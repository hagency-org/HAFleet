'use client';

import { useState } from 'react';
import Link from 'next/link';
import PageHead from '@/components/PageHead';
import { Toast, useToast } from '@/components/Toast';
import { queue as INITIAL, reminders, fmtSpanSec, agents } from '@/lib/mock-data';

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
        say('fail', `Send failed for #${item.id}: already-delivering (409)`);
      } else {
        say('ok', `${action === 'send' ? 'Sent' : 'Discarded'} queued message #${item.id}`);
      }
    }, 500);
  }

  const activeTargets = new Set(agents.filter((a) => a.activeNow).map((a) => a.name));

  return (
    <>
      <PageHead title="Queue" sub={`${items.length} waiting · updated 3s ago`} />

      <div className="notice">
        Messages wait here until their target agent goes idle. <strong>Send now</strong> skips that
        wait and delivers immediately — it does not make the agent finish sooner.
      </div>

      {items.length === 0 ? (
        <div className="empty">
          <div className="big">Nothing queued</div>
          <p className="small">
            Messages appear here when their target is busy. An empty queue means every agent has
            taken delivery of everything addressed to it.
          </p>
        </div>
      ) : (
        <div className="tbl-wrap" style={{ marginTop: 16 }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>To</th>
                <th>Message</th>
                <th>Waiting on</th>
                <th className="num">Held</th>
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
                        #{i.id} · from {i.from} · type {i.type}
                      </div>
                    </td>
                    <td className="dim">{i.reason}</td>
                    <td className="num dim">{fmtSpanSec(i.waitingSec)}</td>
                    <td>
                      <div className="btn-row">
                        <button
                          className="btn"
                          disabled={busy}
                          title="Deliver immediately, without waiting for the agent to go idle."
                          onClick={() => act(i, 'send')}
                        >
                          {busy ? '…' : 'Send now · skip wait'}
                        </button>
                        <button
                          className="btn"
                          disabled={busy}
                          title="Drop this queued message. It is not delivered."
                          onClick={() => act(i, 'discard')}
                        >
                          Discard
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
        Reminders
        <span className="note">discarding a reminder stops it firing; it is not rescheduled</span>
      </h2>
      <div className="panel">
        {reminders.map((r) => (
          <div key={r.id} style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
            <span className="badge">{r.at}</span>
            <span style={{ fontSize: 12.5, flex: 1 }}>{r.text}</span>
            <button className="btn" onClick={() => say('ok', `Discarded reminder ${r.id}`)}>
              Discard
            </button>
          </div>
        ))}
      </div>

      <Toast toast={toast} />
    </>
  );
}
