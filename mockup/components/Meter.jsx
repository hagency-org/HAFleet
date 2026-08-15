'use client';

import { useT } from '@/components/Prefs';
import { fmtTokens } from '@/lib/mock-data';

/*
 * THE ONE PLACE THAT DECIDES WHAT A FULL BAR MEANS.
 *
 * Four pages used to write `width: ${Math.min(100, pct)}%` by hand. The clamp is unavoidable — a
 * bar cannot be 240% of its own track — but on its own it makes an agent 2.4x past its ceiling look
 * EXACTLY like one that landed on it. The number beside the bar told the truth on some pages and
 * was absent on others, so whether an overrun was visible at all depended on which page you opened.
 *
 * Here the clamp keeps the geometry and `over` carries the fact the clamp destroyed: a distinct
 * fill, and a label stating how far past. That is the same rule the rest of this console follows
 * for a missing figure (`Blank why=…` rather than a zero) — when a display cannot show a value,
 * it says so instead of showing a different value that happens to fit.
 *
 * `hot` is NOT that signal. It lights at 80%, which is an approaching-limit warning; a breach is a
 * different event and reusing one colour for both is how the breach stayed invisible.
 */
export default function Meter({ pct, over = null, ok = false, label = null }) {
  const t = useT();
  if (!Number.isFinite(pct)) return null;
  const breached = Number.isFinite(over) && over > 0;
  /*
   * The bar is decoration for a figure the caller already renders, so it is aria-hidden and the
   * overrun gets a TEXT node instead — a screen reader that cannot see the colour must not be the
   * one reader who misses the breach.
   */
  return (
    <>
      <span className="meter" aria-hidden="true">
        <i
          className={breached ? 'over' : (ok ? 'ok' : '')}
          style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
        />
      </span>
      {breached && (
        <span className="over-by">{label ?? t('mt.overBy', { n: fmtTokens(over), pct })}</span>
      )}
    </>
  );
}
