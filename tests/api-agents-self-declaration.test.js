/*
 * AN AGENT MAY NOT DECLARE WHAT IT COSTS OR WHAT IT CAN DO.
 *
 * `POST /api/agents` and `PATCH /api/agents/:name` are guarded by `requireAgentToken`, which is the
 * right guard for what they are mostly for — an agent saying where it is: this tmux session, this host,
 * this workdir. Four of their fields are not that:
 *
 *   presetId       -> `remainingFor` reads `preset.ceiling.tokens` through it. THE CEILING.
 *   runtimeProfile -> `agentCapability` prefers `modelTier(runtimeProfile)` over the role default.
 *   capability     -> the same tier, stated directly.
 *   role           -> what `selectAgent` will match the agent for.
 *
 * So an agent holding only its own token could raise its own budget by re-registering against a richer
 * preset, and advertise itself into a tier and a role the contributor never granted. `PUT
 * /api/agents/:name/preset` states this exact hazard in its own comment — "an agent could raise its
 * ceiling by re-registering with a richer preset" — and can only close its own route.
 *
 * WHY THE FIX IS PER-FIELD AND NOT A MIDDLEWARE. `checkAgentToken` fails OPEN for a name it holds no
 * token for, and that is deliberate: humans, the bridge and system callers register through the same
 * endpoint with no agent token at all. Tightening the guard would break them. The request is
 * legitimate; only some of its fields are not.
 *
 * WHY BOTH ROUTES. Closing `POST` alone would close nothing — an agent that could not declare a role at
 * registration could patch one in a second later. The pair is the fix.
 *
 * Each test asserts BOTH directions. "The agent cannot set it" alone would also pass if the field had
 * simply stopped working, which is why every case pairs the refusal with the operator succeeding.
 */

import { afterEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

/*
 * A name with no role word in it. `canonicalRole()` infers a role from the NAME — 'coding', 'review',
 * 'test' and four more — so a probe called `probe_coding` would appear to have a role no matter what
 * these tests proved about the field.
 */
const AGENT = 'declare_probe';
const AGENT_TOKEN = 'agent-token-declare-probe';
const API_TOKEN = 'operator-token-declare-probe';

/*
 * API_TOKEN is set DELIBERATELY. The harness deletes it by default ("tests run without Bearer auth
 * unless explicitly configured"), and `isOperatorRequest` passes everything when it is unset — which is
 * its documented posture, tested separately at the bottom. A file that forgot it would show every
 * assertion below passing while proving nothing about authorization.
 */
const seed = (agent = {}) => ({
  agents: {
    // `kind: 'agent'` is what inferRecordKind() reads. Without it the record is not an agent and
    // every agent route answers 404.
    [AGENT]: { name: AGENT, type: 'agent', kind: 'agent', online: true, ...agent },
  },
  agentTokens: { [AGENT]: AGENT_TOKEN },
  env: { API_TOKEN },
});

/** A preset with a ceiling, created through the real operator route. */
async function makePreset(ctx, { name = 'probe-strong', tokens = 5_000_000 } = {}) {
  const res = await request(ctx.app).post('/api/framework-presets')
    .set('Authorization', `Bearer ${API_TOKEN}`)
    .send({
      name,
      framework: 'codex',
      provider: 'openai',
      model: 'gpt-5.6-sol',
      reasoning: 'high',
      ceiling: { tokens, period: 'monthly' },
    });
  expect(res.status).toBe(200);
  return res.body.preset;
}

/** The stored record, read back through the API rather than off disk. */
async function record(ctx) {
  const res = await request(ctx.app).get(`/api/agents/${AGENT}`)
    .set('Authorization', `Bearer ${API_TOKEN}`);
  expect(res.status).toBe(200);
  return res.body;
}

/** As the agent: its own token, no operator bearer. This is the attacker in every case below. */
const asAgent = (ctx, method, url) => request(ctx.app)[method](url).set('X-Agent-Token', AGENT_TOKEN);
/** As the operator: the bearer, plus the agent token so `requireAgentToken` is not the thing tested. */
const asOperator = (ctx, method, url) => request(ctx.app)[method](url)
  .set('X-Agent-Token', AGENT_TOKEN)
  .set('Authorization', `Bearer ${API_TOKEN}`);

describe('POST /api/agents — the four fields an agent may not set', () => {
  let ctx;
  afterEach(async () => { await ctx?.cleanup?.(); ctx = null; });

  test('presetId: the agent cannot attach a ceiling to itself, the operator can', async () => {
    ctx = await createBackendTestContext('declare-preset-', seed());
    const preset = await makePreset(ctx);

    await asAgent(ctx, 'post', '/api/agents')
      .send({ name: AGENT, presetId: preset.id }).expect(200);
    expect((await record(ctx)).presetId).toBe(null);

    await asOperator(ctx, 'post', '/api/agents')
      .send({ name: AGENT, presetId: preset.id }).expect(200);
    expect((await record(ctx)).presetId).toBe(preset.id);
  });

  test('presetId: THE MONEY. The ceiling only appears when the operator asked for it', async () => {
    /*
     * The field alone is bookkeeping; this is the consequence. `GET /api/usage` reports
     * `ceilingTokens` by resolving the agent's `presetId` — the same lookup `remainingFor` makes
     * before an engagement can be allocated against the agent at all.
     */
    ctx = await createBackendTestContext('declare-ceiling-', seed());
    const preset = await makePreset(ctx, { tokens: 9_000_000 });
    const ceilingOf = async () => {
      const res = await request(ctx.app).get('/api/usage')
        .set('Authorization', `Bearer ${API_TOKEN}`).expect(200);
      return res.body.agents.find((row) => row.agent === AGENT)?.ceilingTokens ?? null;
    };

    await asAgent(ctx, 'post', '/api/agents').send({ name: AGENT, presetId: preset.id }).expect(200);
    expect(await ceilingOf()).toBe(null);

    await asOperator(ctx, 'post', '/api/agents').send({ name: AGENT, presetId: preset.id }).expect(200);
    expect(await ceilingOf()).toBe(9_000_000);
  });

  test("presetId: dropped BEFORE resolution, so the preset's model and framework do not leak in", async () => {
    /*
     * The reason the gate sits above `runtimeProfileFromPreset` rather than on the stored field.
     * Gating only `presetId` would leave the preset's framework reaching `type` and its profile
     * reaching `runtimeProfile` — the agent would still have picked its own model, with the record no
     * longer saying which preset it came from. That is worse than the original hole, because it is
     * invisible.
     */
    ctx = await createBackendTestContext('declare-preset-leak-', seed());
    const preset = await makePreset(ctx);

    await asAgent(ctx, 'post', '/api/agents')
      .send({ name: AGENT, type: 'agent', presetId: preset.id }).expect(200);

    const after = await record(ctx);
    expect(after.presetId).toBe(null);
    expect(after.runtimeProfile).toBe(null);
    expect(after.type).toBe('agent');
  });

  test('presetId: an unknown preset from the agent is IGNORED, not answered with 400', async () => {
    /*
     * Recorded because it is a choice, not an accident. The gate drops the field before the lookup, so
     * there is nothing left to validate. Answering 400 would confirm to an unauthorized caller which
     * preset ids exist, and the operator still gets the 400 they need.
     */
    ctx = await createBackendTestContext('declare-preset-unknown-', seed());

    await asAgent(ctx, 'post', '/api/agents')
      .send({ name: AGENT, presetId: 'no-such-preset' }).expect(200);
    expect((await record(ctx)).presetId).toBe(null);

    const operator = await asOperator(ctx, 'post', '/api/agents')
      .send({ name: AGENT, presetId: 'no-such-preset' });
    expect(operator.status).toBe(400);
    expect(operator.body.error).toMatch(/unknown preset: no-such-preset/);
  });

  test('runtimeProfile: the agent cannot choose its own model, the operator can', async () => {
    ctx = await createBackendTestContext('declare-profile-', seed());
    const profile = { primary: { framework: 'claude', provider: 'anthropic', model: 'claude-opus-5' } };

    await asAgent(ctx, 'post', '/api/agents').send({ name: AGENT, runtimeProfile: profile }).expect(200);
    expect((await record(ctx)).runtimeProfile).toBe(null);

    await asOperator(ctx, 'post', '/api/agents').send({ name: AGENT, runtimeProfile: profile }).expect(200);
    expect((await record(ctx)).runtimeProfile?.primary?.model).toBe('claude-opus-5');
  });

  test('runtimeProfile: the agent cannot ERASE the profile the operator set either', async () => {
    /*
     * `null` used to reach `mergeRuntimeProfileApiKeys(normalizeRuntimeProfile(null), ...)`, so an
     * explicit null was a write like any other. An agent that could clear its profile would drop to
     * the role's DEFAULT tier — a different claim about someone else's money, not an absence of one.
     */
    ctx = await createBackendTestContext('declare-profile-erase-', seed({
      runtimeProfile: { primary: { framework: 'codex', provider: 'openai', model: 'gpt-5.6-sol' } },
    }));

    await asAgent(ctx, 'post', '/api/agents').send({ name: AGENT, runtimeProfile: null }).expect(200);
    expect((await record(ctx)).runtimeProfile?.primary?.model).toBe('gpt-5.6-sol');
  });

  test('capability: the agent cannot advertise its own tier, the operator can', async () => {
    ctx = await createBackendTestContext('declare-capability-', seed());

    await asAgent(ctx, 'post', '/api/agents').send({ name: AGENT, capability: 'strong' }).expect(200);
    expect((await record(ctx)).capability).toBe(null);

    await asOperator(ctx, 'post', '/api/agents').send({ name: AGENT, capability: 'strong' }).expect(200);
    expect((await record(ctx)).capability).toBe('strong');
  });

  test('role: the agent cannot name the work it will be selected for, the operator can', async () => {
    ctx = await createBackendTestContext('declare-role-', seed());

    await asAgent(ctx, 'post', '/api/agents').send({ name: AGENT, role: 'architect' }).expect(200);
    expect((await record(ctx)).role).toBe(null);

    await asOperator(ctx, 'post', '/api/agents').send({ name: AGENT, role: 'architect' }).expect(200);
    expect((await record(ctx)).role).toBe('architect');
  });

  test('role: VALIDATED against ROLES now — the surface that needed prose here is dead', async () => {
    /*
     * THE REVERSAL, on the record. The earlier version of this test asserted the OPPOSITE — that prose
     * passed — because the old portal's New Agent form sent its GUIDANCE textarea as `role`, and a
     * strict check would have silently discarded what an operator typed. That portal is deleted; every
     * living writer sends a vocabulary key or nothing. Prose about an agent belongs in `identity`.
     *
     * The refusal is a 400 that NAMES the vocabulary and the right field, because an operator whose
     * typo silently kept the old value is the same silent-unstaffable trap the validation exists to
     * close — just wearing a 200.
     */
    ctx = await createBackendTestContext('declare-role-prose-', seed());
    const r = await asOperator(ctx, 'post', '/api/agents')
      .send({ name: AGENT, role: 'Ship the parser rewrite; ask before touching the lexer.' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/unknown role/);
    expect(r.body.error).toMatch(/belongs in identity/);
    /*
     * The seeded record is untouched: the 400 fired before any assignment, and the seed never had a
     * `role` key at all — so the honest assertion is "still absent", not "null". (First draft said
     * null and undefined showed up to disagree.)
     */
    expect((await record(ctx)).role).toBeUndefined();

    // The vocabulary still passes, PATCH included, and null still clears.
    await asOperator(ctx, 'post', '/api/agents').send({ name: AGENT, role: 'architect' }).expect(200);
    expect((await record(ctx)).role).toBe('architect');
    await asOperator(ctx, 'patch', `/api/agents/${AGENT}`).send({ role: 'not-a-role' }).expect(400);
    expect((await record(ctx)).role).toBe('architect');
    await asOperator(ctx, 'patch', `/api/agents/${AGENT}`).send({ role: null }).expect(200);
    expect((await record(ctx)).role).toBe(null);
  });

  test('an AGENT sending an invalid role is dropped, not taught the vocabulary', async () => {
    /*
     * The 400 names valid roles, so it is reserved for the operator — the caller who may actually set
     * the field. An agent-token caller's role is dropped by the self-declaration gate whatever its
     * value; answering 400 would leak which values are valid to a caller that cannot use them.
     */
    ctx = await createBackendTestContext('declare-role-agent-invalid-', seed());
    await asAgent(ctx, 'post', '/api/agents')
      .send({ name: AGENT, role: 'definitely-not-a-role' }).expect(200);
    expect((await record(ctx)).role).toBe(null);
  });

  test('THE REAL AGENT-SIDE CALLER IS UNAFFECTED, and keeps what the operator set', async () => {
    /*
     * `lib/mcp-server-core.js` re-registers its own agent with `{name, type, tmux, server}` on a
     * heartbeat — none of the four fields. This is the regression that would matter most: a gate that
     * quietly reset role, tier or ceiling on every heartbeat would empty the fleet's configuration a
     * few seconds after an operator filled it in.
     */
    ctx = await createBackendTestContext('declare-heartbeat-', seed({
      role: 'architect',
      capability: 'strong',
      runtimeProfile: { primary: { framework: 'codex', provider: 'openai', model: 'gpt-5.6-sol' } },
    }));
    const preset = await makePreset(ctx);
    await asOperator(ctx, 'post', '/api/agents').send({ name: AGENT, presetId: preset.id }).expect(200);

    await asAgent(ctx, 'post', '/api/agents')
      .send({ name: AGENT, type: 'agent', tmux: 'agent_declare_probe', server: 'local' }).expect(200);

    expect(await record(ctx)).toMatchObject({
      role: 'architect',
      capability: 'strong',
      presetId: preset.id,
      tmux: 'agent_declare_probe',
    });
    expect((await record(ctx)).runtimeProfile?.primary?.model).toBe('gpt-5.6-sol');
  });
});

describe('PATCH /api/agents/:name — the same hole through the second door', () => {
  let ctx;
  afterEach(async () => { await ctx?.cleanup?.(); ctx = null; });

  test('role: an agent that could not declare one at registration cannot patch one in', async () => {
    ctx = await createBackendTestContext('declare-patch-role-', seed());

    await asAgent(ctx, 'patch', `/api/agents/${AGENT}`).send({ role: 'architect' }).expect(200);
    expect((await record(ctx)).role).toBeFalsy();

    await asOperator(ctx, 'patch', `/api/agents/${AGENT}`).send({ role: 'architect' }).expect(200);
    expect((await record(ctx)).role).toBe('architect');
  });

  test('runtimeProfile: withdrawn from the agent here too, which is where the tier is decided', async () => {
    ctx = await createBackendTestContext('declare-patch-profile-', seed({
      runtimeProfile: { primary: { framework: 'codex', provider: 'openai', model: 'gpt-5.6-sol' } },
    }));
    const upgrade = { primary: { framework: 'claude', provider: 'anthropic', model: 'claude-opus-5' } };

    await asAgent(ctx, 'patch', `/api/agents/${AGENT}`).send({ runtimeProfile: upgrade }).expect(200);
    expect((await record(ctx)).runtimeProfile?.primary?.model).toBe('gpt-5.6-sol');

    await asOperator(ctx, 'patch', `/api/agents/${AGENT}`).send({ runtimeProfile: upgrade }).expect(200);
    expect((await record(ctx)).runtimeProfile?.primary?.model).toBe('claude-opus-5');
  });

  test('identity is still the agent\'s own to set — the gate is four fields, not the route', async () => {
    /*
     * `bin/hafleet-cli identity` and the bot's `identity` command both patch this field with the
     * agent's token. A gate that had been written per-request instead of per-field would have taken
     * them with it.
     */
    ctx = await createBackendTestContext('declare-patch-identity-', seed());
    await asAgent(ctx, 'patch', `/api/agents/${AGENT}`)
      .send({ identity: 'parser work, Beijing hours' }).expect(200);
    expect((await record(ctx)).identity).toBe('parser work, Beijing hours');
  });
});

describe('no API_TOKEN configured', () => {
  let ctx;
  afterEach(async () => { await ctx?.cleanup?.(); ctx = null; });

  test('everything passes, matching requireBearer rather than being stricter than it', async () => {
    /*
     * A deployment with no operator credential cannot tell an operator from an agent, and
     * `requireBearer` passes there too. Refusing the fields instead would make the unconfigured
     * install stricter than the configured one, which reads as a broken product rather than as a
     * security posture — and it is asserted because it is the branch a reader will doubt.
     */
    ctx = await createBackendTestContext('declare-no-token-', {
      agents: { [AGENT]: { name: AGENT, type: 'agent', kind: 'agent', online: true } },
      agentTokens: { [AGENT]: AGENT_TOKEN },
      // No API_TOKEN: the harness deletes it by default.
    });

    await request(ctx.app).post('/api/agents').set('X-Agent-Token', AGENT_TOKEN)
      .send({ name: AGENT, role: 'architect', capability: 'strong' }).expect(200);

    const res = await request(ctx.app).get(`/api/agents/${AGENT}`).expect(200);
    expect(res.body).toMatchObject({ role: 'architect', capability: 'strong' });
  });
});
