import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

// Mock child_process before importing the module
vi.mock('child_process', () => ({
  execFileSync: vi.fn(() => ''),
}));

const { execFileSync } = await import('child_process');
const { createSupervisorLifecycleManager } = await import('../lib/supervisor-lifecycle-manager.js');
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
    // Set AGENTCHAT_HOMEDIR so resolveV1ManifestForAgent finds the workspace
    process.env.AGENTCHAT_HOMEDIR = tmpDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    process.env.PATH = originalPath;
    delete process.env.AGENTCHAT_HOMEDIR;
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
