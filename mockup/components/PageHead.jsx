'use client';

/*
 * One header, and the single owner of the browser tab title.
 *
 * Next's `export const metadata` runs on the server, which cannot know a locale
 * chosen in the client's localStorage — a static metadata title stays English
 * forever while the page beside it turns Chinese. So the title is derived from the
 * visible H1, and the two can never disagree.
 *
 * It is RENDERED, not assigned in an effect. An earlier version set document.title
 * from useEffect and lost: Next writes the metadata title into <head> during
 * hydration, which happens after effects flush, so the first paint kept the layout's
 * generic title and only later navigations looked right. React 19 hoists a <title>
 * rendered anywhere in the tree into <head>, on the server too — so this is correct
 * in the SSR output and follows the language switch afterwards, with no race.
 * layout.jsx deliberately exports no metadata.title, leaving exactly one owner.
 */
export default function PageHead({ title, sub, children }) {
  return (
    <>
    <title>{`${title} — HAFleet`}</title>
    <div className="page-head">
      <h1>{title}</h1>
      {sub && <span className="sub">{sub}</span>}
      <span className="spacer" />
      {children}
    </div>
    </>
  );
}
