/*
 * What is worth telling a room, decided in one place.
 *
 * The reporter's first version wired the framework's raw events straight through and hardcoded the
 * answer: every tool call became a verb, coalesced into a line a minute. That is a policy, and it was
 * buried in an executable with no way to state it, inspect it, or vary it — so every customer got the
 * same verbosity whether or not their room wanted it.
 *
 * THIS IS THE LAYER IN BETWEEN. It takes a framework event and answers one question: does this go out,
 * and as what. Two properties matter more than the feature list:
 *
 *   IT IS A PURE FUNCTION. No network, no clock, no filesystem. The reporter runs on every tool call
 *   of every agent, and a policy layer that could block or throw there would be a policy layer that
 *   breaks the work it describes. Given the same inputs it gives the same answer, which is also why it
 *   can be tested without a fleet.
 *
 *   IT FAILS CLOSED ON CONFIGURATION AND OPEN ON DEFAULT. A malformed filter reports nothing rather
 *   than everything: an operator who mistypes a rule intended to REDUCE what leaves the machine must
 *   not get more than they had. But with NO filter at all, the built-in default applies — the feature
 *   works out of the box, and silence is never the accidental outcome of not configuring it.
 *
 * THE CUSTOMER DIMENSION. Every group maps to a room on somebody's server, and rooms differ: a
 * three-person project room wants "started" and "finished", an ops channel may want every command. So
 * rules resolve per group, falling back to the defaults. That is the unit ADR-016 already made the
 * boundary — a project side — expressed at the one level the reporter actually knows.
 */

/**
 * The built-in policy, which is the previous hardcoded behaviour written down.
 *
 * `Bash` is reported as "ran commands" and never with its command line — see `VERBS`. It is included
 * rather than excluded because "the agent is running things" is the single most useful signal that
 * work is happening, and the alternative (an agent that looks idle while compiling) is the failure
 * this whole feature exists to prevent.
 */
export const DEFAULT_PROGRESS_FILTER = Object.freeze({
  events: ['start', 'step', 'done'],
  tools: Object.freeze({ include: null, exclude: Object.freeze([]) }),
  minIntervalMs: 60_000,
});

/** Tool name → the verb that leaves the machine. Never the tool's input; often not even its name. */
export const VERBS = Object.freeze({
  Read: 'read',
  Glob: 'searched',
  Grep: 'searched',
  Bash: 'ran commands',
  Edit: 'edited',
  Write: 'wrote',
  NotebookEdit: 'edited',
  WebFetch: 'fetched',
  WebSearch: 'searched',
});

/**
 * ACP's own tool vocabulary, mapped onto the verbs above.
 *
 * WHY THIS IS THE UNIFICATION POINT, and hooks are not. Every framework installs hooks differently — a
 * different file, a different scope, a different trust model — and one of them (octos) has none at all. So
 * "one hook for all frameworks" cannot exist. ACP's `session/update` can: `lib/runtime/acp.js` already
 * receives it and already parses `sessionUpdate === 'tool_call'`, three of four frameworks speak the
 * protocol, and NOTHING has to be installed anywhere.
 *
 * `kind` comes from the ACP spec (`read`, `edit`, `execute`, `search`, `fetch`, `think`, `delete`, `move`,
 * `other`). It is deliberately mapped rather than passed through: the room gets the same words whether the
 * agent runs under a hook or under ACP, so a reader never has to know which.
 *
 * AN UNKNOWN KIND IS "worked", exactly as an unknown tool name is. No sample of a live ACP session was
 * available when this was written, so the table is what the spec states and the fallback is what protects
 * the rest. A future kind will read as activity rather than as its own name — which is also the right
 * privacy default, since a kind nobody has vetted is a fact about the deployment.
 */
const ACP_KIND_TOOLS = Object.freeze({
  read: 'Read',
  search: 'Grep',
  execute: 'Bash',
  edit: 'Edit',
  delete: 'Edit',
  move: 'Edit',
  fetch: 'WebFetch',
  /*
   * `think` IS DROPPED, not reported. "Still thinking" every minute is the noise this whole feature exists
   * to avoid — the typing indicator already says that, without an event.
   */
  think: null,
  other: null,
});

/**
 * Turn one ACP `session/update` into the same `{event, tool}` shape a hook payload produces.
 *
 * Returns null for updates that are not activity — message chunks, plans, permission requests. The caller
 * then feeds the result to `decideProgressEvent`, so ONE policy decides for both transports and a filter an
 * operator wrote applies to an ACP agent without being written twice.
 */
export function acpUpdateToEvent(update) {
  const kind = update?.sessionUpdate;
  if (kind !== 'tool_call' && kind !== 'tool_call_update') return null;
  /*
   * ONLY THE START OF A CALL COUNTS. `tool_call_update` arrives repeatedly for one call as its status
   * changes, so counting every one would report "read ×7" for a single file — inflating the only numbers
   * this feature puts in front of a customer.
   */
  if (kind === 'tool_call_update') return null;
  /*
   * MAPPED TO A TOOL NAME, not to a verb, and that is what makes one filter serve both transports. An
   * operator who writes `tools: { exclude: ['Bash'] }` means "do not tell the room I run commands" — and
   * it must hold for an ACP agent's `execute` too, without them writing the rule twice in two
   * vocabularies.
   *
   * A kind with no mapping is reported as generic activity rather than by name. `update.title` is
   * deliberately not used anywhere: it is free text the agent wrote — "Read /home/customer/secrets.env" —
   * and putting it in a room would leak precisely what the verb table exists to keep out.
   */
  const has = Object.prototype.hasOwnProperty.call(ACP_KIND_TOOLS, update?.kind);
  if (has && ACP_KIND_TOOLS[update.kind] === null) return null;
  return { event: 'PostToolUse', tool: has ? ACP_KIND_TOOLS[update.kind] : 'AcpTool' };
}

/**
 * The verb for a tool, and why an unknown tool is not reported by name.
 *
 * A tool name is itself a fact about the deployment — which MCP servers are connected, which
 * capabilities an agent was given — and an unrecognised one is exactly the case where nobody has
 * decided whether naming it is safe. "worked" says the true thing and leaks nothing.
 */
export function verbFor(tool) {
  return VERBS[tool] || 'worked';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStringList(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (!Array.isArray(value)) return undefined; // signals "malformed" to the caller
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) return undefined;
    out.push(item.trim());
  }
  return out;
}

/**
 * Read a filter document into a usable shape, or say why it cannot be used.
 *
 * Returns `{ ok: true, filter }` or `{ ok: false, reason }`. It does NOT throw and it does NOT repair:
 * a rule an operator wrote and this module silently "fixed" is a rule that does something other than
 * what its author believes, in a room they cannot see.
 */
export function parseProgressFilter(raw, { group = null } = {}) {
  if (raw === null || raw === undefined) {
    return { ok: true, filter: { ...DEFAULT_PROGRESS_FILTER, source: 'default' } };
  }
  if (!isPlainObject(raw)) return { ok: false, reason: 'filter is not an object' };

  /*
   * PER-GROUP RULES REPLACE, THEY DO NOT MERGE FIELD BY FIELD. A merge means an operator writing
   * `{"events":["done"]}` for a customer keeps whatever `tools.exclude` the defaults happened to have —
   * so the rule they wrote to narrow one room silently inherits policy from elsewhere. Whole-object
   * replacement makes a per-group rule readable on its own, which is what someone auditing a
   * customer's room needs.
   */
  const perGroup = raw.perGroup;
  if (perGroup !== undefined && !isPlainObject(perGroup)) {
    return { ok: false, reason: 'perGroup is not an object' };
  }
  const scoped = (group && isPlainObject(perGroup?.[group])) ? perGroup[group] : null;
  const base = scoped || raw;

  const events = normalizeStringList(base.events, DEFAULT_PROGRESS_FILTER.events);
  if (events === undefined) return { ok: false, reason: 'events must be an array of non-empty strings' };

  const toolsRaw = base.tools;
  if (toolsRaw !== undefined && !isPlainObject(toolsRaw)) {
    return { ok: false, reason: 'tools is not an object' };
  }
  const include = normalizeStringList(toolsRaw?.include, null);
  if (include === undefined) return { ok: false, reason: 'tools.include must be an array of strings or null' };
  const exclude = normalizeStringList(toolsRaw?.exclude, []);
  if (exclude === undefined) return { ok: false, reason: 'tools.exclude must be an array of strings' };

  let minIntervalMs = base.minIntervalMs;
  if (minIntervalMs === undefined || minIntervalMs === null) {
    minIntervalMs = DEFAULT_PROGRESS_FILTER.minIntervalMs;
  }
  if (typeof minIntervalMs !== 'number' || !Number.isFinite(minIntervalMs) || minIntervalMs < 0) {
    return { ok: false, reason: 'minIntervalMs must be a non-negative number' };
  }
  /*
   * A FLOOR ON THE INTERVAL, and it is deliberately not configurable away. Throttling a caller can
   * lower is throttling a caller will lower, and the caller here fires on every tool call. Five
   * seconds is already faster than anyone reads.
   */
  minIntervalMs = Math.max(5000, minIntervalMs);

  return {
    ok: true,
    filter: {
      events,
      tools: { include, exclude },
      minIntervalMs,
      source: scoped ? `perGroup:${group}` : 'file',
    },
  };
}

/**
 * Does this event go out, and as what.
 *
 * `{ report: false, reason }` is a normal answer, not an error — most events do not go out, which is
 * the point. The reason is returned rather than logged so the caller can surface it under a debug flag
 * without this module knowing what a log is.
 */
export function decideProgressEvent({ event, tool = null, filter = DEFAULT_PROGRESS_FILTER } = {}) {
  const kind = event === 'Stop' || event === 'done' ? 'done'
    : event === 'start' || event === 'SessionStart' ? 'start'
      : 'step';

  if (!filter.events.includes(kind)) return { report: false, kind, reason: `event ${kind} is not reported` };

  if (kind !== 'step') return { report: true, kind, verb: null };

  /*
   * A STEP WITH NO TOOL is not a step. `PostToolUse` without a tool name means the payload was
   * malformed or came from something this does not understand, and inventing "worked" for it would
   * turn a parsing failure into a line in a customer's room.
   */
  if (!tool || typeof tool !== 'string') {
    return { report: false, kind, reason: 'step carried no tool name' };
  }
  if (filter.tools.exclude.includes(tool)) {
    return { report: false, kind, reason: `tool ${tool} is excluded` };
  }
  if (filter.tools.include && !filter.tools.include.includes(tool)) {
    return { report: false, kind, reason: `tool ${tool} is not in the include list` };
  }
  return { report: true, kind, verb: verbFor(tool) };
}
