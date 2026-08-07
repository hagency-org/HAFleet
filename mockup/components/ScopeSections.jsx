'use client';

import Link from 'next/link';
import { useT } from '@/components/Prefs';
import { Blank } from '@/components/ViewToggle';
import {
  engagementsBy, costBy, perfBy, memoryBy, burn, roleOf,
} from '@/lib/mock-data';

/*
 * The five sections, rendered at any scope.
 *
 * Work · People · Cost · Performance · Memory — 派遣 · 在岗管理 · 成本 · 考核 · 培养.
 * HAFleet's six functions stop being places in the nav and become questions you can
 * ask of a project, of a role, or of one employee. 接入/分类 is not a property of a
 * scope — it is how employees enter the house at all — so it stays global at /onboard.
 *
 * ONE renderer per record, taking a `dim` prop. Two renderers for one record is how
 * lib/project-board.js ended up with two vocabularies for the same task status, and
 * it is how a project's cost total and a role's cost total would come to disagree.
 */

export function WorkSection({ dim, scope, view }) {
  const t = useT();
  const rows = engagementsBy(dim, scope, view);
  if (!rows.length) {
    return <div className="notice">{t(view === 'assigned' ? 'sc.noWork' : 'sc.noWorkLive')}</div>;
  }
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>{t('col.assignment')}</th>
            {dim !== 'project' && <th>{t('col.project')}</th>}
            {dim !== 'role' && <th>{t('col.role')}</th>}
            <th>{t('col.state')}</th>
            <th>{t('col.agent')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id}>
              <td>
                <div>{a.title}</div>
                <span className="dim">{`${a.id} · ${a.workItem}`}</span>
              </td>
              {dim !== 'project' && (
                <td><Link href={`/projects/${a.project}`}>{a.project}</Link></td>
              )}
              {dim !== 'role' && <td className="dim">{roleOf(a.role)?.name ?? a.role}</td>}
              <td>
                <span className={`wstate ${a.state === 'queued' ? 'wait' : a.state === 'executing' ? 'deployed' : 'pend'}`}>
                  {t(`as.state.${a.state}`)}
                </span>
                {/* A template, not a sentence: without the role it renders `{role}` on screen. */}
                {a.blocked && <span className="why-inline">{t(a.blocked, { role: a.role })}</span>}
              </td>
              <td>
                {a.agent
                  ? <Link href={`/agents/${a.agent}`}>{a.agent}</Link>
                  : <Blank why="sc.noStaff" t={t} />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PeopleSection({ people, view }) {
  const t = useT();
  if (!people.length) {
    return <div className="notice">{t(view === 'assigned' ? 'sc.noPeople' : 'sc.noPeopleLive')}</div>;
  }
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>{t('col.agent')}</th>
            <th>{t('og.hasTier')}</th>
            <th>{t('col.role')}</th>
            <th>{t('sc.match')}</th>
          </tr>
        </thead>
        <tbody>
          {people.map((p) => (
            <tr key={p.agent}>
              <td><Link href={`/agents/${p.agent}`}>{p.agent}</Link></td>
              <td>{p.worker.capability}</td>
              <td>{p.role ? <Link href={`/org/${p.role.key}`}>{p.role.name}</Link> : <Blank why="wf.reason.noRole" t={t} />}</td>
              <td>
                {p.match.ok
                  ? (p.match.tierDelta > 0
                    // Over-qualification is reported wherever an allocation is shown,
                    // not only on the org page: floor routes, fix accounts.
                    ? <span className="overqual">{t('sc.overBy', { have: p.worker.capability, need: p.role.minTier })}</span>
                    : <span className="badge ok">{t('sc.exact')}</span>)
                  : <span className="stranded">{t(`sat.${p.match.failedClause}`)}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CostSection({ dim, scope, view }) {
  const t = useT();
  const rows = costBy(dim, view).filter((r) => (scope ? r.key === scope : true));
  if (!rows.length) {
    return <div className="notice">{t(view === 'assigned' ? 'sc.noCost' : 'sc.noCostLive')}</div>;
  }
  return (
    <div className="panel">
      {rows.map((r) => (
        <div className="prov-row" key={r.key}>
          <span className="grow">{r.key}</span>
          <span className="amount">{`${burn.currency}${r.amount.toFixed(2)}`}</span>
          <span className={`prov ${r.provenance}`}>{t(`prov.${r.provenance}`)}</span>
          {/* A plan seat is genuinely not a per-task price. Reporting 0 would claim a
              measurement nobody took; the count of unpriced employees says what is
              actually missing from the total. */}
          {r.unpriced > 0 && <span className="why-inline">{t('sc.unpriced', { n: r.unpriced })}</span>}
        </div>
      ))}
      <div className="prov-row">
        <span className="grow dim">{t('sc.costCaveat')}</span>
      </div>
    </div>
  );
}

export function PerfSection({ dim, scope, view }) {
  const t = useT();
  const rows = perfBy(dim, scope, view);
  if (!rows.length) {
    return <div className="notice">{t(view === 'assigned' ? 'sc.noPerf' : 'sc.noPerfLive')}</div>;
  }
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>{t('col.agent')}</th>
            <th>{t('pf.sample')}</th>
            <th>{t('col.accepted')}</th>
            <th>{t('col.rework')}</th>
            <th>{t('col.timeToAccept')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.agent}>
              <td>
                <Link href={`/agents/${r.agent}`}>{r.agent}</Link>
                {r.flagged && <span className="badge attention">{t(r.flagReason, r.flagVars)}</span>}
              </td>
              {/* Every figure carries its denominator. A scorecard that hides its
                  sample size invites a decision from four data points. */}
              <td>{t('pf.n', { n: r.n, c: t(`pf.conf.${r.confidence}`) })}</td>
              <td>{r.accepted}</td>
              <td>{r.rework}</td>
              <td className="dim">{r.timeToAccept}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MemorySection({ dim, scope, view }) {
  const t = useT();
  const rows = memoryBy(dim, scope, view);
  return (
    <>
      {/* The honest headline of 培养 at any scope above one employee: there is no
          team memory. Memory is per-agent (Letta blocks, agent-knowledge.md) or
          fleet-wide (knowledge/, 16 accepted artifacts) and nothing sits between,
          so the union of members' individual memories is what can be shown — a
          different and weaker thing, named rather than dressed up. */}
      <div className="notice warn">{t('sc.noTeamMemory')}</div>
      {rows.length === 0 ? (
        <div className="notice">{t(view === 'assigned' ? 'sc.noMemory' : 'sc.noMemoryLive')}</div>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr><th>{t('col.agent')}</th><th>{t('kn.citations')}</th><th>{t('col.memory')}</th><th>{t('col.updated')}</th></tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.agent}>
                  <td><Link href={`/agents/${m.agent}`}>{m.agent}</Link></td>
                  <td className={m.citations7d === 0 ? 'warn' : ''}>{m.citations7d}</td>
                  <td><span className="chip-mem">{m.endpoint}</span></td>
                  <td className="dim">{m.updated ?? <Blank why="sc.neverUpdated" t={t} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/**
 * All five, in one order, at any scope. The vocabulary is learned once and used at
 * three altitudes — portfolio, unit, and the employee record below them.
 */
export function ScopeSections({ dim, scope, view, people }) {
  const t = useT();
  return (
    <>
      <h2 className="sec">{t('sc.work')}</h2>
      <WorkSection dim={dim} scope={scope} view={view} />
      <h2 className="sec">{t('sc.people')}</h2>
      <PeopleSection people={people} view={view} />
      <h2 className="sec">{t('sc.cost')}</h2>
      <CostSection dim={dim} scope={scope} view={view} />
      <h2 className="sec">{t('sc.performance')}</h2>
      <PerfSection dim={dim} scope={scope} view={view} />
      <h2 className="sec">{t('sc.memory')}</h2>
      <MemorySection dim={dim} scope={scope} view={view} />
    </>
  );
}
