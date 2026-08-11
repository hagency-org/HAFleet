import { afterEach, describe, expect, test } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MatrixDeliveryJournal } from '../lib/matrix-delivery-journal.js';

const roots = [];

function context() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hafleet-matrix-delivery-journal-'));
  roots.push(root);
  return {
    root,
    journalPath: path.join(root, 'data', 'matrix', 'pending-deliveries.jsonl'),
  };
}

function delivery(overrides = {}) {
  return {
    messageId: 'msg_1',
    roomId: '!room:matrix.test',
    primaryEventId: '$event-1',
    threadRootEventId: '$root-1',
    ...overrides,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('MatrixDeliveryJournal', () => {
  test('pending_delivery_replays_after_restart', () => {
    const { journalPath } = context();
    const first = new MatrixDeliveryJournal({ journalPath });
    first.recordPending(delivery());

    const restarted = new MatrixDeliveryJournal({ journalPath });
    expect(restarted.pending()).toEqual([
      expect.objectContaining(delivery()),
    ]);
    restarted.markCommitted('msg_1');

    const completed = new MatrixDeliveryJournal({ journalPath });
    expect(completed.pending()).toEqual([]);
    expect(completed.get('msg_1')).toMatchObject({
      ...delivery(),
      state: 'committed',
    });
  });

  test('same pending record is idempotent and conflicting primary is rejected', () => {
    /*
     * REQ-MATRIX-THREAD-IDEMPOTENCY at the journal layer, which is where recovery reads from.
     * The line-count assertion is the one that matters: a re-recorded delivery must not append
     * a second row, or a later replay would upsert twice. The throw on a changed
     * primaryEventId is the "retain the first" half — the journal refuses to forget it.
     */
    const { journalPath } = context();
    const journal = new MatrixDeliveryJournal({ journalPath });
    journal.recordPending(delivery());
    journal.recordPending(delivery());

    expect(() => journal.recordPending(delivery({ primaryEventId: '$event-2' })))
      .toThrow(/already recorded/);
    expect(readFileSync(journalPath, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  test('committed delivery cannot regress after restart', () => {
    const { journalPath } = context();
    const journal = new MatrixDeliveryJournal({ journalPath });
    journal.recordPending(delivery());
    journal.markCommitted('msg_1');

    const rows = readFileSync(journalPath, 'utf8');
    const regressed = JSON.stringify({
      ...delivery(),
      state: 'pending',
      updatedAt: new Date().toISOString(),
    });
    writeFileSync(journalPath, `${rows}${regressed}\n`);

    expect(() => new MatrixDeliveryJournal({ journalPath })).toThrow(/regressed/);
    expect(existsSync(journalPath)).toBe(true);
  });

  test('repairs a torn final line without losing the complete pending record', () => {
    const { journalPath } = context();
    new MatrixDeliveryJournal({ journalPath }).recordPending(delivery());
    writeFileSync(journalPath, `${readFileSync(journalPath, 'utf8')}{"messageId":"partial"`);

    const restarted = new MatrixDeliveryJournal({ journalPath });
    expect(restarted.pending()).toHaveLength(1);
    expect(restarted.get('msg_1')).toMatchObject(delivery());
  });
});
