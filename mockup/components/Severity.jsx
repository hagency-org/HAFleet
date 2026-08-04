'use client';

import { useT } from '@/components/Prefs';

/*
 * Severity is a dot AND a word, always. Never colour alone.
 *
 * A round-2 mockup rendered a red dot labelled "info" — two signals disagreeing,
 * on the page meant to demonstrate the rule. Binding them in one component makes
 * that specific mistake impossible to draw.
 *
 * The word is translated, unlike lifecycle statuses: the whole rule rests on the
 * word being readable, and an operator who cannot read "critical" is back to judging
 * by colour. The raw API value stays in `title`, so the correspondence with logs and
 * curl output is one hover away rather than lost.
 */
export default function Severity({ level }) {
  const t = useT();
  return (
    <span className={`sev sev-${level}`} title={level}>
      <span className="dot" aria-hidden="true" />
      <span className="lbl">{t(`sev.${level}`)}</span>
    </span>
  );
}
