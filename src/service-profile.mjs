import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// The Matrix bridge is optional everywhere else in HAFleet — install-full.sh
// gates it behind --with-bridge, and it fail-closes without Matrix credentials.
// Requiring it here meant the supervised-services path (the only one that works
// on macOS, where there is no systemd) could not run a Matrix-free install at
// all: the bridge crash-looped and took the profile's health with it.
const CORE_SERVICES = Object.freeze(['backend', 'dashboard', 'relay']);
const OPTIONAL_SERVICES = Object.freeze(['bridge']);
const KNOWN_SERVICES = Object.freeze([...CORE_SERVICES, ...OPTIONAL_SERVICES]);
// 'record' probes a component's own health record (src/health-record.mjs) for
// freshness. It exists because 'process' is nearly meaningless for the bridge and
// relay: they expose no port, so the probe could only assert "PID 1 is alive",
// which reported a crash-looping bridge as healthy on a real fleet host.
const HEALTH_TYPES = new Set(['process', 'tcp', 'http', 'record']);
const HEALTH_RECORD_COMPONENTS = new Set(['bridge', 'relay']);

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be a non-empty control-character-free string`);
  }
  return value.trim();
}

function validatePort(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${label} must be an integer from 1 to 65535`);
  }
  return value;
}

function validateHealth(raw, serviceName) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${serviceName}.health must be an object`);
  }
  const type = requireText(raw.type, `${serviceName}.health.type`);
  if (!HEALTH_TYPES.has(type)) throw new Error(`${serviceName}.health.type is unsupported`);
  const timeoutMs = raw.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 4000) {
    throw new Error(`${serviceName}.health.timeoutMs must be between 100 and 4000`);
  }
  const health = { type, timeoutMs };
  if (type === 'record') {
    health.component = requireText(raw.component, `${serviceName}.health.component`);
    if (!HEALTH_RECORD_COMPONENTS.has(health.component)) {
      throw new Error(`${serviceName}.health.component must be one of: ${[...HEALTH_RECORD_COMPONENTS].join(', ')}`);
    }
    // Records are rewritten on a cadence measured in tens of seconds, so the
    // staleness window is deliberately far wider than timeoutMs (a socket
    // deadline). Floor of 5s keeps it above any plausible write jitter.
    const maxAgeMs = raw.maxAgeMs;
    if (!Number.isInteger(maxAgeMs) || maxAgeMs < 5000 || maxAgeMs > 600000) {
      throw new Error(`${serviceName}.health.maxAgeMs must be an integer from 5000 to 600000`);
    }
    health.maxAgeMs = maxAgeMs;
    return health;
  }
  if (type !== 'process') {
    health.host = requireText(raw.host, `${serviceName}.health.host`);
    health.defaultPort = validatePort(raw.defaultPort, `${serviceName}.health.defaultPort`);
    if (raw.portEnv !== undefined) {
      const portEnv = requireText(raw.portEnv, `${serviceName}.health.portEnv`);
      if (!/^[A-Z][A-Z0-9_]*$/.test(portEnv)) throw new Error(`${serviceName}.health.portEnv is invalid`);
      health.portEnv = portEnv;
    }
  }
  if (type === 'http') {
    health.path = requireText(raw.path, `${serviceName}.health.path`);
    if (!health.path.startsWith('/') || health.path.startsWith('//')) {
      throw new Error(`${serviceName}.health.path must be an absolute URL path`);
    }
  }
  return health;
}

function validateCommand(raw, serviceName, repoRoot) {
  if (!Array.isArray(raw) || raw.length < 2) {
    throw new Error(`${serviceName}.command must be an executable and script argument array`);
  }
  const command = raw.map((value, index) => requireText(value, `${serviceName}.command[${index}]`));
  if (command[0] !== 'node') throw new Error(`${serviceName}.command executable must be node`);
  const scriptPath = path.resolve(repoRoot, command[1]);
  if (!isInside(repoRoot, scriptPath)) throw new Error(`${serviceName} script is outside repository`);
  let stat;
  try {
    stat = statSync(scriptPath);
  } catch {
    throw new Error(`${serviceName} script does not exist`);
  }
  if (!stat.isFile()) throw new Error(`${serviceName} script must be a regular file`);
  return command;
}

function validateEnv(raw, serviceName) {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${serviceName}.env must be an object`);
  const env = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`${serviceName}.env key is invalid`);
    env[name] = requireText(value, `${serviceName}.env.${name}`);
  }
  return env;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function topologicalOrder(services) {
  const byName = new Map(services.map((service) => [service.name, service]));
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  function visit(name) {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`service dependency cycle includes ${name}`);
    visiting.add(name);
    const service = byName.get(name);
    for (const dependency of service.dependsOn) visit(dependency);
    visiting.delete(name);
    visited.add(name);
    ordered.push(service);
  }
  // Walk the services actually declared, not a fixed list: an omitted optional
  // service would otherwise be looked up and dereferenced as undefined.
  for (const service of services) visit(service.name);
  return ordered;
}

export function loadServiceProfile({ profilePath, repoRoot }) {
  const root = path.resolve(requireText(repoRoot, 'repoRoot'));
  const resolvedProfile = path.resolve(requireText(profilePath, 'profilePath'));
  if (!isInside(root, resolvedProfile)) throw new Error('profile path is outside repository');
  let raw;
  try {
    raw = JSON.parse(readFileSync(resolvedProfile, 'utf8'));
  } catch (error) {
    throw new Error(`failed to read service profile: ${error.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('service profile must be an object');
  const name = requireText(raw.name, 'profile.name');
  if (name !== 'services-local') throw new Error('profile.name must be services-local');
  if (!Array.isArray(raw.services)) throw new Error('profile.services must be an array');

  const seen = new Set();
  const services = raw.services.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('service entry must be an object');
    const serviceName = requireText(entry.name, 'service.name');
    if (!KNOWN_SERVICES.includes(serviceName)) throw new Error(`unknown service ${serviceName}`);
    if (seen.has(serviceName)) throw new Error(`duplicate service ${serviceName}`);
    seen.add(serviceName);
    if (!Array.isArray(entry.dependsOn)) throw new Error(`${serviceName}.dependsOn must be an array`);
    const dependsOn = entry.dependsOn.map((dependency) => requireText(dependency, `${serviceName}.dependsOn`));
    return {
      name: serviceName,
      command: validateCommand(entry.command, serviceName, root),
      dependsOn,
      env: validateEnv(entry.env, serviceName),
      health: validateHealth(entry.health, serviceName),
    };
  });

  const missingCore = CORE_SERVICES.filter((service) => !seen.has(service));
  if (missingCore.length > 0) {
    throw new Error(
      `profile must define the core services: ${CORE_SERVICES.join(', ')} (missing: ${missingCore.join(', ')})`,
    );
  }
  for (const service of services) {
    for (const dependency of service.dependsOn) {
      if (!seen.has(dependency)) throw new Error(`${service.name} has unknown dependency ${dependency}`);
      if (dependency === service.name) throw new Error(`${service.name} cannot depend on itself`);
    }
  }
  return deepFreeze({ name, services: topologicalOrder(services) });
}
