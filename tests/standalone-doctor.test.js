import { afterEach, describe, expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { runDoctor } from '../services/standalone-doctor.mjs';
import { findSensitiveFields, writeBridgeHealthRecord, writePushRelayHealthRecord } from '../src/health-record.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve('.');
const cliPath = path.join(repoRoot, 'services', 'standalone-doctor.mjs');
const fixtureProfilePath = path.join(repoRoot, 'tests', 'fixtures', 'services-local-test.json');

const runtimes = [];

function tempRuntime() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-standalone-doctor-'));
  runtimes.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of runtimes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ── Fixtures ────────────────────────────────────────────────────────────────

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

const PALPO_VERSIONS_URL = 'https://matrix.example.test/_matrix/client/versions';
const BACKEND_URL = 'http://127.0.0.1:18099';

function healthyBackendBody(overrides = {}) {
  return {
    ok: true,
    agents: 3,
    onlineAgents: 3,
    auth: {
      agentTokens: {
        mode: 'hard',
        configuredMode: 'hard',
        behavior: 'enforce-loaded-tokens',
        managedAgentCount: 3,
        loadedManagedAgentTokenCount: 3,
        missingManagedAgentTokenCount: 0,
        missingManagedAgentNames: [],
        missingManagedAgentNamesTruncated: false,
        failClosedReady: true,
      },
      serverCredential: { boundary: 'compat-api-token' },
    },
    ...overrides,
  };
}

function fakeFetch(routes) {
  return async (url) => {
    const href = String(url);
    for (const [match, respond] of routes) {
      const matches = typeof match === 'string' ? href === match : match.test(href);
      if (matches) return typeof respond === 'function' ? respond(href) : respond;
    }
    throw new Error(`fakeFetch: no route configured for ${href}`);
  };
}

function healthyFetch({ backendBody = healthyBackendBody() } = {}) {
  return fakeFetch([
    [PALPO_VERSIONS_URL, jsonResponse({ versions: ['v1.9'] })],
    [`${BACKEND_URL}/health`, jsonResponse(backendBody)],
  ]);
}

function healthyDiagnoseServicesImpl() {
  return async () => ({
    ok: true,
    profile: 'services-local',
    checkedAt: new Date().toISOString(),
    services: [
      { name: 'backend', pid: 111, desired: 'running', healthy: true, reason: null },
      { name: 'dashboard', pid: 112, desired: 'running', healthy: true, reason: null },
      { name: 'bridge', pid: 113, desired: 'running', healthy: true, reason: null },
      { name: 'relay', pid: 114, desired: 'running', healthy: true, reason: null },
    ],
    failures: [],
  });
}

function baseEnv(overrides = {}) {
  return {
    MATRIX_HOMESERVER: 'https://matrix.example.test',
    HAFLEET_API: BACKEND_URL,
    ...overrides,
  };
}

function baseOptions(runtimeRoot, overrides = {}) {
  return {
    runtimeRoot,
    profile: { name: 'services-local', services: [] }, // ignored when diagnoseServicesImpl is stubbed
    env: baseEnv(overrides.env),
    fetchImpl: healthyFetch(),
    diagnoseServicesImpl: healthyDiagnoseServicesImpl(),
    ...overrides,
  };
}

function freshBridgeRecord(runtimeRoot, fields = {}) {
  writeBridgeHealthRecord(runtimeRoot, {
    pid: 1,
    processStartIdentity: 'proc:1',
    lastSuccessfulSyncAt: Date.now() - 1000,
    lastSuccessfulBackendDeliveryAt: Date.now() - 1000,
    managedRoomCount: 1,
    ...fields,
  });
}

function freshRelayRecord(runtimeRoot, fields = {}) {
  writePushRelayHealthRecord(runtimeRoot, {
    pid: 2,
    processStartIdentity: 'proc:2',
    lastSuccessfulBackendContactAt: Date.now() - 1000,
    lastSuccessfulOutboundDeliveryAt: Date.now() - 1000,
    ...fields,
  });
}

function check(result, name) {
  const found = result.checks.find((c) => c.name === name);
  expect(found, `expected a "${name}" check in ${JSON.stringify(result.checks.map((c) => c.name))}`).toBeDefined();
  return found;
}

// ── Happy path ──────────────────────────────────────────────────────────────

describe('runDoctor: happy path', () => {
  test('every check passes when every component is healthy and fresh', async () => {
    const runtimeRoot = tempRuntime();
    freshBridgeRecord(runtimeRoot, {
      requiredMembership: [{
        roomId: '!acceptance:example.test', group: 'acceptance', requiredAgent: null,
        botJoined: true, agentJoined: null, joinedAgentNames: ['reviewer-agent', 'coordinator-agent'],
      }],
    });
    freshRelayRecord(runtimeRoot);

    const result = await runDoctor(baseOptions(runtimeRoot, {
      env: baseEnv({ MATRIX_ACCEPTANCE_ROOM_ID: '!acceptance:example.test', MATRIX_ACCEPTANCE_AGENTS: 'reviewer-agent,coordinator-agent' }),
    }));

    expect(result.ok).toBe(true);
    for (const c of result.checks) expect(c.ok, `${c.name} unexpectedly failed: ${c.reason}`).toBe(true);
    expect(result.checks.map((c) => c.name).sort()).toEqual([
      'acceptanceRoomMembership', 'authAndTokenIntegrity', 'backend', 'bridgeHealthFreshness',
      'dashboard', 'palpo', 'relayHealthFreshness', 'supervisor',
    ].sort());
  });

  test('--allow-unconfigured-room lets an unset acceptance room pass, still labeled not_configured', async () => {
    const runtimeRoot = tempRuntime();
    freshBridgeRecord(runtimeRoot);
    freshRelayRecord(runtimeRoot);

    const result = await runDoctor(baseOptions(runtimeRoot, { allowUnconfiguredRoom: true }));

    expect(result.ok).toBe(true);
    const acceptance = check(result, 'acceptanceRoomMembership');
    expect(acceptance.ok).toBe(true);
    expect(acceptance.status).toBe('not_configured');
  });

  test('without --allow-unconfigured-room, an unset acceptance room fails the doctor overall', async () => {
    const runtimeRoot = tempRuntime();
    freshBridgeRecord(runtimeRoot);
    freshRelayRecord(runtimeRoot);

    const result = await runDoctor(baseOptions(runtimeRoot, { allowUnconfiguredRoom: false }));

    expect(result.ok).toBe(false);
    const acceptance = check(result, 'acceptanceRoomMembership');
    expect(acceptance.ok).toBe(false);
    expect(acceptance.status).toBe('not_configured');
  });
});

// ── Fault matrix (brief Step 3: all 8 required scenarios) ───────────────────

describe('runDoctor: fault matrix', () => {
  test('1. Palpo unreachable', async () => {
    const runtimeRoot = tempRuntime();
    freshBridgeRecord(runtimeRoot);
    freshRelayRecord(runtimeRoot);
    const fetchImpl = fakeFetch([
      [PALPO_VERSIONS_URL, () => { throw new Error('ECONNREFUSED'); }],
      [`${BACKEND_URL}/health`, jsonResponse(healthyBackendBody())],
    ]);

    const result = await runDoctor(baseOptions(runtimeRoot, { fetchImpl, allowUnconfiguredRoom: true }));

    expect(result.ok).toBe(false);
    expect(check(result, 'palpo').ok).toBe(false);
    expect(check(result, 'palpo').reason).toMatch(/ECONNREFUSED|unreachable/i);
  });

  test('2. backend unreachable', async () => {
    const runtimeRoot = tempRuntime();
    freshBridgeRecord(runtimeRoot);
    freshRelayRecord(runtimeRoot);
    const fetchImpl = fakeFetch([
      [PALPO_VERSIONS_URL, jsonResponse({ versions: ['v1.9'] })],
      [`${BACKEND_URL}/health`, () => { throw new Error('ECONNREFUSED'); }],
    ]);

    const result = await runDoctor(baseOptions(runtimeRoot, { fetchImpl, allowUnconfiguredRoom: true }));

    expect(result.ok).toBe(false);
    expect(check(result, 'backend').ok).toBe(false);
    // Cascades: auth/token integrity is read from the same backend /health payload.
    expect(check(result, 'authAndTokenIntegrity').ok).toBe(false);
    expect(check(result, 'authAndTokenIntegrity').reason).toMatch(/backend unreachable/i);
  });

  test('3. supervisor record stale (no state.json — real diagnoseServices, no injected fake)', async () => {
    const runtimeRoot = tempRuntime();
    freshBridgeRecord(runtimeRoot);
    freshRelayRecord(runtimeRoot);

    const result = await runDoctor({
      ...baseOptions(runtimeRoot, { allowUnconfiguredRoom: true }),
      profile: { name: 'services-local', services: [
        { name: 'backend', dependsOn: [] }, { name: 'dashboard', dependsOn: ['backend'] },
        { name: 'bridge', dependsOn: ['backend'] }, { name: 'relay', dependsOn: ['backend'] },
      ] },
      diagnoseServicesImpl: undefined, // use the real implementation
    });

    expect(result.ok).toBe(false);
    expect(check(result, 'supervisor').ok).toBe(false);
    expect(check(result, 'dashboard').ok).toBe(false);
  });

  test('4. bridge sync stale', async () => {
    const runtimeRoot = tempRuntime();
    freshBridgeRecord(runtimeRoot, { lastSuccessfulSyncAt: Date.now() - 999_000 });
    freshRelayRecord(runtimeRoot);

    const result = await runDoctor(baseOptions(runtimeRoot, {
      env: baseEnv({ BRIDGE_HEALTH_MAX_AGE_MS: '5000' }),
      allowUnconfiguredRoom: true,
    }));

    expect(result.ok).toBe(false);
    const bridge = check(result, 'bridgeHealthFreshness');
    expect(bridge.ok).toBe(false);
    expect(bridge.reason).toMatch(/sync/i);
  });

  test('5. relay delivery stale (backend contact still fresh — isolates the delivery signal)', async () => {
    const runtimeRoot = tempRuntime();
    freshBridgeRecord(runtimeRoot);
    freshRelayRecord(runtimeRoot, {
      lastSuccessfulBackendContactAt: Date.now() - 1000, // fresh
      lastSuccessfulOutboundDeliveryAt: Date.now() - 999_000, // stale
    });

    const result = await runDoctor(baseOptions(runtimeRoot, {
      env: baseEnv({ RELAY_HEALTH_MAX_AGE_MS: '5000' }),
      allowUnconfiguredRoom: true,
    }));

    expect(result.ok).toBe(false);
    const relay = check(result, 'relayHealthFreshness');
    expect(relay.ok).toBe(false);
    expect(relay.reason).toMatch(/delivery/i);
  });

  test('6. companion bot not joined to the acceptance room', async () => {
    const runtimeRoot = tempRuntime();
    freshBridgeRecord(runtimeRoot, {
      requiredMembership: [{
        roomId: '!acceptance:example.test', group: 'acceptance', requiredAgent: null,
        botJoined: false, agentJoined: null, joinedAgentNames: [],
      }],
    });
    freshRelayRecord(runtimeRoot);

    const result = await runDoctor(baseOptions(runtimeRoot, {
      env: baseEnv({ MATRIX_ACCEPTANCE_ROOM_ID: '!acceptance:example.test', MATRIX_ACCEPTANCE_AGENTS: 'reviewer-agent' }),
    }));

    expect(result.ok).toBe(false);
    const acceptance = check(result, 'acceptanceRoomMembership');
    expect(acceptance.ok).toBe(false);
    expect(acceptance.status).toBe('fail');
    expect(acceptance.reason).toMatch(/bot/i);
  });

  test('7. managed agent not joined to the acceptance room (bot is joined)', async () => {
    const runtimeRoot = tempRuntime();
    freshBridgeRecord(runtimeRoot, {
      requiredMembership: [{
        roomId: '!acceptance:example.test', group: 'acceptance', requiredAgent: null,
        botJoined: true, agentJoined: null, joinedAgentNames: ['someone-else-agent'],
      }],
    });
    freshRelayRecord(runtimeRoot);

    const result = await runDoctor(baseOptions(runtimeRoot, {
      env: baseEnv({ MATRIX_ACCEPTANCE_ROOM_ID: '!acceptance:example.test', MATRIX_ACCEPTANCE_AGENTS: 'reviewer-agent' }),
    }));

    expect(result.ok).toBe(false);
    const acceptance = check(result, 'acceptanceRoomMembership');
    expect(acceptance.ok).toBe(false);
    expect(acceptance.reason).toMatch(/reviewer-agent/);
    expect(acceptance.reason).not.toMatch(/bot is not joined/i);
  });

  test('8a. the shared health-record writer refuses to persist a sensitive field (defense in depth the doctor relies on)', () => {
    const runtimeRoot = tempRuntime();
    expect(() => writeBridgeHealthRecord(runtimeRoot, { processStartIdentity: 'Bearer leaked-token-value' }))
      .toThrow(/sensitive field/i);
    expect(() => writePushRelayHealthRecord(runtimeRoot, { lastErrorCode: 'Bearer leaked-token-value' }))
      .toThrow(/sensitive field/i);
  });

  test('8b. runDoctor output never contains a sensitive field, even when reading real bridge/relay health records', async () => {
    const runtimeRoot = tempRuntime();
    freshBridgeRecord(runtimeRoot, {
      requiredMembership: [{
        roomId: '!acceptance:example.test', group: 'acceptance', requiredAgent: null,
        botJoined: true, agentJoined: null, joinedAgentNames: ['reviewer-agent'],
      }],
    });
    freshRelayRecord(runtimeRoot);

    const result = await runDoctor(baseOptions(runtimeRoot, {
      env: baseEnv({ MATRIX_ACCEPTANCE_ROOM_ID: '!acceptance:example.test', MATRIX_ACCEPTANCE_AGENTS: 'reviewer-agent' }),
    }));

    expect(findSensitiveFields(result)).toEqual([]);
  });
});

// ── Auth mode / managed token integrity detail ───────────────────────────────

describe('runDoctor: authAndTokenIntegrity', () => {
  test('fails when the configured mode is not hard, even if every token is loaded', async () => {
    const runtimeRoot = tempRuntime();
    freshBridgeRecord(runtimeRoot);
    freshRelayRecord(runtimeRoot);
    const fetchImpl = healthyFetch({
      backendBody: healthyBackendBody({ auth: { agentTokens: { mode: 'audit', configuredMode: 'audit', failClosedReady: true } } }),
    });

    const result = await runDoctor(baseOptions(runtimeRoot, { fetchImpl, allowUnconfiguredRoom: true }));

    expect(check(result, 'authAndTokenIntegrity').ok).toBe(false);
    expect(check(result, 'authAndTokenIntegrity').reason).toMatch(/audit/);
  });

  test('fails when hard mode is configured but a managed agent token is missing', async () => {
    const runtimeRoot = tempRuntime();
    freshBridgeRecord(runtimeRoot);
    freshRelayRecord(runtimeRoot);
    const fetchImpl = healthyFetch({
      backendBody: healthyBackendBody({
        auth: {
          agentTokens: {
            mode: 'hard', configuredMode: 'hard', failClosedReady: false,
            missingManagedAgentTokenCount: 1, missingManagedAgentNames: ['alpha'],
          },
        },
      }),
    });

    const result = await runDoctor(baseOptions(runtimeRoot, { fetchImpl, allowUnconfiguredRoom: true }));

    expect(check(result, 'authAndTokenIntegrity').ok).toBe(false);
    expect(check(result, 'authAndTokenIntegrity').reason).toMatch(/alpha/);
  });
});

// ── CLI smoke test (spawns only this new doctor binary; no live Matrix/backend/tmux) ──

describe('standalone-doctor.mjs CLI', () => {
  test('exits non-zero and emits parseable JSON when nothing is reachable', async () => {
    const runtimeRoot = tempRuntime();
    const env = {
      ...process.env,
      HAFLEET_RUNTIME_DIR: runtimeRoot,
      MATRIX_HOMESERVER: 'http://127.0.0.1:1',
      HAFLEET_API: 'http://127.0.0.1:1',
    };

    await expect(execFileAsync(process.execPath, [
      cliPath, '--json', '--runtime', runtimeRoot, '--profile', fixtureProfilePath, '--allow-unconfigured-room',
    ], { cwd: repoRoot, env, timeout: 15000 })).rejects.toMatchObject({ code: 1 });

    const { stdout } = await execFileAsync(process.execPath, [
      cliPath, '--json', '--runtime', runtimeRoot, '--profile', fixtureProfilePath, '--allow-unconfigured-room',
    ], { cwd: repoRoot, env, timeout: 15000 }).catch((e) => e);

    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.checks.some((c) => c.name === 'palpo' && !c.ok)).toBe(true);
  });
});
