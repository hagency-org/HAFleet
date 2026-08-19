'use client';

import Link from 'next/link';
import PageHead from '@/components/PageHead';
import { Toast, useToast } from '@/components/Toast';
import { Blank } from '@/components/Blank';
import { useT } from '@/components/Prefs';
import { useData, Provenance } from '@/components/Data';
import { send } from '@/lib/api';

/*
 * ③ 项目 — the projects that have asked for me, and the ones I said yes to.
 *
 * WHY THIS PAGE IS MOSTLY READING. ADR-014's 2026-08-11 amendment: a project dictates how you
 * join it, the way an open-source project runs a Discord and developers join by accepting an
 * invitation. Your account is yours and portable — the invitation authorises entry, it does not
 * issue you an identity. So there is almost nothing to configure here. The homeserver is not a
 * field: a Matrix room id is `!opaque:origin-server`, so the project's server is already inside
 * the id the invitation arrives with, and a typed field could only disagree with it.
 *
 * WHAT THIS REPLACES. An invitation used to have one of two fates, both wrong.
 * `MATRIX_TRUST_MODE` defaults to `audit`, so an agent JOINED any room anyone invited it to
 * while no ownership binding was written — present, messageable, and permanently unengageable,
 * because every approval then failed `owner_binding_missing`. Under `enforce` the invitation was
 * skipped with a log line nobody sees. Either way the contributor never learned it had happened,
 * and "joining a project" actually meant editing `.env` and restarting the bridge.
 *
 * WHY ACCEPTING IS A BUTTON AND NOT A LINK CLICK. This is where the Discord analogy stops:
 * joining a Discord costs the joiner nothing, and lending an agent spends the contributor's
 * tokens. So the decision stays theirs, deliberately, and it is audited.
 *
 * WHAT ACCEPTING DOES — and the one thing it does NOT do. It joins the room, marks it trusted,
 * and records that the inviter owns this agent here (ADR-002: the owner IS the inviter, so
 * accepting an invitation is how ownership is established). It does NOT whitelist the project.
 * The whitelist decides who may skip approval entirely (ADR-013 decision 4), which is a much
 * stronger statement than "this agent may be in this project" — granting it on the strength of
 * an invitation from someone just met is exactly the conflation to avoid. Whitelisting stays on
 * /engagements, where it is its own act.
 */

/** The project's homeserver, read off the room id rather than configured. */
function serverOf(roomId) {
  if (typeof roomId !== 'string') return null;
  const at = roomId.indexOf(':');
  return at > 0 ? roomId.slice(at + 1) : null;
}

export default function ProjectsPage() {
  const t = useT();
  const { invites, whitelist, contributions, provenance, refresh } = useData();
  const [toast, say] = useToast();

  /*
   * A decision is only real against a live backend. The proxy is what carries it, and a static
   * export has no proxy — so rather than pretend, the buttons say what would happen.
   */
  const live = provenance.invites === 'live';

  async function decide(invite, accept) {
    if (!live) {
      return say('ok', t(accept ? 'pr.wouldAccept' : 'pr.wouldDecline', { agent: invite.agent }));
    }
    const res = await send('matrix/pending-invites/decide', {
      body: { projectRoomId: invite.projectRoomId, agent: invite.agent, accept },
    });
    if (!res.ok) return say('fail', res.error);
    await refresh();
    /*
     * "Queued", not "joined". Only the bridge can join a Matrix room; the backend records the
     * answer and broadcasts it. Saying the agent is in the project when the join has not been
     * confirmed is the same defect class as an approval that allocated budget and silently failed
     * to attach the agent.
     */
    return say('ok', t(accept ? 'pr.didAccept' : 'pr.didDecline', { agent: invite.agent }));
  }

  const pending = Array.isArray(invites) ? invites : [];

  /*
   * The projects I am already in, assembled from what the console already knows rather than from
   * a new endpoint: a contribution binding is the record that actually lets a project reach an
   * agent, so its project room is a project I accepted.
   */
  const joined = [];
  const seen = new Set();
  for (const c of (contributions ?? [])) {
    const room = c.projectRoomId ?? c.project_room_id;
    if (!room || seen.has(room)) continue;
    seen.add(room);
    joined.push({
      projectRoomId: room,
      project: c.project ?? null,
      agents: (contributions ?? [])
        .filter((x) => (x.projectRoomId ?? x.project_room_id) === room)
        .map((x) => x.agent)
        .filter(Boolean),
      /*
       * B1: IS THE AGENT ACTUALLY IN THIS ROOM?
       *
       * A binding is what lets a project reach an agent, and this table is how a contributor reads
       * which projects they are in. Nothing compared it to Matrix membership, so an operator asking
       * why their agent showed in three projects could only be answered by reading `m.room.member`
       * for three rooms by hand. The bridge now observes it and the backend carries it.
       *
       * THREE STATES, and the third is why this is not a boolean: `false` means the agent is not in
       * a room this binding claims can reach it, and `null` means nobody has looked yet. Rendering
       * null as a problem would accuse every binding before the bridge's first pass; rendering it
       * as fine would be the original defect with extra steps.
       */
      unreachable: (contributions ?? [])
        .filter((x) => (x.projectRoomId ?? x.project_room_id) === room && x.agentJoined === false)
        .map((x) => x.agent),
      unchecked: (contributions ?? [])
        .filter((x) => (x.projectRoomId ?? x.project_room_id) === room && (x.agentJoined ?? null) === null)
        .map((x) => x.agent),
      whitelisted: (whitelist ?? []).some((w) => w.projectRoomId === room),
    });
  }

  return (
    <>
      <PageHead title={t('pr.title')} sub={t('pr.sub')} />

      {/*
        * THE WAY IN, which did not exist. `/projects/new` — the whole four-step flow for taking on a customer
        * — was reachable only by typing the URL: no page and no nav item linked to it. `/resources/new` has
        * had a button on its own list page all along, so this is the same pattern, not a new one.
        *
        * It matters more here than anywhere else in the console: adding a customer is the FIRST thing a new
        * operator does, and an operator who cannot find it has no fleet at all. Found by trying to write a
        * click-by-click guide and having nowhere to tell the reader to click.
        */}
      <div className="btn-row">
        <Link className="btn primary" href="/projects/new">{t('pr.addSide')}</Link>
      </div>

      <Provenance slices={['invites', 'contributions', 'whitelist']} />

      <section className="card">
        <h2>
          {t('pr.pendingTitle')}
          {pending.length > 0 && <span className="badge">{pending.length}</span>}
        </h2>
        <p className="dim">{t('pr.pendingWhy')}</p>

        {provenance.invites === 'absent' ? (
          /*
           * NOT an empty list. "No project is waiting on you" is a claim, and when this endpoint
           * did not answer the truth is that nobody asked the question — a contributor who reads
           * "nothing pending" and looks away has been misinformed.
           */
          <Blank why="pr.why.invitesAbsent" t={t} />
        ) : pending.length === 0 ? (
          <p className="dim">{t('pr.nonePending')}</p>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('pr.colProject')}</th>
                <th>{t('pr.colServer')}</th>
                <th>{t('pr.colInviter')}</th>
                <th>{t('pr.colAgent')}</th>
                <th>{t('pr.colDecide')}</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((inv) => {
                /*
                 * The inviter is the owner (ADR-002), so an invitation whose sender could not be
                 * read cannot be accepted — the bridge refuses it rather than storing a null
                 * owner, which would look accepted and work for nothing. Shown here so the
                 * refusal is not a surprise at the click.
                 */
                const acceptable = Boolean(inv.inviter);
                return (
                  <tr key={`${inv.projectRoomId} ${inv.agent}`}>
                    <td><code>{inv.projectRoomId}</code></td>
                    <td>{inv.projectServer ?? serverOf(inv.projectRoomId) ?? <Blank why="pr.why.noServer" t={t} />}</td>
                    <td>
                      {inv.inviter
                        ? <code>{inv.inviter}</code>
                        : <span className="stranded">{t('pr.noInviter')}</span>}
                    </td>
                    <td>{inv.agent}</td>
                    <td>
                      <button
                        type="button"
                        disabled={!acceptable}
                        title={acceptable ? undefined : t('pr.noInviterWhy')}
                        onClick={() => decide(inv, true)}
                      >
                        {t('pr.accept')}
                      </button>
                      {' '}
                      <button type="button" onClick={() => decide(inv, false)}>
                        {t('pr.decline')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>{t('pr.joinedTitle')}</h2>
        <p className="dim">{t('pr.joinedWhy')}</p>

        {provenance.contributions === 'absent' ? (
          <Blank why="pr.why.contributionsAbsent" t={t} />
        ) : joined.length === 0 ? (
          <p className="dim">{t('pr.noneJoined')}</p>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('pr.colProject')}</th>
                <th>{t('pr.colServer')}</th>
                <th>{t('pr.colMyAgents')}</th>
                <th>{t('pr.colSkipsApproval')}</th>
              </tr>
            </thead>
            <tbody>
              {joined.map((p) => (
                <tr key={p.projectRoomId}>
                  <td>
                    <code>{p.projectRoomId}</code>
                    {p.project && <><br /><small>{p.project}</small></>}
                  </td>
                  <td>{serverOf(p.projectRoomId) ?? <Blank why="pr.why.noServer" t={t} />}</td>
                  <td>
                    {p.agents.join(', ') || <Blank why="pr.why.noAgents" t={t} />}
                    {/*
                      * Named where the claim is made. A binding that says a project can reach this
                      * agent, for a room the agent is not in, is the one thing this column must not
                      * present as ordinary.
                      */}
                    {p.unreachable.length > 0 && (
                      <div>
                        <span className="badge attention">
                          {t('pr.notJoined', { a: p.unreachable.join(', ') })}
                        </span>
                      </div>
                    )}
                    {p.unreachable.length === 0 && p.unchecked.length > 0 && (
                      <span className="why-inline">{t('pr.membershipUnchecked')}</span>
                    )}
                  </td>
                  <td>
                    {/*
                      * Deliberately a separate column rather than implied by being here.
                      * Accepting an invitation and letting a project skip approval are different
                      * decisions, and a row that showed only "joined" would hide which projects
                      * can commit capacity without asking.
                      */}
                    {p.whitelisted
                      ? <span className="overqual">{t('pr.skipsYes')}</span>
                      : <span className="dim">{t('pr.skipsNo')}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="dim">
          {t('pr.whitelistElsewhere')} <Link href="/engagements">{t('nav.engagements')}</Link>
        </p>
      </section>

      <Toast toast={toast} />
    </>
  );
}
