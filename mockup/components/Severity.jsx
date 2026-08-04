/*
 * Severity is a dot AND a word, always. Never colour alone.
 *
 * A round-2 mockup rendered a red dot labelled "info" — two signals disagreeing,
 * on the page meant to demonstrate the rule. Binding them in one component makes
 * that specific mistake impossible to draw.
 */
export default function Severity({ level }) {
  return (
    <span className={`sev sev-${level}`}>
      <span className="dot" aria-hidden="true" />
      <span className="lbl">{level}</span>
    </span>
  );
}
