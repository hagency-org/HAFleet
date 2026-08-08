'use client';

import Link from 'next/link';
import PageHead from '@/components/PageHead';
import { Blank } from '@/components/Blank';
import { useT } from '@/components/Prefs';
import {
  agents, presetOf, tierOf, familyOf, committed, remaining, fmtTokens,
  runtimeStatusText, presets, capability,
} from '@/lib/mock-data';

/*
 * ① 我的资源 — L1, and the home route.
 *
 * The contributor's own question, in order: what am I lending, on what terms, and
 * how much of it is already promised away.
 *
 * Two honest states this page has to carry, both true of a real host:
 *
 *  - An agent with **no preset** contributes nothing. It is registered, running,
 *    and useless, because nobody chose a model for it. That is not an edge case —
 *    it is what every agent looks like before this console exists, since no
 *    onboarding path writes a preset today.
 *  - **Spend is not measured.** HAFleet meters no tokens at any granularity, so
 *    every consumption figure here is a dash with a reason. A `0` would claim a
 *    measurement nobody takes, which is the difference between "this cost me
 *    nothing" and "I cannot see what this cost me".
 *
 * What IS real: `committed` — the sum of budgets I have allocated to active
 * engagements. I know what I promised even though I cannot see what was used.
 */
export default function ResourcesPage() {
  const t = useT();
  const configured = agents.filter((a) => a.presetId);
  const bare = agents.filter((a) => !a.presetId);
  const fillable = capability().filter((c) => c.able.length > 0 && c.crossFamilyOk).length;
  const totalCeiling = configured.reduce((n, a) => n + (presetOf(a)?.ceiling.tokens ?? 0), 0);
  const totalCommitted = configured.reduce((n, a) => n + committed(a.name), 0);

  return (
    <>
      <PageHead title={t('rs.title')} sub={t('rs.sub')}>
        <Link className="btn primary" href="/resources/new">{t('rs.configure')}</Link>
      </PageHead>

      {bare.length > 0 && (
        <div className="notice warn">{t('rs.bareWarn', { n: bare.length })}</div>
      )}

      <div className="cards">
        <div className="card"><div className="cap">{t('rs.cAgents')}</div><div className="val">{agents.length}</div></div>
        <div className="card">
          <div className="cap">{t('rs.cConfigured')}</div>
          <div className={`val${bare.length > 0 ? ' warn' : ''}`}>
            {configured.length}<small> {t('rs.ofN', { n: agents.length })}</small>
          </div>
        </div>
        <div className="card"><div className="cap">{t('rs.cFillable')}</div><div className="val">{fillable}<small> {t('rs.ofRoles', { n: 6 })}</small></div></div>
        <div className="card">
          <div className="cap">{t('rs.cCeiling')}</div>
          <div className="val">{fmtTokens(totalCeiling)}<small> /{t('rs.monthly')}</small></div>
        </div>
        <div className="card">
          <div className="cap">{t('rs.cCommitted')}</div>
          <div className="val">{fmtTokens(totalCommitted)}</div>
        </div>
      </div>

      <h2 className="sec">{t('rs.roster')}<span className="note">{t('rs.rosterNote')}</span></h2>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t('col.agent')}</th>
              <th>{t('col.contributes')}</th>
              <th>{t('col.tier')}</th>
              <th>{t('col.ceiling')}</th>
              <th>{t('col.committed')}</th>
              <th>{t('col.used')}</th>
              <th>{t('col.state')}</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => {
              const p = presetOf(a);
              const tier = tierOf(p);
              const left = remaining(a.name);
              const used = committed(a.name);
              const pct = p ? Math.round((used / p.ceiling.tokens) * 100) : 0;
              return (
                <tr key={a.name}>
                  <td>
                    <div><Link href={`/agents/${a.name}`}>{a.name}</Link></div>
                    <span className="dim">{`${a.framework} · ${a.transport}`}</span>
                  </td>
                  <td>
                    {p ? (
                      <>
                        <div className="mono-s">{p.model}</div>
                        <span className="dim">
                          {p.reasoning ? `${p.provider} · ${t('col.reasoning')} ${p.reasoning}` : p.provider}
                        </span>
                      </>
                    ) : <Blank why="rs.why.noPreset" t={t} />}
                  </td>
                  <td>
                    {tier
                      ? <><span className={`tierchip ${tier}`}>{tier}</span><span className="dim"> {familyOf(p)}</span></>
                      : <Blank why="rs.why.noTier" t={t} />}
                  </td>
                  <td>
                    {p ? (
                      <>
                        <span className="amount">{fmtTokens(p.ceiling.tokens)}</span>
                        {/* Stated, not implied: a ceiling nothing enforces is a
                            declaration of intent, and a reader who assumes it is
                            a guard rail will over-commit. */}
                        {!p.ceiling.enforced && <span className="badge warn-b">{t('rs.notEnforced')}</span>}
                      </>
                    ) : <Blank why="rs.why.noPreset" t={t} />}
                  </td>
                  <td>
                    {p ? (
                      <>
                        <span className="amount">{fmtTokens(used)}</span>
                        <span className="meter"><i style={{ width: `${Math.min(100, pct)}%` }} /></span>
                        <span className="dim">{t('rs.leftN', { n: fmtTokens(left) })}</span>
                      </>
                    ) : <Blank why="rs.why.noPreset" t={t} />}
                  </td>
                  {/* The whole column is a blank with one reason, because the
                      absence is systemic rather than per-row. */}
                  <td><Blank why="rs.why.notMetered" t={t} /></td>
                  <td><span className="dim">{runtimeStatusText(a)}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h2 className="sec">{t('rs.presets')}<span className="note">{t('rs.presetsNote')}</span></h2>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t('col.preset')}</th>
              <th>{t('col.framework')}</th>
              <th>{t('col.model')}</th>
              <th>{t('col.reasoning')}</th>
              <th>{t('col.ceiling')}</th>
              <th>{t('col.rateCap')}</th>
              <th>{t('col.usedBy')}</th>
            </tr>
          </thead>
          <tbody>
            {presets.map((p) => {
              const users = agents.filter((a) => a.presetId === p.id);
              return (
                <tr key={p.id}>
                  <td>{p.name}<span className="dim">{p.id}</span></td>
                  <td>{p.framework}</td>
                  <td className="mono-s">{p.model}</td>
                  <td>{p.reasoning ?? <Blank why="rs.why.noReasoning" t={t} />}</td>
                  <td className="amount">{fmtTokens(p.ceiling.tokens)}</td>
                  <td>
                    {p.ceiling.rateCapPerDay
                      ? <span className="amount">{`${fmtTokens(p.ceiling.rateCapPerDay)}/d`}</span>
                      : <Blank why="rs.why.noRateCap" t={t} />}
                  </td>
                  <td>
                    {users.length
                      ? users.map((u) => <Link className="chip-role" key={u.name} href={`/agents/${u.name}`}>{u.name}</Link>)
                      : <Blank why="rs.why.unusedPreset" t={t} />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="notice">{t('rs.meterGap')}</div>
    </>
  );
}
