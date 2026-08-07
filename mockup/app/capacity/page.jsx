'use client';

import { Fragment, useEffect, useState } from 'react';
import Link from 'next/link';
import PageHead from '@/components/PageHead';
import { useT } from '@/components/Prefs';
import {
  pool, dispatch, cellAgents, coveringTier, gridTotal, seats, burn,
  ROLES, CAPABILITY_TIERS, TIER_RUNTIME, ROLE_DEFAULT_TIER,
} from '@/lib/mock-data';

/*
 * Capacity — the human window onto the matrix-Agent scheduler.
 *
 * Third version of this page, and the first built from the scheduler rather than from
 * the page that renders it. What the two earlier drafts got wrong:
 *
 *  1. "Retire it if nothing reads /api/pool." Wrong — lib/matrix-agent.js and
 *     src/dispatch-lease-store.mjs both read it.
 *  2. Invented axes: shell/git/web/browser x coder/reviewer/researcher/operator. The
 *     real model is three ORDERED capability tiers (strong / medium / lightweight)
 *     against six organisational roles, tiers as rows, matching pool-page.js.
 *  3. Worse than either: it invented POPULATED data. On this fleet the grid is empty,
 *     and drawing a busy-looking scheduler for a feature that was never connected is
 *     the one failure mode a mockup must not have — an implementer would conclude that
 *     wiring up the API produces rows.
 *
 * So the page opens on the truth and offers the populated layout as an explicitly
 * labelled second view. Both views are the same five agents.
 */

function Cell({ state, role, tier, t }) {
  const here = cellAgents(state, role, tier);
  // The tier that would actually serve this cell, or null. Non-null with an empty cell
  // means a stronger idle agent in this role covers it — the distinction an idle/total
  // count could not express, and the reason the old legend ("– not supported") misled.
  const via = coveringTier(state, role, tier);
  const canRoute = via !== null;

  if (here.length === 0) {
    /*
     * A glyph is not a state. These cells used to render `—` or a green `↑` with the
     * meaning only in `title`, which is mark-plus-colour with the word in a tooltip:
     * invisible to touch, unreliable on a <td>, and the exact rule the severity dot
     * component exists to enforce everywhere else. The mark stays — it is what makes the
     * grid scannable — and the word joins it. `↑ strong` also says more than `↑` did: it
     * names the tier that covers the request.
     */
    return (
      <td
        className={canRoute ? 'cap-via' : 'dim'}
        title={t(canRoute ? 'cap.viaStronger' : 'cap.wouldQueue')}
      >
        <span className="cap-mark">{canRoute ? '↑' : '—'}</span>
        {canRoute ? t('cap.cellVia', { tier: via }) : t('cap.cellQueues')}
      </td>
    );
  }
  // Every cell state carries its routing consequence, not just the empty ones — the
  // question the operator has is "can I dispatch here", and a staffed-but-all-busy cell
  // answers that the same way an empty one does.
  return (
    <td title={t(canRoute ? 'cap.wouldRoute' : 'cap.wouldQueue')}>
      <div className="cap-cell">
        {here.map((a) => (
          <span key={a.name} className={`agent-chip${a.busy ? ' busy' : ' idle'}`}>
            {a.name}
            <i>{t(a.busy ? 'cap.busyNow' : 'cap.idleNow')}</i>
          </span>
        ))}
      </div>
    </td>
  );
}

export default function CapacityPage() {
  const t = useT();
  const [view, setView] = useState('unassigned');

  /*
   * The view is a selection, and this design's standing invariant is that selection
   * round-trips through the URL. Holding it in component state alone cost three things
   * that were not obvious until listed: `?view=assigned` was not linkable, a reload lost
   * it, and no URL-driven test or screenshot could reach the populated grid at all — so
   * the wide view was the one the responsive sweep never saw.
   *
   * Plain history rather than useSearchParams(): the server render then stays the honest
   * default view, which is what check-invariants.mjs reads, and the page needs no
   * Suspense boundary to keep prerendering.
   */
  useEffect(() => {
    const read = () => setView(
      new URLSearchParams(window.location.search).get('view') === 'assigned'
        ? 'assigned'
        : 'unassigned',
    );
    read();                                   // a deep link, or a reload
    window.addEventListener('popstate', read); // and Back returns to the previous view
    return () => window.removeEventListener('popstate', read);
  }, []);

  function choose(next) {
    setView(next);
    window.history.pushState(null, '', next === 'assigned' ? '?view=assigned' : window.location.pathname);
  }

  const state = pool[view];
  // Emptiness is a property of the cells, never of `state.total` — /api/pool's `total` is
  // `records.length`, which is 5 on this fleet while the grid is `{}`.
  const empty = gridTotal(state) === 0;

  return (
    <>
      <PageHead title={t('cap.title')} sub={t('cap.sub', { n: '8s' })}>
        {/* Two views, and the honest one is the default. */}
        <div className="prefs-row" role="group" aria-label={t('cap.viewNote')}>
          {[['unassigned', t('cap.viewNow')], ['assigned', t('cap.viewAssigned')]].map(([k, label]) => (
            <button key={k} className="seg" aria-pressed={view === k} onClick={() => choose(k)}>
              {label}
            </button>
          ))}
        </div>
      </PageHead>

      <p className="dim" style={{ fontSize: 12.5 }}>{t('cap.axisNote')}</p>

      {/* The pressed segment button is the only thing marking this view as hypothetical,
          and by the time the operator reaches Active leases it is a screen and a half
          above them. A lease table with rows in it is exactly what makes an implementer
          conclude that wiring up the API produces data, so the label travels with the
          view rather than sitting in the header. */}
      {view === 'assigned' && <div className="notice warn">{t('cap.assignedHypothetical')}</div>}

      {empty && (
        <>
          <div className="empty" style={{ marginTop: 14 }}>
            <div className="big">{t('cap.emptyGrid')}</div>
            <p className="small">{t('cap.emptyWhy', { n: state.unassignedAgents.length })}</p>
          </div>
          {/* Stated separately, because an empty grid is not cosmetic: it means
              dispatch cannot route at all. */}
          <div className="notice warn">{t('cap.emptyConsequence')}</div>
          <div className="notice">{t('cap.emptyFix')}</div>

          <h2 className="sec">{t('cap.unassignedAgents')}</h2>
          <div className="panel">
            <div className="cap-cell">
              {state.unassignedAgents.map((n) => (
                <span key={n} className="agent-chip">
                  <Link href={`/agents/${n}`}>{n}</Link>
                  <i>role=null</i>
                </span>
              ))}
            </div>
            <div className="btn-row" style={{ marginTop: 12 }}>
              <Link className="btn primary" href="/onboard">{t('cap.setRoles')}</Link>
            </div>
          </div>
        </>
      )}

      {/* The grid renders either way. Eighteen empty cells is itself the finding, and
          hiding it would leave the operator without the shape of what is missing. */}
      <div className="tbl-wrap" style={{ marginTop: 16 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>{t('cap.tier')}</th>
              <th>{t('cap.runtime')}</th>
              {ROLES.map((r) => <th key={r}>{r}</th>)}
            </tr>
          </thead>
          <tbody>
            {CAPABILITY_TIERS.map((tier) => (
              <tr key={tier}>
                <td>{tier}</td>
                <td className="faint" style={{ fontSize: 11.5 }}>{TIER_RUNTIME[tier]}</td>
                {ROLES.map((role) => (
                  <Cell key={role} state={state} role={role} tier={tier} t={t} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* The last two entries show the marks the cells actually use, not a colour swatch
          standing in for them — a legend that keys a square to something rendered as text
          is a third notation to learn. */}
      <div className="legend">
        <span><i className="lg idle" />{t('cap.idleNow')}</span>
        <span><i className="lg busy" />{t('cap.busyNow')}</span>
        <span><b className="lg-mark ok">↑</b>{t('cap.viaStronger')}</span>
        <span><b className="lg-mark">—</b>{t('cap.wouldQueue')}</span>
      </div>

      <p className="dim" style={{ fontSize: 12.5, marginTop: 10, maxWidth: '82ch' }}>
        {t('cap.substitution')}
      </p>

      <div className="tbl-wrap" style={{ marginTop: 14 }}>
        <table className="tbl">
          <thead><tr><th>{t('col.role')}</th><th>{t('cap.defaultTier')}</th></tr></thead>
          <tbody>
            {ROLES.map((r) => (
              <tr key={r}>
                <td>{r}</td>
                <td className="dim">{ROLE_DEFAULT_TIER[r]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="sec">
        {t('cap.activeLeases')}
        <span className="note">{t('cap.leaseNote')}</span>
      </h2>
      {state.leases.length === 0 ? (
        <div className="notice">{t('cap.noLeases')}</div>
      ) : (
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t('col.agent')}</th><th>{t('col.cell')}</th><th>{t('col.owner')}</th>
              <th>{t('col.lease')}</th><th className="num">{t('col.expiresIn')}</th>
            </tr>
          </thead>
          <tbody>
            {state.leases.map((l) => (
              <tr key={l.leaseId}>
                <td>{l.agent}</td>
                <td className="dim">{`${l.role} · ${l.capability}`}</td>
                <td className="dim">{l.owner}</td>
                <td className="faint">{l.leaseId}</td>
                <td className="num">{l.expiresIn}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
      <p className="dim" style={{ fontSize: 12, marginTop: 8 }}>
        {t('cap.ttlNote', { n: dispatch.leaseTtlMinutes })}
      </p>

      {state.queuedTickets.length > 0 && (
        <>
          <h2 className="sec">
            {t('cap.waitingCell')}
            <span className="note">{t('cap.waitingNote')}</span>
          </h2>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('col.ticket')}</th><th>{t('col.cell')}</th>
                  <th className="num">{t('col.waitingFor')}</th>
                </tr>
              </thead>
              <tbody>
                {state.queuedTickets.map((tk) => (
                  <tr key={tk.ticket}>
                    <td className="faint">{tk.ticket}</td>
                    <td className="dim">{`${tk.role} · ${tk.capability}`}</td>
                    <td className="num">{tk.waiting}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="dim" style={{ fontSize: 12, marginTop: 8 }}>{t('cap.twoQueues')}</p>
        </>
      )}

      {/* Seats are the commercial resource and they are not the agent: two
          employees on one credential home draw on one subscription window. An
          agent-keyed model counts that capacity — and that spend — twice. */}
      <h2 className="sec">{t('cap.seats')}<span className="note">{t('cap.seatsNote')}</span></h2>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t('col.seat')}</th><th>{t('col.boundTo')}</th>
              <th>{t('col.window')}</th><th className="num">{t('col.headroom')}</th>
            </tr>
          </thead>
          <tbody>
            {seats.map((s) => (
              <tr key={s.id}>
                <td className="faint">{s.id}</td>
                <td>
                  {s.boundTo.join(', ')}
                  <div className="faint" style={{ fontSize: 10.5 }}>
                    {s.boundTo.length > 1 ? t('cap.sharedBy', { n: s.boundTo.length }) : t('cap.soleHolder')}
                  </div>
                </td>
                <td className="dim">
                  {s.window ?? t('cap.metered')}
                  <div className="faint" style={{ fontSize: 10.5 }}>
                    {s.resetsIn ? t('cap.resetsIn', { n: s.resetsIn }) : t('cap.noWindow')}
                  </div>
                </td>
                <td className="num">
                  {s.headroom === null
                    ? (<><span className="mk-dash">—</span><span className="why-inline">{t('cap.perToken')}</span></>)
                    : (
                      <>
                        {`${s.headroom}%`}
                        <span className="meter" aria-hidden="true">
                          <i className={s.headroom > 20 ? 'ok' : ''} style={{ width: `${Math.max(2, s.headroom)}%` }} />
                        </span>
                      </>
                    )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {seats.some((s) => s.boundTo.length > 1) && (
        <div className="notice warn">{t('cap.sharedSeat')}</div>
      )}

      <h2 className="sec">{t('cap.burn')}</h2>
      <div className="panel">
        <dl className="kv">
          {burn.byProject.map((r) => (
            <Fragment key={r.project}>
              <dt>{r.project}</dt>
              <dd>
                {r.amount === null
                  ? (<><span className="mk-dash">—</span><span className="why-inline">{t(r.why)}</span></>)
                  : (
                    <>
                      {`${burn.currency}${r.amount.toFixed(2)}`}
                      <span className="prov">{t(`prov.${r.provenance}`)}</span>
                    </>
                  )}
              </dd>
            </Fragment>
          ))}
        </dl>
        <h3 className="sec" style={{ marginTop: 14 }}>{t('cap.coverage')}</h3>
        <span className="meter" style={{ height: 8 }} aria-hidden="true">
          <i style={{ width: `${burn.coveragePct}%` }} />
        </span>
        <p className="dim" style={{ fontSize: 11.5, margin: '8px 0 0' }}>
          {t('cap.coverageNote', { n: burn.coveragePct })}
        </p>
      </div>

      <div className="notice" style={{ marginTop: 22 }}>
        <strong>{t(dispatch.autoProvisionCap > 0 ? 'cap.autoProvOn' : 'cap.autoProvOff')}</strong>{' '}
        {t('cap.autoProvNote', { n: dispatch.autoProvisionCap })}
      </div>
    </>
  );
}
