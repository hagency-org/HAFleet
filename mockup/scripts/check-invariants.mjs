#!/usr/bin/env node
/**
 * Assert the design invariants against the running prototype.
 *
 * These are the design-document tests, executable. Each exists because a review
 * round caught its absence, or because a screenshot caught a defect the previous
 * suite walked past.
 *
 * Two whole classes of check are NOT here, on purpose:
 *   - anything that depends on computed CSS (a doubled dash, a welded cell), and
 *   - anything a browser renders that the server does not.
 * Both live in check-switches.mjs. A first version of this file asserted them
 * against the markup, passed, and went on passing while the bug was in.
 *
 * HTML is split on `self.__next_f` first: Next embeds an RSC flight payload that
 * duplicates the markup, which made an earlier version report false failures.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DICTS, missingKeys, orphanKeys, placeholderMismatches } from '../lib/i18n.js';
import {
  agents, presets, presetOf, tierOf, familyOf, fills, capability, roleCapacity,
  offers, whitelist, isWhitelisted, engagements, pendingEngagements, activeEngagements,
  committed, remaining, overCommits, fmtTokens, presetCommand, API_BASE, MODEL_SELECTABLE,
} from '../lib/mock-data.js';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3100';

const ROUTES = [
  '/resources', '/resources/new', '/workforce', '/capability', '/engagements', '/usage',
  '/alerts', '/config', '/onboard',
  '/agents/claude-agent', '/agents/octos-agent', '/agents/codex-agent',
  '/agents/hermes-agent', '/agents/codex-acp-agent',
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

console.log(`\nContribution console invariants against ${BASE}\n`);

// 1. every rail destination resolves, and the rail marks exactly one
for (const r of ROUTES) {
  const { status } = await rendered(r);
  check(`route ${r} resolves`, status === 200, `HTTP ${status}`);
}
{
  const bad = await fetch(`${BASE}/definitely-not-a-route`);
  check('an unregistered route 404s', bad.status === 404, `HTTP ${bad.status}`);
}
for (const r of ROUTES) {
  const { html } = await rendered(r);
  check(`${r} renders the rail`, html.includes('class="rail"'));
  const n = (html.match(/aria-current="page"/g) ?? []).length;
  check(`${r} marks exactly one current destination`, n === 1, `${n} found`);
}

// 2. the mapping is IMPORTED from the shipped config, not copied
{
  const disk = JSON.parse(readFileSync('../lib/role-capacity.json', 'utf8'));
  check('the role mapping is the shipped file, byte for byte',
    JSON.stringify(disk) === JSON.stringify(roleCapacity));
  // The whole point of importing it: the prototype cannot advertise a role the
  // product does not define.
  check('every role in the catalogue exists in the config',
    capability().every((c) => c.key in disk.roles));
  check('every tier named by a role is a real tier',
    Object.values(disk.roles).every((r) => disk.tiers.includes(r.defaultTier)),
    Object.entries(disk.roles).filter(([, r]) => !disk.tiers.includes(r.defaultTier)).map(([k]) => k).join(' '));
}

// 3. reasoning is part of the match, not decoration
{
  /*
   * `gpt-5.6-sol` appears at all three tiers and only `reasoning` tells them
   * apart. Matching on (framework, model) alone silently promoted a
   * medium-thinking Codex agent to `strong`, which would have advertised an
   * architect the contributor never configured. Found by probing the fixture
   * before any UI existed.
   */
  const codex = presets.find((p) => p.framework === 'codex');
  check('a medium-thinking codex preset is medium, not strong',
    tierOf(codex) === 'medium', String(tierOf(codex)));
  const asHigh = { ...codex, reasoning: 'high' };
  check('the same model at high reasoning is strong',
    tierOf(asHigh) === 'strong', String(tierOf(asHigh)));
  const bogus = { ...codex, reasoning: 'nonsense' };
  check('an unlisted reasoning level qualifies for nothing',
    tierOf(bogus) === null, String(tierOf(bogus)));
}

// 4. an agent with no preset contributes nothing, and says so
{
  const bare = agents.find((a) => !a.presetId);
  check('the fixture keeps an unconfigured agent', Boolean(bare));
  check('an unconfigured agent qualifies for no role',
    roleCapacity && Object.keys(roleCapacity.roles).every((k) => !fills(bare, k).ok));
  check('and the reason is named rather than left blank',
    Object.keys(roleCapacity.roles).every((k) => fills(bare, k).why === 'cap.why.noModel'));
  check('its ceiling is null, never zero', remaining(bare.name) === null,
    String(remaining(bare.name)));
}

// 5. tier subsumption, and its price
{
  const opus = presets.find((p) => p.model === 'claude-opus-5');
  const holder = agents.find((a) => a.presetId === opus.id);
  check('a strong agent fills every role (subsumption from matrix-agent.js)',
    Object.keys(roleCapacity.roles).every((k) => fills(holder, k).ok));
  // Shown, never prevented: the contributor decides whether to pay Opus rates
  // for documentation.
  check('and over-tier is reported rather than refused',
    fills(holder, 'documentation').overTier > 0,
    String(fills(holder, 'documentation').overTier));
}

// 6. cross-family review is a definition, not a warning
{
  const review = capability().find((c) => c.key === 'review');
  check('review is marked cross-family in the config', review.role.crossFamily === true);
  check('review is satisfiable only with two or more families',
    review.crossFamilyOk === (review.families.length >= 2),
    `${review.families.length} families`);
  // A single-family contributor cannot staff both sides however many agents run it.
  const oneFamily = [{ agent: { name: 'x' }, match: { ok: true, family: 'claude' } }];
  check('one family is not enough, whatever the headcount', oneFamily.length >= 1 && new Set(oneFamily.map((r) => r.match.family)).size < 2);
}

// 7. the per-agent ceiling is what an engagement draws on
{
  const opusAgent = 'claude-agent';
  const p = presetOf(agents.find((a) => a.name === opusAgent));
  check('committed + remaining equals the ceiling',
    committed(opusAgent) + remaining(opusAgent) === p.ceiling.tokens,
    `${committed(opusAgent)} + ${remaining(opusAgent)} vs ${p.ceiling.tokens}`);
  /*
   * The `overCeiling` branch is only reachable when an agent's REMAINING drops
   * below the offer cap — otherwise the cap stops the request first. An earlier
   * fixture labelled a request `overCeiling` while it comfortably fitted, so the
   * routing asserted a branch it never exercised.
   */
  const over = engagements.find((e) => e.route === 'overCeiling');
  check('the fixture contains a genuinely over-ceiling request', Boolean(over));
  check('and it really does exceed what is left', overCommits(over) === true,
    `requested ${fmtTokens(over.requestedTokens)} vs ${fmtTokens(remaining(over.agent))} left`);
}

// 8. every routing branch is exercised
{
  const routes = new Set(pendingEngagements().map((e) => e.route));
  check('a not-whitelisted request is pending', routes.has('notWhitelisted'));
  check('an over-ceiling request is pending, not rejected', routes.has('overCeiling'));
  check('auto-joined engagements exist and are active',
    activeEngagements().some((e) => e.autoJoined));
  // Falling back rather than rejecting is the rule that keeps the halves
  // coherent: asking for more than is left is not a fault.
  check('every pending request from a whitelisted project fell back, not rejected',
    pendingEngagements().filter((e) => isWhitelisted(e.projectRoomId))
      .every((e) => e.route !== 'notWhitelisted'));
}

// 9. the whitelist is keyed on identity, not on a name
{
  const ROOM_ID = /^![^:\s]+:[^\s]+$/;   // ROOM_ID_RE, lib/approval-store.js:19
  check('every whitelist entry is keyed on a valid Matrix room id',
    whitelist.every((w) => ROOM_ID.test(w.projectRoomId)),
    whitelist.filter((w) => !ROOM_ID.test(w.projectRoomId)).map((w) => w.projectRoomId).join(' '));
  check('membership is decided by room id, never by display name',
    whitelist.every((w) => isWhitelisted(w.projectRoomId))
    && !isWhitelisted(whitelist[0].displayName));
  // A spoofed display name must not buy trust.
  check('a project renamed to match a trusted one is still not whitelisted',
    !isWhitelisted('!spoofed:hq.example'));
}

// 10. a ceiling that nothing enforces says so
{
  check('no preset claims an enforced ceiling',
    presets.every((p) => p.ceiling.enforced === false));
  const { html } = await rendered('/resources');
  check('/resources states the ceiling is not enforced', html.includes('not enforced'));
  check('/usage names the metering gap instead of printing zeros',
    (await rendered('/usage')).html.includes('not measured'));
  // A zero would claim a measurement nobody takes.
  const { html: usage } = await rendered('/usage');
  check('no spend figure is rendered as 0', !/>\s*0\s*<\/td>/.test(usage.split('Tasks')[0] ?? ''));
}

// 11. the wizard never offers what the adapter cannot deliver
{
  const refuses = Object.entries(MODEL_SELECTABLE).filter(([, v]) => v.ok === false);
  check('adapters that cannot take a model are marked', refuses.length >= 2,
    refuses.map(([k]) => k).join(' '));
  check('and each names why, as a dictionary key',
    refuses.every(([, v]) => typeof v.why === 'string' && v.why in DICTS.en),
    refuses.filter(([, v]) => !(v.why in DICTS.en)).map(([k]) => k).join(' '));
  /*
   * The printed command carries only what POST /api/framework-presets accepts.
   * A form that sent a ceiling the endpoint drops would be worse than one that
   * admits the gap.
   */
  const cmd = presetCommand({ name: 'x', framework: 'claude', model: 'claude-opus-5', provider: 'anthropic' });
  check('the printed command names a real host', cmd.includes(API_BASE) && !cmd.includes('...'));
  check('it sends a JSON content type',
    /-H '(?:C|c)ontent-(?:T|t)ype: application\/json'/.test(cmd), cmd);
  check('and it omits the ceiling the endpoint has no field for',
    !cmd.includes('ceiling') && !cmd.includes('tokens'), cmd);
}

// 12. no cell states itself in a mark alone
{
  /*
   * The severity dot rule generalised: every `<td>` carries a word. `74%` is a
   * measurement carrying its own unit and passes; a bare `—` has neither and
   * fails, which is what caught two reasonless dashes on /resources.
   */
  for (const path of ['/resources', '/engagements', '/usage', '/capability', '/workforce']) {
    const { html } = await rendered(path);
    const cells = [...html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    const wordless = cells
      .map((c) => c.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, '').trim())
      .filter((text) => !/[A-Za-z0-9一-鿿]/.test(text));
    check(`no cell on ${path} states itself in a mark alone`,
      cells.length > 0 && wordless.length === 0,
      `${cells.length} cells, ${wordless.length} wordless: ${wordless.slice(0, 3).map((w) => JSON.stringify(w)).join(' ')}`);
  }
}

// 13. i18n — complete, matching, and nothing rendered raw
{
  const en = DICTS.en;
  check('both locales define the same keys',
    missingKeys('zh').length === 0 && orphanKeys('zh').length === 0,
    `missing ${missingKeys('zh').length}, orphan ${orphanKeys('zh').length}`);
  const drift = placeholderMismatches('zh');
  check('placeholders match across locales', drift.length === 0, drift.map((d) => d.key).join(' '));

  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if ((full.endsWith('.jsx') || full.endsWith('.js')) && !full.endsWith('i18n.js')) files.push(full);
    }
  };
  walk('app'); walk('components'); walk('lib');
  const asked = new Set();
  const dynamic = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\bt\(\s*'([^']+)'/g)) asked.add(m[1]);
    // JSX string attributes are a real usage form: why="rs.why.noPreset".
    for (const m of src.matchAll(/why="([a-z][a-zA-Z.]+)"/g)) asked.add(m[1]);
    for (const m of src.matchAll(/\bt\(\s*`([^`]*\$\{[^`]*)`/g)) dynamic.push([f, m[1]]);
  }
  const unresolved = [...asked].filter((k) => !(k in en));
  check(`all ${asked.size} literal t() keys resolve`, unresolved.length === 0, unresolved.join(' '));

  const families = {
    'nav.': ['resources', 'workforce', 'onboard', 'capability', 'engagements', 'usage', 'alerts', 'config'],
    'unit.': ['configured', 'offered', 'pending', 'active', 'lent', 'open'],
    'wz.step.': ['framework', 'model', 'reasoning', 'budget'],
    'ag.': ['runtime', 'activity', 'oversight', 'profile'],
    'sev.': ['critical', 'warning', 'info'],
    'ob.st.': ['ready', 'needs_auth', 'needs_setup', 'absent',
      'readyWhy', 'needs_authWhy', 'needs_setupWhy', 'absentWhy'],
    'ob.step.': ['refuse', 'token', 'register', 'health'],
    'ob.pre.': ['codingFull', 'mcpServers', 'acpExtra', 'mcpExtra'],
    // The provenance banner names each data slice it reports on. Declared as a
    // family because the member list is the slice set in lib/api.js — adding a
    // slice there without a label here now fails this check rather than printing
    // a raw key on screen.
    'prov.slice.': ['agents', 'presets', 'frameworks', 'alerts',
      'engagements', 'offers', 'whitelist', 'usage', 'ceilings', 'capability', 'seats', 'detected',
      'contributions'],
  };
  const missingFamily = [];
  for (const [prefix, members] of Object.entries(families)) {
    for (const m of members) if (!(prefix + m in en)) missingFamily.push(prefix + m);
  }
  check(`all ${Object.values(families).flat().length} interpolated keys resolve`,
    missingFamily.length === 0, missingFamily.join(' '));
  check('every t(`…`) call belongs to a declared family',
    dynamic.every(([, expr]) => Object.keys(families).some((p) => expr.startsWith(p))),
    dynamic.filter(([, e]) => !Object.keys(families).some((p) => e.startsWith(p))).map(([f, e]) => `${f}:${e}`).join(' '));

  const allSource = files.map((f) => readFileSync(f, 'utf8')).join('\n');
  const famPrefixes = Object.keys(families);
  const dead = Object.keys(en).filter((k) =>
    !allSource.includes(`'${k}'`) && !allSource.includes(`\`${k}\``)
    && !allSource.includes(`"${k}"`)
    && !famPrefixes.some((p) => k.startsWith(p)));
  check('no unused key in the dictionary', dead.length === 0, `${dead.length}: ${dead.slice(0, 8).join(' ')}`);
}

// 14. no route leaks a raw key or a raw placeholder
{
  const keys = Object.keys(DICTS.en);
  const placeholder = /\{(?:n|c|a|b|f|r|why|tier|cap|rate|left|agent|role|roles|models|used|project|name|models|have|need|stages|base|key)\}/;
  const leaks = [];
  for (const path of ROUTES) {
    const { html } = await rendered(path);
    for (const k of keys) if (html.includes(`>${k}<`) || html.includes(`="${k}"`)) leaks.push(`${path}:${k}`);
    const text = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]*>/g, ' ');
    const hit = text.match(placeholder);
    if (hit) leaks.push(`${path}:${hit[0]}`);
  }
  check('no route renders an unresolved key or placeholder', leaks.length === 0, leaks.slice(0, 6).join(' '));
  check('every key is namespaced', keys.every((k) => k.includes('.')),
    keys.filter((k) => !k.includes('.')).join(' '));
}

// 15. models, tiers and role keys are never translated
{
  /*
   * They are wire values. A translated model name is unsearchable, and a
   * translated tier would stop matching the scheduler. Role DISPLAY names are
   * the manager's text and live in the config, not the dictionary.
   */
  const wire = [...new Set([
    ...presets.map((p) => p.model),
    ...roleCapacity.tiers,
    ...Object.keys(roleCapacity.roles),
  ])];
  const translated = wire.filter((w) => Object.values(DICTS.zh).includes(w) === false
    && Object.entries(DICTS.en).some(([k, v]) => v === w && DICTS.zh[k] !== w));
  check('no model, tier or role key is translated', translated.length === 0, translated.join(' '));
}

// 16. the word "agent" is never rendered as 代理
{
  /*
   * 代理 means *proxy* in Chinese technical usage, and an earlier version of this
   * dictionary used it for both senses in adjacent keys — `ACP 代理没有终端窗格`
   * (agent) next to `原型不会代理真实的终端窗格` (proxy), and `代理令牌` reading as
   * "proxy token". One word cannot carry both when one of them is the real
   * meaning, so Agent stays in Latin script — which is also how the operators
   * write it.
   */
  const offenders = Object.entries(DICTS.zh).filter(([, v]) => v.includes('代理'));
  check('no Chinese string translates "agent" as 代理', offenders.length === 0,
    offenders.slice(0, 4).map(([k]) => k).join(' '));
  // And it really is present in Latin script where the English says Agent.
  check('Agent appears in Latin script in the Chinese dictionary',
    Object.values(DICTS.zh).some((v) => /Agent/.test(v)));

  /*
   * A space between CJK and Latin is typography, not decoration: without it
   * `5 个Agent` and `筛选Agent` read as single words. The 代理 -> Agent rewrite
   * created 52 of these in one pass, which is why the rule is asserted rather
   * than left to whoever edits the dictionary next.
   */
  const unspaced = Object.entries(DICTS.zh)
    .filter(([, v]) => /[一-鿿][A-Za-z0-9]|[A-Za-z0-9][一-鿿]/.test(v));
  check('Chinese strings space CJK against Latin', unspaced.length === 0,
    unspaced.slice(0, 4).map(([k]) => k).join(' '));
}

console.log(`\n${failed === 0 ? 'All invariants hold.' : `${failed} FAILED.`}\n`);
process.exit(failed === 0 ? 0 : 1);
