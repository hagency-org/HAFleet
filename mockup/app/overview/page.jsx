'use client';

import Link from 'next/link';
import PageHead from '@/components/PageHead';
import Severity from '@/components/Severity';
import { useT } from '@/components/Prefs';
import {
  agents, alerts, alertCounts, tasks, queue, reminders, board,
  bySeverityThenAge, fmtSpanSec, isOpenTask,
  fmtIn,
} from '@/lib/mock-data';

/*
 * Fleet overview — the page that did not exist.
 *
 * The old monitor opened on "Select an agent to monitor" / "NO AGENT SELECTED"
 * and computed state only after selection, so finding trouble meant clicking
 * every agent in turn. Both reviewers called that the top finding.
 *
 * Rules this page obeys:
 *  - ranked by severity, because ranking is its entire job. Round 2's mockup
 *    claimed to rank and then sorted by age.
 *  - every row carries the severity WORD next to its dot
 *  - "Recent activity" shows state changes only. Half the round-2 mockup was
 *    heartbeat-OK chatter on a triage surface.
 */

export default function OverviewPage() {
  const t = useT();
  const { byStatus } = alertCounts();
  const blocked = tasks.filter((t) => t.status === 'blocked');
  const offline = agents.filter((a) => a.alive === false);
  const attention = [...alerts.filter((a) => a.status === 'open')].sort(bySeverityThenAge);

  const activity = [
    { at: '01:22', who: 'octos-agent', what: 'task tk_0044 accepted' },
    { at: '01:14', who: 'hermes-agent', what: 'session resumed after restart' },
    { at: '00:47', who: 'codex-acp-agent', what: 'session recycled after prompt timeout' },
  ];

  return (
    <>
      <PageHead title={t('ov.title')} sub={t('common.updatedAgo', { n: '4s' })} />

      <div className="cards">
        <div className="card">
          <div className="cap">{t('ov.openAlerts')}</div>
          <div className={`val${byStatus.open > 0 ? ' warn' : ''}`}>{byStatus.open}</div>
        </div>
        <div className="card">
          <div className="cap">{t('ov.blockedTasks')}</div>
          <div className={`val${blocked.length > 0 ? ' warn' : ''}`}>{blocked.length}</div>
        </div>
        <div className="card">
          <div className="cap">{t('ov.queuedDelivery')}</div>
          <div className="val">{queue.length}</div>
        </div>
        <div className="card">
          <div className="cap">{t('ov.agentsOffline')}</div>
          <div className={`val${offline.length === 0 ? ' ok' : ' bad'}`}>{offline.length}</div>
        </div>
      </div>

      <h2 className="sec">
        {t('ov.needsAttention')}
        <span className="note">{t('ov.sortedBySeverity')}</span>
      </h2>

      {attention.length === 0 ? (
        <div className="notice">{t('ov.nothing', { n: '4s' })}</div>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('col.severity')}</th>
                <th>{t('col.what')}</th>
                <th>{t('col.agent')}</th>
                <th className="num">{t('col.age')}</th>
              </tr>
            </thead>
            <tbody>
              {attention.map((a) => (
                <tr key={a.id}>
                  <td><Severity level={a.severity} /></td>
                  <td>
                    <Link href={`/alerts?alert=${a.id}`}>{a.summary}</Link>
                  </td>
                  <td><Link href={`/agents/${a.agent}`} className="dim">{a.agent}</Link></td>
                  <td className="num dim">{fmtSpanSec(a.ageSec)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {blocked.length > 0 && (
        <>
          <h2 className="sec">
            {t('ov.blockedWork')}
            <span className="note">{t('ov.blockedNote')}</span>
          </h2>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('col.task')}</th>
                  <th>{t('col.assignee')}</th>
                  <th>{t('col.waitingOn')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {blocked.map((t2) => (
                  <tr key={t2.id}>
                    <td>
                      <Link href={`/tasks?task=${t2.id}`}>{t2.title}</Link>
                      <span className="faint"> {t2.id}</span>
                    </td>
                    <td className="dim">{t2.assignee ?? t('tk.unassigned')}</td>
                    <td className="dim">{t2.waiting_reason}</td>
                    <td>{t2.overdue && <span className="badge overdue">{t('ov.overdue')}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="split" style={{ marginTop: 26 }}>
        <div>
          <h2 className="sec" style={{ marginTop: 0 }}>
            {t('ov.recentActivity')}
            <span className="note">{t('ov.stateChangesOnly')}</span>
          </h2>
          <div className="log">
            {activity.map((r, i) => (
              <div className="log-row" key={i} style={{ gridTemplateColumns: '64px 132px 1fr' }}>
                <span className="t">{r.at}</span>
                <span className="dim">{r.who}</span>
                <span>{r.what}</span>
              </div>
            ))}
          </div>
        </div>

        <div>
          <h2 className="sec" style={{ marginTop: 0 }}>{t('ov.reminders')}</h2>
          <div className="panel">
            {reminders.map((r) => (
              <div key={r.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', marginBottom: 8 }}>
                <span className="badge">{fmtIn(r.inMinutes, t)}</span>
                <span style={{ fontSize: 12.5 }}>{r.text}</span>
              </div>
            ))}
          </div>

          <h2 className="sec">{t('ov.project')}</h2>
          <div className="panel">
            <dl className="kv">
              <dt>{t('pj.group')}</dt><dd>{board.group}</dd>
              <dt>{t('pj.openTasks')}</dt><dd>{tasks.filter(isOpenTask).length}</dd>
              <dt>{t('ov.dirtyWorktrees')}</dt>
              <dd>
                {board.totals.dirtyWorktrees > 0
                  ? <span className="badge attention">{t('ov.nDirty', { n: board.totals.dirtyWorktrees })}</span>
                  : t('common.none')}
              </dd>
            </dl>
            <div className="btn-row" style={{ marginTop: 12 }}>
              <Link className="btn" href="/projects">{t('ov.openBoard')}</Link>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
