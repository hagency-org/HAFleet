import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const SUPERVISOR_TOKEN = 'test-supervisor-token';

describe('supervisor v2 API', () => {
  let context = null;
  let homeDir = null;

  afterEach(() => {
    context?.cleanup();
    context = null;
  });

  function provisionSupervisorToken(home, agentName, token) {
    const stateDir = path.join(home, 'agents', `agent_${agentName}`, 'state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, 'agent-token'), token + '\n');
  }

  async function setup(opts = {}) {
    homeDir = mkdtempSync(path.join(os.tmpdir(), 'supervisor-v2-test-home-'));
    provisionSupervisorToken(homeDir, 'supervisor-ac-topleader', SUPERVISOR_TOKEN);
    context = await createBackendTestContext('agent-chat-supervisor-v2-test-', {
      agents: {
        'ac-topleader': { name: 'ac-topleader', type: 'agent', kind: 'agent', online: true },
        'supervisor-ac-topleader': { name: 'supervisor-ac-topleader', type: 'agent', kind: 'agent', online: true },
        alpha: { name: 'alpha', type: 'agent', kind: 'agent', online: true },
        ...opts.agents,
      },
      groups: {},
      env: { AGENTCHAT_HOMEDIR: homeDir, ...opts.env },
      ...opts,
    });
    return context;
  }

  /** Helper: PATCH supervisor-state with auth token */
  function patchState(target, body) {
    return request(context.app)
      .patch(`/api/supervisor-state/${target}`)
      .set('X-Agent-Token', SUPERVISOR_TOKEN)
      .send(body);
  }

  test('posts a supervisor assessment and retrieves it', async () => {
    await setup();
    const patch = await patchState('ac-topleader', {
      state: 'focused',
      confidence: 0.92,
      reason: 'Agent is working on assigned task',
      suggested_action: 'none',
      domain: 'core',
    });
    expect(patch.status).toBe(200);
    expect(patch.body.ok).toBe(true);
    expect(patch.body.snapshot.state).toBe('focused');
    expect(patch.body.snapshot.confidence).toBe(0.92);
    expect(patch.body.snapshot.classification).toBe('active');
    expect(patch.body.snapshot.negative).toBe(false);
    expect(patch.body.snapshot.consecutiveNegative).toBe(0);

    const detail = await request(context.app).get('/api/supervisor/agents/ac-topleader');
    expect(detail.status).toBe(200);
    expect(detail.body.state.lastStatus).toBe('focused');
    expect(detail.body.state.classification).toBe('active');
    expect(detail.body.events).toHaveLength(1);
  });

  test('tracks consecutive negative assessments', async () => {
    await setup();
    await patchState('ac-topleader', { state: 'stuck', confidence: 0.8, reason: 'looping', suggested_action: 'nudge' });

    const res1 = await request(context.app).get('/api/supervisor/agents/ac-topleader');
    expect(res1.body.state.consecutiveNegative).toBe(1);

    await patchState('ac-topleader', { state: 'drifting', confidence: 0.75, reason: 'off-task', suggested_action: 'nudge' });

    const res2 = await request(context.app).get('/api/supervisor/agents/ac-topleader');
    expect(res2.body.state.consecutiveNegative).toBe(2);

    // Positive resets counter
    await patchState('ac-topleader', { state: 'focused', confidence: 0.9, reason: 'back on track', suggested_action: 'none' });

    const res3 = await request(context.app).get('/api/supervisor/agents/ac-topleader');
    expect(res3.body.state.consecutiveNegative).toBe(0);
  });

  test('rejects invalid state values', async () => {
    await setup();
    const res = await patchState('ac-topleader', { state: 'invalid_state', confidence: 0.5, reason: 'test' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('invalid state');
  });

  test('rejects PATCH when supervisor agent has no token provisioned', async () => {
    homeDir = mkdtempSync(path.join(os.tmpdir(), 'supervisor-v2-test-home-'));
    // Register supervisor agent but do NOT provision a token file
    context = await createBackendTestContext('agent-chat-supervisor-v2-test-', {
      agents: {
        'ac-topleader': { name: 'ac-topleader', type: 'agent', kind: 'agent', online: true },
        'supervisor-ac-topleader': { name: 'supervisor-ac-topleader', type: 'agent', kind: 'agent', online: true },
      },
      groups: {},
      env: { AGENTCHAT_HOMEDIR: homeDir },
    });
    const res = await request(context.app)
      .patch('/api/supervisor-state/ac-topleader')
      .send({ state: 'focused', confidence: 0.9, reason: 'test', suggested_action: 'none' });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('no token provisioned');
  });

  test('rejects PATCH with wrong token in enforce mode', async () => {
    homeDir = mkdtempSync(path.join(os.tmpdir(), 'supervisor-v2-test-home-'));
    provisionSupervisorToken(homeDir, 'supervisor-ac-topleader', SUPERVISOR_TOKEN);
    context = await createBackendTestContext('agent-chat-supervisor-v2-test-', {
      agents: {
        'ac-topleader': { name: 'ac-topleader', type: 'agent', kind: 'agent', online: true },
        'supervisor-ac-topleader': { name: 'supervisor-ac-topleader', type: 'agent', kind: 'agent', online: true },
      },
      groups: {},
      env: { AGENTCHAT_HOMEDIR: homeDir, AGENTCHAT_AGENT_TOKEN_MODE: 'hard' },
    });
    const res = await request(context.app)
      .patch('/api/supervisor-state/ac-topleader')
      .set('X-Agent-Token', 'wrong-token')
      .send({ state: 'focused', confidence: 0.9, reason: 'test', suggested_action: 'none' });
    expect(res.status).toBe(403);
  });

  test('global status returns aggregate', async () => {
    await setup();
    const status = await request(context.app).get('/api/supervisor/status');
    expect(status.status).toBe(200);
    expect(status.body).toHaveProperty('enabled');
    expect(status.body).toHaveProperty('runtime');
    expect(status.body).toHaveProperty('llm');
    expect(status.body).toHaveProperty('allowedAgents');
    expect(status.body.allowlistMode).toBe('subset');
  });

  test('agents list enriches with snapshot data', async () => {
    await setup();
    await patchState('ac-topleader', { state: 'focused', confidence: 0.9, reason: 'on task', suggested_action: 'none' });

    const res = await request(context.app).get('/api/supervisor/agents');
    expect(res.status).toBe(200);
    const leader = res.body.agents.find(a => a.name === 'ac-topleader');
    expect(leader.state).not.toBe(null);
    expect(leader.state.lastStatus).toBe('focused');

    const alpha = res.body.agents.find(a => a.name === 'alpha');
    expect(alpha.state).toBe(null);
  });

  test('control GET returns derived allowedAgents', async () => {
    await setup();
    const res = await request(context.app).get('/api/supervisor/control');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.allowlistMode).toBe('subset');
    // ac-topleader has supervisor-ac-topleader → should be in allowedAgents
    expect(res.body.allowedAgents).toContain('ac-topleader');
  });

  test('control POST toggles enabled', async () => {
    await setup();
    const disable = await request(context.app)
      .post('/api/supervisor/control')
      .send({ enabled: false });
    expect(disable.status).toBe(200);
    expect(disable.body.control.enabled).toBe(false);
    expect(disable.body.control.disabledReason).toBe('runtime-disabled');

    const enable = await request(context.app)
      .post('/api/supervisor/control')
      .send({ enabled: true });
    expect(enable.status).toBe(200);
    expect(enable.body.control.enabled).toBe(true);
    expect(enable.body.control.disabledReason).toBe(null);
  });

  test('control POST rejects allowedAgents mutation', async () => {
    await setup();
    const res = await request(context.app)
      .post('/api/supervisor/control')
      .send({ allowedAgents: ['alpha'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('read-only');
  });

  test('task health is enriched from supervisor snapshot via read-through', async () => {
    await setup();
    // Create a task assigned to ac-topleader
    const create = await request(context.app)
      .post('/api/tasks')
      .send({ title: 'Test task', assignee: 'ac-topleader' });
    const taskId = create.body.task.id;
    expect(create.body.task.health).toBe(null);

    // Post supervisor assessment for ac-topleader
    await patchState('ac-topleader', { state: 'focused', confidence: 0.88, reason: 'Working on task', suggested_action: 'none', domain: 'core' });

    // Fetch task — health should be enriched
    const task = await request(context.app).get(`/api/tasks/${taskId}`);
    expect(task.status).toBe(200);
    expect(task.body.health).not.toBe(null);
    expect(task.body.health.state).toBe('focused');
    expect(task.body.health.confidence).toBe(0.88);
    expect(task.body.health.assessed_by).toBe('supervisor-ac-topleader');
  });

  test('event ring buffer limits stored events', async () => {
    await setup();
    // Post multiple assessments
    for (let i = 0; i < 5; i++) {
      await patchState('ac-topleader', { state: 'focused', confidence: 0.9, reason: `assessment ${i}`, suggested_action: 'none' });
    }

    const detail = await request(context.app).get('/api/supervisor/agents/ac-topleader');
    expect(detail.body.events).toHaveLength(5);
    expect(detail.body.latest.reason).toBe('assessment 4');
  });

  test('force-delete clears supervisor state for the deleted agent', async () => {
    await setup();
    // Post assessment
    await patchState('ac-topleader', { state: 'focused', confidence: 0.85, reason: 'active work', suggested_action: 'none', domain: 'core' });

    // Verify state exists via agents list
    const list1 = await request(context.app).get('/api/supervisor/agents');
    const leader1 = list1.body.agents.find(a => a.name === 'ac-topleader');
    expect(leader1.state.lastStatus).toBe('focused');

    // Verify events exist
    const detail1 = await request(context.app).get('/api/supervisor/agents/ac-topleader');
    expect(detail1.body.events.length).toBeGreaterThan(0);

    // Force-delete the agent
    const del = await request(context.app).delete('/api/agents/ac-topleader').query({ force: 'true' });
    expect(del.status).toBe(200);

    // Agent is gone from registry — detail endpoint returns 404
    const detail2 = await request(context.app).get('/api/supervisor/agents/ac-topleader');
    expect(detail2.status).toBe(404);

    // Agents list should no longer include ac-topleader
    const list2 = await request(context.app).get('/api/supervisor/agents');
    const leader2 = list2.body.agents.find(a => a.name === 'ac-topleader');
    expect(leader2).toBeUndefined();

    // Status runtime should reflect removal
    const status = await request(context.app).get('/api/supervisor/status');
    expect(status.body.runtime.lastSweepActive).toBe(0);
    expect(status.body.eventCount).toBe(0);
  });

  test('classification mapping matches spec', async () => {
    await setup();

    const cases = [
      { state: 'focused', classification: 'active', negative: false },
      { state: 'drifting', classification: 'suspected_eos', negative: true },
      { state: 'lost', classification: 'suspected_eos', negative: true },
      { state: 'stuck', classification: 'stalled_wait', negative: true },
      { state: 'idle', classification: 'active', negative: false },
      { state: 'done', classification: 'done', negative: false },
    ];

    for (const c of cases) {
      const res = await patchState('ac-topleader', { state: c.state, confidence: 0.9, reason: `testing ${c.state}`, suggested_action: 'none' });
      expect(res.body.snapshot.classification).toBe(c.classification);
      expect(res.body.snapshot.negative).toBe(c.negative);
    }
  });
});
