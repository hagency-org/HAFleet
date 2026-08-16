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
