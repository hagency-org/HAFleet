/*
 * May a background launcher start this runtime, or can its permission requests reach nobody?
 *
 * ADR-005 requires that "the launcher verifies every required adapter before it creates tmux". Two
 * launchers honoured that; `lib/supervisor-lifecycle-manager.js` did not, so a supervisor-launched
 * Claude agent ran `--permission-mode auto` in a detached pane with no permission relay. Auto mode
 * then either hard-denies everything or opens a native prompt inside a pane nobody is watching —
 * the state REQ-OWNER-UI-APPROVAL-BACKGROUND names and forbids.
 *
 * WHY A SHARED MODULE RATHER THAN A THIRD COPY OF THE CHECKS. A security precondition enforced at
 * two of three entry points does not exist at the third, and adding the checks inline would make a
 * third copy whose drift is exactly what this audit round kept finding — two ownership-binding
 * writers, two field lists, one launcher missing a bot invite.
 *
 * WHY VERIFY-ONLY. `bin/hafleet-up`'s preflight ESTABLISHES readiness and, for Codex, confirms hook
 * trust at a TTY: `confirmHookTrust` returns false when `!input.isTTY` and its caller aborts. A
 * sweep loop inside the backend has no terminal, so it could never complete an establishing
 * preflight — and does not need to, because it launches into an already-provisioned home. So this
 * module reads, never writes, never prompts, and refuses with a reason naming what to run.
 */

import { afterEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyRuntimeApprovalReadiness } from '../lib/agent-launch-readiness.js';

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

/** A provisioned agent home, from which each test removes exactly one artifact. */
function home({ token = true, mcp = true, codexHook = null } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'readiness-'));
  roots.push(root);
  const agentPath = path.join(root, 'home');
  const stateDir = path.join(agentPath, 'state');
  const dataDir = path.join(root, 'data');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  if (token) writeFileSync(path.join(stateDir, 'agent-token'), `${'a'.repeat(64)}\n`, { mode: 0o600 });
  if (mcp) writeFileSync(path.join(agentPath, '.mcp.json'), JSON.stringify({ mcpServers: {} }));
  if (codexHook !== null) writeFileSync(path.join(dataDir, 'codex-approval-hook.json'), codexHook);
  return { agentPath, stateDir, dataDir };
}

const verify = (framework, paths, env = {}) => verifyRuntimeApprovalReadiness({
  framework, ...paths, env,
});

describe('a provisioned home is ready', () => {
  test('Claude passes with a token and an MCP config', () => {
    expect(verify('claude', home())).toEqual({ ok: true });
  });

  test('Codex passes with a token and a parseable hook config', () => {
    expect(verify('codex', home({ codexHook: JSON.stringify({ hooks: {} }) }))).toEqual({ ok: true });
  });
});

describe('the credential the runtime submits WITH', () => {
  test('a missing agent token refuses both frameworks and names the command', () => {
    /*
     * Without it the runtime cannot reach the backend at all, so a permission request has nowhere
     * to go and the runtime falls back to whatever it does alone. `bin/hafleet-up` MINTS this when
     * absent; a daemon must report rather than repair, because minting a credential outside
     * provisioning is how a second source of truth starts.
     */
    for (const framework of ['claude', 'codex']) {
      const result = verify(framework, home({ token: false, codexHook: '{}' }));
      expect(result.ok, framework).toBe(false);
      expect(result.reason).toBe('missing_agent_approval_token');
      // An operator needs somewhere to go, not just a refusal.
      expect(result.detail).toMatch(/hafleet up/);
    }
  });

  test('an EMPTY token file is as bad as a missing one', () => {
    // A zero-byte token authenticates nothing, and `existsSync` alone would have passed it.
    const paths = home({ token: false });
    writeFileSync(path.join(paths.stateDir, 'agent-token'), '');
    expect(verify('claude', paths).reason).toBe('missing_agent_approval_token');
  });
});

describe('Claude asks over the MCP permission channel', () => {
  test('with the channel switched off it refuses, whatever else is present', () => {
    /*
     * The channel is the only way this runtime can ask a human, so launching with it disabled
     * reaches the forbidden state by configuration rather than by omission — and everything else
     * about the home looks correct, which is what makes it worth a case.
     */
    const result = verify('claude', home(), { HAFLEET_CLAUDE_PERMISSION_CHANNEL: 'false' });
    expect(result).toMatchObject({ ok: false, reason: 'claude_permission_channel_disabled' });
  });

  test('any value other than the literal false leaves the channel on', () => {
    // Default-on: an unset or misspelled value must not silently disable the relay.
    for (const value of [undefined, '', 'true', 'TRUE', '0', 'no']) {
      expect(verify('claude', home(), { HAFLEET_CLAUDE_PERMISSION_CHANNEL: value }).ok, String(value))
        .toBe(true);
    }
  });

  test('no MCP config anywhere refuses, because the channel is not declared', () => {
    const result = verify('claude', home({ mcp: false }));
    expect(result).toMatchObject({ ok: false, reason: 'claude_mcp_config_missing' });
  });

  test('Codex is unaffected by Claude\'s MCP config', () => {
    // Different adapter entirely. Requiring `.mcp.json` for Codex would refuse a correct home.
    expect(verify('codex', home({ mcp: false, codexHook: '{}' })).ok).toBe(true);
  });
});

describe('Codex asks through its PermissionRequest hook', () => {
  test('a missing hook config refuses', () => {
    const result = verify('codex', home({ codexHook: null }));
    expect(result).toMatchObject({ ok: false, reason: 'codex_hook_config_missing' });
  });

  test('an UNPARSEABLE hook config refuses, which is worse than a missing one', () => {
    /*
     * A truncated or hand-edited config is the dangerous case: Codex would start, read no usable
     * hook, and run with no approval path — the failure this check exists to prevent, wearing a
     * valid-looking filename. Presence alone would have passed it.
     */
    const result = verify('codex', home({ codexHook: '{"hooks": ' }));
    expect(result).toMatchObject({ ok: false, reason: 'codex_hook_config_unreadable' });
    expect(result.detail).toMatch(/no approval path/);
  });

  test('a config that parses to a non-object refuses', () => {
    // `null` and `"text"` are valid JSON and useless as a hook config.
    for (const body of ['null', '"a string"', '42']) {
      expect(verify('codex', home({ codexHook: body })).reason, body)
        .toBe('codex_hook_config_unreadable');
    }
  });

  test('Claude is unaffected by the Codex hook config', () => {
    expect(verify('claude', home({ codexHook: null })).ok).toBe(true);
  });
});

describe('what is deliberately not gated', () => {
  test('ACP runtimes pass, because they answer permission requests themselves', () => {
    /*
     * hermes, octos and codex-acp answer `session/request_permission` through the ACP client, which
     * declines anything that is not a hafleet coordination tool. There is no adapter here to
     * verify, so refusing them would block launches for a reason that does not apply to them.
     */
    for (const framework of ['hermes', 'octos', 'codex-acp']) {
      const result = verify(framework, home({ token: false, mcp: false }));
      expect(result.ok, framework).toBe(true);
      expect(result.reason).toBe('framework_not_gated');
    }
  });

  test('an unresolved agent home refuses rather than passing vacuously', () => {
    /*
     * The failure mode a permissive default would create: called with paths the caller could not
     * resolve, "nothing to check" must not read as "nothing wrong".
     */
    expect(verifyRuntimeApprovalReadiness({ framework: 'claude' }))
      .toMatchObject({ ok: false, reason: 'agent_home_unresolved' });
    expect(verifyRuntimeApprovalReadiness({ framework: 'codex', agentPath: '/x', stateDir: '/y' }))
      .toMatchObject({ ok: false, reason: 'agent_home_unresolved' });
  });

  test('a gated framework with a home that does not exist on disk refuses', () => {
    // Distinct from unresolved: the paths were given and are simply not there.
    expect(verify('claude', { agentPath: '/nope/home', stateDir: '/nope/state', dataDir: '/nope/data' }))
      .toMatchObject({ ok: false, reason: 'missing_agent_approval_token' });
  });
});
