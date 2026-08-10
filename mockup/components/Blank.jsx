'use client';

/**
 * A dash plus the reason it is a dash.
 *
 * `0` claims a measurement that was never taken. On this console the distinction
 * matters most for spend: nothing in HAFleet meters tokens, so "this engagement
 * cost nothing" and "we have no way to know what it cost" must not render the
 * same. The dash comes from `.why-inline::before`, not from a span here — an
 * earlier version emitted both and every blank read "— — reason".
 */
export function Blank({ why, t, vars }) {
  return <span className="why-inline">{t(why, vars)}</span>;
}
