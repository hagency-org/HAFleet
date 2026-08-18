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

  /*
   * The roles below are `coding` and `review`, from role-capacity.json. They used to be `worker` and
   * `reviewer`, which were never real: the field accepted any string, so whoever wrote these picked
   * plausible-sounding words without checking the vocabulary — `reviewer` is the vocabulary's `review`
   * misremembered. Nothing outside these tests ever wrote either value, and the backend now refuses
   * an operator role outside the vocabulary.
   */
  test('POST /api/agents registers an agent', async () => {
    const response = await request(context.app)
      .post('/api/agents')
      .send({
        name: 'bravo',
        role: 'coding',
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
        role: 'coding',
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
        role: 'coding',
        identity: 'Old identity',
      });

    const response = await request(context.app)
      .patch('/api/agents/delta')
      .send({
        role: 'review',
        identity: 'New identity',
      });
    expect(response.status).toBe(200);
    expect(response.body.agent.role).toBe('review');
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
      /*
       * `releasedEngagements` joined it when force-delete started revoking the agent's active engagements —
       * a removed agent used to hold a project side's committed tokens forever. This assertion is what
       * caught the new field, which is exactly what the note above says it is for.
       */
      releasedEngagements: expect.any(Array),
      // `leftGroups` joined it when force-delete started removing the agent from its groups — `soakroom`
      // listed three deleted agents as members for hours. Caught by this assertion, again.
      leftGroups: expect.any(Array),
      // `leftProjectRooms` joined it when force-delete started taking the agent out of the customer's
      // rooms — a live homeserver held four deleted agents as joined members. Third time this assertion
      // has caught a new field in this series.
      leftProjectRooms: expect.any(Array),
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
      .send({ name: 'volatile', role: 'coding' });
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
      role: 'coding',
    });
    context = await createBackendTestContext('hafleet-agents-persist-test-', {
      agents: { patchy: original },
      groups: {},
    });
    const before = readJson(agentsPath(context.runtimeDir));
    context.internals.setJsonSaveFailureForTest('agents.json', true);

    const response = await request(context.app)
      .patch('/api/agents/patchy')
      .send({ role: 'review', tmux: 'patchy:0.0' });
    const get = await request(context.app).get('/api/agents/patchy');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'agents persistence failed' });
    expect(get.status).toBe(200);
    expect(get.body).toMatchObject({
      name: 'patchy',
      role: 'coding',
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

describe('deleting an agent releases the budget it was holding', () => {
  /*
   * FOUND ON THE LIVE FLEET BY THE OPERATOR READING A SCREEN: `已承诺 200k` beside a project with nobody
   * assigned. Three of the four active engagements belonged to `e2e-probe-*` agents that no longer existed —
   * 150k of a project side's quota held by agents deleted hours earlier, and no path in the product could ever
   * release it. A contributor's quota drains by attrition.
   *
   * REMOVING A PROJECT SIDE ALREADY DID THIS CORRECTLY, which is what makes it a defect rather than an open
   * question: the same rule enforced on one side of the same relationship and not the other.
   *
   * SOFT DELETE MUST NOT, and getting that wrong was a correction mid-change. `revoke` has no inverse, so an
   * `undelete` could not restore what a reversible action had destroyed.
   */
  const AGENT = 'budget-holder';
  const API_TOKEN = 'op-budget';

  let ctx;
  afterEach(async () => {
    await ctx?.close?.();
    ctx = null;
  });

  async function bootWithAgent() {
    ctx = await createBackendTestContext('hafleet-agents-budget-release-', {
      agents: { [AGENT]: { name: AGENT, type: 'agent', kind: 'agent', capability: 'coding' } },
      env: { API_TOKEN, MATRIX_BRIDGE_SECRET: 'secret-for-withdraw' },
    });
    return ctx.app;
  }

  let PRESET_ID = null;

  async function withActiveEngagement(app) {
    await request(app).post('/api/project-sides').set('Authorization', `Bearer ${API_TOKEN}`)
      .send({ server_name: 'holder.test', api_base_url: 'https://matrix.holder.test' });
    await request(app).put('/api/project-sides/holder.test/allocation')
      .set('Authorization', `Bearer ${API_TOKEN}`).send({ allocatedTokens: 1000000 });

    const preset = await request(app).post('/api/framework-presets')
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .send({
        name: 'holder-preset', framework: 'claude', model: 'claude-sonnet-5',
        ceiling: { tokens: 500000, period: 'monthly' },
      });
    PRESET_ID = preset.body.preset.id;
    await request(app).put(`/api/agents/${AGENT}/preset`).set('Authorization', `Bearer ${API_TOKEN}`)
      .send({ presetId: PRESET_ID });

    const created = await request(app).post('/api/engagements').set('Authorization', `Bearer ${API_TOKEN}`)
      .send({
        agent: AGENT, role: 'documentation', project: 'holding', requester: '@op:holder.test',
        requestedTokens: 50000, projectRoomId: '!room:holder.test',
      });
    const id = created.body.engagement?.id;
    await request(app).post(`/api/engagements/${id}/verdict`).set('Authorization', `Bearer ${API_TOKEN}`)
      .send({ approve: true, allocatedTokens: 50000 });
    return id;
  }

  test('a force delete revokes the active engagement and says which', async () => {
    const app = await bootWithAgent();
    const id = await withActiveEngagement(app);

    const before = await request(app).get('/api/project-sides/holder.test/budget')
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(before.body.committed).toBe(50000);

    const res = await request(app).delete(`/api/agents/${AGENT}?force=true`)
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(res.status).toBe(200);
    // Reported: releasing somebody's committed budget is a side effect the caller did not ask for.
    expect(res.body.releasedEngagements).toContain(id);

    const after = await request(app).get('/api/project-sides/holder.test/budget')
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(after.body.committed).toBe(0);
  });

  test('a force delete removes it from its groups and says which', async () => {
    /*
     * THE FOURTH PLACE ONE REMOVAL DID NOT FINISH. `soakroom` on the live fleet listed three `e2e-probe-*`
     * agents as members hours after they were deleted. A group naming a member with no record is the same
     * shape as a commitment outliving its agent: one relationship maintained from one side only.
     */
    const app = await bootWithAgent();
    await request(app).post('/api/groups').set('X-Bridge-Secret', 'secret-for-withdraw')
      .send({ name: 'crew', members: [AGENT, 'someone-else'] });

    const res = await request(app).delete(`/api/agents/${AGENT}?force=true`)
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(res.body.leftGroups).toEqual(['crew']);

    const groups = await request(app).get('/api/groups').set('Authorization', `Bearer ${API_TOKEN}`);
    const crew = (Array.isArray(groups.body) ? groups.body : groups.body.groups).find((g) => g.name === 'crew');
    expect(crew.members).toEqual(['someone-else']);   // the OTHER member stays
  });

  test('a room reached through an ENGAGEMENT is withdrawn, with no binding anywhere', async () => {
    /*
     * THE CASE THAT MADE THE FIRST VERSION USELESS ON THE FLEET IT WAS WRITTEN FOR. Rooms were taken from
     * bindings alone; an agent actually reaches a project room through `admitAgentToProjectRoom(engagement)`,
     * and that deployment had NO bindings at all because its engagements were approved without a resolvable
     * owner. Proved by running the whole sequence after deploying: the agent was still in the room.
     *
     * Every test passed both before and after that fix, which is the useful part of this one existing.
     */
    const app = await bootWithAgent();
    await request(app).post('/api/project-sides').set('Authorization', `Bearer ${API_TOKEN}`)
      .send({ server_name: 'gone.test', api_base_url: 'http://127.0.0.1:9' });
    await request(app).put('/api/project-sides/gone.test/credential')
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .send({ credential: { kind: 'appservice', asToken: 'as_t', hsToken: 'hs_t', namespace: '@ac_.*', senderLocalpart: 'hafleet' } });
    await request(app).put('/api/project-sides/gone.test/allocation')
      .set('Authorization', `Bearer ${API_TOKEN}`).send({ allocatedTokens: 1000000 });

    const preset = await request(app).post('/api/framework-presets')
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .send({ name: 'wd', framework: 'claude', model: 'claude-sonnet-5', ceiling: { tokens: 500000, period: 'monthly' } });
    await request(app).put(`/api/agents/${AGENT}/preset`).set('Authorization', `Bearer ${API_TOKEN}`)
      .send({ presetId: preset.body.preset.id });
    const created = await request(app).post('/api/engagements').set('Authorization', `Bearer ${API_TOKEN}`)
      .send({
        agent: AGENT, role: 'documentation', project: 'w', requester: '@op:gone.test',
        requestedTokens: 10000, projectRoomId: '!viaengagement:gone.test',
      });
    await request(app).post(`/api/engagements/${created.body.engagement.id}/verdict`)
      .set('Authorization', `Bearer ${API_TOKEN}`).send({ approve: true, allocatedTokens: 10000 });

    // No binding exists — the approval could not resolve an owner, which is the live fleet's state.
    const res = await request(app).delete(`/api/agents/${AGENT}?force=true`)
      .set('Authorization', `Bearer ${API_TOKEN}`);
    const room = (res.body.leftProjectRooms ?? []).find((r) => r.roomId === '!viaengagement:gone.test');
    expect(room).toBeTruthy();                              // the room was TRIED
    expect(room.mxid).toBe(`@ac_${AGENT}:gone.test`);
  });

  test("a customer's unreachable homeserver does NOT make the agent unremovable", async () => {
    /*
     * THE ONE DELIBERATE ASYMMETRY IN THIS DELETE PATH. Releasing a commitment and leaving a group are local
     * writes, so failing them answers 503 and removes nothing. Leaving the customer's Matrix room depends on
     * a machine we do not run — and refusing to delete because someone else's server is down would hand the
     * operator a fleet they cannot manage for reasons outside it.
     *
     * So the seat stays occupied, the delete succeeds, and `leftProjectRooms` says exactly which room and
     * why. That is the honest shape for a cleanup that cannot be guaranteed; a silent success would report a
     * withdrawal that never happened.
     */
    const app = await bootWithAgent();
    /*
     * A REAL CREDENTIAL AND A DEAD ADDRESS, and that combination is the point. A first version used a side
     * with NO credential, which produced the same response shape — and mutation testing showed it never
     * reached the leave call at all: reporting `left: true` for a genuine failure passed every test. Port 9
     * is discard; nothing listens, so the attempt fails for real.
     */
    await request(app).post('/api/project-sides').set('Authorization', `Bearer ${API_TOKEN}`)
      .send({ server_name: 'gone.test', api_base_url: 'http://127.0.0.1:9' });
    await request(app).put('/api/project-sides/gone.test/credential')
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .send({ credential: { kind: 'appservice', asToken: 'as_t', hsToken: 'hs_t', namespace: '@ac_.*', senderLocalpart: 'hafleet' } });
    await request(app).put('/api/approval-bindings')
      .set('X-Bridge-Secret', 'secret-for-withdraw')
      .send({
        agent: AGENT, project: 'p', projectRoomId: '!room:gone.test',
        ownerMxid: '@owner:gone.test', ownerDmRoomId: '!dm:gone.test',
      });

    const res = await request(app).delete(`/api/agents/${AGENT}?force=true`)
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    const room = (res.body.leftProjectRooms ?? []).find((r) => r.roomId === '!room:gone.test');
    expect(room).toBeTruthy();
    expect(room.left).toBe(false);
    expect(room.reason).toBeTruthy();       // it says WHY the seat is still occupied
    expect(room.mxid).toBe(`@ac_${AGENT}:gone.test`);   // and which identity is still sitting there

    // And the agent really is gone from HAFleet.
    expect((await request(app).get(`/api/agents/${AGENT}`)).status).toBe(404);
  });

  test('a soft delete keeps its memberships, because undelete restores the record', async () => {
    // Same rule as the commitment. A restored agent silently absent from every room it worked in would be a
    // reversible action with one permanent consequence.
    const app = await bootWithAgent();
    await request(app).post('/api/groups').set('X-Bridge-Secret', 'secret-for-withdraw')
      .send({ name: 'crew', members: [AGENT] });

    const res = await request(app).delete(`/api/agents/${AGENT}`).set('Authorization', `Bearer ${API_TOKEN}`);
    expect(res.body.leftGroups ?? []).toEqual([]);

    const groups = await request(app).get('/api/groups').set('Authorization', `Bearer ${API_TOKEN}`);
    const crew = (Array.isArray(groups.body) ? groups.body : groups.body.groups).find((g) => g.name === 'crew');
    expect(crew.members).toContain(AGENT);
  });

  test("another agent's commitment is untouched", async () => {
    /*
     * The blast radius. This loop walks EVERY active engagement in the fleet and picks its targets by name;
     * an inverted or missing filter would release the commitments of every other agent at once, which is
     * worse than the leak it fixes and would look like a successful delete.
     */
    const app = await bootWithAgent();
    const mine = await withActiveEngagement(app);

    const OTHER = 'other-holder';
    await request(app).post('/api/agents').set('Authorization', `Bearer ${API_TOKEN}`)
      .send({ name: OTHER, role: 'documentation', identity: 'bystander' });
    await request(app).put(`/api/agents/${OTHER}/preset`).set('Authorization', `Bearer ${API_TOKEN}`)
      .send({ presetId: PRESET_ID });
    const theirs = await request(app).post('/api/engagements').set('Authorization', `Bearer ${API_TOKEN}`)
      .send({
        agent: OTHER, role: 'documentation', project: 'holding', requester: '@op:holder.test',
        requestedTokens: 30000, projectRoomId: '!room:holder.test',
      });
    const theirId = theirs.body.engagement?.id;
    expect(theirId).toBeTruthy();
    await request(app).post(`/api/engagements/${theirId}/verdict`).set('Authorization', `Bearer ${API_TOKEN}`)
      .send({ approve: true, allocatedTokens: 30000 });

    const res = await request(app).delete(`/api/agents/${AGENT}?force=true`)
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(res.body.releasedEngagements).toEqual([mine]);

    // Still active, and its 30k still committed.
    const after = await request(app).get('/api/project-sides/holder.test/budget')
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(after.body.committed).toBe(30000);
    // There is no GET /api/engagements/:id — the list is the only read, which is what the first version of
    // this assertion got wrong (it read a route that does not exist and saw `undefined`, not a revocation).
    const list = await request(app).get('/api/engagements?state=active')
      .set('Authorization', `Bearer ${API_TOKEN}`);
    const survivors = (list.body.engagements ?? []).map((e) => e.id);
    expect(survivors).toContain(theirId);
    expect(survivors).not.toContain(mine);
  });

  test('a soft delete keeps the commitment, because it can be undone', async () => {
    /*
     * `revoke` has no inverse. Releasing here would make a reversible action have one permanent consequence, so
     * an inactive agent keeps its promise — the record survives and the operator can change their mind.
     */
    const app = await bootWithAgent();
    await withActiveEngagement(app);

    const res = await request(app).delete(`/api/agents/${AGENT}`).set('Authorization', `Bearer ${API_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.releasedEngagements ?? []).toEqual([]);

    const after = await request(app).get('/api/project-sides/holder.test/budget')
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(after.body.committed).toBe(50000);
  });
});
