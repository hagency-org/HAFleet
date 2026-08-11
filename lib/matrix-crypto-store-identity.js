import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
} from 'node:fs';
import path from 'node:path';

function normalizeDeviceId(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > 255) throw new Error(`${field} is too long`);
  return normalized;
}

function safeArchiveComponent(value) {
  return String(value || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'unknown';
}

function archiveTimestamp(nowMs) {
  return new Date(nowMs).toISOString().replace(/[^0-9TZ]/g, '');
}

/*
 * Files that mean "this store holds key material worth protecting", as opposed to files
 * matrix-bot-sdk creates as scaffolding before there is anything in them.
 *
 * `bot-sdk.json` is NOT one of them, and that is the whole point of this list. matrix-bot-sdk
 * writes it as `{}` the instant `new RustSdkCryptoStorageProvider(path, 0)` runs — lowdb's
 * FileSync.read() persists its default value — while the `deviceId` inside it is not written
 * until `crypto.prepare()` during `botClient.start()`. Between those two moments the bridge
 * registers every agent's Matrix account, with rate-limit backoff, so the window is seconds to
 * minutes wide and widest on a first deployment.
 *
 * Treating that placeholder as "contains data" made a restart inside the window fatal AND
 * PERMANENT: the store held no keys at all, but reconcile read "files present, no device
 * identity" and refused to start, every time, until someone deleted a directory whose location
 * appears in no runbook. Reproduced across five store shapes.
 *
 * The distinction this restores is the one the fail-closed rule was written for. ADR-008
 * archives a mismatched store because it may hold "old private keys" worth preserving for
 * rollback and forensics. A `{}` placeholder holds nothing, so there is nothing to preserve and
 * nothing to be cautious about — refusing to start protects no one.
 */
const KEY_MATERIAL_FILES = [
  'matrix-sdk-crypto.sqlite3',
  'matrix-sdk-crypto.sqlite3-wal',
  'matrix-sdk-crypto.sqlite3-shm',
  'matrix-sdk-state.sqlite3',
];

/** True when the directory holds something other than empty scaffolding. */
function holdsKeyMaterial(cryptoStorePath) {
  if (!existsSync(cryptoStorePath)) return false;
  let entries;
  try { entries = readdirSync(cryptoStorePath); } catch { return false; }
  return entries.some((name) => {
    if (KEY_MATERIAL_FILES.includes(name)) return true;
    /*
     * Anything unrecognised counts. A future bot-sdk version may store keys under a name this
     * list does not know, and the safe error is to be cautious about an unknown file rather
     * than to discard it — `bot-sdk.json` is excluded by name because it is the one file
     * proven to appear before any key exists.
     */
    return name !== 'bot-sdk.json';
  });
}

function readCryptoStoreMetadata(cryptoStorePath) {
  const metadataPath = path.join(cryptoStorePath, 'bot-sdk.json');
  if (!existsSync(metadataPath)) {
    return {
      metadataPath,
      deviceId: null,
      hasFiles: holdsKeyMaterial(cryptoStorePath),
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(metadataPath, 'utf8'));
  } catch (error) {
    throw new Error(`invalid Matrix crypto store metadata at ${metadataPath}: ${error.message}`);
  }
  const rawDeviceId = parsed?.deviceId;
  return {
    metadataPath,
    deviceId: rawDeviceId === null || rawDeviceId === undefined
      ? null
      : normalizeDeviceId(rawDeviceId, 'stored crypto device ID'),
    /*
     * Was unconditionally `true` whenever this file existed, whatever it contained. Now the
     * same question every other branch asks: is there key material here?
     */
    hasFiles: holdsKeyMaterial(cryptoStorePath),
  };
}

function uniqueArchivePath(cryptoStorePath, storedDeviceId, accessTokenDeviceId, nowMs) {
  const suffix = [
    'stale',
    archiveTimestamp(nowMs),
    safeArchiveComponent(storedDeviceId),
    'to',
    safeArchiveComponent(accessTokenDeviceId),
  ].join('-');
  let candidate = `${cryptoStorePath}.${suffix}`;
  let sequence = 1;
  while (existsSync(candidate)) {
    candidate = `${cryptoStorePath}.${suffix}.${sequence}`;
    sequence += 1;
  }
  return candidate;
}

/**
 * Keep the matrix-bot-sdk crypto database bound to the device represented by
 * the active access token. Reusing a crypto database from another device makes
 * the homeserver route room keys to one device while the bridge decrypts with
 * another device's private keys.
 */
export function reconcileMatrixCryptoStoreIdentity({
  cryptoStorePath,
  accessTokenDeviceId,
  nowMs = Date.now(),
}) {
  const resolvedPath = path.resolve(cryptoStorePath);
  const tokenDeviceId = normalizeDeviceId(accessTokenDeviceId, 'access-token device ID');
  const metadata = readCryptoStoreMetadata(resolvedPath);

  if (!metadata.hasFiles) {
    mkdirSync(resolvedPath, { recursive: true, mode: 0o700 });
    chmodSync(resolvedPath, 0o700);
    return {
      status: 'empty',
      accessTokenDeviceId: tokenDeviceId,
      storedDeviceId: null,
      archivePath: null,
    };
  }

  if (!metadata.deviceId) {
    throw new Error(
      `Matrix crypto store at ${resolvedPath} contains data but has no device identity`,
    );
  }

  if (metadata.deviceId === tokenDeviceId) {
    chmodSync(resolvedPath, 0o700);
    return {
      status: 'matched',
      accessTokenDeviceId: tokenDeviceId,
      storedDeviceId: metadata.deviceId,
      archivePath: null,
    };
  }

  const archivePath = uniqueArchivePath(
    resolvedPath,
    metadata.deviceId,
    tokenDeviceId,
    nowMs,
  );
  renameSync(resolvedPath, archivePath);
  chmodSync(archivePath, 0o700);
  mkdirSync(resolvedPath, { recursive: true, mode: 0o700 });
  chmodSync(resolvedPath, 0o700);
  return {
    status: 'rotated',
    accessTokenDeviceId: tokenDeviceId,
    storedDeviceId: metadata.deviceId,
    archivePath,
  };
}

export function assertMatrixCryptoDeviceIdentity(actualDeviceId, expectedDeviceId) {
  const actual = normalizeDeviceId(actualDeviceId, 'crypto client device ID');
  const expected = normalizeDeviceId(expectedDeviceId, 'access-token device ID');
  if (actual !== expected) {
    throw new Error(
      `Matrix crypto client device mismatch: token=${expected} crypto=${actual}`,
    );
  }
  return actual;
}
