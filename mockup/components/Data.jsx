'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useT } from '@/components/Prefs';
import { makeDerive } from '@/lib/derive';
import { fetchLive, CONTRACT_SLICES } from '@/lib/api';
import * as fixture from '@/lib/mock-data';

/*
 * One data context for the console, with provenance attached.
 *
 * The fixture is the INITIAL value, not a fallback of last resort. Two reasons:
 * the static export has no proxy at all and must render something true about the
 * design, and a first paint that is blank-then-populated makes every assertion
 * racy. So pages always have data; what changes is where it came from.
 *
 * `useData()` returns the fixture's exact export names plus `provenance`, so a
 * page reads `presetOf`, `committed` and `capability` without knowing or caring
 * which source is behind them. The derivations come from one factory
 * (lib/derive.js) for the same reason.
 */

const FIXTURE_DATA = {
  roleCapacity: fixture.roleCapacity,
  agents: fixture.agents,
  presets: fixture.presets,
  offers: fixture.offers,
  whitelist: fixture.whitelist,
  engagements: fixture.engagements,
  alerts: fixture.alerts,
  usage: fixture.usage,
  frameworks: [],
  /*
   * No seat fixture. A seat is DERIVED from how agents were launched, so inventing
   * one would be inventing a launch topology — and the page's own point is that the
   * derivation is a fact rather than a choice. Fixture mode therefore shows the
   * seat section empty with its reason, which is true: with no backend there is no
   * host to derive a seat from.
   */
  seats: [],
  seatKeyed: null,
  /*
   * No contribution fixture either, and for the same kind of reason. A binding is
   * the record that a project can REACH an agent; inventing one would invent an
   * access grant, and the roster's access column exists precisely to reconcile that
   * record against the allocations. With no backend there is no binding store, so
   * fixture mode shows the column as unanswered — which is true.
   */
  contributions: [],
  /*
   * Never fixtured. A fabricated invitation would invite the contributor to accept a
   * project that does not exist, and an empty fixture would tell them nobody is waiting.
   */
  invites: [],
  detected: fixture.detected,
  detectedAt: null,
  detectCaveat: null,
  usageLive: [],
  metering: null,
  usageTotals: null,
};

/** Everything a page can read, assembled from a data object. */
function assemble(data, provenance, errors, refresh = async () => {}) {
  const derived = makeDerive(data);
  /*
   * When GET /api/capability answered, the SERVER's judgement replaces the local
   * one — same function name, same shape, one page code path. The server is where
   * role-capacity.json is authoritative and where a project-side client would read
   * it, so two answers to "can I fill Reviewer" is exactly the drift this layer
   * exists to prevent.
   */
  const capability = data.capabilityRows
    ? () => data.capabilityRows
    : derived.capability;
  return {
    ...data,
    ...derived,
    capability,
    provenance,
    errors,
    // Re-fetch after a write. A page that mutates and then re-renders from stale
    // local state shows the user their intention rather than the result, which is
    // exactly the failure a live console must not have.
    refresh,
    // True while the first fetch is in flight. Pages do not gate on it — they show
    // fixture data — but the banner uses it so "no backend" is not announced
    // before the attempt has finished.
    loading: provenance.__loading === true,
  };
}

const DataContext = createContext(
  assemble(FIXTURE_DATA, Object.fromEntries([
    ...['agents', 'presets', 'frameworks', 'alerts'].map((k) => [k, 'fixture']),
    ...CONTRACT_SLICES.map((k) => [k, 'contract']),
  ]), {}),
);

export function useData() {
  return useContext(DataContext);
}

export function DataProvider({ children }) {
  const [state, setState] = useState(() => assemble(
    FIXTURE_DATA,
    {
      __loading: true,
      ...Object.fromEntries(['agents', 'presets', 'frameworks', 'alerts'].map((k) => [k, 'fixture'])),
      ...Object.fromEntries(CONTRACT_SLICES.map((k) => [k, 'contract'])),
    },
    {},
  ));

  /*
   * A generation counter, because an older response must never overwrite a newer one.
   *
   * `refresh()` is called after every write, and the effect calls `load()` on mount.
   * With no ordering, two overlapping fetches resolve in whatever order the network
   * gives them: press Revoke, the refresh renders the ended engagement, then the
   * initial fetch completes and puts it back on screen as active. The user sees their
   * change undo itself.
   */
  const generation = useRef(0);

  const load = async () => {
    const mine = ++generation.current;
    /*
     * `?data=fixture` forces fixture mode without stopping the backend.
     *
     * Needed because the two suites want opposite things from one dev server:
     * check-switches asserts against fixture rows (contract slices are empty
     * against a live backend, so its cell-layout checks had nothing to inspect and
     * failed for the right reason), while live-ux asserts against real payloads.
     * Also useful by hand: it makes the provenance claim falsifiable in both
     * directions rather than only when a backend happens to be down.
     */
    const stale = () => mine !== generation.current;
    if (typeof window !== 'undefined'
      && new URLSearchParams(window.location.search).get('data') === 'fixture') {
      setState(assemble(
        FIXTURE_DATA,
        {
          ...Object.fromEntries(['agents', 'presets', 'frameworks', 'alerts'].map((k) => [k, 'fixture'])),
          ...Object.fromEntries(CONTRACT_SLICES.map((k) => [k, 'contract'])),
        },
        {},
        load,
      ));
      return;
    }
    try {
      const { data, provenance, errors } = await fetchLive();
      if (stale()) return;
      setState(assemble({ ...FIXTURE_DATA, ...data }, provenance, errors, load));
    } catch (e) {
      // fetchLive already degrades per slice, so reaching here means something
      // structural. Keep the fixture and say why rather than rendering nothing.
      if (stale()) return;
      setState((prev) => assemble(FIXTURE_DATA, { ...prev.provenance, __loading: false }, { all: e.message }, load));
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => { if (!cancelled) await load(); })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <DataContext.Provider value={state}>{children}</DataContext.Provider>;
}

/**
 * The banner that names what is real on this page.
 *
 * Not decoration. Four slices have endpoints and five do not, so a console that
 * looked uniformly live would misrepresent five of its own numbers. `slices` is
 * what this page actually reads, so the banner is specific rather than global.
 */
export function Provenance({ slices }) {
  const { provenance, errors, loading } = useData();
  const t = useT();
  const rows = slices.map((s) => ({ slice: s, from: provenance[s] ?? 'fixture', err: errors[s] }));
  const names = (rs) => rs.map((r) => t(`prov.slice.${r.slice}`)).join(' · ');
  /*
   * FIVE states arrive here, and only three were rendered.
   *
   * `absent` (the endpoint failed and there is no fixture to stand in) and `derived`
   * (capability computed locally because the endpoint failed) were both dropped, so a
   * slice in either state simply vanished from the banner — the page looked as though
   * it had not claimed anything about that data, which is the one thing this strip
   * exists to prevent. A `/usage` 500 left the usage slice unmentioned while agents
   * still read `live`.
   */
  const live = rows.filter((r) => r.from === 'live');
  const contract = rows.filter((r) => r.from === 'contract');
  const stale = rows.filter((r) => r.from === 'fixture');
  const absent = rows.filter((r) => r.from === 'absent');
  const derived = rows.filter((r) => r.from === 'derived');

  return (
    <div className={`prov${loading ? ' loading' : ''}`} data-testid="provenance">
      <span className="prov-k">{t('prov.k')}</span>
      {live.length > 0 && (
        <span className="prov-live" data-testid="prov-live">{t('prov.live', { list: names(live) })}</span>
      )}
      {contract.length > 0 && (
        <span className="prov-contract" data-testid="prov-contract">{t('prov.contract', { list: names(contract) })}</span>
      )}
      {stale.length > 0 && (
        <span className="prov-stale" data-testid="prov-stale">
          {t('prov.fixture', { list: names(stale) })}
          {stale[0].err ? ` — ${stale[0].err}` : ''}
        </span>
      )}
      {derived.length > 0 && (
        <span className="prov-stale" data-testid="prov-derived">{t('prov.derived', { list: names(derived) })}</span>
      )}
      {absent.length > 0 && (
        <span className="prov-absent" data-testid="prov-absent">
          {t('prov.absent', { list: names(absent) })}
          {absent[0].err ? ` — ${absent[0].err}` : ''}
        </span>
      )}
    </div>
  );
}
