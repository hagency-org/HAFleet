/*
 * Role→resource matching on the provisioning path — ADR-016 decision 4's recorded gap.
 *
 * Before this, a provision plan's resource declaration was "an operator-chosen preset rather than a
 * role-matched selection" (the ADR's words): the plan's runtime came from TIER_RUNTIME, a static
 * tier→model table that knows nothing about what the deployment has configured. `resourceForRole`
 * closes that: the plan is minted FROM a configured preset that can staff the (role, tier) ask, or
 * refused when none can.
 *
 * THE HEAVIEST ASSERTIONS ARE ABOUT WHAT A REFUSAL MUST NOT DO. A queue entry answers "waiting for
 * capacity" when the truth is "no configured resource can ever staff this" — the same lie the budget
 * gate beside this one exists to avoid — and a refusal that silently kept its (role, tier)
 * reservation would poison the cell for every later ask that COULD be staffed.
 */

import { afterEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

let context = null;
afterEach(async () => { context?.cleanup(); context = null; });

/*
 * Presets are seeded as data rather than created through POST /api/framework-presets wherever the
 * test's point depends on the ID: the route generates ids (`preset_<time>_<rand>`), and the
 * within-a-tier tie-break is BY id, so generated ids would make the deterministic-selection
 * assertions depend on which random id sorted first.
 */
const preset = (id, { framework = 'claude', provider = 'anthropic', model, reasoning = null, ceilingTokens = 5_000_000 } = {}) => ({
  id,
  name: id,
  framework,
  provider,
  model,
  reasoning,
  extraArgs: null,
  apiBaseUrl: null,
  apiKey: null,
  ceiling: ceilingTokens === null
    ? null
    : { tokens: ceilingTokens, period: 'monthly', rateCapPerDay: null, enforced: false },
});

// Models are the ones lib/role-capacity.json accepts, one per tier.
const opus = (id = 'preset_opus', extra = {}) => preset(id, { model: 'claude-opus-5', ...extra });
const sonnet = (id = 'preset_sonnet', extra = {}) => preset(id, { model: 'claude-sonnet-5', ...extra });
const haiku = (id = 'preset_haiku', extra = {}) => preset(id, { model: 'claude-haiku-4-5', ...extra });

async function boot(seed = {}) {
  context = await createBackendTestContext('api-provision-role-matching-', {
    agents: {},
    ...seed,
    env: { MATRIX_AGENT_MAX_PER_CELL: '1', ...(seed.env || {}) },
  });
  return context.app;
}

const dispatch = (app, body = {}) => request(app).post('/api/dispatch').send(body);

describe('POST /api/dispatch — the provision plan is role-matched', () => {
  test('NO QUALIFYING RESOURCE IS A REFUSAL — never a queue entry, and no seat is held', async () => {
    /*
     * Only a lightweight preset is configured, and an architect ask needs `strong`. The three
     * assertions are the three ways this could have gone quietly wrong: relabelled `queued` (the
     * "waiting for capacity" lie), a ticket minted anyway, or a reservation silently held so the
     * cell refuses forever after the operator fixes the configuration.
     */
    const app = await boot({ frameworkPresets: [haiku()] });

    const r = await dispatch(app, { role: 'architect' });
    expect(r.status).toBe(409);
    expect(r.body.status).toBe('refused');
    expect(r.body.reason).toBe('no_resource_for_role');
    // The refusal names the ask and the search space, so the remedy is obvious.
    expect(r.body.error).toMatch(/'architect'/);
    expect(r.body.error).toMatch(/'strong'/);
    expect(r.body.error).toMatch(/1 preset/);
    expect(r.body.presetsConsidered).toBe(1);
    expect(r.body.ticket).toBeUndefined();
    expect(context.internals.dispatchQueuesForTest.get('architect:strong') ?? []).toHaveLength(0);

    // THE SEAT WAS NOT HELD. Cap is 1: had the refusal leaked a reservation, this cell would queue
    // forever. Add a qualifying preset through the real operator route, and the same ask provisions.
    const created = await request(app).post('/api/framework-presets').send({
      name: 'opus-added-later', framework: 'claude', provider: 'anthropic',
      model: 'claude-opus-5', ceiling: { tokens: 1_000_000, period: 'monthly' },
    });
    expect(created.status).toBe(200);
    const after = await dispatch(app, { role: 'architect' });
    expect(after.body.status).toBe('provision');
    expect(after.body.presetId).toBe(created.body.preset.id);
  });

  test("a role's EXCLUDED models are refused even when the ask's tier would accept them", async () => {
    /*
     * role-capacity.json forbids `architect` and `review` on haiku-4-5 and fable-5 ("below the
     * strong floor"). The tier check alone does NOT cover that: both roles default to `strong`, but
     * `resolveTier` lets an explicit `capability` win over the default, so an architect ask at
     * `lightweight` reaches exactly the presets the file forbids. This is the ask that made the
     * `excluded` list load-bearing — before it, no code in the repo read that list at all.
     */
    const app = await boot({ frameworkPresets: [haiku()] });

    const r = await dispatch(app, { role: 'architect', capability: 'lightweight' });
    expect(r.body.status).toBe('refused');
    expect(r.body.reason).toBe('no_resource_for_role');

    // The SAME preset at the SAME tier staffs a role that has no exclusion — so what refused above
    // was the role's exclusion, not the tier or the preset being unusable.
    const other = await dispatch(app, { role: 'documentation', capability: 'lightweight' });
    expect(other.body.status).toBe('provision');
    expect(other.body.presetId).toBe('preset_haiku');
  });

  test('selection picks the LOWEST qualifying tier — a strong seat is not burned on a medium ask', async () => {
    const app = await boot({ frameworkPresets: [opus(), sonnet()] });
    const r = await dispatch(app, { role: 'coding' }); // defaultTier medium
    expect(r.body.status).toBe('provision');
    expect(r.body.presetId).toBe('preset_sonnet');
    // `runtime` stays for launchers, now derived from the matched preset rather than the tier table.
    expect(r.body.runtime).toMatchObject({ runtime: 'claude', model: 'claude-sonnet-5' });
  });

  test('within a tier the pick is deterministic: lowest id, whatever order the store lists them', async () => {
    // Seeded b-before-a so a pick that follows array order would give the wrong answer.
    const app = await boot({ frameworkPresets: [sonnet('preset_m_b'), sonnet('preset_m_a')] });
    const r = await dispatch(app, { role: 'coding' });
    expect(r.body.status).toBe('provision');
    expect(r.body.presetId).toBe('preset_m_a');
  });

  test('a preset with NO ceiling does not qualify — nothing can ever be approved against it', async () => {
    /*
     * `remainingFor` reads `preset.ceiling.tokens`; without one it returns null and the engagement
     * store refuses to allocate. An agent minted from a ceiling-less preset would look like capacity
     * and serve nothing, so the honest answer is the refusal.
     */
    const app = await boot({ frameworkPresets: [sonnet('preset_sonnet_bare', { ceilingTokens: null })] });
    const r = await dispatch(app, { role: 'coding' });
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe('no_resource_for_role');
    expect(context.internals.dispatchQueuesForTest.get('coding:medium') ?? []).toHaveLength(0);
  });

  test('the ceiling requirement steers PAST an exact-tier preset to a stronger one that has one', async () => {
    // The exact-tier preset would win on tier alone; its missing ceiling disqualifies it, so the
    // over-tier preset with a real ceiling is the only resource that can staff the ask.
    const app = await boot({
      frameworkPresets: [sonnet('preset_sonnet_bare', { ceilingTokens: null }), opus()],
    });
    const r = await dispatch(app, { role: 'coding' });
    expect(r.body.status).toBe('provision');
    expect(r.body.presetId).toBe('preset_opus');
    expect(r.body.runtime).toMatchObject({ runtime: 'claude', model: 'claude-opus-5' });
  });

  test('ZERO presets: the static tier table still answers — the gate is scoped to declared resources', async () => {
    /*
     * The scoping decision, pinned so it stays a decision. A deployment with no presets at all has
     * made no resource declarations to match against — it predates the preset model — and refusing
     * every mint there would turn an upgrade into an outage. The moment any preset exists, the
     * matching (and its refusal) is live; that is the rest of this file.
     */
    const app = await boot();
    const r = await dispatch(app, { role: 'documentation' });
    expect(r.body.status).toBe('provision');
    expect(r.body.presetId).toBeUndefined();
    expect(r.body.runtime).toEqual({ runtime: 'claude', model: 'claude-haiku-4-5' });
  });
});

describe('the fulfilled plan binds the agent to the matched preset', () => {
  const API_TOKEN = 'operator-token-role-matching';

  test("the plan's presetId lands at registration and SURVIVES the self-declaration gate", async () => {
    /*
     * API_TOKEN is set DELIBERATELY, same as tests/api-agents-self-declaration.test.js: without it
     * `isOperatorRequest` passes everything and the gate this test exercises is not in the path.
     *
     * The registering agent is the attacker here: it sends a RICHER presetId and an Opus
     * runtimeProfile in its own body. Both must be dropped — and the plan's preset must land
     * anyway, because it comes from the backend's own `provisionedSides` memory, never the body.
     */
    const app = await boot({
      frameworkPresets: [sonnet('preset_plan', { ceilingTokens: 3_000_000 }), opus('preset_decoy')],
      env: { API_TOKEN },
    });

    const plan = await dispatch(app, { role: 'coding' });
    expect(plan.body.status).toBe('provision');
    expect(plan.body.presetId).toBe('preset_plan');

    await request(app).post('/api/agents').send({
      name: plan.body.name,
      type: 'agent',
      presetId: 'preset_decoy',
      runtimeProfile: { primary: { framework: 'claude', provider: 'anthropic', model: 'claude-opus-5' } },
    }).expect(200);

    const agent = (await request(app).get(`/api/agents/${plan.body.name}`)).body;
    expect(agent.presetId).toBe('preset_plan');
    // Resolved through frameworkPresets → runtimeProfileFromPreset, exactly like the operator path:
    // the profile (which decides the tier) and the framework both come from the PLAN's preset.
    expect(agent.runtimeProfile?.primary?.model).toBe('claude-sonnet-5');
    expect(agent.type).toBe('claude');

    // The plan is consumed at fulfilment; a later heartbeat re-registration must KEEP the binding
    // (existing-record carry-forward), not lose it because the plan memory is gone.
    await request(app).post('/api/agents').send({ name: plan.body.name, type: 'agent' }).expect(200);
    expect((await request(app).get(`/api/agents/${plan.body.name}`)).body.presetId).toBe('preset_plan');
  });
});

describe('GET /api/capability — the resources block', () => {
  test('per role: which presets could be minted from, in selection order, with reasons for the rest', async () => {
    const app = await boot({
      frameworkPresets: [
        opus(),
        sonnet(),
        haiku('preset_haiku_bare', { ceilingTokens: null }),
        preset('preset_alien', { model: 'gpt-oss-write' }), // no tier accepts this model
      ],
    });
    const r = await request(app).get('/api/capability');
    expect(r.status).toBe(200);

    // Extend, don't reshape: the existing role rows are still there and still shaped as before.
    expect(Array.isArray(r.body.roles)).toBe(true);
    expect(r.body.roles[0]).toHaveProperty('able');
    expect(r.body.roles[0]).toHaveProperty('unable');
    expect(r.body.source).toBe('lib/role-capacity.json');

    const { resources } = r.body;

    // architect needs strong: only the Opus preset qualifies; every other preset carries its reason.
    expect(resources.architect.qualified).toEqual([
      { presetId: 'preset_opus', name: 'preset_opus', tier: 'strong', overTier: 0, ceilingTokens: 5_000_000 },
    ]);
    expect(resources.architect.selected).toBe('preset_opus');
    expect(resources.architect.considered).toBe(4);
    const architectReasons = Object.fromEntries(
      resources.architect.unqualified.map((u) => [u.presetId, u.reason]),
    );
    expect(architectReasons).toEqual({
      preset_sonnet: 'below-tier',
      preset_haiku_bare: 'below-tier',
      preset_alien: 'model-not-accepted',
    });

    // coding needs medium: sonnet before opus — lowest qualifying tier first, the selection order.
    expect(resources.coding.qualified.map((q) => q.presetId)).toEqual(['preset_sonnet', 'preset_opus']);
    expect(resources.coding.selected).toBe('preset_sonnet');
    expect(resources.coding.qualified[1].overTier).toBe(1);

    // documentation needs lightweight: the haiku preset is tier-right but ceiling-less, so it is
    // named unqualified rather than silently missing — that difference is the whole refusal.
    expect(resources.documentation.selected).toBe('preset_sonnet');
    const docReason = resources.documentation.unqualified.find((u) => u.presetId === 'preset_haiku_bare');
    expect(docReason).toMatchObject({ reason: 'no-ceiling', tier: 'lightweight' });
  });
});

/*
 * THE MATCHER, ON A PATH SOMETHING ACTUALLY CALLS.
 *
 * Everything above tests `POST /api/dispatch`, which ADR-013 decision 8 withdrew and which has no product
 * caller — a correct matcher on a road nobody drives. A project asks for a role through
 * `POST /api/engagements`, and when nothing can serve it the response now says what it would take.
 *
 * A HINT, NOT A REFUSAL. A first version refused with 409 and two existing tests refused THAT, correctly:
 * a request with no qualifying agent is recorded (the project asked, which is a fact worth keeping) and
 * discloses `serving: null` rather than a guess. Turning it into an error would make ADR-013's queue model
 * unreachable from outside. So the request lands and the operator learns what is missing.
 */
describe('POST /api/engagements — when nothing can serve the role', () => {
  const ROOM = `!p:${'palpo.test'}`;

  const ask = (app, role = 'coding') => request(app).post('/api/engagements').send({
    project: 'p', projectRoomId: ROOM, role, requester: '@r:palpo.test',
    requestedTokens: 1000, ratePerDay: 100, requestId: `$hint-${role}`,
  });

  test('it names the preset that WOULD staff the role, and still records the request', async () => {
    const app = await boot({ frameworkPresets: [opus()] });
    const r = await ask(app, 'architect');

    expect(r.status).toBe(200);
    expect(r.body.engagement).toBeDefined();
    // The disclosure contract is untouched: no agent, so nothing is claimed about what serves it.
    expect(r.body.serving).toBeNull();
    expect(r.body.provisionHint).toMatchObject({
      reason: 'no_agent_provisioned_for_role',
      role: 'architect',
      tier: 'strong',
      presetId: 'preset_opus',
    });
    expect(r.body.provisionHint.detail).toMatch(/preset_opus/);
  });

  test('with nothing configured that qualifies, it says THAT instead — a different problem', async () => {
    /*
     * The two have different fixes: provision an agent from a preset you already have, versus add a preset
     * at all. One reason string for both would send an operator looking for an agent that could never
     * exist.
     */
    const app = await boot({ frameworkPresets: [haiku()] });
    const r = await ask(app, 'architect');
    expect(r.body.provisionHint).toMatchObject({
      reason: 'no_resource_for_role', presetId: null, presetsConsidered: 1,
    });
    expect(r.body.provisionHint.detail).toMatch(/none of the 1 configured preset/);
  });

  test('when an agent CAN serve the role, no hint is attached at all', async () => {
    /*
     * Omitted rather than null: a field that is null on every normal response is noise, and noise in a
     * response teaches readers to skip the object it lives in.
     */
    const app = await boot({
      frameworkPresets: [opus()],
      agents: {
        able: {
          name: 'able', type: 'agent', kind: 'agent', online: true, role: 'architect',
          runtimeProfile: { primary: { framework: 'claude', provider: 'anthropic', model: 'claude-opus-5' } },
        },
      },
    });
    const r = await ask(app, 'architect');
    expect(r.body.engagement.agent).toBe('able');
    expect(r.body).not.toHaveProperty('provisionHint');
  });
});
