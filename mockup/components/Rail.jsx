'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo, useState } from 'react';
import { agents, railCounts, runtimeStatusText } from '@/lib/mock-data';
import { PrefsSwitch, useT } from '@/components/Prefs';

/*
 * The rail. Present on every route, which is the whole point of the relayout:
 * agent state never leaves the screen.
 *
 * Design decisions encoded here, each answering a review finding:
 *  - agents are <Link>, not <button>: they already have real URLs, so
 *    middle-click, bookmarking and keyboard navigation come free
 *  - every row shows ACTIVE/IDLE and a duration, so the first screen answers
 *    "what needs attention" without a click
 *  - Fleet nav is a separate pinned grid row, so a long agent list cannot push
 *    it below the fold
 *  - counts are labelled ("9 open", "0 groups"), never bare numbers whose
 *    denominator the operator has to guess
 *  - aria-current="page" marks the destination, so the rail necessarily differs
 *    by one attribute per page rather than being byte-identical
 */

const FLEET = [
  { href: '/overview', key: 'overview', icon: '▦', count: null },
  { href: '/alerts', key: 'alerts', icon: '◉', count: 'alertsOpen', unit: 'open', hot: true },
  { href: '/queue', key: 'queue', icon: '↧', count: 'queued', unit: 'waiting' },
  { href: '/tasks', key: 'tasks', icon: '☑', count: 'tasksOpen', unit: 'open' },
  { href: '/projects', key: 'projects', icon: '▤', count: 'projectGroups', unit: 'groups' },
  { href: '/capacity', key: 'capacity', icon: '◫', count: null },
  // Onboarding sits with the fleet destinations rather than inside Config: it
  // adds an agent, and Config's other sections change agents that already exist.
  { href: '/onboard', key: 'onboard', icon: '＋', count: 'frameworksReady', unit: 'ready' },
  { href: '/config', key: 'config', icon: '⚙', count: null },
];

export default function Rail() {
  const t = useT();
  const pathname = usePathname();
  const [filter, setFilter] = useState('');
  const counts = railCounts();

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const live = agents.filter((a) => a.alive !== false);
    if (!q) return live;
    return live.filter((a) => a.name.toLowerCase().includes(q));
  }, [filter]);

  const downCount = agents.filter((a) => a.alive === false).length;

  return (
    <nav className="rail" aria-label={t('rail.fleet')}>
      <div className="rail-brand">
        <b>HAFLEET</b>
        <span>
          {`${agents.length} ${t('rail.agentsCount')} · ${downCount} ${t('rail.agentsDown')}`}
        </span>
      </div>

      <div className="rail-filter">
        <input
          type="search"
          placeholder={t('rail.filter')}
          aria-label={t('rail.filter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <div className="rail-scroll">
        <h2 className="rail-sec">{`${t('rail.agents')} · ${shown.length}`}</h2>
        <ul className="rail-list">
          {shown.map((a) => {
            const href = `/agents/${a.name}`;
            const current = pathname === href;
            return (
              <li key={a.name}>
                <Link
                  href={href}
                  className={`agent-row${a.activeNow ? ' on' : ''}`}
                  aria-current={current ? 'page' : undefined}
                >
                  <span className="glyph" aria-hidden="true">
                    {a.activeNow ? '●' : '○'}
                  </span>
                  <span className="id">
                    <span className="nm">{a.name}</span>
                    {/* Status is text, not colour. Hidden nothing at narrow widths. */}
                    <span className="st">{runtimeStatusText(a)}</span>
                  </span>
                  <span className="tag">{a.transport === 'acp' ? 'ACP' : 'TMUX'}</span>
                </Link>
              </li>
            );
          })}
          {shown.length === 0 && (
            <li style={{ padding: '6px 16px', fontSize: 12, color: 'var(--ink-faint)' }}>
              {`${t('rail.noMatch')} “${filter}”`}
            </li>
          )}
        </ul>
      </div>

      <div className="rail-fleet">
        <h2 className="rail-sec">{t('rail.fleet')}</h2>
        <ul className="rail-list">
          {FLEET.map((f) => {
            const n = f.count ? counts[f.count] : null;
            const current = pathname === f.href || (f.href === '/overview' && pathname === '/');
            return (
              <li key={f.href}>
                <Link
                  href={f.href}
                  className="fleet-row"
                  aria-current={current ? 'page' : undefined}
                >
                  <span className="ico" aria-hidden="true">{f.icon}</span>
                  <span className="grow">{t(`nav.${f.key}`)}</span>
                  {/* One interpolated string below, not two adjacent expressions:
                      React separates those with a comment marker in SSR, which
                      fragments the text node and breaks selection and copy. */}
                  {f.count && (
                    <span className={`pill${n > 0 && f.hot ? ' hot' : ''}${n === 0 ? ' zero' : ''}`}>
                      {`${n} ${t(`unit.${f.unit}`)}`}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>

      <PrefsSwitch />
    </nav>
  );
}
