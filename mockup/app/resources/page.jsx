'use client';

import Link from 'next/link';
import PageHead from '@/components/PageHead';
import { Blank } from '@/components/Blank';
import { useT } from '@/components/Prefs';
import { useData, Provenance } from '@/components/Data';
// Pure formatters only: they take a number and return a string, so they have no
// data source to belong to. Everything data-dependent comes from useData().
import { fmtTokens, runtimeStatusText } from '@/lib/mock-data';

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
 *
 * A CEILING MAY NOT EXIST. It does now — POST /api/framework-presets persists one,
 * where it previously accepted a `ceiling` with 200 and dropped it because the
 * record was built from a closed field list. But a preset saved before the field
 * existed still has none, so every ceiling cell has to survive that and say which
 * of the two absences it is: "no model chosen" or "no ceiling field upstream".
 *
 * AND A CEILING IS NOT A QUOTA. The seats section below is the reason: two agents
 * on one credential home share one subscription, so two 5.0M ceilings on this page
 * can be ten million promised out of a seat that holds six.
 */
export default function ResourcesPage() {
  const t = useT();
  const {
    agents, presets, presetOf, tierOf, familyOf, committed, remaining, capability,
    seats = [], seatKeyed,
  } = useData();

  const configured = agents.filter((a) => a.presetId);
  const bare = agents.filter((a) => !a.presetId);
  const fillable = capability().filter((c) => c.able.length > 0 && c.crossFamilyOk).length;

  // Summed over the presets that HAVE a ceiling, with the rest counted rather
  // than treated as zero. A total that quietly folded in missing ceilings as 0
  // would understate what is being lent and read as a measurement.
  const withCeiling = configured.filter((a) => presetOf(a)?.ceiling);
  const totalCeiling = withCeiling.reduce((n, a) => n + presetOf(a).ceiling.tokens, 0);
  const noCeilingCount = presets.filter((p) => !p.ceiling).length;
  const totalCommitted = configured.reduce((n, a) => n + committed(a.name), 0);

  return (
    <>
      <PageHead title={t('rs.title')} sub={t('rs.sub')}>
        <Link className="btn primary" href="/resources/new">{t('rs.configure')}</Link>
      </PageHead>

      <Provenance slices={['agents', 'presets', 'ceilings', 'seats', 'engagements']} />

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
          {withCeiling.length === 0
            ? <div className="val"><Blank why="rs.why.noCeilingSum" t={t} /></div>
            : (
              <div className="val">
                {fmtTokens(totalCeiling)}<small> /{t('rs.monthly')}</small>
                {noCeilingCount > 0 && (
                  <span className="dim">{t('rs.ceilingPartial', { n: noCeilingCount, of: presets.length })}</span>
                )}
              </div>
            )}
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
              // Percent-of-ceiling only means something when there is a ceiling.
              // Without one there is no denominator, so the meter is not drawn at
              // all rather than drawn empty — an empty bar reads as "0% used".
              const pct = p?.ceiling ? Math.round((used / p.ceiling.tokens) * 100) : null;
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
                  {/* Three distinct states, and conflating any two of them would
                      mislead: no preset at all, a preset the backend cannot store
                      a ceiling for, and a real ceiling that nothing enforces. */}
                  <td>
                    {!p && <Blank why="rs.why.noPreset" t={t} />}
                    {p && !p.ceiling && <Blank why="rs.why.noCeiling" t={t} />}
                    {p && p.ceiling && (
                      <>
                        <span className="amount">{fmtTokens(p.ceiling.tokens)}</span>
                        {/* Stated, not implied: a ceiling nothing enforces is a
                            declaration of intent, and a reader who assumes it is
                            a guard rail will over-commit. */}
                        {!p.ceiling.enforced && <span className="badge warn-b">{t('rs.notEnforced')}</span>}
                      </>
                    )}
                  </td>
                  <td>
                    {p ? (
                      <>
                        <span className="amount">{fmtTokens(used)}</span>
                        {pct !== null && <span className="meter"><i style={{ width: `${Math.min(100, pct)}%` }} /></span>}
                        {left === null
                          ? <Blank why="rs.why.noCeiling" t={t} />
                          : <span className="dim">{t('rs.leftN', { n: fmtTokens(left) })}</span>}
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
      {/* A table with headers and no rows states nothing. On a fresh install this
          is the FIRST thing a contributor sees, so it has to say what is missing and
          where the next step lives — including the part this console cannot do. */}
      {agents.length === 0 && (
        <div className="notice warn">
          <div><b>{t('rs.noAgents')}</b></div>
          <div>{t('rs.noAgentsHow')}</div>
        </div>
      )}

      {/*
        * SEATS — the layer under every ceiling above.
        *
        * A ceiling is declared per agent because that is the unit a contributor
        * reasons about. It is not the unit the capacity was bought in: two Claude
        * agents on one host read one credential home ($HOME is never reassigned in
        * the launch path) and consume one authenticated subscription. So the roster
        * above can show 5.0M twice while the seat below holds one quota, and
        * without this section that arithmetic is invisible until a plan runs out.
        *
        * The quota is a DECLARATION, not a reading. Nothing can measure what a
        * subscription includes, so an undeclared seat reports unknown rather than
        * unlimited — and over-subscription is null in that case, because "not
        * over-subscribed" would be the reassuring half of a coin nobody flipped.
        */}
      <h2 className="sec">{t('rs.seats')}<span className="note">{t('rs.seatsNote')}</span></h2>
      <div className="notice">{t('rs.seatWhy')}</div>
      {seats.length === 0 ? (
        <div className="notice warn">{t('rs.seatsEmpty')}</div>
      ) : (
        <>
          {seatKeyed === false && (
            <div className="notice warn">
              <div><b>{t('rs.seatUnkeyed')}</b></div>
              <div>{t('rs.seatUnkeyedWhy')}</div>
            </div>
          )}
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('col.seat')}</th>
                  <th>{t('col.authMode')}</th>
                  <th>{t('col.members')}</th>
                  <th>{t('col.declared')}</th>
                  <th>{t('col.quota')}</th>
                </tr>
              </thead>
              <tbody>
                {seats.map((s) => (
                  <tr key={s.seatId}>
                    <td>
                      <div className="mono-s">{s.framework}</div>
                      <span className="dim">{s.seatId}</span>
                    </td>
                    <td>
                      <span className={s.authMode === 'api-key' ? 'badge' : 'badge attention'}>{s.authMode}</span>
                      <span className="dim">{s.server}</span>
                    </td>
                    <td>
                      {s.members.map((m) => (
                        <Link className="chip-role" key={m.agent} href={`/agents/${m.agent}`}>{m.agent}</Link>
                      ))}
                      {s.membersWithoutCeiling > 0 && (
                        <span className="dim">
                          {t('rs.seatNoCeilings', { n: s.membersWithoutCeiling, of: s.members.length })}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={`amount${s.overSubscribed ? ' warn' : ''}`}>{fmtTokens(s.declaredTokens)}</span>
                      {s.overSubscribed && (
                        <span className="badge warn-b">
                          {t('rs.seatOver', { n: fmtTokens(Math.abs(s.headroomTokens)) })}
                        </span>
                      )}
                    </td>
                    <td>
                      {s.quotaTokens === null ? <Blank why="rs.why.noQuota" t={t} /> : (
                        <>
                          <span className="amount">{fmtTokens(s.quotaTokens)}</span>
                          {s.planLabel && <span className="dim">{s.planLabel}</span>}
                          {/* "left" only reads correctly when something is left.
                              Negative headroom is already stated as
                              "over-subscribed by N" on the declared column, and
                              saying "-4.0M left" beside it is the same fact
                              phrased as its own contradiction. */}
                          {s.headroomTokens >= 0 && (
                            <span className="dim">{t('rs.seatHeadroom', { n: fmtTokens(s.headroomTokens) })}</span>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {seats.some((s) => s.quotaTokens === null) && (
            <div className="notice">{t('rs.why.noQuotaLong')}</div>
          )}
        </>
      )}

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
                  <td>
                    {p.ceiling
                      ? <span className="amount">{fmtTokens(p.ceiling.tokens)}</span>
                      : <Blank why="rs.why.noCeiling" t={t} />}
                  </td>
                  <td>
                    {!p.ceiling && <Blank why="rs.why.noCeiling" t={t} />}
                    {p.ceiling && (p.ceiling.rateCapPerDay
                      ? <span className="amount">{`${fmtTokens(p.ceiling.rateCapPerDay)}/d`}</span>
                      : <Blank why="rs.why.noRateCap" t={t} />)}
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
      {presets.length === 0 && (
        <div className="notice warn">
          <div><b>{t('rs.noPresets')}</b></div>
          <div>{t('rs.noPresetsHow')}</div>
        </div>
      )}

      <div className="notice">{t('rs.meterGap')}</div>
    </>
  );
}
