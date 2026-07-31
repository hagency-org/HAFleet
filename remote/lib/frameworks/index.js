/**
 * Framework adapters: everything HAFleet needs to know about one coding agent,
 * declared in a JSON file rather than branched on across the tree.
 *
 * Before this, adding a framework meant editing ~234 hardcoded claude/codex
 * branches spread over bin/agent-up, lib/agent-launch-policy.js,
 * lib/mcp-server-core.js and lib/push-relay-core.js. This module owns the
 * launch and guard half of that; the pane-scraping signals follow.
 *
 * Adding a framework is three mechanical steps:
 *   1. drop lib/frameworks/<id>.json in place
 *   2. add the filename to MANIFEST_FILES below
 *   3. add both paths to MANAGED_SPECS in scripts/build-remote-package.sh
 * tests/framework-adapters.test.js fails if step 2 or 3 is missed.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Explicit rather than a directory scan: the order is part of the contract (it
// decides which message a token matching two frameworks produces), and the
// remote package ships a copied file tree where a scan would silently find
// nothing.
const MANIFEST_FILES = Object.freeze(['claude.json', 'codex.json', 'hermes.json']);

/** Fields a manifest must carry to be usable. Kept small on purpose. */
function validateManifest(raw, file) {
  const fail = (message) => {
    const error = new Error(`${file}: ${message}`);
    error.code = 'invalid_framework_manifest';
    throw error;
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('must be a JSON object');
  if (typeof raw.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(raw.id)) {
    fail('id must be lowercase kebab-case');
  }
  if (path.basename(file, '.json') !== raw.id) fail(`id "${raw.id}" must match the filename`);
  if (typeof raw.displayName !== 'string' || !raw.displayName.trim()) fail('displayName is required');
  const launch = raw.launch;
  if (!launch || typeof launch !== 'object') fail('launch is required');
  if (typeof launch.command !== 'string' || !launch.command.trim()) fail('launch.command is required');
  if (!Array.isArray(launch.defaultArgs) || launch.defaultArgs.some((a) => typeof a !== 'string')) {
    fail('launch.defaultArgs must be an array of strings');
  }
  if (typeof launch.permissionSummary !== 'string' || !launch.permissionSummary.trim()) {
    fail('launch.permissionSummary is required — it is shown to operators');
  }
  if (raw.launchable !== undefined && typeof raw.launchable !== 'boolean') {
    fail('launchable must be a boolean when present');
  }
  if (raw.launchable === false && !String(raw.notLaunchableReason || '').trim()) {
    fail('launchable:false requires notLaunchableReason — an operator needs to know why');
  }
  // Typing the init prompt into a pane is only safe if there is a way to know the
  // prompt is live. Without this, the keystrokes race the process starting up.
  if (raw.launch?.initPromptDelivery === 'keystrokes' && !(raw.signals?.ready || []).length) {
    fail('launch.initPromptDelivery "keystrokes" requires at least one signals.ready pattern');
  }
  for (const kind of ['blocked', 'compact', 'ready']) {
    const list = raw.signals?.[kind];
    if (list === undefined) continue;
    if (!Array.isArray(list)) fail(`signals.${kind} must be an array`);
    for (const entry of list) {
      if (!entry?.marker || !entry?.re) fail(`signals.${kind} entries need marker and re`);
      let compiled;
      try { compiled = new RegExp(entry.re); } catch { fail(`signals.${kind} regex is invalid: ${entry.re}`); }
      // Ready patterns are also consumed by shell, which must not have to guess a
      // regex dialect — so they carry a literal, and it has to agree with the regex.
      if (kind === 'ready') {
        if (typeof entry.fixed !== 'string' || !entry.fixed) fail('signals.ready entries need a `fixed` literal for grep -F');
        if (!compiled.test(entry.fixed)) fail(`signals.ready regex does not match its own fixed literal: ${entry.marker}`);
      }
    }
  }
  const flags = raw.guards?.flags;
  if (flags) {
    for (const key of ['exact', 'prefix', 'pattern']) {
      if (flags[key] !== undefined && !Array.isArray(flags[key])) fail(`guards.flags.${key} must be an array`);
    }
    if (typeof flags.message !== 'string' || !flags.message.includes('{token}')) {
      fail('guards.flags.message must interpolate {token}');
    }
    for (const source of flags.pattern || []) {
      try { new RegExp(source); } catch { fail(`guards.flags.pattern is not a valid regex: ${source}`); }
    }
  }
  const config = raw.guards?.config;
  if (config) {
    if (!Array.isArray(config.flags) || !config.flags.length) fail('guards.config.flags is required');
    try { new RegExp(config.keyPattern); } catch { fail('guards.config.keyPattern is not a valid regex'); }
    if (typeof config.message !== 'string' || !config.message.includes('{key}')) {
      fail('guards.config.message must interpolate {key}');
    }
    if (typeof config.inlineMessage !== 'string') fail('guards.config.inlineMessage is required');
  }
  return raw;
}

function compile(raw) {
  const flags = raw.guards?.flags;
  const config = raw.guards?.config;
  return Object.freeze({
    id: raw.id,
    displayName: raw.displayName,
    // Declared but not yet wired into bin/agent-up. Kept explicit so the gate can
    // refuse with a real reason instead of letting a launch fall through.
    launchable: raw.launchable !== false,
    notLaunchableReason: raw.notLaunchableReason || null,
    signals: Object.freeze({
      blocked: Object.freeze((raw.signals?.blocked || []).map((s) => Object.freeze({ ...s, regex: new RegExp(s.re) }))),
      compact: Object.freeze((raw.signals?.compact || []).map((s) => Object.freeze({ ...s, regex: new RegExp(s.re) }))),
      // How to tell the agent is accepting input. Only needed by frameworks whose
      // init prompt is typed in rather than passed as an argument.
      ready: Object.freeze((raw.signals?.ready || []).map((s) => Object.freeze({ ...s, regex: new RegExp(s.re) }))),
    }),
    launch: Object.freeze({ ...raw.launch, defaultArgs: Object.freeze([...raw.launch.defaultArgs]) }),
    flagGuard: flags
      ? Object.freeze({
        exact: new Set(flags.exact || []),
        prefix: Object.freeze([...(flags.prefix || [])]),
        pattern: Object.freeze((flags.pattern || []).map((p) => new RegExp(p))),
        message: flags.message,
      })
      : null,
    configGuard: config
      ? Object.freeze({
        flags: new Set(config.flags),
        inlinePrefix: Object.freeze([...(config.inlinePrefix || [])]),
        keyPattern: new RegExp(config.keyPattern),
        message: config.message,
        inlineMessage: config.inlineMessage,
      })
      : null,
    raw,
  });
}

const REGISTRY = Object.freeze(MANIFEST_FILES.map((file) => compile(
  validateManifest(JSON.parse(readFileSync(path.join(HERE, file), 'utf8')), file),
)));

const BY_ID = new Map(REGISTRY.map((f) => [f.id, f]));

/** Every adapter, in manifest order. */
export function listFrameworks() {
  return [...REGISTRY];
}

export function getFramework(id) {
  return BY_ID.get(String(id || '').trim().toLowerCase()) || null;
}

export function frameworkIds() {
  return REGISTRY.map((f) => f.id);
}

/**
 * Which adapters' guards apply to a launch declared as `framework`.
 *
 * An empty framework means "unknown caller", and every guard applies — refusing
 * a flag that only one framework cares about is harmless, allowing one is not.
 *
 * A NON-empty name that matches no adapter yields NO guards. That is the
 * pre-existing behaviour, preserved deliberately so this refactor changes
 * nothing, and it is a real hole: `--framework hermes --extra-args --yolo` is
 * accepted today. See tests/framework-adapters.test.js, which pins it as a
 * known gap rather than an intended feature.
 */
export function applicableFrameworks(framework) {
  const id = String(framework || '').trim().toLowerCase();
  if (!id) return [...REGISTRY];
  const found = BY_ID.get(id);
  return found ? [found] : [];
}

/**
 * The first guard a token trips, or null.
 *
 * Callers must iterate tokens on the OUTSIDE and call this per token, because
 * the reported violation is the first offending *token*, not the first
 * offending framework — `--yolo --permission-mode` reports Codex while
 * `--permission-mode --yolo` reports Claude.
 *
 * @param {string} token       the token under test
 * @param {string} nextToken   the following token, for `-c KEY=VALUE` forms
 * @param {Array}  frameworks  from applicableFrameworks()
 */
export function guardViolation(token, nextToken, frameworks) {
  for (const framework of frameworks) {
    const flags = framework.flagGuard;
    if (flags) {
      const hit = flags.exact.has(token)
        || flags.prefix.some((p) => token.startsWith(p))
        || flags.pattern.some((re) => re.test(token));
      if (hit) return { reason: flags.message.replace('{token}', token) };
    }

    const config = framework.configGuard;
    if (config) {
      // `-c KEY=VALUE` — the policy key is in the next token.
      if (config.flags.has(token)) {
        const value = nextToken || '';
        if (config.keyPattern.test(String(value).trim())) {
          return { reason: config.message.replace('{key}', String(value).split('=')[0]) };
        }
      }
      // `--config=KEY=VALUE`, `-c=KEY=VALUE`, `-cKEY=VALUE` — key is inline.
      for (const prefix of config.inlinePrefix) {
        if (!token.startsWith(prefix) || token.length <= prefix.length) continue;
        if (config.keyPattern.test(token.slice(prefix.length).trim())) {
          return { reason: config.inlineMessage };
        }
      }
    }
  }
  return null;
}

/** Ids that bin/agent-up can actually start today. */
export function launchableFrameworkIds() {
  return REGISTRY.filter((f) => f.launchable).map((f) => f.id);
}

/** Why a declared framework cannot be launched, or null if it can. */
export function launchBlockedReason(id) {
  const framework = getFramework(id);
  if (!framework) return `unknown framework: ${String(id || '').trim().toLowerCase()}`;
  return framework.launchable ? null : framework.notLaunchableReason;
}
