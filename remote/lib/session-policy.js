/**
 * Which tmux sessions is this HAFleet install allowed to manage?
 *
 * HAFleet talks to an agent by typing into its tmux pane. It has no way to tell
 * an agent's pane from any other terminal, so by default it claims every session
 * on the box — observed for real on a fleet host, where a fresh install adopted
 * five unrelated sessions running someone else's work and became able to type
 * into them.
 *
 * Two env vars, both optional:
 *
 *   AGENT_CHAT_SESSION_ALLOWLIST   only these sessions are managed
 *   AGENT_CHAT_SESSION_DENYLIST    these sessions are never managed
 *
 * Comma- or whitespace-separated. `*` matches any run of characters, so
 * `claude-*` covers a naming convention. Denial always wins.
 *
 * Defaults are deliberately permissive: an existing install that sets neither
 * var keeps behaving exactly as before. Restricting the default would silently
 * orphan every agent on every host already deployed. The installer is what
 * populates the denylist for a *new* install that finds foreign sessions.
 *
 * This module reads no environment of its own — callers pass values in, so the
 * decision is testable without mutating process.env.
 */

/** A variable that is present but yields no usable pattern. See parsePatterns. */
const EMPTY_BUT_SET = Symbol('empty-but-set');

/**
 * Split a raw env value into patterns.
 *
 * Returns null when the variable is absent (meaning "no opinion"), EMPTY_BUT_SET
 * when it was provided but contained nothing usable. Those two cases must stay
 * distinguishable: `ALLOWLIST=` unset means allow everything, whereas
 * `ALLOWLIST=","` means the operator tried to restrict something and the value
 * is broken. Treating the second as "allow everything" would turn a typo into a
 * silent removal of the very protection being configured.
 */
export function parsePatterns(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return EMPTY_BUT_SET;
  if (raw.trim() === '') return null; // FOO= in a .env is how you unset it
  const patterns = raw
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return patterns.length ? patterns : EMPTY_BUT_SET;
}

/** Anchored regex for one glob. Everything except `*` is literal. */
function globToRegExp(pattern) {
  // Split on the wildcard first, then escape each literal segment. Escaping
  // first and substituting afterwards needs a sentinel character, and any
  // sentinel is a latent bug the day a session name contains it.
  const body = pattern
    .split('*')
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}$`);
}

function matchesAny(name, patterns) {
  return patterns.some((p) => (p.includes('*') ? globToRegExp(p).test(name) : p === name));
}

/**
 * Build a reusable policy.
 *
 * @param {object} config
 * @param {string|undefined} config.allowlist raw AGENT_CHAT_SESSION_ALLOWLIST
 * @param {string|undefined} config.denylist  raw AGENT_CHAT_SESSION_DENYLIST
 */
export function createSessionPolicy({ allowlist, denylist } = {}) {
  const allowParsed = parsePatterns(allowlist);
  const denyParsed = parsePatterns(denylist);

  // A broken allowlist denies everything rather than nothing. A broken denylist
  // denies everything too: both mean "the operator asked for a restriction we
  // could not read", and in that state guessing wide is the unsafe guess.
  const allowBroken = allowParsed === EMPTY_BUT_SET;
  const denyBroken = denyParsed === EMPTY_BUT_SET;
  const allowPatterns = Array.isArray(allowParsed) ? allowParsed : [];
  const denyPatterns = Array.isArray(denyParsed) ? denyParsed : [];

  const warnings = [];
  if (allowBroken) warnings.push('AGENT_CHAT_SESSION_ALLOWLIST is set but lists no session; refusing all sessions');
  if (denyBroken) warnings.push('AGENT_CHAT_SESSION_DENYLIST is set but lists no session; refusing all sessions');

  /**
   * @returns {{allowed: boolean, reason: string}} reason is a short stable code,
   *   never interpolated user data, so it is safe to log verbatim.
   */
  function evaluate(sessionName) {
    if (typeof sessionName !== 'string' || sessionName.trim() === '') {
      return { allowed: false, reason: 'invalid-session-name' };
    }
    const name = sessionName.trim();
    if (allowBroken || denyBroken) return { allowed: false, reason: 'policy-unreadable' };
    if (denyPatterns.length && matchesAny(name, denyPatterns)) {
      return { allowed: false, reason: 'denylisted' };
    }
    if (allowPatterns.length) {
      return matchesAny(name, allowPatterns)
        ? { allowed: true, reason: 'allowlisted' }
        : { allowed: false, reason: 'not-allowlisted' };
    }
    return { allowed: true, reason: 'no-policy' };
  }

  return {
    /** True when neither var restricts anything — the default install. */
    get unrestricted() {
      return !allowBroken && !denyBroken && !allowPatterns.length && !denyPatterns.length;
    },
    get warnings() { return [...warnings]; },
    evaluate,
    allows: (name) => evaluate(name).allowed,
    /** Filter an iterable of names, preserving input order. */
    filter(names) {
      const kept = [];
      const rejected = [];
      for (const name of names || []) {
        (evaluate(name).allowed ? kept : rejected).push(name);
      }
      return { kept, rejected };
    },
  };
}

/** Convenience: build from an env-like object. */
export function sessionPolicyFromEnv(env = process.env) {
  return createSessionPolicy({
    allowlist: env.AGENT_CHAT_SESSION_ALLOWLIST,
    denylist: env.AGENT_CHAT_SESSION_DENYLIST,
  });
}
