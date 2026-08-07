'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo, useState } from 'react';
import { agents, railCounts, runtimeStatusText, workforce, allocationRows } from '@/lib/mock-data';
import { PrefsSwitch, useT } from '@/components/Prefs';
import { useProjectedView } from '@/components/ViewToggle';

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

/*
 * Six rows under three headings, down from nine flat siblings.
 *
 * The nine were HAFleet's six functions plus three fleet destinations, which was
 * right about what the product does and wrong about how anyone arrives. Nobody
 * turns up holding an attribute; they turn up holding a project or a group. So the
 * rail now names the two lines of report, and the six functions become sections
 * WITHIN a scope rather than destinations of their own.
 *
 * `also` keeps the four demoted routes alive and marked. /workforce, /capacity,
 * /performance and /knowledge are still real URLs — bookmarks and a large existing
 * assertion suite point at them — they simply light up Org instead of themselves.
 */
const SECTIONS = [
  {
    head: 'rail.secDelivery',
    rows: [
      // Labelled `bridged`, and it is 0: data/groups.json does not exist, so
      // /api/project-board answers with no projects until a room is bridged.
      { href: '/projects', key: 'projects', icon: '▤', count: 'projectsBridged', unit: 'bridged' },
    ],
  },
  {
    head: 'rail.secOrg',
    rows: [
      { href: '/org', key: 'org', icon: '▦', count: 'rolesDefined', unit: 'roles', also: ['/', '/workforce', '/capacity', '/performance', '/knowledge'] },
      { href: '/assignments', key: 'dispatch', icon: '⇄', count: 'assignmentsQueued', unit: 'queued', hot: true, also: ['/tasks', '/queue'] },
    ],
  },
  {
    head: 'rail.fleet',
    rows: [
      // Hiring sits with the fleet destinations rather than inside Config: it adds an
      // employee, and Config's other sections change ones that already exist.
      { href: '/onboard', key: 'onboard', icon: '＋', count: 'frameworksReady', unit: 'ready' },
      { href: '/alerts', key: 'alerts', icon: '◉', count: 'alertsOpen', unit: 'open', hot: true },
      { href: '/config', key: 'config', icon: '⚙', count: null },
    ],
  },
];

// A dynamic segment marks its parent too, so /org/coding and /projects/api-service
// do not render a rail with nothing current — which the invariant suite rejects and
// a reader would experience as being lost.
const isUnder = (pathname, href) => pathname.startsWith(`${href}/`);

export default function Rail() {
  const t = useT();
  const pathname = usePathname();
  const [filter, setFilter] = useState('');
  const counts = railCounts();
  /*
   * The per-agent tag follows the ?view= the reader is on; the section pills do not.
   * That split is deliberate rather than sloppy: a tag sits beside the same agent the
   * page is describing, so a rail reading "not qualified" next to a page showing that
   * agent allocated as a Coder is a contradiction on one screen. A pill is a
   * fleet-level fact — `0 bridged` is about the Matrix bridge, not about allocation —
   * and stays live so the rail always states what the backend would actually return.
   */
  const [view] = useProjectedView();
  const allocated = new Map(allocationRows(view).map((a) => [a.agent, a]));

  const staff = workforce(view);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const live = staff.filter((a) => a.alive !== false);
    if (!q) return live;
    return live.filter((a) => a.name.toLowerCase().includes(q));
  }, [filter, staff]);

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
                    {/* The job, not the plumbing. The tag used to read ACP/TMUX,
                        which three of five agents shared and which distinguished
                        nothing an operator navigates by; transport moved to the
                        roster row and the employee record, where it is
                        diagnostic rather than a label. */}
                    <span className="job">
                      {allocated.has(a.name)
                        ? `${allocated.get(a.name).role.name} · ${allocated.get(a.name).worker.capability}`
                        : t('wf.notQualified')}
                    </span>
                  </span>
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
        ))}
      </div>

      <PrefsSwitch />
    </nav>
  );
}
