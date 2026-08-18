/*
 * The layer that decides what a room hears, and the two directions it must not fail in.
 *
 * The reporter's first version wired framework events straight through with the policy hardcoded, so
 * every customer got the same verbosity whether their room wanted it or not. This is that policy made
 * inspectable — and the reason it needs its own test file is that both of its failure directions are
 * silent in production: report too much and a shared room fills with an agent's narration, report too
 * little and the feature looks broken while appearing configured.
 */
import { describe, expect, test } from 'vitest';
import {
  DEFAULT_PROGRESS_FILTER,
  acpUpdateFailedCall,
  acpUpdateToEvent,
  buildProgressSummary,
  decideProgressEvent,
  parseProgressFilter,
  verbFor,
} from '../lib/progress-filter.js';

const ok = (raw, opts) => {
  const result = parseProgressFilter(raw, opts);
  expect(result.ok, result.reason).toBe(true);
  return result.filter;
};

describe('the default, which is the old hardcoded behaviour written down', () => {
  test('no filter at all reports start, steps and completion', () => {
    // Absent must mean "nobody configured this", never "report nothing": a feature that goes silent
    // because it was not configured is a feature that reads as broken.
    const filter = ok(null);
    expect(filter.source).toBe('default');
    for (const [event, tool] of [['start', null], ['PostToolUse', 'Read'], ['Stop', null]]) {
      expect(decideProgressEvent({ event, tool, filter }).report).toBe(true);
    }
  });

  test('Bash is reported by default, as a verb and never as a command', () => {
    // Included on purpose: "the agent is running things" is the strongest signal work is happening, and
    // an agent that looks idle while compiling is the failure this feature exists to prevent.
    expect(decideProgressEvent({ event: 'PostToolUse', tool: 'Bash', filter: DEFAULT_PROGRESS_FILTER }))
      .toMatchObject({ report: true, verb: 'ran commands' });
  });

  test('an unknown tool is "worked", not its own name', () => {
    // A tool name is a fact about the deployment — which MCP servers are connected, what an agent was
    // given. An unrecognised one is exactly where nobody has decided whether naming it is safe.
    expect(verbFor('SomeCustomerMcpTool')).toBe('worked');
    expect(verbFor(undefined)).toBe('worked');
  });
});

describe('narrowing what leaves the machine', () => {
  test('events can be reduced to start and finish', () => {
    const filter = ok({ events: ['start', 'done'] });
    expect(decideProgressEvent({ event: 'start', filter }).report).toBe(true);
    expect(decideProgressEvent({ event: 'Stop', filter }).report).toBe(true);
    expect(decideProgressEvent({ event: 'PostToolUse', tool: 'Read', filter }).report).toBe(false);
  });

  test('a tool can be excluded outright', () => {
    // The privacy control, not just a verbosity one: a command line can carry a credential somebody
    // pasted, and an operator may want the fact of running commands kept out of a customer's room.
    const filter = ok({ tools: { exclude: ['Bash'] } });
    expect(decideProgressEvent({ event: 'PostToolUse', tool: 'Bash', filter }))
      .toMatchObject({ report: false });
    expect(decideProgressEvent({ event: 'PostToolUse', tool: 'Read', filter }).report).toBe(true);
  });

  test('an include list makes everything else silent', () => {
    const filter = ok({ tools: { include: ['Read'] } });
    expect(decideProgressEvent({ event: 'PostToolUse', tool: 'Read', filter }).report).toBe(true);
    expect(decideProgressEvent({ event: 'PostToolUse', tool: 'Edit', filter }).report).toBe(false);
  });

  test('a step with no tool name is refused rather than called "worked"', () => {
    // A malformed payload must not become a line in a customer's room. Reporting a parse failure as
    // activity is how a broken integration comes to look like a working one.
    const filter = ok(null);
    expect(decideProgressEvent({ event: 'PostToolUse', tool: null, filter }))
      .toMatchObject({ report: false });
  });
});

describe('per-customer rules', () => {
  test('a group with its own rule uses it, and says so', () => {
    const raw = { events: ['start', 'step', 'done'], perGroup: { acme: { events: ['done'] } } };
    const scoped = ok(raw, { group: 'acme' });
    expect(scoped.source).toBe('perGroup:acme');
    expect(decideProgressEvent({ event: 'start', filter: scoped }).report).toBe(false);
    expect(decideProgressEvent({ event: 'Stop', filter: scoped }).report).toBe(true);
  });

  test('a group with no rule of its own uses the defaults', () => {
    const raw = { events: ['start', 'step', 'done'], perGroup: { acme: { events: ['done'] } } };
    const other = ok(raw, { group: 'other' });
    expect(other.source).toBe('file');
    expect(decideProgressEvent({ event: 'start', filter: other }).report).toBe(true);
  });

  test('a per-group rule REPLACES rather than merging field by field', () => {
    /*
     * A merge would mean an operator writing `{"events":["done"]}` for one customer silently keeps
     * whatever `tools.exclude` the top level happened to have — so a rule written to narrow one room
     * inherits policy from somewhere else. Whole-object replacement keeps a customer's rule readable on
     * its own, which is what auditing that customer's room requires.
     */
    const raw = {
      tools: { exclude: ['Bash'] },
      perGroup: { acme: { events: ['step'] } },
    };
    const scoped = ok(raw, { group: 'acme' });
    expect(decideProgressEvent({ event: 'PostToolUse', tool: 'Bash', filter: scoped }).report).toBe(true);
  });
});

describe('failing closed on configuration, open on absence', () => {
  test.each([
    ['events is a string, not a list', { events: 'done' }],
    ['events contains a blank', { events: ['done', '  '] }],
    ['events contains a non-string', { events: ['done', 3] }],
    ['tools is a list', { tools: ['Bash'] }],
    ['tools.exclude is a string', { tools: { exclude: 'Bash' } }],
    ['perGroup is a list', { perGroup: [] }],
    ['minIntervalMs is negative', { minIntervalMs: -1 }],
    ['minIntervalMs is not a number', { minIntervalMs: '60s' }],
    ['the document is a list', []],
    ['the document is a string', 'events=done'],
  ])('%s is refused, not repaired', (_label, raw) => {
    // Not repaired, deliberately: a rule this module silently "fixed" does something other than what
    // its author believes, in a room they cannot see.
    const result = parseProgressFilter(raw);
    expect(result.ok).toBe(false);
    expect(typeof result.reason).toBe('string');
  });

  test('the interval has a floor that cannot be configured away', () => {
    // Throttling a caller can lower is throttling a caller will lower, and this caller fires on every
    // tool call. Five seconds is already faster than anyone reads.
    expect(ok({ minIntervalMs: 0 }).minIntervalMs).toBe(5000);
    expect(ok({ minIntervalMs: 1 }).minIntervalMs).toBe(5000);
    expect(ok({ minIntervalMs: 120000 }).minIntervalMs).toBe(120000);
  });

  test('deciding is pure — the same inputs give the same answer', () => {
    // No clock, no network, no filesystem. This runs on every tool call of every agent; a policy layer
    // that could block or throw there would break the work it describes.
    const filter = ok({ events: ['step'], tools: { exclude: ['Bash'] } });
    const once = decideProgressEvent({ event: 'PostToolUse', tool: 'Read', filter });
    const twice = decideProgressEvent({ event: 'PostToolUse', tool: 'Read', filter });
    expect(once).toEqual(twice);
  });
});

describe('ACP as the transport, which needs nothing installed', () => {
  /*
   * WHY THIS EXISTS AND HOOKS DO NOT COVER IT. Each framework installs hooks differently — different file,
   * different scope, different trust model — and octos has none at all, so one hook for every framework is
   * not a thing that can be built. `session/update` is: HAFleet already receives it, already parses tool
   * calls from it, and three of four frameworks speak the protocol. The mapping below is what lets ONE
   * policy and ONE vocabulary serve both transports.
   */
  test('a tool call becomes the same shape a hook payload has', () => {
    expect(acpUpdateToEvent({ sessionUpdate: 'tool_call', kind: 'read', toolCallId: 't1' }))
      .toEqual({ event: 'PostToolUse', tool: 'Read' });
  });

  test('kinds map to the tool names an operator already filters by', () => {
    /*
     * The reason `execute` becomes `Bash` rather than its own name. An operator writing
     * `tools: { exclude: ['Bash'] }` means "do not tell the room I run commands", and that must hold for an
     * ACP agent too — without them writing the rule twice in two vocabularies.
     */
    const filter = parseProgressFilter({ tools: { exclude: ['Bash'] } }).filter;
    const mapped = acpUpdateToEvent({ sessionUpdate: 'tool_call', kind: 'execute' });
    expect(mapped.tool).toBe('Bash');
    expect(decideProgressEvent({ ...mapped, filter }).report).toBe(false);
  });

  test('thinking is dropped rather than reported', () => {
    // "Still thinking" every minute is the noise this feature exists to avoid; the typing indicator already
    // says it, without an event.
    expect(acpUpdateToEvent({ sessionUpdate: 'tool_call', kind: 'think' })).toBeNull();
  });

  test('an unknown kind is generic activity, never its own name', () => {
    /*
     * No sample of a live ACP session existed when this was written, so the table is what the spec states
     * and this fallback is what protects the rest. A future kind reads as activity — which is also the right
     * privacy default, since an unvetted kind is a fact about the deployment.
     */
    const mapped = acpUpdateToEvent({ sessionUpdate: 'tool_call', kind: 'something_new_in_2027' });
    expect(mapped.tool).toBe('AcpTool');
    expect(decideProgressEvent({ ...mapped, filter: DEFAULT_PROGRESS_FILTER }))
      .toMatchObject({ report: true, verb: 'worked' });
  });

  test('a repeat update for one call is not counted again', () => {
    /*
     * `tool_call_update` arrives repeatedly for a single call as its status changes. Counting each would
     * report "read ×7" for one file — inflating the only numbers this puts in front of a customer.
     */
    expect(acpUpdateToEvent({ sessionUpdate: 'tool_call_update', kind: 'read', status: 'completed' }))
      .toBeNull();
  });

  test('everything that is not a tool call is ignored', () => {
    for (const kind of ['agent_message_chunk', 'plan', 'user_message_chunk', 'agent_thought_chunk']) {
      expect(acpUpdateToEvent({ sessionUpdate: kind })).toBeNull();
    }
    expect(acpUpdateToEvent(null)).toBeNull();
    expect(acpUpdateToEvent({})).toBeNull();
  });

  test('the title is never carried, because the agent wrote it', () => {
    /*
     * A title is free text: "Read /home/customer/secrets.env". Putting it in a customer's room would leak
     * exactly what the verb table exists to keep out, so no field of the mapping may contain it.
     */
    const mapped = acpUpdateToEvent({
      sessionUpdate: 'tool_call',
      kind: 'read',
      title: 'Read /home/customer/.env with the API keys',
      rawInput: { arguments: { path: '/home/customer/.env' } },
    });
    expect(JSON.stringify(mapped)).not.toMatch(/secrets|\.env|customer/);
  });
});

describe('a turn that only failed must not read as a turn that worked', () => {
  /*
   * FOUND BY RUNNING IT, and it is the defect this whole group exists for. A real ACP turn put
   * `⏳ finished — worked ×16, read` into a Matrix room while the agent was stuck in a loop it could not
   * escape — the tools it needed were not available to it, so sixteen attempts produced nothing. The room
   * was told the agent was busy. Sixteen attempts and zero results read as diligence.
   *
   * A progress feed that cannot tell working from failing is worse than one that says nothing, because it
   * manufactures confidence in a stall.
   */
  test('nothing succeeded is said plainly, not dressed as activity', () => {
    expect(buildProgressSummary({ kind: 'done', counts: {}, failures: 16 }))
      .toBe('finished, but nothing succeeded — 16 failed attempts');
  });

  test('one failed attempt is singular, because sloppy counting reads as a bug', () => {
    expect(buildProgressSummary({ kind: 'done', counts: {}, failures: 1 }))
      .toBe('finished, but nothing succeeded — 1 failed attempt');
  });

  test('mixed work and failure reports both, and neither hides the other', () => {
    expect(buildProgressSummary({ kind: 'done', counts: { read: 3 }, failures: 2 }))
      .toBe('finished — read ×3, 2 failed');
  });

  test('a clean turn is unchanged, so the common case did not get noisier', () => {
    expect(buildProgressSummary({ kind: 'done', counts: { read: 3, edited: 1 } }))
      .toBe('finished — read ×3, edited');
    expect(buildProgressSummary({ kind: 'done', counts: {} })).toBe('finished');
    expect(buildProgressSummary({ kind: 'start' })).toBe('started');
  });

  test('failures reach a step line too, not only the summary at the end', () => {
    // A ten-minute turn should not hide trouble until it is over. Somebody waiting can act on "it is
    // failing" long before they can act on "it finished having failed".
    expect(buildProgressSummary({ kind: 'step', counts: {}, failures: 4 })).toBe('4 failed attempts');
    expect(buildProgressSummary({ kind: 'step', counts: { read: 1 }, failures: 1 })).toBe('read, 1 failed');
  });

  test('an empty step is still nothing to say', () => {
    // "Still thinking" every minute is the noise this feature exists to avoid.
    expect(buildProgressSummary({ kind: 'step', counts: {}, failures: 0 })).toBeNull();
  });

  test('a failure is read from the update kind that activity counting drops', () => {
    /*
     * `tool_call_update` repeats per call as its status changes, so it must not add to the activity counts —
     * but the status is the only place failure is stated. Ignoring those updates entirely is exactly what
     * made a stuck agent look busy.
     */
    expect(acpUpdateFailedCall({ sessionUpdate: 'tool_call_update', status: 'failed' })).toBe(true);
    expect(acpUpdateToEvent({ sessionUpdate: 'tool_call_update', status: 'failed', kind: 'read' })).toBeNull();
  });

  test('only "failed" counts as failure — pending and completed do not', () => {
    for (const status of ['pending', 'in_progress', 'completed', '', undefined]) {
      expect(acpUpdateFailedCall({ sessionUpdate: 'tool_call_update', status })).toBe(false);
    }
    // And a fresh call is not a failure however it is spelled.
    expect(acpUpdateFailedCall({ sessionUpdate: 'tool_call', status: 'failed' })).toBe(false);
  });

  test('no reason travels with the count', () => {
    /*
     * A reason is written by the tool that failed — a path, a command, an error from somebody's homeserver —
     * and this line goes to a customer's room. The count is actionable to whoever is waiting; the detail is
     * for the operator, who has the pane.
     */
    const line = buildProgressSummary({ kind: 'done', counts: {}, failures: 3 });
    expect(line).not.toMatch(/error|ENOENT|\/home|denied|refused/i);
  });
});

describe('work that produced no answer, which is what the incident actually was', () => {
  /*
   * THE CORRECTION. Counting failures was built to fix `⏳ finished — worked ×16` and does not: measured on
   * a live octos turn, every one of those calls emitted `tool_call_update:completed`. A shell command that
   * returns an error still RAN, so the framework calls it completed. The agent was not failing at tools — it
   * had no tool that could deliver its answer, so it worked hard and produced nothing the room could see.
   *
   * `delivered === 0` after real activity is the honest signal, and it is the one that matches the incident.
   */
  test('activity with nothing sent says so', () => {
    expect(buildProgressSummary({ kind: 'done', counts: { worked: 16 }, delivered: 0 }))
      .toBe('finished — worked ×16, but sent nothing');
  });

  test('activity with something sent is unchanged', () => {
    expect(buildProgressSummary({ kind: 'done', counts: { worked: 16 }, delivered: 1 }))
      .toBe('finished — worked ×16');
  });

  test('unknown delivery says nothing about it', () => {
    // `null` is the hook transport, which cannot tell. Silence beats a guess — a hook agent that answered
    // would otherwise be reported as silent on every turn.
    expect(buildProgressSummary({ kind: 'done', counts: { worked: 2 }, delivered: null }))
      .toBe('finished — worked ×2');
  });

  test('a turn that did nothing at all is not accused of sending nothing', () => {
    // "It did nothing" and "it worked and delivered nothing" are different states, and only the second is
    // worth flagging. An agent that read its inbox and had nothing to do is behaving correctly.
    expect(buildProgressSummary({ kind: 'done', counts: {}, delivered: 0 })).toBe('finished');
  });

  test('failures still take precedence, because they are the stronger statement', () => {
    expect(buildProgressSummary({ kind: 'done', counts: { read: 2 }, failures: 1, delivered: 0 }))
      .toBe('finished — read ×2, 1 failed');
  });

  test('no cause is offered for the silence', () => {
    /*
     * Why nothing was sent is on the operator's side of the line — a missing tool, an unreachable backend,
     * a permission. The room only needs to know not to keep waiting.
     */
    const line = buildProgressSummary({ kind: 'done', counts: { worked: 3 }, delivered: 0 });
    expect(line).not.toMatch(/tool|mcp|backend|permission|unreachable/i);
  });
});
