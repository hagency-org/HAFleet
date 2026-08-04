#!/usr/bin/env node
/**
 * Assert the design invariants against the running prototype.
 *
 * These are the design-document tests, executable. Each one exists because a
 * review round caught its absence:
 *   - route inventory: round 1 listed a `queue` destination with no handler
 *   - one aria-current: the rail must mark the current page, exactly once
 *   - tablist contract: round 2 called bare role="tab" fake accessibility
 *   - severity ordering: round 2's overview claimed to rank and sorted by age
 *   - dot-and-word: round 2 drew a red dot labelled "info"
 *   - no pane polling for ACP: 10/sec was pane polling; ACP has no pane
 *
 * HTML is split on `self.__next_f` first: Next embeds an RSC flight payload in
 * the page, which duplicates the markup and made an earlier version of this
 * check report false failures.
 */

const BASE = process.env.BASE ?? 'http://127.0.0.1:3100';

const ROUTES = [
  '/overview', '/alerts', '/queue', '/tasks', '/projects', '/capacity', '/config',
  '/agents/octos-agent', '/agents/codex-agent', '/agents/hermes-agent',
  '/agents/codex-acp-agent', '/agents/renamed-agent',
];

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

async function rendered(path) {
  const res = await fetch(BASE + path);
  const html = await res.text();
  return { status: res.status, html: html.split('self.__next_f')[0], raw: html };
}

const rank = (map) => (list) => list.every((v, i) => i === 0 || map[list[i - 1]] <= map[v]);

console.log(`\nDesign invariants against ${BASE}\n`);

// 1. every rail destination resolves
for (const r of ROUTES) {
  const { status } = await rendered(r);
  check(`route ${r} resolves`, status === 200, `HTTP ${status}`);
}
const bad = await fetch(`${BASE}/definitely-not-a-route`);
check('an unregistered route 404s', bad.status === 404, `HTTP ${bad.status}`);

// 2. the rail is on every page, marking exactly one destination
for (const r of ROUTES) {
  const { html } = await rendered(r);
  check(`${r} renders the rail`, html.includes('class="rail"'));
  const n = (html.match(/aria-current="page"/g) ?? []).length;
  check(`${r} marks exactly one current destination`, n === 1, `${n} found`);
}

// 3. the full tablist contract on agent detail
{
  const { html } = await rendered('/agents/octos-agent');
  check('role="tablist" present', html.includes('role="tablist"'));
  const tabs = (html.match(/role="tab"/g) ?? []).length;
  check('seven tabs', tabs === 7, `${tabs} found`);
  const sel = (html.match(/aria-selected="true"/g) ?? []).length;
  check('exactly one aria-selected="true"', sel === 1, `${sel} found`);
  const controls = (html.match(/aria-controls="panel-/g) ?? []).length;
  check('every tab has aria-controls', controls === 7, `${controls} found`);
  check('a tabpanel is labelled by its tab', html.includes('aria-labelledby="tab-'));
}

// 4. severity is a dot AND a word, and the overview ranks
{
  const { html } = await rendered('/overview');
  const dots = (html.match(/class="dot"/g) ?? []).length;
  const lbls = (html.match(/class="lbl"/g) ?? []).length;
  check('every severity dot has a word beside it', dots > 0 && dots === lbls, `${dots} dots, ${lbls} labels`);
  const order = [...html.matchAll(/sev sev-(critical|warning|info)/g)].map((m) => m[1]);
  check('needs-attention ranked most-severe-first',
    rank({ critical: 0, warning: 1, info: 2 })(order), order.join(' '));
}

// 5. tasks are blocked-first
{
  const { html } = await rendered('/tasks');
  const tbody = html.slice(html.indexOf('<tbody'), html.indexOf('</tbody>'));
  const buckets = [...tbody.matchAll(/class="badge (blocked|in_progress|accepted|created|done)"/g)].map((m) => m[1]);
  check('task list ordered blocked-first',
    rank({ blocked: 0, in_progress: 1, accepted: 2, created: 3, done: 4 })(buckets), buckets.join(' '));
  check('a status class is not reused as a warning', !tbody.includes('HEARTBEAT STALE</span>') || tbody.includes('badge attention'));
}

// 6. ACP agents are never offered pane polling
{
  const acp = await rendered('/agents/octos-agent');
  check('ACP agent offers no 10/sec control', !acp.html.includes('10/sec'));
  check('ACP agent states it has no pane', acp.html.includes('no pane'));
  const tmux = await rendered('/agents/codex-agent');
  check('tmux agent does offer 10/sec', tmux.html.includes('10/sec'));
}

// 7. counts carry their unit
{
  const { html } = await rendered('/overview');
  check('rail counts are labelled, not bare', /\d+ (open|groups|waiting)/.test(html));
}

console.log(`\n${failed === 0 ? 'All invariants hold.' : `${failed} FAILED.`}\n`);
process.exit(failed === 0 ? 0 : 1);
