/*
 * Binding an agent to a project side — the route that did not exist, found by running the whole thing.
 *
 * `agent.projectSide` is what lets `POST /api/agents/:name/matrix-identity` decide which side to mint on.
 * Without it that endpoint refuses with `no_project_side`, correctly. But nothing could set it: `POST
 * /api/agents` is agent-authenticated, and the only other writer was a binding produced by the Matrix-side
 * owner approval — which needs the agent to already be reachable. On a clean fleet the chain closed on
 * itself. Every gate refused informatively and the sequence was still impossible.
 *
 * This is the same shape as `PUT .../preset`, which exists for the same reason, and the tests mirror it.
 * Two properties carry the design:
 *
 *   AN AGENT CANNOT BIND ITSELF. Which customer an agent serves is a decision about someone else's
 *   homeserver and someone else's budget. That is why this is a separate operator route and not a field on
 *   PATCH — and why PATCH now REFUSES the field instead of ignoring it, which is what it used to do.
 *
 *   A NAME THAT IS NOT A SIDE IS REFUSED HERE. Accepting it would move the same confusion one step later,
 *   where it reads as a minting failure rather than as the typo it is.
 */
import { afterEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const AGENT = 'side-binding-probe';
const AGENT_TOKEN = 'agent-token-side-probe';
const API_TOKEN = 'operator-token-side-probe';
const SIDE = 'customer.test';

const seed = () => ({
  agents: {
    [AGENT]: { name: AGENT, type: 'agent', kind: 'agent', online: true, capability: 'coding' },
  },
  agentTokens: { [AGENT]: AGENT_TOKEN },
  env: { API_TOKEN },
});

let ctx;
afterEach(async () => {
  await ctx?.close?.();
  ctx = null;
});

async function withSide(app) {
  const res = await request(app).post('/api/project-sides')
    .set('Authorization', `Bearer ${API_TOKEN}`)
    .send({ server_name: SIDE, api_base_url: 'https://matrix.customer.test' });
  expect(res.status).toBe(200);
  return res.body.side;
}

describe('binding an agent to a project side', () => {
  test('an operator can bind, and the record shows it', async () => {
    ctx = await createBackendTestContext('agent-side-', seed());
    await withSide(ctx.app);

    const res = await request(ctx.app).put(`/api/agents/${AGENT}/project-side`)
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .send({ projectSide: SIDE });
    expect(res.status).toBe(200);
    expect(res.body.agent.projectSide).toBe(SIDE);

    const read = await request(ctx.app).get(`/api/agents/${AGENT}`)
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(read.body.projectSide).toBe(SIDE);
  });

  test('the response says what to do next, because binding alone changes nothing visible', async () => {
    // An operator who binds and stops has an agent that still cannot act — the state this route exists to
    // get out of, so the way out is in the answer rather than in the source.
    ctx = await createBackendTestContext('agent-side-', seed());
    await withSide(ctx.app);
    const res = await request(ctx.app).put(`/api/agents/${AGENT}/project-side`)
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .send({ projectSide: SIDE });
    expect(res.body.nextStep).toMatch(/matrix-identity/);
  });

  test('a side nobody configured is refused, and the refusal lists the real ones', async () => {
    ctx = await createBackendTestContext('agent-side-', seed());
    await withSide(ctx.app);
    const res = await request(ctx.app).put(`/api/agents/${AGENT}/project-side`)
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .send({ projectSide: 'typo.test' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('unknown_project_side');
    expect(res.body.known).toContain(SIDE);
  });

  test('null unbinds, and says the agent can no longer be minted', async () => {
    ctx = await createBackendTestContext('agent-side-', seed());
    await withSide(ctx.app);
    await request(ctx.app).put(`/api/agents/${AGENT}/project-side`)
      .set('Authorization', `Bearer ${API_TOKEN}`).send({ projectSide: SIDE });

    const res = await request(ctx.app).put(`/api/agents/${AGENT}/project-side`)
      .set('Authorization', `Bearer ${API_TOKEN}`).send({ projectSide: null });
    expect(res.status).toBe(200);
    expect(res.body.agent.projectSide).toBeNull();
    expect(res.body.nextStep).toMatch(/no longer/);
  });

  test('an unknown agent is a 404, not a binding stored against nothing', async () => {
    ctx = await createBackendTestContext('agent-side-', seed());
    await withSide(ctx.app);
    const res = await request(ctx.app).put('/api/agents/ghost/project-side')
      .set('Authorization', `Bearer ${API_TOKEN}`).send({ projectSide: SIDE });
    expect(res.status).toBe(404);
  });
});

describe('who is allowed to decide it', () => {
  test('an agent token cannot bind an agent to a side', async () => {
    /*
     * The reason this is a separate route. An agent that could claim a side would be choosing its own
     * employer — and the side it claimed carries someone else's homeserver and someone else's budget.
     */
    ctx = await createBackendTestContext('agent-side-', seed());
    await withSide(ctx.app);
    const res = await request(ctx.app).put(`/api/agents/${AGENT}/project-side`)
      .set('X-Agent-Token', AGENT_TOKEN)
      .send({ projectSide: SIDE });
    expect(res.status).toBeGreaterThanOrEqual(400);

    const read = await request(ctx.app).get(`/api/agents/${AGENT}`)
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(read.body.projectSide ?? null).toBeNull();
  });

  test('PATCH REFUSES projectSide rather than ignoring it, and names the route that works', async () => {
    /*
     * It used to accept the field and drop it, answering `ok: true` — discoverable only by reading the
     * record back. A walkthrough on a clean fleet lost real time to exactly that. Refusing is not a
     * regression in convenience: an ignored write is a lie, and the answer to "how do I set this" now
     * comes from the failure instead of from the source.
     */
    ctx = await createBackendTestContext('agent-side-', seed());
    const res = await request(ctx.app).patch(`/api/agents/${AGENT}`)
      .set('X-Agent-Token', AGENT_TOKEN)
      .send({ projectSide: SIDE });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('project_side_not_settable_here');
    expect(res.body.use).toMatch(/project-side/);
  });

  test('the snake_case spelling is refused by PATCH too', async () => {
    // Both spellings are accepted by the operator route, so both must be refused by the agent one —
    // otherwise the guard is a spelling test.
    ctx = await createBackendTestContext('agent-side-', seed());
    const res = await request(ctx.app).patch(`/api/agents/${AGENT}`)
      .set('X-Agent-Token', AGENT_TOKEN)
      .send({ project_side: SIDE });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('project_side_not_settable_here');
  });

  test('PATCH still works for the fields it does own', async () => {
    // The refusal must be narrow. An agent updating its own identity string is ordinary.
    ctx = await createBackendTestContext('agent-side-', seed());
    const res = await request(ctx.app).patch(`/api/agents/${AGENT}`)
      .set('X-Agent-Token', AGENT_TOKEN)
      .send({ identity: 'still allowed' });
    expect(res.status).toBe(200);
  });
});

describe('what the binding unlocks', () => {
  test('minting refuses before the binding and gets past that refusal after it', async () => {
    /*
     * The whole point, in one test. `no_project_side` was unreachable-from — nothing could set the thing
     * it asked for. Afterwards the refusal moves on to the NEXT real precondition (the side's credential),
     * which is progress rather than the same wall.
     */
    ctx = await createBackendTestContext('agent-side-', seed());
    await withSide(ctx.app);

    const before = await request(ctx.app).post(`/api/agents/${AGENT}/matrix-identity`)
      .set('Authorization', `Bearer ${API_TOKEN}`).send({});
    expect(before.body.code).toBe('no_project_side');

    await request(ctx.app).put(`/api/agents/${AGENT}/project-side`)
      .set('Authorization', `Bearer ${API_TOKEN}`).send({ projectSide: SIDE });

    const after = await request(ctx.app).post(`/api/agents/${AGENT}/matrix-identity`)
      .set('Authorization', `Bearer ${API_TOKEN}`).send({});
    expect(after.body.code).not.toBe('no_project_side');
  });
});
