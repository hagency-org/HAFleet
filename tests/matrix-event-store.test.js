import { afterEach, describe, expect, test } from 'vitest';
import {
  existsSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MatrixEventStore } from '../src/matrix-event-store.mjs';

const roots = [];

function context() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hafleet-matrix-event-store-'));
  roots.push(root);
  return { root, journalPath: path.join(root, 'data', 'matrix', 'processed-events.jsonl') };
}

function line(eventId, messageId, processedAt = '2026-07-12T00:00:00.000Z') {
  return JSON.stringify({ eventId, messageId, processedAt });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('MatrixEventStore', () => {
  test('starts empty without creating the journal', () => {
    const { journalPath } = context();
    const store = new MatrixEventStore({ journalPath });

    expect(store.has('$missing')).toBe(false);
    expect(store.get('$missing')).toBeNull();
    expect(existsSync(journalPath)).toBe(false);
  });

  test('fsync append survives a new store instance', () => {
    const { journalPath } = context();
    const first = new MatrixEventStore({ journalPath });
    const recorded = first.recordProcessed({ eventId: '$event-1', messageId: 'msg_1' });
    const second = new MatrixEventStore({ journalPath });

    expect(recorded).toMatchObject({ eventId: '$event-1', messageId: 'msg_1' });
    expect(second.has('$event-1')).toBe(true);
    expect(second.get('$event-1')).toMatchObject({ eventId: '$event-1', messageId: 'msg_1' });
  });

  test('keeps the first message id when the same event is recorded twice', () => {
    const { journalPath } = context();
    const store = new MatrixEventStore({ journalPath });
    store.recordProcessed({ eventId: '$event-1', messageId: 'msg_1' });
    const duplicate = store.recordProcessed({ eventId: '$event-1', messageId: 'msg_2' });

    expect(duplicate).toMatchObject({ eventId: '$event-1', messageId: 'msg_1' });
    expect(readFileSync(journalPath, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  test('truncates only an incomplete final line before the next append', () => {
    const { journalPath } = context();
    const directory = path.dirname(journalPath);
    const seed = new MatrixEventStore({ journalPath });
    seed.recordProcessed({ eventId: '$event-1', messageId: 'msg_1' });
    writeFileSync(journalPath, `${readFileSync(journalPath, 'utf8')}{"eventId":"$partial"`);

    const recovered = new MatrixEventStore({ journalPath });
    expect(recovered.has('$event-1')).toBe(true);
    expect(recovered.has('$partial')).toBe(false);
    recovered.recordProcessed({ eventId: '$event-2', messageId: 'msg_2' });

    const rows = readFileSync(journalPath, 'utf8').trim().split('\n').map(JSON.parse);
    expect(rows.map((row) => row.eventId)).toEqual(['$event-1', '$event-2']);
    expect(path.dirname(journalPath)).toBe(directory);
  });

  test('fails closed on a malformed complete line and names the journal', () => {
    const { root, journalPath } = context();
    const directory = path.dirname(journalPath);
    new MatrixEventStore({ journalPath }).recordProcessed({ eventId: '$event-1', messageId: 'msg_1' });
    writeFileSync(journalPath, `${line('$event-1', 'msg_1')}\n{malformed}\n${line('$event-2', 'msg_2')}\n`);

    expect(() => new MatrixEventStore({ journalPath })).toThrow(new RegExp(
      `${journalPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*line 2|line 2.*${path.basename(journalPath)}`,
      'i',
    ));
    expect(existsSync(root)).toBe(true);
    expect(path.dirname(journalPath)).toBe(directory);
  });

  test('creates a private journal even under a permissive umask', () => {
    const { journalPath } = context();
    const store = new MatrixEventStore({ journalPath });
    const previousUmask = process.umask(0);
    try {
      store.recordProcessed({ eventId: '$event-1', messageId: 'msg_1' });
    } finally {
      process.umask(previousUmask);
    }

    expect(statSync(journalPath).mode & 0o777).toBe(0o600);
  });

  test('repairs permissions on an existing journal', () => {
    const { journalPath } = context();
    const seed = new MatrixEventStore({ journalPath });
    seed.recordProcessed({ eventId: '$event-1', messageId: 'msg_1' });
    chmodSync(journalPath, 0o644);

    new MatrixEventStore({ journalPath });

    expect(statSync(journalPath).mode & 0o777).toBe(0o600);
  });

  test('fails closed on a complete blank record', () => {
    const { journalPath } = context();
    new MatrixEventStore({ journalPath }).recordProcessed({ eventId: '$event-1', messageId: 'msg_1' });
    writeFileSync(journalPath, `${line('$event-1', 'msg_1')}\n\n${line('$event-2', 'msg_2')}\n`);

    expect(() => new MatrixEventStore({ journalPath })).toThrow(/line 2/i);
  });

  test('fails closed when a duplicate event changes message id', () => {
    const { journalPath } = context();
    new MatrixEventStore({ journalPath }).recordProcessed({ eventId: '$event-1', messageId: 'msg_1' });
    writeFileSync(journalPath, `${line('$event-1', 'msg_1')}\n${line('$event-1', 'msg_2')}\n`);

    expect(() => new MatrixEventStore({ journalPath })).toThrow(/line 2.*messageId changed/i);
  });
});
