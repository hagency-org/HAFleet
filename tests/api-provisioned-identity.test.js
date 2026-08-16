/*
 * A DISPATCHED AGENT GETS AN IDENTITY ON THE CUSTOMER'S SERVER — ADR-016 decision 4's last clause.
 *
 * `mintAgentIdentity` existed with NO product caller: every reference was a test or the operator's own
 * endpoint, so the function written to give a dispatched agent an account on the customer's homeserver
 * was never reached by dispatching one. The identity appeared anyway during the first live run, through
 * the bridge's own path, which is how a function can look built and be unexercised.
 *
 * IT IS FIRE-AND-FORGET, AND THAT IS THE PROPERTY MOST WORTH PINNING. Minting talks to somebody else's
 * homeserver. A registration that only 200s when a foreign server answers would make every launcher's
 * success depend on that server's mood — and ADR-016 already settles what happens without an identity:
 * the representative can invite and join the agent and the appservice can speak as it, so a failed mint
 * costs an attributable account, not the ability to work.
 */

import { afterEach, describe, expect, test } from 'vitest';
import { createServer } from 'http';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const SIDE = 'palpo.test';
const ROOM = `!proj:${SIDE}`;
const AGENT = 'dispatched';
const TOKEN = 'provisioned-identity-token';

let context = null;
let fake = null;

afterEach(async () => {
  context?.cleanup();
  context = null;
  if (fake) { await new Promise((r) => fake.server.close(r)); fake = null; }
});

/**
 * A homeserver that answers the appservice probe, or refuses it.
 *
 * Minting under appservice is a `whoami?user_id=` probe rather than a registration, so acceptance IS the
 * identity existing. `seen` records the probes, which is how a test can tell "minted" from "nothing was
 * attempted" — two outcomes that look identical from the registration response, because the response
 * never waits for either.
 */
async function fakeHomeserver({ accept = true } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    if (req.url.startsWith('/_matrix/client/v3/account/whoami')) {
      const m = /user_id=([^&]+)/.exec(req.url);
      const claimed = decodeURIComponent(m ? m[1] : '');
      res.writeHead(accept ? 200 : 403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(accept ? { user_id: claimed } : { errcode: 'M_FORBIDDEN' }));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ errcode: 'M_NOT_FOUND' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fake = { server, seen, url: `http://127.0.0.1:${server.address().port}` };
  return fake;
}

async function boot({ hs = null, credential = 'appservice' } = {}) {
  context = await createBackendTestContext('provisioned-identity-', {
    agents: {},
    env: {
      API_TOKEN: TOKEN,
      MATRIX_AGENT_PREFIX: 'ac_',
      // Auto-provisioning is off by default (a pure queue); a plan is what carries the side.
      MATRIX_AGENT_MAX_PER_CELL: '1',
    },
  });
  const app = context.app;
  await request(app).post('/api/project-sides')
    .set('Authorization', `Bearer ${TOKEN}`)
    .send({ server_name: SIDE, api_base_url: hs ? hs.url : 'http://127.0.0.1:1' })
    .expect(200);
  if (credential) {
    await request(app).put(`/api/project-sides/${SIDE}/credential`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({
        credential: credential === 'appservice'
          ? { kind: 'appservice', asToken: 'as-tok', hsToken: 'hs-tok', namespace: '@ac_.*', senderLocalpart: 'hafleet' }
          : { kind: 'registrationToken', registrationToken: 'reg-tok' },
      })
      .expect(200);
  }
  await request(app).put(`/api/project-sides/${SIDE}/allocation`)
    .set('Authorization', `Bearer ${TOKEN}`)
    .send({ allocated_tokens: 5_000_000 })
    .expect(200);
  return app;
}

/** Ask for a role against the side's room, which is what produces a plan carrying `sideId`. */
const plan = (app) => request(app).post('/api/dispatch')
  .set('Authorization', `Bearer ${TOKEN}`)
  .send({ role: 'coding', room: ROOM });

/**
 * Register under the name the PLAN chose, which is what a launcher does.
 *
 * The plan generates it (`mx_<side>_<role>_<tier>_<n>`) and `provisionedSides` is keyed on it, so
 * registering under a name of our own choosing fulfils no plan and carries no side — which is exactly
 * what the first version of these tests did, and why they saw `projectSide: null`.
 */
const registerFulfilling = (app, name) => request(app).post('/api/agents')
  .set('Authorization', `Bearer ${TOKEN}`)
  .send({ name, type: 'agent', kind: 'agent', online: true });

/** The mint is fire-and-forget, so a test has to wait for the effect rather than the response. */
async function waitFor(predicate, { tries = 50, delayMs = 20 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

const alertsOf = async (app) => {
  const r = await request(app).get('/api/alerts').set('Authorization', `Bearer ${TOKEN}`);
  return r.body.alerts ?? r.body ?? [];
};

describe('a provisioned agent is minted on the side it was dispatched to', () => {
  test('registration answers immediately, and the identity is minted after it', async () => {
    const hs = await fakeHomeserver();
    const app = await boot({ hs });

    const planned = await plan(app);
    expect(planned.body.status).toBe('provision');
    expect(planned.body.sideId).toBe(SIDE);
    const name = planned.body.name;
    expect(name).toMatch(/^mx_palpo_test_coding_/);

    const registered = await registerFulfilling(app, name);
    expect(registered.status).toBe(200);
    // The record carries the side from the plan, never from the request body (#60's per-field gate).
    expect(registered.body.agent.projectSide).toBe(SIDE);

    const probed = await waitFor(() => hs.seen.some((u) => u.includes(encodeURIComponent(`@ac_${name}:${SIDE}`))));
    expect(probed).toBe(true);
  });

  test('a REFUSED mint leaves the registration standing, and raises an alarm', async () => {
    /*
     * The half-state this alarm exists for: the agent works — the representative can invite and join it,
     * the appservice can speak as it — while nobody on the customer's side can attribute that work to an
     * account. Silent would mean discovering it when somebody asks who @ac_x is.
     */
    const hs = await fakeHomeserver({ accept: false });
    const app = await boot({ hs });
    const name = (await plan(app)).body.name;

    const registered = await registerFulfilling(app, name);
    expect(registered.status).toBe(200);
    expect(registered.body.agent.projectSide).toBe(SIDE);

    const raised = await waitFor(async () => (await alertsOf(app))
      .some((a) => a.alertType === 'agent_identity_unminted'));
    expect(raised).toBe(true);

    const alert = (await alertsOf(app)).find((a) => a.alertType === 'agent_identity_unminted');
    expect(alert.sourceAgent).toBe(name);
    // Actionable, or `buildActionability` files it as info and it pages nobody.
    expect(alert.severity).toBe('warning');
    expect(alert.owner || alert.assignee).toBeTruthy();
    expect(alert.runbook).toMatch(/matrix-identity/);
    expect(alert.impact).toMatch(/work is not blocked|not blocked/);
    expect(alert.recoveryCondition).toBeTruthy();
    expect(JSON.parse(alert.detail)).toMatchObject({ agent: name, sideId: SIDE });
  });

  test('a side with no credential mints nothing and raises nothing', async () => {
    /*
     * A configuration state the operator is already looking at on the console. A second alarm per
     * registration would bury the one that matters.
     */
    const hs = await fakeHomeserver();
    const app = await boot({ hs, credential: null });
    const name = (await plan(app)).body.name;
    expect((await registerFulfilling(app, name)).status).toBe(200);

    const quiet = await waitFor(async () => (await alertsOf(app))
      .some((a) => a.alertType === 'agent_identity_unminted'), { tries: 8 });
    expect(quiet).toBe(false);
    /*
     * AND NOTHING REACHED THE HOMESERVER — asserted against a real (fake) one rather than a dead port,
     * so the property is measured rather than implied by an unreachable address.
     *
     * A NOTE ON WHAT THIS DOES NOT DO. Deleting the `if (!credential) return` guard in the backend still
     * passes every test here, including this line: `mintAgentIdentity` validates its credential before
     * it fetches, so removing the guard changes nothing observable — one confusing "threw" log line
     * instead of silence. That is an EQUIVALENT MUTANT, not a coverage gap, and the guard stays because
     * it says what the function will not do rather than because a test can feel it. Recorded because a
     * comment claiming a kill that did not happen is worse than an unkilled mutant.
     */
    expect(hs.seen).toEqual([]);
  });

  test('an agent registered with NO plan is not minted anywhere', async () => {
    /*
     * The side comes from the plan, so an agent nobody dispatched has no side — and minting it "somewhere"
     * would be inventing which customer it serves.
     */
    const hs = await fakeHomeserver();
    const app = await boot({ hs });

    const registered = await registerFulfilling(app, 'walkin');
    expect(registered.status).toBe(200);
    expect(registered.body.agent.projectSide).toBeNull();

    const probed = await waitFor(() => hs.seen.length > 0, { tries: 8 });
    expect(probed).toBe(false);
  });
});
