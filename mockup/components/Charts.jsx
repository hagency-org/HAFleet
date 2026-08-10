'use client';

import { useT } from '@/components/Prefs';
import { fmtTokens } from '@/lib/mock-data';

/*
 * Charts for the usage dashboard. Inline SVG, no dependency — the prototype's
 * constraint is no new runtime library, and three chart types do not need one.
 *
 * THE CHART A READER EXPECTS IS NOT HERE, and its absence is the point.
 *
 * A usage dashboard normally opens with spend over time. HAFleet meters no tokens
 * at any granularity, so that series does not exist and drawing it would be
 * fabricating the one number the contributor came for. Everything below charts
 * what is genuinely known — **allocation**, the budget I promised — and `/usage`
 * says once, at the top, that consumption is a gap rather than a zero.
 *
 * Two rules every chart here follows:
 *
 *  - **A value is printed, not just drawn.** Colour and length are the second and
 *    third signals; the number is the first. A reader who cannot distinguish the
 *    hues, or who is looking at a greyscale print, loses nothing.
 *  - **The chart sits above the table, never instead of it.** Shape from the
 *    chart, values from the table. A chart alone would make the figures
 *    unreadable at exactly the moment someone wants to check one.
 */

/** Categorical series colours. Four is the ceiling on honest discrimination. */
const SERIES = ['var(--c-a)', 'var(--c-b)', 'var(--c-c)', 'var(--c-d)'];

/**
 * Committed against ceiling, per agent.
 *
 * A stacked bar rather than two bars: the question is "how much of this agent is
 * already promised away", which is a proportion of one whole. Two separate bars
 * would invite reading them as unrelated quantities.
 */
export function CeilingBars({ rows }) {
  const t = useT();
  if (!rows.length) return <div className="notice">{t('ch.noAgents')}</div>;
  return (
    <div className="chart">
      {rows.map((r) => {
        const pct = Math.round((r.committed / r.ceiling) * 100);
        return (
          <div className="cb-row" key={r.agent}>
            <span className="cb-label">{r.agent}</span>
            <span className="cb-track" role="img"
              aria-label={t('ch.ceilingAria', { agent: r.agent, pct, of: fmtTokens(r.ceiling) })}>
              <i className={`cb-fill${pct > 80 ? ' hot' : ''}`} style={{ width: `${Math.min(100, pct)}%` }} />
            </span>
            {/* The number leads. The bar is corroboration. */}
            <span className="cb-val">
              <b>{fmtTokens(r.committed)}</b>
              {` / ${fmtTokens(r.ceiling)}`}
              <span className="dim">{` ${pct}%`}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Share of allocation by project.
 *
 * A donut earns its place here only because the question really is "what fraction
 * of what I have promised went where" — a part-to-whole reading. The legend
 * carries the absolute value and the percentage, so the arcs are never the only
 * way to get a number out of it.
 */
export function AllocationDonut({ slices }) {
  const t = useT();
  const total = slices.reduce((n, s) => n + s.value, 0);
  if (!total) return <div className="notice">{t('ch.noAllocation')}</div>;

  const R = 52;
  const C = 2 * Math.PI * R;
  let offset = 0;

  return (
    <div className="donut-wrap">
      <svg viewBox="0 0 140 140" className="donut" role="img"
        aria-label={t('ch.donutAria', { n: slices.length, total: fmtTokens(total) })}>
        <g transform="translate(70,70) rotate(-90)">
          {slices.map((s, i) => {
            const len = (s.value / total) * C;
            const el = (
              <circle
                key={s.label} r={R} fill="none" strokeWidth="20"
                stroke={SERIES[i % SERIES.length]}
                strokeDasharray={`${len} ${C - len}`}
                strokeDashoffset={-offset}
              />
            );
            offset += len;
            return el;
          })}
        </g>
        <text x="70" y="66" className="donut-total">{fmtTokens(total)}</text>
        <text x="70" y="82" className="donut-cap">{t('ch.allocated')}</text>
      </svg>
      <ul className="legend">
        {slices.map((s, i) => (
          <li key={s.label}>
            <span className="swatch" style={{ background: SERIES[i % SERIES.length] }} aria-hidden="true" />
            <span className="grow">{s.label}</span>
            <span className="amount">{fmtTokens(s.value)}</span>
            <span className="dim">{`${Math.round((s.value / total) * 100)}%`}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Tasks done against open, per project.
 *
 * This is the one series on the page that is a real measurement rather than a
 * commitment: `lib/task-store.js` has five statuses and the project board rolls
 * them up per member. Grouped rather than stacked, because done and open are not
 * parts of a fixed whole — more work can arrive.
 */
export function TaskBars({ rows }) {
  const t = useT();
  if (!rows.length) return <div className="notice">{t('ch.noTasks')}</div>;
  const max = Math.max(...rows.map((r) => Math.max(r.done, r.open)), 1);
  return (
    <div className="chart">
      <div className="tb-key">
        <span><i className="sw done" aria-hidden="true" />{t('ch.done')}</span>
        <span><i className="sw open" aria-hidden="true" />{t('ch.open')}</span>
      </div>
      {rows.map((r) => (
        <div className="tb-row" key={r.label}>
          <span className="cb-label">{r.label}</span>
          <span className="tb-bars">
            <span className="tb-bar">
              <i className="done" style={{ width: `${(r.done / max) * 100}%` }} />
              <b>{r.done}</b>
            </span>
            <span className="tb-bar">
              <i className="open" style={{ width: `${(r.open / max) * 100}%` }} />
              <b>{r.open}</b>
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The series that cannot be drawn, drawn as its own absence.
 *
 * Leaving it out entirely would let the dashboard look complete. A reader who
 * scans four charts and finds no spend-over-time concludes it was an oversight;
 * one who finds this concludes the measurement does not exist, which is the
 * true and actionable version.
 */
export function MissingSeries() {
  const t = useT();
  return (
    <div className="chart missing" role="img" aria-label={t('ch.missingAria')}>
      <svg viewBox="0 0 300 90" className="ghost" aria-hidden="true">
        {/* A flat baseline, not a plausible-looking curve: an invented shape is
            exactly what this panel exists to refuse. */}
        <line x1="8" y1="80" x2="292" y2="80" />
        <line x1="8" y1="80" x2="8" y2="10" />
        {[60, 112, 164, 216, 268].map((x) => <line key={x} x1={x} y1="80" x2={x} y2="76" />)}
      </svg>
      <div className="missing-why">
        <b>{t('ch.missingTitle')}</b>
        <span>{t('ch.missingWhy')}</span>
      </div>
    </div>
  );
}
