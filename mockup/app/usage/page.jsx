'use client';

import Link from 'next/link';
import PageHead from '@/components/PageHead';
import { Blank } from '@/components/Blank';
import { CeilingBars, AllocationDonut, TaskBars, MissingSeries } from '@/components/Charts';
import { useT } from '@/components/Prefs';
import { fmtTokens, fmtSpanSec } from '@/lib/mock-data';
import { useData, Provenance } from '@/components/Data';
import { InfoTip, InfoTipList } from '@/components/InfoTip';

/*
 * ⑤ 用量 — L4, and the layer where this design is most honest about what it
 * cannot do.
 *
 * Task structure is real: lib/task-store.js has five statuses and the project
 * board rolls them up per member. So "what did my agent actually work on" is
 * answerable.
 *
 * Token consumption is NOT. Nothing in HAFleet meters tokens at any granularity —
 * every `usage`/`budget` match in lib/ and backend-v2.js is a CLI help string. So
 * the column that matters most to a contributor is the one that cannot be filled,
 * and the page says so ONCE, at the top, rather than printing a dash per row and
 * making the reader wonder whether it is a gap or a zero.
 *
 * What IS knowable, and worth separating: **allocated** is real. I know what I
 * promised even though I cannot see what was spent. The page keeps the two apart,
 * because conflating them would let a contributor believe an untouched engagement
 * had consumed its whole budget.
 */
/*
 * Gap ids the backend publishes, mapped to localized text. See the API's `remainingGaps`.
 * An id absent here falls back to the API's English `detail` rather than to a key name.
 */
const GAP_KEYS = {
  'per-project': 'us.gap.perProject',
  'no-accounting': 'us.gap.noAccounting',
  'file-budget': 'us.gap.fileBudget',
};

export default function UsagePage() {
  const t = useT();
  const {
    usage, engagements, roleCapacity, agents, presetOf, committed, remaining,
    usageLive = [], metering,
  } = useData();

  const roleName = (key) => roleCapacity.roles[key]?.displayName ?? key;

  const byProject = usage.reduce((acc, u) => {
    (acc[u.project] ??= []).push(u);
    return acc;
  }, {});

  const configured = agents.filter((a) => a.presetId);

  /*
   * Measured consumption across the fleet, and the count it was measured over.
   *
   * Kept as two values on purpose. A sum alone cannot be read honestly: metering is
   * per framework and per workspace, so a fleet where one of four agents is
   * attributable produces a real number that describes a quarter of the fleet.
   */
  const meteredAgents = usageLive.filter((r) => r.tokensUsed !== null && r.tokensUsed !== undefined);
  /*
   * TWO TOTALS, AND THE HEADLINE IS THE DRAWN ONE.
   *
   * `tokensUsed` sums all four kinds, and cache reads dominate it by more than an order of
   * magnitude: on a real session, 203 tool calls each re-sending a context that grew to
   * 224,992 tokens produced 25,956,736 cache reads against 984,016 of fresh tokens. Leading
   * with 26.9M told a contributor who had asked three questions that they had spent 27M —
   * a figure that is arithmetically true, incomparable to anything they intuit, and 96%
   * composed of the SAME tokens counted 210 times.
   *
   * So `drawn` is the figure, because it is both the work and the thing the ceiling spends,
   * and the re-read volume is shown beside it as what it is.
   */
  const meteredDrawn = meteredAgents.reduce((n, r) => n + (r.tokensDrawn ?? 0), 0);
  const meteredReread = meteredAgents.reduce((n, r) => n + (r.tokensByKind?.cacheRead ?? 0), 0);

  /*
   * Every series below is ALLOCATION — what I promised — because that is what is
   * knowable. The one real measurement is the task count, and the one series a
   * reader will look for (spend over time) is rendered as its own absence.
   */
  // Only agents whose preset carries a ceiling can be charted against one. The
  // rest are not drawn at 0% — a bar with no denominator is not an empty bar, it
  // is a chart that should not exist, and the panel says so when the set is empty.
  const ceilingRows = configured
    .filter((a) => presetOf(a)?.ceiling)
    .map((a) => ({
      agent: a.name,
      committed: committed(a.name),
      ceiling: presetOf(a).ceiling.tokens,
    }));

  const donutSlices = Object.entries(
    engagements.filter((e) => e.state !== 'pending').reduce((acc, e) => {
      acc[e.project] = (acc[e.project] ?? 0) + (e.allocatedTokens ?? 0);
      return acc;
    }, {}),
  ).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);

  const taskRows = Object.entries(byProject).map(([label, rows]) => ({
    label,
    done: rows.reduce((n, u) => n + u.tasksDone, 0),
    open: rows.reduce((n, u) => n + u.tasksOpen, 0),
  }));

  return (
    <>
      <PageHead title={t('us.title')} sub={t('us.sub')} />

      <Provenance slices={['agents', 'usage', 'engagements', 'ceilings']} />

      {/*
        * WHAT THIS DEPLOYMENT ACTUALLY MEASURES, from the backend's own declaration.
        *
        * `GET /api/usage` returns a `metering` block naming each signal's
        * availability, so the page states the partition instead of the reader
        * inferring it from which cells happen to be full. That inference is the
        * failure mode: an empty column reads as "nothing happened" when it means
        * "nothing was counted".
        *
        * Tokens is the interesting one, and it is no longer a gap: the CLIs write the
        * provider's own figures to disk and lib/metering reads them. What is still not
        * measured is listed below, narrowed to the parts that really are open.
        *
        * THE PROVENANCE LINE IS LOCALIZED, NOT ECHOED. It used to render the API's
        * `source` verbatim — `lib/task-store.js`, `lib/metering — the coding CLIs' own
        * transcripts...` — so a Chinese console showed a contributor English module
        * paths, and the panel read as debug output leaking into a product surface. An
        * operator asked whether it was there for debugging, which is the right question
        * to ask of a page that prints file names at you. The guarantee is worth keeping:
        * every column says where its number came from. Naming an internal module is not
        * how you keep it. The technical string stays on the element's title for anyone
        * who wants it.
        */}
      {metering && (
        <>
          <h2 className="sec" style={{ marginTop: 0 }}>
            {t('us.measured')}<span className="note">{t('us.measuredNote')}</span>
          </h2>
          <div className="cards">
            {[
              ['us.sigTasks', 'us.sigSrcTasks', metering.tasks],
              ['us.sigBusy', 'us.sigSrcBusy', metering.busyTime],
              ['us.sigTokens', 'us.sigSrcTokens', metering.tokens],
            ].map(([key, srcKey, sig]) => (
              <div className="card" key={key} title={sig?.source ?? undefined}>
                <div className="cap">{t(key)}</div>
                <div className={`val${sig?.available ? ' ok' : ' warn'}`} style={{ fontSize: 15 }}>
                  {t(sig?.available ? 'us.sigYes' : 'us.sigNo')}
                </div>
                {/*
                  * The signal's own reason wins when it is unavailable — that text is
                  * specific to this deployment and is the actionable half. Otherwise the
                  * localized description of where a measured figure comes from.
                  */}
                <span className="dim">{sig?.available ? t(srcKey) : (sig?.reason ?? t(srcKey))}</span>
              </div>
            ))}
          </div>
          {/*
            * WHAT IS STILL NOT MEASURED. Renamed from `candidateSources`, which listed two
            * ways to obtain token figures at all — and kept listing them after the first one
            * shipped, so this block told an operator that getting real numbers was a pending
            * decision while the panel directly above reported the token signal as measured
            * from that very source.
            */}
          {/*
            * Localized by ID, and folded behind a one-line claim.
            *
            * It was a permanent warn-block printing three English paragraphs into a Chinese
            * console — the same defect as the provenance line echoing `lib/task-store.js`,
            * which is why the API now sends `{id, detail}` and this maps the id. `detail` is
            * the fallback so an id this build does not know still says something true.
            */}
          {metering.tokens?.remainingGaps?.length > 0 && (
            <InfoTipList
              label={t('us.tokenGaps')}
              items={metering.tokens.remainingGaps.map((g) => {
                if (typeof g === 'string') return g;
                /*
                 * An explicit map, rather than interpolating the id into a translation key.
                 * `translate` returns the key itself when it has no entry, so an id this build
                 * has not translated would render the key name at the reader. Falling back to
                 * the API's own English detail is worse-looking and true, which is the right
                 * trade. (Written without a literal key expression on purpose: the key-resolve
                 * invariant scans for them and would read a prefix out of this comment.)
                 */
                const key = GAP_KEYS[g.id];
                return key ? t(key) : g.detail;
              })}
            />
          )}
        </>
      )}

      {usageLive.length > 0 && (
        <>
          <h2 className="sec">
            {t('us.byAgentLive')}<span className="note">{t('us.byAgentLiveNote')}</span>
          </h2>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('col.agent')}</th><th>{t('col.model')}</th>
                  <th>{t('col.busy')}</th><th>{t('col.tasks')}</th>
                  <th>{t('col.ceiling')}</th><th>{t('col.used')}</th>
                </tr>
              </thead>
              <tbody>
                {usageLive.map((r) => (
                  <tr key={r.agent}>
                    <td><Link href={`/agents/${r.agent}`}>{r.agent}</Link><span className="dim">{r.framework}</span></td>
                    <td>{r.model ? <span className="mono-s">{r.model}</span> : <Blank why="rs.why.noPreset" t={t} />}</td>
                    <td>
                      {/* Real, and zero is a real answer here: the sweep observed
                          this agent and it was never busy. Distinct from the token
                          column below, where nothing observed anything. */}
                      {r.busySec > 0
                        ? <><span className="amount">{fmtSpanSec(r.busySec)}</span><span className="dim">{r.activeNow ? 'active' : `idle ${fmtSpanSec(r.idleSec)}`}</span></>
                        : <Blank why="us.why.noBusy" t={t} />}
                    </td>
                    <td>
                      <span className="amount">{r.tasks}</span>
                      <span className="dim">
                        {t('us.taskBreak', {
                          done: r.tasksByStatus?.done ?? 0,
                          open: r.tasks - (r.tasksByStatus?.done ?? 0),
                        })}
                      </span>
                    </td>
                    <td>
                      {r.ceilingTokens === null
                        ? <Blank why="rs.why.noCeiling" t={t} />
                        : <span className="amount">{fmtTokens(r.ceilingTokens)}</span>}
                    </td>
                    {/*
                      * MEASURED, and it was a hardcoded blank until now.
                      *
                      * `r.tokensUsed` arrives on this very row and the cell printed
                      * `us.why.noMeter` unconditionally — so a codex agent with 6.8M
                      * measured tokens rendered 系统未计量, directly under a provenance
                      * panel declaring the token signal available. The page asserted a
                      * gap it never checked, which is the same defect as the runtime tab
                      * claiming an agent had no pane while holding its pane id.
                      *
                      * When it IS null the reason comes from the server, not from a fixed
                      * string: "no transcripts yet", "the scan stopped at its bounds" and
                      * "this framework writes no accounting" are different facts and only
                      * the last one is about the framework.
                      */}
                    <td>
                      {r.tokensUsed === null
                        ? <Blank why="us.why.meterReason" t={t} vars={{ r: r.tokensReason || t('us.why.noMeter') }} />
                        : (
                          <>
                            {/*
                              * `tokensDrawn`, and the percentage with it. Using `tokensUsed`
                              * here rendered an agent that had spent 9.8% of its ceiling as
                              * 136% of it, because cache reads were in the numerator and
                              * never in the limit.
                              */}
                            <span className="amount">{fmtTokens(r.tokensDrawn ?? r.tokensUsed)}</span>
                            {r.ceilingTokens && r.tokensDrawn != null
                              ? <span className="dim">{t('us.pctOfCeiling', { n: Math.round((r.tokensDrawn / r.ceilingTokens) * 100) })}</span>
                              : null}
                            {/*
                              * Named rather than hidden. Dropping it would understate what the
                              * agent actually moved through the provider, and an operator
                              * comparing this against their own bill needs to see it.
                              */}
                            {r.tokensByKind?.cacheRead
                              ? (
                                <span className="dim">
                                  {t('us.rereadNote', { n: fmtTokens(r.tokensByKind.cacheRead) })}
                                </span>
                              )
                              : null}
                          </>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/*
        * Said once — but folded, not printed.
        *
        * Still one systemic statement rather than a dash on every row; the content just grew
        * past what belongs above a table. It has to explain WHICH number the Used column is,
        * because "984k" and "26.0M context re-read" sitting side by side otherwise read as a
        * contradiction rather than as two different quantities.
        */}
      <InfoTip label={t('us.usedIsFresh')}>{t('us.notMeteredNote')}</InfoTip>

      <div className="cards">
        {/*
          * COUNTED FROM THE ENGAGEMENTS, not from `usage`.
          *
          * `usage` is the per-ENGAGEMENT fixture that lib/api.js deliberately empties in live
          * mode ("the endpoint reports per AGENT and there is no engagement record to key them
          * to"). So this card read an array that is structurally empty and displayed 0 while a
          * live engagement existed — an operator asked how to interpret that 0, and the answer
          * was that it is not a measurement at all.
          *
          * Active, not "not pending": an ended engagement is not one the contributor is in.
          */}
        <div className="card">
          <div className="cap">{t('us.cEngagements')}</div>
          <div className="val">{engagements.filter((e) => e.state === 'active').length}</div>
        </div>
        <div className="card">
          <div className="cap">{t('us.cAllocated')}</div>
          <div className="val">
            {/*
              * ACTIVE only. `state !== 'pending'` included ENDED engagements, so this figure
              * grew forever and read 540k when 250k was actually allocated — 290k of it
              * belonged to engagements that had already been revoked. "Allocated" has to mean
              * what is allocated now, or it is not a number a contributor can act on.
              */}
            {fmtTokens(engagements.filter((e) => e.state === 'active').reduce((n, e) => n + (e.allocatedTokens ?? 0), 0))}
          </div>
        </div>
        <div className="card">
          <div className="cap">{t('us.cSpent')}</div>
          {/*
            * The headline figure a contributor came for. It is now a number when anything
            * was measured, and it CARRIES ITS OWN DENOMINATOR: a fleet total summed over
            * the agents that could be attributed, presented without saying how many were
            * left out, is the exact shape of a number that gets believed too much. When
            * nothing could be measured it stays a blank, because 0 would claim a
            * measurement.
            */}
          <div className="val">
            {meteredAgents.length === 0
              ? <Blank why="us.why.noMeter" t={t} />
              : <>{fmtTokens(meteredDrawn)}</>}
          </div>
          {meteredAgents.length > 0 && meteredAgents.length < usageLive.length && (
            <div className="dim">
              {t('us.spentPartial', { n: meteredAgents.length, m: usageLive.length })}
            </div>
          )}
          {/* So the headline cannot be mistaken for everything the fleet moved. */}
          {meteredReread > 0 && (
            <div className="dim">{t('us.rereadNote', { n: fmtTokens(meteredReread) })}</div>
          )}
        </div>
        {/*
          * Same emptied fixture, same permanent 0. Task counts ARE real and arrive per agent
          * on the live rows, so they are summed from there.
          */}
        <div className="card">
          <div className="cap">{t('us.cTasks')}</div>
          <div className="val">
            {usageLive.reduce((n, r) => n + (r.tasksByStatus?.done ?? 0), 0)}
          </div>
        </div>
      </div>

      {/*
        * THREE NUMBERS THAT SOUND LIKE ONE.
        *
        * An operator who had declared a 10M ceiling read "已分配 250k" and asked where they had
        * promised 250k. Fair: they had not. The 250k was the amount a REQUESTER asked for — in
        * that case a default baked into a test tool — which they approved. And the same quantity
        * was labelled 已分配 on this card and 已承诺 in the table below it, while 已分配 also meant
        * a single engagement's allocation in the by-project table. Three concepts, two names.
        *
        * The card now says what it is. This explains how the three relate, including the part
        * nobody can infer: spend outside an engagement still draws the ceiling down.
        */}
      <InfoTip label={t('us.cardsExplain')}>{t('us.cardsExplainBody')}</InfoTip>

      <h2 className="sec">{t('us.charts')}<span className="note">{t('us.chartsNote')}</span></h2>
      <div className="chart-grid">
        <div className="panel">
          <h3 className="sub">{t('ch.ceilingTitle')}<span className="note">{t('ch.ceilingNote')}</span></h3>
          <CeilingBars rows={ceilingRows} />
        </div>
        <div className="panel">
          <h3 className="sub">{t('ch.donutTitle')}<span className="note">{t('ch.donutNote')}</span></h3>
          <AllocationDonut slices={donutSlices} />
        </div>
        <div className="panel">
          <h3 className="sub">{t('ch.taskTitle')}<span className="note">{t('ch.taskNote')}</span></h3>
          <TaskBars rows={taskRows} />
        </div>
        <div className="panel">
          <h3 className="sub">{t('ch.missingSection')}</h3>
          <MissingSeries />
        </div>
      </div>

      <h2 className="sec">{t('us.byProject')}<span className="note">{t('us.byProjectNote')}</span></h2>
      {Object.entries(byProject).map(([project, rows]) => (
        <div key={project}>
          <h3 className="sub">{project}</h3>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('col.role')}</th><th>{t('col.agent')}</th>
                  <th>{t('col.allocated')}</th><th>{t('col.used')}</th>
                  <th>{t('us.tasksDone')}</th><th>{t('us.tasksOpen')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((u) => {
                  const e = engagements.find((x) => x.id === u.engagementId);
                  return (
                    <tr key={u.engagementId}>
                      <td>{roleName(u.role)}</td>
                      <td><Link href={`/agents/${u.agent}`}>{u.agent}</Link></td>
                      <td className="amount">{fmtTokens(e?.allocatedTokens)}</td>
                      {/*
                        * STILL A BLANK, and for a different reason than the tables below.
                        *
                        * Per-AGENT consumption is measured. Per-PROJECT is not, and cannot be
                        * by this method: a transcript records the directory the CLI ran in,
                        * not which engagement the work was for, so an agent serving two
                        * projects out of one workdir produces one undivided total. Splitting
                        * it would invent a division.
                        *
                        * The reason had to change with the metering fix. It said the framework
                        * could not be read, which is now false for codex and claude — and it
                        * was the sentence that made this page contradict itself.
                        */}
                      <td>
                        {u.tokensUsed === null
                          ? <Blank why="us.why.noProjectMeter" t={t} />
                          : <span className="amount">{fmtTokens(u.tokensUsed)}</span>}
                      </td>
                      {/* Real: lib/task-store.js statuses, rolled up per member. */}
                      <td>{u.tasksDone}</td>
                      <td className={u.tasksOpen > 0 ? 'warn' : ''}>{u.tasksOpen}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      <h2 className="sec">{t('us.byAgent')}<span className="note">{t('us.byAgentNote')}</span></h2>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t('col.agent')}</th><th>{t('col.model')}</th>
              <th>{t('col.ceiling')}</th><th>{t('col.committed')}</th>
              <th>{t('us.headroom')}</th><th>{t('col.used')}</th>
            </tr>
          </thead>
          <tbody>
            {configured.map((a) => {
              const p = presetOf(a);
              const live = usageLive.find((r) => r.agent === a.name) ?? null;
              const used = committed(a.name);
              const left = remaining(a.name);
              /*
               * THE BAR SHOWS WHAT ACTUALLY CONSUMED THE HEADROOM, which is not the same as
               * what was committed. `remainingFor` draws `max(committed, measuredSpend)`, so a
               * bar drawn from committed alone contradicted the headroom beside it: 250k of
               * 10M rendered as 3% used next to 9.0M left, which only adds up if 1M went
               * somewhere unstated. The label still names the committed share, because that is
               * the part the contributor promised rather than the part that was spent.
               */
              const drawn = p?.ceiling && left !== null ? p.ceiling.tokens - left : null;
              const pct = p?.ceiling && drawn !== null ? Math.round((drawn / p.ceiling.tokens) * 100) : null;
              const committedPct = p?.ceiling ? Math.round((used / p.ceiling.tokens) * 100) : null;
              return (
                <tr key={a.name}>
                  <td><Link href={`/agents/${a.name}`}>{a.name}</Link></td>
                  <td className="mono-s">{p.model}</td>
                  <td>
                    {p?.ceiling
                      ? <span className="amount">{fmtTokens(p.ceiling.tokens)}</span>
                      : <Blank why="rs.why.noCeiling" t={t} />}
                  </td>
                  <td className="amount">{fmtTokens(used)}</td>
                  <td>
                    {/* Headroom is ceiling minus committed. With no ceiling there
                        is no headroom to report — not zero headroom, which would
                        read as an exhausted agent. */}
                    {left === null ? <Blank why="rs.why.noCeiling" t={t} /> : (
                      <>
                        <span className={`amount${pct > 80 ? ' warn' : ''}`}>{fmtTokens(left)}</span>
                        <span className="meter"><i style={{ width: `${Math.min(100, pct)}%` }} /></span>
                        <span className="dim">{t('us.pctCommitted', { n: committedPct })}</span>
                      </>
                    )}
                  </td>
                  {/*
                    * Joined to the LIVE rows by name. This table is built from `agents`
                    * (configuration) while consumption is measured per agent by the
                    * backend, so the two have to be joined — and until now they were not
                    * joined at all: the cell was a fixed blank, so an agent's ceiling and
                    * its commitment were real on this row while its spend was fabricated
                    * absent. That is what made 已承诺 3% sit next to 系统未计量.
                    */}
                  <td>
                    {live?.tokensUsed == null
                      ? <Blank why="us.why.meterReason" t={t} vars={{ r: live?.tokensReason || t('us.why.noMeter') }} />
                      : (
                        <>
                          {/* Drawn, so this column is comparable to the 额度上限 beside it. */}
                          <span className="amount">{fmtTokens(live.tokensDrawn ?? live.tokensUsed)}</span>
                          {live.tokensByKind?.cacheRead
                            ? <span className="dim">{t('us.rereadNote', { n: fmtTokens(live.tokensByKind.cacheRead) })}</span>
                            : null}
                        </>
                      )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="notice">{t('us.contractNote')}</div>
    </>
  );
}
