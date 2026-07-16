import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import request from 'supertest';

import { MatrixEventStore } from '../src/matrix-event-store.mjs';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';
import { restoreEnv, snapshotEnv } from './helpers/env.js';

const repoRoot = path.resolve('.');
let runtimeDir;
let MatrixBridge;
let envSnapshot;
const mappedRooms = [];

function createBridge({ store, submit, members = null }) {
  const bridge = new MatrixBridge({ eventStore: store });
  bridge.botUserId = '@agent-bridge:matrix.test';
  bridge.addKnownAgent('wf_coordinator');
  bridge.botClient = {
    getJoinedRoomMembers: vi.fn().mockResolvedValue(members || [
      '@agent-bridge:matrix.test',
      '@alice:matrix.test',
      '@ac_wf_coordinator:matrix.test',
    ]),
  };
  if (submit) bridge.submitHumanMessage = submit;
  return bridge;
}

function mapRoom(bridge, roomId, groupName = 'factory') {
  bridge.getBridgeState().roomGroupMap[roomId] = groupName;
  mappedRooms.push([bridge, roomId]);
}

function commandEvent(eventId = '$create-issue-1') {
  return {
    event_id: eventId,
    sender: '@alice:matrix.test',
    content: { msgtype: 'm.text', body: 'create issue: durable Matrix routing' },
  };
}

beforeAll(async () => {
  runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'agentchat-fsf0-b2-routing-'));
  envSnapshot = snapshotEnv([
    'AGENT_CHAT_RUNTIME_DIR',
    'MATRIX_TRUST_MODE',
    'MATRIX_TRUSTED_ROOM_IDS',
    'MATRIX_TRUSTED_INVITER_MXIDS',
    'MATRIX_IGNORED_SENDER_MXIDS',
  ]);
  process.env.AGENT_CHAT_RUNTIME_DIR = runtimeDir;
  process.env.MATRIX_TRUST_MODE = 'enforce';
  process.env.MATRIX_TRUSTED_ROOM_IDS = '!factory:matrix.test';
  process.env.MATRIX_TRUSTED_INVITER_MXIDS = '@trusted:matrix.test';
  process.env.MATRIX_IGNORED_SENDER_MXIDS = '@appservice:matrix.test';
  const url = pathToFileURL(path.join(repoRoot, 'bridge-matrix.js')).href;
  ({ MatrixBridge } = await import(`${url}?fsf0-b2=${Date.now()}-${Math.random()}`));
});

afterEach(() => {
  for (const [bridge, roomId] of mappedRooms.splice(0)) {
    delete bridge.getBridgeState().roomGroupMap[roomId];
  }
  vi.restoreAllMocks();
});

afterAll(() => {
  rmSync(runtimeDir, { recursive: true, force: true });
  restoreEnv(envSnapshot);
});

test('replay_after_restart_zero_duplicates', async () => {
  const roomId = '!factory:matrix.test';
  const journalPath = path.join(runtimeDir, 'data', 'matrix', 'restart-events.jsonl');
  const firstSubmit = vi.fn().mockResolvedValue({ ok: true, id: 'msg_1' });
  const first = createBridge({
    store: new MatrixEventStore({ journalPath }),
    submit: firstSubmit,
  });
  mapRoom(first, roomId);

  await first.onRoomMessage(roomId, commandEvent());

  const restartedStore = new MatrixEventStore({ journalPath });
  const replaySubmit = vi.fn().mockResolvedValue({ ok: true, id: 'msg_2' });
  const restarted = createBridge({ store: restartedStore, submit: replaySubmit });
  mapRoom(restarted, roomId);
  await restarted.onRoomMessage(roomId, commandEvent());

  expect(firstSubmit).toHaveBeenCalledTimes(1);
  expect(replaySubmit).not.toHaveBeenCalled();
  expect(restartedStore.get('$create-issue-1')).toMatchObject({ messageId: 'msg_1' });
});

test('concurrent delivery of one Matrix event issues one backend request', async () => {
  const roomId = '!factory:matrix.test';
  const journalPath = path.join(runtimeDir, 'data', 'matrix', 'concurrent-events.jsonl');
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const submit = vi.fn().mockImplementation(() => pending);
  const bridge = createBridge({ store: new MatrixEventStore({ journalPath }), submit });
  mapRoom(bridge, roomId);

  const first = bridge.onRoomMessage(roomId, commandEvent('$concurrent-event'));
  await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  const duplicate = bridge.onRoomMessage(roomId, commandEvent('$concurrent-event'));
  release({ ok: true, id: 'msg_concurrent' });
  await Promise.all([first, duplicate]);

  expect(submit).toHaveBeenCalledTimes(1);
  expect(new MatrixEventStore({ journalPath }).get('$concurrent-event')).toMatchObject({
    messageId: 'msg_concurrent',
  });
});

test('concurrent duplicate waits for the claimed attempt and remains replayable after failure', async () => {
  const roomId = '!factory:matrix.test';
  const journalPath = path.join(runtimeDir, 'data', 'matrix', 'concurrent-failure-events.jsonl');
  let rejectAttempt;
  const pending = new Promise((_resolve, reject) => { rejectAttempt = reject; });
  const submit = vi.fn().mockImplementation(() => pending);
  const bridge = createBridge({ store: new MatrixEventStore({ journalPath }), submit });
  mapRoom(bridge, roomId);

  const first = bridge.onRoomMessage(roomId, commandEvent('$concurrent-failure'));
  await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  const duplicate = bridge.onRoomMessage(roomId, commandEvent('$concurrent-failure'));
  rejectAttempt(new Error('backend unavailable'));

  const attempts = await Promise.allSettled([first, duplicate]);
  expect(attempts.map((attempt) => attempt.status)).toEqual(['rejected', 'rejected']);
  expect(new MatrixEventStore({ journalPath }).has('$concurrent-failure')).toBe(false);

  submit.mockResolvedValueOnce({ ok: true, id: 'msg_recovered' });
  await bridge.onRoomMessage(roomId, commandEvent('$concurrent-failure'));
  expect(submit).toHaveBeenCalledTimes(2);
});

test('accepted_before_checkpoint_replay_zero_duplicates', async () => {
  const backend = await createBackendTestContext('agentchat-fsf0-b2-crash-window-', {
    agents: {
      wf_coordinator: {
        name: 'wf_coordinator', type: 'agent', kind: 'agent', online: true,
      },
    },
    groups: {
      factory: { name: 'factory', members: ['wf_coordinator'], createdAt: 1000 },
    },
    env: { MATRIX_BRIDGE_SECRET: 'fsf0-b2-bridge-secret' },
  });
  const roomId = '!factory:matrix.test';
  const journalPath = path.join(runtimeDir, 'data', 'matrix', 'crash-window-events.jsonl');
  const acceptedStore = new MatrixEventStore({ journalPath });
  acceptedStore.recordProcessed = vi.fn(() => {
    throw new Error('injected checkpoint failure');
  });
  const first = createBridge({ store: acceptedStore });
  mapRoom(first, roomId);
  const callBackend = async (method, route, payload) => {
    const response = await request(backend.app)
      [method.toLowerCase()](route)
      .set('X-Bridge-Secret', 'fsf0-b2-bridge-secret')
      .send(payload);
    if (!response.ok) throw new Error(`backend ${method} ${route} failed: ${response.status}`);
    return response.body;
  };
  first.callBackendApi = vi.fn(callBackend);

  try {
    await expect(first.onRoomMessage(roomId, commandEvent('$crash-window-event')))
      .rejects.toThrow('injected checkpoint failure');
    const persistedAfterCrash = JSON.parse(readFileSync(
      path.join(backend.runtimeDir, 'data', 'messages.json'), 'utf8',
    ));
    expect(persistedAfterCrash).toHaveLength(1);

    const recoveredStore = new MatrixEventStore({ journalPath });
    const restarted = createBridge({ store: recoveredStore });
    mapRoom(restarted, roomId);
    restarted.callBackendApi = vi.fn(callBackend);
    await restarted.onRoomMessage(roomId, commandEvent('$crash-window-event'));

    const persistedAfterReplay = JSON.parse(readFileSync(
      path.join(backend.runtimeDir, 'data', 'messages.json'), 'utf8',
    ));
    expect(persistedAfterReplay).toHaveLength(1);
    expect(persistedAfterReplay[0].id).toBe(persistedAfterCrash[0].id);
    expect(recoveredStore.get('$crash-window-event')).toMatchObject({
      messageId: persistedAfterCrash[0].id,
    });
    const deliveryRows = readFileSync(
      path.join(backend.runtimeDir, 'data', 'message-delivery-events.jsonl'), 'utf8',
    ).trim().split('\n').filter(Boolean).map(JSON.parse);
    expect(deliveryRows.filter((row) => row.type === 'message.accepted')).toHaveLength(1);
  } finally {
    backend.cleanup();
  }
});

test('routes_mapped_room_as_group_wakes_coordinator', async () => {
  const roomId = '!factory:matrix.test';
  const submit = vi.fn().mockResolvedValue({ ok: true, id: 'msg_group_route' });
  const bridge = createBridge({
    store: new MatrixEventStore({
      journalPath: path.join(runtimeDir, 'data', 'matrix', 'mapped-group-events.jsonl'),
    }),
    submit,
    members: [
      '@agent-bridge:matrix.test',
      '@alice:matrix.test',
      '@ac_implementer:matrix.test',
    ],
  });
  bridge.addKnownAgent('implementer');
  mapRoom(bridge, roomId, 'factory');

  await bridge.onRoomMessage(roomId, commandEvent('$mapped-group-event'));

  expect(submit).toHaveBeenCalledTimes(1);
  expect(submit.mock.calls[0][1]).toMatchObject({
    group: 'factory',
    mentions: ['wf_coordinator'],
    source_event_id: '$mapped-group-event',
  });
  expect(submit.mock.calls[0][1]).not.toHaveProperty('to');
});

test('mapped_room_coordinator_delivered_by_backend', async () => {
  const backend = await createBackendTestContext('agentchat-fsf0-b2-group-delivery-', {
    agents: {
      implementer: { name: 'implementer', type: 'agent', kind: 'agent', online: true },
      wf_coordinator: { name: 'wf_coordinator', type: 'agent', kind: 'agent', online: true },
    },
    groups: {
      factory: { name: 'factory', members: ['implementer'], createdAt: 1000 },
    },
    env: { MATRIX_BRIDGE_SECRET: 'fsf0-b2-bridge-secret' },
  });
  const roomId = '!factory:matrix.test';
  const bridge = createBridge({
    store: new MatrixEventStore({
      journalPath: path.join(runtimeDir, 'data', 'matrix', 'integrated-group-events.jsonl'),
    }),
    members: [
      '@agent-bridge:matrix.test',
      '@alice:matrix.test',
      '@ac_implementer:matrix.test',
    ],
  });
  bridge.addKnownAgent('implementer');
  mapRoom(bridge, roomId, 'factory');
  bridge.callBackendApi = async (method, route, payload) => {
    const response = await request(backend.app)
      [method.toLowerCase()](route)
      .set('X-Bridge-Secret', 'fsf0-b2-bridge-secret')
      .send(payload);
    if (!response.ok) throw new Error(`backend ${response.status}`);
    return response.body;
  };

  try {
    const result = await bridge.onRoomMessage(roomId, commandEvent('$integrated-group-event'));
    expect(result).toMatchObject({ ok: true, delivery: { suppressed: [] } });
    const rows = readFileSync(
      path.join(backend.runtimeDir, 'data', 'message-delivery-events.jsonl'), 'utf8',
    ).trim().split('\n').filter(Boolean).map(JSON.parse);
    expect(rows.find((row) => row.type === 'message.accepted')?.targetAgents)
      .toContain('wf_coordinator');
    const inbox = await request(backend.app)
      .get('/api/inbox/wf_coordinator/unread-list?limit=0');
    expect(inbox.status).toBe(200);
    expect(inbox.body.messages).toHaveLength(1);
    expect(inbox.body.messages[0].id).toBe(result.id);
  } finally {
    backend.cleanup();
  }
});

test('untrusted_inviter_denied', async () => {
  const bridge = createBridge({
    store: new MatrixEventStore({
      journalPath: path.join(runtimeDir, 'data', 'matrix', 'invite-events.jsonl'),
    }),
    submit: vi.fn(),
  });
  bridge.botClient.joinRoom = vi.fn().mockResolvedValue(undefined);
  bridge.botClient.leaveRoom = vi.fn().mockResolvedValue(undefined);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});

  const result = await bridge.handleBotInvite('!untrusted:matrix.test', {
    sender: '@evil:matrix.test',
  });

  expect(result).toMatchObject({ accepted: false, reason: expect.any(String) });
  expect(bridge.botClient.joinRoom).not.toHaveBeenCalled();
  expect(bridge.botClient.leaveRoom).toHaveBeenCalledWith('!untrusted:matrix.test');
  // The redacted reason tag (never the bridge secret or a raw exception) is what gets logged.
  expect(log.mock.calls.flat().join(' ')).toContain('reason=untrusted_inviter');
  expect(log.mock.calls.flat().join(' ')).toContain('@evil:matrix.test');
});

test('trusted_inviter_allowed', async () => {
  const roomId = '!trusted-invite-room:matrix.test';
  const bridge = createBridge({
    store: new MatrixEventStore({
      journalPath: path.join(runtimeDir, 'data', 'matrix', 'trusted-invite-events.jsonl'),
    }),
    submit: vi.fn(),
  });
  bridge.botClient.joinRoom = vi.fn().mockResolvedValue(undefined);
  bridge.botClient.leaveRoom = vi.fn().mockResolvedValue(undefined);

  const result = await bridge.handleBotInvite(roomId, {
    sender: '@trusted:matrix.test',
  });

  expect(result).toMatchObject({ accepted: true, reason: 'trusted_inviter', inviter: '@trusted:matrix.test' });
  expect(bridge.botClient.joinRoom).toHaveBeenCalledWith(roomId);
  expect(bridge.botClient.leaveRoom).not.toHaveBeenCalled();
});

test('allowlisted_room_untrusted_inviter_denied', async () => {
  const bridge = createBridge({
    store: new MatrixEventStore({
      journalPath: path.join(runtimeDir, 'data', 'matrix', 'allowlist-invite-events.jsonl'),
    }),
    submit: vi.fn(),
  });
  bridge.botClient.joinRoom = vi.fn().mockResolvedValue(undefined);
  bridge.botClient.leaveRoom = vi.fn().mockResolvedValue(undefined);

  const result = await bridge.handleBotInvite('!factory:matrix.test', {
    sender: '@evil:matrix.test',
  });

  expect(result).toMatchObject({ accepted: false, reason: 'untrusted_inviter' });
  expect(bridge.botClient.joinRoom).not.toHaveBeenCalled();
});

test('ignored_sender_not_routed', async () => {
  const roomId = '!factory:matrix.test';
  const submit = vi.fn().mockResolvedValue({ ok: true, id: 'msg_must_not_exist' });
  const bridge = createBridge({
    store: new MatrixEventStore({
      journalPath: path.join(runtimeDir, 'data', 'matrix', 'ignored-events.jsonl'),
    }),
    submit,
  });
  mapRoom(bridge, roomId, 'factory');

  await bridge.onRoomMessage(roomId, {
    ...commandEvent('$ignored-appservice-event'),
    sender: '@appservice:matrix.test',
  });

  expect(submit).not.toHaveBeenCalled();
});

test('create_issue_routed_exactly_once', async () => {
  const roomId = '!factory:matrix.test';
  const journalPath = path.join(runtimeDir, 'data', 'matrix', 'create-issue-events.jsonl');
  const submit = vi.fn().mockResolvedValue({ ok: true, id: 'msg_create_issue' });
  const bridge = createBridge({ store: new MatrixEventStore({ journalPath }), submit });
  mapRoom(bridge, roomId, 'factory');
  const event = commandEvent('$create-issue-exactly-once');

  await bridge.onRoomMessage(roomId, event);
  await bridge.onRoomMessage(roomId, event);

  expect(submit).toHaveBeenCalledTimes(1);
  expect(submit.mock.calls[0][1]).toMatchObject({
    group: 'factory',
    mentions: ['wf_coordinator'],
    source_event_id: '$create-issue-exactly-once',
  });
  expect(new MatrixEventStore({ journalPath }).get('$create-issue-exactly-once')).toMatchObject({
    messageId: 'msg_create_issue',
  });
});

test('missing_event_id_not_dispatched', async () => {
  const roomId = '!factory:matrix.test';
  const submit = vi.fn().mockResolvedValue({ ok: true, id: 'msg_without_event_id' });
  const bridge = createBridge({
    store: new MatrixEventStore({
      journalPath: path.join(runtimeDir, 'data', 'matrix', 'missing-event-id.jsonl'),
    }),
    submit,
  });
  mapRoom(bridge, roomId, 'factory');
  const event = commandEvent();
  delete event.event_id;

  await bridge.onRoomMessage(roomId, event);

  expect(submit).not.toHaveBeenCalled();
});

test('corrupt_processed_event_journal_fails_closed', () => {
  const journalPath = path.join(runtimeDir, 'data', 'matrix', 'processed-events.jsonl');
  mkdirSync(path.dirname(journalPath), { recursive: true });
  writeFileSync(journalPath, '{"eventId":"$ok","messageId":"msg_ok"}\n{malformed}\n');

  try {
    expect(() => new MatrixBridge()).toThrow(new RegExp(
      `${path.basename(journalPath)}.*line 2|line 2.*${path.basename(journalPath)}`,
      'i',
    ));
  } finally {
    rmSync(journalPath, { force: true });
  }
});
