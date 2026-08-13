'use client';

/**
 * A one-line claim with the reasoning folded behind it.
 *
 * WHY THIS EXISTS. This console's rule is that no figure appears without saying where it came
 * from, and the honest explanations turned out to be long: why the Used column counts fresh
 * tokens and not cache reads takes three sentences and a measured example. Printed inline,
 * those sentences became walls of text above the very tables they described — an operator
 * asked for them to be tips, which is the right call. The reasoning is not less important
 * than the number; it is just not what you read every time.
 *
 * `<details>` rather than a hover tooltip, deliberately:
 *   - it works with no JS state, so it survives server rendering and the fixture pages,
 *   - it is keyboard reachable and screen-reader announced, which a `title=` is not,
 *   - hover tips are unreachable on touch, and this console is read on a laptop beside a
 *     phone,
 *   - and it stays open once opened, so a reader can look at the table while reading why.
 *
 * The summary must state the CLAIM, not "more info". A disclosure whose label says nothing
 * makes the reader open it to find out whether they needed to.
 */
export function InfoTip({ label, children }) {
  return (
    <details className="infotip">
      <summary>{label}</summary>
      <div className="infotip-body">{children}</div>
    </details>
  );
}

/**
 * The same thing for a list of reasons, each of which is a sentence rather than a figure.
 *
 * Items are rendered as given — the CALLER localizes them. Passing raw strings from an API
 * through here is the mistake this console has already made twice: the provenance panel
 * echoed `lib/task-store.js` into a Chinese UI, and the metering gap list echoed English
 * paragraphs. A component cannot fix that; it can only avoid encouraging it.
 */
export function InfoTipList({ label, items = [] }) {
  if (!items.length) return null;
  return (
    <InfoTip label={label}>
      <ul className="infotip-list">
        {items.map((item, i) => <li key={typeof item === 'string' ? item : i}>{item}</li>)}
      </ul>
    </InfoTip>
  );
}
