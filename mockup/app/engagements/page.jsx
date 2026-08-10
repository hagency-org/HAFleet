'use client';

import { useState } from 'react';
import Link from 'next/link';
import PageHead from '@/components/PageHead';
import { Toast, useToast } from '@/components/Toast';
import { Blank } from '@/components/Blank';
import { useT } from '@/components/Prefs';
import { fmtTokens } from '@/lib/mock-data';
import { useData, Provenance } from '@/components/Data';
import { send } from '@/lib/api';

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

/**
 * Why this request needs a decision instead of auto-joining.
 *
 * Reads the data context itself rather than taking `offers` and `remaining` as
 * props. It is a component, so a hook is legal here, and threading two more props
 * through every call site would make the row markup harder to read for no gain.
 */
function RouteReason({ e, t }) {
  const { offers, remaining } = useData();
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
  const {
    pendingEngagements, activeEngagements, endedEngagements, whitelist,
    roleCapacity, remaining, overCommits, offers, presetOf, agents,
    provenance, refresh,
  } = useData();
  const roleName = (key) => roleCapacity.roles[key]?.displayName ?? key;
  const [toast, say] = useToast();
  const [wlRoom, setWlRoom] = useState('');
  const [wlName, setWlName] = useState('');

  /*
   * Real writes when the endpoint is behind the page, simulated otherwise.
   *
   * The server re-derives the headroom and refuses an over-committing allocation
   * itself, so the check the form performs before the click is a courtesy rather
   * than the guard — a client-side-only limit is one any other client can ignore.
   * A refusal is surfaced with the server's own message, which names the agent and
   * what is left on it, because "declined" alone leaves nothing to act on.
   */
  const live = provenance.engagements === 'live';
  async function act(kind, e, body) {
    if (!live) return null;
    const path = kind === 'verdict' ? `engagements/${e.id}/verdict`
      : kind === 'revoke' ? `engagements/${e.id}/revoke`
        : null;
    if (!path) return null;
    const res = await send(path, { body });
    if (res.ok) await refresh();
    else say('fail', res.error);
    return res;
  }

  const pending = pendingEngagements();
  const active = activeEngagements();
  const ended = endedEngagements();

  return (
    <>
      <PageHead title={t('en.title')} sub={t('en.sub')} />

      {/* All five slices have endpoints now. The banner stays because the page's
          controls behave differently behind a live store — they write — and a
          reader pressing Approve is entitled to know whether it committed
          anything. */}
      <Provenance slices={['agents', 'engagements', 'offers', 'whitelist', 'ceilings']} />

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
                    {/* `agent` is legitimately null when no configured agent qualifies
                        for the role. Rendering it anyway produced a link to
                        /agents/null and a headroom of "—" with no explanation; the
                        useful answer is that nothing can serve this request. */}
                    {e.agent ? (
                      <>
                        <Link href={`/agents/${e.agent}`}>{e.agent}</Link>
                        <span className="dim">{t('en.leftN', { n: fmtTokens(remaining(e.agent)) })}</span>
                      </>
                    ) : <Blank why="en.why.noQualifyingAgent" t={t} />}
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
                        onClick={async () => {
                          if (!live) {
                            return say(over ? 'err' : 'ok', over
                              ? t('en.wouldRefuse', { left: fmtTokens(remaining(e.agent)), agent: e.agent })
                              : t('en.wouldApprove', { n: fmtTokens(e.requestedTokens) }));
                          }
                          const res = await act('verdict', e, {
                            approve: true, allocatedTokens: e.requestedTokens,
                          });
                          if (res?.ok) say('ok', t('en.didApprove', { n: fmtTokens(e.requestedTokens) }));
                          return null;
                        }}
                      >
                        {t('en.approve')}
                      </button>
                      <button
                        className="btn"
                        onClick={async () => {
                          if (!live) return say('ok', t('en.wouldReject'));
                          const res = await act('verdict', e, { approve: false, reason: 'rejected from the console' });
                          if (res?.ok) say('ok', t('en.didReject', { id: e.id }));
                          return null;
                        }}
                      >
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
                  <button
                    className="btn danger"
                    onClick={async () => {
                      if (!live) return say('ok', t('en.wouldRevoke', { project: e.project }));
                      const res = await act('revoke', e, { reason: 'revoked from the console' });
                      if (res?.ok) say('ok', t('en.didRevoke', { project: e.project }));
                      return null;
                    }}
                  >
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
                {/* An engagement that ended without ever being approved never had
                    an allocation, and a blank cell here says nothing — the rule
                    everywhere else on this console is that an absence carries its
                    reason. `fmtTokens(null)` returns null, which React renders as
                    literally nothing. */}
                <td>
                  {e.allocatedTokens === null || e.allocatedTokens === undefined
                    ? <Blank why="en.why.neverAllocated" t={t} />
                    : <span className="amount">{fmtTokens(e.allocatedTokens)}</span>}
                </td>
                {/*
                  * The reason may be a dictionary key (the fixture's
                  * `en.ended.completed`) or free text a person typed at the point
                  * of rejection. `t()` returns the key back when it does not
                  * resolve, which printed a raw `en.ended.*` string on screen for
                  * anything the backend recorded.
                  */}
                <td className="dim">{/^[a-z]+\.[a-zA-Z.]+$/.test(e.endedReason ?? '') ? t(e.endedReason) : (e.endedReason ?? '')}</td>
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

      {/*
        * ADDING, which the page could not do at all until now — it offered only
        * removal, so the trust list was read-mostly and the one direction that
        * grants power had no control.
        *
        * The room id is typed, never picked from a list of projects that have
        * asked: a chooser would make it trivial to trust the wrong one by clicking
        * a familiar display name, and the display name is precisely the spoofable
        * part. The backend validates the id shape too, so a mistyped entry is
        * refused rather than stored as a rule that can never match.
        */}
      <form
        className="btn-row"
        style={{ margin: '10px 0 14px', flexWrap: 'wrap' }}
        onSubmit={async (ev) => {
          ev.preventDefault();
          const room = wlRoom.trim();
          if (!room) return say('fail', t('en.wlNeedRoom'));
          if (!live) return say('ok', t('en.wouldAdd', { room }));
          const res = await send('whitelist', {
            body: { projectRoomId: room, displayName: wlName.trim() || null },
          });
          if (!res.ok) return say('fail', res.error);
          setWlRoom('');
          setWlName('');
          await refresh();
          return say('ok', t('en.didAdd', { room }));
        }}
      >
        <input
          className="inp mono-s"
          style={{ minWidth: 260 }}
          value={wlRoom}
          onChange={(e) => setWlRoom(e.target.value)}
          placeholder={t('en.wlRoomPlaceholder')}
          aria-label={t('en.wlRoom')}
        />
        <input
          className="inp"
          style={{ minWidth: 200 }}
          value={wlName}
          onChange={(e) => setWlName(e.target.value)}
          placeholder={t('en.wlNamePlaceholder')}
          aria-label={t('en.wlName')}
        />
        <button className="btn" type="submit">{t('en.wlAdd')}</button>
        <span className="dim" style={{ flexBasis: '100%' }}>{t('en.wlAddWarn')}</span>
      </form>

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
                  <button
                    className="btn danger"
                    onClick={async () => {
                      if (!live) return say('ok', t('en.wouldRemove', { name: w.displayName }));
                      const res = await send(`whitelist/${encodeURIComponent(w.projectRoomId)}`, { method: 'DELETE' });
                      if (!res.ok) return say('fail', res.error);
                      await refresh();
                      /*
                       * The count of surviving engagements is reported, not
                       * swallowed. Removal affects future requests only, so a
                       * silent success would read as "that project is gone" while
                       * its work is still running under the trust just withdrawn.
                       */
                      const still = res.body?.stillActive?.length ?? 0;
                      return say('ok', still > 0
                        ? t('en.didRemoveStillActive', { name: w.displayName ?? w.projectRoomId, n: still })
                        : t('en.didRemove', { name: w.displayName ?? w.projectRoomId }));
                    }}
                  >
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
