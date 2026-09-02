import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/*
 * An m.room.name event for a room with no group creates one — from the room's MEMBERSHIP. When
 * that membership cannot be read, the handler must neither create an empty group nor answer as if
 * it had handled the event: it throws a retryable error so the router answers 500 and the event is
 * redelivered. A quiet return was tried first and let the sync cursor advance past the only event
 * that triggers the mapping; a bot-less bridge has no scanJoinedRooms to catch that later.
 */
let MatrixBridge;
let runtime;
let savedRuntimeDir;
let savedApi;
beforeAll(async () => {
  savedRuntimeDir = process.env.HAFLEET_RUNTIME_DIR;
  savedApi = process.env.HAFLEET_API;
  runtime = mkdtempSync(path.join(tmpdir(), 'hafleet-room-name-'));
  process.env.HAFLEET_RUNTIME_DIR = runtime;
  process.env.HAFLEET_API = 'http://127.0.0.1:1';
  ({ MatrixBridge } = await import('../bridge-matrix.js'));
});
afterAll(() => {
  rmSync(runtime, { recursive: true, force: true });
  for (const [key, value] of [['HAFLEET_RUNTIME_DIR', savedRuntimeDir], ['HAFLEET_API', savedApi]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
afterEach(() => vi.unstubAllGlobals());

const ROOM = '!fresh-room:side.test';
const nameEvent = () => ({ type: 'm.room.name', event_id: '$name', sender: '@alex:side.test', origin_server_ts: Date.now() + 60_000, content: { name: 'a brand new customer room' } });

function backendStub(posts) {
  return vi.fn(async (url, init = {}) => {
    const method = init.method ?? 'GET';
    if (method === 'GET') return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'group not found' }) };
    posts.push({ url: String(url), body: init.body });
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
  });
}

function bridgeStub(membership) {
  return {
    startupTs: 0,
    _bridgeCreatedGroups: new Set(),
    joinedMembersOf: async () => membership,
    reconcileRoomGroupMembership: async () => {},
    syncApprovalBindingForRoom: async () => {},
    botUserId: null,
  };
}

describe('m.room.name with unreadable membership', () => {
  test('throws a retryable membership_unknown error and posts no group', async () => {
    const posts = [];
    vi.stubGlobal('fetch', backendStub(posts));
    const self = bridgeStub({ known: false, members: [], reason: 'no bot and no credential for that server' });
    await expect(MatrixBridge.prototype.onRoomEvent.call(self, ROOM, nameEvent()))
      .rejects.toMatchObject({ code: 'membership_unknown', retryable: true });
    expect(posts.filter((p) => p.url.endsWith('/api/groups'))).toHaveLength(0);
  });

  test('with membership known, the group is created exactly once', async () => {
    const posts = [];
    vi.stubGlobal('fetch', backendStub(posts));
    const self = bridgeStub({ known: true, members: ['@alex:side.test'], reason: null });
    await expect(MatrixBridge.prototype.onRoomEvent.call(self, '!another-room:side.test', nameEvent())).resolves.toBeUndefined();
    expect(posts.filter((p) => p.url.endsWith('/api/groups'))).toHaveLength(1);
  });
});
