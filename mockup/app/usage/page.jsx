'use client';

import Link from 'next/link';
import PageHead from '@/components/PageHead';
import { Blank } from '@/components/Blank';
import { useT } from '@/components/Prefs';
import {
  usage, engagements, roleCapacity, fmtTokens, agents, presetOf, committed, remaining,
} from '@/lib/mock-data';

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
const roleName = (key) => roleCapacity.roles[key]?.displayName ?? key;

export default function UsagePage() {
  const t = useT();

  const byProject = usage.reduce((acc, u) => {
    (acc[u.project] ??= []).push(u);
    return acc;
  }, {});

  const configured = agents.filter((a) => a.presetId);

  return (
    <>
      <PageHead title={t('us.title')} sub={t('us.sub')} />

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
              const pct = Math.round((used / p.ceiling.tokens) * 100);
              return (
                <tr key={a.name}>
                  <td><Link href={`/agents/${a.name}`}>{a.name}</Link></td>
                  <td className="mono-s">{p.model}</td>
                  <td className="amount">{fmtTokens(p.ceiling.tokens)}</td>
                  <td className="amount">{fmtTokens(used)}</td>
                  <td>
                    <span className={`amount${pct > 80 ? ' warn' : ''}`}>{fmtTokens(left)}</span>
                    <span className="meter"><i style={{ width: `${Math.min(100, pct)}%` }} /></span>
                    <span className="dim">{t('us.pctCommitted', { n: pct })}</span>
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
