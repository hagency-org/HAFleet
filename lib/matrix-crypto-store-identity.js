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

function readCryptoStoreMetadata(cryptoStorePath) {
  const metadataPath = path.join(cryptoStorePath, 'bot-sdk.json');
  if (!existsSync(metadataPath)) {
    return {
      metadataPath,
      deviceId: null,
      hasFiles: existsSync(cryptoStorePath) && readdirSync(cryptoStorePath).length > 0,
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
    hasFiles: true,
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
