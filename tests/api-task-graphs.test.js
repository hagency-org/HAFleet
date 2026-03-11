import { afterEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'fs';
import path from 'path';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function buildChainGraph(owner = 'orchestrator') {
  return {
    owner,
    label: 'chain graph',
    nodes: {
      a: {
        assignee: 'alpha',
        description: 'Do A',
      },
      b: {
        assignee: 'beta',
        description: 'Do B',
        depends_on: ['a'],
      },
      c: {
        assignee: 'gamma',
        description: 'Do C',
        depends_on: ['a', 'b'],
      },
    },
  };
}

describe('task graph API', () => {
  let context = null;

  afterEach(() => {
    context?.cleanup();
    context = null;
  });

  test('graph creation dispatches roots and chained completion dispatches downstream nodes', async () => {
    context = await createBackendTestContext('agent-chat-task-graphs-test-', {
      agents: {
        alpha: { name: 'alpha', type: 'agent', kind: 'agent', online: false, manualDown: true, offlineReason: 'idle' },
        beta: { name: 'beta', type: 'agent', kind: 'agent', online: false, manualDown: true, offlineReason: 'idle' },
        gamma: { name: 'gamma', type: 'agent', kind: 'agent', online: false, manualDown: true, offlineReason: 'idle' },
      },
      groups: {},
    });

    const createResponse = await request(context.app)
      .post('/api/task-graphs')
      .send(buildChainGraph());
    expect(createResponse.status).toBe(200);
    const graphId = createResponse.body.graph.id;
    expect(createResponse.body.graph.status).toBe('active');
    expect(createResponse.body.graph.nodes.a.status).toBe('dispatched');
    expect(createResponse.body.graph.nodes.b.status).toBe('pending');
    expect(createResponse.body.graph.nodes.c.status).toBe('pending');

    const messagesAfterCreate = readJson(path.join(context.runtimeDir, 'data', 'messages.json'));
    expect(messagesAfterCreate).toHaveLength(1);
    expect(messagesAfterCreate[0].schema).toEqual({
      kind: 'task_graph_dispatch',
      version: 1,
      payload: {
        graphId,
        nodeId: 'a',
        description: 'Do A',
        dependencyResults: [],
      },
    });

    const completeA = await request(context.app)
      .patch(`/api/task-graphs/${graphId}/nodes/a`)
      .send({ status: 'complete', result: { finished: 'A' } });
    expect(completeA.status).toBe(200);
    expect(completeA.body.node.status).toBe('complete');
    expect(completeA.body.graph.nodes.b.status).toBe('dispatched');
    expect(completeA.body.graph.nodes.c.status).toBe('pending');

    const completeB = await request(context.app)
      .patch(`/api/task-graphs/${graphId}/nodes/b`)
      .send({ status: 'complete', result: { finished: 'B' } });
    expect(completeB.status).toBe(200);
    expect(completeB.body.graph.nodes.c.status).toBe('dispatched');

    const completeC = await request(context.app)
      .patch(`/api/task-graphs/${graphId}/nodes/c`)
      .send({ status: 'complete', result: { finished: 'C' } });
    expect(completeC.status).toBe(200);
    expect(completeC.body.graph.status).toBe('complete');
    expect(completeC.body.node.status).toBe('complete');
  });

  test('failed dependency cascades failure through remaining pending nodes', async () => {
    context = await createBackendTestContext('agent-chat-task-graphs-test-', {
      agents: {
        alpha: { name: 'alpha', type: 'agent', kind: 'agent', online: false, manualDown: true, offlineReason: 'idle' },
        beta: { name: 'beta', type: 'agent', kind: 'agent', online: false, manualDown: true, offlineReason: 'idle' },
        gamma: { name: 'gamma', type: 'agent', kind: 'agent', online: false, manualDown: true, offlineReason: 'idle' },
      },
      groups: {},
    });

    const createResponse = await request(context.app)
      .post('/api/task-graphs')
      .send(buildChainGraph());
    const graphId = createResponse.body.graph.id;

    const failA = await request(context.app)
      .patch(`/api/task-graphs/${graphId}/nodes/a`)
      .send({ status: 'failed', error: 'A exploded' });
    expect(failA.status).toBe(200);
    expect(failA.body.graph.status).toBe('failed');
    expect(failA.body.graph.nodes.a.status).toBe('failed');
    expect(failA.body.graph.nodes.b.status).toBe('failed');
    expect(failA.body.graph.nodes.c.status).toBe('failed');
    expect(failA.body.graph.nodes.b.error).toContain('dependency failed');
    expect(failA.body.graph.nodes.c.error).toContain('dependency failed');
  });

  test('delete cancels the graph and all non-terminal nodes', async () => {
    context = await createBackendTestContext('agent-chat-task-graphs-test-', {
      agents: {
        alpha: { name: 'alpha', type: 'agent', kind: 'agent', online: false, manualDown: true, offlineReason: 'idle' },
        beta: { name: 'beta', type: 'agent', kind: 'agent', online: false, manualDown: true, offlineReason: 'idle' },
        gamma: { name: 'gamma', type: 'agent', kind: 'agent', online: false, manualDown: true, offlineReason: 'idle' },
      },
      groups: {},
    });

    const createResponse = await request(context.app)
      .post('/api/task-graphs')
      .send(buildChainGraph());
    const graphId = createResponse.body.graph.id;

    const deleteResponse = await request(context.app).delete(`/api/task-graphs/${graphId}`);
    expect(deleteResponse.status).toBe(200);
    expect(deleteResponse.body.graph.status).toBe('cancelled');
    expect(deleteResponse.body.graph.nodes.a.status).toBe('cancelled');
    expect(deleteResponse.body.graph.nodes.b.status).toBe('cancelled');
    expect(deleteResponse.body.graph.nodes.c.status).toBe('cancelled');
  });

  test('task_graph_result messages auto-complete dispatched nodes via message hook', async () => {
    context = await createBackendTestContext('agent-chat-task-graphs-test-', {
      agents: {
        alpha: { name: 'alpha', type: 'agent', kind: 'agent', online: false, manualDown: true, offlineReason: 'idle' },
      },
      groups: {},
    });

    const createResponse = await request(context.app)
      .post('/api/task-graphs')
      .send({
        owner: 'orchestrator',
        label: 'single node graph',
        nodes: {
          a: {
            assignee: 'alpha',
            description: 'Do A',
          },
        },
      });
    const graphId = createResponse.body.graph.id;

    const messageResponse = await request(context.app)
      .post('/api/messages')
      .send({
        from: 'alpha',
        to: 'orchestrator',
        type: 'inform',
        summary: 'node complete',
        full: 'done',
        schema: {
          kind: 'task_graph_result',
          version: 1,
          payload: {
            graphId,
            nodeId: 'a',
            result: { ok: true },
          },
        },
      });
    expect(messageResponse.status).toBe(200);
    expect(messageResponse.body.taskGraph).toEqual({
      handled: true,
      graphId,
      nodeId: 'a',
      status: 'complete',
      graphStatus: 'complete',
    });

    const graphResponse = await request(context.app).get(`/api/task-graphs/${graphId}`);
    expect(graphResponse.status).toBe(200);
    expect(graphResponse.body.status).toBe('complete');
    expect(graphResponse.body.nodes.a.status).toBe('complete');
    expect(graphResponse.body.nodes.a.result).toEqual({ ok: true });
  });

  test('rejects graph creation when dependencies contain a cycle', async () => {
    context = await createBackendTestContext('agent-chat-task-graphs-test-', {
      agents: {
        alpha: { name: 'alpha', type: 'agent', kind: 'agent', online: false, manualDown: true, offlineReason: 'idle' },
        beta: { name: 'beta', type: 'agent', kind: 'agent', online: false, manualDown: true, offlineReason: 'idle' },
      },
      groups: {},
    });

    const createResponse = await request(context.app)
      .post('/api/task-graphs')
      .send({
        owner: 'orchestrator',
        label: 'cyclic graph',
        nodes: {
          a: {
            assignee: 'alpha',
            description: 'Do A',
            depends_on: ['b'],
          },
          b: {
            assignee: 'beta',
            description: 'Do B',
            depends_on: ['a'],
          },
        },
      });

    expect(createResponse.status).toBe(400);
    expect(createResponse.body.error).toContain('dependency cycle detected');
  });

  test('rejects oversized result payloads on direct node updates', async () => {
    context = await createBackendTestContext('agent-chat-task-graphs-test-', {
      agents: {
        alpha: { name: 'alpha', type: 'agent', kind: 'agent', online: false, manualDown: true, offlineReason: 'idle' },
      },
      groups: {},
    });

    const createResponse = await request(context.app)
      .post('/api/task-graphs')
      .send({
        owner: 'orchestrator',
        label: 'single node graph',
        nodes: {
          a: {
            assignee: 'alpha',
            description: 'Do A',
          },
        },
      });
    const graphId = createResponse.body.graph.id;
    const oversized = { blob: 'x'.repeat(70_000) };

    const patchResponse = await request(context.app)
      .patch(`/api/task-graphs/${graphId}/nodes/a`)
      .send({ status: 'complete', result: oversized });

    expect(patchResponse.status).toBe(400);
    expect(patchResponse.body.error).toContain('result exceeds 65536 bytes');

    const graphResponse = await request(context.app).get(`/api/task-graphs/${graphId}`);
    expect(graphResponse.status).toBe(200);
    expect(graphResponse.body.nodes.a.status).toBe('dispatched');
    expect(graphResponse.body.nodes.a.result).toBe(null);
  });

  test('ignores oversized task_graph_result payloads in the message hook', async () => {
    context = await createBackendTestContext('agent-chat-task-graphs-test-', {
      agents: {
        alpha: { name: 'alpha', type: 'agent', kind: 'agent', online: false, manualDown: true, offlineReason: 'idle' },
      },
      groups: {},
    });

    const createResponse = await request(context.app)
      .post('/api/task-graphs')
      .send({
        owner: 'orchestrator',
        label: 'single node graph',
        nodes: {
          a: {
            assignee: 'alpha',
            description: 'Do A',
          },
        },
      });
    const graphId = createResponse.body.graph.id;
    const oversized = { blob: 'x'.repeat(70_000) };

    const messageResponse = await request(context.app)
      .post('/api/messages')
      .send({
        from: 'alpha',
        to: 'orchestrator',
        type: 'inform',
        summary: 'node complete',
        full: 'done',
        schema: {
          kind: 'task_graph_result',
          version: 1,
          payload: {
            graphId,
            nodeId: 'a',
            result: oversized,
          },
        },
      });

    expect(messageResponse.status).toBe(200);
    expect(messageResponse.body.taskGraph).toBe(null);

    const graphResponse = await request(context.app).get(`/api/task-graphs/${graphId}`);
    expect(graphResponse.status).toBe(200);
    expect(graphResponse.body.status).toBe('active');
    expect(graphResponse.body.nodes.a.status).toBe('dispatched');
    expect(graphResponse.body.nodes.a.result).toBe(null);
  });

  test('blocks dangerous prototype path segments during condition evaluation', async () => {
    context = await createBackendTestContext('agent-chat-task-graphs-test-', {
      agents: {
        alpha: { name: 'alpha', type: 'agent', kind: 'agent', online: false, manualDown: true, offlineReason: 'idle' },
        beta: { name: 'beta', type: 'agent', kind: 'agent', online: false, manualDown: true, offlineReason: 'idle' },
      },
      groups: {},
    });

    const createResponse = await request(context.app)
      .post('/api/task-graphs')
      .send({
        owner: 'orchestrator',
        label: 'guarded condition graph',
        nodes: {
          a: {
            assignee: 'alpha',
            description: 'Do A',
          },
          b: {
            assignee: 'beta',
            description: 'Do B',
            depends_on: ['a'],
            condition: {
              dep: 'a',
              path: '__proto__.toString',
            },
          },
        },
      });
    const graphId = createResponse.body.graph.id;

    const completeA = await request(context.app)
      .patch(`/api/task-graphs/${graphId}/nodes/a`)
      .send({ status: 'complete', result: {} });

    expect(completeA.status).toBe(200);
    expect(completeA.body.graph.nodes.b.status).toBe('skipped');
    expect(completeA.body.graph.status).toBe('complete');
  });
});
