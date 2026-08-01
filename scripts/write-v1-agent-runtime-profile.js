#!/usr/bin/env node
import path from 'path';
import { readV1AgentManifest } from '../lib/agent-home-v1.js';

function parseArgs(argv) {
  const args = {
    workdir: '',
    webUrl: '',
    clearPrimary: false,
    clearSupervisor: false,
    primaryFramework: '',
    primaryProvider: '',
    primaryModel: '',
    primaryReasoning: '',
    primaryExtraArgs: '',
    supervisorFramework: '',
    supervisorProvider: '',
    supervisorModel: '',
    supervisorReasoning: '',
    supervisorExtraArgs: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--workdir' && argv[i + 1]) {
      args.workdir = argv[++i];
      continue;
    }
    if (token === '--web-url' && argv[i + 1]) {
      args.webUrl = argv[++i];
      continue;
    }
    if (token === '--clear-primary') {
      args.clearPrimary = true;
      continue;
    }
    if (token === '--clear-supervisor') {
      args.clearSupervisor = true;
      continue;
    }
    if (token === '--primary-framework' && argv[i + 1]) {
      args.primaryFramework = argv[++i];
      continue;
    }
    if (token === '--primary-provider' && argv[i + 1]) {
      args.primaryProvider = argv[++i];
      continue;
    }
    if (token === '--primary-model' && argv[i + 1]) {
      args.primaryModel = argv[++i];
      continue;
    }
    if (token === '--primary-reasoning' && argv[i + 1]) {
      args.primaryReasoning = argv[++i];
      continue;
    }
    if (token === '--primary-extra-args' && argv[i + 1]) {
      args.primaryExtraArgs = argv[++i];
      continue;
    }
    if (token === '--supervisor-framework' && argv[i + 1]) {
      args.supervisorFramework = argv[++i];
      continue;
    }
    if (token === '--supervisor-provider' && argv[i + 1]) {
      args.supervisorProvider = argv[++i];
      continue;
    }
    if (token === '--supervisor-model' && argv[i + 1]) {
      args.supervisorModel = argv[++i];
      continue;
    }
    if (token === '--supervisor-reasoning' && argv[i + 1]) {
      args.supervisorReasoning = argv[++i];
      continue;
    }
    if (token === '--supervisor-extra-args' && argv[i + 1]) {
      args.supervisorExtraArgs = argv[++i];
      continue;
    }
    if (token === '-h' || token === '--help') {
      args.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  console.log(`Usage: write-v1-agent-runtime-profile [options]

Options:
  --workdir <path>                 Agent workdir (default: cwd)
  --web-url <url>                  Override HAFLEET_WEB_URL / HAFLEET_WEB_PORT resolution
  --clear-primary                  Remove runtimeProfile.primary
  --clear-supervisor               Remove runtimeProfile.supervisor
  --primary-framework <value>
  --primary-provider <value>
  --primary-model <value>
  --primary-reasoning <value>
  --primary-extra-args <value>
  --supervisor-framework <value>
  --supervisor-provider <value>
  --supervisor-model <value>
  --supervisor-reasoning <value>
  --supervisor-extra-args <value>
`);
}

function normalizeText(value, maxLen = 4000) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

function normalizeRole(role) {
  if (role === null) return null;
  if (!role || typeof role !== 'object') return null;
  const framework = normalizeText(role.framework, 32);
  const provider = normalizeText(role.provider, 64);
  const model = normalizeText(role.model, 256);
  const reasoning = normalizeText(role.reasoning, 64);
  const extraArgs = normalizeText(role.extraArgs, 4000);
  if (!framework && !provider && !model && !reasoning && !extraArgs) return null;
  return {
    framework: framework || null,
    provider: provider || null,
    model: model || null,
    reasoning: reasoning || null,
    ...(extraArgs ? { extraArgs } : {}),
  };
}

function normalizeRuntimeProfile(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object') return null;
  const primary = normalizeRole(value.primary);
  const supervisor = normalizeRole(value.supervisor);
  if (!primary && !supervisor) return null;
  return {
    primary: primary || null,
    supervisor: supervisor || null,
  };
}

function parsePositiveInt(value, fallback) {
  const n = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function defaultWebBaseUrl(env = process.env) {
  const explicit = String(env.HAFLEET_WEB_URL || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const port = parsePositiveInt(env.HAFLEET_WEB_PORT, 8084);
  return `http://127.0.0.1:${port}`;
}

function resolveWorkdir(raw) {
  return raw ? path.resolve(raw) : process.cwd();
}

function resolveRoleUpdate(args, roleName, existingRole) {
  const prefix = roleName === 'primary' ? 'primary' : 'supervisor';
  const clear = prefix === 'primary' ? args.clearPrimary : args.clearSupervisor;
  if (clear) return null;
  const updates = {
    framework: args[`${prefix}Framework`],
    provider: args[`${prefix}Provider`],
    model: args[`${prefix}Model`],
    reasoning: args[`${prefix}Reasoning`],
    extraArgs: args[`${prefix}ExtraArgs`],
  };
  const hasUpdate = Object.values(updates).some((value) => String(value || '').trim());
  if (!hasUpdate) return normalizeRole(existingRole);
  return normalizeRole({
    ...(existingRole && typeof existingRole === 'object' ? existingRole : {}),
    ...updates,
  });
}

function buildNextRuntimeProfile(manifest, args) {
  const current = (manifest?.runtimeProfile && typeof manifest.runtimeProfile === 'object')
    ? manifest.runtimeProfile
    : {};
  return normalizeRuntimeProfile({
    primary: resolveRoleUpdate(args, 'primary', current.primary),
    supervisor: resolveRoleUpdate(args, 'supervisor', current.supervisor),
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }
  const workdir = resolveWorkdir(args.workdir);
  const manifestPath = path.join(workdir, '..', 'agent.json');
  const manifest = readV1AgentManifest(manifestPath);
  if (!manifest) {
    throw new Error(`v1 agent manifest not found: ${manifestPath}`);
  }
  const runtimeProfile = buildNextRuntimeProfile(manifest, args);
  const webUrl = String(args.webUrl || '').trim().replace(/\/$/, '') || defaultWebBaseUrl(process.env);
  const response = await fetch(`${webUrl}/api/agents/${encodeURIComponent(manifest.name)}/home-metadata`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runtimeProfile }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(`runtimeProfile write failed: ${response.status} ${JSON.stringify(data || { error: 'invalid response' })}`);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    agent: manifest.name,
    manifestPath,
    workdir,
    webUrl,
    runtimeProfile: data?.metadata?.runtimeProfile ?? runtimeProfile,
  }, null, 2)}\n`);
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
