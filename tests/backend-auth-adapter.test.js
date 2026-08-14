import { describe, it, expect } from 'vitest';
import {
  agentTokenModeBehavior,
  authorizeAgentCredential,
  buildAgentTokenReadiness,
  buildServerCredentialReadiness,
  checkAgentToken,
  createApiAuthMiddleware,
  createRequireAgentToken,
  createRequireBearer,
  createRequireBridgeSecret,
  getBearerToken,
  getBridgeSecret,
  getRequestAgentName,
  hasApiTokenAccess,
  loadAgentTokensFromHomes,
  resolveAgentTokenMode,
} from '../lib/backend/auth-adapter.js';

/*
 * This module is the whole authentication surface of backend-v2.js. Every export here
 * is wired at backend-v2.js:283-311 and 2497-2527, and between them they decide who
 * may call /api/agents/:name/runtime, /api/servers/heartbeat, /api/tasks and
 * It had no test file at all.
 *
 * What these tests are for, in one sentence each:
 *   - the mode resolver, because an unrecognised mode FAILS OPEN to audit and the
 *     only signal that this happened is `configuredMode`;
 *   - the home-root loader, because it is where a token is bound to an agent name;
 *   - the middleware factories, because `audit` must not reject and `soft` must;
 *   - the three credential checks, because each one answers a different question and
 *     they must not accept each other's secrets.
 *
 * Deliberately NOT asserted here: that a function returns "something". Every case
 * below names the value it must produce and, where a guard exists, arranges the
 * fixture so that deleting the guard changes the answer.
 */

// ── Test doubles ──────────────────────────────────────────────────────
// Express req/res reduced to exactly what this module touches. res records instead
// of writing so a test can distinguish "responded 403" from "called next()".
const req = ({ headers = {}, query, method, path, ...rest } = {}) => ({
  headers, query, method, path, ...rest,
});

function fakeRes() {
  const sent = { status: null, body: null };
  return {
    sent,
    status(code) { sent.status = code; return this; },
    json(body) { sent.body = body; return this; },
  };
}

/** Runs a middleware and reports which of the two exits it took. */
function runMiddleware(mw, request) {
  const res = fakeRes();
  let nextCalls = 0;
  mw(request, res, () => { nextCalls += 1; });
  return { nextCalls, status: res.sent.status, body: res.sent.body };
}

const silentLogger = { log() {}, warn() {}, error() {} };

function recordingLogger() {
  const lines = { log: [], warn: [], error: [] };
  return {
    lines,
    log: (m) => lines.log.push(String(m)),
    warn: (m) => lines.warn.push(String(m)),
    error: (m) => lines.error.push(String(m)),
  };
}

const identityNormalizer = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

// ── resolveAgentTokenMode ─────────────────────────────────────────────
describe('resolveAgentTokenMode', () => {
  it('defaults to audit when nothing is configured', () => {
    // A fleet that has never heard of HAFLEET_AGENT_TOKEN_MODE must keep working:
    // agent tokens were added to a running product, and defaulting to `hard` would
    // have 403'd every un-provisioned agent on upgrade.
    expect(resolveAgentTokenMode({})).toEqual({ mode: 'audit', configuredMode: 'audit' });
  });

  it('recognises hard and soft, and normalises case and padding', () => {
    // An operator writing `Hard` in a systemd unit intends enforcement. Case-folding
    // is the difference between an enforced fleet and one that only logs.
    expect(resolveAgentTokenMode({ HAFLEET_AGENT_TOKEN_MODE: 'hard' }).mode).toBe('hard');
    expect(resolveAgentTokenMode({ HAFLEET_AGENT_TOKEN_MODE: '  HARD  ' }).mode).toBe('hard');
    expect(resolveAgentTokenMode({ HAFLEET_AGENT_TOKEN_MODE: 'Soft' }).mode).toBe('soft');
  });

  it('falls open to audit on an unrecognised mode but PRESERVES what was configured', () => {
    /*
     * The important half is the second one. `enforce` is the word an operator is most
     * likely to reach for, and it silently means audit — nothing is enforced. If
     * `configuredMode` were normalised too, /health would report mode=audit
     * configuredMode=audit and there would be no evidence anywhere that the operator
     * asked for enforcement and did not get it.
     */
    expect(resolveAgentTokenMode({ HAFLEET_AGENT_TOKEN_MODE: 'enforce' }))
      .toEqual({ mode: 'audit', configuredMode: 'enforce' });
    expect(resolveAgentTokenMode({ HAFLEET_AGENT_TOKEN_MODE: 'strict' }).configuredMode).toBe('strict');
    // An empty or blank value is not a typo, so it reports plain audit.
    expect(resolveAgentTokenMode({ HAFLEET_AGENT_TOKEN_MODE: '   ' }))
      .toEqual({ mode: 'audit', configuredMode: 'audit' });
  });
});

describe('agentTokenModeBehavior', () => {
  it('treats ONLY audit as log-only', () => {
    // authFlowHealth (lib/backend/flow-health.js:87) reports degraded when behavior is
    // `enforce-loaded-tokens` and tokens are missing. If `soft` were bucketed as
    // log-only, a fleet that rejects requests would report itself healthy while
    // agents were being 403'd.
    expect(agentTokenModeBehavior('audit')).toBe('log-only');
    expect(agentTokenModeBehavior('soft')).toBe('enforce-loaded-tokens');
    expect(agentTokenModeBehavior('hard')).toBe('enforce-loaded-tokens');
  });
});

// ── loadAgentTokensFromHomes ──────────────────────────────────────────
describe('loadAgentTokensFromHomes', () => {
  /**
   * Builds readdir/readFile doubles over a plain description of the home roots.
   *
   * `entries` is ordered, and the order is load-bearing in several tests below: a
   * decoy that a guard is supposed to reject is listed FIRST, so removing the guard
   * changes what ends up in the map rather than merely adding to it.
   */
  function fakeHomes(roots) {
    const dirs = new Map();   // agentsDir -> [{ name, dir }]
    const files = new Map();  // tokenPath -> contents
    for (const [rootPath, entries] of Object.entries(roots)) {
      const agentsDir = `${rootPath}/agents`;
      dirs.set(agentsDir, entries.map((e) => ({
        name: e.name,
        isDirectory: () => e.dir !== false,
      })));
      for (const e of entries) {
        if (e.token === undefined) continue;
        files.set(`${agentsDir}/${e.name}/state/agent-token`, e.token);
      }
    }
    return {
      readdirSyncImpl: (dir) => {
        if (!dirs.has(dir)) {
          const err = new Error(`ENOENT: ${dir}`);
          err.code = 'ENOENT';
          throw err;
        }
        return dirs.get(dir);
      },
      readFileSyncImpl: (file) => {
        if (!files.has(file)) {
          const err = new Error(`ENOENT: ${file}`);
          err.code = 'ENOENT';
          throw err;
        }
        return files.get(file);
      },
      allAgentHomeRoots: () => Object.keys(roots),
    };
  }

  it('lets the FIRST home root win, so a later root cannot substitute a token', () => {
    /*
     * `if (agentTokens.has(name)) continue` is the guard. Both roots provision an
     * agent called alpha; the first root's token is the real one. Without the guard
     * the second root overwrites it, which is a token-substitution vector: anyone who
     * can create a directory in a lower-precedence home root gets to choose the secret
     * that authenticates an existing agent.
     *
     * The decoy is second because that is the position the guard protects.
     */
    const agentTokens = new Map();
    const loaded = loadAgentTokensFromHomes({
      agentTokens,
      logger: silentLogger,
      ...fakeHomes({
        '/homes/primary': [{ name: 'agent_alpha', token: 'tok-primary\n' }],
        '/homes/secondary': [{ name: 'agent_alpha', token: 'tok-secondary\n' }],
      }),
    });
    expect(agentTokens.get('alpha')).toBe('tok-primary');
    expect(loaded).toBe(1);
  });

  it('ignores entries that are not agent_ DIRECTORIES', () => {
    /*
     * Two guards, both with the decoy first so removing either one changes the map:
     *   - `notagent_beta` would become an agent literally named `t_beta`, because the
     *     loader takes name.slice('agent_'.length) with no re-check.
     *   - `agent_gamma` is a FILE, and a file where a directory is expected is how a
     *     half-written provisioning run looks.
     * Either would register a token under a name no real agent uses, which then counts
     * toward the `loaded` figure and toward failClosedReady.
     */
    const agentTokens = new Map();
    const loaded = loadAgentTokensFromHomes({
      agentTokens,
      logger: silentLogger,
      ...fakeHomes({
        '/homes/only': [
          { name: 'notagent_beta', token: 'tok-beta' },
          { name: 'agent_gamma', dir: false, token: 'tok-gamma' },
          { name: 'agent_alpha', token: 'tok-alpha' },
        ],
      }),
    });
    expect([...agentTokens.keys()]).toEqual(['alpha']);
    expect(agentTokens.has('t_beta')).toBe(false);
    expect(agentTokens.has('gamma')).toBe(false);
    expect(loaded).toBe(1);
  });

  it('keeps scanning later roots when an earlier root has no agents directory', () => {
    // Decoy first: a home root that was never provisioned. Without the outer try/catch
    // its ENOENT would abort the loop and EVERY later root's tokens would be missing —
    // in hard mode that 403s the whole fleet because one home is empty.
    const agentTokens = new Map();
    const loaded = loadAgentTokensFromHomes({
      agentTokens,
      logger: silentLogger,
      allAgentHomeRoots: () => ['/homes/missing', '/homes/good'],
      ...(() => {
        const { readdirSyncImpl, readFileSyncImpl } = fakeHomes({
          '/homes/good': [{ name: 'agent_alpha', token: 'tok-alpha' }],
        });
        return { readdirSyncImpl, readFileSyncImpl };
      })(),
    });
    expect(agentTokens.get('alpha')).toBe('tok-alpha');
    expect(loaded).toBe(1);
  });

  it('also registers the token under the canonical casing from agents.json, counted once', () => {
    /*
     * Home directories are lowercased ids (`agent_myagent`) while agents.json keeps
     * whatever the operator typed (`MyAgent`). requireAgentToken looks the sender up by
     * the canonical name, so without the alias a correctly provisioned agent presents
     * a valid token and is rejected.
     *
     * `loaded` must stay 1: the log line says "loaded N agent token(s)", and counting
     * map entries instead of agents would double-report on every case-mismatched name.
     */
    const agentTokens = new Map();
    const loaded = loadAgentTokensFromHomes({
      agentTokens,
      agents: { MyAgent: {}, Unrelated: {} },
      logger: silentLogger,
      ...fakeHomes({ '/homes/only': [{ name: 'agent_myagent', token: 'tok-1' }] }),
    });
    expect(agentTokens.get('myagent')).toBe('tok-1');
    expect(agentTokens.get('MyAgent')).toBe('tok-1');
    expect(agentTokens.has('Unrelated')).toBe(false);
    expect(loaded).toBe(1);
  });

  it('does not register a blank token file as a token', () => {
    /*
     * A blank agent-token file is a provisioning failure, not a credential. Registering
     * '' would make buildAgentTokenReadiness report the agent as having a token — so
     * failClosedReady would say the fleet is ready to enforce while that agent has no
     * secret it could ever present. The assertion is on `has`, not on `get`, for
     * exactly that reason.
     */
    const agentTokens = new Map();
    const loaded = loadAgentTokensFromHomes({
      agentTokens,
      logger: silentLogger,
      ...fakeHomes({
        '/homes/only': [
          { name: 'agent_blank', token: '   \n' },
          { name: 'agent_real', token: 'tok-real' },
        ],
      }),
    });
    expect(agentTokens.has('blank')).toBe(false);
    expect(agentTokens.get('real')).toBe('tok-real');
    expect(loaded).toBe(1);
  });

  it('says nothing at all when it loaded nothing', () => {
    // `if (loaded > 0)` — an empty deployment must not print a reassuring
    // "loaded 0 agent token(s)" line that reads like tokens are in force.
    const logger = recordingLogger();
    const loaded = loadAgentTokensFromHomes({
      agentTokens: new Map(),
      logger,
      allAgentHomeRoots: () => [],
    });
    expect(loaded).toBe(0);
    expect(logger.lines.log).toEqual([]);
  });
});

// ── checkAgentToken ───────────────────────────────────────────────────
describe('checkAgentToken', () => {
  const tokens = new Map([['alpha', 'tok-alpha'], ['beta', 'tok-beta']]);

  /*
   * These cases are all about the AGENT's credential, and none of their requests carries an
   * `authorization` header — so the operator-bearer path this function also serves cannot reach them,
   * whatever the ambient `process.env` holds. That path is covered in
   * tests/api-operator-bearer-on-agent-routes.test.js, including the case that would break these:
   * an unconfigured API_TOKEN must not make every caller the operator.
   */

  it('allows a request that names no agent', () => {
    // The bridge, the dashboard and the operator all post without an agent identity.
    // A blank name is "not an agent", not "an agent with no token".
    expect(checkAgentToken('', req(), { agentTokens: tokens })).toEqual({ ok: true });
    expect(checkAgentToken(null, req(), { agentTokens: tokens })).toEqual({ ok: true });
  });

  it('allows an agent for which no token was ever provisioned', () => {
    // Documented fail-open (the module comment: "sender is not a managed agent").
    // It is what makes `audit` -> `hard` a gradual rollout rather than a cutover, and
    // it is also why buildAgentTokenReadiness exists — this is the hole it measures.
    expect(checkAgentToken('unprovisioned', req({ headers: {} }), { agentTokens: tokens }))
      .toEqual({ ok: true });
  });

  it('distinguishes a MISSING token from a WRONG one', () => {
    /*
     * The two reasons travel into the 403 body and into the audit log. Collapsing them
     * would leave an operator unable to tell "this agent has not been provisioned yet"
     * from "something is presenting the wrong secret for this agent" — the second is an
     * incident and the first is a chore.
     */
    expect(checkAgentToken('alpha', req({ headers: {} }), { agentTokens: tokens }))
      .toEqual({ ok: false, reason: 'token required but not provided' });
    expect(checkAgentToken('alpha', req({ headers: { 'x-agent-token': '   ' } }), { agentTokens: tokens }))
      .toEqual({ ok: false, reason: 'token required but not provided' });
    expect(checkAgentToken('alpha', req({ headers: { 'x-agent-token': 'nope' } }), { agentTokens: tokens }))
      .toEqual({ ok: false, reason: 'token mismatch' });
  });

  it('will not accept ANOTHER agent\'s valid token', () => {
    // Tokens are per-agent, not a shared fleet secret. If beta's token authenticated as
    // alpha, any provisioned agent could post runtime state, heartbeats and task
    // transitions on behalf of every other agent.
    expect(checkAgentToken('alpha', req({ headers: { 'x-agent-token': 'tok-beta' } }), { agentTokens: tokens }))
      .toEqual({ ok: false, reason: 'token mismatch' });
    expect(checkAgentToken('alpha', req({ headers: { 'x-agent-token': '  tok-alpha  ' } }), { agentTokens: tokens }))
      .toEqual({ ok: true });
  });
});

// ── createRequireAgentToken ───────────────────────────────────────────
describe('createRequireAgentToken', () => {
  const tokens = new Map([['alpha', 'tok-alpha']]);
  const build = (mode, logger = silentLogger) =>
    createRequireAgentToken({ agentTokens: tokens, agentTokenMode: mode, logger })(
      (r) => r.headers['x-agent-name'] || '',
    );

  it('in audit mode LOGS and lets the request through', () => {
    /*
     * audit is the migration mode: tokens are being rolled out across homes and the
     * fleet must keep running while some agents have none and others present a stale
     * one. If audit rejected, enabling the feature would take the fleet down — and the
     * warning line is the only record that it would have.
     */
    const logger = recordingLogger();
    const result = runMiddleware(
      build('audit', logger),
      req({ headers: { 'x-agent-name': 'alpha', 'x-agent-token': 'wrong' } }),
    );
    expect(result.nextCalls).toBe(1);
    expect(result.status).toBeNull();
    expect(logger.lines.warn.join('\n')).toContain('token mismatch');
    expect(logger.lines.warn.join('\n')).toContain('mode=audit');
  });

  it('in SOFT mode rejects — soft is not audit', () => {
    // The case a reader is most likely to get wrong. agentTokenModeBehavior buckets
    // soft with hard, and this is the behaviour that has to match: a fleet configured
    // `soft` believes it is enforcing, and it is.
    const result = runMiddleware(
      build('soft'),
      req({ headers: { 'x-agent-name': 'alpha', 'x-agent-token': 'wrong' } }),
    );
    expect(result.nextCalls).toBe(0);
    expect(result.status).toBe(403);
    expect(result.body.error).toMatch(/mismatch/);
  });

  it('in hard mode rejects, and the two reasons stay distinguishable in the body', () => {
    /*
     * The body is what an agent's operator sees in a failing curl. "you sent no token"
     * and "you sent the wrong token" are different problems — the first is an
     * un-provisioned home, the second is a stale or substituted secret — so the two
     * responses must not read the same.
     *
     * The message text is matched loosely on purpose: it is currently emitted as
     * `agent token ${reason}` where reason already begins with "token", so the string
     * reads "agent token token mismatch". That stutter is a cosmetic defect (see
     * lib/backend/auth-adapter.js:135) and pinning it exactly here would make the test
     * resist the fix. What must not regress is that the two reasons differ.
     */
    const missing = runMiddleware(build('hard'), req({ headers: { 'x-agent-name': 'alpha' } }));
    expect(missing.nextCalls).toBe(0);
    expect(missing.status).toBe(403);
    expect(missing.body.error).toMatch(/required but not provided/);

    const wrong = runMiddleware(build('hard'), req({ headers: { 'x-agent-name': 'alpha', 'x-agent-token': 'nope' } }));
    expect(wrong.body.error).toMatch(/mismatch/);
    expect(wrong.body.error).not.toBe(missing.body.error);
  });

  it('passes a correctly credentialed agent through even in hard mode', () => {
    // Bounds the change: enforcement must not reject the agents it was provisioned for.
    const result = runMiddleware(
      build('hard'),
      req({ headers: { 'x-agent-name': 'alpha', 'x-agent-token': 'tok-alpha' } }),
    );
    expect(result.nextCalls).toBe(1);
    expect(result.status).toBeNull();
  });

  it('uses the extractor it was given, per route', () => {
    // Every call site passes a different extractor (_tokenFromName, _tokenFromTaskAssignee,
    // _tokenFromApprovalRecord). If the factory ignored it and read a fixed header, a
    // task transition would be checked against the caller's self-declared name instead
    // of the assignee's — which is the whole point of the assignee extractor.
    const mw = createRequireAgentToken({ agentTokens: tokens, agentTokenMode: 'hard', logger: silentLogger })(
      (r) => r.body?.assignee || '',
    );
    const denied = runMiddleware(mw, req({ body: { assignee: 'alpha' }, headers: { 'x-agent-name': 'alpha', 'x-agent-token': 'tok-alpha' } }));
    expect(denied.nextCalls).toBe(1);
    const wrong = runMiddleware(mw, req({ body: { assignee: 'alpha' }, headers: { 'x-agent-token': 'tok-beta' } }));
    expect(wrong.status).toBe(403);
  });
});

// ── getBearerToken ────────────────────────────────────────────────────
describe('getBearerToken', () => {
  it('extracts only a Bearer credential, and never the raw header', () => {
    /*
     * Every operator route compares this against API_TOKEN. If a non-Bearer scheme fell
     * through as the raw header value, `Basic <base64>` would be compared as a bearer
     * token — and more importantly a header of exactly `Bearer` with nothing after it
     * must not yield the string 'Bearer', which would then be a guessable secret.
     */
    expect(getBearerToken(req({ headers: { authorization: 'Bearer abc123' } }))).toBe('abc123');
    expect(getBearerToken(req({ headers: { authorization: 'bearer abc123' } }))).toBe('abc123');
    expect(getBearerToken(req({ headers: { authorization: '  Bearer   abc123  ' } }))).toBe('abc123');
    expect(getBearerToken(req({ headers: { authorization: 'Basic abc123' } }))).toBeNull();
    expect(getBearerToken(req({ headers: { authorization: 'Bearer' } }))).toBeNull();
    expect(getBearerToken(req({ headers: { authorization: '' } }))).toBeNull();
    expect(getBearerToken(req({ headers: {} }))).toBeNull();
    expect(getBearerToken(undefined)).toBeNull();
    // A non-string header (Node can hand back an array for a repeated header) must not
    // be coerced into a credential.
    expect(getBearerToken(req({ headers: { authorization: ['Bearer a', 'Bearer b'] } }))).toBeNull();
  });
});

// ── hasApiTokenAccess ─────────────────────────────────────────────────
describe('hasApiTokenAccess', () => {
  it('is FALSE when no API_TOKEN is configured, however plausible the bearer', () => {
    /*
     * The direction matters. authorizeAgentCredential branches on this result, and
     * `serverCredentialReadiness.behavior` is derived from the same env value. If an
     * unconfigured deployment answered true here, every caller would be an operator and
     * `mode: 'bearer'` would appear in the audit trail for anonymous requests.
     */
    expect(hasApiTokenAccess(req({ headers: { authorization: 'Bearer anything' } }), { env: {} })).toBe(false);
    expect(hasApiTokenAccess(req({ headers: {} }), { env: { API_TOKEN: '   ' } })).toBe(false);
  });

  it('matches only the exact configured token', () => {
    const env = { API_TOKEN: 'operator-secret' };
    expect(hasApiTokenAccess(req({ headers: { authorization: 'Bearer operator-secret' } }), { env })).toBe(true);
    expect(hasApiTokenAccess(req({ headers: { authorization: 'Bearer operator-secre' } }), { env })).toBe(false);
    expect(hasApiTokenAccess(req({ headers: { authorization: 'Bearer operator-secret2' } }), { env })).toBe(false);
    expect(hasApiTokenAccess(req({ headers: {} }), { env })).toBe(false);
  });

  it('accepts a token at the full 512-character limit, and rejects a prefix of it', () => {
    /*
     * The limit is real: normalizeOptionalText(env.API_TOKEN, 512) TRUNCATES. At exactly
     * 512 nothing is cut, so the correct token authenticates and no shorter prefix does —
     * which is the property a secret must have.
     *
     * KNOWN DEFECT, not asserted here because it cannot be asserted as correct: above
     * 512 characters the truncation makes the honest client fail and its 512-character
     * prefix succeed. See lib/backend/auth-adapter.js:150 and :226. Reported separately;
     * this case pins the boundary that still behaves.
     */
    const token = 'k'.repeat(512);
    const env = { API_TOKEN: token };
    expect(hasApiTokenAccess(req({ headers: { authorization: `Bearer ${token}` } }), { env })).toBe(true);
    expect(hasApiTokenAccess(req({ headers: { authorization: `Bearer ${'k'.repeat(511)}` } }), { env })).toBe(false);
  });
});

// ── getRequestAgentName ───────────────────────────────────────────────
describe('getRequestAgentName', () => {
  it('prefers ?agent, then x-agent-name, then x-agent', () => {
    /*
     * Three ways to name the same identity, and the winner is the one authorization is
     * checked against. All three are supplied at once so the precedence is observable:
     * if it flipped, a caller could authorize as one agent (via the query) and be
     * attributed as another (via the header), or the reverse.
     */
    expect(getRequestAgentName(
      req({ query: { agent: 'from-query' }, headers: { 'x-agent-name': 'from-name', 'x-agent': 'from-agent' } }),
      { normalizeAgentName: identityNormalizer },
    )).toBe('from-query');
    expect(getRequestAgentName(
      req({ headers: { 'x-agent-name': 'from-name', 'x-agent': 'from-agent' } }),
      { normalizeAgentName: identityNormalizer },
    )).toBe('from-name');
    expect(getRequestAgentName(
      req({ headers: { 'x-agent': 'from-agent' } }),
      { normalizeAgentName: identityNormalizer },
    )).toBe('from-agent');
  });

  it('sends the chosen value THROUGH the normaliser, and normalises absence too', () => {
    // backend-v2.js's normaliser resolves case-insensitively to the canonical stored
    // name. Bypassing it would authorize `MYAGENT` against a token map keyed `myagent`.
    const seen = [];
    const normalize = (v) => { seen.push(v); return `canonical:${v}`; };
    expect(getRequestAgentName(req({ query: { agent: '  Spaced  ' } }), { normalizeAgentName: normalize }))
      .toBe('canonical:  Spaced  ');
    expect(getRequestAgentName(req({ headers: {} }), { normalizeAgentName: normalize })).toBe('canonical:');
    expect(seen).toEqual(['  Spaced  ', '']);
  });
});

// ── authorizeAgentCredential ──────────────────────────────────────────
describe('authorizeAgentCredential', () => {
  const tokens = new Map([['alpha', 'tok-alpha']]);
  const call = (request, name, env = {}) => authorizeAgentCredential(request, name, {
    agentTokens: tokens,
    normalizeAgentName: identityNormalizer,
    env,
  });

  it('refuses a request that names no agent, before looking at any credential', () => {
    // 400 rather than 401: the caller has not asked a question that can be authorized.
    // A valid operator bearer must not paper over a missing identity, because the name
    // is what the route then acts on.
    expect(call(req({ headers: { authorization: 'Bearer op' } }), '', { API_TOKEN: 'op' }))
      .toEqual({ ok: false, status: 400, error: 'agent identity required' });
    expect(call(req(), '   ')).toMatchObject({ status: 400 });
  });

  it('lets the operator bearer win over a WRONG agent token', () => {
    // The operator credential is checked first on purpose. An operator acting on an
    // agent's behalf carries no agent token, and a stale x-agent-token left in a script
    // must not defeat the credential that outranks it.
    expect(call(
      req({ headers: { authorization: 'Bearer op-secret', 'x-agent-token': 'stale' } }),
      'alpha',
      { API_TOKEN: 'op-secret' },
    )).toEqual({ ok: true, mode: 'bearer' });
  });

  it('accepts the agent\'s own token and reports which credential was used', () => {
    // The mode string is what the caller records. `agent-token` and `bearer` are
    // different actors in an audit trail.
    expect(call(req({ headers: { 'x-agent-token': 'tok-alpha' } }), 'alpha'))
      .toEqual({ ok: true, mode: 'agent-token' });
  });

  it('answers 401 for a missing agent token and 403 for a wrong one', () => {
    /*
     * The status is the instruction to the client. 401 means "present a credential", so
     * a provisioned agent retries with its token; 403 means "that credential is wrong",
     * so it stops and an operator is paged. Collapsing them into one code turns a
     * misconfigured agent into an infinite retry loop or a real intrusion into a shrug.
     */
    expect(call(req({ headers: {} }), 'alpha'))
      .toEqual({ ok: false, status: 401, error: 'agent token required' });
    expect(call(req({ headers: { 'x-agent-token': 'wrong' } }), 'alpha'))
      .toEqual({ ok: false, status: 403, error: 'agent token required' });
  });

  it('closes the door on an unprovisioned agent once API_TOKEN is configured', () => {
    // The production shape. `beta` has no token, so there is nothing to check — and
    // because the deployment has auth material configured, "nothing to check" must mean
    // refuse, not allow.
    expect(call(req({ headers: {} }), 'beta', { API_TOKEN: 'op-secret' }))
      .toEqual({ ok: false, status: 401, error: 'bearer token or agent token required' });
  });

  it('falls open ONLY when no auth material exists at all, and says the identity is unverified', () => {
    /*
     * The documented dev/test compatibility path. The mode string is the load-bearing
     * part: a caller that logs `mode` must be able to see that nothing was verified. If
     * this returned `mode: 'agent-token'` the audit trail would claim a check that never
     * happened, and the fall-open would be invisible in production logs.
     */
    expect(call(req({ headers: {} }), 'beta'))
      .toEqual({ ok: true, mode: 'agent-identity-unverified' });
    // ...and it really is gated on absence: adding either credential closes it.
    expect(call(req({ headers: {} }), 'beta', { API_TOKEN: 'op' }).ok).toBe(false);
    expect(call(req({ headers: {} }), 'alpha').ok).toBe(false);
  });
});

// ── createRequireBearer ───────────────────────────────────────────────
describe('createRequireBearer', () => {
  it('is open when API_TOKEN is unset, whether or not the caller presents a bearer', () => {
    /*
     * Documented compatibility: a single-user local install has no token and every
     * requireBearer route must still work. API_TOKEN is the switch that secures the
     * backend, so its absence has to mean open.
     *
     * The second half is the load-bearing one. `expectedToken && ...` short-circuits, and
     * dropping that guard leaves `getBearerToken(req) !== null` — which is FALSE for a
     * request with no header, so an unsecured install still works, but TRUE for a client
     * that sends a token anyway. That client is the normal case: a CLI or dashboard
     * configured with a credential, pointed at a backend that has none, would start
     * getting 401s for presenting a credential the server never asked for.
     */
    const mw = createRequireBearer({ env: {} });
    expect(runMiddleware(mw, req({ headers: {} }))).toMatchObject({ nextCalls: 1, status: null });
    expect(runMiddleware(mw, req({ headers: { authorization: 'Bearer a-token-nobody-asked-for' } })))
      .toMatchObject({ nextCalls: 1, status: null });
  });

  it('rejects a missing or wrong bearer with 401 and does not continue', () => {
    const mw = createRequireBearer({ env: { API_TOKEN: 'op-secret' } });
    for (const headers of [{}, { authorization: 'Bearer nope' }, { authorization: 'Basic op-secret' }]) {
      const result = runMiddleware(mw, req({ headers }));
      expect(result.nextCalls, JSON.stringify(headers)).toBe(0);
      expect(result.status).toBe(401);
      expect(result.body).toEqual({ error: 'bearer token required' });
    }
    expect(runMiddleware(mw, req({ headers: { authorization: 'Bearer op-secret' } })).nextCalls).toBe(1);
  });

  it('reads API_TOKEN FRESH on every request rather than capturing it at construction', () => {
    /*
     * backend-v2.js:2527 builds this once at module load with `{ env: process.env }`,
     * and the test runtime deletes and sets API_TOKEN between cases
     * (tests/helpers/backend-test-runtime.js:95). A captured snapshot would make every
     * one of those cases exercise the wrong auth state — a suite that appears to test a
     * secured backend while running an open one.
     */
    const env = {};
    const mw = createRequireBearer({ env });
    expect(runMiddleware(mw, req({ headers: {} })).nextCalls).toBe(1);
    env.API_TOKEN = 'now-secured';
    expect(runMiddleware(mw, req({ headers: {} })).status).toBe(401);
    expect(runMiddleware(mw, req({ headers: { authorization: 'Bearer now-secured' } })).nextCalls).toBe(1);
    delete env.API_TOKEN;
    expect(runMiddleware(mw, req({ headers: {} })).nextCalls).toBe(1);
  });
});

// ── bridge secret ─────────────────────────────────────────────────────
describe('createRequireBridgeSecret', () => {
  it('treats an unset or blank secret as no boundary', () => {
    expect(getBridgeSecret({})).toBe('');
    expect(getBridgeSecret({ MATRIX_BRIDGE_SECRET: '   ' })).toBe('');
    expect(runMiddleware(createRequireBridgeSecret({ env: {} }), req({ headers: {} })).nextCalls).toBe(1);
  });

  it('requires an exact header match once a secret is configured', () => {
    // The bridge routes accept messages addressed to any agent, so this header is the
    // only thing between an unauthenticated poster and the fleet's inbox.
    const mw = createRequireBridgeSecret({ env: { MATRIX_BRIDGE_SECRET: '  bridge-secret  ' } });
    expect(runMiddleware(mw, req({ headers: { 'x-bridge-secret': 'bridge-secret' } })).nextCalls).toBe(1);
    for (const headers of [{}, { 'x-bridge-secret': '' }, { 'x-bridge-secret': '  bridge-secret  ' }]) {
      const result = runMiddleware(mw, req({ headers }));
      expect(result.nextCalls, JSON.stringify(headers)).toBe(0);
      expect(result.status).toBe(403);
      expect(result.body).toEqual({ error: 'bridge secret required' });
    }
  });

  it('reads the secret fresh on every request', () => {
    // backend-v2.js:284 carries a comment claiming exactly this. Without it, toggling
    // MATRIX_BRIDGE_SECRET between test cases would silently test one state twice.
    const env = {};
    const mw = createRequireBridgeSecret({ env });
    expect(runMiddleware(mw, req({ headers: {} })).nextCalls).toBe(1);
    env.MATRIX_BRIDGE_SECRET = 's';
    expect(runMiddleware(mw, req({ headers: {} })).status).toBe(403);
  });
});

// ── createApiAuthMiddleware ───────────────────────────────────────────
describe('createApiAuthMiddleware', () => {
  const build = (over = {}) => createApiAuthMiddleware({
    apiToken: 'op-secret',
    isLocalRequest: () => false,
    ...over,
  });

  it('is entirely open when no apiToken is configured', () => {
    const mw = build({ apiToken: undefined });
    expect(runMiddleware(mw, req({ method: 'DELETE', path: '/agents/x', headers: {} })).nextCalls).toBe(1);
  });

  it('lets local callers past without a credential', () => {
    // This is the gate mounted on ALL of /api (backend-v2.js:7714). The CLI and the
    // dashboard talk to the backend over loopback with no token.
    const mw = build({ isLocalRequest: () => true });
    expect(runMiddleware(mw, req({ method: 'POST', path: '/agents', headers: { authorization: 'Bearer wrong' } })).nextCalls).toBe(1);
  });

  it('rejects anything else without the exact operator bearer', () => {
    const mw = build();
    expect(runMiddleware(mw, req({ method: 'GET', path: '/agents', headers: { authorization: 'Bearer op-secret' } })).nextCalls).toBe(1);
    for (const headers of [{}, { authorization: 'Bearer op-secre' }, { authorization: 'bearer op-secret' }]) {
      const result = runMiddleware(mw, req({ method: 'GET', path: '/agents', headers }));
      expect(result.nextCalls, JSON.stringify(headers)).toBe(0);
      expect(result.status).toBe(401);
      expect(result.body).toEqual({ error: 'unauthorized' });
    }
  });

});

// ── readiness reporting ───────────────────────────────────────────────
describe('buildAgentTokenReadiness', () => {
  const agents = (names) => Object.fromEntries(names.map((n) => [n, { name: n, type: 'claude' }]));

  it('counts only records the caller recognises as agents', () => {
    /*
     * data/agents.json holds non-agent bookkeeping keys alongside agents, which is why
     * backend-v2.js passes isAgentRecord. The decoy is listed FIRST so dropping the
     * filter changes managedAgentCount from 2 to 3 and adds a phantom name to the
     * missing list — a fleet reported as never ready to fail closed because of a
     * bookkeeping key.
     */
    const readiness = buildAgentTokenReadiness({
      agents: { _meta: { schema: 3 }, alpha: { type: 'claude' }, beta: { type: 'codex' } },
      agentTokens: new Map([['alpha', 't']]),
      isAgentRecord: (record) => typeof record?.type === 'string',
    });
    expect(readiness.managedAgentCount).toBe(2);
    expect(readiness.loadedManagedAgentTokenCount).toBe(1);
    expect(readiness.missingManagedAgentNames).toEqual(['beta']);
  });

  it('reports failClosedReady only when EVERY managed agent has a token', () => {
    /*
     * This is the number an operator reads before switching HAFLEET_AGENT_TOKEN_MODE to
     * hard. A true here with one agent missing its token means that agent is 403'd
     * immediately after the switch — so the flip must be all-or-nothing.
     */
    const partial = buildAgentTokenReadiness({
      agents: agents(['alpha', 'beta']),
      agentTokens: new Map([['alpha', 't']]),
    });
    expect(partial.failClosedReady).toBe(false);
    expect(partial.missingManagedAgentTokenCount).toBe(1);

    const complete = buildAgentTokenReadiness({
      agents: agents(['alpha', 'beta']),
      agentTokens: new Map([['alpha', 't'], ['beta', 't']]),
    });
    expect(complete.failClosedReady).toBe(true);
    expect(complete.missingManagedAgentNames).toEqual([]);
    // A fleet with no agents at all is vacuously ready, not "not ready".
    expect(buildAgentTokenReadiness({ agents: {}, agentTokens: new Map() }).failClosedReady).toBe(true);
  });

  it('caps the missing-name list at 50 and SAYS when it truncated', () => {
    /*
     * /health is polled; an unbounded name list on a large fleet inflates every poll.
     * The flag is the load-bearing half — a truncated list with no flag reads as
     * "exactly 50 agents are missing tokens", and an operator would fix fifty and
     * switch to hard with the rest still unprovisioned. The counts stay exact.
     */
    const fifty = buildAgentTokenReadiness({
      agents: agents(Array.from({ length: 50 }, (_, i) => `a${String(i).padStart(3, '0')}`)),
      agentTokens: new Map(),
    });
    expect(fifty.missingManagedAgentNames).toHaveLength(50);
    expect(fifty.missingManagedAgentNamesTruncated).toBe(false);

    const fiftyOne = buildAgentTokenReadiness({
      agents: agents(Array.from({ length: 51 }, (_, i) => `a${String(i).padStart(3, '0')}`)),
      agentTokens: new Map(),
    });
    expect(fiftyOne.missingManagedAgentNames).toHaveLength(50);
    expect(fiftyOne.missingManagedAgentNamesTruncated).toBe(true);
    expect(fiftyOne.missingManagedAgentTokenCount).toBe(51);
  });

  it('sorts names so the list is stable between polls', () => {
    // A set-ordered list makes /health diffs unreadable and makes any snapshot of it
    // flap between polls for no reason.
    const readiness = buildAgentTokenReadiness({
      agents: agents(['zeta', 'alpha', 'Mid']),
      agentTokens: new Map(),
    });
    expect(readiness.missingManagedAgentNames).toEqual(['alpha', 'Mid', 'zeta']);
  });

  it('carries the mode, the configured mode and the derived behaviour', () => {
    // The pair is how /health surfaces a typo'd mode: mode=audit configuredMode=enforce
    // is the only evidence that enforcement was asked for and is not happening.
    expect(buildAgentTokenReadiness({
      agents: {}, agentTokens: new Map(), agentTokenMode: 'audit', configuredMode: 'enforce',
    })).toMatchObject({ mode: 'audit', configuredMode: 'enforce', behavior: 'log-only' });
    expect(buildAgentTokenReadiness({
      agents: {}, agentTokens: new Map(), agentTokenMode: 'hard', configuredMode: 'hard',
    }).behavior).toBe('enforce-loaded-tokens');
  });
});

describe('buildServerCredentialReadiness', () => {
  it('reports HAFLEET_SERVER_TOKEN as configured but NOT accepted or enforced', () => {
    /*
     * The invariant this module states in its own field names: HAFLEET_SERVER_TOKEN is a
     * FUTURE credential. An operator who sets it and sees `serverTokenConfigured: true`
     * must also see that it buys nothing yet — otherwise they will believe the
     * server-owned routes are protected by it and leave API_TOKEN unset, which is
     * precisely the deployment `behavior: 'server-routes-open'` is warning about.
     */
    const readiness = buildServerCredentialReadiness({ env: { HAFLEET_SERVER_TOKEN: 'srv' } });
    expect(readiness.serverTokenConfigured).toBe(true);
    expect(readiness.serverTokenAccepted).toBe(false);
    expect(readiness.serverTokenEnforced).toBe(false);
    expect(readiness.futureCredential).toBe('HAFLEET_SERVER_TOKEN');
    expect(readiness.behavior).toBe('server-routes-open');
  });

  it('says the server routes are open until API_TOKEN is configured', () => {
    // The two behaviour strings are what the install docs and /health both read.
    expect(buildServerCredentialReadiness({ env: {} }))
      .toMatchObject({ operatorBearerConfigured: false, behavior: 'server-routes-open' });
    expect(buildServerCredentialReadiness({ env: { API_TOKEN: 'op' } }))
      .toMatchObject({ operatorBearerConfigured: true, behavior: 'server-routes-require-api-token' });
    // Blank is not configured — a unit file with `API_TOKEN=` must not report secured.
    expect(buildServerCredentialReadiness({ env: { API_TOKEN: '   ' } }).operatorBearerConfigured).toBe(false);
  });

  it('lists the server-owned routes it is describing', () => {
    /*
     * The route lists are the contract this readiness block is about; a caller reading
     * `behavior: 'server-routes-open'` needs to know WHICH routes are open. The
     * maintenance route is deliberately in the operator list rather than the server
     * one — putting a server in maintenance suppresses its offline alerts, so it must
     * not be self-service.
     */
    const readiness = buildServerCredentialReadiness({ env: {} });
    expect(readiness.serverOwnedRoutes).toContain('POST /api/servers/heartbeat');
    expect(readiness.serverOwnedRoutes).toContain('POST /api/agents/:name/runtime');
    expect(readiness.operatorOwnedRoutes).toEqual(['POST /api/servers/:id/maintenance']);
    expect(readiness.serverOwnedRoutes).not.toContain('POST /api/servers/:id/maintenance');
  });
});
