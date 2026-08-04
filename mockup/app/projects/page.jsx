'use client';

import { useState } from 'react';
import Link from 'next/link';
import PageHead from '@/components/PageHead';
import { board, tasks, TASK_STATUSES, byBlockedFirst } from '@/lib/mock-data';

/*
 * Project board — fleet scope, not an agent attribute.
 *
 * Round 1 called Projects "an attribute of an agent" and proposed folding it under
 * one. That was wrong: projects-page.js reads only /api/project-board. It is a
 * coordination board across agents and repositories, and folding it would have
 * discarded seven of its eight sections. The per-agent Repos tab links here rather
 * than replacing it.
 *
 * The rail count says "N groups" and this page selects one of them, so the two
 * agree — the static mockup said "0 groups" while showing a selected group.
 */
export default function ProjectsPage() {
  const [group, setGroup] = useState(board.group);
  const t = board.totals;
  const lanes = TASK_STATUSES.map((s) => ({ status: s, items: tasks.filter((x) => x.status === s) }));

  return (
    <>
      <PageHead title="Project board" sub={`updated 12s ago`}>
        <label style={{ fontSize: 12, color: 'var(--ink-dim)' }}>
          Group{' '}
          <select value={group} onChange={(e) => setGroup(e.target.value)}>
            {board.groups.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </label>
        <button className="btn">Refresh</button>
      </PageHead>

      <div className="cards">
        <div className="card"><div className="cap">Members</div><div className="val">{t.members}</div></div>
        <div className="card"><div className="cap">Online</div><div className="val ok">{t.online}</div></div>
        <div className="card"><div className="cap">Working</div><div className="val">{t.working}</div></div>
        <div className="card"><div className="cap">Open tasks</div><div className="val">{t.openTasks}</div></div>
        <div className="card"><div className="cap">Worktrees</div><div className="val">{t.worktrees}</div></div>
        <div className="card">
          <div className="cap">Dirty</div>
          <div className={`val${t.dirtyWorktrees > 0 ? ' warn' : ''}`}>{t.dirtyWorktrees}</div>
        </div>
      </div>

      <div className="split" style={{ marginTop: 4, gridTemplateColumns: 'minmax(0,1.5fr) minmax(0,1fr)' }}>
        <div>
          <h2 className="sec">Task board<span className="note">blocked lane first in the ordering, not the layout</span></h2>
          <div className="lanes">
            {lanes.map((l) => (
              <div className={`lane${l.status === 'blocked' ? ' blocked' : ''}`} key={l.status}>
                <h4>
                  <span>{l.status === 'in_progress' ? 'In progress' : l.status[0].toUpperCase() + l.status.slice(1)}</span>
                  <span className="dim">{l.items.length}</span>
                </h4>
                <div className="cards-in">
                  {[...l.items].sort(byBlockedFirst).map((x) => (
                    <Link className="mini" key={x.id} href={`/tasks?task=${x.id}`}>
                      {x.title}
                      <span className="who">{x.assignee ?? 'Unassigned'} · {x.priority}</span>
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <h2 className="sec">Repositories and worktrees</h2>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Repo</th><th>Branch</th><th>State</th></tr></thead>
              <tbody>
                {board.repos.map((r) => (
                  <tr key={r.repo}>
                    <td>{r.repo}</td>
                    <td className="dim">{r.branch}</td>
                    <td><span className={`badge${r.state === 'dirty' ? ' attention' : ' ok'}`}>{r.state}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <h2 className="sec" style={{ marginTop: 0 }}>Members</h2>
          <div className="panel">
            {board.members.map((m) => (
              <div key={m.name} style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
                <span style={{ color: m.online ? 'var(--ok)' : 'var(--ink-faint)', fontSize: 10 }}>
                  {m.online ? '●' : '○'}
                </span>
                <Link href={`/agents/${m.name}`} style={{ flex: 1, fontSize: 12.5 }}>{m.name}</Link>
                <span className="dim" style={{ fontSize: 11.5 }}>{m.role}</span>
              </div>
            ))}
          </div>

          <h2 className="sec">Specs and issues</h2>
          <div className="cards" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <div className="card"><div className="cap">Local</div><div className="val">{t.localIssues}</div></div>
            <div className="card"><div className="cap">Remote</div><div className="val">{t.remoteIssues}</div></div>
          </div>

          <h2 className="sec">Changes</h2>
          <div className="panel">
            {board.changes.map((c) => (
              <div key={c.title} style={{ display: 'flex', gap: 10, marginBottom: 8, fontSize: 12.5 }}>
                <span style={{ flex: 1 }}>{c.title}</span>
                <span className={c.checksPassed === c.checksTotal ? 'badge ok' : 'badge'}>
                  {c.checksPassed}/{c.checksTotal} checks
                </span>
              </div>
            ))}
          </div>

          <h2 className="sec">Activity</h2>
          <div className="log">
            {board.activity.map((a, i) => (
              <div className="log-row" key={i} style={{ gridTemplateColumns: '52px 128px 1fr' }}>
                <span className="t">{a.at}</span>
                <span className="dim">{a.who}</span>
                <span>{a.what}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
