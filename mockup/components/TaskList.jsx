'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { byBlockedFirst, isOpenTask, TASK_TRANSITIONS } from '@/lib/mock-data';
import { useT } from '@/components/Prefs';

/*
 * ONE list-and-detail renderer, used by both fleet Tasks and the agent Work tab.
 *
 * This is the shared contract from the design: agent Work is the same view with a
 * locked `assignee=<agent>` scope, not a fork. Two implementations of one record
 * is exactly how the statuses in lib/project-board.js ended up with two
 * vocabularies, and how a third name would have crept in.
 *
 * Ordering, stated because the page's job is ranking:
 *   bucket blocked -> in_progress -> accepted -> created -> done
 *   then priority P0..P3
 *   blocked ties: overdue first, then oldest updated
 *
 * BLOCKED and OVERDUE appear as words. Colour is never the only signal.
 */

// Relative age has to go through the dictionary too: "5m ago" is not readable
// Chinese, and a number glued to an English unit is the classic half-translated UI.
function relAge(iso, t) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  const mins = Math.max(0, Math.round((Date.parse('2026-08-04T06:00:00Z') - then) / 60000));
  if (mins < 60) return t('age.m', { n: mins });
  if (mins < 1440) return t('age.h', { n: Math.floor(mins / 60) });
  return t('age.d', { n: Math.floor(mins / 1440) });
}

export default function TaskList({ tasks, scope, onSay, lockedAssignee = null, agentNames = [] }) {
  const t = useT();
  const [selectedId, setSelectedId] = useState(null);
  const [busy, setBusy] = useState(null);
  const [draft, setDraft] = useState('');

  const rows = useMemo(() => {
    let out = tasks;
    if (lockedAssignee) out = out.filter((x) => x.assignee === lockedAssignee);
    else if (scope.assignee === '__none') out = out.filter((x) => !x.assignee);
    else if (scope.assignee && scope.assignee !== 'all') out = out.filter((x) => x.assignee === scope.assignee);

    if (scope.status === 'open') out = out.filter(isOpenTask);
    else if (scope.status && scope.status !== 'all') out = out.filter((x) => x.status === scope.status);

    if (scope.priority && scope.priority !== 'all') out = out.filter((x) => x.priority === scope.priority);
    if (scope.q) {
      const q = scope.q.toLowerCase();
      out = out.filter((x) => x.title.toLowerCase().includes(q) || x.id.includes(q));
    }
    return [...out].sort(byBlockedFirst);
  }, [tasks, scope, lockedAssignee]);

  const selected = rows.find((r) => r.id === selectedId) ?? rows[0] ?? null;

  function transition(next) {
    if (!selected) return;
    setBusy(next);
    setTimeout(() => {
      setBusy(null);
      onSay?.('ok', `${t(`tr.${next}`)}: ${selected.id} \u2192 ${next.replace('_', ' ')}`);
    }, 400);
  }

  if (rows.length === 0) {
    return (
      <div className="empty">
        <div className="big">{t('tk.noMatch')}</div>
        <p className="small">
          {lockedAssignee
            ? t('tk.emptyLocked', { name: lockedAssignee })
            : t('tk.emptyFleet')}
        </p>
        <div className="flow" style={{ justifyContent: 'center' }}>
          <span className="node">created</span><span className="arr">→</span>
          <span className="node">accepted</span><span className="arr">→</span>
          <span className="node">in progress</span><span className="arr">⇄</span>
          <span className="node blocked">blocked</span>
          <span className="arr">·</span>
          <span className="node">done</span>
        </div>
        <p className="small" style={{ marginTop: 10 }}>
          {t('tk.lifecycleNote')}
        </p>
      </div>
    );
  }

  return (
    <div className="split">
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t('col.status')}</th>
              <th className="num">{t('col.priority')}</th>
              <th>{t('col.task')}</th>
              <th>{t('col.assignee')}</th>
              <th>{t('tk.waitingHeartbeat')}</th>
              <th className="num">{t('col.updated')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr
                key={x.id}
                aria-selected={selected?.id === x.id}
                onClick={() => { setSelectedId(x.id); setDraft(''); }}
                style={{ cursor: 'pointer' }}
              >
                <td>
                  {/* The status VALUE is not translated — it is the API's word and
                      appears in curl output. Only the column heading is. */}
                  <span className={`badge ${x.status}`}>
                    {x.status === 'in_progress' ? 'IN PROGRESS' : x.status.toUpperCase()}
                  </span>
                </td>
                <td className="num">{x.priority}</td>
                <td>
                  <div>{x.title}</div>
                  <div className="faint" style={{ fontSize: 11 }}>{x.id}</div>
                </td>
                <td className="dim">{x.assignee ?? t('tk.unassigned')}</td>
                <td>
                  {x.status === 'blocked' ? (
                    <>
                      <div style={{ fontSize: 11.5 }}>{x.waiting_reason}</div>
                      {x.overdue && <span className="badge overdue">{t('ov.overdue')}</span>}
                    </>
                  ) : x.status === 'in_progress' ? (
                    <span className={`badge${x.stale ? ' attention' : ' ok'}`}>
                      {t(x.stale ? 'tk.heartbeatStale' : 'tk.heartbeatOk')}
                    </span>
                  ) : (
                    <span className="faint">—</span>
                  )}
                </td>
                <td className="num dim" title={x.updated_at}>{relAge(x.updated_at, t)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && (
        <div className="panel">
          <h3>{selected.title}</h3>
          <dl className="kv">
            <dt>{t('col.id')}</dt><dd>{selected.id}</dd>
            <dt>{t('col.status')}</dt>
            <dd>
              <span className={`badge ${selected.status}`}>
                {selected.status === 'in_progress' ? 'IN PROGRESS' : selected.status.toUpperCase()}
              </span>
            </dd>
            <dt>{t('col.priority')}</dt><dd>{selected.priority}</dd>
            <dt>{t('col.assignee')}</dt>
            <dd>
              {selected.assignee
                ? <Link href={`/agents/${selected.assignee}`}>{selected.assignee}</Link>
                : t('tk.unassigned')}
            </dd>
            {selected.labels?.length > 0 && (
              <>
                <dt>{t('tk.labels')}</dt>
                <dd>{selected.labels.map((l) => <span key={l} className="badge" style={{ marginRight: 5 }}>{l}</span>)}</dd>
              </>
            )}
            <dt>{t('tk.created')}</dt><dd className="dim">{relAge(selected.created_at, t)}</dd>
            <dt>{t('col.updated')}</dt><dd className="dim">{relAge(selected.updated_at, t)}</dd>
            {selected.status === 'blocked' && (
              <>
                <dt>{t('col.waitingOn')}</dt><dd>{selected.waiting_reason}</dd>
                <dt>{t('tk.until')}</dt>
                <dd>
                  {selected.waiting_until}{' '}
                  {selected.overdue && <span className="badge overdue">{t('ov.overdue')}</span>}
                </dd>
              </>
            )}
            {selected.status === 'in_progress' && (
              <>
                <dt>{t('tk.heartbeat')}</dt>
                <dd>
                  {relAge(selected.heartbeat_at, t)}{' '}
                  {selected.stale && <span className="badge attention">{t('tk.stale')}</span>}
                </dd>
              </>
            )}
          </dl>

          <p style={{ fontSize: 12.5, color: 'var(--ink-2)', marginTop: 12 }}>{selected.description}</p>

          <div className="btn-row" style={{ marginTop: 14 }}>
            {TASK_TRANSITIONS[selected.status].length === 0 ? (
              <span className="dim" style={{ fontSize: 12 }}>
                {t('tk.noTransitions', { s: selected.status })}
              </span>
            ) : (
              TASK_TRANSITIONS[selected.status].map((n) => (
                <button key={n} className="btn" disabled={busy === n} onClick={() => transition(n)}>
                  {busy === n ? '…' : t(`tr.${n}`)}
                </button>
              ))
            )}
          </div>

          <h3 style={{ marginTop: 18 }}>{t('tk.comments')}</h3>
          {selected.comments.length === 0 && (
            <p className="faint" style={{ fontSize: 12 }}>{t('tk.noneYet')}</p>
          )}
          {selected.comments.map((c, i) => (
            <div key={i} style={{ fontSize: 12.5, marginBottom: 9 }}>
              <span className="faint">{c.at} · {c.by}</span>
              <div>{c.text}</div>
            </div>
          ))}
          <textarea
            placeholder={t('tk.addComment')}
            aria-label={t('tk.addComment')}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            style={{
              width: '100%', marginTop: 8, font: '400 12.5px var(--sans)',
              padding: 8, border: '1px solid var(--line)', borderRadius: 5, resize: 'vertical',
            }}
          />
          <div className="btn-row" style={{ marginTop: 6, justifyContent: 'flex-end' }}>
            <button
              className="btn"
              disabled={!draft.trim()}
              onClick={() => { onSay?.('ok', t('tk.commentOn', { id: selected.id })); setDraft(''); }}
            >
              {t('act.post')}
            </button>
          </div>
          {draft.trim() && (
            <p className="faint" style={{ fontSize: 11 }}>
              {t('tk.draftKept')}
            </p>
          )}

          <div className="danger-zone">
            <span className="lbl">{t('tk.actions')}</span>
            <button
              className="btn danger"
              onClick={() => onSay?.('fail', t('tk.deleteNeedsConfirm', { id: selected.id }))}
            >
              {t('tk.deleteTask')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
