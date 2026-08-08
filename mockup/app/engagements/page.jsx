'use client';

import Link from 'next/link';
import PageHead from '@/components/PageHead';
import { Toast, useToast } from '@/components/Toast';
import { Blank } from '@/components/Blank';
import { useT } from '@/components/Prefs';
import {
  pendingEngagements, activeEngagements, endedEngagements, whitelist,
  roleCapacity, remaining, overCommits, fmtTokens, offers, presetOf, agents,
} from '@/lib/mock-data';

/*
 * ④ 接洽 — what replaces dispatch.
 *
 * Nothing here schedules work: which task an agent does is decided on the project
 * side. What the contributor decides is whether to be in a project at all, and
 * for how much.
 *
 * The routing:
 *
 *   whitelisted + within the standing offer + within the agent's ceiling → auto-join
 *   whitelisted + over either                                            → FALLS BACK to approval
 *   not whitelisted                                                      → approval
 *
 * Falling back rather than rejecting is the rule that keeps the two halves
 * coherent: the project did nothing wrong by asking for more than is left, so
 * refusing it would send the wrong signal. The owner decides.
 *
 * Over-commitment is computed PER AGENT, because an engagement draws on one
 * agent's ceiling. Two projects wanting an architect served by the same Opus agent
 * share that 5M — so the approval row has to name the agent BEFORE the decision,
 * not after.
 */

const roleName = (key) => roleCapacity.roles[key]?.displayName ?? key;

/** Why this request needs a decision instead of auto-joining. */
function RouteReason({ e, t }) {
  if (e.route === 'notWhitelisted') {
    return <span className="stranded">{t('en.route.notWhitelisted')}</span>;
  }
  const offer = offers.find((o) => o.role === e.role);
  if (e.route === 'overOffer') {
    return <span className="overqual">{t('en.route.overOffer', { cap: fmtTokens(offer?.budgetCapPerEngagement) })}</span>;
  }
  return (
    <span className="overqual">
      {t('en.route.overCeiling', { left: fmtTokens(remaining(e.agent)), agent: e.agent })}
    </span>
  );
}

export default function EngagementsPage() {
  const t = useT();
  const [toast, say] = useToast();
  const pending = pendingEngagements();
  const active = activeEngagements();
  const ended = endedEngagements();

  return (
    <>
      <PageHead title={t('en.title')} sub={t('en.sub')} />

      {/* The routing stated once, at the top, because every row below is an
          instance of it and a reader who has to infer the rule from examples will
          infer the wrong one. */}
      <div className="notice">{t('en.routingNote')}</div>

      <div className="cards">
        <div className="card">
          <div className="cap">{t('en.cPending')}</div>
          <div className={`val${pending.length > 0 ? ' warn' : ''}`}>{pending.length}</div>
        </div>
        <div className="card"><div className="cap">{t('en.cActive')}</div><div className="val ok">{active.length}</div></div>
        <div className="card"><div className="cap">{t('en.cWhitelisted')}</div><div className="val">{whitelist.length}</div></div>
        <div className="card">
          <div className="cap">{t('en.cCommitted')}</div>
          <div className="val">{fmtTokens(active.reduce((n, e) => n + (e.allocatedTokens ?? 0), 0))}</div>
        </div>
      </div>

      <h2 className="sec">{t('en.pendingHead')}<span className="note">{t('en.pendingNote')}</span></h2>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t('col.project')}</th>
              <th>{t('col.role')}</th>
              <th>{t('en.wouldServe')}</th>
              <th>{t('col.requested')}</th>
              <th>{t('en.needsYou')}</th>
              <th>{t('col.action')}</th>
            </tr>
          </thead>
          <tbody>
            {pending.map((e) => {
              const over = overCommits(e);
              return (
                <tr key={e.id}>
                  <td>
                    <div>{e.project}</div>
                    {/* The room id is the identity; the name is decoration. Shown
                        together so the reader can see which one they are trusting. */}
                    <span className="dim mono-s">{e.projectRoomId}</span>
                    <span className="dim">{`${e.requester} · ${e.since}`}</span>
                  </td>
                  <td>{roleName(e.role)}</td>
                  <td>
                    <Link href={`/agents/${e.agent}`}>{e.agent}</Link>
                    <span className="dim">{t('en.leftN', { n: fmtTokens(remaining(e.agent)) })}</span>
                  </td>
                  <td>
                    <span className="amount">{fmtTokens(e.requestedTokens)}</span>
                    <span className="dim">{`${fmtTokens(e.ratePerDay)}/d`}</span>
                  </td>
                  <td><RouteReason e={e} t={t} /></td>
                  <td>
                    <div className="btn-row tight">
                      <button
                        className="btn primary"
                        onClick={() => say(
                          over ? 'err' : 'ok',
                          over
                            ? t('en.wouldRefuse', { left: fmtTokens(remaining(e.agent)), agent: e.agent })
                            : t('en.wouldApprove', { n: fmtTokens(e.requestedTokens) }),
                        )}
                      >
                        {t('en.approve')}
                      </button>
                      <button className="btn" onClick={() => say('ok', t('en.wouldReject'))}>
                        {t('en.reject')}
                      </button>
                    </div>
                    {/* The constraint is shown before the click, not discovered
                        after it: approving 1.2M against 1.1M remaining is the
                        error this column exists to prevent. */}
                    {over && <span className="stranded">{t('en.wouldOverCommit')}</span>}
                  </td>
                </tr>
              );
            })}
            {pending.length === 0 && (
              <tr><td colSpan={6} className="dim">{t('en.noPending')}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <h2 className="sec">{t('en.activeHead')}<span className="note">{t('en.activeNote')}</span></h2>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t('col.project')}</th><th>{t('col.role')}</th><th>{t('col.agent')}</th>
              <th>{t('col.allocated')}</th><th>{t('col.used')}</th>
              <th>{t('col.joinedHow')}</th><th>{t('col.action')}</th>
            </tr>
          </thead>
          <tbody>
            {active.map((e) => (
              <tr key={e.id}>
                <td><div>{e.project}</div><span className="dim mono-s">{e.projectRoomId}</span></td>
                <td>{roleName(e.role)}</td>
                <td><Link href={`/agents/${e.agent}`}>{e.agent}</Link></td>
                <td className="amount">{fmtTokens(e.allocatedTokens)}</td>
                {/* Same systemic blank as everywhere else: nothing meters tokens. */}
                <td><Blank why="en.why.notMetered" t={t} /></td>
                <td>
                  {/* An auto-approval I cannot see afterwards is indistinguishable
                      from a compromise, so auto-joined engagements are listed
                      rather than hidden. */}
                  {e.autoJoined
                    ? <span className="badge ok">{t('en.autoJoined')}</span>
                    : <span className="badge">{t('en.byApproval')}</span>}
                </td>
                <td>
                  <button className="btn danger" onClick={() => say('ok', t('en.wouldRevoke', { project: e.project }))}>
                    {t('en.revoke')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="sec">{t('en.endedHead')}</h2>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr><th>{t('col.project')}</th><th>{t('col.role')}</th><th>{t('col.allocated')}</th><th>{t('col.reason')}</th></tr>
          </thead>
          <tbody>
            {ended.map((e) => (
              <tr key={e.id}>
                <td>{e.project}</td>
                <td>{roleName(e.role)}</td>
                <td className="amount">{fmtTokens(e.allocatedTokens)}</td>
                <td className="dim">{t(e.endedReason)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Below a divider and under its own heading, because editing it is a
          privilege change and not a preference: adding a project means its future
          requests bypass the owner entirely. */}
      <hr className="divider" />
      <h2 className="sec danger-head">{t('en.wlHead')}<span className="note">{t('en.wlNote')}</span></h2>
      <div className="notice warn">{t('en.wlKeyNote')}</div>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr><th>{t('en.wlRoom')}</th><th>{t('en.wlName')}</th><th>{t('col.added')}</th><th>{t('col.action')}</th></tr>
          </thead>
          <tbody>
            {whitelist.map((w) => (
              <tr key={w.projectRoomId}>
                <td className="mono-s">{w.projectRoomId}</td>
                <td className="dim">{w.displayName}</td>
                <td className="dim">{`${w.addedAt} · ${w.addedBy}`}</td>
                <td>
                  <button className="btn danger" onClick={() => say('ok', t('en.wouldRemove', { name: w.displayName }))}>
                    {t('en.wlRemove')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Removing trust must not kill work in flight, or de-trusting a project
          silently cancels an engagement nobody meant to cancel. */}
      <div className="notice">{t('en.wlRemoveNote')}</div>

      <Toast toast={toast} />
    </>
  );
}
