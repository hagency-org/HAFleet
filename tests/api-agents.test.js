import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import request from 'supertest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

/*
 * `on` belongs in this mock. /start now attaches an exit listener so a launcher that dies is not
 * left reported as a running agent — and a child stub without `on` made the route throw TypeError
 * and answer 500, which is how this mock's incompleteness surfaced.
 */
const spawnMock = vi.hoisted(() => vi.fn(() => ({ pid: 4242, unref: vi.fn(), on: vi.fn() })));
/*
 * execFileSync is mocked because a stray real call from this file would run against the developer's
 * own machine. The delete path no longer uses it — it goes through the runtime — but the mock stays
 * as a guard: if anything in the backend starts shelling out again, it hits this instead of tmux.
 */
const execFileSyncMock = vi.hoisted(() => vi.fn(() => ''));

vi.mock('child_process', async () => {
  const actual = await vi.importActual('child_process');
  return {
    ...actual,
    spawn: spawnMock,
    execFileSync: execFileSyncMock,
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
    context = await createBackendTestContext('hafleet-agents-test-', {
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
        // A second offline agent, so the launch-failure case does not have to reuse `starter`
        // after that test has already brought it online.
        failer: {
          name: 'failer',
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
    /*
     * `sessionKilled` joined this response when force-delete started stopping the agent's tmux
     * session — deleting the record used to leave the process running. Asserted explicitly rather
     * than loosened to toMatchObject, so a future field cannot appear here unnoticed: this is the
     * body a destructive operation reports, and it is worth pinning exactly.
     */
    expect(response.body).toEqual({
      ok: true,
      deleted: true,
      name: 'alpha',
      sessionKilled: expect.any(Boolean),
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

  test('force-delete stops the agent process, and says whether it found one', async () => {
    /*
     * Deleting the record used to leave the tmux session and its coding-CLI process running: an
     * orphan spending the contributor's tokens, its MCP server still calling a backend that no
     * longer knows the agent, while the console reported it gone. Seen for real — a session started
     * at 00:03 was still alive after the record was deleted at 07:55.
     *
     * `sessionKilled` is in the response because "deleted, and stopped a session" and "deleted, no
     * session was running" are different outcomes, and a caller that cannot tell them apart cannot
     * warn an operator that something is still running.
     */
    const res = await request(context.app).delete('/api/agents/starter?force=true');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, deleted: true, name: 'starter' });
    /*
     * The OUTCOME is asserted here, not the tmux arguments. The stop goes through
     * `hostRuntime.killSession`, which is the point — the backend must not shell out to tmux itself
     * (tests/runtime-interface.test.js). No session called `starter` exists in a test runtime, so
     * false is the correct answer, and it must be REPORTED rather than omitted: a caller that cannot
     * tell "stopped something" from "there was nothing to stop" cannot warn that a process may still
     * be running. The tmux arguments are asserted where they live, in
     * tests/runtime-interface.test.js.
     */
    expect(res.body.sessionKilled).toBe(false);
  });

  test('a launcher that exits non-zero takes the optimistic online back', async () => {
    /*
     * The claim above is OPTIMISTIC — /start marks the agent starting before the launcher has done
     * anything, because the heartbeat is what confirms it. That is fine while the launcher works.
     * It was not fine when the launcher failed: the process was spawned with `stdio: 'ignore'`, the
     * endpoint answered `{ok: true, pid}`, and the record kept claiming a tmux session that did not
     * exist — an agent that looked alive and merely quiet. Observed for real: `hafleet up-v1` died
     * with "FATAL: Failed to fetch launch-env from backend" and /start reported success.
     */
    let exitHandler = null;
    spawnMock.mockClear();
    spawnMock.mockImplementationOnce(() => ({
      pid: 9191,
      unref: vi.fn(),
      on: (event, handler) => { if (event === 'exit') exitHandler = handler; },
    }));

    const started = await request(context.app).post('/api/agents/failer/start');
    expect(started.status).toBe(200);
    // `launching`, not `started`: the process exists, the agent does not yet.
    expect(started.body).toMatchObject({ ok: true, state: 'launching' });
    expect(started.body.log).toContain('launch.log');

    // The launcher now dies the way the real one did.
    expect(exitHandler, 'no exit handler was attached').toBeTypeOf('function');
    exitHandler(1, null);

    const after = await request(context.app).get('/api/agents/failer');
    expect(after.status).toBe(200);
    expect(after.body.online).toBe(false);
    expect(after.body.tmux).toBeNull();
    expect(after.body.offlineReason).toBe('launch-failed:exit-1');
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
    context = await createBackendTestContext('hafleet-agents-force-delete-test-', {
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
    context = await createBackendTestContext('hafleet-agents-persist-test-', {
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
    context = await createBackendTestContext('hafleet-agents-persist-test-', {
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
    context = await createBackendTestContext('hafleet-agents-persist-test-', {
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
    context = await createBackendTestContext('hafleet-agents-persist-test-', {
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
    context = await createBackendTestContext('hafleet-agents-persist-test-', {
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
