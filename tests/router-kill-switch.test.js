import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';

import { createBackendTestContext } from './helpers/backend-test-runtime.js';

describe('thread-session kill switch after task cutover', () => {
  let context;

  beforeAll(async () => {
    context = await createBackendTestContext('hafleet-router-kill-switch-', {
      env: {
        HAFLEET_THREAD_SESSIONS: '0',
        HAFLEET_ROUTER_TASK_CUTOVER: '1',
        HAFLEET_ROUTER_SHADOW: '0',
        MATRIX_BRIDGE_SECRET: 'router-kill-switch-secret',
        API_TOKEN: 'router-kill-switch-api',
      },
      agents: {
        worker: {
          name: 'worker', agentId: 'agent_worker', type: 'codex', role: 'coding',
          kind: 'agent', workdir: process.cwd(), workspaceMode: 'shared', online: false,
        },
      },
      agentTokens: { worker: 'worker-kill-switch-token' },
      rawDataFiles: { 'tasks.json': '[]' },
    });
  });

  afterAll(() => {
    context.internals.routerStoreForTest?.close();
    context.cleanup();
  });

  test('test_kill_switch_off_uses_legacy_delivery_after_task_store_cutover', async () => {
    const delivered = await request(context.app)
      .post('/api/messages')
      .set('X-Bridge-Secret', 'router-kill-switch-secret')
      .send({
        from: 'alice', to: 'worker', target_type: 'agent', type: 'human', source: 'matrix',
        summary: '@worker legacy message', full: '@worker legacy message', mentions: ['worker'],
        source_room: '!kill-switch:test', source_event_id: '$kill-switch-input', sender_mxid: '@alice:test',
      });
    expect(delivered.status).toBe(200);

    const created = await request(context.app)
      .post('/api/tasks')
      .set('Authorization', 'Bearer router-kill-switch-api')
      .send({ title: 'SQLite-only task', assignee: 'worker', priority: 'p1' });
    expect(created.status).toBe(200);
    expect(created.body.task.title).toBe('SQLite-only task');

    const snapshot = context.internals.routerStoreForTest.snapshot();
    expect(snapshot.sessions).toHaveLength(0);
    expect(snapshot.dispatches).toHaveLength(0);
    expect(snapshot.tasks).toEqual([
      expect.objectContaining({ taskId: created.body.task.id, title: 'SQLite-only task' }),
    ]);
    expect(JSON.parse(readFileSync(path.join(context.runtimeDir, 'data', 'tasks.json'), 'utf8'))).toEqual([]);
  });
});
