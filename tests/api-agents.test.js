import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

describe('backend agents API', () => {
  let context;

  beforeAll(async () => {
    context = await createBackendTestContext('agent-chat-agents-test-', {
      agents: {
        alpha: {
          name: 'alpha',
          type: 'agent',
          kind: 'agent',
          online: false,
          manualDown: true,
          offlineReason: 'test-offline',
          human: {
            owner: 'ops',
            notes: 'legacy notes',
            projectScope: 'legacy scope',
          },
        },
        legacy: {
          name: 'legacy',
          type: 'agent',
          kind: 'agent',
          online: false,
          manualDown: true,
          offlineReason: 'test-offline',
          human: {
            owner: 'ops',
            notes: 'legacy notes',
            projectScope: 'legacy scope',
          },
        },
      },
      groups: {},
      cursors: {
        alpha: {
          inbox: 3,
          inboxId: 'msg_123',
          groups: {},
          groupIds: {},
        },
      },
      agentRuntime: {
        alpha: {
          agent: 'alpha',
          blocked: true,
          blockedReason: 'interactive-confirm',
        },
      },
      supervisorState: {
        agents: {
          alpha: {
            lastStatus: 'active',
            runtimeLaunch: {
              sessionName: 'supervisor-alpha',
              tmuxTarget: 'supervisor-alpha:0.0',
            },
          },
        },
        selectionCursor: 0,
      },
    });

    const dataAgentDir = path.join(context.runtimeDir, 'data', 'agents', 'alpha', 'tmp');
    mkdirSync(dataAgentDir, { recursive: true });
    writeFileSync(path.join(dataAgentDir, 'init.txt'), 'residue');
  });

  afterAll(() => {
    context.cleanup();
  });

  test('POST /api/agents registers an agent', async () => {
    const response = await request(context.app)
      .post('/api/agents')
      .send({
        name: 'bravo',
        role: 'worker',
        identity: 'Build agent',
      });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.agent.name).toBe('bravo');
  });

  test('GET /api/agents/:name returns registered agent', async () => {
    await request(context.app)
      .post('/api/agents')
      .send({
        name: 'charlie',
        role: 'worker',
      });

    const response = await request(context.app).get('/api/agents/charlie');
    expect(response.status).toBe(200);
    expect(response.body.name).toBe('charlie');
  });

  test('PATCH /api/agents/:name updates agent fields', async () => {
    await request(context.app)
      .post('/api/agents')
      .send({
        name: 'delta',
        role: 'worker',
        identity: 'Old identity',
      });

    const response = await request(context.app)
      .patch('/api/agents/delta')
      .send({
        role: 'reviewer',
        identity: 'New identity',
      });
    expect(response.status).toBe(200);
    expect(response.body.agent.role).toBe('reviewer');
    expect(response.body.agent.identity).toBe('New identity');
  });

  test('PATCH /api/agents/:name preserves existing human metadata shape', async () => {
    const response = await request(context.app)
      .patch('/api/agents/alpha')
      .send({
        human: {
          owner: 'new-owner',
        },
      });
    expect(response.status).toBe(200);
    expect(response.body.agent.human).toEqual({ owner: 'new-owner' });

    const followup = await request(context.app).get('/api/agents/alpha');
    expect(followup.status).toBe(200);
    expect(followup.body.human).toEqual({ owner: 'new-owner' });
    expect(Object.prototype.hasOwnProperty.call(followup.body.human, 'notes')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(followup.body.human, 'projectScope')).toBe(false);
  });

  test('GET /api/agents?view=names returns string array', async () => {
    const response = await request(context.app).get('/api/agents').query({ view: 'names' });
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.every((value) => typeof value === 'string')).toBe(true);
  });

  test('human serialization does not include projectScope or notes', async () => {
    const response = await request(context.app).get('/api/agents/legacy');
    expect(response.status).toBe(200);
    expect(response.body.human).toEqual({ owner: 'ops' });
    expect(Object.prototype.hasOwnProperty.call(response.body.human, 'notes')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(response.body.human, 'projectScope')).toBe(false);
  });

  test('DELETE /api/agents/:name?force=true cascades cleanup across runtime state files', async () => {
    const response = await request(context.app).delete('/api/agents/alpha').query({ force: 'true' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      deleted: true,
      name: 'alpha',
    });

    const agentResponse = await request(context.app).get('/api/agents/alpha');
    expect(agentResponse.status).toBe(404);

    const dataDir = path.join(context.runtimeDir, 'data');
    const agents = readJson(path.join(dataDir, 'agents.json'));
    const runtime = readJson(path.join(dataDir, 'agent_runtime.json'));
    const cursors = readJson(path.join(dataDir, 'cursors.json'));

    expect(Object.prototype.hasOwnProperty.call(agents, 'alpha')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(runtime, 'alpha')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(cursors, 'alpha')).toBe(false);
    expect(existsSync(path.join(dataDir, 'agents', 'alpha'))).toBe(false);
  });
});
