'use client';

import { useState } from 'react';
import Link from 'next/link';
import PageHead from '@/components/PageHead';
import { Toast, useToast } from '@/components/Toast';
import { board, tasks, TASK_STATUSES, byBlockedFirst } from '@/lib/mock-data';
import { useT } from '@/components/Prefs';

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
  const t = useT();
  const [toast, say] = useToast();
  const [group, setGroup] = useState(board.group);
  const totals = board.totals;
  const lanes = TASK_STATUSES.map((s) => ({ status: s, items: tasks.filter((x) => x.status === s) }));

  return (
    <>
      <PageHead title={t('pj.title')} sub={t('pj.sub', { n: '12s' })}>
        <label style={{ fontSize: 12, color: 'var(--ink-dim)' }}>
          {t('pj.group')}{' '}
          <select value={group} onChange={(e) => setGroup(e.target.value)}>
            {board.groups.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </label>
        <button className="btn" onClick={() => say('ok', t('act.refreshed'))}>{t('act.refresh')}</button>
      </PageHead>

      <div className="cards">
        <div className="card"><div className="cap">{t('pj.members')}</div><div className="val">{totals.members}</div></div>
        <div className="card"><div className="cap">{t('pj.online')}</div><div className="val ok">{totals.online}</div></div>
        <div className="card"><div className="cap">{t('pj.working')}</div><div className="val">{totals.working}</div></div>
        <div className="card"><div className="cap">{t('pj.openTasks')}</div><div className="val">{totals.openTasks}</div></div>
        <div className="card"><div className="cap">{t('pj.worktrees')}</div><div className="val">{totals.worktrees}</div></div>
        <div className="card">
          <div className="cap">{t('pj.dirty')}</div>
          <div className={`val${totals.dirtyWorktrees > 0 ? ' warn' : ''}`}>{totals.dirtyWorktrees}</div>
        </div>
      </div>

      <div className="split wide-left" style={{ marginTop: 4 }}>
        <div>
          <h2 className="sec">{t('pj.taskBoard')}<span className="note">{t('pj.laneNote')}</span></h2>
          <div className="lanes">
            {lanes.map((l) => (
              <div className={`lane${l.status === 'blocked' ? ' blocked' : ''}`} key={l.status}>
                <h4>
                  <span>{t(`pj.lane.${l.status}`)}</span>
                  <span className="dim">{l.items.length}</span>
                </h4>
                <div className="cards-in">
                  {[...l.items].sort(byBlockedFirst).map((x) => (
                    <Link className="mini" key={x.id} href={`/tasks?task=${x.id}`}>
                      {x.title}
                      <span className="who">{`${x.assignee ?? t('tk.unassigned')} · ${x.priority}`}</span>
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <h2 className="sec">{t('pj.repos')}</h2>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>{t('col.repo')}</th><th>{t('col.branch')}</th><th>{t('col.state')}</th></tr></thead>
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
          <h2 className="sec" style={{ marginTop: 0 }}>{t('pj.members')}</h2>
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

          <h2 className="sec">{t('pj.specs')}</h2>
          <div className="cards" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <div className="card"><div className="cap">{t('pj.local')}</div><div className="val">{totals.localIssues}</div></div>
            <div className="card"><div className="cap">{t('pj.remote')}</div><div className="val">{totals.remoteIssues}</div></div>
          </div>

          <h2 className="sec">{t('pj.changes')}</h2>
          <div className="panel">
            {board.changes.map((c) => (
              <div key={c.title} style={{ display: 'flex', gap: 10, marginBottom: 8, fontSize: 12.5 }}>
                <span style={{ flex: 1 }}>{c.title}</span>
                <span className={c.checksPassed === c.checksTotal ? 'badge ok' : 'badge'}>
                  {t('pj.nChecks', { a: c.checksPassed, b: c.checksTotal })}
                </span>
              </div>
            ))}
          </div>

          <h2 className="sec">{t('pj.activity')}</h2>
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

      <Toast toast={toast} />
    </>
  );
}
