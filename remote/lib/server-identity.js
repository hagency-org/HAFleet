import os from 'os';

export function normalizeServer(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function resolveLocalServerId(env = process.env, hostname = os.hostname()) {
  return normalizeServer(env?.HAFLEET_SERVER) || normalizeServer(hostname) || 'local';
}

export function localServerAliases(localServerId = resolveLocalServerId(), options = {}) {
  const includeLegacyLocal = options.includeLegacyLocal !== false;
  const hostname = options.hostname === undefined ? os.hostname() : options.hostname;
  const aliases = new Set();
  if (includeLegacyLocal) aliases.add('local');
  for (const value of [localServerId, hostname]) {
    const normalized = normalizeServer(value);
    if (normalized) aliases.add(normalized);
  }
  return aliases;
}

export function isLocalAgentServer(serverId, localServerId = resolveLocalServerId(), options = {}) {
  const normalized = normalizeServer(serverId);
  if (!normalized) return true;
  return localServerAliases(localServerId, options).has(normalized);
}

export function serversEquivalent(left, right, options = {}) {
  const normalizedLeft = normalizeServer(left);
  const normalizedRight = normalizeServer(right);
  if (!normalizedLeft && !normalizedRight) return true;
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  const localServerId = options.localServerId || resolveLocalServerId(options.env || process.env, options.hostname);
  const aliases = localServerAliases(localServerId, options);
  return aliases.has(normalizedLeft) && aliases.has(normalizedRight);
}
