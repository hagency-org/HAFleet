import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { pathToFileURL } from 'url';

describe('room trust classifier (5.8.1)', () => {
  let runtimeDir;
  let getRoomTrust;
  let markRoomTrusted;
  let MATRIX_TRUST_MODE;

  beforeAll(async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'room-trust-test-'));
    const matrixDir = path.join(runtimeDir, 'data', 'matrix');
    mkdirSync(matrixDir, { recursive: true });
    // Seed bridge-state with existing rooms to verify managed-room trust
    writeFileSync(path.join(matrixDir, 'bridge-state.json'), JSON.stringify({
      botToken: null,
      agentTokens: {},
      roomGroupMap: { '!existing:matrix.test': 'ops-chat' },
      groupRoomMap: { 'ops-chat': '!existing:matrix.test' },
      dmRooms: { 'dm:testbot': '!dm-existing:matrix.test' },
    }, null, 2));
    process.env.AGENT_CHAT_RUNTIME_DIR = runtimeDir;
    process.env.MATRIX_TRUST_MODE = 'audit';
    process.env.MATRIX_TRUSTED_ROOM_IDS = '!allow1:matrix.test,!allow2:matrix.test';
    process.env.MATRIX_TRUSTED_INVITER_MXIDS = '@admin:matrix.test';

    const bridgeUrl = pathToFileURL(path.resolve('bridge-matrix.js')).href;
    const cacheBust = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    ({ getRoomTrust, markRoomTrusted, MATRIX_TRUST_MODE } = await import(`${bridgeUrl}?trust-test=${cacheBust}`));
  });

  afterAll(() => {
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  test('room in allowlist is trusted', () => {
    const result = getRoomTrust('!allow1:matrix.test');
    expect(result).toEqual({ trusted: true, reason: 'allowlist' });
  });

  test('managed room (from existing roomGroupMap) is trusted', () => {
    const result = getRoomTrust('!existing:matrix.test');
    expect(result).toEqual({ trusted: true, reason: 'managed' });
  });

  test('managed DM room (from existing dmRooms) is trusted', () => {
    const result = getRoomTrust('!dm-existing:matrix.test');
    expect(result).toEqual({ trusted: true, reason: 'managed' });
  });

  test('room with trusted inviter MXID is trusted', () => {
    const result = getRoomTrust('!unknown:matrix.test', { inviterMxid: '@admin:matrix.test' });
    expect(result).toEqual({ trusted: true, reason: 'trusted_inviter' });
  });

  test('unknown room without any trust signal is untrusted', () => {
    const result = getRoomTrust('!rando:evil.server');
    expect(result).toEqual({ trusted: false, reason: 'unknown_room' });
  });

  test('unknown room with untrusted inviter is untrusted', () => {
    const result = getRoomTrust('!rando:evil.server', { inviterMxid: '@hacker:evil.server' });
    expect(result).toEqual({ trusted: false, reason: 'unknown_room' });
  });

  test('markRoomTrusted makes a room trusted', () => {
    expect(getRoomTrust('!new-room:matrix.test').trusted).toBe(false);
    markRoomTrusted('!new-room:matrix.test', { group: 'new-group' });
    const result = getRoomTrust('!new-room:matrix.test');
    expect(result).toEqual({ trusted: true, reason: 'managed' });
  });

  test('trust mode defaults to audit', () => {
    expect(MATRIX_TRUST_MODE).toBe('audit');
  });
});
