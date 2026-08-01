import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';

const source = readFileSync('server.js', 'utf-8');

// A host on mini5 had six registered agents, one of them online and running
// Claude, and the dashboard rendered an empty fleet. /api/agents/status filtered
// out every agent whose tmux target was null, so "no agents exist" and "every
// agent is offline" produced byte-identical responses. The backend nulls that
// field whenever it marks an agent tmux-missing, which is the normal offline
// state, so the dashboard was hiding exactly the agents an operator needs to see.

describe('/api/agents/status reports offline agents instead of hiding them', () => {
  const handler = (() => {
    const start = source.indexOf("app.get('/api/agents/status'");
    expect(start).toBeGreaterThan(-1);
    return source.slice(start, source.indexOf('\n});', start));
  })();

  test('paneless agents are collected, not discarded', () => {
    expect(handler).toContain('withoutPane');
    expect(handler).toMatch(/\.filter\(a => !a\.tmux\)/);
  });

  test('they are included in the response', () => {
    expect(handler).toMatch(/res\.json\(\[\.\.\.result, \.\.\.withoutPane\]\)/);
    expect(handler).not.toMatch(/res\.json\(result\);/);
  });

  test('a paneless tmux agent renders as down, while an ACP one does not', () => {
    // Absence of a pane is a fault for a tmux agent and normal for an ACP agent,
    // so aliveness is no longer a constant here: it follows the backend's `online`
    // for acp and is false otherwise. Reporting every paneless agent dead would
    // have hidden every working ACP agent.
    const block = handler.slice(handler.indexOf('withoutPane'), handler.indexOf('const result'));
    expect(block).toContain("a.transport === 'acp'");
    expect(block).toMatch(/alive: acp \? a\.online === true : false/);
    expect(block).toContain('active: false');
    expect(block).toContain('idleMs: -1');
  });

  test('they carry the reason the backend recorded', () => {
    // Without this the UI can say "offline" but not why — and "tmux-missing:auto"
    // versus "denylisted by session policy" are very different situations.
    const block = handler.slice(handler.indexOf('withoutPane'), handler.indexOf('const result'));
    expect(block).toContain('offlineReason');
    expect(block).toMatch(/a\.offlineReason \|\| 'no-tmux-target'/);
  });

  test('agents with a pane still come first', () => {
    // Ordering is deliberate: the ones an operator can act on lead the list.
    expect(handler).toMatch(/\[\.\.\.result, \.\.\.withoutPane\]/);
  });

  test('the pane-probing path is unchanged for live agents', () => {
    // The fix must not alter what a healthy agent reports.
    expect(handler).toContain('getPaneIdleMs(a.tmux)');
    expect(handler).toContain('const alive = idleMs >= 0');
  });
});

describe('pane capture honours the session policy', () => {
  // GET /api/tmux/capture/:session ran `tmux capture-pane -p -S -500` on any
  // session name matching [\w\-:.]+. The session policy governed agent management
  // but not this route, and GET is exempt from the dashboard's auth boundary — so
  // on a host where the denylist exists to keep HAFleet away from someone else's
  // work, 500 lines of that work were readable with no credential. Verified by
  // pulling an excluded pane's contents over the LAN before this was fixed.
  const handler = (() => {
    const start = source.indexOf("app.get('/api/tmux/capture/:session'");
    expect(start).toBeGreaterThan(-1);
    return source.slice(start, source.indexOf('\n});', start));
  })();

  test('the policy is consulted', () => {
    expect(handler).toContain('capturePolicy.evaluate');
  });

  test('an excluded session is refused with 403 and a reason', () => {
    expect(handler).toMatch(/status\(403\)/);
    expect(handler).toContain('session excluded by policy');
    expect(handler).toContain('verdict.reason');
  });

  test('the check runs before any capture is attempted', () => {
    const guard = handler.indexOf('capturePolicy.evaluate');
    const capture = handler.indexOf('capture-pane');
    expect(guard).toBeGreaterThan(-1);
    expect(capture).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(capture);
  });

  test('the session name is taken before any window/pane suffix', () => {
    // 'ps2:0.0' must be evaluated as 'ps2', or a suffix would bypass the denylist.
    expect(handler).toMatch(/session\.split\(':', 1\)\[0\]/);
  });

  test('the policy comes from the environment, like the backend and relay', () => {
    expect(source).toContain("import { sessionPolicyFromEnv } from './lib/session-policy.js'");
    expect(source).toContain('const capturePolicy = sessionPolicyFromEnv()');
  });
});
