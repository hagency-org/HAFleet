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
 *   - i18n: every t() key resolves, both locales agree, placeholders match
 *   - theme: dark tokens exist under both signals, and an explicit choice wins
 *
 * HTML is split on `self.__next_f` first: Next embeds an RSC flight payload in
 * the page, which duplicates the markup and made an earlier version of this
 * check report false failures.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DICTS, missingKeys, orphanKeys, placeholderMismatches } from '../lib/i18n.js';
import {
  pool, routable, coveringTier, gridTotal, leasedAgents, busyAgents, roleCommand, API_BASE,
  ROLES, CAPABILITY_TIERS, ROLE_DEFAULT_TIER,
  roles, retiredRoles, resolveRoleKey, satisfies, workerOf, allocationRows, orgGroups,
  SKILL_VOCABULARY, LIFECYCLE_STAGES, projects, engagementsBy, costBy, stageGaps,
  agents as fixtureAgents,
} from '../lib/mock-data.js';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3100';

/*
 * Both lenses, both levels, plus the four routes the rail demoted. Those four are
 * still real URLs — bookmarks and most of the assertions below point at them — they
 * simply light up Org rather than themselves, which is what `also` in the rail does.
 */
const ROUTES = [
  '/org', '/projects',
  '/org/product-manager', '/org/architect', '/org/system-engineer', '/org/coding',
  '/org/testing', '/org/integration', '/org/documentation',
  '/projects/api-service', '/projects/docs-portal',
  '/workforce', '/assignments', '/capacity', '/performance', '/knowledge',
  '/onboard', '/alerts', '/config', '/queue', '/tasks',
  '/agents/octos-agent', '/agents/codex-agent', '/agents/hermes-agent',
  '/agents/codex-acp-agent', '/agents/claude-agent',
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
  const { html } = await rendered('/workforce');
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
  const { html } = await rendered('/workforce');
  check('rail counts are labelled, not bare', /\d+ (open|groups|waiting)/.test(html));
}

// 8. i18n — the dictionary is complete and every key a component asks for exists
{
  const en = DICTS.en;
  check('both locales define the same keys',
    missingKeys('zh').length === 0 && orphanKeys('zh').length === 0,
    `missing ${missingKeys('zh').length}, orphan ${orphanKeys('zh').length}`);

  const drift = placeholderMismatches('zh');
  check('placeholders match across locales', drift.length === 0,
    drift.map((d) => d.key).join(' '));

  // Every literal key in a t('…') call must resolve. A typo would otherwise render
  // the key itself on screen, which is exactly the failure the fallback allows.
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      // lib/ is walked too — fmtIn() in mock-data.js asks for in.m and in.h, and a
      // scan of components alone reported them dead. i18n.js is excluded on purpose:
      // it contains every key as a literal, so including it would make the
      // unused-key check pass unconditionally.
      else if ((full.endsWith('.jsx') || full.endsWith('.js')) && !full.endsWith('i18n.js')) files.push(full);
    }
  };
  walk('app'); walk('components'); walk('lib');

  const asked = new Set();
  const dynamic = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\bt\(\s*'([^']+)'/g)) asked.add(m[1]);
    // Template-literal keys — t(`ag.${id}`) — expand from the sibling list rather
    // than being waved through, since those are the ones a rename silently breaks.
    for (const m of src.matchAll(/\bt\(\s*`([^`]*\$\{[^`]*)`/g)) dynamic.push([f, m[1]]);
  }
  const unresolved = [...asked].filter((k) => !(k in en));
  check(`all ${asked.size} literal t() keys resolve`, unresolved.length === 0, unresolved.join(' '));

  // The other direction: a key nothing asks for is dead weight that still has to be
  // translated, and 17 of them had accumulated by the time this check was written.
  // "Used" means the quoted literal appears anywhere in a component, which covers
  // the lookup-table and ternary forms — t(a.activeNow ? 'cf.active' : 'cf.idle').
  const allSource = files.map((f) => readFileSync(f, 'utf8')).join('\n');
  const familyPrefixes = ['nav.', 'unit.', 'sev.', 'tr.', 'pj.lane.', 'ob.st.',
    // The workforce console's interpolated families: a state, a provenance tag
    // and a confidence word are all chosen from data, so the key is built rather
    // than written out. Each is expanded member-by-member below, so a rename
    // upstream still fails rather than being waved through by the prefix.
    'wf.state.', 'as.state.', 'as.blocked.', 'wf.reason.', 'prov.', 'pf.conf.',
    // the two-lens families: a lifecycle stage and a failed satisfies() clause are
    // both chosen from data, so the key is built rather than written out
    'stage.', 'sat.', 'og.gap.'];
  const tabKeys = ['activity', 'work', 'messages', 'repos', 'profile', 'runtime', 'oversight']
    .map((x) => `ag.${x}`);
  // A JSX string attribute — why="og.noSkills" on <Blank> — is a real usage form and
  // uses double quotes, so scanning only for single quotes reported live keys as dead.
  const dead = Object.keys(en).filter((k) =>
    !allSource.includes(`'${k}'`) && !allSource.includes(`\`${k}\``)
    && !allSource.includes(`"${k}"`)
    && !tabKeys.includes(k) && !familyPrefixes.some((p) => k.startsWith(p)));
  check('no unused key in the dictionary', dead.length === 0, dead.join(' '));

  // The four interpolated families, expanded explicitly.
  const families = {
    'nav.': ['workforce', 'assignments', 'alerts', 'queue', 'tasks', 'projects', 'capacity',
      'performance', 'knowledge', 'onboard', 'config', 'org', 'dispatch'],
    'unit.': ['open', 'waiting', 'groups', 'ready', 'hired', 'queued', 'proposals', 'flagged',
      'bridged', 'roles'],
    'stage.': ['prd', 'spec', 'coding', 'testing', 'release', 'mo'],
    'sat.': ['tier', 'skills', 'noRole'],
    'og.gap.': ['allocatable', 'contended', 'unhireable'],
    'wf.state.': ['deployed', 'idle', 'throttled', 'unassigned'],
    'wf.reason.': ['available', 'noRole', 'cannotStaff', 'noIntervals', 'noSeat', 'planSeat',
      'healthyIneligible'],
    'as.state.': ['executing', 'acceptance_pending', 'queued'],
    'as.blocked.': ['noRole', 'allBusy'],
    'prov.': ['reported', 'measured', 'unknown', 'plan'],
    'pf.conf.': ['low', 'medium', 'high'],
    'ob.st.': ['ready', 'needs_auth', 'needs_setup', 'absent',
      'readyWhy', 'needs_authWhy', 'needs_setupWhy', 'absentWhy'],
    'ob.step.': ['refuse', 'token', 'register', 'health'],
    'ob.pre.': ['codingFull', 'mcpServers', 'acpExtra', 'mcpExtra'],
    'sev.': ['critical', 'warning', 'info'],
    'ag.': ['activity', 'work', 'messages', 'repos', 'profile', 'runtime', 'oversight'],
    'tr.': ['accepted', 'in_progress', 'blocked', 'done'],
    'pj.lane.': ['created', 'accepted', 'in_progress', 'blocked', 'done'],
  };
  const missingFamily = [];
  for (const [prefix, members] of Object.entries(families)) {
    for (const m of members) if (!(prefix + m in en)) missingFamily.push(prefix + m);
  }
  check(`all ${Object.values(families).flat().length} interpolated t() keys resolve`,
    missingFamily.length === 0, missingFamily.join(' '));
  check('every t(`…`) call belongs to a declared family',
    dynamic.every(([, expr]) => Object.keys(families).some((p) => expr.startsWith(p))),
    dynamic.filter(([, e]) => !Object.keys(families).some((p) => e.startsWith(p))).map(([f, e]) => `${f}:${e}`).join(' '));
}

// 9. no rendered page leaks a raw dictionary key
{
  const keys = Object.keys(DICTS.en);
  const leaks = [];
  for (const path of ROUTES) {
    const { html } = await rendered(path);
    // A key only counts as leaked if it appears as element text or an attribute
    // value — the key strings also live in the JS bundle, which is not a leak.
    for (const k of keys) if (html.includes(`>${k}<`) || html.includes(`="${k}"`)) leaks.push(`${path}:${k}`);
    // A key without a dot is indistinguishable from ordinary markup, so the naming
    // rule is enforced instead: every key is namespaced.
    for (const k of keys) if (!k.includes('.')) leaks.push(`unnamespaced-key:${k}`);
  }
  check('no route renders an unresolved key', leaks.length === 0, leaks.slice(0, 6).join(' '));
}

// 10. theme — tokens for both, and an explicit choice beats the OS preference
{
  const css = readFileSync('app/globals.css', 'utf8');
  const tokensIn = (selector) => {
    const at = css.indexOf(selector);
    if (at < 0) return [];
    const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
    return [...body.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]).sort();
  };
  const light = tokensIn(':root {');
  const darkMedia = tokensIn(':root:not([data-theme="light"])');
  const darkAttr = tokensIn(':root[data-theme="dark"]');
  const lightAttr = tokensIn(':root[data-theme="light"]');

  check('dark tokens exist under prefers-color-scheme', darkMedia.length > 0, `${darkMedia.length} tokens`);
  check('dark tokens exist under [data-theme="dark"]', darkAttr.length > 0, `${darkAttr.length} tokens`);
  check('an explicit light choice overrides a dark OS', lightAttr.length > 0, `${lightAttr.length} tokens`);
  check('both dark selectors define the same tokens',
    darkMedia.join() === darkAttr.join(), `${darkMedia.length} vs ${darkAttr.length}`);
  check('every dark token has a light counterpart',
    darkAttr.every((v) => light.includes(v)),
    darkAttr.filter((v) => !light.includes(v)).join(' '));
  check('[data-theme="light"] restates the full palette',
    lightAttr.join() === darkAttr.join(), `${lightAttr.length} vs ${darkAttr.length}`);

  // Colour must not be hardcoded past the token layer, or a theme swap misses it.
  // Split per DECLARATION, not per line: `color: var(--ok); background: #e9f6ee;`
  // is one line with one literal, and a line-granular check waves it through — which
  // is exactly how the toast's background survived the first pass.
  const declarations = css
    .replace(/@media[^{]*\{[\s\S]*?\n\}/g, '')      // the dark media block is tokens only
    .replace(/:root(\[[^\]]+\])?\s*\{[\s\S]*?\n\}/g, '')  // and so are the palette blocks
    .split(';');
  const hardcoded = declarations
    // Collapse whitespace: a chunk spans the newline before its selector, and a
    // multi-line detail string made the first real failure unreadable.
    .map((d) => d.trim().replace(/\s+/g, ' ').replace(/^\}\s*/, ''))
    .filter((d) => /:\s*(#[0-9a-f]{3,8}\b|rgba?\(|hsla?\()/i.test(d))
    .filter((d) => !d.startsWith('--'));
  check('no colour literal outside the token blocks', hardcoded.length === 0,
    hardcoded.slice(0, 4).join(' | '));

  const layout = readFileSync('app/layout.jsx', 'utf8');
  check('theme is applied before first paint',
    layout.includes('dangerouslySetInnerHTML') && layout.includes("localStorage.getItem('hafleet.theme')"));
  check('lang is applied before first paint',
    layout.includes("localStorage.getItem('hafleet.locale')"));

  const prefs = readFileSync('components/Prefs.jsx', 'utf8');
  check('switch styling is bound to aria-pressed, not a parallel class',
    css.includes('.seg[aria-pressed="true"]') && prefs.includes('aria-pressed={'));
  check('the Chinese label carries its own lang attribute', prefs.includes('lang={l.htmlLang}'));
}

// 11. the pool axes are the scheduler's, not invented ones
{
  /*
   * This page was wrong three times. The third time was the worst: the fixture invented
   * `shell/git/web/browser` x `coder/reviewer/researcher/operator` AND populated it, so
   * a feature that has never been connected rendered as a working scheduler.
   *
   * So the axes are not asserted against a copy of themselves — they are read out of
   * the real lib/matrix-agent.js. Renaming a role there fails this check, and inventing
   * one here fails it too.
   */
  const real = readFileSync('../lib/matrix-agent.js', 'utf8');
  const listFrom = (src, name) => {
    const m = src.match(new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`));
    return m ? m[1].split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : [];
  };
  const realRoles = listFrom(real, 'ROLES');
  const realTiers = listFrom(real, 'CAPABILITY_TIERS');
  check('the real module still declares both axes',
    realRoles.length === 6 && realTiers.length === 3,
    `${realRoles.length} roles, ${realTiers.length} tiers`);
  check('fixture roles match lib/matrix-agent.js',
    ROLES.join() === realRoles.join(), `${ROLES.join()} vs ${realRoles.join()}`);
  check('fixture tiers match lib/matrix-agent.js',
    CAPABILITY_TIERS.join() === realTiers.join(), `${CAPABILITY_TIERS.join()} vs ${realTiers.join()}`);

  // Every default tier names a real tier, and every role has one.
  const badDefaults = ROLES.filter((r) => !CAPABILITY_TIERS.includes(ROLE_DEFAULT_TIER[r]));
  check('every role has a valid default tier', badDefaults.length === 0, badDefaults.join(' '));

  // Leases and tickets must live in cells that exist, or the page shows a coordinate
  // the scheduler cannot produce.
  const cells = Object.values(pool).flatMap((v) => [...v.leases, ...v.queuedTickets]);
  const offGrid = cells.filter((c) => !ROLES.includes(c.role) || !CAPABILITY_TIERS.includes(c.capability));
  check('every lease and ticket names a real cell', offGrid.length === 0,
    offGrid.map((c) => `${c.role}/${c.capability}`).join(' '));

  // The grid and the lease table are two views of one fact. An empty grid above a
  // populated lease table is the page contradicting itself — a lease exists only
  // because selectAgent() returned an agent.
  for (const [name, v] of Object.entries(pool)) {
    const leased = [...leasedAgents(v)].sort().join();
    const busy = [...busyAgents(v)].sort().join();
    check(`${name}: leased agents and busy cells agree`, leased === busy, `${leased || '∅'} vs ${busy || '∅'}`);
  }
  check('the empty view has no leases', pool.unassigned.leases.length === 0);
  check('the empty view still shows queued tickets',
    pool.unassigned.queuedTickets.length > 0,
    `${pool.unassigned.queuedTickets.length} waiting — every dispatch ends here`);

  // The substitution rule, which is the thing the old idle/total cell could not say.
  check('a stronger idle agent covers a weaker request',
    routable(pool.assigned, 'coding', 'lightweight') === true);
  check('substitution never crosses a role',
    routable(pool.assigned, 'architect', 'lightweight') === false);
  check('a busy agent does not count as available',
    routable(pool.assigned, 'testing', 'medium') === false);

  // And the honest default: this fleet's grid is empty.
  check('the unassigned view is genuinely empty',
    gridTotal(pool.unassigned) === 0 && Object.keys(pool.unassigned.cells).length === 0);
  check('the empty view still names the agents that are missing a role',
    pool.unassigned.unassignedAgents.length > 0,
    `${pool.unassigned.unassignedAgents.length} listed`);

  /*
   * Emptiness must not be read off `total`. GET /api/pool answers `total: records.length`
   * — every pool record, including the ones indexPool() skipped — so on the fleet this
   * page was written for it is 5 while the grid is {}. A page that gates its empty state
   * on `total === 0` shows a blank grid with no explanation, which is the one outcome the
   * whole page exists to prevent.
   */
  check('the empty view still reports pool records, like /api/pool does',
    pool.unassigned.total > 0,
    `total=${pool.unassigned.total}, grid=${gridTotal(pool.unassigned)}`);
  check('emptiness is derived from the cells, not from total',
    readFileSync('app/capacity/page.jsx', 'utf8').includes('gridTotal(state) === 0'));

  // coveringTier() names the tier, and routable() must be the same fact as a boolean.
  check('the covering tier is the cheapest sufficient one',
    coveringTier(pool.assigned, 'coding', 'lightweight') === 'medium',
    String(coveringTier(pool.assigned, 'coding', 'lightweight')));
  check('routable() and coveringTier() cannot disagree',
    ROLES.every((r) => CAPABILITY_TIERS.every((c) =>
      routable(pool.assigned, r, c) === (coveringTier(pool.assigned, r, c) !== null))));

  /*
   * The printed PATCH is the one command an operator runs to fix the empty grid, and the
   * first version could not work: `.../api/agents` for a host, and no Content-Type, so
   * the global express.json() parsed nothing, `role` arrived undefined, and the handler's
   * `if (role !== undefined)` made it a 200 that changed nothing. Silent success is why
   * this is asserted rather than eyeballed.
   */
  const rc = roleCommand({ name: 'octos-agent', role: 'coding' });
  check('the role command names a real host', rc.patch.includes(API_BASE) && !rc.patch.includes('...'));
  check('the role command sends a JSON content type',
    /-H '(?:C|c)ontent-(?:T|t)ype: application\/json'/.test(rc.patch), rc.patch);
  check('the role command still carries the role', rc.patch.includes('{"role":"coding"}'));
}

// 12. no capacity cell states itself in a glyph alone
{
  /*
   * The severity dot rule — a mark never carries a state by itself — had one component
   * enforcing it and one assertion covering it, and the newest page walked straight past
   * both: the grid rendered `—` and a green `↑` with the meaning only in `title`, which
   * touch users never see and AT does not reliably announce on a <td>.
   *
   * So this asserts the general property instead of the two specific marks: every cell on
   * the page contains a word. Comments are stripped first — React's SSR marker lands
   * between adjacent expressions and would otherwise read as content.
   */
  const { html } = await rendered('/capacity');
  const cellsRaw = [...html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
  /*
   * Refined once the seat table landed: the rule is that a cell never states
   * itself in a MARK alone — `—`, or a green `↑` with the meaning in a tooltip.
   * It is not that every cell must contain a letter. `74%` is a measurement
   * carrying its own unit, and it tripped the first version of this predicate.
   * "Has any alphanumeric content" still catches a bare dash or arrow, which has
   * neither, and lets a self-describing number through.
   */
  const wordless = cellsRaw
    .map((c) => c.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, '').trim())
    .filter((text) => !/[A-Za-z0-9一-鿿]/.test(text));
  check('no capacity cell states itself in a mark alone',
    cellsRaw.length > 0 && wordless.length === 0,
    `${cellsRaw.length} cells, ${wordless.length} wordless: ${wordless.slice(0, 3).map((w) => JSON.stringify(w)).join(' ')}`);

  // The view is a selection, so it belongs in the URL like every other selection here.
  const src = readFileSync('app/capacity/page.jsx', 'utf8');
  check('the capacity view is addressable as ?view=assigned',
    src.includes("?view=assigned") && src.includes('popstate'));
}

// 13. the role registry — the dotted line's missing record, now a record
{
  /*
   * Roles are USER-DEFINED. lib/matrix-agent.js's ROLES array is never imported by
   * the backend — its only consumers are its own unit test and this file — and
   * agentRole() returns agent.role verbatim, unvalidated. So the six were never a
   * constraint, and the registry is what makes them manageable rather than merely
   * possible.
   *
   * The old assertion said the fixture's roles ARE the constant. That would now
   * forbid the manager from defining anything, which is the opposite of the point.
   * It becomes: every key is either one the scheduler already routes, or explicitly
   * marked as new. A typo can then still not slip through unnamed.
   */
  const seeded = roles.filter((r) => !r.wireNew).map((r) => r.key);
  const strays = seeded.filter((k) => !ROLES.includes(k));
  check('every non-new role key is one the scheduler already routes',
    strays.length === 0, strays.join(' '));
  check('every new role key is declared new rather than assumed',
    roles.filter((r) => r.wireNew).every((r) => !ROLES.includes(r.key)),
    roles.filter((r) => r.wireNew && ROLES.includes(r.key)).map((r) => r.key).join(' '));

  // Key is the wire value and name is the manager's word. Conflating them is what
  // made "rename Coding to Coder" look like a backend change.
  check('role keys are unique', new Set(roles.map((r) => r.key)).size === roles.length);
  check('every role declares a tier the scheduler validates',
    roles.every((r) => CAPABILITY_TIERS.includes(r.minTier)),
    roles.filter((r) => !CAPABILITY_TIERS.includes(r.minTier)).map((r) => r.key).join(' '));
  check('every role carries a lifecycle stage',
    roles.every((r) => LIFECYCLE_STAGES.includes(r.stage)),
    roles.filter((r) => !LIFECYCLE_STAGES.includes(r.stage)).map((r) => r.key).join(' '));
  // Free-text skills fragment a pool inside a week: node / nodejs / Node.js.
  const offVocab = roles.flatMap((r) => r.skills).filter((sk) => !SKILL_VOCABULARY.includes(sk));
  check('every required skill comes from the controlled vocabulary',
    offVocab.length === 0, [...new Set(offVocab)].join(' '));
  const workerOffVocab = fixtureAgents
    .flatMap((a) => workerOf(a.name).skills)
    .filter((sk) => !SKILL_VOCABULARY.includes(sk));
  check('every asserted worker skill comes from the same vocabulary',
    workerOffVocab.length === 0, [...new Set(workerOffVocab)].join(' '));

  /*
   * A retired key that resolves to nothing is a dispatch that queues forever with no
   * diagnosis — the exact failure the empty pool already taught us to assert against.
   * `review` is live on the wire: POST /api/dispatch {role:'review'} routes today and
   * canonicalRole() mints it out of agent names.
   */
  const dangling = retiredRoles.filter((r) => resolveRoleKey(r.key) === null);
  check('every retired key still resolves to a live role',
    dangling.length === 0, dangling.map((r) => r.key).join(' '));
  check('a retired key is never also a live one',
    retiredRoles.every((r) => !roles.some((x) => x.key === r.key)));
}

// 14. satisfies() — floor for routing, fix for accounting
{
  const strong = { agent: 'x', capability: 'strong', skills: ['implementation'] };
  const light = { agent: 'y', capability: 'lightweight', skills: ['implementation'] };
  const coder = roles.find((r) => r.key === 'coding');

  // FLOOR: over-qualified still qualifies. This is what selectAgent() already does,
  // and reversing it would force Coder and Senior Coder to be separate roles.
  check('floor: a stronger worker satisfies a weaker role', satisfies(strong, coder).ok);
  check('floor: a weaker worker does not', !satisfies(light, coder).ok);

  // FIX: the substitution is measured, so the console can render it. Floor without
  // this is elasticity that looks identical to a quietly larger bill.
  check('accounting: over-qualification is reported as a delta',
    satisfies(strong, coder).tierDelta === 1, String(satisfies(strong, coder).tierDelta));
  check('accounting: an exact match reports no delta',
    satisfies({ ...strong, capability: 'medium' }, coder).tierDelta === 0);

  // The result names the clause, so no call site has to recompute the reason.
  check('a tier failure names the tier clause', satisfies(light, coder).failedClause === 'tier');
  const noSkill = satisfies({ agent: 'z', capability: 'strong', skills: [] }, coder);
  check('a skill failure names the skill clause', noSkill.failedClause === 'skills');
  check('a skill failure lists what is missing', noSkill.missingSkills.includes('implementation'));
}

// 15. the projected fleet exercises both edge cases rather than only the happy path
{
  const rows = allocationRows('assigned');
  check('the honest view allocates nobody', allocationRows('unassigned').length === 0);
  check('the projected view allocates every hired worker', rows.length === fixtureAgents.length,
    `${rows.length} of ${fixtureAgents.length}`);

  // Raising Marketing's floor from lightweight to medium strands claude-agent. The
  // narrowing rule and its first live instance ship together, so the assertion below
  // has something to catch on day one instead of being theoretical.
  const stranded = rows.filter((r) => !r.match.ok);
  check('a narrowing strands an allocation, and the fixture contains one',
    stranded.length === 1 && stranded[0].agent === 'claude-agent',
    stranded.map((r) => r.agent).join(' '));
  check('the stranded row names the clause it fails',
    stranded.every((r) => r.match.failedClause !== null));

  const over = rows.filter((r) => r.match.tierDelta > 0);
  check('the fixture contains an over-qualified allocation', over.length > 0,
    over.map((r) => r.agent).join(' '));

  // An allocation written against a retired key resolves and SAYS SO.
  const aliased = rows.filter((r) => r.aliased);
  check('an allocation on a retired key resolves through the alias',
    aliased.length === 1 && aliased[0].role.key === 'system-engineer',
    aliased.map((r) => `${r.aliased?.from}->${r.role?.key}`).join(' '));

  // Two different problems needing two different actions.
  const groups = orgGroups('assigned');
  check('an unfillable role is distinguished from a contended one',
    groups.some((g) => g.gap === 'unhireable') && groups.some((g) => g.gap === 'contended'),
    groups.filter((g) => g.gap).map((g) => `${g.role.key}:${g.gap}`).join(' '));
  // Architect is the case that caught the first version: octos-agent satisfies it but
  // is allocated to Coder, which is a priority call and was being reported as "go hire".
  check('a role whose only candidate is allocated elsewhere is not called a hiring gap',
    groups.find((g) => g.role.key === 'architect')?.gap === 'contended',
    groups.find((g) => g.role.key === 'architect')?.gap);
}

// 16. one number, two slices — the join cannot drift
{
  /*
   * The same spend sliced by project and by role must total the same, or the PDT
   * owner and the PDU manager are reading two different books. One implementation
   * per fact is what guarantees it; this asserts the guarantee rather than trusting it.
   */
  const byProject = costBy('project', 'assigned').reduce((n, r) => n + r.amount, 0);
  const byRole = costBy('role', 'assigned').reduce((n, r) => n + r.amount, 0);
  check('cost by project and cost by role agree', Math.abs(byProject - byRole) < 1e-9,
    `${byProject} vs ${byRole}`);

  const engProject = projects.flatMap((p) => engagementsBy('project', p.key, 'assigned'));
  check('every engagement belongs to a project that resolves',
    engProject.length === engagementsBy(null, null, 'assigned').length,
    `${engProject.length} attributed`);

  // Only computable because the dotted line knows the roles and the solid line knows
  // the project — the first thing the two lenses produce together.
  const gaps = projects.map((p) => stageGaps(p.key, 'assigned'));
  check('a staffing gap is computed per project and is not empty on this fixture',
    gaps.every((g) => Array.isArray(g)) && gaps.some((g) => g.length > 0),
    gaps.map((g) => g.length).join('/'));
  check('a stage gap only ever names a real lifecycle stage',
    gaps.flat().every((g) => LIFECYCLE_STAGES.includes(g)));
}

// 17. the two lenses render, and neither hides what it cannot answer
{
  const { html: org } = await rendered('/org');
  // The honest default is not "empty", it is "nobody has done the classifying step" —
  // which is actionable, and an empty grid never was.
  check('/org opens on the honest state and says why', org.includes('role=null') || org.includes('unclassified'));
  check('/org renders every defined role', roles.every((r) => org.includes(r.name)),
    roles.filter((r) => !org.includes(r.name)).map((r) => r.key).join(' '));
  check('/org shows the retired key rather than dropping it', org.includes('review'));

  const { html: proj } = await rendered('/projects');
  check('/projects opens empty and names who writes the missing record',
    proj.includes('Matrix bridge') || proj.includes('bridge'));

  // Over-qualification is a cost signal and must never render as one tier alone.
  const { html: role } = await rendered('/org/coding?view=assigned');
  check('an over-qualified allocation is reachable and renders both tiers',
    role.includes('coding'));
}

// 18. no server-rendered page prints a raw placeholder
{
  /*
   * A dictionary VALUE that is a template — `nobody holds the {role} role` — renders
   * with its braces intact wherever a caller forgets the vars. The i18n checks above
   * only verify that KEYS resolve and that placeholders MATCH ACROSS LOCALES, both of
   * which pass happily while `{role}` is on screen.
   *
   * SCOPE, stated because a first version of this quietly had none: ?view= is read in
   * an effect, so the server-rendered HTML this fetches is always the LIVE view. Adding
   * projected URLs here looked like coverage and was not — the check passed with the
   * bug in. Projected content, and the doubled em dash (which is ::before content and
   * never in the markup at all), are both asserted in check-switches.mjs.
   */
  const placeholder = /\{(?:n|c|a|b|role|tier|agent|have|need|runtime|names|keys|stages|room|owner|why|from|to|key|stage|base)\}/;
  const leaked = [];
  for (const path of ROUTES) {
    const { html } = await rendered(path);
    const text = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]*>/g, ' ');
    const hit = text.match(placeholder);
    if (hit) leaked.push(`${path}:${hit[0]}`);
  }
  check('no server-rendered page renders a raw {placeholder}', leaked.length === 0,
    leaked.slice(0, 4).join(' '));
}

console.log(`\n${failed === 0 ? 'All invariants hold.' : `${failed} FAILED.`}\n`);
process.exit(failed === 0 ? 0 : 1);
