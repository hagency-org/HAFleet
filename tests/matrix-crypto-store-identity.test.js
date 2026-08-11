import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  assertMatrixCryptoDeviceIdentity,
  reconcileMatrixCryptoStoreIdentity,
} from '../lib/matrix-crypto-store-identity.js';

const temporaryRoots = [];

async function temporaryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hafleet-crypto-identity-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Matrix crypto store device identity', () => {
  test('keeps a crypto store whose device matches the access token', async () => {
    const root = await temporaryRoot();
    const store = path.join(root, 'bot-crypto');
    mkdirSync(store);
    writeFileSync(path.join(store, 'bot-sdk.json'), JSON.stringify({
      deviceId: 'DEVICE_CURRENT',
      rooms: {},
    }));
    writeFileSync(path.join(store, 'matrix-sdk-crypto.sqlite3'), 'database');

    const result = reconcileMatrixCryptoStoreIdentity({
      cryptoStorePath: store,
      accessTokenDeviceId: 'DEVICE_CURRENT',
      nowMs: Date.UTC(2026, 6, 24, 3, 0, 0),
    });

    expect(result).toMatchObject({
      status: 'matched',
      storedDeviceId: 'DEVICE_CURRENT',
      accessTokenDeviceId: 'DEVICE_CURRENT',
      archivePath: null,
    });
    expect(readFileSync(path.join(store, 'matrix-sdk-crypto.sqlite3'), 'utf8')).toBe('database');
  });

  test('archives a stale crypto store before initializing the access-token device', async () => {
    /*
     * REQ-OWNER-UI-APPROVAL-DEVICE, the archive-and-replace clause. Two assertions carry it and
     * they have to hold together: the archived directory still contains the old
     * `matrix-sdk-crypto.sqlite3` byte-for-byte ("archived intact" — the Olm private keys are
     * not deleted, so a message encrypted to DEVICE_OLD is still recoverable by hand), and the
     * live store is left EMPTY so the token device initializes fresh instead of adopting
     * another device's identity.
     *
     * This is the test the spec's `stale crypto store is archived before the token device
     * starts syncing` selector means. The "before sync begins" ordering is a property of the
     * call site in bridge-matrix.js, which no test asserts — see the report note.
     */
    const root = await temporaryRoot();
    const store = path.join(root, 'bot-crypto');
    mkdirSync(store);
    writeFileSync(path.join(store, 'bot-sdk.json'), JSON.stringify({
      deviceId: 'DEVICE_OLD',
      rooms: {},
    }));
    writeFileSync(path.join(store, 'matrix-sdk-crypto.sqlite3'), 'old-private-keys');

    const result = reconcileMatrixCryptoStoreIdentity({
      cryptoStorePath: store,
      accessTokenDeviceId: 'DEVICE_NEW',
      nowMs: Date.UTC(2026, 6, 24, 3, 0, 0),
    });

    expect(result.status).toBe('rotated');
    expect(result.archivePath).toContain('DEVICE_OLD-to-DEVICE_NEW');
    expect(readFileSync(path.join(result.archivePath, 'matrix-sdk-crypto.sqlite3'), 'utf8'))
      .toBe('old-private-keys');
    expect(await readdir(store)).toEqual([]);
  });

  test('fails closed for an unidentified non-empty crypto store', async () => {
    /*
     * REQ-OWNER-UI-APPROVAL-DEVICE: "missing ... device identity MUST fail closed". A store
     * holding private keys but no `bot-sdk.json` cannot be shown to belong to the token device,
     * and the throw is the requirement — the tempting alternatives are both wrong, since
     * adopting it risks encrypting owner approvals to a device the token cannot decrypt, and
     * deleting it destroys keys.
     */
    const root = await temporaryRoot();
    const store = path.join(root, 'bot-crypto');
    mkdirSync(store);
    writeFileSync(path.join(store, 'matrix-sdk-crypto.sqlite3'), 'unknown-private-keys');

    expect(() => reconcileMatrixCryptoStoreIdentity({
      cryptoStorePath: store,
      accessTokenDeviceId: 'DEVICE_NEW',
    })).toThrow('contains data but has no device identity');
  });

  test('requires the initialized crypto client to match the access-token device', () => {
    /*
     * REQ-OWNER-UI-APPROVAL-DEVICE: "post-initialization mismatched device identity MUST fail
     * closed". Reconciling the store on disk is not enough — the client can come up on a
     * different device anyway — so the identity is checked again after initialization and a
     * mismatch throws rather than syncing.
     */
    expect(assertMatrixCryptoDeviceIdentity('DEVICE_CURRENT', 'DEVICE_CURRENT'))
      .toBe('DEVICE_CURRENT');
    expect(() => assertMatrixCryptoDeviceIdentity('DEVICE_OLD', 'DEVICE_NEW'))
      .toThrow('token=DEVICE_NEW crypto=DEVICE_OLD');
  });
});
