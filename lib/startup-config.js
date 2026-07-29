export function isConfiguredEnvValue(value) {
  return typeof value === 'string' ? value.trim().length > 0 : value !== undefined && value !== null;
}

export function collectMissingRequiredEnv(env = process.env, required = []) {
  return required
    .map((item) => (typeof item === 'string' ? { name: item } : item))
    .filter((item) => item?.name && !isConfiguredEnvValue(env?.[item.name]));
}

export function warnMissingOptionalEnv({
  env = process.env,
  logger = console,
  optional = [],
  serviceName = 'service',
} = {}) {
  for (const item of optional) {
    const entry = typeof item === 'string' ? { name: item } : item;
    if (!entry?.name || isConfiguredEnvValue(env?.[entry.name])) continue;
    const suffix = entry.description ? ` ${entry.description}` : '';
    logger.warn(`[WARN] ${serviceName}: optional ${entry.name} is not set.${suffix}`);
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Resolve the TCP bind address for a service.
 *
 * Loopback is the default and must stay that way. The auth boundary's
 * `isLocalRequest()` treats any loopback peer as trusted, which is only sound
 * while the listener is unreachable off-box. Binding wider is therefore an
 * explicit, per-deployment decision.
 *
 * The legitimate case is a container: there the network namespace is the
 * isolation boundary, the process must bind 0.0.0.0 to be reachable through a
 * published port, and the host publishes only 127.0.0.1:PORT.
 *
 * Returns { host, warning } — the caller logs the warning so binding wide is
 * never silent. Invalid values fall back to loopback rather than throwing,
 * because a typo must not turn into a wide bind.
 */
export function resolveBindHost(value, { defaultHost = '127.0.0.1' } = {}) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return { host: defaultHost, warning: null };

  // Hostnames, IPv4, and bare IPv6 only. Reject anything with whitespace or
  // separators that suggests a URL or a list was passed by mistake.
  if (!/^[A-Za-z0-9.:_-]+$/.test(raw)) {
    return {
      host: defaultHost,
      warning: `ignoring malformed bind host '${raw}'; falling back to ${defaultHost}`,
    };
  }

  if (LOOPBACK_HOSTS.has(raw)) return { host: raw, warning: null };

  return {
    host: raw,
    warning: `binding to ${raw} instead of loopback. The loopback trust check treats every `
      + 'loopback peer as local, so this listener must not be reachable from an untrusted '
      + 'network. This is expected inside a container and wrong on a bare host.',
  };
}

export function enforceStartupConfig({
  env = process.env,
  logger = console,
  exit = (code) => process.exit(code),
  serviceName = 'service',
  required = ['API_TOKEN'],
  optional = [],
} = {}) {
  const missing = collectMissingRequiredEnv(env, required);
  if (missing.length > 0) {
    const names = missing.map((item) => item.name).join(', ');
    logger.error(`[FATAL] ${serviceName} cannot start: missing required ${names}.`);
    logger.error('Set API_TOKEN in .env or the systemd EnvironmentFile before starting agentchat.');
    exit(1);
    return false;
  }
  warnMissingOptionalEnv({ env, logger, optional, serviceName });
  return true;
}
