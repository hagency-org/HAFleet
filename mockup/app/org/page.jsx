'use client';

import Link from 'next/link';
import PageHead from '@/components/PageHead';
import { Toast, useToast } from '@/components/Toast';
import { useProjectedView, ViewToggle, Blank } from '@/components/ViewToggle';
import { useT } from '@/components/Prefs';
import {
  orgGroups, unallocatedWorkers, unregisteredGroups, retiredRoles, roles,
  roleOf, TIER_RUNTIME, roleCommand, API_BASE,
} from '@/lib/mock-data';

/*
 * Organization — the DOTTED line, and the PDU manager's entrance.
 *
 * This replaces four pages that were each one slice of the same population by one
 * attribute: /workforce (state), /capacity (staffing), /performance (score),
 * /knowledge (memory). They still exist as URLs, but as destinations they asked the
 * reader to reassemble one group's picture from four places, carrying agent names
 * between routes. A group is the scope; those four are its sections.
 *
 * The chart is AUTHORED. Roles are not a constant in lib/matrix-agent.js — that
 * ROLES array is never imported by the backend, and agentRole() returns agent.role
 * verbatim — they are job descriptions this manager wrote, each composing a minimum
 * tier with required skills. So this page is the catalogue and the org chart at once.
 */

/** `strong` on a role whose minimum is `medium` is a cost, not an error. Say which. */
function OverQual({ row, t }) {
  return (
    <span className="overqual">
      {t('og.overQualWhy', {
        have: row.worker.capability,
        need: row.role.minTier,
        runtime: TIER_RUNTIME[row.worker.capability],
      })}
    </span>
  );
}

function RoleCard({ g, t }) {
  const { role } = g;
  return (
    <div className={`rolecard${g.gap === 'unhireable' ? ' unhireable' : ''}`}>
      <div className="rc-head">
        <Link href={`/org/${role.key}`} className="rc-name">{role.name}</Link>
        <span className="rc-stage">{t(`stage.${role.stage}`)}</span>
      </div>

      {/* The definition, above the staffing. A card that leads with a headcount
          invites the reader to treat the role as a bucket that already exists;
          it is a specification somebody wrote, and it can be wrong. */}
      <div className="rc-def">
        <code className="rc-key">{role.key}</code>
        {role.wireNew && <span className="badge attention">{t('og.wireNew')}</span>}
        <span className="rc-min">{t('og.min', { tier: role.minTier })}</span>
        {role.narrowedFrom && (
          <span className="badge attention">{t('og.narrowed', { tier: role.narrowedFrom })}</span>
        )}
      </div>
      <div className="rc-skills">
        {role.skills.map((s) => <span className="chip-skill" key={s}>{s}</span>)}
      </div>

      <div className="rc-staff">
        {g.allocated.length === 0 ? (
          <div className={`rc-gap${g.gap === 'unhireable' ? ' bad' : ''}`}>
            {/* Two different problems, two different actions: one is a click, the
                other is a hiring decision. A single "0 allocated" hides which. */}
            {t(`og.gap.${g.gap}`, { n: g.gap === 'contended' ? g.qualified.length : g.eligible.length })}
          </div>
        ) : (
          <ul className="rc-list">
            {g.allocated.map((a) => (
              <li key={a.agent}>
                <Link href={`/agents/${a.agent}`}>{a.agent}</Link>
                <span className="rc-tier">{a.worker.capability}</span>
                {a.aliased && (
                  <span className="badge">{t('og.aliasTo', { from: a.aliased.from, to: a.aliased.to })}</span>
                )}
                {/* Floor routes, fix accounts. Wherever the worker's own tier
                    exceeds the role's minimum both are rendered, because the
                    substitution is otherwise silent and the bill is not. */}
                {a.match.tierDelta > 0 && <OverQual row={a} t={t} />}
                {!a.match.ok && (
                  <span className="stranded">
                    {t('og.strandedWhy', { why: t(`sat.${a.match.failedClause}`) })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {g.eligible.length > 0 && g.allocated.length > 0 && (
          <div className="rc-elig">{t('og.eligibleMore', { n: g.eligible.length })}</div>
        )}
      </div>
    </div>
  );
}

export default function OrgPage() {
  const t = useT();
  const [view, choose] = useProjectedView();
  const [toast, say] = useToast();

  const groups = orgGroups(view);
  const free = unallocatedWorkers(view);
  const unregistered = unregisteredGroups(view);
  const stranded = groups.flatMap((g) => g.stranded);
  const overQualified = groups.flatMap((g) => g.overQualified);
  const allocatedCount = groups.reduce((n, g) => n + g.allocated.length, 0);

  return (
    <>
      <PageHead title={t('og.title')} sub={t('og.sub', { n: roles.length })}>
        <ViewToggle view={view} choose={choose} />
        <button className="btn" onClick={() => say('ok', t('og.defineTodo'))}>
          {t('og.define')}
        </button>
      </PageHead>

      {view === 'assigned' && <div className="notice warn">{t('cap.assignedHypothetical')}</div>}

      {/* The honest state is not "empty", it is "nobody has done the classifying
          step yet" — and that is actionable, which an empty grid never was. */}
      {view === 'unassigned' && (
        <div className="notice">{t('og.noneAllocated', { n: free.length })}</div>
      )}

      <div className="cards">
        <div className="card"><div className="cap">{t('og.cRoles')}</div><div className="val">{roles.length}</div></div>
        <div className="card">
          <div className="cap">{t('og.cAllocated')}</div>
          <div className={`val${allocatedCount === 0 ? ' warn' : ''}`}>{allocatedCount}</div>
        </div>
        <div className="card">
          <div className="cap">{t('og.cUnallocated')}</div>
          <div className={`val${free.length > 0 ? ' warn' : ''}`}>{free.length}</div>
        </div>
        <div className="card">
          <div className="cap">{t('og.cUnfilled')}</div>
          <div className="val">{groups.filter((g) => g.allocated.length === 0).length}</div>
        </div>
        <div className="card">
          <div className="cap">{t('og.cStranded')}</div>
          <div className={`val${stranded.length > 0 ? ' warn' : ''}`}>{stranded.length}</div>
        </div>
      </div>

      <h2 className="sec">
        {t('og.catalogue')}
        <span className="note">{t('og.skillsAsserted')}</span>
      </h2>
      <div className="rolegrid">
        {groups.map((g) => <RoleCard key={g.role.key} g={g} t={t} />)}
      </div>

      {overQualified.length > 0 && (
        <>
          <h2 className="sec">{t('og.overQual')}<span className="note">{t('og.overQualNote')}</span></h2>
          <div className="panel">
            {overQualified.map((a) => (
              <div className="prov-row" key={a.agent}>
                <Link href={`/agents/${a.agent}`}>{a.agent}</Link>
                <OverQual row={a} t={t} />
              </div>
            ))}
          </div>
        </>
      )}

      {stranded.length > 0 && (
        <>
          <h2 className="sec">{t('og.stranded')}<span className="note">{t('og.strandedNote')}</span></h2>
          <div className="panel">
            {stranded.map((a) => (
              <div className="prov-row" key={a.agent}>
                <Link href={`/agents/${a.agent}`}>{a.agent}</Link>
                <span className="stranded">
                  {t('og.strandedRow', {
                    role: a.role.name,
                    why: t(`sat.${a.match.failedClause}`),
                    have: a.worker.capability,
                    need: a.role.minTier,
                  })}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <h2 className="sec">{t('og.unallocated')}<span className="note">{t('og.unallocatedNote')}</span></h2>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t('col.agent')}</th>
              <th>{t('og.hasTier')}</th>
              <th>{t('og.hasSkills')}</th>
              <th>{t('og.eligibleFor')}</th>
              <th>{t('col.action')}</th>
            </tr>
          </thead>
          <tbody>
            {free.map((w) => (
              <tr key={w.agent}>
                <td><Link href={`/agents/${w.agent}`}>{w.agent}</Link></td>
                <td>{w.capability}</td>
                <td className="dim">{w.skills.length ? w.skills.join(', ') : <Blank why="og.noSkills" t={t} />}</td>
                <td>
                  {w.eligibleFor.length === 0
                    ? <Blank why="og.eligibleNone" t={t} />
                    : w.eligibleFor.map((k) => (
                      <Link className="chip-role" key={k} href={`/org/${k}`}>{roleOf(k).name}</Link>
                    ))}
                </td>
                <td>
                  <button
                    className="btn"
                    disabled={w.eligibleFor.length === 0}
                    onClick={() => say(
                      w.eligibleFor.length ? 'ok' : 'err',
                      t('og.allocateTodo', { agent: w.agent }),
                    )}
                  >
                    {t('og.allocate')}
                  </button>
                </td>
              </tr>
            ))}
            {free.length === 0 && (
              <tr><td colSpan={5} className="dim">{t('og.allAllocated')}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Allocation is not fully expressible against today's API and the page says so
          rather than shipping a form that silently sends half a write. PATCH
          /api/agents/:name destructures `role` and NOT `capability`, so the tier half
          of an allocation never lands. */}
      <div className="notice">
        {t('og.patchGap')}
        <pre className="cmd">{roleCommand({ name: '<agent>', role: '<role-key>' }).patch}</pre>
        <span className="dim">{t('og.patchGapApi', { base: API_BASE })}</span>
      </div>

      <h2 className="sec">{t('og.retired')}<span className="note">{t('og.retiredNote')}</span></h2>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr><th>{t('og.retiredKey')}</th><th>{t('og.aliasHead')}</th><th>{t('col.state')}</th></tr>
          </thead>
          <tbody>
            {retiredRoles.map((r) => (
              <tr key={r.key}>
                <td><code>{r.key}</code></td>
                <td><Link href={`/org/${r.aliasTo}`}>{roleOf(r.aliasTo).name}</Link></td>
                <td><span className="badge ok">{t('og.stillRoutes')}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {unregistered.length > 0 && (
        <>
          <h2 className="sec">{t('og.unregistered')}</h2>
          <div className="notice warn">{t('og.unregisteredNote', { keys: unregistered.join(', ') })}</div>
        </>
      )}

      <Toast toast={toast} />
    </>
  );
}
