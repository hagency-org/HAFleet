import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openRouter } from '../router/dist/index.js';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function openTestRouter() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hafleet-directives-'));
  roots.push(root);
  const router = openRouter({ dbPath: path.join(root, 'router.db') });
  return { root, router };
}

describe('session override store policy', () => {
  test('operator overrides persist on the session and survive re-resolution', () => {
    const { router } = openTestRouter();
    const applied = router.setSessionOverrides({
      agentId: 'agent-id', agentName: 'agent', roomId: '!room:test',
      threadRootEventId: '$root', model: 'claude-sonnet-5', mode: 'auto',
      requestedBy: '@alex:test',
    });
    expect(applied).toMatchObject({ modelOverride: 'claude-sonnet-5', modeOverride: 'auto' });
    const reread = router.sessionById(applied.sessionId);
    expect(reread).toMatchObject({ modelOverride: 'claude-sonnet-5', modeOverride: 'auto' });
    const resolved = router.resolveSession({
      agentId: 'agent-id', agentName: 'agent', roomId: '!room:test', threadRootEventId: '$root',
    });
    expect(resolved.sessionId).toBe(applied.sessionId);
    expect(resolved.modelOverride).toBe('claude-sonnet-5');
  });

  test('a malformed model override is refused', () => {
    const { router } = openTestRouter();
    const refused = router.setSessionOverrides({
      agentId: 'agent-id', agentName: 'agent', roomId: '!room:test',
      threadRootEventId: '$root', model: 'sonnet; rm -rf /', requestedBy: '@alex:test',
    });
    expect(refused).toMatchObject({ ok: false, code: 'bad_request' });
  });

  test('a task-less write dispatch is refused without a mode grant and accepted with one', () => {
    const { root, router } = openTestRouter();
    const ingested = router.ingestMessage({
      messageId: 'm-1', roomId: '!room:test', matrixEventId: '$m-1',
      threadRootEventId: '$root', senderName: 'alex',
      recipientAgentId: 'agent-id', recipientAgentName: 'agent',
      normalizedBody: 'please take notes',
    });
    router.registerWorkspace({ resourceId: 'ws', safeLabel: 'workspace', backendPath: root });
    const refused = router.enqueueDispatch({
      sessionId: ingested.session.sessionId, framework: 'claude', localServerId: 'local',
      mayWrite: true, workspaceResourceId: 'ws', payload: { prompt: 'x' },
    });
    expect(refused).toMatchObject({ ok: false, code: 'missing_task_credential' });

    const granted = router.setSessionOverrides({
      agentId: 'agent-id', agentName: 'agent', roomId: '!room:test',
      threadRootEventId: '$root', mode: 'auto', requestedBy: '@alex:test',
    });
    expect(granted.modeOverride).toBe('auto');
    const accepted = router.enqueueDispatch({
      sessionId: ingested.session.sessionId, framework: 'claude', localServerId: 'local',
      mayWrite: true, workspaceResourceId: 'ws', payload: { prompt: 'x' },
    });
    expect(accepted).toMatchObject({ ok: true, state: 'queued' });
    const claim = router.claimDispatch({
      runnerId: 'r-1', leaseMs: 60_000, capabilityTtlMs: 60_000, maxLiveRunners: 8,
    });
    const descriptor = router.getLaunchDescriptor(claim);
    expect(descriptor).toMatchObject({ mayWrite: true, modelOverride: null });
  });

  test('the launch descriptor carries the session model override', () => {
    const { root, router } = openTestRouter();
    const ingested = router.ingestMessage({
      messageId: 'm-2', roomId: '!room:test', matrixEventId: '$m-2',
      threadRootEventId: '$root2', senderName: 'alex',
      recipientAgentId: 'agent-id', recipientAgentName: 'agent',
      normalizedBody: 'question',
    });
    router.setSessionOverrides({
      agentId: 'agent-id', agentName: 'agent', roomId: '!room:test',
      threadRootEventId: '$root2', model: 'claude-haiku-4-5', requestedBy: '@alex:test',
    });
    router.registerWorkspace({ resourceId: 'ws2', safeLabel: 'workspace', backendPath: root });
    const queued = router.enqueueDispatch({
      sessionId: ingested.session.sessionId, framework: 'claude', localServerId: 'local',
      mayWrite: false, workspaceResourceId: 'ws2', payload: { prompt: 'x' },
    });
    expect(queued.ok).toBe(true);
    const claim = router.claimDispatch({
      runnerId: 'r-2', leaseMs: 60_000, capabilityTtlMs: 60_000, maxLiveRunners: 8,
    });
    expect(router.getLaunchDescriptor(claim)).toMatchObject({
      mayWrite: false, modelOverride: 'claude-haiku-4-5',
    });
  });
});

describe('thread directive backend integration', () => {
  let context;

  beforeAll(async () => {
    context = await createBackendTestContext('hafleet-router-directives-', {
      env: {
        HAFLEET_THREAD_SESSIONS: '1',
        HAFLEET_ROUTER_TASK_CUTOVER: '1',
        HAFLEET_CLAUDE_RUNNER_BIN: path.join(fixtures, 'fake-claude-runner.mjs'),
        HAFLEET_CODEX_RUNNER_BIN: path.join(fixtures, 'fake-codex-app-server.mjs'),
        MATRIX_BRIDGE_SECRET: 'router-bridge-secret',
        API_TOKEN: 'router-api-token',
        MATRIX_OPERATOR_MXIDS: '@alex:test',
      },
      groups: {
        frontdesk: { name: 'frontdesk', members: ['coordinator'], createdAt: 1 },
      },
      agents: {
        coordinator: {
          name: 'coordinator', agentId: 'agent_coordinator', type: 'claude', role: 'architect',
          kind: 'agent', workdir: process.cwd(), workspaceMode: 'shared', online: true,
        },
      },
    });
  });

  afterAll(() => {
    context.internals.routerStoreForTest?.close();
    context.cleanup();
  });

  function postMatrix(body, overrides = {}) {
    return request(context.app)
      .post('/api/messages')
      .set('X-Bridge-Secret', 'router-bridge-secret')
      .send({
        from: 'alex', group: 'frontdesk', type: 'human', source: 'matrix',
        summary: body, full: body, mentions: ['coordinator'],
        source_room: '!dir:test', sender_mxid: '@alex:test',
        ...overrides,
      });
  }

  test('an operator /thread model directive updates the session and queues a confirmation', async () => {
    const response = await postMatrix('@coordinator /thread model claude-sonnet-5', {
      source_event_id: '$dir-1', thread_root_event_id: '$dir-root',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const db = context.internals.routerStoreForTest.db;
    const session = db.prepare(
      "SELECT model_override, mode_override FROM sessions WHERE room_id = '!dir:test' AND thread_root_event_id = '$dir-root'",
    ).get();
    expect(session).toMatchObject({ model_override: 'claude-sonnet-5', mode_override: null });
    // The directive configures the session; it must not become chat input.
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM router_messages WHERE room_id = '!dir:test'",
    ).get().n).toBe(0);
    expect(db.prepare(
      "SELECT body FROM notice_outbox WHERE room_id = '!dir:test' AND thread_root_event_id = '$dir-root'",
    ).get()).toMatchObject({ body: expect.stringContaining('model=claude-sonnet-5') });
  });

  test('a non-operator /thread directive is consumed with a notice, not applied', async () => {
    const response = await postMatrix('@coordinator /thread mode auto', {
      source_event_id: '$dir-2', thread_root_event_id: '$dir-root-2',
      sender_mxid: '@mallory:test',
    });
    // Delivery must not fail: the directive is consumed and answered in-thread.
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const db = context.internals.routerStoreForTest.db;
    expect(db.prepare(
      "SELECT mode_override FROM sessions WHERE thread_root_event_id = '$dir-root-2'",
    ).get()?.mode_override ?? null).toBe(null);
    expect(db.prepare(
      "SELECT body FROM notice_outbox WHERE thread_root_event_id = '$dir-root-2'",
    ).get()).toMatchObject({ body: expect.stringContaining('operator') });
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM router_messages WHERE thread_root_event_id = '$dir-root-2'",
    ).get().n).toBe(0);
  });

  test('a malformed operator /thread directive answers with usage instead of failing delivery', async () => {
    const response = await postMatrix('@coordinator /thread', {
      source_event_id: '$dir-5', thread_root_event_id: '$dir-root-5',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const db = context.internals.routerStoreForTest.db;
    expect(db.prepare(
      "SELECT body FROM notice_outbox WHERE thread_root_event_id = '$dir-root-5'",
    ).get()).toMatchObject({ body: expect.stringContaining('usage: /thread') });
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM router_messages WHERE thread_root_event_id = '$dir-root-5'",
    ).get().n).toBe(0);
  });

  test('an operator mode grant lets a subsequent chat dispatch write', async () => {
    const grant = await postMatrix('@coordinator /thread mode auto', {
      source_event_id: '$dir-3', thread_root_event_id: '$dir-root-3',
    });
    expect(grant.status, JSON.stringify(grant.body)).toBe(200);

    const chat = await postMatrix('@coordinator please remember my preference', {
      source_event_id: '$dir-4', thread_root_event_id: '$dir-root-3',
    });
    expect(chat.status, JSON.stringify(chat.body)).toBe(200);

    const db = context.internals.routerStoreForTest.db;
    const dispatch = db.prepare(
      `SELECT d.may_write FROM dispatches d
       JOIN sessions s ON s.session_id = d.session_id
       WHERE s.thread_root_event_id = '$dir-root-3'`,
    ).get();
    expect(dispatch).toMatchObject({ may_write: 1 });
  });
});
