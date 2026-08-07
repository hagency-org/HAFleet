'use client';

import Link from 'next/link';
import PageHead from '@/components/PageHead';
import { useT } from '@/components/Prefs';
import { useProjectedView, ViewToggle } from '@/components/ViewToggle';
import { ScopeSections } from '@/components/ScopeSections';
import {
  projectOf, stageGaps, allocationRows, LIFECYCLE_STAGES, tasks, TASK_STATUSES,
  byBlockedFirst, agents,
} from '@/lib/mock-data';

/*
 * One project — the unit level of the solid line, and where the reviewer's
 * "Project -> backlog / issues / pr" finally lands.
 *
 * Those three are `specs`, `localIssues` + `remoteIssues`, and `changeRequests`,
 * every one of which lib/project-board.js already computes from the members'
 * worktrees. They are rendered with their source named and WITHOUT controls:
 * HAFleet reads them, the customer owns them in Matrix, and offering a button here
 * would be the same error as offering to accept delivery on the customer's behalf.
 */
export default function ProjectDetail({ projectKey }) {
  const t = useT();
  const [view, choose] = useProjectedView();

  const p = projectOf(projectKey);
  const gaps = stageGaps(projectKey, view);
  const members = new Set(p.members);
  const people = allocationRows(view).filter((a) => members.has(a.agent));
  const projectTasks = tasks.filter((x) => x.assignee && members.has(x.assignee));
  const lanes = TASK_STATUSES.map((s) => ({ status: s, items: projectTasks.filter((x) => x.status === s) }));
  const online = p.members.filter((m) => agents.find((a) => a.name === m)?.alive !== false).length;
  const working = p.members.filter((m) => agents.find((a) => a.name === m)?.activeNow).length;

  return (
    <>
      <PageHead title={p.key} sub={t('pd.sub', { room: p.room, owner: p.owner })}>
        <ViewToggle view={view} choose={choose} />
      </PageHead>

      {view === 'assigned' && <div className="notice warn">{t('pp.hypothetical')}</div>}

      {/* A staffing gap is a different fact from a queue. Three of this project's
          queued assignments say "nobody holds the architect role"; the gap strip
          says which whole lifecycle stages have nobody at all, which is a hiring
          decision rather than a scheduling one. */}
      {gaps.length > 0 && (
        <div className="notice warn">
          {t('pd.gaps', { stages: gaps.map((s) => t(`stage.${s}`)).join(' · ') })}
        </div>
      )}

      <div className="cards">
        <div className="card"><div className="cap">{t('pj.members')}</div><div className="val">{p.members.length}</div></div>
        <div className="card"><div className="cap">{t('pj.online')}</div><div className="val ok">{online}</div></div>
        <div className="card"><div className="cap">{t('pj.working')}</div><div className="val">{working}</div></div>
        <div className="card"><div className="cap">{t('pj.openTasks')}</div><div className="val">{projectTasks.filter((x) => x.status !== 'done').length}</div></div>
        <div className="card"><div className="cap">{t('pj.worktrees')}</div><div className="val">{p.summary.worktrees}</div></div>
        <div className="card">
          <div className="cap">{t('pj.dirty')}</div>
          <div className={`val${p.summary.dirtyWorktrees > 0 ? ' warn' : ''}`}>{p.summary.dirtyWorktrees}</div>
        </div>
      </div>

      <h2 className="sec">{t('pd.coverage')}</h2>
      <div className="panel">
        <div className="stages big">
          {LIFECYCLE_STAGES.map((s) => (
            <span key={s} className={`stg${gaps.includes(s) ? ' gap' : ' held'}`}>{t(`stage.${s}`)}</span>
          ))}
        </div>
        <div className="prov-row"><span className="grow dim">{t('pd.coverageNote')}</span></div>
      </div>

      <ScopeSections dim="project" scope={projectKey} view={view} people={people} />

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
                  <span className="who">{`${x.assignee} · ${x.priority}`}</span>
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Read from worktrees, owned in Matrix, rendered without controls. */}
      <h2 className="sec">{t('pd.customerOwned')}<span className="note">{t('pd.customerOwnedNote')}</span></h2>
      <div className="cards" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <div className="card"><div className="cap">{t('pj.specs')}</div><div className="val">{p.summary.specs}</div></div>
        <div className="card"><div className="cap">{t('pj.local')}</div><div className="val">{p.summary.localIssues}</div></div>
        <div className="card"><div className="cap">{t('pj.remote')}</div><div className="val">{p.summary.remoteIssues}</div></div>
      </div>

      <h2 className="sec">{t('pj.repos')}</h2>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr><th>{t('col.repo')}</th><th>{t('col.branch')}</th><th>{t('col.state')}</th></tr></thead>
          <tbody>
            {p.repos.map((r) => (
              <tr key={r.repo}>
                <td>{r.repo}</td>
                <td className="dim">{r.branch}</td>
                <td><span className={`badge${r.state === 'dirty' ? ' attention' : ' ok'}`}>{r.state}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="sec">{t('pj.changes')}</h2>
      <div className="panel">
        {p.changeRequests.map((c) => (
          <div className="prov-row" key={c.title}>
            <span className="grow">{c.title}</span>
            <span className={c.checksPassed === c.checksTotal ? 'badge ok' : 'badge'}>
              {t('pj.nChecks', { a: c.checksPassed, b: c.checksTotal })}
            </span>
          </div>
        ))}
      </div>

      <h2 className="sec">{t('pj.activity')}</h2>
      <div className="log">
        {p.activity.map((a, i) => (
          <div className="log-row" key={i} style={{ gridTemplateColumns: '52px 128px 1fr' }}>
            <span className="t">{a.at}</span>
            <span className="dim">{a.who}</span>
            <span>{a.what}</span>
          </div>
        ))}
      </div>

      <p className="dim" style={{ fontSize: 12, marginTop: 18 }}>
        <Link href="/projects">{t('pd.back')}</Link>
      </p>
    </>
  );
}
