'use client';

import Link from 'next/link';
import PageHead from '@/components/PageHead';
import { Blank } from '@/components/Blank';
import { CeilingBars, AllocationDonut, TaskBars, MissingSeries } from '@/components/Charts';
import { useT } from '@/components/Prefs';
import { fmtTokens, fmtSpanSec } from '@/lib/mock-data';
import { useData, Provenance } from '@/components/Data';

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
        * Tokens is the interesting one, and it is not a missing field. HAFleet
        * launches a CLI that talks to the provider directly, so no API response
        * passes through it to read a usage figure from — in api-key mode as much as
        * on a subscription. The routes that could work are listed rather than
        * merely admitted, because a named route is a decision someone can take.
        */}
      {metering && (
        <>
          <h2 className="sec" style={{ marginTop: 0 }}>
            {t('us.measured')}<span className="note">{t('us.measuredNote')}</span>
          </h2>
          <div className="cards">
            {[
              ['us.sigTasks', metering.tasks],
              ['us.sigBusy', metering.busyTime],
              ['us.sigTokens', metering.tokens],
            ].map(([key, sig]) => (
              <div className="card" key={key}>
                <div className="cap">{t(key)}</div>
                <div className={`val${sig?.available ? ' ok' : ' warn'}`} style={{ fontSize: 15 }}>
                  {t(sig?.available ? 'us.sigYes' : 'us.sigNo')}
                </div>
                <span className="dim">{sig?.source ?? sig?.reason ?? ''}</span>
              </div>
            ))}
          </div>
          {metering.tokens?.candidateSources?.length > 0 && (
            <div className="notice warn">
              <div>{t('us.tokenRoutes')}</div>
              <ul style={{ margin: '6px 0 0 18px' }}>
                {metering.tokens.candidateSources.map((c) => <li key={c}>{c}</li>)}
              </ul>
            </div>
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
                    <td><Blank why="us.why.noMeter" t={t} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Said once, plainly, at the top. The alternative — a dash on every row —
          reads as many small unknowns rather than one systemic one. */}
      <div className="notice warn">{t('us.notMeteredNote')}</div>

      <div className="cards">
        <div className="card"><div className="cap">{t('us.cEngagements')}</div><div className="val">{usage.length}</div></div>
        <div className="card">
          <div className="cap">{t('us.cAllocated')}</div>
          <div className="val">
            {fmtTokens(engagements.filter((e) => e.state !== 'pending').reduce((n, e) => n + (e.allocatedTokens ?? 0), 0))}
          </div>
        </div>
        <div className="card">
          <div className="cap">{t('us.cSpent')}</div>
          {/* The headline figure a contributor came for, and it is a blank. Making
              it a card rather than hiding it keeps the gap visible instead of
              letting the page look complete. */}
          <div className="val"><Blank why="us.why.noMeter" t={t} /></div>
        </div>
        <div className="card"><div className="cap">{t('us.cTasks')}</div><div className="val">{usage.reduce((n, u) => n + u.tasksDone, 0)}</div></div>
      </div>

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
                      <td>
                        {u.tokensUsed === null
                          ? <Blank why="us.why.noMeter" t={t} />
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
              const used = committed(a.name);
              const left = remaining(a.name);
              const pct = p?.ceiling ? Math.round((used / p.ceiling.tokens) * 100) : null;
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
                        <span className="dim">{t('us.pctCommitted', { n: pct })}</span>
                      </>
                    )}
                  </td>
                  <td><Blank why="us.why.noMeter" t={t} /></td>
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
