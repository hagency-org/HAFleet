import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

describe('AgentStateMachine backend integration', () => {
  let context;

  beforeAll(async () => {
    context = await createBackendTestContext('hafleet-state-int-', {
      agents: {
        localagent: {
          name: 'localagent',
          type: 'agent',
          kind: 'agent',
          server: 'local',
          online: false,
          manualDown: false,
          offlineReason: 'inactive',
          tmux: null,
          agentModelVersion: '1.0',
        },
        pausedagent: {
          name: 'pausedagent',
          type: 'agent',
          kind: 'agent',
          server: 'local',
          online: false,
          manualDown: true,
          offlineReason: 'manual-offline',
          tmux: null,
          agentModelVersion: '1.0',
        },
        degradedagent: {
          name: 'degradedagent',
          type: 'agent',
          kind: 'agent',
          server: 'local',
          online: true,
          manualDown: false,
          offlineReason: null,
          tmux: 'degradedagent:0.0',
          agentModelVersion: '1.0',
        },
      },
      agentRuntime: {
        degradedagent: {
          agent: 'degradedagent',
          mcpPresent: false,
        },
      },
    });
  });

  afterAll(() => {
    if (context) context.cleanup();
  });

  test('local registration with tmux → state=starting (not online)', async () => {
    const res = await request(context.app)
      .post('/api/agents')
      .send({ name: 'localagent', tmux: 'localagent:0.0', server: 'local', agentModelVersion: '1.0' })
      .expect(200);
    expect(res.body.ok).toBe(true);
    const agent = res.body.agent;
    expect(agent.state).toBe('starting');
    expect(agent.online).toBe(true); // starting is deliverable
    expect(agent.healthy).toBe(false); // not fully operational yet
  });

  test('PATCH unpause → agent not immediately deliverable', async () => {
    // First verify the agent is paused
    const before = await request(context.app).get('/api/agents/pausedagent').expect(200);
    expect(before.body.state).toBe('manual_down');
    expect(before.body.online).toBe(false);

    // Unpause via PATCH
    const res = await request(context.app)
      .patch('/api/agents/pausedagent')
      .send({ manualDown: false })
      .expect(200);
    const agent = res.body.agent;
    // After manual_up, machine goes to OFFLINE — agent comes online on next sweep
    expect(agent.state).toBe('offline');
    expect(agent.online).toBe(false);
    expect(agent.healthy).toBe(false);
  });

  test('serializeAgent → online=true for state=degraded', async () => {
    const res = await request(context.app).get('/api/agents/degradedagent').expect(200);
    // degradedagent has mcpPresent=false in runtime → degraded state
    expect(res.body.state).toBe('degraded');
    expect(res.body.online).toBe(true); // degraded is still deliverable
    expect(res.body.healthy).toBe(false); // but not healthy
  });

  test('DELETE → state=offline (not manual_down)', async () => {
    // Register an agent to delete
    await request(context.app)
      .post('/api/agents')
      .send({ name: 'deletetest', tmux: 'deletetest:0.0', server: 'local' })
      .expect(200);

    // DELETE without force → marks offline
    const res = await request(context.app)
      .delete('/api/agents/deletetest')
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.agent.state).toBe('offline');
    expect(res.body.agent.manualDown).toBe(false);
  });

  test('PATCH online:true does NOT make agent deliverable without real liveness', async () => {
    // localagent is offline after earlier registration moved it to starting;
    // force it back to offline via DELETE then re-seed as offline
    await request(context.app)
      .patch('/api/agents/localagent')
      .send({ manualDown: true })
      .expect(200);
    const before = await request(context.app).get('/api/agents/localagent').expect(200);
    expect(before.body.manualDown).toBe(true);
    expect(before.body.online).toBe(false);

    // PATCH online:true should only clear manualDown, not synthesize deliverable
    const res = await request(context.app)
      .patch('/api/agents/localagent')
      .send({ online: true })
      .expect(200);
    const agent = res.body.agent;
    expect(agent.state).toBe('offline');
    expect(agent.online).toBe(false); // NOT deliverable — no real liveness proof
    expect(agent.healthy).toBe(false);
    expect(agent.manualDown).toBe(false); // manualDown cleared
  });
});
