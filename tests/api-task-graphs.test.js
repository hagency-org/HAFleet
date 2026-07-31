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
    context = await createBackendTestContext('hafleet-task-graphs-test-', {
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
        dispatchKey: `task_graph_dispatch:${graphId}:a`,
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

  test('graph creation fails closed without dispatch when graph persistence fails', async () => {
    context = await createBackendTestContext('hafleet-task-graphs-test-', {
      agents: {
        alpha: { name: 'alpha', type: 'agent', kind: 'agent', online: false, manualDown: true, offlineReason: 'idle' },
      },
      groups: {},
    });
    context.internals.setJsonSaveFailureForTest('task_graphs.json', true);

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

    expect(createResponse.status).toBe(503);
    expect(createResponse.body.error).toContain('task graph persistence failed');
    const listResponse = await request(context.app).get('/api/task-graphs');
    expect(listResponse.status).toBe(200);
    expect(listResponse.body).toEqual([]);
    expect(readJson(path.join(context.runtimeDir, 'data', 'messages.json'))).toEqual([]);
  });

  test('dispatch persistence failure leaves created graph pending instead of failed', async () => {
    context = await createBackendTestContext('hafleet-task-graphs-test-', {
      agents: {
        alpha: { name: 'alpha', type: 'agent', kind: 'agent', online: false, manualDown: true, offlineReason: 'idle' },
      },
      groups: {},
    });
    context.internals.setJsonSaveFailureForTest('.msg_counter', true);

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

    expect(createResponse.status).toBe(503);
    expect(createResponse.body.error).toContain('task graph dispatch failed');
    const listResponse = await request(context.app).get('/api/task-graphs');
    expect(listResponse.status).toBe(200);
    expect(listResponse.body).toHaveLength(1);
    expect(listResponse.body[0].status).toBe('active');
    expect(listResponse.body[0].nodes.a.status).toBe('pending');
    expect(readJson(path.join(context.runtimeDir, 'data', 'messages.json'))).toEqual([]);
  });

  test('node update persistence failure leaves graph state unchanged', async () => {
    context = await createBackendTestContext('hafleet-task-graphs-test-', {
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
    context.internals.setJsonSaveFailureForTest('task_graphs.json', true);

    const patchResponse = await request(context.app)
      .patch(`/api/task-graphs/${graphId}/nodes/a`)
      .send({ status: 'complete', result: { finished: 'A' } });

    expect(patchResponse.status).toBe(503);
    expect(patchResponse.body.error).toContain('task graph persistence failed');
    const graphResponse = await request(context.app).get(`/api/task-graphs/${graphId}`);
    expect(graphResponse.status).toBe(200);
    expect(graphResponse.body.status).toBe('active');
    expect(graphResponse.body.nodes.a.status).toBe('dispatched');
    expect(graphResponse.body.nodes.a.result).toBe(null);
    expect(graphResponse.body.nodes.b.status).toBe('pending');
    expect(readJson(path.join(context.runtimeDir, 'data', 'messages.json'))).toHaveLength(1);
  });

  test('downstream dispatch graph save failure reuses the durable dispatch on retry', async () => {
    context = await createBackendTestContext('hafleet-task-graphs-test-', {
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
    context.internals.setJsonSaveFailureForTest('task_graphs.json', { after: 1, count: 1 });

    const firstPatch = await request(context.app)
      .patch(`/api/task-graphs/${graphId}/nodes/a`)
      .send({ status: 'complete', result: { finished: 'A' } });
    expect(firstPatch.status).toBe(503);
    expect(firstPatch.body.error).toContain('task graph persistence failed');
    const messagesAfterFailure = readJson(path.join(context.runtimeDir, 'data', 'messages.json'));
    expect(messagesAfterFailure).toHaveLength(2);
    const betaDispatchId = messagesAfterFailure[1].id;
    expect(messagesAfterFailure[1].schema.payload).toMatchObject({
      dispatchKey: `task_graph_dispatch:${graphId}:b`,
      graphId,
      nodeId: 'b',
    });

    const graphAfterFailure = await request(context.app).get(`/api/task-graphs/${graphId}`);
    expect(graphAfterFailure.status).toBe(200);
    expect(graphAfterFailure.body.nodes.a.status).toBe('complete');
    expect(graphAfterFailure.body.nodes.b.status).toBe('pending');

    const retryPatch = await request(context.app)
      .patch(`/api/task-graphs/${graphId}/nodes/a`)
      .send({ status: 'complete', result: { finished: 'A' } });
    expect(retryPatch.status).toBe(200);
    expect(retryPatch.body.graph.nodes.b.status).toBe('dispatched');
    expect(retryPatch.body.graph.nodes.b.message_id).toBe(betaDispatchId);
    const messagesAfterRetry = readJson(path.join(context.runtimeDir, 'data', 'messages.json'));
    expect(messagesAfterRetry).toHaveLength(2);
    expect(messagesAfterRetry[1].id).toBe(betaDispatchId);
  });

  test('task graph result hook persistence failure returns 503 and leaves graph unchanged', async () => {
    context = await createBackendTestContext('hafleet-task-graphs-test-', {
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
    expect(createResponse.status).toBe(200);
    const graphId = createResponse.body.graph.id;
    const dispatchMessageId = createResponse.body.graph.nodes.a.message_id;
    context.internals.setJsonSaveFailureForTest('task_graphs.json', true);

    const messageResponse = await request(context.app)
      .post('/api/messages')
      .send({
        from: 'alpha',
        to: 'orchestrator',
        type: 'inform',
        summary: 'node complete',
        full: 'done',
        reply_to: dispatchMessageId,
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

    expect(messageResponse.status).toBe(503);
    expect(messageResponse.body).toMatchObject({
      messageAccepted: true,
      taskGraph: null,
    });
    expect(messageResponse.body.id).toMatch(/^msg_/);
    const graphResponse = await request(context.app).get(`/api/task-graphs/${graphId}`);
    expect(graphResponse.status).toBe(200);
    expect(graphResponse.body.status).toBe('active');
    expect(graphResponse.body.nodes.a.status).toBe('dispatched');
    expect(graphResponse.body.nodes.a.result).toBe(null);
    expect(readJson(path.join(context.runtimeDir, 'data', 'messages.json'))).toHaveLength(2);
  });

  test('delete persistence failure returns 503 and leaves active graph intact', async () => {
    context = await createBackendTestContext('hafleet-task-graphs-test-', {
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
    context.internals.setJsonSaveFailureForTest('task_graphs.json', true);

    const deleteResponse = await request(context.app).delete(`/api/task-graphs/${graphId}`);
    expect(deleteResponse.status).toBe(503);
    expect(deleteResponse.body.error).toContain('task graph persistence failed');
    const graphResponse = await request(context.app).get(`/api/task-graphs/${graphId}`);
    expect(graphResponse.status).toBe(200);
    expect(graphResponse.body.status).toBe('active');
    expect(graphResponse.body.nodes.a.status).toBe('dispatched');
    expect(graphResponse.body.nodes.b.status).toBe('pending');
  });

  test('failed dependency cascades failure through remaining pending nodes', async () => {
    context = await createBackendTestContext('hafleet-task-graphs-test-', {
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
    context = await createBackendTestContext('hafleet-task-graphs-test-', {
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
    context = await createBackendTestContext('hafleet-task-graphs-test-', {
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
    const dispatchMessageId = createResponse.body.graph.nodes.a.message_id;
    expect(dispatchMessageId).toBeTruthy();

    const messageResponse = await request(context.app)
      .post('/api/messages')
      .send({
        from: 'alpha',
        to: 'orchestrator',
        type: 'inform',
        summary: 'node complete',
        full: 'done',
        reply_to: dispatchMessageId,
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

  test('task_graph_result messages from non-assignees are ignored by the message hook', async () => {
    context = await createBackendTestContext('hafleet-task-graphs-test-', {
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
        label: 'single node graph',
        nodes: {
          a: {
            assignee: 'alpha',
            description: 'Do A',
          },
        },
      });
    const graphId = createResponse.body.graph.id;
    const dispatchMessageId = createResponse.body.graph.nodes.a.message_id;
    expect(dispatchMessageId).toBeTruthy();

    const spoofResponse = await request(context.app)
      .post('/api/messages')
      .send({
        from: 'beta',
        to: 'orchestrator',
        type: 'inform',
        summary: 'spoof complete',
        full: 'spoofed',
        reply_to: dispatchMessageId,
        schema: {
          kind: 'task_graph_result',
          version: 1,
          payload: {
            graphId,
            nodeId: 'a',
            result: { ok: false },
          },
        },
      });
    expect(spoofResponse.status).toBe(200);
    expect(spoofResponse.body.taskGraph).toBe(null);

    const graphResponse = await request(context.app).get(`/api/task-graphs/${graphId}`);
    expect(graphResponse.status).toBe(200);
    expect(graphResponse.body.status).toBe('active');
    expect(graphResponse.body.nodes.a.status).toBe('dispatched');
    expect(graphResponse.body.nodes.a.result).toBe(null);
  });

  test('task_graph_result messages without dispatch reply binding are ignored', async () => {
    context = await createBackendTestContext('hafleet-task-graphs-test-', {
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

    const missingReply = await request(context.app)
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
    expect(missingReply.status).toBe(200);
    expect(missingReply.body.taskGraph).toBe(null);

    const wrongReply = await request(context.app)
      .post('/api/messages')
      .send({
        from: 'alpha',
        to: 'orchestrator',
        type: 'inform',
        summary: 'node complete',
        full: 'done',
        reply_to: 'msg_wrong',
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
    expect(wrongReply.status).toBe(200);
    expect(wrongReply.body.taskGraph).toBe(null);

    const graphResponse = await request(context.app).get(`/api/task-graphs/${graphId}`);
    expect(graphResponse.status).toBe(200);
    expect(graphResponse.body.status).toBe('active');
    expect(graphResponse.body.nodes.a.status).toBe('dispatched');
    expect(graphResponse.body.nodes.a.result).toBe(null);
  });

  test('task_graph_failed messages from non-assignees are ignored by the message hook', async () => {
    context = await createBackendTestContext('hafleet-task-graphs-test-', {
      agents: {
        alpha: { name: 'alpha', type: 'agent', kind: 'agent', online: false, manualDown: true, offlineReason: 'idle' },
        mallory: { name: 'mallory', type: 'agent', kind: 'agent', online: false, manualDown: true, offlineReason: 'idle' },
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
    const dispatchMessageId = createResponse.body.graph.nodes.a.message_id;
    expect(dispatchMessageId).toBeTruthy();

    const spoofResponse = await request(context.app)
      .post('/api/messages')
      .send({
        from: 'mallory',
        to: 'orchestrator',
        type: 'inform',
        summary: 'spoof failed',
        full: 'spoofed',
        reply_to: dispatchMessageId,
        schema: {
          kind: 'task_graph_failed',
          version: 1,
          payload: {
            graphId,
            nodeId: 'a',
            error: 'spoofed failure',
          },
        },
      });
    expect(spoofResponse.status).toBe(200);
    expect(spoofResponse.body.taskGraph).toBe(null);

    const graphResponse = await request(context.app).get(`/api/task-graphs/${graphId}`);
    expect(graphResponse.status).toBe(200);
    expect(graphResponse.body.status).toBe('active');
    expect(graphResponse.body.nodes.a.status).toBe('dispatched');
    expect(graphResponse.body.nodes.a.error).toBe(null);
  });

  test('rejects graph creation when dependencies contain a cycle', async () => {
    context = await createBackendTestContext('hafleet-task-graphs-test-', {
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
    context = await createBackendTestContext('hafleet-task-graphs-test-', {
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
    context = await createBackendTestContext('hafleet-task-graphs-test-', {
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
    const dispatchMessageId = createResponse.body.graph.nodes.a.message_id;
    expect(dispatchMessageId).toBeTruthy();
    const oversized = { blob: 'x'.repeat(70_000) };

    const messageResponse = await request(context.app)
      .post('/api/messages')
      .send({
        from: 'alpha',
        to: 'orchestrator',
        type: 'inform',
        summary: 'node complete',
        full: 'done',
        reply_to: dispatchMessageId,
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
    context = await createBackendTestContext('hafleet-task-graphs-test-', {
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

  test('node PATCH authenticates against node assignee token, not graph owner', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('fs');
    const os = await import('os');
    const homeDir = mkdtempSync(path.join(os.tmpdir(), 'task-graph-token-test-'));
    // Create token for assignee (alpha), NOT for graph owner (orchestrator)
    const alphaStateDir = path.join(homeDir, 'agents', 'agent_alpha', 'state');
    mkdirSync(alphaStateDir, { recursive: true });
    writeFileSync(path.join(alphaStateDir, 'agent-token'), 'alpha-secret\n');

    context = await createBackendTestContext('hafleet-task-graphs-token-test-', {
      agents: {
        alpha: { name: 'alpha', type: 'agent', kind: 'agent', online: false },
        orchestrator: { name: 'orchestrator', type: 'agent', kind: 'agent', online: false },
      },
      groups: {},
      env: {
        HAFLEET_AGENT_TOKEN_MODE: 'hard',
        HAFLEET_HOMEDIR: homeDir,
      },
    });

    const createResponse = await request(context.app)
      .post('/api/task-graphs')
      .send({
        owner: 'orchestrator',
        label: 'token test graph',
        nodes: { a: { assignee: 'alpha', description: 'Do A' } },
      });
    expect(createResponse.status).toBe(200);
    const graphId = createResponse.body.graph.id;

    // alpha's token should succeed (node assignee)
    const ok = await request(context.app)
      .patch(`/api/task-graphs/${graphId}/nodes/a`)
      .set('X-Agent-Token', 'alpha-secret')
      .send({ status: 'complete', result: {} });
    expect(ok.status).toBe(200);

    const { rmSync } = await import('fs');
    rmSync(homeDir, { recursive: true, force: true });
  });
});
