'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo, useState } from 'react';
import { agents, presetOf, railCounts, runtimeStatusText, tierOf } from '@/lib/mock-data';
import { PrefsSwitch, useT } from '@/components/Prefs';

/*
 * The rail. Present on every route, so what I am lending never leaves the screen.
 *
 * Decisions carried over from the previous console, each of which answered a
 * review finding:
 *  - agents are <Link>, not <button>: they have real URLs, so middle-click,
 *    bookmarking and keyboard navigation come free
 *  - nav is a pinned grid row, so a long agent list cannot push it below the fold
 *  - counts are labelled ("3 pending"), never bare numbers whose denominator the
 *    reader has to guess
 *  - aria-current="page" marks the destination exactly once
 *
 * What changed is the tag under each agent. It used to read the transport, then
 * the role it had been allocated. For a contributor the useful fact is **what it
 * contributes** — the model, and the tier that model qualifies for. An agent with
 * no preset says so, because that is the state which makes it useless.
 */
const SECTIONS = [
  {
    head: 'rail.secResource',
    rows: [
      { href: '/resources', key: 'resources', icon: '▦', count: 'agentsConfigured', unit: 'configured', also: ['/'] },
      { href: '/onboard', key: 'onboard', icon: '＋', count: null },
    ],
  },
  {
    head: 'rail.secCapability',
    rows: [
      { href: '/capability', key: 'capability', icon: '◫', count: 'rolesOffered', unit: 'offered' },
    ],
  },
  {
    head: 'rail.secEngagement',
    rows: [
      { href: '/engagements', key: 'engagements', icon: '⇄', count: 'pending', unit: 'pending', hot: true },
      { href: '/usage', key: 'usage', icon: '◎', count: 'active', unit: 'active' },
    ],
  },
  {
    head: 'rail.secFleet',
    rows: [
      { href: '/alerts', key: 'alerts', icon: '◉', count: 'alertsOpen', unit: 'open', hot: true },
      { href: '/config', key: 'config', icon: '⚙', count: null },
    ],
  },
];

// A dynamic segment marks its parent, so /resources/new and /agents/<name> never
// render a rail with nothing current — which the invariant suite rejects and a
// reader experiences as being lost.
const isUnder = (pathname, href) => pathname.startsWith(`${href}/`);

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

  const unconfigured = agents.filter((a) => !a.presetId).length;

  return (
    <nav className="rail" aria-label={t('rail.nav')}>
      <div className="rail-brand">
        <b>HAFLEET</b>
        <span>
          {`${agents.length} ${t('rail.agentsCount')} · ${unconfigured} ${t('rail.unconfigured')}`}
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
            const preset = presetOf(a);
            const tier = tierOf(preset);
            return (
              <li key={a.name}>
                <Link
                  href={href}
                  className={`agent-row${a.activeNow ? ' on' : ''}`}
                  aria-current={pathname === href ? 'page' : undefined}
                >
                  <span className="glyph" aria-hidden="true">{a.activeNow ? '●' : '○'}</span>
                  <span className="id">
                    <span className="nm">{a.name}</span>
                    {/* Status is text, not colour. */}
                    <span className="st">{runtimeStatusText(a)}</span>
                    {/* What it contributes. An unconfigured agent contributes
                        nothing, and that is the fact worth surfacing. */}
                    <span className={`job${preset ? '' : ' none'}`}>
                      {preset ? `${preset.model} · ${tier}` : t('rail.noModel')}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
          {shown.length === 0 && (
            <li className="rail-empty">{`${t('rail.noMatch')} “${filter}”`}</li>
          )}
        </ul>
      </div>

      <div className="rail-fleet">
        {SECTIONS.map((sec) => (
          <div key={sec.head}>
            <h2 className="rail-sec">{t(sec.head)}</h2>
            <ul className="rail-list">
              {sec.rows.map((f) => {
                const n = f.count ? counts[f.count] : null;
                const current = pathname === f.href
                  || isUnder(pathname, f.href)
                  || (f.also ?? []).includes(pathname);
                return (
                  <li key={f.href}>
                    <Link
                      href={f.href}
                      className="fleet-row"
                      aria-current={current ? 'page' : undefined}
                    >
                      <span className="ico" aria-hidden="true">{f.icon}</span>
                      <span className="grow">{t(`nav.${f.key}`)}</span>
                      {/* One interpolated string, not two adjacent expressions:
                          React separates those with a comment marker in SSR,
                          which fragments the text node and breaks copy. */}
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
        ))}
      </div>

      <PrefsSwitch />
    </nav>
  );
}
