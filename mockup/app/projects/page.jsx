'use client';

import Link from 'next/link';
import PageHead from '@/components/PageHead';
import { useT } from '@/components/Prefs';
import { useProjectedView, ViewToggle, Blank } from '@/components/ViewToggle';
import {
  projects, engagementsBy, costBy, stageGaps, LIFECYCLE_STAGES, burn,
} from '@/lib/mock-data';

/*
 * Projects — the SOLID line, and the PDT owner's entrance.
 *
 * The previous version of this page rendered ONE group, selected from a dropdown,
 * with no portfolio above it. A product-line owner arrives holding a project and
 * asking which are at risk; there was no row to compare.
 *
 * What HAFleet legitimately knows about a project it knows through the group: the
 * backend already maps groups to projects and hangs worktrees, specs, issues,
 * change requests and task lanes off each one. What it does NOT know is which of
 * its employees is deployed on which project — group membership is not deployment,
 * a lease carries no project, and a dispatch ticket's `room` is optional and never
 * read back. So the staffing columns here are the projected view's, and the page
 * says so rather than implying the join exists.
 */

/** Which lifecycle stages nobody holds. Only computable because both lenses exist. */
function StageStrip({ gaps, t }) {
  return (
    <span className="stages">
      {LIFECYCLE_STAGES.map((s) => (
        <span key={s} className={`stg${gaps.includes(s) ? ' gap' : ' held'}`}>
          {t(`stage.${s}`)}
        </span>
      ))}
    </span>
  );
}

export default function ProjectsPage() {
  const t = useT();
  const [view, choose] = useProjectedView();

  // Zero on this fleet, and that is a fact about ownership rather than an empty
  // database: groups are written by the Matrix bridge (requireBridgeSecret guards
  // every mutating route), so a project appears when the customer bridges a room.
  const rows = view === 'assigned' ? projects : [];
  const spend = costBy('project', view);

  return (
    <>
      <PageHead title={t('pp.title')} sub={t('pp.sub')}>
        <ViewToggle view={view} choose={choose} />
      </PageHead>

      {view === 'assigned' && <div className="notice warn">{t('pp.hypothetical')}</div>}

      {rows.length === 0 ? (
        <div className="notice warn">{t('pp.noneBridged')}</div>
      ) : (
        <div className="cards">
          <div className="card"><div className="cap">{t('pp.cProjects')}</div><div className="val">{rows.length}</div></div>
          <div className="card">
            <div className="cap">{t('pp.cQueued')}</div>
            <div className="val warn">
              {rows.reduce((n, p) => n + engagementsBy('project', p.key, view).filter((a) => a.state === 'queued').length, 0)}
            </div>
          </div>
          <div className="card">
            <div className="cap">{t('pp.cGaps')}</div>
            <div className="val warn">{rows.reduce((n, p) => n + stageGaps(p.key, view).length, 0)}</div>
          </div>
          <div className="card">
            <div className="cap">{t('pp.cSpend')}</div>
            <div className="val">
              {`${burn.currency}${spend.reduce((s, r) => s + r.amount, 0).toFixed(2)}`}
            </div>
          </div>
        </div>
      )}

      <h2 className="sec">{t('pp.portfolio')}<span className="note">{t('pp.portfolioNote')}</span></h2>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t('col.project')}</th>
              <th>{t('pp.team')}</th>
              <th>{t('pp.executing')}</th>
              <th>{t('pp.queued')}</th>
              <th>{t('pp.staffing')}</th>
              <th>{t('pp.spend')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const work = engagementsBy('project', p.key, view);
              const gaps = stageGaps(p.key, view);
              const cost = spend.find((s) => s.key === p.key);
              return (
                <tr key={p.key}>
                  <td>
                    <div><Link href={`/projects/${p.key}`}>{p.key}</Link></div>
                    <span className="dim">{`${p.room} · ${p.owner}`}</span>
                  </td>
                  <td>{p.members.length}</td>
                  <td>{work.filter((a) => a.state === 'executing').length}</td>
                  <td className={work.some((a) => a.state === 'queued') ? 'warn' : ''}>
                    {work.filter((a) => a.state === 'queued').length}
                  </td>
                  {/* The staffing gap is the first thing the two lenses produce
                      together: only computable because the dotted line knows the
                      roles and the solid line knows the project. */}
                  <td><StageStrip gaps={gaps} t={t} /></td>
                  <td>
                    {cost
                      ? (<>
                        <span className="amount">{`${burn.currency}${cost.amount.toFixed(2)}`}</span>
                        <span className={`prov ${cost.provenance}`}>{t(`prov.${cost.provenance}`)}</span>
                      </>)
                      : <Blank why="pp.noSpend" t={t} />}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={6} className="dim">{t('pp.emptyRow')}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="notice">{t('pp.ownership')}</div>
    </>
  );
}
