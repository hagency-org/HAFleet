'use client';

import Link from 'next/link';
import PageHead from '@/components/PageHead';
import { useT } from '@/components/Prefs';
import { perfByRole, perfRows, burn } from '@/lib/mock-data';

/*
 * Performance — 考核, reshaped rather than newly measured.
 *
 * The supervisor already evaluates every agent continuously. It answers "does
 * this agent need intervention right now", stored per incident, newest first.
 * A PDU asks "is this employee worth keeping, and is it improving" — the same
 * evidence, aggregated per employee over a period.
 *
 * Three rules keep it from becoming a league table:
 *  - comparison stays inside a role; ranking an architect against a
 *    documentation employee is a category error
 *  - every figure carries n and a confidence read, because a scorecard that
 *    hides its denominator invites a decision from four data points
 *  - what is not the employee's fault gets its own column
 */

function Spark({ values }) {
  const max = Math.max(...values, 1);
  return (
    <span className="spark" aria-hidden="true">
      {values.map((v, i) => (
        <i key={i} style={{ height: `${Math.max(2, Math.round((v / max) * 20))}px` }} />
      ))}
    </span>
  );
}

export default function PerformancePage() {
  const t = useT();
  const groups = perfByRole();
  const rows = perfRows();
  const flagged = rows.filter((r) => r.flagged);
  const total = rows.reduce((n, r) => n + r.n, 0);

  return (
    <>
      <PageHead title={t('pf.title')} sub={t('pf.sub', { n: total })} />

      <div className="notice">{t('pf.withinRole')}</div>

      {groups.map((g) => (
        <section key={g.role}>
          <h2 className="sec">
            {g.role}
            <span className="note">{t('pf.roleNote', { n: g.rows.length })}</span>
          </h2>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('col.employee')}</th>
                  <th className="num">{t('col.accepted')}</th>
                  <th className="num">{t('col.rework')}</th>
                  <th className="num">{t('col.costPerAccepted')}</th>
                  <th className="num">{t('col.timeToAccept')}</th>
                  <th className="num">{t('col.externalWait')}</th>
                  <th>{t('col.trend')}</th>
                </tr>
              </thead>
              <tbody>
                {g.rows.map((r) => (
                  <tr key={r.agent}>
                    <td>
                      <Link href={`/agents/${r.agent}`}>{r.agent}</Link>
                      <div className="faint" style={{ fontSize: 10.5 }}>
                        {t('pf.n', { n: r.n, c: t(`pf.conf.${r.confidence}`) })}
                      </div>
                    </td>
                    <td className="num ok-text">{r.accepted}</td>
                    <td className={`num${r.rework > 1 ? ' warn-text' : ''}`}>{r.rework}</td>
                    <td className="num">
                      {r.costPerAccepted === null
                        ? (
                          <>
                            <span className="mk-dash">—</span>
                            <span className="why-inline">{t('cost.why.planSeat')}</span>
                          </>
                        )
                        : `${burn.currency}${r.costPerAccepted.toFixed(2)}`}
                    </td>
                    <td className="num">{r.timeToAccept}</td>
                    <td className="num dim">
                      {r.externalWait}
                      <span className="why-inline">{t('pf.roomReview')}</span>
                    </td>
                    <td><Spark values={r.trend} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      <h2 className="sec">{t('pf.flagged')}<span className="note">{t('pf.flaggedNote')}</span></h2>
      {flagged.length === 0 ? (
        <div className="notice">{t('pf.noneFlagged')}</div>
      ) : flagged.map((r) => (
        <div className="panel" key={r.agent}>
          <div style={{ display: 'flex', gap: 11, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <span className="wstate throttled"><i aria-hidden="true" />{t('pf.reviewSuggested')}</span>
            <b style={{ fontSize: 13.5 }}>{r.agent}</b>
            <span className="faint" style={{ fontSize: 11.5 }}>
              {t(r.flagReason, r.flagVars)}
            </span>
          </div>
          <dl className="kv" style={{ marginTop: 10 }}>
            <dt>{t('pf.pinned')}</dt>
            <dd>codex 0.42 · codex-default · guidance v3</dd>
            <dt>{t('pf.incidents')}</dt>
            <dd>2 prompt timeouts, 1 session recycle</dd>
            <dt>{t('pf.notAttributable')}</dt>
            <dd className="dim">{r.externalWait} {t('pf.roomReview')}</dd>
            <dt>{t('pf.sample')}</dt>
            <dd className="dim">
              {r.n}
              <span className="why-inline">{t('pf.sampleWhy', { n: 10 })}</span>
            </dd>
          </dl>
          <div className="btn-row" style={{ marginTop: 12 }}>
            <button className="btn" onClick={() => {}}>{t('pf.openEvidence')}</button>
            <Link className="btn" href={`/agents/${r.agent}`}>{t('pf.reviseGuidance')}</Link>
          </div>
        </div>
      ))}
    </>
  );
}
