import Link from 'next/link';
import PageHead from '@/components/PageHead';
import Severity from '@/components/Severity';
import {
  agents, alerts, alertCounts, tasks, queue, reminders, board,
  bySeverityThenAge, fmtSpanSec, isOpenTask,
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

export const metadata = { title: 'Fleet overview — HAFleet' };

export default function OverviewPage() {
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
      <PageHead title="Fleet overview" sub="updated 4s ago" />

      <div className="cards">
        <div className="card">
          <div className="cap">Open alerts</div>
          <div className={`val${byStatus.open > 0 ? ' warn' : ''}`}>{byStatus.open}</div>
        </div>
        <div className="card">
          <div className="cap">Blocked tasks</div>
          <div className={`val${blocked.length > 0 ? ' warn' : ''}`}>{blocked.length}</div>
        </div>
        <div className="card">
          <div className="cap">Queued delivery</div>
          <div className="val">{queue.length}</div>
        </div>
        <div className="card">
          <div className="cap">Agents offline</div>
          <div className={`val${offline.length === 0 ? ' ok' : ' bad'}`}>{offline.length}</div>
        </div>
      </div>

      <h2 className="sec">
        Needs attention
        <span className="note">sorted by severity, then oldest</span>
      </h2>

      {attention.length === 0 ? (
        <div className="notice">Nothing needs attention. Last checked 4s ago.</div>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Severity</th>
                <th>What</th>
                <th>Agent</th>
                <th className="num">Age</th>
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
            Blocked work
            <span className="note">what is waiting, and on what</span>
          </h2>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Assignee</th>
                  <th>Waiting on</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {blocked.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <Link href={`/tasks?task=${t.id}`}>{t.title}</Link>
                      <span className="faint"> {t.id}</span>
                    </td>
                    <td className="dim">{t.assignee ?? 'Unassigned'}</td>
                    <td className="dim">{t.waiting_reason}</td>
                    <td>{t.overdue && <span className="badge overdue">OVERDUE</span>}</td>
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
            Recent activity
            <span className="note">state changes only</span>
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
          <h2 className="sec" style={{ marginTop: 0 }}>Reminders</h2>
          <div className="panel">
            {reminders.map((r) => (
              <div key={r.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', marginBottom: 8 }}>
                <span className="badge">{r.at}</span>
                <span style={{ fontSize: 12.5 }}>{r.text}</span>
              </div>
            ))}
          </div>

          <h2 className="sec">Project</h2>
          <div className="panel">
            <dl className="kv">
              <dt>Group</dt><dd>{board.group}</dd>
              <dt>Open tasks</dt><dd>{tasks.filter(isOpenTask).length}</dd>
              <dt>Dirty worktrees</dt>
              <dd>
                {board.totals.dirtyWorktrees > 0
                  ? <span className="badge attention">{board.totals.dirtyWorktrees} dirty</span>
                  : 'none'}
              </dd>
            </dl>
            <div className="btn-row" style={{ marginTop: 12 }}>
              <Link className="btn" href="/projects">Open project board</Link>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
