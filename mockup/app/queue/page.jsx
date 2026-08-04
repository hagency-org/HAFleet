'use client';

import { useState } from 'react';
import Link from 'next/link';
import PageHead from '@/components/PageHead';
import { Toast, useToast } from '@/components/Toast';
import { queue as INITIAL, reminders, fmtSpanSec, fmtIn, agents } from '@/lib/mock-data';
import { useT } from '@/components/Prefs';

/*
 * Queue — the destination the migration table promised and nothing ever designed.
 *
 * Two things it must get right, both from live findings:
 *
 * 1. "Send now" bypasses the idle delivery gate. Verified in server.js: the
 *    endpoint claims the entry for delivery with reason 'manual' rather than
 *    waiting for the agent to go idle, and the old card said nothing about it.
 *    So the button says "skip wait" and the row states what it is waiting for.
 *
 * 2. Actions are optimistic with restore-on-failure, and the outcome is VISIBLE.
 *    The old implementation removed the row and, on failure, put it back while
 *    logging to console.debug — so a failed send looked exactly like a new event
 *    arriving. The concurrency defenses stay; only the silence goes.
 */

export const dynamic = 'force-static';

export default function QueuePage() {
  const t = useT();
  const [items, setItems] = useState(INITIAL);
  const [pending, setPending] = useState(new Set());
  const [toast, say] = useToast();

  function act(item, action) {
    if (pending.has(item.id)) return;
    setPending((p) => new Set(p).add(item.id));
    // Optimistic: remove immediately.
    setItems((list) => list.filter((i) => i.id !== item.id));

    setTimeout(() => {
      setPending((p) => { const n = new Set(p); n.delete(item.id); return n; });
      // The real endpoint refuses for distinguishable reasons: 409
      // already-delivering, 503 queue-persist-failed. Simulate one failure so the
      // restore path is visible rather than theoretical.
      const fails = item.id === 4468 && action === 'send';
      if (fails) {
        setItems((list) => [...list, item].sort((a, b) => b.id - a.id));
        say('fail', t('q.sendFailed', { id: item.id }));
      } else {
        say('ok', t(action === 'send' ? 'q.sentOne' : 'q.discardedOne', { id: item.id }));
      }
    }, 500);
  }

  const activeTargets = new Set(agents.filter((a) => a.activeNow).map((a) => a.name));

  return (
    <>
      <PageHead title={t('q.title')} sub={t('q.sub', { n: items.length, t: '3s' })} />

      <div className="notice">{t('q.explain')}</div>

      {items.length === 0 ? (
        <div className="empty">
          <div className="big">{t('q.empty')}</div>
          <p className="small">{t('q.emptyNote')}</p>
        </div>
      ) : (
        <div className="tbl-wrap" style={{ marginTop: 16 }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('col.to')}</th>
                <th>{t('col.message')}</th>
                <th>{t('col.waitingOn')}</th>
                <th className="num">{t('col.held')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((i) => {
                const busy = pending.has(i.id);
                return (
                  <tr key={i.id}>
                    <td>
                      <Link href={`/agents/${i.to}`}>{i.to}</Link>
                      <div className="faint" style={{ fontSize: 11 }}>
                        {activeTargets.has(i.to) ? 'ACTIVE' : 'IDLE'}
                      </div>
                    </td>
                    <td>
                      <div>{i.summary}</div>
                      <div className="faint" style={{ fontSize: 11 }}>
                        {t('q.meta', { id: i.id, from: i.from, type: i.type })}
                      </div>
                    </td>
                    <td className="dim">{i.reason}</td>
                    <td className="num dim">{fmtSpanSec(i.waitingSec)}</td>
                    <td>
                      <div className="btn-row">
                        <button
                          className="btn"
                          disabled={busy}
                          title={t('q.sendTitle')}
                          onClick={() => act(i, 'send')}
                        >
                          {busy ? '…' : t('q.sendNow')}
                        </button>
                        <button
                          className="btn"
                          disabled={busy}
                          title={t('q.discardTitle')}
                          onClick={() => act(i, 'discard')}
                        >
                          {t('q.discard')}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="sec">
        {t('q.reminders')}
        <span className="note">{t('q.remindersNote')}</span>
      </h2>
      <div className="panel">
        {reminders.map((r) => (
          <div key={r.id} style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
            <span className="badge">{fmtIn(r.inMinutes, t)}</span>
            <span style={{ fontSize: 12.5, flex: 1 }}>{r.text}</span>
            <button className="btn" onClick={() => say('ok', t('q.discardedReminder', { id: r.id }))}>
              {t('q.discard')}
            </button>
          </div>
        ))}
      </div>

      <Toast toast={toast} />
    </>
  );
}
