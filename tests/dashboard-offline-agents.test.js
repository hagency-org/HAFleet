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

  test('they carry alive:false so the UI can render them as down', () => {
    const block = handler.slice(handler.indexOf('withoutPane'), handler.indexOf('const result'));
    expect(block).toContain('alive: false');
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
