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

export function checkAgentToken(agentName, req, { agentTokens } = {}) {
  if (!agentName) return { ok: true };
  const expected = agentTokens.get(agentName);
  // No token configured: sender is not a managed agent (system, human, bridge).
  if (!expected) return { ok: true };
  const provided = (req.headers['x-agent-token'] || '').trim();
  if (!provided) return { ok: false, reason: 'token required but not provided' };
  if (provided !== expected) return { ok: false, reason: 'token mismatch' };
  return { ok: true };
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
  const operatorBearerConfigured = Boolean(normalizeOptionalText(env.API_TOKEN, 512));
  const serverTokenConfigured = Boolean(normalizeOptionalText(env.HAFLEET_SERVER_TOKEN, 512));
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

export function createRequireAgentToken({ agentTokens, agentTokenMode = 'audit', logger = console } = {}) {
  return function requireAgentToken(extractAgent) {
    return (req, res, next) => {
      const agentName = extractAgent(req);
      const result = checkAgentToken(agentName, req, { agentTokens });
      if (!result.ok) {
        const msg = `[auth] agent-token ${result.reason}: agent=${agentName} mode=${agentTokenMode}`;
        if (agentTokenMode === 'audit') { logger.warn(msg); return next(); }
        logger.warn(msg);
        return res.status(403).json({ error: `agent token ${result.reason}` });
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
  const expectedToken = normalizeOptionalText(env.API_TOKEN, 512);
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

  const expectedBearer = normalizeOptionalText(env.API_TOKEN, 512);
  if (expectedBearer) {
    return { ok: false, status: 401, error: 'bearer token or agent token required' };
  }

  // Development/test compatibility when no auth material is configured.
  return { ok: true, mode: 'agent-identity-unverified' };
}

export function authorizeSubconsciousEventIngest(req, {
  env = process.env,
  isLocalRequest = () => false,
} = {}) {
  if (isLocalRequest(req)) {
    return { ok: true, mode: 'local' };
  }
  const expectedToken = normalizeOptionalText(env.HAFLEET_SUBCONSCIOUS_EVENT_TOKEN, 512);
  if (!expectedToken) {
    return {
      ok: false,
      status: 403,
      error: 'subconscious event ingest is local-only unless HAFLEET_SUBCONSCIOUS_EVENT_TOKEN is configured',
      mode: 'local-only',
    };
  }
  const providedToken = getBearerToken(req);
  if (providedToken === expectedToken) {
    return { ok: true, mode: 'token' };
  }
  return {
    ok: false,
    status: 401,
    error: 'invalid subconscious event token',
    mode: 'token-required',
  };
}

export function canAccessPrivilegedSubconsciousDetail(req, {
  env = process.env,
  isLocalRequest = () => false,
} = {}) {
  return isLocalRequest(req) || hasApiTokenAccess(req, { env });
}

export function createRequireBearer({ env = process.env } = {}) {
  return function requireBearer(req, res, next) {
    const expectedToken = normalizeOptionalText(env.API_TOKEN, 512);
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
  subconsciousEventToken,
  isLocalRequest = () => false,
} = {}) {
  return function apiAuthMiddleware(req, res, next) {
    if (!apiToken) return next();
    if (isLocalRequest(req)) return next();
    const auth = req.headers.authorization;
    const apiPath = typeof req.path === 'string' ? req.path : '';
    if (req.method === 'POST' && apiPath.endsWith('/subconscious/events') && subconsciousEventToken && auth === `Bearer ${subconsciousEventToken}`) {
      return next();
    }
    if (auth === `Bearer ${apiToken}`) return next();
    return res.status(401).json({ error: 'unauthorized' });
  };
}
