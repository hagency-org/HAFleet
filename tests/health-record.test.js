import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'fs';
import os from 'os';
import path from 'path';

import {
  buildBridgeHealthRecord,
  buildPushRelayHealthRecord,
  findSensitiveFields,
  healthPaths,
  writeBridgeHealthRecord,
  writeHealthRecordAtomic,
  writePushRelayHealthRecord,
} from '../src/health-record.mjs';

const runtimes = [];

function tempRuntime() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agentchat-health-record-'));
  runtimes.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of runtimes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('healthPaths', () => {
  test('resolves bridge and relay paths under <runtimeRoot>/data/health', () => {
    const runtimeRoot = tempRuntime();
    const paths = healthPaths(runtimeRoot);

    expect(paths.dir).toBe(path.join(path.resolve(runtimeRoot), 'data', 'health'));
    expect(paths.bridgePath).toBe(path.join(paths.dir, 'matrix-bridge.json'));
    expect(paths.relayPath).toBe(path.join(paths.dir, 'push-relay.json'));
  });

  test('resolves a relative runtimeRoot the same as its absolute form', () => {
    const runtimeRoot = tempRuntime();
    const relative = path.relative(process.cwd(), runtimeRoot);
    expect(healthPaths(relative).dir).toBe(healthPaths(runtimeRoot).dir);
  });
});

describe('buildBridgeHealthRecord', () => {
  test('is null-safe with no fields supplied', () => {
    const record = buildBridgeHealthRecord();
    expect(record.schemaVersion).toBe(1);
    expect(record.component).toBe('matrix-bridge');
    expect(typeof record.generatedAt).toBe('string');
    expect(record.process).toEqual({ pid: null, startedAt: null, processStartIdentity: null });
    expect(record.lastSuccessfulSyncAt).toBeNull();
    expect(record.lastSuccessfulBackendDeliveryAt).toBeNull();
    expect(record.lastObservedRateLimitAt).toBeNull();
    expect(record.managedRoomCount).toBe(0);
    expect(record.requiredMembership).toEqual([]);
  });

  test('normalizes epoch-ms timestamps to ISO strings and copies known fields', () => {
    const now = () => new Date('2026-07-17T12:00:00.000Z');
    const record = buildBridgeHealthRecord({
      pid: 4242,
      startedAt: 1_700_000_000_000,
      processStartIdentity: 'proc:12345',
      lastSuccessfulSyncAt: 1_700_000_001_000,
      lastSuccessfulBackendDeliveryAt: 1_700_000_002_000,
      lastObservedRateLimitAt: 1_700_000_003_000,
      managedRoomCount: 3,
      requiredMembership: [
        { roomId: '!acceptance:example.com', group: 'acceptance', requiredAgent: 'reviewer-agent', botJoined: true, agentJoined: true, joinedAgentNames: ['reviewer-agent', 'coordinator-agent'] },
        { roomId: '!other:example.com', botJoined: false },
      ],
      now,
    });

    expect(record.generatedAt).toBe('2026-07-17T12:00:00.000Z');
    expect(record.process).toEqual({ pid: 4242, startedAt: new Date(1_700_000_000_000).toISOString(), processStartIdentity: 'proc:12345' });
    expect(record.lastSuccessfulSyncAt).toBe(new Date(1_700_000_001_000).toISOString());
    expect(record.lastSuccessfulBackendDeliveryAt).toBe(new Date(1_700_000_002_000).toISOString());
    expect(record.lastObservedRateLimitAt).toBe(new Date(1_700_000_003_000).toISOString());
    expect(record.managedRoomCount).toBe(3);
    expect(record.requiredMembership).toEqual([
      { roomId: '!acceptance:example.com', group: 'acceptance', requiredAgent: 'reviewer-agent', botJoined: true, agentJoined: true, joinedAgentNames: ['reviewer-agent', 'coordinator-agent'] },
      { roomId: '!other:example.com', group: null, requiredAgent: null, botJoined: false, agentJoined: null, joinedAgentNames: [] },
    ]);
  });

  test('never echoes unknown/extra input fields into the record', () => {
    const record = buildBridgeHealthRecord({ botToken: 'should-not-appear', matrixBridgeSecret: 'nope' });
    expect(JSON.stringify(record)).not.toMatch(/should-not-appear|nope/);
  });
});

describe('buildPushRelayHealthRecord', () => {
  test('is null-safe with no fields supplied', () => {
    const record = buildPushRelayHealthRecord();
    expect(record.schemaVersion).toBe(1);
    expect(record.component).toBe('push-relay');
    expect(record.process).toEqual({ pid: null, startedAt: null, processStartIdentity: null });
    expect(record.lastSuccessfulBackendContactAt).toBeNull();
    expect(record.lastSuccessfulOutboundDeliveryAt).toBeNull();
    expect(record.lastErrorCode).toBeNull();
  });

  test('copies known fields and normalizes timestamps', () => {
    const record = buildPushRelayHealthRecord({
      pid: 99,
      startedAt: 1_700_000_000_000,
      processStartIdentity: 'proc:99',
      lastSuccessfulBackendContactAt: 1_700_000_005_000,
      lastSuccessfulOutboundDeliveryAt: 1_700_000_006_000,
      lastErrorCode: 'tmux_inject_failed',
    });

    expect(record.process).toEqual({ pid: 99, startedAt: new Date(1_700_000_000_000).toISOString(), processStartIdentity: 'proc:99' });
    expect(record.lastSuccessfulBackendContactAt).toBe(new Date(1_700_000_005_000).toISOString());
    expect(record.lastSuccessfulOutboundDeliveryAt).toBe(new Date(1_700_000_006_000).toISOString());
    expect(record.lastErrorCode).toBe('tmux_inject_failed');
  });
});

describe('findSensitiveFields', () => {
  test('returns no violations for a realistic clean bridge record', () => {
    const record = buildBridgeHealthRecord({
      pid: 1,
      processStartIdentity: 'ps:Thu Jul 17 12:00:00 2026',
      managedRoomCount: 1,
      requiredMembership: [
        { roomId: '!acceptance-room:matrix.example.com', group: 'acceptance', requiredAgent: 'reviewer-agent', botJoined: true, agentJoined: true, joinedAgentNames: ['reviewer-agent', 'coordinator-agent-2'] },
      ],
    });
    expect(findSensitiveFields(record)).toEqual([]);
  });

  test('returns no violations for a realistic clean relay record', () => {
    const record = buildPushRelayHealthRecord({ pid: 1, processStartIdentity: 'proc:12345', lastErrorCode: 'heartbeat_http_502' });
    expect(findSensitiveFields(record)).toEqual([]);
  });

  test('flags a forbidden key name anywhere in the object, however deeply nested', () => {
    const violations = findSensitiveFields({ process: { pid: 1, nested: { apiToken: 'x' } } });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].path).toContain('apiToken');
  });

  test.each([
    ['bridge secret key name', { matrixBridgeSecret: 'x' }],
    ['password key name', { password: 'x' }],
    ['credential key name', { credential: 'x' }],
    ['bearer-shaped value', { lastErrorCode: 'Bearer abc.def.ghi' }],
    ['matrix access token-shaped value', { lastErrorCode: 'syt_YWJjZGVm_reallyLongOpaqueTail1234567890' }],
    ['jwt-shaped value', { lastErrorCode: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U' }],
  ])('flags %s', (_label, fields) => {
    expect(findSensitiveFields(fields).length).toBeGreaterThan(0);
  });

  test.each([
    ['matrix room id', '!acceptance-room-1234567890123456:matrix.example.com'],
    ['matrix user id', '@ac_reviewer-agent:matrix.example.com'],
    ['hyphenated agent/group name', 'super-long-descriptive-acceptance-room-group-name'],
    ['iso timestamp', '2026-07-17T12:00:00.000Z'],
    ['proc identity', 'proc:18446744073709551615'],
    ['ps identity', 'ps:Thu Jul 17 12:00:00 2026'],
  ])('does not false-positive on %s', (_label, value) => {
    expect(findSensitiveFields({ someField: value })).toEqual([]);
  });
});

describe('writeHealthRecordAtomic', () => {
  test('writes JSON content with 0600 permissions via tmp+rename, no leftover tmp files', () => {
    const runtimeRoot = tempRuntime();
    const target = path.join(runtimeRoot, 'data', 'health', 'example.json');
    const record = { schemaVersion: 1, component: 'example', generatedAt: new Date().toISOString() };

    writeHealthRecordAtomic(target, record);

    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual(record);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    const siblings = readdirSync(path.dirname(target));
    expect(siblings).toEqual(['example.json']);
  });

  test('creates missing parent directories', () => {
    const runtimeRoot = tempRuntime();
    const target = path.join(runtimeRoot, 'data', 'health', 'example.json');
    writeHealthRecordAtomic(target, { ok: true });
    expect(statSync(path.dirname(target)).isDirectory()).toBe(true);
  });

  test('refuses to write and leaves an existing file untouched when the record contains a sensitive field', () => {
    const runtimeRoot = tempRuntime();
    const target = path.join(runtimeRoot, 'data', 'health', 'example.json');
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, '{"safe":true}\n', { mode: 0o600 });

    expect(() => writeHealthRecordAtomic(target, { password: 'hunter2' })).toThrow(/sensitive field/i);
    expect(readFileSync(target, 'utf8')).toBe('{"safe":true}\n');
    const siblings = readdirSync(path.dirname(target));
    expect(siblings).toEqual(['example.json']); // no leftover .tmp from the aborted write
  });

  test('does not leak the offending value into the thrown error message', () => {
    const runtimeRoot = tempRuntime();
    const target = path.join(runtimeRoot, 'data', 'health', 'example.json');
    try {
      writeHealthRecordAtomic(target, { lastErrorCode: 'Bearer super-secret-value-should-not-leak' });
      throw new Error('expected write to throw');
    } catch (error) {
      expect(error.message).not.toContain('super-secret-value-should-not-leak');
    }
  });
});

describe('writeBridgeHealthRecord / writePushRelayHealthRecord', () => {
  test('writes the bridge record to <runtimeRoot>/data/health/matrix-bridge.json', () => {
    const runtimeRoot = tempRuntime();
    writeBridgeHealthRecord(runtimeRoot, { pid: 7, managedRoomCount: 2 });

    const { bridgePath } = healthPaths(runtimeRoot);
    const written = JSON.parse(readFileSync(bridgePath, 'utf8'));
    expect(written.component).toBe('matrix-bridge');
    expect(written.process.pid).toBe(7);
    expect(written.managedRoomCount).toBe(2);
    expect(statSync(bridgePath).mode & 0o777).toBe(0o600);
  });

  test('writes the relay record to <runtimeRoot>/data/health/push-relay.json', () => {
    const runtimeRoot = tempRuntime();
    writePushRelayHealthRecord(runtimeRoot, { pid: 8, lastErrorCode: 'sse_error' });

    const { relayPath } = healthPaths(runtimeRoot);
    const written = JSON.parse(readFileSync(relayPath, 'utf8'));
    expect(written.component).toBe('push-relay');
    expect(written.process.pid).toBe(8);
    expect(written.lastErrorCode).toBe('sse_error');
    expect(statSync(relayPath).mode & 0o777).toBe(0o600);
  });

  test('requiredMembership entries are whitelisted, so an unknown key on them is dropped rather than written', () => {
    const runtimeRoot = tempRuntime();
    writeBridgeHealthRecord(runtimeRoot, {
      requiredMembership: [{ roomId: '!a:b', botToken: 'should-not-be-here', botJoined: true }],
    });
    const { bridgePath } = healthPaths(runtimeRoot);
    const written = readFileSync(bridgePath, 'utf8');
    expect(written).not.toContain('botToken');
    expect(written).not.toContain('should-not-be-here');
    expect(JSON.parse(written).requiredMembership[0]).toMatchObject({ roomId: '!a:b', botJoined: true });
  });

  test('rejects a bridge write whose scalar field value has a sensitive shape, without writing a file', () => {
    const runtimeRoot = tempRuntime();
    expect(() => writeBridgeHealthRecord(runtimeRoot, {
      processStartIdentity: 'Bearer should-not-leak-token-value',
    })).toThrow(/sensitive field/i);
    const { bridgePath } = healthPaths(runtimeRoot);
    expect(() => readFileSync(bridgePath, 'utf8')).toThrow();
  });
});
