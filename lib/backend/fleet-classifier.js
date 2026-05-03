function normalizeOptionalText(value, maxLen = 4000) {
  if (value === null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLen) return trimmed.slice(0, maxLen);
  return trimmed;
}

function normalizeServer(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function defaultNormalizeRelayInstanceId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function defaultNormalizeRelayBootTs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function normalizeServerVersion(value) {
  return normalizeOptionalText(value, 128);
}

export function isUnknownServerVersion(version) {
  const normalized = normalizeServerVersion(version);
  return !normalized || normalized === 'unknown-legacy';
}

export function buildFleetServerRow(server, {
  expectedVersion = null,
  now = Date.now(),
  heartbeatTtlMs,
  isServerInMaintenance = () => false,
  normalizeRelayInstanceId = defaultNormalizeRelayInstanceId,
  normalizeRelayBootTs = defaultNormalizeRelayBootTs,
} = {}) {
  const id = normalizeServer(server?.id) || normalizeOptionalText(server?.id, 128) || 'unknown';
  const maintenance = isServerInMaintenance(id, server);
  const heartbeatAt = Number(server?.heartbeatAt) || 0;
  const lastSeen = Number(server?.lastSeen) || 0;
  const online = server?.online === true;
  const version = normalizeServerVersion(server?.version);
  const expected = normalizeServerVersion(expectedVersion);
  const heartbeatAgeMs = heartbeatAt > 0 ? Math.max(0, now - heartbeatAt) : null;
  const stale = !maintenance && heartbeatAt > 0 && heartbeatAgeMs !== null && heartbeatAgeMs > heartbeatTtlMs;
  let versionStatus;
  if (maintenance) versionStatus = 'maintenance';
  else if (!online || heartbeatAt <= 0 || stale) versionStatus = 'offline';
  else if (!expected || isUnknownServerVersion(version)) versionStatus = 'unknown';
  else if (version === expected) versionStatus = 'current';
  else versionStatus = 'outdated';
  const knownVersion = !isUnknownServerVersion(version);
  const versionStale = Boolean(expected && knownVersion && version !== expected && versionStatus !== 'unknown');

  return {
    id,
    online,
    maintenance,
    lastSeen: lastSeen || null,
    heartbeatAt: heartbeatAt || null,
    heartbeatAgeMs,
    updatedAt: Number(server?.updatedAt) || null,
    agentCount: Number(server?.agentCount) || 0,
    agents: Array.isArray(server?.agents) ? server.agents.filter(name => typeof name === 'string') : [],
    sessions: Array.isArray(server?.sessions) ? server.sessions.filter(name => typeof name === 'string') : [],
    sourceIp: server?.sourceIp || null,
    relayInstanceId: normalizeRelayInstanceId(server?.relayInstanceId),
    relayBootTs: normalizeRelayBootTs(server?.relayBootTs) || null,
    version: version || null,
    versionStatus,
    versionStale,
  };
}

export function buildFleetInventory({
  servers = [],
  expectedVersion = null,
  localGitVersion = null,
  now = Date.now(),
  heartbeatTtlMs,
  isServerInMaintenance,
  normalizeRelayInstanceId,
  normalizeRelayBootTs,
} = {}) {
  const expected = normalizeServerVersion(expectedVersion) || normalizeServerVersion(localGitVersion);
  const summary = {
    total: 0,
    current: 0,
    outdated: 0,
    unknown: 0,
    offline: 0,
    maintenance: 0,
  };
  const statusOrder = { current: 0, outdated: 1, unknown: 2, offline: 3, maintenance: 4 };
  const rows = servers
    .map(server => buildFleetServerRow(server, {
      expectedVersion: expected,
      now,
      heartbeatTtlMs,
      isServerInMaintenance,
      normalizeRelayInstanceId,
      normalizeRelayBootTs,
    }))
    .sort((a, b) => {
      const statusDelta = (statusOrder[a.versionStatus] ?? 99) - (statusOrder[b.versionStatus] ?? 99);
      if (statusDelta) return statusDelta;
      return a.id.localeCompare(b.id);
    });
  for (const row of rows) {
    summary.total += 1;
    summary[row.versionStatus] = (summary[row.versionStatus] || 0) + 1;
  }
  return {
    ok: true,
    expectedVersion: expected || null,
    generatedAt: new Date(now).toISOString(),
    summary,
    servers: rows,
  };
}
