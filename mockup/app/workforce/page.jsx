'use client';

import Link from 'next/link';
import PageHead from '@/components/PageHead';
import { Blank } from '@/components/Blank';
import { useT } from '@/components/Prefs';
import { useData, Provenance } from '@/components/Data';
// Pure formatters only. Everything data-dependent arrives through useData(), so
// the fixture and the live backend reach this page through one implementation.
import { fmtTokens, runtimeStatusText } from '@/lib/mock-data';

/*
 * 员工名册 — the workforce roster, PRD 6.4 R12 read through ADR-013.
 *
 * WHY THIS PAGE EXISTS WHEN FOUR OTHERS ALREADY DO. The console is organised by
 * LAYER: /resources is what I own and on what terms, /capability is what a project
 * may ask for, /engagements is who asked and what I decided, /usage is what the
 * deployment can and cannot measure. Every one of those is a column through the
 * fleet. Not one of them answers the question a contributor actually asks about a
 * single agent — *what is this one of mine doing, for whom, at what cost, and is it
 * healthy* — because that answer is a ROW across all four. /agents/[name] has the
 * row for one agent; nothing had it for all of them side by side, which is exactly
 * what a roster is.
 *
 * WHAT I CHOSE TO SHOW, AND WHY EACH COLUMN IS HERE.
 *
 *  - **Can be asked for** (L2). A borrower asks for a System Architect, never for
 *    `lend-kimi-02 running kimi-k3`. This is the only per-agent view of the
 *    catalogue, which is organised per role — and it is the roster's answer to
 *    R12's "role/skills summary, qualification", with the mapping still private:
 *    the column reads role names outward, agent names inward.
 *  - **Borrowed by** (L3). The engagements I approved. This is R12's "for whom",
 *    and it is legitimate here precisely because I decided it: an engagement is my
 *    own lending record, not an assignment I handed down.
 *  - **Access** (L3, and the column I would keep if I could keep only one). An
 *    engagement is the allocation; a contribution binding is what actually lets a
 *    project reach the agent. `GET /api/contributions` had no consumer in this
 *    console, so the two records had never been compared on screen. Both
 *    disagreements matter: an allocation with no binding is capacity a project
 *    cannot use (backend-v2.js:10736 records this having happened), and a binding
 *    with no live engagement is standing reachability outliving its justification —
 *    which, for somebody lending their own machines out, is the security question.
 *  - **Committed** and **Consumed**, side by side and never merged. Committed is
 *    known: I know what I promised. Consumed is measured only where a framework
 *    writes its own transcript AND the agent's workspace is known, so most cells
 *    carry the backend's own reason instead of a figure. ADR-013 §6: a blank is
 *    never a zero, and the reason goes in place rather than being generalised into
 *    a page-level footnote — the reasons genuinely differ per agent here.
 *  - **Condition**. Health and availability, with the offline reason beside the
 *    state rather than a colour standing in for it.
 *  - **Draws on**. The seat. A per-agent ceiling is a sub-allocation of a shared
 *    credential home (ADR-013 §5), so a roster that printed a ceiling without
 *    naming the seat under it would repeat the arithmetic error the seats table
 *    exists to correct.
 *
 * WHAT I REFUSED TO SHOW, WHICH MATTERS MORE.
 *
 * R12 asks each row for "current assignment, work item, elapsed time, assignment
 * lifecycle state" and "accrued cost … cost coverage". ADR-013 withdrew the first
 * group with R0's assignment contract (§8) and the second's monetary half on
 * 2026-08-10. So this roster carries **no work item, no assignment state, no
 * progress, no queue, no lease and no currency** — and says so, in the five-question
 * table below, rather than leaving a reader to notice the gap and assume an
 * oversight. Two of the PDU's five standing questions are not this console's to
 * answer; naming them as withdrawn is the honest form of that, and it is also the
 * only place in the product where the PRD/ADR split is visible to its user.
 *
 * The same discipline kills a column I could easily have justified: the task count.
 * `GET /api/usage` reports one per agent and it is a real measurement, but a task
 * on a workforce roster is the withdrawn work-item column wearing a number. That an
 * agent is busy is mine to see; what it is busy with belongs to the borrower, and
 * /usage keeps the task figure where it reads as activity rather than as an
 * assignment.
 *
 * And no utilisation percentage. R13 wants one from durable intervals; what exists
 * is a sweep's busy/idle counters — a numerator whose denominator nobody declared.
 */

/*
 * The five questions R12 says a roster exists to answer, with what answers each one
 * here. `answered: false` is a row, not an omission: a question this console has
 * withdrawn is more informative on screen than absent from it.
 */
const QUESTIONS = [
  { id: 'doing', q: 'wf.q.doing', a: 'wf.a.doing', w: 'wf.w.doing', answered: true },
  { id: 'forWhom', q: 'wf.q.forWhom', a: 'wf.a.forWhom', w: 'wf.w.forWhom', answered: true },
  { id: 'howFar', q: 'wf.q.howFar', a: 'wf.a.howFar', w: null, answered: false },
  { id: 'cost', q: 'wf.q.cost', a: 'wf.a.cost', w: 'wf.w.cost', answered: true },
  { id: 'condition', q: 'wf.q.condition', a: 'wf.a.condition', w: 'wf.w.condition', answered: true },
];

/*
 * The catalogue's reason codes, in this page's words.
 *
 * Three shortfalls, three different next steps: choose a model, choose a different
 * model, or acquire stronger capacity. Two of the three already have a translated
 * reason on /resources, so they are reused rather than restated — a second wording
 * for one state is how two pages start disagreeing about it.
 */
const NO_ROLE_WHY = {
  'cap.why.noModel': 'rs.why.noPreset',
  'cap.why.notAccepted': 'rs.why.noTier',
  'cap.why.belowTier': 'wf.why.belowEveryFloor',
  'wf.why.notInCatalogue': 'wf.why.notInCatalogue',
};

export default function WorkforcePage() {
  const t = useT();
  const { workforce, agents, roleCapacity, provenance } = useData();
  const rows = workforce();
  const roleName = (key) => roleCapacity.roles[key]?.displayName ?? key;

  /*
   * Two slices whose EMPTINESS is a claim, so the page checks where they came from
   * before making it.
   *
   * "Nobody is borrowing this agent" and "no project can reach it" are reassuring
   * sentences, and both are false if the store simply did not answer. The list is
   * empty either way, so provenance is the only thing that distinguishes them —
   * this is the same reason lib/api.js marks a failed slice `absent` instead of
   * substituting the fixture.
   */
  /*
   * `?? 'fixture'` is what components/Data.jsx's banner does for an unnamed slice,
   * and the two must agree: on the first paint, and in the static export, the
   * engagement slice has no provenance entry at all and the fixture's engagements
   * are the data. Reading undefined as "did not answer" put "the engagement store
   * did not answer" on every row of a page whose fixture has three live borrowers.
   */
  const lentKnown = (provenance.engagements ?? 'fixture') !== 'absent';
  /*
   * The access record is the one slice with no fixture, so it is knowable only when
   * the endpoint answered. Absent is not "nothing can reach this agent" — that
   * sentence is reassuring and would be a fabrication — so the cell states the
   * absence instead.
   */
  const accessKnown = provenance.contributions === 'live';

  const hireable = rows.filter((r) => r.roles.length > 0);
  const borrowed = rows.filter((r) => r.lent.length > 0);
  const running = agents.filter((a) => a.alive);
  /*
   * A fleet consumption figure is a COVERAGE figure. Summing the agents that could
   * be attributed and printing it as the total would understate by however many
   * could not — silently, and in the direction that flatters. So the sum is
   * reported with its denominator beside it, and when nothing was attributed the
   * card is a blank with a reason rather than a 0.
   */
  const measured = rows.filter((r) => r.tokens?.used !== null && r.tokens?.used !== undefined);
  const measuredTotal = measured.reduce((n, r) => n + r.tokens.used, 0);

  return (
    <>
      <PageHead title={t('wf.title')} sub={t('wf.sub')} />

      {/* Seven slices, five provenances possible on each. The banner is long here
          because the page really does read all of them — a roster that joined seven
          sources and claimed one provenance would be the misrepresentation this
          strip exists to prevent. */}
      <Provenance
        slices={['agents', 'capability', 'engagements', 'contributions', 'usage', 'ceilings', 'seats']}
      />

      {/* Said once, at the top, before any row invites the reading it forbids. */}
      <div className="notice">{t('wf.notScheduler')}</div>

      <div className="cards">
        <div className="card"><div className="cap">{t('wf.cAgents')}</div><div className="val">{agents.length}</div></div>
        <div className="card">
          <div className="cap">{t('wf.cHireable')}</div>
          <div className={`val${hireable.length < agents.length ? ' warn' : ''}`}>
            {hireable.length}<small> {t('rs.ofN', { n: agents.length })}</small>
          </div>
        </div>
        <div className="card">
          <div className="cap">{t('wf.cLent')}</div>
          {lentKnown
            ? <div className="val">{borrowed.length}<small> {t('rs.ofN', { n: agents.length })}</small></div>
            : <div className="val"><Blank why="wf.why.noEngagements" t={t} /></div>}
        </div>
        <div className="card">
          <div className="cap">{t('wf.cTokens')}</div>
          {measured.length === 0
            ? <div className="val"><Blank why="wf.why.noneMeasured" t={t} /></div>
            : (
              <div className="val">
                {fmtTokens(measuredTotal)}
                <span className="dim">{t('wf.measuredFor', { n: measured.length, of: agents.length })}</span>
              </div>
            )}
        </div>
        <div className="card">
          <div className="cap">{t('wf.cRunning')}</div>
          {/* A real zero: the sweep observed every agent and none was up. Distinct
              from the card above it, where nothing observed anything. */}
          <div className={`val${running.length === 0 ? ' warn' : ''}`}>
            {running.length}<small> {t('rs.ofN', { n: agents.length })}</small>
          </div>
        </div>
      </div>

      <h2 className="sec">{t('wf.roster')}<span className="note">{t('wf.rosterNote')}</span></h2>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t('col.agent')}</th>
              <th>{t('wf.colHireable')}</th>
              <th>{t('wf.colLent')}</th>
              <th>{t('wf.colAccess')}</th>
              <th>{t('col.committed')}</th>
              <th>{t('wf.colConsumed')}</th>
              <th>{t('wf.colCondition')}</th>
              <th>{t('wf.colSeat')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const a = r.agent;
              return (
                <tr key={a.name}>
                  <td>
                    <div><Link href={`/agents/${a.name}`}>{a.name}</Link></div>
                    <span className="dim">{`${a.framework} · ${a.transport}`}</span>
                  </td>

                  {/* L2 — roles outward, the agent behind them already known to the
                      reader because this is their own console. */}
                  <td>
                    {r.roles.length === 0
                      ? <Blank why={NO_ROLE_WHY[r.noRoleWhy] ?? 'wf.why.notInCatalogue'} t={t} />
                      : (
                        <>
                          <div>
                            <span className={`tierchip ${r.tier}`}>{r.tier}</span>
                            {r.roles.map((role) => (
                              <span className="chip-role" key={role.key}>{role.displayName}</span>
                            ))}
                          </div>
                          {/* Once per row, not once per role: every strong agent is
                              over-tier on four of the six, and six identical badges
                              bury the one fact worth reading. */}
                          {r.overTier > 0 && (
                            <span className="dim">{t('wf.overTierCell', { n: r.overTier })}</span>
                          )}
                        </>
                      )}
                  </td>

                  {/* L3 — who is borrowing it. Never a work item. */}
                  <td>
                    {!lentKnown && <Blank why="wf.why.noEngagements" t={t} />}
                    {lentKnown && r.lent.length === 0 && (
                      <span className="dim">{t('wf.notLent')}</span>
                    )}
                    {/*
                      * The id rides along with the allocation, and it is not
                      * decoration: this backend holds three concurrent active
                      * engagements for one (agent, project room) — each drawing on
                      * the ceiling separately — and without the id three identical
                      * lines read as the table repeating itself rather than as three
                      * records. Never abbreviated; an identifier you cannot search
                      * for is not one.
                      */}
                    {lentKnown && r.lent.map((e) => (
                      <div key={e.id}>
                        <div>{`${e.project} · ${roleName(e.role)}`}</div>
                        {e.allocatedTokens
                          ? (
                            <span className="dim">
                              {t('wf.allocated', { n: fmtTokens(e.allocatedTokens), id: e.id })}
                            </span>
                          )
                          : <Blank why="wf.why.noAllocation" t={t} />}
                      </div>
                    ))}
                  </td>

                  {/* The reconciliation. Agreement is stated too — "3 matching the
                      engagements" is what makes the disagreement legible when it
                      appears, and an unlabelled quiet column reads as unchecked. */}
                  <td>
                    {!accessKnown && <Blank why="wf.why.noAccessRecord" t={t} />}
                    {accessKnown && r.bindings.length === 0 && r.lent.length === 0 && (
                      <span className="dim">{t('wf.noAccess')}</span>
                    )}
                    {accessKnown && (r.bindings.length > 0 || r.lent.length > 0) && (
                      <>
                        {r.unreachable.length === 0 && r.standing.length === 0 && (
                          <span className="dim">{t('wf.accessOk', { n: r.bindings.length })}</span>
                        )}
                        {r.unreachable.length > 0 && (
                          <>
                            <div>
                              <span className="badge attention">
                                {t('wf.accessMissing', { n: r.unreachable.length })}
                              </span>
                            </div>
                            <span className="dim">{t('wf.accessMissingWhy')}</span>
                          </>
                        )}
                        {r.standing.length > 0 && (
                          <>
                            <div>
                              <span className="badge attention">
                                {t('wf.accessStanding', { n: r.standing.length })}
                              </span>
                            </div>
                            {/* The projects by name, and what holding a binding
                                without a live engagement means. The count alone
                                would be a number nobody could act on. */}
                            <span className="dim">
                              {r.standing.map((b) => b.project).join(' · ')}
                            </span>
                            <span className="dim">{t('wf.accessStandingWhy')}</span>
                          </>
                        )}
                      </>
                    )}
                  </td>

                  {/* Known. What I promised, against the ceiling I declared. */}
                  <td>
                    {!lentKnown ? <Blank why="wf.why.noEngagements" t={t} /> : (
                      <>
                        {/* The figure gets its own line so a missing ceiling's
                            reason cannot read as a qualifier on the committed
                            number: "0 — no ceiling field upstream" is two facts,
                            and one of them is known. */}
                        <div><span className="amount">{fmtTokens(r.promised)}</span></div>
                        {r.ceiling ? (
                          <>
                            {/* No denominator, no meter. An empty bar reads as 0%
                                used, which is a measurement. */}
                            <span className="meter">
                              <i style={{ width: `${Math.min(100, Math.round((r.promised / r.ceiling.tokens) * 100))}%` }} />
                            </span>
                            <span className="dim">{t('wf.ofCeiling', { n: fmtTokens(r.ceiling.tokens) })}</span>
                          </>
                        ) : <Blank why="rs.why.noCeiling" t={t} />}
                      </>
                    )}
                  </td>

                  {/*
                    * L4 — measured, or absent with the backend's own reason.
                    *
                    * The reason is quoted verbatim rather than mapped to a key: it
                    * is specific to this agent and this framework ("no workspace
                    * recorded", "octos session files record no usage object", "no
                    * transcript location verified for this adapter"), and a
                    * generalised local wording would lose exactly the part that
                    * tells a contributor what to do about it.
                    *
                    * So this is the one string on the page that stays in the
                    * backend's language when the console is in Chinese. The
                    * alternative is worse in both directions: enumerating the
                    * backend's reasons as dictionary keys makes a new reason render
                    * as a raw key, and paraphrasing them locally silently drifts
                    * from what the server actually said. The provenance banner
                    * already quotes backend error text the same way, for the same
                    * reason. The label around it is translated.
                    */}
                  <td>
                    {!r.tokens && <Blank why="wf.why.noUsageSlice" t={t} />}
                    {r.tokens && r.tokens.used === null && (
                      <span className="why-inline">{t('wf.why.tokens', { why: r.tokens.reason })}</span>
                    )}
                    {r.tokens && r.tokens.used !== null && (
                      <>
                        <div>
                          <span className="amount">{fmtTokens(r.tokens.used)}</span>
                          {/* Both caveats on a figure that otherwise looks exact. */}
                          {r.tokens.fromLedger && <span className="badge">{t('wf.fromLedger')}</span>}
                          {r.tokens.regressions > 0 && (
                            <span className="badge warn-b">{t('wf.regressed', { n: r.tokens.regressions })}</span>
                          )}
                        </div>
                        {/* The kinds stay apart, and all four are printed: cache
                            reads run orders of magnitude above fresh input, and a
                            subset beside a total nobody can reconcile is worse than
                            no breakdown at all. */}
                        {r.tokens.byKind && (
                          <span className="dim">
                            {t('wf.byKind', {
                              input: fmtTokens(r.tokens.byKind.input ?? 0),
                              cacheRead: fmtTokens(r.tokens.byKind.cacheRead ?? 0),
                              cacheWrite: fmtTokens(r.tokens.byKind.cacheWrite ?? 0),
                              output: fmtTokens(r.tokens.byKind.output ?? 0),
                            })}
                          </span>
                        )}
                        {r.tokens.sessions !== null && (
                          <span className="dim">{t('wf.sessions', { n: r.tokens.sessions })}</span>
                        )}
                      </>
                    )}
                  </td>

                  <td>
                    {/* The backend's own word for the state, unlaundered — it is a
                        wire value, so it is not translated and not recoloured into
                        something friendlier. */}
                    <div>
                      <span className={`badge${a.alive ? ' ok' : ''}`}>{a.state ?? (a.alive ? 'online' : 'offline')}</span>
                      {a.blocked && <span className="badge blocked">{t('wf.blocked')}</span>}
                    </div>
                    <span className="dim">{runtimeStatusText(a)}</span>
                    {a.blocked && a.blockedReason && <span className="dim">{a.blockedReason}</span>}
                    {!a.online && a.offlineReason && (
                      <span className="dim mono-s">{a.offlineReason}</span>
                    )}
                    {/* The disagreement the roster row usually collapses: up, and
                        reporting itself unwell. */}
                    {a.online && !a.healthy && <span className="dim">{t('wf.condUnhealthy')}</span>}
                  </td>

                  <td>
                    {r.seat ? (
                      <>
                        <div className="mono-s">{r.seat.framework}</div>
                        <span className={r.seat.authMode === 'api-key' ? 'badge' : 'badge attention'}>
                          {r.seat.authMode}
                        </span>
                        <span className="dim">
                          {r.seat.members.length > 1
                            ? t('wf.onSeat', { n: r.seat.members.length - 1 })
                            : t('wf.seatAlone')}
                        </span>
                      </>
                    ) : <Blank why="wf.why.noSeat" t={t} />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {/* A table with headers and no rows states nothing, and this is a plausible
          state on a fresh install rather than an edge case. */}
      {rows.length === 0 && (
        <div className="notice warn">
          <div><b>{t('rs.noAgents')}</b></div>
          <div>{t('rs.noAgentsHow')}</div>
        </div>
      )}

      <div className="notice warn">{t('wf.utilNote')}</div>

      {/*
        * THE FIVE QUESTIONS, INCLUDING THE ONE THIS ROSTER REFUSES.
        *
        * R12 defines the roster by the questions it answers, so the honest place to
        * record that two of them were withdrawn is the roster itself. Leaving the
        * withdrawn row out would let the page look like a complete answer to R12,
        * which is the same failure as drawing a spend chart with no meter behind it.
        */}
      <h2 className="sec">{t('wf.questions')}<span className="note">{t('wf.questionsNote')}</span></h2>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t('wf.qQuestion')}</th>
              <th>{t('wf.qAnswer')}</th>
              <th>{t('wf.qWhere')}</th>
            </tr>
          </thead>
          <tbody>
            {QUESTIONS.map((q) => (
              <tr key={q.id}>
                <td>{t(q.q)}</td>
                <td>{t(q.a)}</td>
                <td>
                  {q.answered
                    ? <span className="dim">{t(q.w)}</span>
                    : <span className="badge warn-b">{t('wf.withdrawn')}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="notice">{t('wf.contractNote')}</div>
      <Link className="btn" href="/usage">{t('wf.seeUsage')}</Link>
    </>
  );
}
