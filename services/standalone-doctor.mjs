#!/usr/bin/env node
// Standalone cross-component business-health doctor.
//
// hafleet-services.mjs's own `doctor` command is process-level: it only asks "is
// each service's PID alive and passing its configured TCP/HTTP/process probe". That
// says nothing about whether the bridge is actually syncing with Matrix, whether the
// relay is actually delivering to agents, or whether the acceptance room the whole
// feature is meant to unblock is even reachable. This doctor is the business-level
// gate: it reads the bridge/relay self-reported health records (data/health/*.json,
// written by bridge-matrix.js and push-relay.js — see src/health-record.mjs), probes
// Palpo and the backend directly, and reuses the process-level doctor's own result for
// the four-service supervisor check. See services/README.md for the two-layer split.
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { assertRuntimeDir } from '../lib/runtime-dir-guard.js';
import { diagnoseServices } from '../src/local-service-supervisor.mjs';
import { loadServiceProfile } from '../src/service-profile.mjs';
import { healthPaths } from '../src/health-record.mjs';

const cliPath = fileURLToPath(import.meta.url);
const repoRoot = path.dirname(path.dirname(cliPath));

// ── env-tunable, floor-validated freshness thresholds ────────────────────────
function resolveMaxAgeMs(rawValue, defaultMs, floorMs = 5000) {
  const parsed = Number(rawValue);
  const ms = Number.isFinite(parsed) && parsed > 0 ? parsed : defaultMs;
  return Math.max(floorMs, ms);
}

export function resolveBridgeHealthMaxAgeMs(env = process.env) {
  return resolveMaxAgeMs(env.BRIDGE_HEALTH_MAX_AGE_MS, 120000);
}

export function resolveRelayHealthMaxAgeMs(env = process.env) {
  return resolveMaxAgeMs(env.RELAY_HEALTH_MAX_AGE_MS, 90000);
}

// ── check 1: Palpo ────────────────────────────────────────────────────────
async function checkPalpo({ env, fetchImpl }) {
  const homeserver = String(env.MATRIX_HOMESERVER || '').trim();
  if (!homeserver) return { name: 'palpo', ok: false, reason: 'MATRIX_HOMESERVER is not set' };
  const url = `${homeserver.replace(/\/+$/, '')}/_matrix/client/versions`;
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return { name: 'palpo', ok: false, reason: `HTTP ${res.status} from ${url}` };
    const body = await res.json().catch(() => null);
    if (!body || !Array.isArray(body.versions)) {
      return { name: 'palpo', ok: false, reason: `${url} did not return a versions array` };
    }
    return { name: 'palpo', ok: true, reason: null };
  } catch (error) {
    return { name: 'palpo', ok: false, reason: `${url} unreachable: ${error?.message || error}` };
  }
}

// ── check 2 + 8: hafleet backend /health (fetched once, reused by check 8) ──
function resolveBackendBaseUrl(env) {
  const apiBase = String(env.HAFLEET_API || '').trim();
  if (apiBase) return apiBase.replace(/\/+$/, '');
  const portRaw = Number.parseInt(env.HAFLEET_BACKEND_PORT || '8090', 10);
  const port = Number.isFinite(portRaw) && portRaw > 0 ? portRaw : 8090;
  return `http://127.0.0.1:${port}`;
}

async function checkBackend({ env, fetchImpl }) {
  const base = resolveBackendBaseUrl(env);
  const url = `${base}/health`;
  try {
    const res = await fetchImpl(url);
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.ok !== true) {
      return { check: { name: 'backend', ok: false, reason: `HTTP ${res.status} from ${url}` }, body };
    }
    return { check: { name: 'backend', ok: true, reason: null }, body };
  } catch (error) {
    return { check: { name: 'backend', ok: false, reason: `${url} unreachable: ${error?.message || error}` }, body: null };
  }
}

function checkAuthAndTokenIntegrity({ backendHealthBody }) {
  if (!backendHealthBody) {
    return { name: 'authAndTokenIntegrity', ok: false, reason: 'backend unreachable; cannot verify auth mode' };
  }
  const agentTokens = backendHealthBody?.auth?.agentTokens;
  if (!agentTokens) {
    return { name: 'authAndTokenIntegrity', ok: false, reason: 'backend /health did not report auth.agentTokens' };
  }
  if (agentTokens.mode !== 'hard') {
    return { name: 'authAndTokenIntegrity', ok: false, reason: `agent token mode is '${agentTokens.mode}', expected 'hard'` };
  }
  if (agentTokens.failClosedReady !== true) {
    const missingNames = Array.isArray(agentTokens.missingManagedAgentNames) ? agentTokens.missingManagedAgentNames.join(', ') : '';
    const missingCount = agentTokens.missingManagedAgentTokenCount ?? '?';
    return {
      name: 'authAndTokenIntegrity',
      ok: false,
      reason: `${missingCount} managed agent(s) missing tokens${missingNames ? `: ${missingNames}` : ''}`,
    };
  }
  return { name: 'authAndTokenIntegrity', ok: true, reason: null };
}

// ── check 3 + 4: dashboard TCP/HTTP + supervisor four-service status ─────────
// Both derived from one diagnoseServices() call — the process-level doctor already
// implements exactly this probe; re-running it here (rather than duplicating TCP/HTTP
// probing) keeps this doctor's result an honest superset of the process-level one.
function checkDashboard(supervisorStatus) {
  const service = supervisorStatus.services?.find((s) => s.name === 'dashboard');
  if (!service) return { name: 'dashboard', ok: false, reason: 'dashboard not present in service profile' };
  return { name: 'dashboard', ok: service.healthy === true, reason: service.healthy ? null : (service.reason || 'dashboard is not healthy') };
}

function checkSupervisor(supervisorStatus) {
  if (supervisorStatus.ok) return { name: 'supervisor', ok: true, reason: null };
  const failures = Array.isArray(supervisorStatus.failures) ? supervisorStatus.failures : [];
  const reason = failures.length > 0
    ? failures.map((f) => `${f.name}: ${f.cause}`).join('; ')
    : 'supervisor reports not-healthy';
  return { name: 'supervisor', ok: false, reason };
}

// ── check 5 + 6: bridge/relay health-record freshness ────────────────────────
function readHealthRecord(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return { record: null, error: 'missing' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { record: null, error: 'invalid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.generatedAt !== 'string') {
    return { record: null, error: 'missing or invalid generatedAt' };
  }
  return { record: parsed, error: null };
}

function ageMs(isoOrNull) {
  if (typeof isoOrNull !== 'string' || !isoOrNull) return null;
  const ms = Date.now() - new Date(isoOrNull).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// lastSuccessfulSyncAt is a hard, always-required gate: matrix-bot-sdk's /sync
// long-poll runs continuously regardless of message traffic, so its absence or
// staleness is never explained by "the system has just been quiet". Backend
// delivery, by contrast, only happens when there is something to reconcile —
// checked only when non-null so a quiet system with no traffic doesn't false-alarm.
function checkBridgeHealthFreshness({ bridgePath, maxAgeMs }) {
  const { record, error } = readHealthRecord(bridgePath);
  if (!record) return { name: 'bridgeHealthFreshness', ok: false, reason: `bridge health record ${error} (${bridgePath})`, record: null };

  const generatedAgeMs = ageMs(record.generatedAt);
  if (generatedAgeMs === null || generatedAgeMs < 0 || generatedAgeMs > maxAgeMs) {
    return { name: 'bridgeHealthFreshness', ok: false, reason: `bridge health record generatedAt is stale or invalid (age=${generatedAgeMs}ms, max=${maxAgeMs}ms)`, record };
  }
  const syncAgeMs = ageMs(record.lastSuccessfulSyncAt);
  if (syncAgeMs === null || syncAgeMs > maxAgeMs) {
    return {
      name: 'bridgeHealthFreshness', ok: false, record,
      reason: `lastSuccessfulSyncAt is ${syncAgeMs === null ? 'missing' : `stale (age=${syncAgeMs}ms)`} (max=${maxAgeMs}ms)`,
    };
  }
  const deliveryAgeMs = ageMs(record.lastSuccessfulBackendDeliveryAt);
  if (deliveryAgeMs !== null && deliveryAgeMs > maxAgeMs) {
    return { name: 'bridgeHealthFreshness', ok: false, record, reason: `lastSuccessfulBackendDeliveryAt is stale (age=${deliveryAgeMs}ms, max=${maxAgeMs}ms)` };
  }
  return { name: 'bridgeHealthFreshness', ok: true, reason: null, record };
}

// lastSuccessfulBackendContactAt (heartbeat/SSE) is the hard, always-required gate —
// it runs on a fixed timer independent of message volume. lastSuccessfulOutboundDeliveryAt
// only advances when there is a message to deliver, so (as with the bridge above) it is
// checked only when non-null.
function checkRelayHealthFreshness({ relayPath, maxAgeMs }) {
  const { record, error } = readHealthRecord(relayPath);
  if (!record) return { name: 'relayHealthFreshness', ok: false, reason: `relay health record ${error} (${relayPath})`, record: null };

  const generatedAgeMs = ageMs(record.generatedAt);
  if (generatedAgeMs === null || generatedAgeMs < 0 || generatedAgeMs > maxAgeMs) {
    return { name: 'relayHealthFreshness', ok: false, reason: `relay health record generatedAt is stale or invalid (age=${generatedAgeMs}ms, max=${maxAgeMs}ms)`, record };
  }
  const contactAgeMs = ageMs(record.lastSuccessfulBackendContactAt);
  if (contactAgeMs === null || contactAgeMs > maxAgeMs) {
    return {
      name: 'relayHealthFreshness', ok: false, record,
      reason: `lastSuccessfulBackendContactAt is ${contactAgeMs === null ? 'missing' : `stale (age=${contactAgeMs}ms)`} (max=${maxAgeMs}ms)`,
    };
  }
  const deliveryAgeMs = ageMs(record.lastSuccessfulOutboundDeliveryAt);
  if (deliveryAgeMs !== null && deliveryAgeMs > maxAgeMs) {
    return { name: 'relayHealthFreshness', ok: false, record, reason: `lastSuccessfulOutboundDeliveryAt is stale (age=${deliveryAgeMs}ms, max=${maxAgeMs}ms)` };
  }
  return { name: 'relayHealthFreshness', ok: true, reason: null, record };
}

// ── check 7: bridge bot + target agent membership for the acceptance room ────
function checkAcceptanceRoomMembership({ env, bridgeFreshnessResult, allowUnconfiguredRoom }) {
  const roomId = String(env.MATRIX_ACCEPTANCE_ROOM_ID || '').trim();
  if (!roomId) {
    return {
      name: 'acceptanceRoomMembership',
      status: 'not_configured',
      ok: Boolean(allowUnconfiguredRoom),
      reason: allowUnconfiguredRoom
        ? 'MATRIX_ACCEPTANCE_ROOM_ID is not set; bypassed via --allow-unconfigured-room'
        : 'MATRIX_ACCEPTANCE_ROOM_ID is not set; pass --allow-unconfigured-room to bypass before the acceptance room exists',
    };
  }
  if (!bridgeFreshnessResult.record) {
    return { name: 'acceptanceRoomMembership', status: 'fail', ok: false, reason: 'bridge health record unavailable; cannot verify acceptance room membership' };
  }
  if (!bridgeFreshnessResult.ok) {
    return { name: 'acceptanceRoomMembership', status: 'fail', ok: false, reason: 'bridge health record is stale; cannot verify acceptance room membership' };
  }
  const entries = Array.isArray(bridgeFreshnessResult.record.requiredMembership) ? bridgeFreshnessResult.record.requiredMembership : [];
  const entry = entries.find((item) => item?.roomId === roomId);
  if (!entry) {
    return { name: 'acceptanceRoomMembership', status: 'fail', ok: false, reason: `acceptance room ${roomId} not present in bridge health record (bridge may not have joined/trusted it yet)` };
  }
  const requiredAgents = String(env.MATRIX_ACCEPTANCE_AGENTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const joinedNamesLower = new Set([
    ...(Array.isArray(entry.joinedAgentNames) ? entry.joinedAgentNames : []),
    ...(entry.agentJoined && entry.requiredAgent ? [entry.requiredAgent] : []),
  ].map((name) => String(name).toLowerCase()));
  const missingAgents = requiredAgents.filter((agent) => !joinedNamesLower.has(agent.toLowerCase()));

  const problems = [];
  if (!entry.botJoined) problems.push('companion bot is not joined to the acceptance room');
  if (missingAgents.length > 0) problems.push(`managed agent(s) not joined: ${missingAgents.join(', ')}`);
  if (problems.length > 0) {
    return { name: 'acceptanceRoomMembership', status: 'fail', ok: false, reason: problems.join('; ') };
  }
  return { name: 'acceptanceRoomMembership', status: 'ok', ok: true, reason: null };
}

// ── orchestration ─────────────────────────────────────────────────────────
export async function runDoctor(options = {}) {
  const {
    runtimeRoot,
    profile,
    profilePath,
    repoRoot: optionsRepoRoot,
    env = process.env,
    fetchImpl = fetch,
    diagnoseServicesImpl = diagnoseServices,
    allowUnconfiguredRoom = false,
  } = options;
  if (!runtimeRoot) throw new Error('runDoctor requires runtimeRoot');

  const checks = [];

  checks.push(await checkPalpo({ env, fetchImpl }));

  const backendResult = await checkBackend({ env, fetchImpl });
  checks.push(backendResult.check);

  const resolvedProfile = profile || loadServiceProfile({
    profilePath: profilePath || path.join(optionsRepoRoot || repoRoot, 'services', 'services-local.json'),
    repoRoot: optionsRepoRoot || repoRoot,
  });
  const supervisorStatus = await diagnoseServicesImpl({ profile: resolvedProfile, runtimeRoot, env });
  checks.push(checkDashboard(supervisorStatus));
  checks.push(checkSupervisor(supervisorStatus));

  const { bridgePath, relayPath } = healthPaths(runtimeRoot);
  const bridgeFreshness = checkBridgeHealthFreshness({ bridgePath, maxAgeMs: resolveBridgeHealthMaxAgeMs(env) });
  checks.push({ name: bridgeFreshness.name, ok: bridgeFreshness.ok, reason: bridgeFreshness.reason });

  const relayFreshness = checkRelayHealthFreshness({ relayPath, maxAgeMs: resolveRelayHealthMaxAgeMs(env) });
  checks.push({ name: relayFreshness.name, ok: relayFreshness.ok, reason: relayFreshness.reason });

  checks.push(checkAcceptanceRoomMembership({ env, bridgeFreshnessResult: bridgeFreshness, allowUnconfiguredRoom }));

  checks.push(checkAuthAndTokenIntegrity({ backendHealthBody: backendResult.body }));

  return {
    ok: checks.every((c) => c.ok),
    checkedAt: new Date().toISOString(),
    checks,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  let profilePath = null;
  let runtimeRoot = process.env.HAFLEET_RUNTIME_DIR
    ? path.resolve(process.env.HAFLEET_RUNTIME_DIR)
    : repoRoot;
  let json = false;
  let allowUnconfiguredRoom = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') { json = true; continue; }
    if (arg === '--allow-unconfigured-room') { allowUnconfiguredRoom = true; continue; }
    if (arg === '--profile' || arg === '--runtime') {
      if (index + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      const value = argv[index + 1];
      index += 1;
      if (arg === '--profile') profilePath = path.resolve(value);
      else runtimeRoot = path.resolve(value);
      continue;
    }
    throw new Error(`unknown argument ${arg}`);
  }
  assertRuntimeDir(runtimeRoot);
  return {
    profilePath: profilePath || path.join(repoRoot, 'services', 'services-local.json'),
    runtimeRoot,
    json,
    allowUnconfiguredRoom,
  };
}

function output(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  for (const c of result.checks) {
    const statusCol = c.status ? `\t${c.status}` : '';
    process.stdout.write(`${c.ok ? 'ok' : 'FAIL'}\t${c.name}${statusCol}${c.reason ? `\t${c.reason}` : ''}\n`);
  }
  process.stdout.write(`${result.ok ? 'ok' : 'FAIL'}\toverall\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const profile = loadServiceProfile({ profilePath: options.profilePath, repoRoot });
  const result = await runDoctor({
    runtimeRoot: options.runtimeRoot,
    profile,
    env: process.env,
    allowUnconfiguredRoom: options.allowUnconfiguredRoom,
  });
  output(result, options.json);
  if (!result.ok) process.exitCode = 1;
}

const isMainModule = (() => {
  const entry = process.argv[1];
  return Boolean(entry) && path.resolve(entry) === cliPath;
})();

if (isMainModule) {
  main().catch((error) => {
    process.stderr.write(`[standalone-doctor] ${error.message}\n`);
    process.exitCode = 1;
  });
}
