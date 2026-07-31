// Agent runtime contract.
//
// HAFleet reaches its agents through a terminal multiplexer: it launches them in
// tmux panes, delivers messages by typing into those panes, and infers state by
// reading pane output. That coupling was spread across 43 raw `tmux` invocations
// — 34 in backend-v2.js alone, with no abstraction at all — which is what pins
// the project to Linux and macOS. tmux does not run natively on Windows.
//
// This module is the seam. Everything platform-specific about reaching an agent
// lives behind a runtime object, so alternative runtimes become additive:
//
//   tmux      Linux, macOS            — implemented here
//   conpty    Windows native          — not written
//   headless  all platforms           — not written; `claude -p` / `codex exec`,
//                                       needs no multiplexer, so it is the
//                                       cheapest route to native Windows
//   acp       all platforms           — not written; see docs on the Agent
//                                       Client Protocol
//
// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------
//
// A runtime is a plain object. Every method is async unless noted. Methods
// report failure by return value rather than throwing, because callers here are
// health-monitoring loops that must not die when a multiplexer is absent.
//
//   name                       string identifier, e.g. 'tmux'
//   capabilities               { keys, capture, sessions } — see below
//   isAvailable()              -> boolean. Is this runtime usable on this host?
//   sessionExists(session)     -> boolean
//   listPanes()                -> { ok, panes, error, serverUnavailable }
//                                 serverUnavailable: no multiplexer server was
//                                 reachable. Distinct from an empty pane list,
//                                 which means the server is up and idle.
//                                 panes: [{ tty, session, pid, command, path }]
//                                 Paths are returned RAW; normalising them is
//                                 the caller's business, not the runtime's.
//   capturePane(target)        -> string | null   (null = unavailable)
//   sendKeys(target, keys, o)  -> boolean         (o.literal sends text as-is)
//   isEmptyServerError(err)    -> boolean (sync). Distinguishes "no multiplexer
//                                 server running" — an expected idle state —
//                                 from a real failure.
//
// ---------------------------------------------------------------------------
// Capabilities, and why sendKeys is flagged
// ---------------------------------------------------------------------------
//
// `sendKeys` is deliberately marked as a capability rather than assumed. It is
// meaningful only for runtimes that drive an interactive terminal: pressing C-c
// then C-u then typing `/clear` is a TUI operation. A headless runtime has no
// prompt to interrupt and must report `capabilities.keys === false`, so callers
// can degrade instead of failing.
//
// Callers MUST check the capability before relying on a method, rather than
// assuming tmux semantics.

/** Capability shape shared by all runtimes; individual runtimes narrow it. */
export const RUNTIME_CAPABILITIES = Object.freeze({
  /** Can press individual keys into an interactive prompt. */
  keys: false,
  /** Can read back what the agent's terminal is displaying. */
  capture: false,
  /** Can enumerate and test for named sessions. */
  sessions: false,
});

/**
 * Empty result for listPanes(), so callers never branch on undefined.
 *
 * `serverUnavailable` distinguishes "no multiplexer server was reachable" from
 * "the server is up and has no panes". Both are ok:true with zero panes, because
 * neither is a fault — but they mean opposite things to a caller deciding whether
 * an agent has gone away. Collapsing them made a transient tmux failure look like
 * an idle host, and the backend marked every agent tmux-missing on the strength
 * of it, then recovered on the next sweep. Agents flapped between online and
 * offline, 153 times in one boot on a real host.
 */
export function emptyPaneListing(error = null, { serverUnavailable = false } = {}) {
  return { ok: error === null, panes: [], error, serverUnavailable };
}

/**
 * Runtime used when nothing is available — every query answers "nothing here"
 * and every action is a no-op. Keeps callers branch-free on hosts with no
 * multiplexer, which is the normal state on a backend-only or Windows host.
 */
export function createNullRuntime({ reason = 'no agent runtime available' } = {}) {
  return Object.freeze({
    name: 'null',
    capabilities: Object.freeze({ ...RUNTIME_CAPABILITIES }),
    reason,
    async isAvailable() { return false; },
    async sessionExists() { return false; },
    async listPanes() { return emptyPaneListing(reason); },
    async capturePane() { return null; },
    async sendKeys() { return false; },
    isEmptyServerError() { return true; },
  });
}

/**
 * Shape check with actionable errors. Used by tests and by anyone adding a
 * runtime, so a partial implementation fails loudly at construction rather than
 * mysteriously at the first health sweep.
 */
export function assertRuntimeContract(runtime, label = 'runtime') {
  if (!runtime || typeof runtime !== 'object') {
    throw new Error(`${label} must be an object`);
  }
  if (typeof runtime.name !== 'string' || !runtime.name.trim()) {
    throw new Error(`${label}.name must be a non-empty string`);
  }
  if (!runtime.capabilities || typeof runtime.capabilities !== 'object') {
    throw new Error(`${label}.capabilities must be an object`);
  }
  for (const key of Object.keys(RUNTIME_CAPABILITIES)) {
    if (typeof runtime.capabilities[key] !== 'boolean') {
      throw new Error(`${label}.capabilities.${key} must be a boolean`);
    }
  }
  for (const method of [
    'isAvailable', 'sessionExists', 'listPanes', 'capturePane', 'sendKeys', 'isEmptyServerError',
  ]) {
    if (typeof runtime[method] !== 'function') {
      throw new Error(`${label}.${method} must be a function`);
    }
  }
  return runtime;
}
