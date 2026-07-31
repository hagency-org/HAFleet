import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import os from 'os';
import path from 'path';
import { PendingEncryptedEventStore } from '../lib/pending-encrypted-event-store.js';

describe('pending encrypted approval event store', () => {
  const temporaryDirectories = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('retains an encrypted event across restart and removes it after recovery', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'hafleet-pending-e2ee-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'pending.json');
    const event = {
      type: 'm.room.encrypted',
      event_id: '$verdict',
      sender: '@owner:palpo.test',
      content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'encrypted' },
    };

    const first = new PendingEncryptedEventStore(filePath, { now: () => 1000 });
    first.put({ roomId: '!approval:palpo.test', event });

    const restarted = new PendingEncryptedEventStore(filePath, { now: () => 1001 });
    expect(restarted.list()).toEqual([expect.objectContaining({
      eventId: '$verdict',
      roomId: '!approval:palpo.test',
      event,
      receivedAt: 1000,
    })]);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);

    expect(restarted.remove('$verdict')).toBe(true);
    expect(restarted.list()).toEqual([]);
    expect(JSON.parse(readFileSync(filePath, 'utf8')).records).toEqual([]);
  });

  test('prunes retained ciphertext after the bounded recovery window', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'hafleet-pending-e2ee-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'pending.json');
    let now = 1000;
    const store = new PendingEncryptedEventStore(filePath, {
      now: () => now,
      maxAgeMs: 500,
    });
    store.put({
      roomId: '!approval:palpo.test',
      event: {
        type: 'm.room.encrypted',
        event_id: '$stale',
        content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'encrypted' },
      },
    });

    now = 1501;
    expect(store.prune()).toEqual([expect.objectContaining({ eventId: '$stale' })]);
    expect(store.list()).toEqual([]);
  });

  test('fails closed instead of evicting an unprocessed event at capacity', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'hafleet-pending-e2ee-'));
    temporaryDirectories.push(directory);
    const store = new PendingEncryptedEventStore(path.join(directory, 'pending.json'), {
      maxEntries: 1,
    });
    store.put({
      roomId: '!approval:palpo.test',
      event: {
        type: 'm.room.encrypted',
        event_id: '$first',
        content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'first' },
      },
    });

    expect(() => store.put({
      roomId: '!approval:palpo.test',
      event: {
        type: 'm.room.encrypted',
        event_id: '$second',
        content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'second' },
      },
    })).toThrow('capacity exceeded');
    expect(store.list().map((record) => record.eventId)).toEqual(['$first']);
  });
});
