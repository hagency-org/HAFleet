import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createBackendTestContext } from './helpers/backend-test-runtime.js';

function matrixMessage(id, ts, eventId, body) {
  return {
    id, ts, from: 'alice', to: 'worker', group: null, type: 'human',
    summary: body, full: body, mentions: ['worker'], reply_to: null,
    source: 'matrix', sourceRoom: '!reconcile:test', sourceEventId: eventId,
    senderMxid: '@alice:test', matrixContext: {
      roomId: '!reconcile:test', eventId, threadRootEventId: null,
    },
  };
}

describe('thread-session source reconciliation', () => {
  let context;

  beforeAll(async () => {
    context = await createBackendTestContext('hafleet-router-reconcile-', {
      env: {
        HAFLEET_THREAD_SESSIONS: '1',
        HAFLEET_ROUTER_TASK_CUTOVER: '1',
        MATRIX_BRIDGE_SECRET: 'router-reconcile-secret',
        API_TOKEN: 'router-reconcile-api-token',
      },
      agents: {
        worker: {
          name: 'worker', agentId: 'agent_worker', type: 'codex', role: 'coding',
          kind: 'agent', workdir: process.cwd(), workspaceMode: 'shared', online: true,
        },
      },
      messages: [
        matrixMessage('persisted-one', 100, '$persisted-one', '@worker first'),
        matrixMessage('persisted-two', 200, '$persisted-two', '@worker second'),
      ],
    });
  });

  afterAll(() => {
    context.internals.routerStoreForTest?.close();
    context.cleanup();
  });

  test('test_router_ingestion_reconciles_persisted_source_message', async () => {
    const router = context.internals.routerStoreForTest;
    router.initializeIngestionCursor(
      'messages.json:matrix-thread-router-v1',
      JSON.stringify({ ts: 100, id: 'persisted-one' }),
    );
    const report = await context.internals.reconcileThreadSessionSourceMessagesForTest();
    expect(report).toMatchObject({ scanned: 1, initialized: false });
    const command = router.claimMatrixCommand();
    expect(command).toMatchObject({
      roomId: '!reconcile:test', threadRootEventId: '$persisted-two', senderAgentName: 'worker',
    });
    expect(router.readIngestionCursor('messages.json:matrix-thread-router-v1'))
      .toBe(JSON.stringify({ ts: 200, id: 'persisted-two' }));
    expect(router.db.prepare(
      'SELECT normalized_body FROM router_messages WHERE message_id = ?',
    ).all('persisted-two')).toEqual([{ normalized_body: '@worker second' }]);
    expect(router.snapshot().sessions.filter((row) => row.roomId === '!reconcile:test')).toHaveLength(0);

    const activated = router.recordMatrixDelivery({
      commandId: command.commandId,
      claimToken: command.claimToken,
      eventId: '$persisted-anchor',
    });
    expect(activated).toMatchObject({
      ok: true,
      threadRootEventId: '$persisted-two',
      threadAnchorEventId: '$persisted-anchor',
    });
    if (!activated.ok) throw new Error(activated.message);
    expect(router.assembleContext(activated.sessionId)).toMatchObject({
      messages: [expect.objectContaining({ body: '@worker second' })],
    });
  });
});
