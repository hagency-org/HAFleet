#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRuntimeDir } from './lib/runtime-dir-guard.js';
import { enforceStartupConfig } from './lib/startup-config.js';
import { getProcessStartIdentity } from './src/process-identity.mjs';
import { writePushRelayHealthRecord } from './src/health-record.mjs';

const requestedMode = (process.env.PUSH_RELAY_MODE || '').trim().toLowerCase();
if (!requestedMode) {
  process.env.PUSH_RELAY_MODE = 'local';
} else if (requestedMode !== 'local') {
  console.error(`[push-relay] FATAL: local entrypoint requires PUSH_RELAY_MODE=local, got ${process.env.PUSH_RELAY_MODE}`);
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.dirname(__filename);
const RUNTIME_ROOT = (() => {
  const raw = String(process.env.HAFLEET_RUNTIME_DIR || '').trim();
  return raw ? path.resolve(raw) : REPO_ROOT;
})();
assertRuntimeDir(RUNTIME_ROOT);

enforceStartupConfig({
  serviceName: 'Agent Chat push relay',
});

// Task 8: standalone cross-component doctor. This entrypoint owns runtime-root
// resolution and the on-disk business-health record (data/health/push-relay.json);
// lib/push-relay-core.js only tracks the in-memory snapshot via getRelayHealthSnapshot().
// The write runs on its own timer independent of core's internal retry/backoff
// state, so a fresh generatedAt always proves this process is alive even while the
// snapshot's own lastSuccessful* fields honestly stay null/stale if it isn't.
function resolveHealthWriteIntervalMs(env = process.env) {
  const raw = Number(env.PUSH_RELAY_HEALTH_WRITE_INTERVAL_MS || 20000);
  const ms = Number.isFinite(raw) ? raw : 20000;
  return Math.max(5000, ms);
}

const relayStartedAtMs = Date.now();
const relayProcessStartIdentity = getProcessStartIdentity(process.pid);

const core = await import('./lib/push-relay-core.js');

function writeRelayHealthRecordNow() {
  try {
    const snapshot = typeof core.getRelayHealthSnapshot === 'function' ? core.getRelayHealthSnapshot() : {};
    writePushRelayHealthRecord(RUNTIME_ROOT, {
      pid: process.pid,
      startedAt: relayStartedAtMs,
      processStartIdentity: relayProcessStartIdentity,
      lastSuccessfulBackendContactAt: snapshot.lastSuccessfulBackendContactAtMs ?? null,
      lastSuccessfulOutboundDeliveryAt: snapshot.lastSuccessfulOutboundDeliveryAtMs ?? null,
      lastErrorCode: snapshot.lastErrorCode ?? null,
    });
  } catch (e) {
    console.error(`[push-relay] failed to write health record: ${e?.message || e}`);
  }
}

if (typeof core.main === 'function') {
  if (typeof core.installPushRelayProcessHandlers === 'function') {
    core.installPushRelayProcessHandlers();
  }
  writeRelayHealthRecordNow();
  setInterval(writeRelayHealthRecordNow, resolveHealthWriteIntervalMs()).unref();
  core.main().catch((e) => {
    console.error(`[push-relay] startup error: ${e?.message || e}`);
    process.exit(1);
  });
}
