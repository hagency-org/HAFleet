import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const MANAGED_BY = 'hafleet-services-compose';

function readJson(filename) {
  try {
    return JSON.parse(readFileSync(filename, 'utf8'));
  } catch {
    return null;
  }
}

export function prepareBridgeContainerOwnership({ runtimeRoot, hostname }) {
  const root = path.resolve(runtimeRoot);
  const currentHostname = String(hostname || '').trim();
  if (!currentHostname) throw new Error('bridge container hostname is required');
  const matrixDir = path.join(root, 'data', 'matrix');
  const serviceDir = path.join(root, 'data', 'services-local');
  const ownerPath = path.join(matrixDir, 'bridge-owner.lock');
  const markerPath = path.join(serviceDir, 'bridge-container-owner.json');
  mkdirSync(matrixDir, { recursive: true, mode: 0o700 });
  mkdirSync(serviceDir, { recursive: true, mode: 0o700 });

  const ownerExists = existsSync(ownerPath);
  const owner = readJson(ownerPath);
  const marker = readJson(markerPath);
  let recovered = false;
  if (ownerExists && !owner) {
    throw new Error('existing bridge owner lock is invalid or unreadable');
  }
  if (owner) {
    const managedOwner = marker?.managedBy === MANAGED_BY
      && typeof owner.hostname === 'string'
      && owner.hostname === marker.hostname;
    if (!managedOwner) {
      throw new Error(`foreign or unmanaged bridge owner lock exists for hostname ${owner.hostname || 'unknown'}`);
    }
    unlinkSync(ownerPath);
    recovered = true;
  }

  const nextMarker = {
    schemaVersion: 1,
    managedBy: MANAGED_BY,
    hostname: currentHostname,
    preparedAt: new Date().toISOString(),
  };
  const temporary = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(nextMarker, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, markerPath);
  return { recovered, marker: nextMarker };
}
