import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applicableFrameworks, getFramework, guardViolation, listFrameworks } from './frameworks/index.js';

const SHELL_METACHAR_RE = /[;&|`$(){}!\\<>\r\n]/;

function tokenizeCliArgs(value) {
  const input = String(value || '');
  const tokens = [];
  let token = '';
  let quote = null;
  let started = false;

  for (const ch of input) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        token += ch;
      }
      started = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        tokens.push(token);
        token = '';
        started = false;
      }
      continue;
    }
    token += ch;
    started = true;
  }

  if (quote) throw new Error('extraArgs contains an unterminated quote');
  if (started) tokens.push(token);
  return tokens;
}

export function defaultLaunchArgs(framework) {
  const adapter = getFramework(framework);
  return adapter ? [...adapter.launch.defaultArgs] : null;
}

export function validateLaunchExtraArgs(framework, value) {
  const frameworks = applicableFrameworks(framework);
  const extraArgs = String(value || '').trim();
  if (!extraArgs) return { ok: true, tokens: [] };
  if (SHELL_METACHAR_RE.test(extraArgs)) {
    return { ok: false, reason: 'shell metacharacters are not allowed in extraArgs' };
  }

  let tokens;
  try {
    tokens = tokenizeCliArgs(extraArgs);
  } catch (error) {
    return { ok: false, reason: error.message };
  }

  // Tokens on the outside, frameworks on the inside: the violation reported is
  // the one belonging to the first offending token, so `--yolo --permission-mode`
  // reports Codex and `--permission-mode --yolo` reports Claude.
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--') {
      return { ok: false, reason: 'the launch argument delimiter is managed by hafleet' };
    }
    const violation = guardViolation(token, tokens[index + 1] || '', frameworks);
    if (violation) return { ok: false, reason: violation.reason };
  }

  return { ok: true, tokens };
}

export function assertSafeLaunchExtraArgs(framework, value) {
  const result = validateLaunchExtraArgs(framework, value);
  if (!result.ok) {
    const error = new Error(result.reason);
    error.code = 'unsafe_launch_extra_args';
    throw error;
  }
  return result.tokens;
}

function canonicalDirectory(value) {
  const raw = String(value || '').trim();
  if (!raw || !path.isAbsolute(raw) || !existsSync(raw)) return null;
  const resolved = realpathSync(raw);
  try {
    return statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

export function readFirstAgentManifest(manifestPaths) {
  for (const manifestPath of manifestPaths || []) {
    const candidate = String(manifestPath || '').trim();
    if (!candidate) continue;
    try {
      const value = JSON.parse(readFileSync(candidate, 'utf8'));
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch { /* try the next candidate */ }
  }
  return null;
}

export function resolveManagedProjectRoots({ manifest, agentPath, homeDir = os.homedir() } = {}) {
  const canonicalAgentPath = canonicalDirectory(agentPath);
  const canonicalHome = canonicalDirectory(homeDir) || path.resolve(String(homeDir || os.homedir()));
  const roots = [];
  const warnings = [];
  const seen = new Set();

  for (const entry of manifest?.managedProjects || []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const rawPath = String(entry.path || '').trim();
    if (!rawPath || !path.isAbsolute(rawPath)) continue;
    const resolved = canonicalDirectory(rawPath);
    if (!resolved) {
      warnings.push(`managed project path is unavailable, skipping: ${path.resolve(rawPath)}`);
      continue;
    }
    const containsHome = canonicalHome === resolved || canonicalHome.startsWith(`${resolved}${path.sep}`);
    if (resolved === path.parse(resolved).root || containsHome) {
      const error = new Error(`refusing broad managed project path: ${resolved}`);
      error.code = 'unsafe_managed_project_root';
      throw error;
    }
    if (resolved === canonicalAgentPath || seen.has(resolved)) continue;
    seen.add(resolved);
    roots.push(resolved);
  }

  return { roots, warnings };
}

export const LAUNCH_PERMISSION_SUMMARY = Object.freeze(
  Object.fromEntries(listFrameworks().map((f) => [f.id, f.launch.permissionSummary])),
);
