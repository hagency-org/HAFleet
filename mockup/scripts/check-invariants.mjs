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

const BASE = process.env.BASE ?? 'http://127.0.0.1:3100';

const ROUTES = [
  '/overview', '/alerts', '/queue', '/tasks', '/projects', '/capacity', '/onboard', '/config',
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
  const familyPrefixes = ['nav.', 'unit.', 'sev.', 'tr.', 'pj.lane.', 'ob.st.'];
  const tabKeys = ['activity', 'work', 'messages', 'repos', 'profile', 'runtime', 'oversight']
    .map((x) => `ag.${x}`);
  const dead = Object.keys(en).filter((k) =>
    !allSource.includes(`'${k}'`) && !allSource.includes(`\`${k}\``)
    && !tabKeys.includes(k) && !familyPrefixes.some((p) => k.startsWith(p)));
  check('no unused key in the dictionary', dead.length === 0, dead.join(' '));

  // The four interpolated families, expanded explicitly.
  const families = {
    'nav.': ['overview', 'alerts', 'queue', 'tasks', 'projects', 'capacity', 'onboard', 'config'],
    'unit.': ['open', 'waiting', 'groups', 'ready'],
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

console.log(`\n${failed === 0 ? 'All invariants hold.' : `${failed} FAILED.`}\n`);
process.exit(failed === 0 ? 0 : 1);
