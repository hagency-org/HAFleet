'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { byBlockedFirst, isOpenTask, TASK_TRANSITIONS, TRANSITION_LABELS } from '@/lib/mock-data';

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

function relAge(iso) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  const mins = Math.max(0, Math.round((Date.parse('2026-08-04T06:00:00Z') - then) / 60000));
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
}

export default function TaskList({ tasks, scope, onSay, lockedAssignee = null, agentNames = [] }) {
  const [selectedId, setSelectedId] = useState(null);
  const [busy, setBusy] = useState(null);
  const [draft, setDraft] = useState('');

  const rows = useMemo(() => {
    let out = tasks;
    if (lockedAssignee) out = out.filter((t) => t.assignee === lockedAssignee);
    else if (scope.assignee === '__none') out = out.filter((t) => !t.assignee);
    else if (scope.assignee && scope.assignee !== 'all') out = out.filter((t) => t.assignee === scope.assignee);

    if (scope.status === 'open') out = out.filter(isOpenTask);
    else if (scope.status && scope.status !== 'all') out = out.filter((t) => t.status === scope.status);

    if (scope.priority && scope.priority !== 'all') out = out.filter((t) => t.priority === scope.priority);
    if (scope.q) {
      const q = scope.q.toLowerCase();
      out = out.filter((t) => t.title.toLowerCase().includes(q) || t.id.includes(q));
    }
    return [...out].sort(byBlockedFirst);
  }, [tasks, scope, lockedAssignee]);

  const selected = rows.find((r) => r.id === selectedId) ?? rows[0] ?? null;

  function transition(next) {
    if (!selected) return;
    setBusy(next);
    setTimeout(() => {
      setBusy(null);
      onSay?.('ok', `${TRANSITION_LABELS[next]}: ${selected.id} → ${next.replace('_', ' ')}`);
    }, 400);
  }

  if (rows.length === 0) {
    return (
      <div className="empty">
        <div className="big">No tasks match this view</div>
        <p className="small">
          {lockedAssignee
            ? `${lockedAssignee} has no tasks in this scope. A task is a work item with a lifecycle: created, accepted, in progress, blocked, done.`
            : 'Widen a filter, or create one. A task is a work item assigned to an agent and grouped under a project.'}
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
          <code>blocked</code> is a detour from <code>in progress</code> and returns to it — not a
          step before <code>done</code>.
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
              <th>Status</th>
              <th className="num">Pri</th>
              <th>Task</th>
              <th>Assignee</th>
              <th>Waiting / heartbeat</th>
              <th className="num">Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr
                key={t.id}
                aria-selected={selected?.id === t.id}
                onClick={() => { setSelectedId(t.id); setDraft(''); }}
                style={{ cursor: 'pointer' }}
              >
                <td>
                  <span className={`badge ${t.status}`}>
                    {t.status === 'in_progress' ? 'IN PROGRESS' : t.status.toUpperCase()}
                  </span>
                </td>
                <td className="num">{t.priority}</td>
                <td>
                  <div>{t.title}</div>
                  <div className="faint" style={{ fontSize: 11 }}>{t.id}</div>
                </td>
                <td className="dim">{t.assignee ?? 'Unassigned'}</td>
                <td>
                  {t.status === 'blocked' ? (
                    <>
                      <div style={{ fontSize: 11.5 }}>{t.waiting_reason}</div>
                      {t.overdue && <span className="badge overdue">OVERDUE</span>}
                    </>
                  ) : t.status === 'in_progress' ? (
                    <span className={`badge${t.stale ? ' attention' : ' ok'}`}>
                      {t.stale ? 'HEARTBEAT STALE' : 'heartbeat ok'}
                    </span>
                  ) : (
                    <span className="faint">—</span>
                  )}
                </td>
                <td className="num dim" title={t.updated_at}>{relAge(t.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && (
        <div className="panel">
          <h3>{selected.title}</h3>
          <dl className="kv">
            <dt>Id</dt><dd>{selected.id}</dd>
            <dt>Status</dt>
            <dd>
              <span className={`badge ${selected.status}`}>
                {selected.status === 'in_progress' ? 'IN PROGRESS' : selected.status.toUpperCase()}
              </span>
            </dd>
            <dt>Priority</dt><dd>{selected.priority}</dd>
            <dt>Assignee</dt>
            <dd>
              {selected.assignee
                ? <Link href={`/agents/${selected.assignee}`}>{selected.assignee}</Link>
                : 'Unassigned'}
            </dd>
            {selected.labels?.length > 0 && (
              <>
                <dt>Labels</dt>
                <dd>{selected.labels.map((l) => <span key={l} className="badge" style={{ marginRight: 5 }}>{l}</span>)}</dd>
              </>
            )}
            <dt>Created</dt><dd className="dim">{relAge(selected.created_at)}</dd>
            <dt>Updated</dt><dd className="dim">{relAge(selected.updated_at)}</dd>
            {selected.status === 'blocked' && (
              <>
                <dt>Waiting on</dt><dd>{selected.waiting_reason}</dd>
                <dt>Until</dt>
                <dd>
                  {selected.waiting_until}{' '}
                  {selected.overdue && <span className="badge overdue">OVERDUE</span>}
                </dd>
              </>
            )}
            {selected.status === 'in_progress' && (
              <>
                <dt>Heartbeat</dt>
                <dd>
                  {relAge(selected.heartbeat_at)}{' '}
                  {selected.stale && <span className="badge attention">STALE</span>}
                </dd>
              </>
            )}
          </dl>

          <p style={{ fontSize: 12.5, color: 'var(--ink-2)', marginTop: 12 }}>{selected.description}</p>

          <div className="btn-row" style={{ marginTop: 14 }}>
            {TASK_TRANSITIONS[selected.status].length === 0 ? (
              <span className="dim" style={{ fontSize: 12 }}>
                No transitions from “{selected.status}”.
              </span>
            ) : (
              TASK_TRANSITIONS[selected.status].map((n) => (
                <button key={n} className="btn" disabled={busy === n} onClick={() => transition(n)}>
                  {busy === n ? '…' : TRANSITION_LABELS[n]}
                </button>
              ))
            )}
          </div>

          <h3 style={{ marginTop: 18 }}>Comments</h3>
          {selected.comments.length === 0 && (
            <p className="faint" style={{ fontSize: 12 }}>None yet.</p>
          )}
          {selected.comments.map((c, i) => (
            <div key={i} style={{ fontSize: 12.5, marginBottom: 9 }}>
              <span className="faint">{c.at} · {c.by}</span>
              <div>{c.text}</div>
            </div>
          ))}
          <textarea
            placeholder="Add a comment"
            aria-label="Add a comment"
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
              onClick={() => { onSay?.('ok', `Comment posted on ${selected.id}`); setDraft(''); }}
            >
              Post
            </button>
          </div>
          {draft.trim() && (
            <p className="faint" style={{ fontSize: 11 }}>
              Draft is preserved across refresh — an unsaved comment is not discarded by a poll.
            </p>
          )}

          <div className="danger-zone">
            <span className="lbl">Task actions</span>
            <button
              className="btn danger"
              onClick={() => onSay?.('fail', `Delete needs confirmation: type ${selected.id} to proceed`)}
            >
              Delete task
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
