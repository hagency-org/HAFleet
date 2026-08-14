/*
 * THE OPERATOR'S BEARER COUNTS ON AN AGENT ROUTE.
 *
 * `requireAgentToken` knew exactly one credential — `x-agent-token` — so under
 * `HAFLEET_AGENT_TOKEN_MODE=hard` the operator was refused on every route it guards, for any agent
 * whose token was loaded. Not a policy: `authorizeAgentCredential` in the same file has always taken
 * the bearer first, so the module held two credential checkers that disagreed about whether the
 * operator exists.
 *
 * Three observed consequences, each a separate reason this is a defect:
 *
 *   - `bin/hafleet-up` documents it against itself: "the launcher sends only the operator bearer, so a
 *     managed agent whose token is already loaded answers 403 here EVERY time and printed 'Registered
 *     online' anyway."
 *   - the dashboard's Save Configuration reaches `PATCH /api/agents/:name` through `server.js`, whose
 *     `backendFetch` attaches the operator bearer and no agent token — so it could not write an
 *     existing agent at all in hard mode.
 *   - `POST /api/alerts/:id/transition` and `GET /api/inbox/:agent/unread-list` had each worked around
 *     it with an inline bearer check. Three copies of a workaround is the guard telling you what it
 *     should have done.
 *
 * Every test here pins BOTH halves: that the operator now gets through, and that the guard still
 * refuses everyone else. The first alone would also pass if agent-token auth had simply stopped
 * working, which is the failure this change could plausibly cause.
 *
 * The second half of the file is the truncation bug that shared the same sites. `normalizeSecret`
 * exists because `normalizeOptionalText(API_TOKEN, 512)` cuts the expected value and not the presented
 * one, locking out any operator with a longer token — and it had been fixed for `hasApiTokenAccess`
 * only, while four other comparisons kept copying the broken form.
 */

import { describe, expect, test, vi, afterEach } from 'vitest';
import request from 'supertest';
import { checkAgentToken, createRequireAgentToken } from '../lib/backend/auth-adapter.js';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const AGENT = 'alpha';
const AGENT_TOKEN = 'tok-alpha-secret';
const OPERATOR = 'operator-bearer-secret';

let context = null;
afterEach(() => { context?.cleanup(); context = null; vi.restoreAllMocks(); });

/**
 * Hard mode with a real agent token loaded. Both are load-bearing: in `audit` mode the guard warns and
 * passes so there is no 403 to fix, and with no token loaded `checkAgentToken` fails open by design.
 */
async function boot(env = {}) {
  context = await createBackendTestContext('operator-bearer-', {
    agents: {
      [AGENT]: {
        name: AGENT, type: 'agent', kind: 'agent', online: true, server: 'local',
        role: 'coding', capability: 'medium',
      },
    },
    agentTokens: { [AGENT]: AGENT_TOKEN },
    env: { HAFLEET_AGENT_TOKEN_MODE: 'hard', API_TOKEN: OPERATOR, ...env },
  });
  /*
   * Asserted, not assumed. If the token had not loaded, every 403 below would be absent for the wrong
   * reason and the file would prove nothing.
   */
  const health = await request(context.app).get('/health');
  expect(health.body.auth.agentTokens).toMatchObject({
    mode: 'hard', loadedManagedAgentTokenCount: 1, failClosedReady: true,
  });
  return context.app;
}

describe('POST /api/agents in hard mode — the launcher and the dashboard case', () => {
  test('the OPERATOR BEARER ALONE is accepted, where it used to be 403 every time', async () => {
    const app = await boot();
    const r = await request(app).post('/api/agents')
      .set('Authorization', `Bearer ${OPERATOR}`)
      .send({ name: AGENT, tmux: 'alpha:0.0' });
    expect(r.status).toBe(200);
    expect(r.body.agent).toMatchObject({ name: AGENT, tmux: 'alpha:0.0' });
  });

  test('no credential is still refused, with the reason unchanged', async () => {
    const app = await boot();
    const r = await request(app).post('/api/agents').send({ name: AGENT });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('agent token required but not provided');
  });

  test('a WRONG bearer is refused, and reported as a token mismatch rather than as a bearer problem', async () => {
    /*
     * The reason names the credential the route is about. A caller presenting a bad bearer to an
     * agent route has failed the agent check — saying "bearer token required" would point them at a
     * guard this route does not have.
     */
    const app = await boot();
    const r = await request(app).post('/api/agents')
      .set('Authorization', 'Bearer not-the-operator')
      .send({ name: AGENT });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('agent token required but not provided');
  });

  test("a wrong AGENT token is refused even when it is the only credential offered", async () => {
    const app = await boot();
    const r = await request(app).post('/api/agents')
      .set('X-Agent-Token', 'wrong')
      .send({ name: AGENT });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('agent token mismatch');
  });

  test("the agent's OWN token still works with no bearer anywhere", async () => {
    const app = await boot();
    const r = await request(app).post('/api/agents')
      .set('X-Agent-Token', AGENT_TOKEN)
      .send({ name: AGENT, tmux: 'alpha:1.0' });
    expect(r.status).toBe(200);
  });

  test('an agent with no token loaded still passes open — humans, the bridge and system callers', async () => {
    /*
     * The reason the fix is a substitution and not a tightening. `checkAgentToken` deliberately fails
     * open for a name it holds no token for, and that path must be untouched or human and bridge
     * registration breaks.
     */
    const app = await boot();
    const r = await request(app).post('/api/agents').send({ name: 'a-human-being', type: 'human' });
    expect(r.status).toBe(200);
  });
});

describe("PATCH /api/agents/:name — the dashboard's Save Configuration", () => {
  test('the operator bearer alone writes an existing tokened agent', async () => {
    const app = await boot();
    const r = await request(app).patch(`/api/agents/${AGENT}`)
      .set('Authorization', `Bearer ${OPERATOR}`)
      .send({ identity: 'parser work' });
    expect(r.status).toBe(200);
    expect(r.body.agent.identity).toBe('parser work');
  });

  test('BOTH FIXES AT ONCE: the operator reaches the route AND may set the gated fields', async () => {
    /*
     * The interaction with the self-declaration gate, which is the reason this had to be fixed rather
     * than noted. That gate made `role`, `capability`, `presetId` and `runtimeProfile`
     * operator-bearer-only; this guard refused the operator bearer on the same route. Between them the
     * four fields were writable by nobody for any agent with a token — a lock, not a boundary.
     */
    const app = await boot();
    const asOperator = await request(app).patch(`/api/agents/${AGENT}`)
      .set('Authorization', `Bearer ${OPERATOR}`)
      .send({ role: 'architect' });
    expect(asOperator.status).toBe(200);
    expect(asOperator.body.agent.role).toBe('architect');

    // And the gate still holds against the agent's own credential.
    const asAgent = await request(app).patch(`/api/agents/${AGENT}`)
      .set('X-Agent-Token', AGENT_TOKEN)
      .send({ role: 'testing' });
    expect(asAgent.status).toBe(200);
    expect(asAgent.body.agent.role).toBe('architect');
  });
});

describe('GET /api/inbox/:agent/unread-list — the workaround that became duplication', () => {
  test('the bearer is accepted by the shared guard, not by an inline copy', async () => {
    const app = await boot();
    const r = await request(app).get(`/api/inbox/${AGENT}/unread-list`)
      .set('Authorization', `Bearer ${OPERATOR}`);
    expect(r.status).toBe(200);
    expect(r.body.agent).toBe(AGENT);
  });

  test('and the agent token still is', async () => {
    const app = await boot();
    const r = await request(app).get(`/api/inbox/${AGENT}/unread-list`)
      .set('X-Agent-Token', AGENT_TOKEN);
    expect(r.status).toBe(200);
  });

  test('with neither, it is refused — the route had no test at all before this one', async () => {
    const app = await boot();
    const r = await request(app).get(`/api/inbox/${AGENT}/unread-list`);
    expect(r.status).toBe(403);
  });
});

describe('a secret is compared whole, never truncated', () => {
  /*
   * `normalizeSecret`'s own comment: a token longer than 512 characters made the expected value shorter
   * than the presented one, so NO credential could match and the operator was locked out — and the
   * 512-character prefix was accepted, capping the effective secret. It was fixed for
   * `hasApiTokenAccess` and left in four other comparisons, including `requireBearer` itself and (as of
   * yesterday) `isOperatorRequest`.
   */
  const LONG = `op-${'x'.repeat(700)}`;

  test('requireBearer accepts a 700-character operator token', async () => {
    const app = await boot({ API_TOKEN: LONG });
    expect((await request(app).get('/api/engagements')
      .set('Authorization', `Bearer ${LONG}`)).status).toBe(200);
  });

  test('and its 512-character prefix is NOT accepted', async () => {
    // The other direction of the same bug, and the one a length cap makes silently true.
    const app = await boot({ API_TOKEN: LONG });
    expect((await request(app).get('/api/engagements')
      .set('Authorization', `Bearer ${LONG.slice(0, 512)}`)).status).toBe(401);
  });

  test('an agent route accepts the long token too, and the gated fields still take', async () => {
    const app = await boot({ API_TOKEN: LONG });
    const r = await request(app).patch(`/api/agents/${AGENT}`)
      .set('Authorization', `Bearer ${LONG}`)
      .send({ role: 'architect' });
    expect(r.status).toBe(200);
    expect(r.body.agent.role).toBe('architect');
  });
});

describe('the substitution is visible', () => {
  const tokens = new Map([[AGENT, AGENT_TOKEN]]);
  const req = (headers = {}) => ({ headers });

  test('checkAgentToken says HOW it authorised, so a caller can tell the two apart', () => {
    expect(checkAgentToken(AGENT, req({ 'x-agent-token': AGENT_TOKEN }), { agentTokens: tokens, env: {} }))
      .toEqual({ ok: true });
    expect(checkAgentToken(AGENT, req({ authorization: `Bearer ${OPERATOR}` }),
      { agentTokens: tokens, env: { API_TOKEN: OPERATOR } }))
      .toEqual({ ok: true, via: 'operator' });
  });

  test('called with NO env — the backend wrapper\'s own shape — it still finds the operator', () => {
    /*
     * `checkAgentToken` deliberately has no `env` default: `hasApiTokenAccess` owns the `process.env`
     * fallback so there is one copy of it. That makes the no-argument call a real path — it is exactly
     * how `backend-v2.js`'s wrapper calls this — and mutation testing found it untested, which is the
     * only reason this case exists.
     */
    const saved = process.env.API_TOKEN;
    process.env.API_TOKEN = OPERATOR;
    try {
      expect(checkAgentToken(AGENT, req({ authorization: `Bearer ${OPERATOR}` }), { agentTokens: tokens }))
        .toEqual({ ok: true, via: 'operator' });
      expect(checkAgentToken(AGENT, req({ authorization: 'Bearer wrong' }), { agentTokens: tokens }))
        .toEqual({ ok: false, reason: 'token required but not provided' });
    } finally {
      if (saved === undefined) delete process.env.API_TOKEN; else process.env.API_TOKEN = saved;
    }
  });

  test('an unconfigured API_TOKEN does NOT turn every caller into the operator', () => {
    /*
     * The branch that would quietly disable agent-token auth altogether. `hasApiTokenAccess` returns
     * false when no operator credential is configured, so hard mode still enforces the agent's token —
     * which is the opposite of `isOperatorRequest`'s posture, deliberately: that one decides which
     * FIELDS a legitimate request may set, this one decides whether the request is legitimate at all.
     */
    expect(checkAgentToken(AGENT, req({ authorization: 'Bearer anything' }),
      { agentTokens: tokens, env: {} }))
      .toEqual({ ok: false, reason: 'token required but not provided' });
  });

  test('requireAgentToken logs the substitution rather than performing it silently', () => {
    const logger = { log: vi.fn(), warn: vi.fn() };
    const guard = createRequireAgentToken({
      agentTokens: tokens, agentTokenMode: 'hard', logger, env: { API_TOKEN: OPERATOR },
    })(() => AGENT);
    const next = vi.fn();
    guard(req({ authorization: `Bearer ${OPERATOR}` }), {}, next);
    expect(next).toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('agent-token supplied by the operator bearer: agent=alpha'),
    );
    // The agent's own call is not narrated: nothing was substituted.
    logger.log.mockClear();
    guard(req({ 'x-agent-token': AGENT_TOKEN }), {}, vi.fn());
    expect(logger.log).not.toHaveBeenCalled();
  });
});
