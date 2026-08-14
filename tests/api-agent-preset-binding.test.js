/*
 * PUT /api/agents/:name/preset — the act that gives an agent a CEILING.
 *
 * Found by walking the contribution flow end to end, not by a failing test. The chain is:
 * a preset carries `ceiling.tokens`; `remainingFor(agent)` reads `agent.presetId` to find that
 * preset; `engagementStore.decide()` REFUSES to approve an engagement whose agent has no
 * remaining ("cannot allocate against an agent with no declared ceiling"). So `presetId` is the
 * single link between a declared ceiling and an approvable engagement.
 *
 * Before this route, nothing a contributor could reach wrote it. The only writer was
 * `POST /api/agents`, behind `requireAgentToken`, and no CLI flag passes a preset. A contributor
 * could therefore create a ceiling, onboard an agent, and never connect them — every engagement
 * permanently unapprovable, with the console listing the agent as "bare" and offering no action.
 *
 * That other writer is now operator-gated as well: `POST /api/agents` and `PATCH /api/agents/:name`
 * honour `presetId`, `runtimeProfile`, `capability` and `role` only from a request carrying the
 * operator bearer. See tests/api-agents-self-declaration.test.js — this route is no longer the only
 * place the argument below is enforced, it is where the argument was first made.
 *
 * The auth choice is the substance of the design, so it is tested first: the ceiling is the
 * CONTRIBUTOR's declaration about their own resource (ADR-013 L1/L2). Gating it on the agent's own
 * token would let the resource set its own budget — an agent could raise its ceiling by
 * re-registering against a richer preset.
 */

import { afterEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const AGENT = 'lend-codex-probe';
const AGENT_TOKEN = 'agent-token-probe';
const API_TOKEN = 'operator-token-probe';

/*
 * API_TOKEN is set DELIBERATELY. `createRequireBearer` is a no-op when API_TOKEN is empty, and the
 * test harness deletes it by default ("tests run without Bearer auth unless explicitly
 * configured"), so a suite that omits it sends `Bearer undefined`, gets 200, and proves nothing
 * about authorization. The two auth cases below are the point of this file, so the token has to be
 * real for them to mean anything.
 */
const seed = () => ({
  agents: {
    // `kind: 'agent'` is what inferRecordKind() looks at — the shared store holds agents and
    // servers in one map, so a record without it is not an agent and every route 404s.
    [AGENT]: { name: AGENT, type: 'agent', kind: 'agent', online: true, capability: 'coding' },
  },
  agentTokens: { [AGENT]: AGENT_TOKEN },
  env: { API_TOKEN },
});

/** Create a preset with an optional ceiling, through the real endpoint. */
async function makePreset(ctx, { name, tokens = 5_000_000 } = {}) {
  const body = {
    name: name || 'probe-codex-strong',
    framework: 'codex',
    provider: 'openai',
    model: 'gpt-5.6-sol',
    reasoning: 'high',
  };
  if (tokens !== null) body.ceiling = { tokens, period: 'monthly' };
  const res = await request(ctx.app).post('/api/framework-presets')
    .set('Authorization', `Bearer ${API_TOKEN}`)
    .send(body);
  expect(res.status).toBe(200);
  return res.body.preset;
}

describe('PUT /api/agents/:name/preset', () => {
  let ctx;
  afterEach(async () => { await ctx?.cleanup?.(); ctx = null; });

  test('binds the preset and reports the resulting ceiling and remaining', async () => {
    ctx = await createBackendTestContext('agent-preset-', seed());
    const preset = await makePreset(ctx);

    const res = await request(ctx.app).put(`/api/agents/${AGENT}/preset`)
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .send({ presetId: preset.id });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.agent.presetId).toBe(preset.id);
    /*
     * `remaining` is in the response because it is the question the caller actually has. Binding a
     * preset that carries no ceiling leaves the agent exactly as unapprovable as before, and
     * answering with a bare `ok: true` would conceal that.
     */
    expect(res.body.ceilingTokens).toBe(5_000_000);
    expect(res.body.remaining).toBe(5_000_000);
  });

  test('an agent with no preset has no remaining — the state that blocks every approval', async () => {
    ctx = await createBackendTestContext('agent-preset-none-', seed());
    const usage = await request(ctx.app).get('/api/usage')
      .set('Authorization', `Bearer ${API_TOKEN}`);
    const row = usage.body.agents.find((a) => a.agent === AGENT);
    expect(row.ceilingTokens).toBeNull();
  });

  test('binding a preset that declares NO ceiling still leaves remaining null, and says so', async () => {
    /*
     * The failure this route must not paper over: a preset is not automatically a budget. If this
     * returned `ok` with no signal, a contributor would believe the agent was ready to lend and
     * discover otherwise only when an approval failed with `no_ceiling`.
     */
    ctx = await createBackendTestContext('agent-preset-noceiling-', seed());
    const preset = await makePreset(ctx, { name: 'no-ceiling', tokens: null });

    const res = await request(ctx.app).put(`/api/agents/${AGENT}/preset`)
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .send({ presetId: preset.id });

    expect(res.status).toBe(200);
    expect(res.body.agent.presetId).toBe(preset.id);
    expect(res.body.ceilingTokens).toBeNull();
    expect(res.body.remaining).toBeNull();
  });

  test('presetId null unbinds, and the ceiling goes with it', async () => {
    ctx = await createBackendTestContext('agent-preset-unbind-', seed());
    const preset = await makePreset(ctx);
    await request(ctx.app).put(`/api/agents/${AGENT}/preset`)
      .set('Authorization', `Bearer ${API_TOKEN}`).send({ presetId: preset.id });

    const res = await request(ctx.app).put(`/api/agents/${AGENT}/preset`)
      .set('Authorization', `Bearer ${API_TOKEN}`).send({ presetId: null });

    expect(res.status).toBe(200);
    expect(res.body.agent.presetId).toBeNull();
    expect(res.body.remaining).toBeNull();
  });

  test('an unknown preset is refused, and the previous binding is untouched', async () => {
    /*
     * Not merely "rejects": the binding must SURVIVE a failed write. Clearing it on a typo would
     * silently strip a working ceiling and make every later approval fail for a reason unrelated
     * to what the operator just did.
     */
    ctx = await createBackendTestContext('agent-preset-unknown-', seed());
    const preset = await makePreset(ctx);
    await request(ctx.app).put(`/api/agents/${AGENT}/preset`)
      .set('Authorization', `Bearer ${API_TOKEN}`).send({ presetId: preset.id });

    const res = await request(ctx.app).put(`/api/agents/${AGENT}/preset`)
      .set('Authorization', `Bearer ${API_TOKEN}`).send({ presetId: 'preset_does_not_exist' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown preset/);
    const after = await request(ctx.app).get(`/api/agents/${AGENT}`)
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(after.body.presetId ?? after.body.agent?.presetId).toBe(preset.id);
  });

  test('the runtimeProfile moves with the preset — otherwise the agent fills no role', async () => {
    /*
     * The defect the first version of this route shipped. `agentForRole()` picks an agent by
     * `modelTier(agent.runtimeProfile)`, NOT by its preset, so setting presetId alone produced an
     * agent with a ceiling, no tier and no role. The visible symptom was two steps away and
     * misleading: the engagement came back with `agent: null`, and approving it then failed
     * `no_ceiling` — pointing at the budget, which was fine.
     */
    ctx = await createBackendTestContext('agent-preset-profile-', seed());
    const preset = await makePreset(ctx);

    const res = await request(ctx.app).put(`/api/agents/${AGENT}/preset`)
      .set('Authorization', `Bearer ${API_TOKEN}`).send({ presetId: preset.id });

    expect(res.status).toBe(200);
    // codex + gpt-5.6-sol + high is the STRONG tier, which subsumes every role.
    expect(res.body.tier).toBe('strong');
    expect(res.body.agent.runtimeProfile?.primary).toMatchObject({
      framework: 'codex', provider: 'openai', model: 'gpt-5.6-sol', reasoning: 'high',
    });
  });

  test('unbinding clears the runtimeProfile too, not just the id', async () => {
    /*
     * Otherwise a contributor detaches a resource and it keeps serving on the terms they just
     * withdrew: no ceiling to draw against, but still tier-qualified and therefore still selected
     * by agentForRole().
     */
    ctx = await createBackendTestContext('agent-preset-unbind-profile-', seed());
    const preset = await makePreset(ctx);
    await request(ctx.app).put(`/api/agents/${AGENT}/preset`)
      .set('Authorization', `Bearer ${API_TOKEN}`).send({ presetId: preset.id });

    const res = await request(ctx.app).put(`/api/agents/${AGENT}/preset`)
      .set('Authorization', `Bearer ${API_TOKEN}`).send({ presetId: null });

    expect(res.status).toBe(200);
    expect(res.body.tier).toBeNull();
    expect(res.body.agent.runtimeProfile ?? null).toBeNull();
  });

  test('an unknown agent is 404', async () => {
    ctx = await createBackendTestContext('agent-preset-404-', seed());
    const preset = await makePreset(ctx);
    const res = await request(ctx.app).put('/api/agents/not-an-agent/preset')
      .set('Authorization', `Bearer ${API_TOKEN}`).send({ presetId: preset.id });
    expect(res.status).toBe(404);
  });

  test('the AGENT\'S OWN token cannot set its budget — only the contributor can', async () => {
    /*
     * The design decision, as a test. An agent authenticating as itself must not be able to raise
     * its own ceiling: the budget is the contributor's statement about how much of their capacity
     * they will lend, and letting the resource declare it is self-authorization. The agent keeps
     * reporting its runtimeProfile; it does not get to report its budget.
     */
    ctx = await createBackendTestContext('agent-preset-selfauth-', seed());
    const preset = await makePreset(ctx);

    const res = await request(ctx.app).put(`/api/agents/${AGENT}/preset`)
      .set('X-Agent-Token', AGENT_TOKEN)
      .send({ presetId: preset.id });

    expect(res.status).toBe(401);
    const after = await request(ctx.app).get(`/api/agents/${AGENT}`)
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(after.body.presetId ?? after.body.agent?.presetId ?? null).toBeNull();
  });

  test('unauthenticated is refused', async () => {
    ctx = await createBackendTestContext('agent-preset-noauth-', seed());
    const preset = await makePreset(ctx);
    const res = await request(ctx.app).put(`/api/agents/${AGENT}/preset`).send({ presetId: preset.id });
    expect(res.status).toBe(401);
  });
});
