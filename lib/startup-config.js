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
