import { afterEach, describe, expect, test } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MatrixDispatchStore } from '../src/matrix-dispatch-store.mjs';

const roots = [];

function context() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agentchat-matrix-dispatch-store-'));
  roots.push(root);
  return { journalPath: path.join(root, 'data', 'matrix', 'source-events.jsonl') };
}

function reservation(eventId = '$event-1', messageId = 'msg_1') {
  return {
    eventId,
    messageId,
    message: { id: messageId, source: 'matrix', sourceEventId: eventId },
    dispatch: { senderIsAgent: false, directTargetKind: 'agent' },
    response: { ok: true, id: messageId },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('MatrixDispatchStore', () => {
  test('persists reservation and commit across reload', () => {
    const { journalPath } = context();
    const first = new MatrixDispatchStore({ journalPath });
    first.reserve(reservation());
    first.accept('$event-1', { ok: true, id: 'msg_1' });
    first.commit('$event-1', { ok: true, id: 'msg_1' });

    const reloaded = new MatrixDispatchStore({ journalPath });
    expect(reloaded.get('$event-1')).toMatchObject({
      eventId: '$event-1', messageId: 'msg_1', status: 'committed',
    });
    expect(readFileSync(journalPath, 'utf8').trim().split('\n')).toHaveLength(3);
  });

  test('keeps the original reservation for a repeated event id', () => {
    const { journalPath } = context();
    const store = new MatrixDispatchStore({ journalPath });
    store.reserve(reservation());
    const duplicate = store.reserve(reservation('$event-1', 'msg_2'));

    expect(duplicate.messageId).toBe('msg_1');
    expect(readFileSync(journalPath, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  test('repairs existing journal permissions', () => {
    const { journalPath } = context();
    new MatrixDispatchStore({ journalPath }).reserve(reservation());
    chmodSync(journalPath, 0o644);

    new MatrixDispatchStore({ journalPath });

    expect(statSync(journalPath).mode & 0o777).toBe(0o600);
  });

  test('fails closed on malformed or blank complete records', () => {
    const { journalPath } = context();
    new MatrixDispatchStore({ journalPath }).reserve(reservation());
    const valid = readFileSync(journalPath, 'utf8');
    writeFileSync(journalPath, `${valid}\n{malformed}\n`);

    expect(() => new MatrixDispatchStore({ journalPath })).toThrow(/line 2/i);
  });

  test('fails closed on an unknown status or committed-to-reserved rollback', () => {
    const { journalPath } = context();
    const store = new MatrixDispatchStore({ journalPath });
    store.reserve(reservation());
    store.accept('$event-1', { ok: true, id: 'msg_1' });
    store.commit('$event-1', { ok: true, id: 'msg_1' });
    const rows = readFileSync(journalPath, 'utf8').trim().split('\n').map(JSON.parse);
    writeFileSync(journalPath, `${JSON.stringify(rows[0])}\n${JSON.stringify({ ...rows[1], status: 'unknown' })}\n`);
    expect(() => new MatrixDispatchStore({ journalPath })).toThrow(/line 2.*status/i);

    writeFileSync(journalPath, `${JSON.stringify(rows[2])}\n${JSON.stringify(rows[0])}\n`);
    expect(() => new MatrixDispatchStore({ journalPath })).toThrow(/line 2.*rollback/i);
  });
});
