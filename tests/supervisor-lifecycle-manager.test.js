import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

// Mock child_process before importing the module
vi.mock('child_process', () => ({
  execFileSync: vi.fn(() => ''),
}));

const { execFileSync } = await import('child_process');
const { buildLaunchCommand, createSupervisorLifecycleManager } = await import('../lib/supervisor-lifecycle-manager.js');
const { createSupervisorSnapshotStore } = await import('../lib/supervisor-snapshot-store.js');

describe('SupervisorLifecycleManager', () => {
  let tmpDir;
  let snapshotStore;
  let agents;
  let runtimes;
  let broadcastEvents;
  let originalPath;

  beforeEach(() => {
    vi.clearAllMocks();
    originalPath = process.env.PATH;
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'supervisor-lifecycle-test-'));
    // Create a dummy `claude` binary so binaryExistsOnPath() succeeds in CI
    const binDir = path.join(tmpDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(binDir, 'claude'), '#!/bin/sh\nexit 0', { mode: 0o755 });
    process.env.PATH = `${binDir}:${process.env.PATH}`;
    broadcastEvents = [];
    agents = {
      'ac-topleader': { name: 'ac-topleader', kind: 'agent', online: true },
      'supervisor-ac-topleader': {
        name: 'supervisor-ac-topleader', kind: 'agent', online: true,
        homeDir: tmpDir,
      },
      alpha: { name: 'alpha', kind: 'agent', online: true },
    };
    runtimes = {
      'ac-topleader': { activeNow: false },
    };
    snapshotStore = createSupervisorSnapshotStore({ save: () => {} });

    // Create supervisor workspace at the expected location
    const homeRoot = path.join(tmpDir, 'agents', 'agent_supervisor-ac-topleader');
    const workdir = path.join(homeRoot, 'workdir');
    const stateDir = path.join(homeRoot, 'state');
    mkdirSync(workdir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    // Write a minimal agent.json for resolveV1ManifestForAgent
    writeFileSync(path.join(homeRoot, 'agent.json'), JSON.stringify({
      name: 'supervisor-ac-topleader',
      id: 'agent_supervisor-ac-topleader',
      layoutVersion: 1,
      homeDir: homeRoot,
      stateDir,
      workdir,
    }));
    /*
     * A PROVISIONED home, because the launcher now verifies the approval adapter before it creates
     * a session (ADR-005: "verifies every required adapter before it creates tmux"). A fixture
     * without these artifacts is an unprovisioned agent, and the launcher is right to refuse it —
     * which is how these two files first failed when the check landed.
     *
     * The token is what the runtime submits an approval request WITH; `.mcp.json` is what declares
     * the channel Claude asks over. Both are what `hafleet up` writes.
     */
    writeFileSync(path.join(stateDir, 'agent-token'), 'a'.repeat(64) + '\n', { mode: 0o600 });
    writeFileSync(path.join(homeRoot, '.mcp.json'), JSON.stringify({ mcpServers: {} }));
    // Set HAFLEET_HOMEDIR so resolveV1ManifestForAgent finds the workspace
    process.env.HAFLEET_HOMEDIR = tmpDir;
    // The readiness check reads the agent data dir from here, matching bin/hafleet-up's
    // DATA_DIR="$RUNTIME_DIR/data/agents".
    process.env.HAFLEET_RUNTIME_DIR = tmpDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    process.env.PATH = originalPath;
    delete process.env.HAFLEET_HOMEDIR;
    delete process.env.HAFLEET_RUNTIME_DIR;
    delete process.env.SUPERVISOR_TRAILING_HEARTBEAT_PERIODS;
    delete process.env.SUPERVISOR_HEARTBEAT_TTL_MS;
  });

  function createManager(overrides = {}) {
    return createSupervisorLifecycleManager({
      getAgents: () => agents,
      getRuntime: (name) => runtimes[name] || null,
      snapshotStore,
      isAgentRecord: (record) => Boolean(record) && record.kind === 'agent',
      broadcastSSE: (type, data) => broadcastEvents.push({ type, data }),
      ...overrides,
    });
  }

  // Mock tmux has-session to return "exists" or "not found"
  function mockTmuxExists(sessionsSet) {
    execFileSync.mockImplementation((cmd, args, opts) => {
      if (cmd !== 'tmux') return '';
      const subCmd = args[0];
      if (subCmd === 'has-session') {
        const sessionName = args[2].replace(/^=/, '');
        if (sessionsSet.has(sessionName)) return '';
        throw new Error('session not found');
      }
      if (subCmd === 'display-message') {
        return tmpDir; // return some path
      }
      // new-session, send-keys, kill-session — succeed silently
      return '';
    });
  }

  test('skips agents without a registered supervisor', () => {
    delete agents['supervisor-ac-topleader'];
    const manager = createManager();
    const result = manager.reconcile('ac-topleader');
    expect(result.action).toBe('skip');
    expect(result.reason).toBe('no-supervisor-registered');
  });

  test('stops supervisor and clears lease when kill switch is disabled', () => {
    // First establish a lease
    snapshotStore.renewLease('ac-topleader', 'supervisor-ac-topleader');
    expect(snapshotStore.isLeaseActive('ac-topleader')).toBe(true);

    snapshotStore.setEnabled(false);
    mockTmuxExists(new Set(['supervisor-ac-topleader']));
    const manager = createManager();
    const result = manager.reconcile('ac-topleader');
    expect(result.action).toBe('stopped');
    expect(result.reason).toBe('kill-switch-disabled');
    // Lease must be cleared
    expect(snapshotStore.isLeaseActive('ac-topleader')).toBe(false);
  });

  test('returns idle when kill switch is disabled and no session exists', () => {
    snapshotStore.setEnabled(false);
    mockTmuxExists(new Set());
    const manager = createManager();
    const result = manager.reconcile('ac-topleader');
    expect(result.action).toBe('idle');
    expect(result.reason).toBe('kill-switch-disabled');
  });

  test('starts supervisor when target agent is active', () => {
    runtimes['ac-topleader'] = { activeNow: true };
    mockTmuxExists(new Set());
    const manager = createManager();
    const result = manager.reconcile('ac-topleader');
    expect(result.action).toBe('started');
    expect(result.reason).toBe('target-active');
    // Verify tmux new-session was called
    const newSessionCall = execFileSync.mock.calls.find(c => c[0] === 'tmux' && c[1][0] === 'new-session');
    expect(newSessionCall).toBeTruthy();
    expect(newSessionCall[1]).toContain('supervisor-ac-topleader');
    // Verify SSE broadcast
    expect(broadcastEvents).toHaveLength(1);
    expect(broadcastEvents[0].data.type).toBe('started');
  });

  test('REFUSES to launch when the approval adapter is not ready', () => {
    /*
     * ADR-005: "the launcher verifies every required adapter before it creates tmux." Two launchers
     * did; this one did not, so a supervisor Claude agent ran `--permission-mode auto` in a detached
     * pane with NO permission relay — auto mode then either hard-denies everything or opens a native
     * prompt inside a pane nobody is watching, which is the state
     * REQ-OWNER-UI-APPROVAL-BACKGROUND forbids by name.
     *
     * Asserted as a refusal AND as no tmux call: reporting `failed` while still creating the session
     * would be the same defect with a better error message.
     */
    rmSync(path.join(tmpDir, 'agents', 'agent_supervisor-ac-topleader', 'state', 'agent-token'), { force: true });
    runtimes['ac-topleader'] = { activeNow: true };
    mockTmuxExists(new Set());

    const result = createManager().reconcile('ac-topleader');

    expect(result.action).toBe('failed');
    expect(result.reason).toBe('approval-adapter-unready');
    // The reason names what to run, because "unready" alone leaves an operator nowhere to go.
    expect(result.error).toMatch(/missing_agent_approval_token/);
    expect(result.error).toMatch(/hafleet up/);
    expect(execFileSync.mock.calls.some((c) => c[0] === 'tmux' && c[1][0] === 'new-session')).toBe(false);
  });

  test('refuses a Claude launch when the permission channel is switched off', () => {
    // The channel is the ONLY way this runtime can ask a human. Turning it off and launching anyway
    // is the forbidden state reached by configuration rather than by omission.
    process.env.HAFLEET_CLAUDE_PERMISSION_CHANNEL = 'false';
    try {
      runtimes['ac-topleader'] = { activeNow: true };
      mockTmuxExists(new Set());
      const result = createManager().reconcile('ac-topleader');
      expect(result.action).toBe('failed');
      expect(result.error).toMatch(/claude_permission_channel_disabled/);
    } finally {
      delete process.env.HAFLEET_CLAUDE_PERMISSION_CHANNEL;
    }
  });

  test('an already-running supervisor is KEPT even if an artifact went missing', () => {
    /*
     * The placement the first draft got wrong. ADR-005's wording is "before it CREATES tmux", and a
     * supervisor already running healthily is not creating one — so gating the `kept` path would
     * report `failed` for a working session and, worse, invite a caller to restart it. The suite
     * caught that draft by failing this case's ancestor.
     */
    rmSync(path.join(tmpDir, 'agents', 'agent_supervisor-ac-topleader', 'state', 'agent-token'), { force: true });
    runtimes['ac-topleader'] = { activeNow: true };
    /*
     * The pane path has to MATCH, or this exercises the restart branch instead — which does create a
     * session and is therefore correctly gated. The first version of this test omitted the
     * display-message mock and failed for exactly that reason, which is a useful thing to have
     * learned: a path-mismatch restart goes through the gate, and only a true `kept` bypasses it.
     */
    const workdir = path.join(tmpDir, 'agents', 'agent_supervisor-ac-topleader', 'workdir');
    execFileSync.mockImplementation((cmd, args) => {
      if (cmd !== 'tmux') return '';
      if (args[0] === 'has-session') return '';
      if (args[0] === 'display-message') return workdir + '\n';
      return '';
    });

    const result = createManager().reconcile('ac-topleader');

    expect(result.action).toBe('kept');
  });

  test('a path-mismatch RESTART is gated, because it does create a session', () => {
    // The other half of the placement rule. `kept` bypasses the check; anything that calls
    // startTmuxSession — including a restart — goes through it.
    rmSync(path.join(tmpDir, 'agents', 'agent_supervisor-ac-topleader', 'state', 'agent-token'), { force: true });
    runtimes['ac-topleader'] = { activeNow: true };
    execFileSync.mockImplementation((cmd, args) => {
      if (cmd !== 'tmux') return '';
      if (args[0] === 'has-session') return '';
      if (args[0] === 'display-message') return '/somewhere/else\n';
      return '';
    });

    const result = createManager().reconcile('ac-topleader');

    expect(result.action).toBe('failed');
    expect(result.reason).toBe('approval-adapter-unready');
  });

  test('the launch replaces the pane shell, so a dead runtime does not look alive', () => {
    /*
     * ADR-005 ¶6. Without `exec`, a runtime that exits leaves the pane at an interactive shell — and
     * because the SESSION still exists, `tmuxSessionExists` reports it and reconcile returns `kept`,
     * so a supervisor whose runtime died is indistinguishable from one that is running and is never
     * restarted. `bin/hafleet-up` has always done this; this launcher did not.
     */
    runtimes['ac-topleader'] = { activeNow: true };
    mockTmuxExists(new Set());
    createManager().reconcile('ac-topleader');

    const sendKeys = execFileSync.mock.calls.find((c) => c[0] === 'tmux' && c[1][0] === 'send-keys');
    expect(sendKeys).toBeTruthy();
    expect(sendKeys[1][3]).toMatch(/^exec /);
  });

  test('builds sandboxed Claude auto-mode and Codex Level 2 supervisor commands', () => {
    const claudeCommand = buildLaunchCommand('alpha', '/tmp/alpha', {
      profileSource: 'env/default', framework: 'claude', provider: 'anthropic',
      model: null, reasoning: null, extraArgs: '--verbose',
    }, null);
    expect(claudeCommand).toContain("claude --permission-mode auto '--verbose'");
    expect(claudeCommand).toContain("HAFLEET_AGENT_PERMISSION_MODE='auto'");
    expect(claudeCommand).toContain("-- 'Read your AGENTS.md and begin your assessment cycle now.'");
    expect(claudeCommand).not.toContain('--dangerously-skip-permissions');

    const codexCommand = buildLaunchCommand('alpha', '/tmp/alpha', {
      profileSource: 'env/default', framework: 'codex', provider: 'openai',
      model: null, reasoning: null, extraArgs: '--search',
    }, null);
    expect(codexCommand).toContain("codex --sandbox workspace-write --ask-for-approval on-request '--search'");
    expect(codexCommand).toContain("HAFLEET_AGENT_PERMISSION_LEVEL='2'");
    expect(codexCommand).toContain("-C '/tmp/alpha'");
    expect(codexCommand).toContain("-- 'Read your AGENTS.md and begin your assessment cycle now.'");
    expect(codexCommand).not.toContain('--yolo');
  });

  test('an ambient ANTHROPIC_API_KEY is unset for Claude with no profile key', () => {
    /*
     * ADR-005 ¶5. Both hafleet-up launchers do this — pinned by
     * `launchers_clear_ambient_anthropic_key_without_explicit_profile` — and this one did not, so a
     * key sitting in the operator's shell was inherited by the tmux server and used INSTEAD of the
     * subscription the contributor configured. Silent, and it bills the wrong credential: ADR-013's
     * seat accounting assumes an agent draws on the credential home its profile names.
     */
    const command = buildLaunchCommand('alpha', '/tmp/alpha', {
      profileSource: 'env/default', framework: 'claude', provider: 'anthropic',
      model: null, reasoning: null, extraArgs: '',
    }, null);
    expect(command).toMatch(/^env -u ANTHROPIC_API_KEY /);
  });

  test('an EXPLICIT profile key is left alone', () => {
    // A per-agent key is a deliberate choice. Unsetting it here would override the operator in the
    // opposite direction, which is the same class of surprise.
    const command = buildLaunchCommand('alpha', '/tmp/alpha', {
      profileSource: 'agent/runtimeProfile', framework: 'claude', provider: 'anthropic',
      model: null, reasoning: null, extraArgs: '',
    }, { primary: { apiKey: 'sk-explicit-per-agent' } });
    expect(command).not.toMatch(/env -u ANTHROPIC_API_KEY/);
  });

  test('Codex is not touched by the Anthropic hygiene', () => {
    // The variable means nothing to Codex, and unsetting it there would be cargo-culting the fix.
    const command = buildLaunchCommand('alpha', '/tmp/alpha', {
      profileSource: 'env/default', framework: 'codex', provider: 'openai',
      model: null, reasoning: null, extraArgs: '',
    }, null);
    expect(command).not.toMatch(/env -u ANTHROPIC_API_KEY/);
  });

  test('rejects supervisor extraArgs that override the managed permission policy', () => {
    expect(() => buildLaunchCommand('alpha', '/tmp/alpha', {
      profileSource: 'runtimeProfile.supervisor', framework: 'claude', provider: 'anthropic',
      model: null, reasoning: null, extraArgs: '--permission-mode bypassPermissions',
    }, null)).toThrow(expect.objectContaining({ code: 'unsafe_launch_extra_args' }));
    expect(() => buildLaunchCommand('alpha', '/tmp/alpha', {
      profileSource: 'runtimeProfile.supervisor', framework: 'codex', provider: 'openai',
      model: null, reasoning: null, extraArgs: '--yolo',
    }, null)).toThrow(expect.objectContaining({ code: 'unsafe_launch_extra_args' }));
  });

  test('keeps existing session when target is active and session exists', () => {
    runtimes['ac-topleader'] = { activeNow: true };
    const workdir = path.join(tmpDir, 'agents', 'agent_supervisor-ac-topleader', 'workdir');
    execFileSync.mockImplementation((cmd, args) => {
      if (cmd !== 'tmux') return '';
      if (args[0] === 'has-session') return '';
      if (args[0] === 'display-message') return workdir + '\n';
      return '';
    });
    const manager = createManager();
    const result = manager.reconcile('ac-topleader');
    expect(result.action).toBe('kept');
  });

  test('idles supervisor after trailing window expires', () => {
    process.env.SUPERVISOR_TRAILING_HEARTBEAT_PERIODS = '1';
    process.env.SUPERVISOR_HEARTBEAT_TTL_MS = '100';
    mockTmuxExists(new Set());
    const manager = createManager();

    // First call: target idle, starts trailing
    const t0 = Date.now();
    const r1 = manager.reconcile('ac-topleader', t0);
    expect(r1.action).toBe('idle');
    expect(r1.reason).toBe('target-idle-no-session');

    // Second call: after trailing window (100ms * 1 period)
    const r2 = manager.reconcile('ac-topleader', t0 + 200);
    expect(r2.action).toBe('idle');
    expect(r2.reason).toBe('trailing-expired');
  });

  test('stops running supervisor after trailing window expires', () => {
    process.env.SUPERVISOR_TRAILING_HEARTBEAT_PERIODS = '1';
    process.env.SUPERVISOR_HEARTBEAT_TTL_MS = '100';
    mockTmuxExists(new Set(['supervisor-ac-topleader']));
    const manager = createManager();

    const t0 = Date.now();
    // First reconcile: target idle, session exists, trailing starts
    const r1 = manager.reconcile('ac-topleader', t0);
    expect(r1.action).toBe('trailing');

    // After trailing expires
    const r2 = manager.reconcile('ac-topleader', t0 + 200);
    expect(r2.action).toBe('stopped');
    expect(r2.reason).toBe('trailing-expired');
    // Verify kill-session was called
    const killCall = execFileSync.mock.calls.find(c => c[0] === 'tmux' && c[1][0] === 'kill-session');
    expect(killCall).toBeTruthy();
  });

  test('resets trailing when target becomes active again', () => {
    process.env.SUPERVISOR_TRAILING_HEARTBEAT_PERIODS = '1';
    process.env.SUPERVISOR_HEARTBEAT_TTL_MS = '100';
    mockTmuxExists(new Set());
    const manager = createManager();

    const t0 = Date.now();
    // Target idle → trailing starts
    manager.reconcile('ac-topleader', t0);

    // Target active → trailing resets
    runtimes['ac-topleader'] = { activeNow: true };
    const r2 = manager.reconcile('ac-topleader', t0 + 50);
    expect(r2.action).toBe('started');

    // Target idle again → new trailing window
    runtimes['ac-topleader'] = { activeNow: false };
    const r3 = manager.reconcile('ac-topleader', t0 + 60);
    expect(r3.action).toBe('idle');
    expect(r3.reason).toBe('target-idle-no-session');

    // Old trailing would have expired at t0+100, but new one starts at t0+60
    const r4 = manager.reconcile('ac-topleader', t0 + 120);
    expect(r4.action).toBe('idle');
    expect(r4.reason).toBe('target-idle-no-session'); // still within new trailing
  });

  test('fails when supervisor workspace is missing', () => {
    runtimes['ac-topleader'] = { activeNow: true };
    mockTmuxExists(new Set());
    // Remove workspace
    const workdir = path.join(tmpDir, 'agents', 'agent_supervisor-ac-topleader', 'workdir');
    rmSync(workdir, { recursive: true, force: true });
    const manager = createManager();
    const result = manager.reconcile('ac-topleader');
    expect(result.action).toBe('failed');
    expect(result.reason).toBe('missing-workspace');
  });

  test('sweepAll processes all supervised agents', () => {
    mockTmuxExists(new Set());
    const manager = createManager();
    const results = manager.sweepAll();
    // Only ac-topleader has a supervisor (alpha does not)
    expect(results).toHaveLength(1);
    expect(results[0].target).toBe('ac-topleader');
  });

  test('sweepAll skips supervisor agents themselves', () => {
    mockTmuxExists(new Set());
    const manager = createManager();
    const results = manager.sweepAll();
    const supervisorResult = results.find(r => r.target === 'supervisor-ac-topleader');
    expect(supervisorResult).toBeUndefined();
  });

  test('cleanOrphanSessions kills supervisor tmux sessions with no registered agent', () => {
    // Mock list-sessions to return orphan + known supervisor sessions
    execFileSync.mockImplementation((cmd, args) => {
      if (cmd !== 'tmux') return '';
      if (args[0] === 'list-sessions') return 'supervisor-ac-topleader\nsupervisor-orphan\nalpha\nsupervisor-unknown\n';
      // kill-session — succeed silently
      return '';
    });
    const manager = createManager();
    const killed = manager.cleanOrphanSessions();
    // supervisor-ac-topleader has both target + supervisor registered → kept
    // supervisor-orphan and supervisor-unknown have no registered target/supervisor → killed
    // alpha is not a supervisor- session → ignored
    expect(killed.sort()).toEqual(['supervisor-orphan', 'supervisor-unknown']);
    // Verify kill-session was called for each orphan
    const killCalls = execFileSync.mock.calls.filter(c => c[0] === 'tmux' && c[1][0] === 'kill-session');
    expect(killCalls).toHaveLength(2);
  });
});
