import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';

import { createBackendTestContext } from './helpers/backend-test-runtime.js';

describe('thread-session router shadow mode', () => {
  let context;

  beforeAll(async () => {
    context = await createBackendTestContext('hafleet-router-shadow-', {
      env: {
        HAFLEET_THREAD_SESSIONS: '0',
        HAFLEET_ROUTER_TASK_CUTOVER: '0',
        HAFLEET_ROUTER_SHADOW: '1',
        MATRIX_BRIDGE_SECRET: 'router-shadow-secret',
      },
      agents: {
        worker: {
          name: 'worker', agentId: 'agent_worker', type: 'codex', role: 'coding',
          kind: 'agent', workdir: process.cwd(), workspaceMode: 'shared', online: false,
        },
      },
      agentTokens: { worker: 'worker-shadow-token' },
    });
  });

  afterAll(() => {
    context.internals.routerStoreForTest?.close();
    context.cleanup();
  });

  test('shadow ingestion copies session input but leaves legacy delivery and dispatch decisions untouched', async () => {
    const response = await request(context.app)
      .post('/api/messages')
      .set('X-Bridge-Secret', 'router-shadow-secret')
      .send({
        from: 'alice', to: 'worker', target_type: 'agent', type: 'human', source: 'matrix',
        summary: '@worker observe this', full: '@worker observe this', mentions: ['worker'],
        source_room: '!shadow:test', source_event_id: '$shadow-input', sender_mxid: '@alice:test',
      });

    expect(response.status).toBe(200);
    const snapshot = context.internals.routerStoreForTest.snapshot();
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0]).toMatchObject({
      agentId: 'agent_worker', roomId: '!shadow:test', scopeKind: 'main',
    });
    expect(snapshot.dispatches).toHaveLength(0);
    expect(snapshot.tasks).toHaveLength(0);
  });
});
