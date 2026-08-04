import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';

import { renderMonitorPage } from '../lib/dashboard/render/monitor-page.js';

// The monitor opened on "Select an agent to monitor" / "NO AGENT SELECTED", and every
// agent button carried only a glyph, a name, and sometimes SUP. ACTIVE/IDLE and
// duration were computed only AFTER selection, so finding trouble meant clicking
// every agent in turn. It was a viewer, not a triage surface.
//
// Codex reviewed this independently and argued against starting with semantic HTML,
// a component layer, or splitting the 3,473-line detail file — all real problems,
// none of them the operator's. This is the change it recommended instead.

const html = renderMonitorPage({ idleThreshold: 60000, idleThresholdSec: 60 });
const source = readFileSync('lib/dashboard/render/monitor-page.js', 'utf-8');

describe('an agent button states its own condition', () => {
  test('the button template emits a state line', () => {
    // Assert on the TEMPLATE, not the rendered shell. Buttons are built client-side,
    // so `agent-btn-state` appears in the static HTML via the stylesheet whether or
    // not the button emits it — the first version of this test passed with the span
    // deleted from agentBtnHtml.
    const fn = source.slice(source.indexOf('function agentBtnHtml'));
    const body = fn.slice(0, fn.indexOf('\n    }'));
    expect(body, 'the button does not emit a state span').toMatch(
      /<span class="agent-btn-state" data-state-for=/,
    );
    expect(body).toMatch(/esc\(stateText\)/);
    expect(body).toMatch(/<span class="agent-btn-name">/);
    // And the stylesheet must still define it, or the span is unstyled.
    expect(html).toContain('.agent-btn-state');
  });

  test('the state text reuses the existing helper rather than a second copy', () => {
    // runtimeStatusText() already produced exactly this string for the selected-agent
    // badge and the detail panel. A second formatter is how the two drift.
    const fn = source.slice(source.indexOf('function agentBtnHtml'));
    const body = fn.slice(0, fn.indexOf('\n    }'));
    expect(body).toContain('runtimeStatusText(');
    expect(body).not.toMatch(/ACTIVE '|IDLE '/);
  });

  test('REMOTE and SUP are spelled out, not left to a glyph', () => {
    // Colour and shape alone required a legend that appears nowhere on the page.
    const fn = source.slice(source.indexOf('function agentBtnHtml'));
    const body = fn.slice(0, fn.indexOf('\n    }'));
    expect(body).toContain("'REMOTE'");
    expect(body).toContain("'SUP'");
    // The glyph stays as a secondary cue.
    expect(body).toContain('9679');
  });

  test('the click contract is unchanged', () => {
    // Selection, supervisor targeting and tmux routing all read these attributes.
    for (const attr of ['data-name=', 'data-tmux=', 'data-sup-target=']) {
      expect(source).toContain(attr);
    }
  });

  test('the existing state classes still drive styling', () => {
    for (const cls of ['active-agent', 'inactive-agent', 'remote-agent']) {
      expect(html).toContain(cls);
    }
  });
});

describe('durations stay live without re-rendering the list', () => {
  test('the ticker updates state text in place', () => {
    expect(source).toContain('function updateAgentButtonStates');
    expect(source).toMatch(/data-state-for/);
  });

  test('the ticker does NOT call renderAgentButtons', () => {
    // renderAgentButtons() re-sorts by active/idle and idle duration. Calling it
    // once a second would shuffle buttons under the pointer mid-scan — live
    // durations bought at the cost of an unreadable list.
    const fn = source.slice(source.indexOf('function updateAgentButtonStates'));
    const body = fn.slice(0, fn.indexOf('\n  }'));
    expect(body).not.toContain('renderAgentButtons');
    expect(body).toContain('textContent');
  });

  test('the ticker is actually wired into the duration tick', () => {
    const ticker = source.slice(source.indexOf('function tickAgentDurationsLocal'));
    const body = ticker.slice(0, ticker.indexOf('\n  }'));
    expect(body).toContain('updateAgentButtonStates()');
  });

  test('digits do not reflow the button as they tick', () => {
    expect(source).toContain('font-variant-numeric:tabular-nums');
  });
});

describe('controls name their effect, not their implementation', () => {
  test.each([
    ['10HZ', 'Refresh: 10/sec'],
    ['ECO', 'Refresh: Eco'],
    ['PAUSE', 'Pause display'],
    ['DETAIL', 'Agent details'],
    ['SEND NOW', 'Send now'],
  ])('%s became %s', (_old, now) => {
    expect(html).toContain(now);
  });

  test.each(['>10HZ<', '>ECO<', 'SEND NOW', '>DETAIL<', '>CANCEL<'])('%s is gone', (stale) => {
    expect(html).not.toContain(stale);
  });

  test('the two most misleading controls say what they do NOT affect', () => {
    // 10HZ changed display polling and PAUSE paused the terminal refresh; neither
    // touched the agent. During an incident that is the wrong mental model.
    expect(html).toMatch(/Does not affect the agent/);
    expect(html).toMatch(/The agent keeps running/);
  });

  test('send now discloses that it skips the idle wait', () => {
    // Verified against server.js: /api/queue/:id/send claims the entry for delivery
    // with reason 'manual' rather than waiting for the agent to go idle.
    expect(html).toMatch(/without waiting for the agent to go idle/);
  });
});

describe('an action says whether it worked', () => {
  test('both queue outcomes are announced', () => {
    const fn = source.slice(source.indexOf('window.queueAction'));
    const body = fn.slice(0, fn.indexOf('\n  };'));
    expect(body).toMatch(/announceAction\('ok'/);
    expect(body).toMatch(/announceAction\('fail'/);
  });

  test('the reminder path is announced too', () => {
    const fn = source.slice(source.indexOf('window.cancelReminder'));
    const body = fn.slice(0, fn.indexOf('\n  };'));
    expect(body).toMatch(/announceAction\('ok'/);
    expect(body).toMatch(/announceAction\('fail'/);
  });

  test('a failure reports the reason, not just that it failed', () => {
    // The endpoint refuses for distinguishable reasons: 409 already-delivering,
    // 503 queue-persist-failed.
    expect(source).toMatch(/announceAction\('fail'[^)]*e\.message/);
  });

  test('failures stay on screen longer than successes', () => {
    const fn = source.slice(source.indexOf('function announceAction'));
    const body = fn.slice(0, fn.indexOf('\n  }'));
    const match = body.match(/kind === 'ok' \? (\d+) : (\d+)/);
    expect(match).toBeTruthy();
    expect(Number(match[2])).toBeGreaterThan(Number(match[1]));
  });

  test('the notice is announced to assistive tech and never blocks the terminal', () => {
    expect(source).toContain("setAttribute('role', 'status')");
    expect(source).toContain("aria-live");
    expect(html).toMatch(/#action-notice\{[^}]*pointer-events:none/);
  });

  test('the optimistic restore-on-failure is preserved', () => {
    // Load-bearing concurrency defense. Making failure visible must not remove it.
    for (const fname of ['window.queueAction', 'window.cancelReminder']) {
      const fn = source.slice(source.indexOf(fname));
      const body = fn.slice(0, fn.indexOf('\n  };'));
      expect(body, `${fname} lost its restore`).toMatch(/\.push\(removed\)/);
    }
  });
});
