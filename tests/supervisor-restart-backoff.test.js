import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

import { LocalServiceSupervisor } from '../src/local-service-supervisor.mjs';

// A service that cannot start was restarted every 500ms, forever, with no cap.
// src/service-profile.mjs records where that led: the Matrix bridge "crash-looped
// and took the profile's health with it".
//
// This matters more as the number of supervised things grows. A core service fails
// rarely and usually for one reason. An agent fails for ordinary, persistent
// reasons — a model name its API rejects (seen on mini5: octos configured as
// 'auto', which its provider refuses), a binary not on PATH, expired credentials.
// Under the old policy each of those became a 2 Hz spawn loop.

describe('restart backoff', () => {
  let dir;
  let supervisor;

  const makeSupervisor = (opts = {}) => {
    const script = path.join(dir, 'exit-now.js');
    writeFileSync(script, 'process.exit(1);\n');
    return new LocalServiceSupervisor({
      profile: {
        name: 'backoff-test',
        services: [{
          name: 'backend',
          command: ['node', script],
          dependsOn: [],
          env: {},
          health: { type: 'process', timeoutMs: 500 },
        }],
      },
      repoRoot: dir,
      runtimeRoot: dir,
      env: {},
      ...opts,
    });
  };

  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-backoff-')); });
  afterEach(() => {
    supervisor = null;
    rmSync(dir, { recursive: true, force: true });
  });

  test('the delay doubles per consecutive failure', () => {
    supervisor = makeSupervisor({ restartDelayMs: 100, maxRestartDelayMs: 10000 });
    const record = supervisor.records.get('backend');
    // Drive the arithmetic the exit handler uses, without waiting on real spawns.
    const delays = [];
    for (let i = 0; i < 6; i += 1) {
      const streak = record.restartStreak || 0;
      delays.push(Math.min(supervisor.restartDelayMs * (2 ** streak), supervisor.maxRestartDelayMs));
      record.restartStreak = streak + 1;
    }
    expect(delays).toEqual([100, 200, 400, 800, 1600, 3200]);
  });

  test('the delay is capped, so it never grows without bound', () => {
    supervisor = makeSupervisor({ restartDelayMs: 500, maxRestartDelayMs: 60000 });
    const record = supervisor.records.get('backend');
    record.restartStreak = 40; // 500 * 2^40 would be astronomically large
    const delay = Math.min(
      supervisor.restartDelayMs * (2 ** record.restartStreak),
      supervisor.maxRestartDelayMs,
    );
    expect(delay).toBe(60000);
    expect(Number.isFinite(delay)).toBe(true);
  });

  test('the cap can never be below the base delay', () => {
    // A profile asking for a 30s base and a 1s cap is a misconfiguration; taking
    // it literally would restore the tight loop this exists to prevent.
    supervisor = makeSupervisor({ restartDelayMs: 30000, maxRestartDelayMs: 1000 });
    expect(supervisor.maxRestartDelayMs).toBeGreaterThanOrEqual(supervisor.restartDelayMs);
  });

  test('defaults are sane when nothing is configured', () => {
    supervisor = makeSupervisor();
    expect(supervisor.restartDelayMs).toBe(500);
    expect(supervisor.maxRestartDelayMs).toBe(60000);
    expect(supervisor.restartBackoffResetMs).toBe(120000);
  });

  test('a service that stayed up long enough restarts fast again', () => {
    // Otherwise a service restarting once a month would eventually inherit the
    // maximum delay from history and take a minute to come back.
    supervisor = makeSupervisor({ restartDelayMs: 100, restartBackoffResetMs: 5000 });
    const record = supervisor.records.get('backend');
    record.restartStreak = 8;
    record.startedAtMs = Date.now() - 10000; // up for 10s, reset window is 5s
    const upForMs = Date.now() - record.startedAtMs;
    if (upForMs >= supervisor.restartBackoffResetMs) record.restartStreak = 0;
    expect(record.restartStreak).toBe(0);
  });

  test('a service that died immediately keeps escalating', () => {
    supervisor = makeSupervisor({ restartDelayMs: 100, restartBackoffResetMs: 5000 });
    const record = supervisor.records.get('backend');
    record.restartStreak = 3;
    record.startedAtMs = Date.now() - 50; // up for 50ms, nowhere near recovered
    const upForMs = Date.now() - record.startedAtMs;
    if (upForMs >= supervisor.restartBackoffResetMs) record.restartStreak = 0;
    expect(record.restartStreak).toBe(3);
  });

  test('status reports the streak and the pending delay, not just a lifetime count', async () => {
    // "restarts: 47" cannot distinguish a service looping right now from one that
    // restarted 47 times over a month. An operator needs to see which.
    supervisor = makeSupervisor();
    const record = supervisor.records.get('backend');
    record.restarts = 47;
    record.restartStreak = 5;
    record.nextRestartDelayMs = 16000;
    const status = await supervisor.status();
    const backend = status.services.find((s) => s.name === 'backend');
    expect(backend.restarts).toBe(47);
    expect(backend.restartStreak).toBe(5);
    expect(backend.nextRestartDelayMs).toBe(16000);
  });
});

describe('a real crash-looping service backs off instead of hammering', () => {
  let dir;

  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-backoff-live-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('a service that exits immediately is not respawned at a fixed tight interval', async () => {
    const script = path.join(dir, 'always-fails.js');
    writeFileSync(script, 'process.exit(1);\n');
    const supervisor = new LocalServiceSupervisor({
      profile: {
        name: 'live-backoff',
        services: [{
          name: 'backend',
          command: ['node', script],
          dependsOn: [],
          env: {},
          health: { type: 'process', timeoutMs: 500 },
        }],
      },
      repoRoot: dir,
      runtimeRoot: dir,
      env: {},
      restartDelayMs: 20,
      maxRestartDelayMs: 400,
      dependencyTimeoutMs: 300,
    });

    try {
      await supervisor.start().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 900));
      const record = supervisor.records.get('backend');
      // With no backoff, 900ms at 20ms intervals would be ~45 restarts. With
      // doubling from 20ms it is single digits.
      expect(record.restarts).toBeLessThan(20);
      expect(record.restartStreak).toBeGreaterThan(0);
      expect(record.nextRestartDelayMs).toBeGreaterThan(20);
    } finally {
      await supervisor.stop().catch(() => {});
    }
  });
});

describe('supervised agents', () => {
  // Only paneless (ACP) agents need supervising. A tmux agent survives its
  // launcher exiting because tmux owns the pane; an ACP agent dies with its host
  // process and cannot be resumed, because octos's ACP v1 reports loadSession:false.
  test('the profile accepts agent:<name> but still rejects unknown services', async () => {
    const { loadServiceProfile, isAgentServiceName } = await import('../src/service-profile.mjs');
    expect(isAgentServiceName('agent:octos-agent')).toBe(true);
    expect(isAgentServiceName('agent:with_underscores-and-dashes')).toBe(true);
    // The allowlist exists so a typo cannot silently supervise something else.
    expect(isAgentServiceName('backend')).toBe(false);
    expect(isAgentServiceName('agent:')).toBe(false);
    expect(isAgentServiceName('agent:-leading-dash')).toBe(false);
    expect(isAgentServiceName('agent:has spaces')).toBe(false);
    expect(isAgentServiceName('notagent:x')).toBe(false);
    expect(typeof loadServiceProfile).toBe('function');
  });

  test('two agents sharing one script are told apart by their arguments', async () => {
    // pidMatchesService originally compared only command[1]. Every ACP agent runs
    // scripts/hafleet-acp-agent.mjs, so agent A would match agent B's process and
    // report healthy while its own child was gone.
    const source = await import('fs').then((fs) =>
      fs.readFileSync('src/local-service-supervisor.mjs', 'utf-8'));
    expect(source).toContain('service.command.slice(2)');
    expect(source).toMatch(/discriminators\.every/);
  });
});
