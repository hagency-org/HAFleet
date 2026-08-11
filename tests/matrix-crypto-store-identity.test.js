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

  test('STARTS on a store holding only the bot-sdk.json placeholder', async () => {
    /*
     * The startup brick, as an operator meets it. matrix-bot-sdk writes `bot-sdk.json` as `{}`
     * the instant `new RustSdkCryptoStorageProvider(path, 0)` runs, and the `deviceId` inside it
     * is not written until `crypto.prepare()` during `botClient.start()`. Between those two
     * moments the bridge registers every agent's Matrix account with rate-limit backoff, so the
     * window is seconds to minutes wide — widest on a FIRST deployment, when every account is
     * new and every request can hit a 429.
     *
     * A restart inside that window used to be fatal and PERMANENT: the store held no keys at
     * all, but reconcile read "files present, no device identity" and threw, every time, until
     * someone deleted a directory whose path appears in no runbook. systemd's
     * StartLimitBurst=5 then stops retrying and the unit stays dead.
     *
     * The rule this restores: ADR-008 fails closed on an unidentified store because it may hold
     * "old private keys" worth archiving for rollback and forensics. A `{}` placeholder holds
     * nothing, so there is nothing to preserve and nothing to be cautious about.
     */
    const root = await temporaryRoot();
    const store = path.join(root, 'bot-crypto');
    mkdirSync(store);
    writeFileSync(path.join(store, 'bot-sdk.json'), '{}');

    const result = reconcileMatrixCryptoStoreIdentity({
      cryptoStorePath: store,
      accessTokenDeviceId: 'DEVICE_NEW',
      nowMs: Date.UTC(2026, 6, 24, 3, 0, 0),
    });

    /*
     * `empty`, not `matched` — the honest status. The store is recognised as holding nothing
     * rather than as agreeing with the token device, and the caller
     * (`bridge-matrix.js:2656`) special-cases only `rotated`, so `empty` proceeds to construct
     * the client exactly as a fresh install does.
     */
    expect(result).toMatchObject({ status: 'empty', archivePath: null });
    // Nothing archived, because there was nothing to archive.
    expect(await readdir(store)).toEqual(['bot-sdk.json']);
  });

  test('starts when the placeholder names a null device, as lowdb defaults write it', async () => {
    // `db.defaults({ deviceId: null, ... })` is the shape bot-sdk seeds, so this is the same
    // window one step later. Still no key material, still nothing to protect.
    const root = await temporaryRoot();
    const store = path.join(root, 'bot-crypto');
    mkdirSync(store);
    writeFileSync(path.join(store, 'bot-sdk.json'), JSON.stringify({ deviceId: null, rooms: {} }));

    expect(reconcileMatrixCryptoStoreIdentity({
      cryptoStorePath: store,
      accessTokenDeviceId: 'DEVICE_NEW',
      nowMs: Date.UTC(2026, 6, 24, 3, 0, 0),
    })).toMatchObject({ status: 'empty' });
  });

  test('still FAILS CLOSED when the placeholder sits beside real key material', async () => {
    /*
     * The line the fix must not cross. Same unidentified `{}`, but a crypto database next to it
     * — so this store may hold keys from another device, which is exactly the case ADR-008
     * refuses to start on. If this ever passes, the fix has become a hole.
     */
    const root = await temporaryRoot();
    const store = path.join(root, 'bot-crypto');
    mkdirSync(store);
    writeFileSync(path.join(store, 'bot-sdk.json'), '{}');
    writeFileSync(path.join(store, 'matrix-sdk-crypto.sqlite3'), 'private-keys');

    expect(() => reconcileMatrixCryptoStoreIdentity({
      cryptoStorePath: store,
      accessTokenDeviceId: 'DEVICE_NEW',
      nowMs: Date.UTC(2026, 6, 24, 3, 0, 0),
    })).toThrow('contains data but has no device identity');
  });

  test('treats an UNRECOGNISED file as key material rather than as scaffolding', async () => {
    /*
     * The exclusion is by name, so a future bot-sdk version storing keys under a name this list
     * does not know must still be treated as data. Only `bot-sdk.json` is excluded, because it
     * is the one file proven to exist before any key does.
     */
    const root = await temporaryRoot();
    const store = path.join(root, 'bot-crypto');
    mkdirSync(store);
    writeFileSync(path.join(store, 'bot-sdk.json'), '{}');
    writeFileSync(path.join(store, 'some-future-keystore.dat'), 'x');

    expect(() => reconcileMatrixCryptoStoreIdentity({
      cryptoStorePath: store,
      accessTokenDeviceId: 'DEVICE_NEW',
      nowMs: Date.UTC(2026, 6, 24, 3, 0, 0),
    })).toThrow('contains data but has no device identity');
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
