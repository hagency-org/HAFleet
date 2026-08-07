'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/components/Prefs';

/*
 * The honest/projected switch, extracted.
 *
 * Four pages now need it and each had been about to grow its own copy. The rule it
 * encodes is the one this whole prototype turns on: the DEFAULT IS THE TRUTH about
 * this fleet — no groups bridged, no worker allocated, every agent role=null — and
 * the populated state is reachable, labelled, and never the thing you land on.
 *
 * It lives in the URL rather than useState because selection belongs there: it is
 * linkable, survives a reload, and is reachable by the screenshot script and the
 * responsive sweep. While an earlier version of this lived in component state, the
 * sweep was measuring the empty view twice and nobody noticed.
 *
 * The param keeps the name `?view=assigned` it had when only Capacity used it, so
 * existing links and the browser assertions keep resolving.
 */
export function useProjectedView() {
  const [view, setView] = useState('unassigned');

  useEffect(() => {
    const read = () => setView(
      new URLSearchParams(window.location.search).get('view') === 'assigned'
        ? 'assigned'
        : 'unassigned',
    );
    read();
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, []);

  function choose(next) {
    setView(next);
    window.history.pushState(
      null, '',
      next === 'assigned' ? '?view=assigned' : window.location.pathname,
    );
  }

  return [view, choose];
}

export function ViewToggle({ view, choose }) {
  const t = useT();
  return (
    <div className="prefs-row" role="group" aria-label={t('cap.viewNote')}>
      {[['unassigned', t('cap.viewNow')], ['assigned', t('cap.viewAssigned')]].map(([k, label]) => (
        <button key={k} className="seg" aria-pressed={view === k} onClick={() => choose(k)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * A dash plus the reason it is a dash. Never renders a bare mark.
 *
 * The dash comes from `.why-inline::before`, not from a span here. An earlier version
 * emitted `.mk-dash` as well and every blank on the console rendered "— — reason":
 * `.why-inline` is also used on its own — a queued assignment's blocked reason — where
 * it has to supply its own dash, so the duplication had to be removed on this side.
 */
export function Blank({ why, t }) {
  return <span className="why-inline">{t(why)}</span>;
}
