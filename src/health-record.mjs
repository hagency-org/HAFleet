// Shared business-health record writer for the Matrix bridge and push relay.
//
// Both components run as long-lived processes with no HTTP endpoint of their own,
// so they self-report a small, non-secret health record to disk that the standalone
// doctor (services/standalone-doctor.mjs) can read cross-process. This module owns
// the one atomic-write primitive both writers share, the record shapes, and a
// redaction guard that refuses to persist anything token/secret/password-shaped.
import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Key-name check: reliable, zero false positives against this module's own schema.
const SENSITIVE_KEY_PATTERN = /token|secret|passw|credential|bearer|authoriz|api[-_]?key/i;

// Value-shape checks: intentionally high-confidence-only patterns (specific prefixes,
// JWT's dot-triple structure). The generic "opaque secret" pattern below excludes
// hyphens/underscores/colons so hand-chosen slugs (agent names, room/process
// identifiers) never match — real tokens are unbroken alnum/base64 runs, slugs use
// word separators.
const SENSITIVE_VALUE_PATTERNS = [
  { name: 'bearer-header', re: /^bearer\s+\S+/i },
  { name: 'matrix-access-token', re: /^(syt_|mat_|mct_)/i },
  { name: 'jwt', re: /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/ },
  { name: 'opaque-secret-shape', re: /^(?=.*[0-9])(?=.*[a-zA-Z])[A-Za-z0-9+/=]{32,}$/ },
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Recursively scan a value for forbidden key names and forbidden value shapes. */
export function findSensitiveFields(value, keyPath = '$') {
  const violations = [];
  const visit = (node, nodePath, keyName) => {
    if (typeof keyName === 'string' && SENSITIVE_KEY_PATTERN.test(keyName)) {
      violations.push({ path: nodePath, reason: `key name matches forbidden pattern: ${keyName}` });
      return;
    }
    if (typeof node === 'string') {
      for (const pattern of SENSITIVE_VALUE_PATTERNS) {
        if (pattern.re.test(node)) {
          violations.push({ path: nodePath, reason: `value matches forbidden pattern: ${pattern.name}` });
          break;
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${nodePath}[${index}]`, null));
      return;
    }
    if (isPlainObject(node)) {
      for (const [key, child] of Object.entries(node)) visit(child, `${nodePath}.${key}`, key);
    }
  };
  visit(value, keyPath, null);
  return violations;
}

function assertNoSensitiveFields(record) {
  const violations = findSensitiveFields(record);
  if (violations.length === 0) return;
  // Report only the paths, never the value — the point of this guard is to keep
  // secrets out of the record; echoing one into the thrown error would defeat it.
  const paths = violations.map((violation) => violation.path).join(', ');
  throw new Error(`refusing to write health record: sensitive field detected at ${paths}`);
}

export function healthPaths(runtimeRoot) {
  const dir = path.join(path.resolve(runtimeRoot), 'data', 'health');
  return {
    dir,
    bridgePath: path.join(dir, 'matrix-bridge.json'),
    relayPath: path.join(dir, 'push-relay.json'),
  };
}

/** Atomic (tmp+rename) 0600 JSON write, shared by both health-record writers below. */
export function writeHealthRecordAtomic(filePath, record) {
  assertNoSensitiveFields(record);
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, filePath);
  return record;
}

function isoOrNull(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && value.trim()) return value;
  return null;
}

function textOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeMembershipEntry(entry) {
  return {
    roomId: textOrNull(entry?.roomId),
    group: textOrNull(entry?.group),
    requiredAgent: textOrNull(entry?.requiredAgent),
    botJoined: entry?.botJoined === true,
    agentJoined: entry?.agentJoined === null || entry?.agentJoined === undefined ? null : Boolean(entry.agentJoined),
    joinedAgentNames: Array.isArray(entry?.joinedAgentNames)
      ? entry.joinedAgentNames.filter((name) => typeof name === 'string')
      : [],
  };
}

/**
 * Bridge health record shape. Only ever includes: process identity, coarse
 * timestamps, a room count, and a membership summary (room ids, group/agent
 * names, booleans). Never a token, password, full message body, or bridge secret.
 */
export function buildBridgeHealthRecord({
  pid = null,
  startedAt = null,
  processStartIdentity = null,
  lastSuccessfulSyncAt = null,
  lastSuccessfulBackendDeliveryAt = null,
  lastObservedRateLimitAt = null,
  managedRoomCount = 0,
  requiredMembership = [],
  now = () => new Date(),
} = {}) {
  return {
    schemaVersion: 1,
    component: 'matrix-bridge',
    generatedAt: now().toISOString(),
    process: {
      pid: Number.isInteger(pid) ? pid : null,
      startedAt: isoOrNull(startedAt),
      processStartIdentity: textOrNull(processStartIdentity),
    },
    lastSuccessfulSyncAt: isoOrNull(lastSuccessfulSyncAt),
    lastSuccessfulBackendDeliveryAt: isoOrNull(lastSuccessfulBackendDeliveryAt),
    lastObservedRateLimitAt: isoOrNull(lastObservedRateLimitAt),
    managedRoomCount: Number.isInteger(managedRoomCount) ? managedRoomCount : 0,
    requiredMembership: Array.isArray(requiredMembership) ? requiredMembership.map(normalizeMembershipEntry) : [],
  };
}

/**
 * Relay health record shape. Only ever includes: process identity, coarse
 * timestamps, and a short error code. Never a token, password, or message body.
 */
export function buildPushRelayHealthRecord({
  pid = null,
  startedAt = null,
  processStartIdentity = null,
  lastSuccessfulBackendContactAt = null,
  lastSuccessfulOutboundDeliveryAt = null,
  lastErrorCode = null,
  now = () => new Date(),
} = {}) {
  return {
    schemaVersion: 1,
    component: 'push-relay',
    generatedAt: now().toISOString(),
    process: {
      pid: Number.isInteger(pid) ? pid : null,
      startedAt: isoOrNull(startedAt),
      processStartIdentity: textOrNull(processStartIdentity),
    },
    lastSuccessfulBackendContactAt: isoOrNull(lastSuccessfulBackendContactAt),
    lastSuccessfulOutboundDeliveryAt: isoOrNull(lastSuccessfulOutboundDeliveryAt),
    lastErrorCode: textOrNull(lastErrorCode),
  };
}

export function writeBridgeHealthRecord(runtimeRoot, fields = {}) {
  const record = buildBridgeHealthRecord(fields);
  const { bridgePath } = healthPaths(runtimeRoot);
  return writeHealthRecordAtomic(bridgePath, record);
}

export function writePushRelayHealthRecord(runtimeRoot, fields = {}) {
  const record = buildPushRelayHealthRecord(fields);
  const { relayPath } = healthPaths(runtimeRoot);
  return writeHealthRecordAtomic(relayPath, record);
}
