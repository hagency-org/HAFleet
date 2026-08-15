/*
 * AN AGENT ALREADY PAST ITS CEILING HAS TO PAGE SOMEBODY.
 *
 * `project_side_budget` fires when a request is REFUSED, so it needs somebody to ask. An overrun needs
 * nobody: it arrives when a ceiling is lowered under commitments that were admissible when they were
 * made, and admission control cannot retract those. There is no request to hang an alarm on, so the
 * state used to exist only as a console meter — visible to whoever opened the page, and to nobody else.
 *
 * THE HEAVIEST TEST HERE IS THE ONE ABOUT SEVERITY, and it is not about severity. `buildActionability`
 * silently DOWNGRADES a warning to `info` unless it carries owner-or-assignee, runbook, impact and
 * recoveryCondition — so an alarm raised carelessly is filed as a note that pages nobody, which is the
 * exact quiet non-alarm this exists to remove. #65 was written twice for that reason.
 */

import { afterEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const AGENT = 'overrunner';
const TOKEN = 'ceiling-overrun-operator';

let context = null;
afterEach(() => { context?.cleanup(); context = null; });

async function boot({ ceilingTokens = 1_000_000 } = {}) {
  context = await createBackendTestContext('ceiling-overrun-', {
    agents: {
      [AGENT]: { name: AGENT, type: 'agent', kind: 'agent', online: true, role: 'coding' },
    },
    env: { API_TOKEN: TOKEN },
  });
  const app = context.app;
  /*
   * Every write carries the operator bearer, because seeding `API_TOKEN` is what puts this context in
   * hard mode — the same posture the real deployment runs in. Without it the setup 401s, which is the
   * gate working, not a test problem.
   */
  const preset = await request(app).post('/api/framework-presets')
    .set('Authorization', `Bearer ${TOKEN}`)
    .send({
    name: 'overrun-preset', framework: 'claude', provider: 'anthropic', model: 'claude-opus-5',
    ceiling: { tokens: ceilingTokens, period: 'monthly' },
  }).expect(200);
  await request(app).put(`/api/agents/${AGENT}/preset`)
    .set('Authorization', `Bearer ${TOKEN}`)
    .send({ presetId: preset.body.preset.id }).expect(200);
  return { app, presetId: preset.body.preset.id };
}

/**
 * Commit tokens against the agent, then lower the ceiling under them.
 *
 * This is the ONLY way an overrun happens under admission control, so it is the only way worth
 * setting one up: a fixture that just wrote a big number would test the sweep against a state the
 * product cannot reach.
 */
async function overcommitThenLower(app, presetId, { commit, lowerTo }) {
  await request(app).post('/api/engagements')
    .set('Authorization', `Bearer ${TOKEN}`)
    .send({
    project: 'p', projectRoomId: '!r:palpo.test', role: 'coding', requester: '@r:palpo.test',
    requestedTokens: commit, ratePerDay: 1000, requestId: `$over-${commit}`, agent: AGENT,
  }).expect(200);
  const list = await request(app).get('/api/engagements').set('Authorization', `Bearer ${TOKEN}`);
  const pending = list.body.engagements.find((e) => e.state === 'pending');
  if (pending) {
    await request(app).post(`/api/engagements/${pending.id}/verdict`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ approve: true, allocatedTokens: commit }).expect(200);
  }
  await request(app).put(`/api/framework-presets/${presetId}`)
    .set('Authorization', `Bearer ${TOKEN}`)
    .send({
    name: 'overrun-preset', framework: 'claude', provider: 'anthropic', model: 'claude-opus-5',
    ceiling: { tokens: lowerTo, period: 'monthly' },
  }).expect(200);
}

const alertsOf = async (app) => (await request(app).get('/api/alerts')
  .set('Authorization', `Bearer ${TOKEN}`)).body;

const overrunAlert = (payload) => (payload.alerts ?? payload ?? [])
  .find((a) => a.alertType === 'agent_ceiling_overrun');

describe('an agent past its ceiling raises an alarm nobody had to ask for', () => {
  test('the sweep finds it, and files it as a WARNING rather than a note', async () => {
    const { app, presetId } = await boot({ ceilingTokens: 2_000_000 });
    await overcommitThenLower(app, presetId, { commit: 1_500_000, lowerTo: 1_000_000 });

    context.internals.sweepCeilingOverrunsForTest();

    const alert = overrunAlert(await alertsOf(app));
    expect(alert).toBeDefined();
    /*
     * `warning`, and this is the assertion the whole file exists for. Miss any one of owner, runbook,
     * impact or recoveryCondition and `buildActionability` files this as `info` — an alarm that pages
     * nobody, indistinguishable from not raising one.
     */
    expect(alert.severity).toBe('warning');
    expect(alert.owner || alert.assignee).toBeTruthy();
    expect(alert.runbook).toBeTruthy();
    expect(alert.impact).toBeTruthy();
    expect(alert.recoveryCondition).toBeTruthy();

    /*
     * The numbers are on the alert, so the operator does not have to go find them — and `detail` comes
     * back as a JSON STRING rather than an object, which is worth pinning here: an assertion that
     * forgot to parse would compare a string against an object and pass vacuously under
     * `toMatchObject` on some shapes.
     */
    expect(JSON.parse(alert.detail)).toMatchObject({
      agent: AGENT,
      ceilingTokens: 1_000_000,
      committedTokens: 1_500_000,
      measuredTokens: null,
      drawnTokens: 1_500_000,
      overByTokens: 500_000,
    });
    expect(alert.sourceAgent).toBe(AGENT);
  });

  test('MEASURED spend over the ceiling raises it too, with nothing committed', async () => {
    /*
     * The case that makes `max(committed, measured)` load-bearing, and the one a mutation test found
     * missing: `drawn = committed` alone passed every other test here, because none of them had the two
     * figures disagree. An agent that was metered above its ceiling with NO engagement committed is
     * over it just the same — and `remainingFor` says so, which is why this alarm has to.
     *
     * The ledger is seeded on disk rather than driven through a sweep: the sweep reads coding-CLI
     * transcripts, and inventing one would be testing the parser instead of the alarm. `cacheRead` is
     * deliberately large and deliberately excluded — CEILING_KINDS is input+output+cacheWrite, so a
     * ledger that summed all four would report this agent 9M over instead of 200k.
     */
    const month = new Date().toISOString().slice(0, 7);
    context = await createBackendTestContext('ceiling-overrun-metered-', {
      agents: { [AGENT]: { name: AGENT, type: 'agent', kind: 'agent', online: true } },
      env: { API_TOKEN: TOKEN },
      rawRuntimeFiles: {
        'data/usage-ledger.json': JSON.stringify({
          agents: {
            [AGENT]: {
              sessions: {}, retired: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
              retiredSessions: 0, regressions: 0, framework: 'claude',
              periods: {
                daily: {},
                monthly: {
                  [month]: { input: 900_000, output: 250_000, cacheWrite: 50_000, cacheRead: 9_000_000 },
                },
              },
            },
          },
          updatedAt: Date.now(),
        }),
      },
    });
    const app = context.app;
    const preset = await request(app).post('/api/framework-presets')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({
        name: 'metered-preset', framework: 'claude', provider: 'anthropic', model: 'claude-opus-5',
        ceiling: { tokens: 1_000_000, period: 'monthly' },
      }).expect(200);
    await request(app).put(`/api/agents/${AGENT}/preset`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ presetId: preset.body.preset.id }).expect(200);

    context.internals.sweepCeilingOverrunsForTest();

    const alert = overrunAlert(await alertsOf(app));
    expect(alert).toBeDefined();
    expect(JSON.parse(alert.detail)).toMatchObject({
      committedTokens: 0,
      measuredTokens: 1_200_000,
      drawnTokens: 1_200_000,
      overByTokens: 200_000,
    });
  });

  test('an agent inside its ceiling raises nothing', async () => {
    const { app, presetId } = await boot({ ceilingTokens: 2_000_000 });
    await overcommitThenLower(app, presetId, { commit: 500_000, lowerTo: 1_000_000 });

    context.internals.sweepCeilingOverrunsForTest();
    expect(overrunAlert(await alertsOf(app))).toBeUndefined();
  });

  test('exactly ON the ceiling is not over it', async () => {
    /*
     * The boundary, because `>=` here would page an operator whose configuration is exactly right —
     * and an alarm that fires on a correct state is one an operator learns to close without reading.
     */
    const { app, presetId } = await boot({ ceilingTokens: 2_000_000 });
    await overcommitThenLower(app, presetId, { commit: 1_000_000, lowerTo: 1_000_000 });

    context.internals.sweepCeilingOverrunsForTest();
    expect(overrunAlert(await alertsOf(app))).toBeUndefined();
  });

  test('raising the ceiling back resolves it, without an operator closing anything', async () => {
    const { app, presetId } = await boot({ ceilingTokens: 2_000_000 });
    await overcommitThenLower(app, presetId, { commit: 1_500_000, lowerTo: 1_000_000 });
    context.internals.sweepCeilingOverrunsForTest();
    expect(overrunAlert(await alertsOf(app)).status).not.toBe('resolved');

    await request(app).put(`/api/framework-presets/${presetId}`)
    .set('Authorization', `Bearer ${TOKEN}`)
    .send({
      name: 'overrun-preset', framework: 'claude', provider: 'anthropic', model: 'claude-opus-5',
      ceiling: { tokens: 3_000_000, period: 'monthly' },
    }).expect(200);
    context.internals.sweepCeilingOverrunsForTest();

    /*
     * An alert that survives its own fix trains an operator to ignore alerts, which costs more than
     * this alert is worth. Same rule the side-budget alarm follows.
     */
    expect(overrunAlert(await alertsOf(app)).status).toBe('resolved');
  });

  test('an agent with no ceiling is skipped, not reported as over', async () => {
    /*
     * No ceiling is UNKNOWN, not zero. An agent lending nothing declared cannot be past a limit that
     * does not exist, and reporting one would put a number on the page that nobody chose.
     */
    context = await createBackendTestContext('ceiling-overrun-none-', {
      agents: { [AGENT]: { name: AGENT, type: 'agent', kind: 'agent', online: true } },
      env: { API_TOKEN: TOKEN },
    });
    context.internals.sweepCeilingOverrunsForTest();
    expect(overrunAlert(await alertsOf(context.app))).toBeUndefined();
  });

  test('one alert per agent, however many times the sweep runs', async () => {
    const { app, presetId } = await boot({ ceilingTokens: 2_000_000 });
    await overcommitThenLower(app, presetId, { commit: 1_500_000, lowerTo: 1_000_000 });

    context.internals.sweepCeilingOverrunsForTest();
    context.internals.sweepCeilingOverrunsForTest();
    context.internals.sweepCeilingOverrunsForTest();

    const payload = await alertsOf(app);
    const all = (payload.alerts ?? payload ?? []).filter((a) => a.alertType === 'agent_ceiling_overrun');
    expect(all).toHaveLength(1);
    // The repeat count rides ON the alert, so an hourly sweep does not bury it under itself.
    expect(all[0].occurrences).toBeGreaterThan(1);
  });
});
