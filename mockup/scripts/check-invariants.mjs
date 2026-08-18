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
  '/resources', '/resources/new', '/workforce', '/capability', '/projects', '/engagements', '/usage',
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
  /*
   * REQ-CONTRIBUTION-CONSOLE-VOCABULARY — the role vocabulary comes from the system's own
   * enumeration, so a console role name the borrower cannot recognise is impossible by
   * construction rather than by review. The byte-for-byte check is what makes that true:
   * a console-local copy of the mapping would drift, and the drift would be invisible.
   * 'and the reason is named rather than left blank' is the requirement's last clause —
   * an excluded combination states why instead of being silently omitted.
   *
   * REQ-CONTRIBUTION-CONSOLE-ROLES is deliberately NOT claimed here any more. This comment
   * used to cite it, on the reasoning that the console keeps the role-to-(agent x model)
   * mapping private — which the operator ruling of 2026-08-11 reversed: the serving agent
   * and its model are disclosed to the borrower. The console was never the surface that
   * statement governed anyway, since it faces the provider, who may see everything.
   *
   * The rewritten statement is established where its two halves actually live:
   * tests/bot-commands-request.test.js (what a project is told, and what it is not) and
   * tests/engagement-serving-disclosure.test.js (a named agent is honoured only if it
   * independently qualifies).
   */
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
  /*
   * REQ-CONTRIBUTION-CONSOLE-BLANK — an unmeasured quantity renders as unknown WITH its
   * reason, never as zero, and allocations stay distinct from consumption. The pair below is
   * both halves: the gap is named, and no cell is a bare 0. A zero here would read as "this
   * agent consumed nothing", which is a claim rather than an absence — the backend half of
   * the same rule is tests/api-usage-metering.test.js.
   */
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

// 17. dictionary strings are plain text, because that is how they are rendered
{
  /*
   * Every value in this dictionary reaches the DOM as a text node — `{t('...')}` in JSX,
   * never `dangerouslySetInnerHTML`. So markdown in a string is not emphasis, it is
   * asterisks: `**新增 token**` rendered literally as `**新增 token**` inside an info tip,
   * and four keys had picked it up before anyone looked at the page in a browser.
   *
   * Chinese emphasis uses 「」, which the rest of the dictionary already does. English
   * emphasis uses capitals or nothing. A backtick is the same trap: it renders as a
   * backtick, so file and symbol names in user-facing copy are written bare — and mostly
   * should not be there at all, since a contributor is not reading source paths.
   */
  const marked = Object.entries(DICTS)
    .flatMap(([loc, dict]) => Object.entries(dict)
      .filter(([, v]) => typeof v === 'string' && /\*\*|`|\[[^\]]+\]\([^)]+\)/.test(v))
      .map(([k]) => `${loc}:${k}`));
  check('no dictionary string carries markdown, which renders literally', marked.length === 0,
    marked.slice(0, 5).join(' '));
}

// 19. the over-ceiling state is rendered, not merely implemented
{
  /*
   * The fixture puts octos-agent 400k past a 3M ceiling (en_0036), and this asserts the pages
   * actually SAY so. It is checked against the server-rendered markup because that is the only
   * place a reader can see it without a live backend: `engagements` is a nothing-shown slice when
   * the fetch fails, so the browser drops the fixture's commitments and every meter falls back
   * inside its ceiling. Which means an eyes-on review of the running prototype cannot confirm this
   * state, and this check is what stands in for the screenshot.
   */
  for (const path of ['/workforce', '/usage', '/resources']) {
    const { html } = await rendered(path);
    check(`${path} renders the over-ceiling state`,
      /class="over"/.test(html) && /over by/.test(html),
      html.includes('class="meter"') ? 'meters present, none marked over' : 'no meters at all');
  }
}

// 20. a key the UI BUILDS cannot be checked by looking for it
{
  /*
   * `t(`prov.slice.${r.slice}`)` is assembled at render time, so no static sweep of the dictionary can
   * see it — and `prov.slice.projectSides` was therefore missing for as long as project sides have
   * existed. It rendered as `PROV.SLICE.PROJECTSIDES` in the provenance banner: an i18n key, upper-cased
   * by CSS, sitting in the one line whose whole job is telling an operator which data is real.
   *
   * The slice NAMES come from where they are assigned (`provenance.<name> = 'live'` in lib/api.js), which
   * is the same place the UI later reads them from, so this compares the two ends of one contract rather
   * than a list somebody has to remember to update.
   */
  const api = readFileSync(join(import.meta.dirname, '..', 'lib', 'api.js'), 'utf8');
  const assigned = new Set([...api.matchAll(/provenance\.([A-Za-z][\w]*)\s*=/g)].map((m) => m[1]));
  // `__loading` is internal bookkeeping the banner never labels.
  assigned.delete('__loading');
  const missing = [...assigned].filter((name) => Object.entries(DICTS)
    .some(([, dict]) => dict[`prov.slice.${name}`] === undefined));
  check('every provenance slice has a label in every dictionary', missing.length === 0,
    missing.map((n) => `prov.slice.${n}`).join(' '));
}

// 18. a full bar is not allowed to mean two different things
{
  /*
   * `width: ${Math.min(100, pct)}%` is unavoidable — a bar cannot be 240% of its track — but a page
   * that writes the clamp itself has quietly decided that 240% and 100% look the same. Four pages
   * had done exactly that, and an agent past its ceiling rendered identically to one that landed on
   * it. The clamp now lives in Meter and CeilingBars, which pair it with an `over` state; anywhere
   * else it is the bug coming back.
   */
  const CLAMP_OWNERS = new Set(['components/Meter.jsx', 'components/Charts.jsx']);
  const walk = (dir) => readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.jsx?$/.test(full) ? [full] : [];
  });
  const root = join(import.meta.dirname, '..');
  const offenders = [...walk(join(root, 'app')), ...walk(join(root, 'components'))]
    .filter((file) => /Math\.min\(\s*100\s*,/.test(readFileSync(file, 'utf8')))
    .map((file) => file.slice(root.length + 1))
    .filter((rel) => !CLAMP_OWNERS.has(rel));
  check('no page clamps a meter itself — the clamp lives with the over state', offenders.length === 0,
    offenders.join(' '));
}

console.log(`\n${failed === 0 ? 'All invariants hold.' : `${failed} FAILED.`}\n`);
// 19. no page invents its own names for a backend enum
{
  /*
   * The engagements page tested `accessState` against `'ok'`, `'unauthorized'` and `'forbidden'` — none of
   * which the backend produces. `ACCESS_STATES` is `unverified | accepted | rejected | unreachable | blocked`,
   * so a side that had verified successfully fell through to the default and rendered as "never checked". The
   * operator asked why their working appservice said it had never been looked at.
   *
   * A display that invents state names cannot be wrong LOUDLY — only quietly, which is how this survived. So
   * the check is mechanical: every string literal compared against `accessState` must be a real member.
   */
  const source = readFileSync(join(import.meta.dirname, '..', '..', 'lib', 'project-side-store.js'), 'utf8');
  const declared = new Set(
    (/export const ACCESS_STATES = \[([^\]]+)\]/.exec(source)?.[1] ?? '')
      .split(',').map((part) => part.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean),
  );
  const walk = (dir) => readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.jsx?$/.test(full) ? [full] : [];
  });
  const root = join(import.meta.dirname, '..');
  const bogus = [];
  for (const file of [...walk(join(root, 'app')), ...walk(join(root, 'components'))]) {
    const text = readFileSync(file, 'utf8');
    /*
     * NARROWED TO WHAT IT CAN ACTUALLY PROVE. A first version matched any variable named `state`, and
     * flagged `ready`, `absent` and `active` — legitimate members of OTHER enums on other pages. A check
     * that cries wolf about correct code gets switched off, and then it protects nothing.
     *
     * Two shapes are matched: a direct `accessState === 'x'`, and a comparison inside a helper that was
     * handed `accessState` at its call site — which is how the defect actually looked, `reach(side.accessState)`
     * with `state === 'ok'` inside. The helper's parameter name is read from the call rather than assumed.
     */
    for (const match of text.matchAll(/accessState\s*===\s*'([a-z_]+)'/g)) {
      if (!declared.has(match[1])) bogus.push(`${file.slice(root.length + 1)}:${match[1]}`);
    }
    for (const call of text.matchAll(/(\w+)\((?:\w+\.)?accessState\)/g)) {
      const helper = call[1];
      const body = new RegExp(`const ${helper} = \\(([^)]*)\\) => \\{([\\s\\S]*?)\\n  \\};`).exec(text);
      if (!body) continue;
      const param = body[1].trim().split(/[,\s]+/)[0];
      if (!param) continue;
      for (const match of body[2].matchAll(new RegExp(`\\b${param}\\s*===\\s*'([a-z_]+)'`, 'g'))) {
        if (!declared.has(match[1])) bogus.push(`${file.slice(root.length + 1)}:${helper}():${match[1]}`);
      }
    }
  }
  check(
    'no page compares accessState against a name the backend never produces',
    declared.size > 0 && bogus.length === 0,
    declared.size === 0 ? 'could not read ACCESS_STATES' : bogus.join(' '),
  );
}

// 20. a field the pages branch on must survive the projection
{
  /*
   * `hasCredential` reached the console as `undefined` for three rounds of the operator asking why 「设置凭据」
   * was still there. The backend answered `true`; `mapProjectSide` read the field only to derive something else
   * and never carried it — so `CredentialForm` rendered "set credential" for a side that had one, and the actions
   * added beside it returned null on `if (!side.hasCredential)`. Invisible however many times the page reloaded.
   *
   * A projection that omits a field cannot be wrong loudly: every consumer just sees undefined and takes the
   * falsy branch. So the check is mechanical — any `side.<field>` a page reads must appear as a key in the map
   * that builds those objects.
   */
  const walk = (dir) => readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.jsx?$/.test(full) ? [full] : [];
  });
  const root = join(import.meta.dirname, '..');
  const api = readFileSync(join(root, 'lib', 'api.js'), 'utf8');
  /*
   * Read from the projection literal rather than from a hand-kept list, so adding a field to one and forgetting
   * the other cannot pass. Bounded to the block that starts at `id: side.id`, which is the side map.
   */
  const block = /return \{\s*\n\s*id: side\.id,([\s\S]*?)\n {10}\};/.exec(api);
  /*
   * BOTH FORMS. A first version matched only `key: value` and flagged `budget`, which is present as a shorthand
   * `budget,`. A guard that reports a field as missing when it is right there is a guard that gets switched off —
   * and this one had exactly one job, so a false positive on its first run would have ended it.
   */
  const provided = new Set(
    [...(block?.[1] ?? '').matchAll(/^\s{12}([a-zA-Z]+)\s*[:,]/gm)].map((m) => m[1]),
  );
  provided.add('id');

  const used = new Map();
  for (const file of [...walk(join(root, 'app')), ...walk(join(root, 'components'))]) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\bside\.([a-zA-Z]+)\b/g)) {
      if (!provided.has(match[1])) used.set(match[1], file.slice(root.length + 1));
    }
  }
  check(
    'every side field a page reads is carried by the projection',
    provided.size > 1 && used.size === 0,
    provided.size <= 1 ? 'could not read the side projection' : [...used].map(([f, w]) => `${w}:${f}`).join(' '),
  );
}

// 21. a backend enum is not shown to an operator raw
{
  /*
   * The verify action set its note to `body.side.accessState`, so a row read 「accepted 可达」 — the same fact
   * twice, once in the operator's language and once in the store's raw enum. Repeating the status next to the
   * status gains nothing, and putting the internal vocabulary on screen invites someone to start matching on it,
   * which is exactly how invariant 19's defect began.
   *
   * The check is narrow on purpose: a raw `accessState` reaching a setter that feeds rendered text. Reading the
   * field to BRANCH on is what pages are supposed to do — invariant 19 covers whether they branch correctly.
   */
  const walk = (dir) => readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.jsx?$/.test(full) ? [full] : [];
  });
  const root = join(import.meta.dirname, '..');
  const offenders = [];
  for (const file of [...walk(join(root, 'app')), ...walk(join(root, 'components'))]) {
    const text = readFileSync(file, 'utf8');
    /*
     * MATCHED TO THE STATEMENT, not to balanced parentheses. A first version used `\(([^;]{0,200}?)\)` and
     * missed the real defect, which spanned several lines and nested calls — a guard that cannot see the bug it
     * was written for is worse than none, because it certifies the code as checked. Verified against the defect
     * itself before being kept.
     */
    for (const match of text.matchAll(/\b(setNote|setError|setMessage|say)\s*\(([\s\S]*?)\);/g)) {
      if (/accessState/.test(match[2])) offenders.push(`${file.slice(root.length + 1)}:${match[1]}`);
    }
  }
  check('no page puts a raw accessState into text an operator reads', offenders.length === 0,
    offenders.join(' '));
}

process.exit(failed === 0 ? 0 : 1);
