import { readFileSync, readdirSync } from 'fs';
import path from 'path';

function normalizeOptionalText(value, maxLen = 4000) {
  if (value === null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLen) return trimmed.slice(0, maxLen);
  return trimmed;
}

/**
 * A secret, trimmed but NEVER truncated.
 *
 * `normalizeOptionalText(value, 512)` was being used on `API_TOKEN`, and it truncates. That
 * had two effects, both wrong and in opposite directions:
 *
 *   an API_TOKEN longer than 512 chars LOCKED THE OPERATOR OUT of every requireBearer
 *   route, because the expected value was cut to 512 while the presented bearer was not,
 *   so no credential could ever match — verified: a correct 600-char token returns false
 *
 *   and a 512-character PREFIX of the real secret was accepted, so the effective secret was
 *   capped at 512 characters regardless of what the operator configured
 *
 * A length cap belongs on text that gets displayed or logged, not on a credential being
 * compared. Nothing is truncated here; an over-long value is simply an over-long value.
 */
function normalizeSecret(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/**
 * Is an operator credential configured at all?
 *
 * Exported because four call sites were each answering it themselves with
 * `normalizeOptionalText(env.API_TOKEN, 512)` — the truncating form `normalizeSecret` exists to
 * replace. For a boolean the truncation is harmless, which is exactly why it kept getting copied: the
 * pattern looks fine at the site that only tests presence, and the next site copies it for a
 * comparison, where it locks out an operator whose token is longer than 512 characters.
 */
export function operatorBearerConfigured(env = process.env) {
  return Boolean(normalizeSecret(env.API_TOKEN));
}

export function resolveAgentTokenMode(env = process.env) {
  const configuredMode = (env.HAFLEET_AGENT_TOKEN_MODE || 'audit').trim().toLowerCase() || 'audit';
  const mode = configuredMode === 'hard' ? 'hard' : configuredMode === 'soft' ? 'soft' : 'audit';
  return { mode, configuredMode };
}

export function loadAgentTokensFromHomes({
  agentTokens,
  agents = {},
  allAgentHomeRoots = () => [],
  mode = 'audit',
  readFileSyncImpl = readFileSync,
  readdirSyncImpl = readdirSync,
  logger = console,
} = {}) {
  let loaded = 0;
  for (const homeRoot of allAgentHomeRoots()) {
    const agentsDir = path.join(homeRoot, 'agents');
    try {
      for (const entry of readdirSyncImpl(agentsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('agent_')) continue;
        const name = entry.name.slice('agent_'.length);
        if (agentTokens.has(name)) continue; // first root wins
        const tokenPath = path.join(agentsDir, entry.name, 'state', 'agent-token');
        try {
          const token = readFileSyncImpl(tokenPath, 'utf-8').trim();
          if (token) {
            agentTokens.set(name, token);
            // Also store under canonical agents.json name if case differs.
            for (const key of Object.keys(agents)) {
              if (key !== name && key.toLowerCase() === name.toLowerCase()) {
                agentTokens.set(key, token);
              }
            }
            loaded++;
          }
        } catch { /* missing token file - expected for un-provisioned agents */ }
      }
    } catch { /* missing agents dir */ }
  }
  if (loaded > 0) logger.log(`[auth] loaded ${loaded} agent token(s), mode=${mode}`);
  return loaded;
}

/**
 * May this request act as `agentName`?
 *
 * THE OPERATOR'S BEARER COUNTS, and until 2026-08-14 it did not — which was a defect, not a policy.
 * `authorizeAgentCredential` forty lines below has always got this right (`hasApiTokenAccess` first,
 * then the agent token), so the file held two credential checkers that disagreed about whether the
 * operator exists. The consequences were all real and all observed:
 *
 *   - `bin/hafleet-up` says so in its own comment: "the launcher sends only the operator bearer, so a
 *     managed agent whose token is already loaded answers 403 here EVERY time and printed 'Registered
 *     online' anyway". The message was wrong and the outcome was right only because the agent's own
 *     MCP server registered it a moment later.
 *   - the dashboard reaches `PATCH /api/agents/:name` through `server.js`, whose `backendFetch`
 *     attaches the operator bearer and no agent token. Save Configuration therefore could not write
 *     an existing agent at all under `HAFLEET_AGENT_TOKEN_MODE=hard`.
 *   - two routes had already worked around it inline — `POST /api/alerts/:id/transition` and
 *     `GET /api/inbox/:agent/unread-list` both check the bearer themselves before falling back here.
 *     Three copies of a workaround is the guard telling you what it should have done.
 *
 * It grants nothing new. The operator bearer already sets any agent's preset and ceiling
 * (`PUT /api/agents/:name/preset`), decides verdicts, revokes engagements and deletes agents — all
 * `requireBearer`. Refusing it on an agent route was not a boundary, just a guard that knew one
 * credential.
 *
 * WHAT IT DOES COST, STATED. Attribution gets weaker: a route that records "agent X did this" cannot
 * tell from the record whether X or the operator authenticated. `via: 'operator'` is returned so a
 * caller CAN distinguish, and `requireAgentToken` logs the substitution rather than performing it
 * silently — but no audit record consumes the flag yet. An operator who wanted to forge an agent's
 * action could already edit the store directly, so this widens a gap in the log, not in the trust
 * boundary.
 *
 * A CORRECT AGENT TOKEN STILL WINS FIRST, so nothing about an agent's own calls changes — including
 * the two refusal reasons, which are asserted verbatim by tests/backend-auth-adapter.test.js.
 *
 * `env` has NO default here on purpose: `hasApiTokenAccess` owns the `process.env` fallback, and a
 * second copy of it would be two places to change and one of them forgotten. Passing nothing therefore
 * still finds the operator credential — which is how the backend's own wrapper calls this, so it is
 * tested rather than assumed.
 */
export function checkAgentToken(agentName, req, { agentTokens, env } = {}) {
  if (!agentName) return { ok: true };
  const expected = agentTokens.get(agentName);
  // No token configured: sender is not a managed agent (system, human, bridge).
  if (!expected) return { ok: true };
  const provided = (req.headers['x-agent-token'] || '').trim();
  // `expected` is known truthy here (the fail-open return above), so an absent `provided` — which is
  // `''` — cannot match it. No emptiness guard is needed and one would only look like it did something.
  if (provided === expected) return { ok: true };
  if (hasApiTokenAccess(req, { env })) return { ok: true, via: 'operator' };
  if (!provided) return { ok: false, reason: 'token required but not provided' };
  return { ok: false, reason: 'token mismatch' };
}

export function agentTokenModeBehavior(mode) {
  if (mode === 'audit') return 'log-only';
  return 'enforce-loaded-tokens';
}

export function buildAgentTokenReadiness({
  agents = {},
  agentTokens,
  agentTokenMode = 'audit',
  configuredMode = 'audit',
  isAgentRecord = () => true,
} = {}) {
  const managedAgentNames = Object.keys(agents)
    .filter(name => isAgentRecord(agents[name]))
    .sort((a, b) => a.localeCompare(b));
  const loadedManagedAgentNames = managedAgentNames.filter(name => agentTokens.has(name));
  const missingManagedAgentNames = managedAgentNames.filter(name => !agentTokens.has(name));
  const maxNames = 50;
  return {
    mode: agentTokenMode,
    configuredMode,
    behavior: agentTokenModeBehavior(agentTokenMode),
    managedAgentCount: managedAgentNames.length,
    loadedManagedAgentTokenCount: loadedManagedAgentNames.length,
    missingManagedAgentTokenCount: missingManagedAgentNames.length,
    missingManagedAgentNames: missingManagedAgentNames.slice(0, maxNames),
    missingManagedAgentNamesTruncated: missingManagedAgentNames.length > maxNames,
    failClosedReady: missingManagedAgentNames.length === 0,
  };
}

export function buildServerCredentialReadiness({ env = process.env } = {}) {
  const operatorBearerConfigured = Boolean(normalizeSecret(env.API_TOKEN));
  const serverTokenConfigured = Boolean(normalizeSecret(env.HAFLEET_SERVER_TOKEN));
  return {
    boundary: 'compat-api-token',
    behavior: operatorBearerConfigured ? 'server-routes-require-api-token' : 'server-routes-open',
    operatorBearerConfigured,
    serverTokenConfigured,
    serverTokenAccepted: false,
    serverTokenEnforced: false,
    serverOwnedRoutes: [
      'POST /api/servers/heartbeat',
      'POST /api/servers/:id/offline',
      'POST /api/agents/:name/heartbeat',
      'POST /api/agents/:name/runtime',
      'POST /api/runtime/compact',
    ],
    operatorOwnedRoutes: [
      'POST /api/servers/:id/maintenance',
    ],
    relayReadRoutes: [
      'GET /api/stream',
    ],
    futureCredential: 'HAFLEET_SERVER_TOKEN',
  };
}

export function createRequireAgentToken({
  agentTokens, agentTokenMode = 'audit', logger = console, env = process.env,
} = {}) {
  return function requireAgentToken(extractAgent) {
    return (req, res, next) => {
      const agentName = extractAgent(req);
      const result = checkAgentToken(agentName, req, { agentTokens, env });
      /*
       * SAID OUT LOUD. The operator standing in for an agent is legitimate, so this is not a warning —
       * but it is the one thing the request's own record cannot show afterwards, and a substitution
       * nobody can see is how an audit trail starts being wrong in a way nobody notices.
       */
      if (result.via === 'operator') {
        logger.log(`[auth] agent-token supplied by the operator bearer: agent=${agentName}`);
      }
      if (!result.ok) {
        const msg = `[auth] agent-token ${result.reason}: agent=${agentName} mode=${agentTokenMode}`;
        if (agentTokenMode === 'audit') { logger.warn(msg); return next(); }
        logger.warn(msg);
        /*
         * `agent ${reason}`, not `agent token ${reason}`: both reasons already begin with
         * "token", so the longer form produced "agent token token mismatch". Fixed at the
         * join rather than in the reasons, which are asserted verbatim by
         * tests/backend-auth-adapter.test.js:332,340 and read correctly on their own.
         */
        return res.status(403).json({ error: `agent ${result.reason}` });
      }
      next();
    };
  };
}

export function getBearerToken(req) {
  const raw = typeof req?.headers?.authorization === 'string' ? req.headers.authorization.trim() : '';
  if (!raw) return null;
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export function hasApiTokenAccess(req, { env = process.env } = {}) {
  const expectedToken = normalizeSecret(env.API_TOKEN);
  if (!expectedToken) return false;
  return getBearerToken(req) === expectedToken;
}

export function getRequestAgentName(req, { normalizeAgentName } = {}) {
  return normalizeAgentName(
    req?.query?.agent
    || req?.headers?.['x-agent-name']
    || req?.headers?.['x-agent']
    || ''
  );
}

export function authorizeAgentCredential(req, agentName, {
  agentTokens,
  normalizeAgentName,
  env = process.env,
} = {}) {
  const normalized = normalizeAgentName(agentName);
  if (!normalized) return { ok: false, status: 400, error: 'agent identity required' };
  if (hasApiTokenAccess(req, { env })) return { ok: true, mode: 'bearer' };

  const expectedAgentToken = agentTokens.get(normalized);
  const providedAgentToken = (req?.headers?.['x-agent-token'] || '').trim();
  if (expectedAgentToken) {
    if (providedAgentToken === expectedAgentToken) return { ok: true, mode: 'agent-token' };
    return { ok: false, status: providedAgentToken ? 403 : 401, error: 'agent token required' };
  }

  const expectedBearer = normalizeSecret(env.API_TOKEN);
  if (expectedBearer) {
    return { ok: false, status: 401, error: 'bearer token or agent token required' };
  }

  // Development/test compatibility when no auth material is configured.
  return { ok: true, mode: 'agent-identity-unverified' };
}

export function createRequireBearer({ env = process.env } = {}) {
  return function requireBearer(req, res, next) {
    /*
     * `normalizeSecret`, NOT `normalizeOptionalText(..., 512)`. The comment on `normalizeSecret`
     * describes this exact bug and fixed it for `hasApiTokenAccess` only: a token longer than 512
     * characters locks the operator out of every route on this guard, because the expected value is cut
     * and the presented bearer is not. This was the last comparison still doing it.
     */
    const expectedToken = normalizeSecret(env.API_TOKEN);
    if (expectedToken && getBearerToken(req) !== expectedToken) {
      return res.status(401).json({ error: 'bearer token required' });
    }
    next();
  };
}

export function getBridgeSecret(env = process.env) {
  return (env.MATRIX_BRIDGE_SECRET || '').trim();
}

export function createRequireBridgeSecret({ env = process.env } = {}) {
  return function requireBridgeSecret(req, res, next) {
    const secret = getBridgeSecret(env);
    if (secret && req.headers['x-bridge-secret'] !== secret) {
      return res.status(403).json({ error: 'bridge secret required' });
    }
    next();
  };
}

export function createApiAuthMiddleware({
  apiToken,
  isLocalRequest = () => false,
} = {}) {
  return function apiAuthMiddleware(req, res, next) {
    if (!apiToken) return next();
    if (isLocalRequest(req)) return next();
    const auth = req.headers.authorization;
    if (auth === `Bearer ${apiToken}`) return next();
    return res.status(401).json({ error: 'unauthorized' });
  };
}
