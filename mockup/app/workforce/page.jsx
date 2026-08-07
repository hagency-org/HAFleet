'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import PageHead from '@/components/PageHead';
import Severity from '@/components/Severity';
import { useT } from '@/components/Prefs';
import { Blank } from '@/components/ViewToggle';
import {
  workforce, workforceCounts, burn, costToday, alerts, bySeverityThenAge, fmtSpanSec,
} from '@/lib/mock-data';

/*
 * Workforce — the home route, and the page the old monitor was not.
 *
 * The monitor opened on "NO AGENT SELECTED" and made you click each agent to
 * find out anything. This opens on the whole staff, one row each, answering the
 * five standing questions before any drill-down:
 *
 *   在干什么 · 给谁干 · 干到什么地步 · 成本开支 · 健康状态
 *
 * Two rules do most of the work here:
 *
 *  - A blank is never a zero. Every em dash is followed by its reason, because
 *    `0` claims a measurement that was never taken — the difference between "this
 *    employee cost nothing" and "we have no way to price a plan seat".
 *  - State axes stay separate. THROTTLED is a capacity state on a *healthy*
 *    employee; collapsing it into health sends someone to restart a working
 *    process, and collapsing it into a colour loses it entirely.
 */

export default function WorkforcePage() {
  const t = useT();
  const [view, setView] = useState('unassigned');

  // Same contract as Capacity: the view is a selection, so it round-trips
  // through the URL — linkable, survives a reload, and reachable by a test or a
  // screenshot script, which is how the populated grid stopped being invisible
  // to the responsive sweep.
  useEffect(() => {
    const read = () => setView(
      new URLSearchParams(window.location.search).get('view') === 'assigned'
        ? 'assigned'
        : 'unassigned',
    );
    read();
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, []);

  function choose(next) {
    setView(next);
    window.history.pushState(null, '', next === 'assigned' ? '?view=assigned' : window.location.pathname);
  }

  const staff = workforce(view);
  const c = workforceCounts(view);
  const attention = [...alerts.filter((a) => a.status === 'open')].sort(bySeverityThenAge).slice(0, 3);
  const stranded = staff.filter((s) => s.state === 'unassigned');

  return (
    <>
      <PageHead title={t('wf.title')} sub={t('common.updatedAgo', { n: '8s' })}>
        <div className="prefs-row" role="group" aria-label={t('cap.viewNote')}>
          {[['unassigned', t('cap.viewNow')], ['assigned', t('cap.viewAssigned')]].map(([k, label]) => (
            <button key={k} className="seg" aria-pressed={view === k} onClick={() => choose(k)}>
              {label}
            </button>
          ))}
        </div>
      </PageHead>

      {/* The label travels with the view, not with the header alone: a roster
          full of deployed employees is exactly what makes a reader believe the
          fleet is staffed. */}
      {view === 'assigned' && <div className="notice warn">{t('cap.assignedHypothetical')}</div>}

      <div className="cards">
        <div className="card"><div className="cap">{t('wf.hired')}</div><div className="val">{c.hired}</div></div>
        <div className="card">
          <div className="cap">{t('wf.deployed')}</div>
          <div className={`val${c.deployed > 0 ? ' ok' : ''}`}>
            {c.deployed}
            <small> {t('wf.ofQualified', { n: c.qualified })}</small>
          </div>
        </div>
        <div className="card"><div className="cap">{t('wf.idle')}</div><div className="val">{c.idle}</div></div>
        <div className="card">
          <div className="cap">{t('wf.unassigned')}</div>
          <div className={`val${c.unassigned > 0 ? ' warn' : ''}`}>{c.unassigned}</div>
        </div>
        <div className="card">
          <div className="cap">{t('wf.costToday')}</div>
          {/* No staffed employee means no work and therefore no spend. Carrying
              the hypothetical view's burn into the honest one would have the
              roster report ¥14.25 against a workforce that cannot be staffed. */}
          <div className="val">
            {c.qualified === 0
              ? <Blank why="wf.reason.noWork" t={t} />
              : (
                <>
                  {`${burn.currency}${costToday().toFixed(2)}`}
                  <small> {t('wf.covered', { n: burn.coveragePct })}</small>
                </>
              )}
          </div>
        </div>
      </div>

      <h2 className="sec">
        {t('wf.title')}
        <span className="note">{t('wf.rosterNote')}</span>
      </h2>

      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t('col.employee')}</th>
              <th>{t('col.roleTier')}</th>
              <th>{t('col.state')}</th>
              <th>{t('col.workingFor')}</th>
              <th className="num">{t('col.since')}</th>
              <th className="num">{t('col.util')}</th>
              <th className="num">{t('col.costToday')}</th>
            </tr>
          </thead>
          <tbody>
            {staff.map((s) => (
              <tr key={s.name}>
                <td>
                  <Link href={`/agents/${s.name}`}>{s.name}</Link>
                  <div className="faint" style={{ fontSize: 11 }}>
                    {`${s.framework} · ${s.transport === 'acp' ? 'ACP' : 'tmux'}`}
                  </div>
                </td>
                <td>
                  {s.cell ? `${s.cell.role} · ${s.cell.tier}` : <Blank why={s.blankReason} t={t} />}
                  {s.qualifiedAgo && (
                    <div className="faint" style={{ fontSize: 10.5 }}>
                      {t('wf.qualifiedAgo', { n: s.qualifiedAgo })}
                    </div>
                  )}
                </td>
                <td>
                  <span className={`wstate ${s.state}`}>
                    <i aria-hidden="true" />
                    {t(`wf.state.${s.state}`)}
                  </span>
                  {s.state === 'throttled' && s.seat && (
                    <div className="faint" style={{ fontSize: 10.5 }}>
                      {t('cap.resetsIn', { n: s.seat.resetsIn })}
                    </div>
                  )}
                  {s.state === 'unassigned' && (
                    <div className="faint" style={{ fontSize: 10.5 }}>{t('wf.reason.healthyIneligible')}</div>
                  )}
                </td>
                <td>
                  {s.assignment ? (
                    <>
                      <span className="mono-s">{s.assignment.room}</span>
                      <div className="faint" style={{ fontSize: 10.5 }}>
                        {`${s.assignment.workItem} · ${s.assignment.title}`}
                      </div>
                    </>
                  ) : (
                    <Blank why={s.state === 'unassigned' ? 'wf.reason.cannotStaff' : 'wf.reason.available'} t={t} />
                  )}
                </td>
                <td className="num dim">{fmtSpanSec(s.activeNow ? s.activeDurationSec : s.idleDurationSec)}</td>
                <td className="num">
                  {s.util7d === null
                    ? <Blank why="wf.reason.noIntervals" t={t} />
                    : (
                      <>
                        {`${s.util7d}%`}
                        <span className="meter" aria-hidden="true">
                          <i className={s.util7d > 50 ? 'ok' : ''} style={{ width: `${s.util7d}%` }} />
                        </span>
                      </>
                    )}
                </td>
                <td className="num">
                  {s.costToday === null
                    ? (
                      <Blank
                        why={!s.cell ? 'wf.reason.noWork'
                          : s.seat ? 'wf.reason.planSeat' : 'wf.reason.noSeat'}
                        t={t}
                      />
                    )
                    : (
                      <>
                        {`${burn.currency}${s.costToday.toFixed(2)}`}
                        <span className="prov">{t(`prov.${s.provenance}`)}</span>
                      </>
                    )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {stranded.length > 0 && (
        <div className="notice warn">
          {t('wf.notStaffable', { n: stranded.length })}{' '}
          <Link href="/onboard">{t('wf.openHire')}</Link>
        </div>
      )}

      <h2 className="sec">{t('wf.needsAttention')}<span className="note">{t('ov.sortedBySeverity')}</span></h2>
      {attention.length === 0 ? (
        <div className="notice">{t('ov.nothing', { n: '8s' })}</div>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('col.severity')}</th><th>{t('col.what')}</th>
                <th>{t('col.agent')}</th><th className="num">{t('col.age')}</th>
              </tr>
            </thead>
            <tbody>
              {attention.map((a) => (
                <tr key={a.id}>
                  <td><Severity level={a.severity} /></td>
                  <td><Link href={`/alerts?alert=${a.id}`}>{a.summary}</Link></td>
                  <td><Link href={`/agents/${a.agent}`} className="dim">{a.agent}</Link></td>
                  <td className="num dim">{fmtSpanSec(a.ageSec)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
