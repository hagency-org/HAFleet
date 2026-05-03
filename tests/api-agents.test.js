import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import request from 'supertest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const spawnMock = vi.hoisted(() => vi.fn(() => ({ pid: 4242, unref: vi.fn() })));

vi.mock('child_process', async () => {
  const actual = await vi.importActual('child_process');
  return {
    ...actual,
    spawn: spawnMock,
  };
});

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function agentsPath(runtimeDir) {
  return path.join(runtimeDir, 'data', 'agents.json');
}

function runtimePath(runtimeDir) {
  return path.join(runtimeDir, 'data', 'agent_runtime.json');
}

function cursorsPath(runtimeDir) {
  return path.join(runtimeDir, 'data', 'cursors.json');
}

function tombstonesPath(runtimeDir) {
  return path.join(runtimeDir, 'data', 'deleted_agents.json');
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
        starter: {
          name: 'starter',
          type: 'claude',
          kind: 'agent',
          online: false,
          manualDown: true,
          offlineReason: 'idle',
          server: null,
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

  test('POST /api/agents/:name/start claims starting state before launch registration', async () => {
    spawnMock.mockClear();

    const first = await request(context.app).post('/api/agents/starter/start');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, name: 'starter', framework: 'claude', pid: 4242 });

    const second = await request(context.app).post('/api/agents/starter/start');
    expect(second.status).toBe(409);
    expect(second.body.error).toContain('already online');
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const agent = await request(context.app).get('/api/agents/starter');
    expect(agent.status).toBe(200);
    expect(agent.body.state).toBe('starting');
    expect(agent.body.online).toBe(true);
    expect(agent.body.tmux).toBe('starter:0.0');
    expect(agent.body.offlineReason).toBe(null);

    const agents = readJson(path.join(context.runtimeDir, 'data', 'agents.json'));
    expect(agents.starter).toMatchObject({
      online: true,
      manualDown: false,
      tmux: 'starter:0.0',
      offlineReason: null,
      state: 'starting',
    });
  });
});

describe('backend agents API persistence failures', () => {
  let context = null;

  afterEach(() => {
    context?.cleanup();
    context = null;
  });

  function seedAgent(overrides = {}) {
    return {
      name: 'alpha',
      type: 'agent',
      kind: 'agent',
      server: null,
      tmux: null,
      online: false,
      manualDown: false,
      offlineReason: 'offline',
      lastSeen: 1700000000000,
      registeredAt: 1700000000000,
      discoveredAt: 1700000000000,
      ...overrides,
    };
  }

  async function setupForceDeleteContext() {
    const original = seedAgent({
      name: 'forcey',
      tmux: 'forcey:0.0',
      online: true,
      manualDown: false,
      offlineReason: null,
      state: 'online',
    });
    context = await createBackendTestContext('agent-chat-agents-force-delete-test-', {
      agents: { forcey: original },
      groups: {},
      agentRuntime: {
        forcey: {
          agent: 'forcey',
          blocked: true,
          blockedReason: 'needs-input',
        },
      },
      cursors: {
        forcey: {
          inbox: 3,
          inboxId: 'msg_003',
          groups: {},
          groupIds: {},
        },
      },
      deletedAgents: {},
    });
    const agentDataDir = path.join(context.runtimeDir, 'data', 'agents', 'forcey', 'tmp');
    mkdirSync(agentDataDir, { recursive: true });
    writeFileSync(path.join(agentDataDir, 'residue.txt'), 'residue');
    return {
      agentDataDir,
      agentsBefore: readJson(agentsPath(context.runtimeDir)),
      runtimeBefore: readJson(runtimePath(context.runtimeDir)),
      cursorsBefore: readJson(cursorsPath(context.runtimeDir)),
      tombstonesBefore: readJson(tombstonesPath(context.runtimeDir)),
    };
  }

  test('POST /api/agents returns 503 and leaves no visible agent when agents persistence fails', async () => {
    context = await createBackendTestContext('agent-chat-agents-persist-test-', {
      agents: {},
      groups: {},
    });
    const before = readJson(agentsPath(context.runtimeDir));
    context.internals.setJsonSaveFailureForTest('agents.json', true);

    const response = await request(context.app)
      .post('/api/agents')
      .send({ name: 'volatile', role: 'worker' });
    const get = await request(context.app).get('/api/agents/volatile');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'agents persistence failed' });
    expect(get.status).toBe(404);
    const after = readJson(agentsPath(context.runtimeDir));
    expect(after.volatile).toBeUndefined();
    expect(after).toEqual(before);
  });

  test('POST /api/agents with tmux persists the transitioned agent state', async () => {
    context = await createBackendTestContext('agent-chat-agents-persist-test-', {
      agents: {},
      groups: {},
    });

    const response = await request(context.app)
      .post('/api/agents')
      .send({ name: 'starter', type: 'claude', tmux: 'starter:0.0' });

    expect(response.status).toBe(200);
    expect(response.body.agent).toMatchObject({
      name: 'starter',
      online: true,
      manualDown: false,
      tmux: 'starter:0.0',
    });
    const stored = readJson(agentsPath(context.runtimeDir)).starter;
    expect(stored).toMatchObject({
      online: true,
      manualDown: false,
      tmux: 'starter:0.0',
      offlineReason: null,
    });
    expect(stored.state).toBe(response.body.agent.state);
  });

  test('PATCH /api/agents/:name returns 503 and restores fields and state when agents persistence fails', async () => {
    const original = seedAgent({
      name: 'patchy',
      role: 'worker',
    });
    context = await createBackendTestContext('agent-chat-agents-persist-test-', {
      agents: { patchy: original },
      groups: {},
    });
    const before = readJson(agentsPath(context.runtimeDir));
    context.internals.setJsonSaveFailureForTest('agents.json', true);

    const response = await request(context.app)
      .patch('/api/agents/patchy')
      .send({ role: 'reviewer', tmux: 'patchy:0.0' });
    const get = await request(context.app).get('/api/agents/patchy');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'agents persistence failed' });
    expect(get.status).toBe(200);
    expect(get.body).toMatchObject({
      name: 'patchy',
      role: 'worker',
      online: false,
      state: 'offline',
      tmux: null,
      offlineReason: 'offline',
    });
    expect(readJson(agentsPath(context.runtimeDir)).patchy).toEqual(before.patchy);
  });

  test('POST /api/agents/:name/offline returns 503, restores online state, and emits no alert on persistence failure', async () => {
    const original = seedAgent({
      name: 'online-agent',
      tmux: 'online-agent:0.0',
      online: true,
      manualDown: false,
      offlineReason: null,
      state: 'online',
    });
    context = await createBackendTestContext('agent-chat-agents-persist-test-', {
      agents: { 'online-agent': original },
      groups: {},
    });
    const before = readJson(agentsPath(context.runtimeDir));
    context.internals.setJsonSaveFailureForTest('agents.json', true);

    const response = await request(context.app)
      .post('/api/agents/online-agent/offline')
      .send({ reason: 'lost-tmux', manualDown: false });
    const get = await request(context.app).get('/api/agents/online-agent');
    const alerts = await request(context.app).get('/api/alerts');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'agents persistence failed' });
    expect(get.body).toMatchObject({
      name: 'online-agent',
      online: true,
      state: 'online',
      tmux: 'online-agent:0.0',
      offlineReason: null,
    });
    expect(alerts.status).toBe(200);
    expect(alerts.body).toEqual([]);
    expect(readJson(agentsPath(context.runtimeDir))['online-agent']).toEqual(before['online-agent']);
  });

  test('DELETE /api/agents/:name returns 503 and keeps the agent registered on persistence failure', async () => {
    const original = seedAgent({
      name: 'registered',
      tmux: 'registered:0.0',
      online: true,
      manualDown: false,
      offlineReason: null,
      state: 'online',
    });
    context = await createBackendTestContext('agent-chat-agents-persist-test-', {
      agents: { registered: original },
      groups: {},
    });
    const before = readJson(agentsPath(context.runtimeDir));
    context.internals.setJsonSaveFailureForTest('agents.json', true);

    const response = await request(context.app).delete('/api/agents/registered');
    const get = await request(context.app).get('/api/agents/registered');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'agents persistence failed' });
    expect(get.status).toBe(200);
    expect(get.body).toMatchObject({
      name: 'registered',
      online: true,
      state: 'online',
      tmux: 'registered:0.0',
      offlineReason: null,
    });
    expect(readJson(agentsPath(context.runtimeDir)).registered).toEqual(before.registered);
  });

  test('DELETE /api/agents/:name?force=true returns 503 before cleanup when tombstone persistence fails', async () => {
    const before = await setupForceDeleteContext();
    context.internals.setJsonSaveFailureForTest('deleted_agents.json', true);

    const response = await request(context.app).delete('/api/agents/forcey?force=true');
    const get = await request(context.app).get('/api/agents/forcey');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'agent force-delete persistence failed' });
    expect(get.status).toBe(200);
    expect(readJson(agentsPath(context.runtimeDir)).forcey).toEqual(before.agentsBefore.forcey);
    expect(readJson(runtimePath(context.runtimeDir)).forcey).toMatchObject(before.runtimeBefore.forcey);
    expect(readJson(cursorsPath(context.runtimeDir)).forcey).toEqual(before.cursorsBefore.forcey);
    expect(readJson(tombstonesPath(context.runtimeDir))).toEqual(before.tombstonesBefore);
    expect(existsSync(before.agentDataDir)).toBe(true);
  });

  test('DELETE /api/agents/:name?force=true rolls back tombstone when agents persistence fails', async () => {
    const before = await setupForceDeleteContext();
    context.internals.setJsonSaveFailureForTest('agents.json', { count: 1 });

    const response = await request(context.app).delete('/api/agents/forcey?force=true');
    const get = await request(context.app).get('/api/agents/forcey');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'agent force-delete persistence failed' });
    expect(get.status).toBe(200);
    expect(readJson(agentsPath(context.runtimeDir)).forcey).toEqual(before.agentsBefore.forcey);
    expect(readJson(runtimePath(context.runtimeDir)).forcey).toMatchObject(before.runtimeBefore.forcey);
    expect(readJson(cursorsPath(context.runtimeDir)).forcey).toEqual(before.cursorsBefore.forcey);
    expect(readJson(tombstonesPath(context.runtimeDir))).toEqual(before.tombstonesBefore);
    expect(existsSync(before.agentDataDir)).toBe(true);
  });
});
