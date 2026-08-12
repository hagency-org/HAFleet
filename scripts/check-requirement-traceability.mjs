#!/usr/bin/env node
/*
 * Which requirement statements are pinned by a named test, and which are only prose.
 *
 * WHY THIS EXISTS. `knowledge/requirements/` holds 68 statement-level MUSTs across five
 * documents. Two of them were cited by a test. The rest were asserted or not — nobody could
 * tell which without reading every test, and a requirement nothing verifies is a sentence,
 * not a guarantee. The lifecycle asks for traceability at statement level; this produces it.
 *
 * WHAT IT DOES NOT DO: it does not check that a citing test actually tests the requirement.
 * A citation is a claim by whoever wrote it. What this catches is the cheaper and more
 * common failure — the statement nobody ever came back to — plus the two mechanical errors
 * that make a coverage table lie:
 *
 *   PREFIX COLLISION. `REQ-X` matched inside `REQ-X-DURABLE` reports the parent as covered
 *   because a child is. The first pass of this survey made exactly that mistake and counted
 *   REQ-CONTRIBUTION-CONSOLE as covered; matching is on word boundary here.
 *
 *   CITING AN ID THAT DOES NOT EXIST. A test citing `REQ-CONTRIBUTION-CONSOLE-CEILING`
 *   when the statement is `-CEILING-SEAT` looks like coverage and is nothing. Unknown
 *   citations are reported as errors, not ignored.
 *
 * THE GATE IS A RATCHET, NOT A TARGET. Coverage may not fall below the recorded baseline.
 * Demanding 100% would push toward the empty citation — add the tag, ship the table, verify
 * nothing — which is worse than an honest 60% because it removes the signal.
 *
 *   node scripts/check-requirement-traceability.mjs           # report + gate
 *   node scripts/check-requirement-traceability.mjs --list     # every id and its tests
 *   node scripts/check-requirement-traceability.mjs --update   # re-record the baseline
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, basename } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const REQ_DIR = join(ROOT, 'knowledge/requirements');
const BASELINE = join(REQ_DIR, 'traceability-baseline.json');
/** Docs that describe the format rather than stating requirements. */
const NOT_REQUIREMENTS = new Set(['README.md', 'req-template.md']);
/** Where a citation may live. Tests are the point, but a checker script can pin one too. */
const SEARCH_DIRS = ['tests', 'mockup/scripts', 'scripts'];
const CITING_FILE = /\.(m?js|jsx|ts|tsx)$/;
/** This file. Its comments name example ids to explain the two failure modes. */
const SELF = 'scripts/check-requirement-traceability.mjs';
/**
 * Ids that look like citations but are not, with the reason each is allowed.
 *
 * An explicit list with a stated reason, rather than a pattern: a pattern broad enough to
 * cover these would also hide a genuine typo, which is the thing being looked for.
 */
const NOT_CITATIONS = new Map([
  ['REQ-DEMO', 'fixture data in tests/project-board.test.js and tests/project-inspector.test.js — '
    + 'a made-up id inside a synthetic spec file, not a claim about this repo'],
]);

const args = new Set(process.argv.slice(2));

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (CITING_FILE.test(name)) out.push(full);
  }
  return out;
}

/** Statement ids, declared as `[REQ-...]` at the head of a MUST. */
function collectStatements() {
  const byDoc = new Map();
  for (const name of readdirSync(REQ_DIR)) {
    if (!name.endsWith('.md') || NOT_REQUIREMENTS.has(name)) continue;
    const text = readFileSync(join(REQ_DIR, name), 'utf-8');
    const ids = [];
    for (const line of text.split('\n')) {
      for (const m of line.matchAll(/\[(REQ-[A-Z0-9-]+)\]/g)) {
        // A statement is cited in its own doc as a definition; elsewhere in the doc it may be
        // referenced again. First occurrence wins as the declaration site.
        if (!ids.includes(m[1])) ids.push(m[1]);
      }
    }
    if (ids.length) byDoc.set(name, ids);
  }
  return byDoc;
}

/**
 * Citations in code, keyed by id.
 *
 * The boundary is `[^A-Z0-9-]`, not `\b`: `\b` treats `-` as a boundary, so `REQ-X\b` would
 * match the `REQ-X` inside `REQ-X-DURABLE` and report a parent covered by its child.
 */
function collectCitations(ids) {
  const files = SEARCH_DIRS.flatMap((d) => walk(join(ROOT, d)));
  const cited = new Map(ids.map((id) => [id, []]));
  const unknown = new Map();
  const known = new Set(ids);

  for (const file of files) {
    const text = readFileSync(file, 'utf-8');
    if (!text.includes('REQ-')) continue;
    const rel = relative(ROOT, file);
    if (rel === SELF) continue;
    for (const m of text.matchAll(/REQ-[A-Z0-9-]*[A-Z0-9]/g)) {
      const id = m[0];
      if (known.has(id)) {
        if (!cited.get(id).includes(rel)) cited.get(id).push(rel);
      } else {
        // A doc-level id is a document name, not a statement — citing it is legitimate.
        if (!unknown.has(id)) unknown.set(id, []);
        if (!unknown.get(id).includes(rel)) unknown.get(id).push(rel);
      }
    }
  }
  return { cited, unknown };
}

/** Doc-level ids from frontmatter, which are names rather than statements. */
function docLevelIds() {
  const out = new Set();
  for (const name of readdirSync(REQ_DIR)) {
    if (!name.endsWith('.md') || NOT_REQUIREMENTS.has(name)) continue;
    for (const line of readFileSync(join(REQ_DIR, name), 'utf-8').split('\n')) {
      const m = /^id:\s*(REQ-[A-Z0-9-]+)\s*$/.exec(line.trim());
      if (m) out.add(m[1]);
    }
  }
  return out;
}

/*
 * THE OTHER HALF OF THE CHAIN.
 *
 * `specs/*.spec.md` binds scenarios to tests with `Test: <selector>`, and those selectors are
 * the only machine-readable link from a spec to a test. Ten of fifty-eight did not resolve
 * when this was first run, and the reason is worth recording because it is not the reason it
 * looks like: THE TESTS EXIST. Three project-board scenarios were consolidated into one
 * `it('groups tasks, graphs, and stale agent work deterministically')`, and one selector lost
 * its `project_board_` prefix in the test title.
 *
 * So a dangling selector here does not mean untested behavior — it means the chain cannot be
 * followed without reading everything, which is the entire point of having it. Reported
 * separately from statement coverage for that reason: the two say different things.
 */
function checkSelectors(testText) {
  const rows = [];
  for (const name of readdirSync(join(ROOT, 'specs'))) {
    if (!name.endsWith('.spec.md')) continue;
    const text = readFileSync(join(ROOT, 'specs', name), 'utf-8');
    for (const line of text.split('\n')) {
      const m = /^\s+Test:\s*(.+?)\s*$/.exec(line);
      if (!m) continue;
      const selector = m[1];
      // Both forms, because the repo uses both: snake_case selectors quoted verbatim inside a
      // test title, and natural-language titles written out in the spec.
      const resolves = testText.includes(selector)
        || testText.toLowerCase().includes(selector.replace(/_/g, ' ').toLowerCase());
      rows.push({ spec: name, selector, resolves });
    }
  }
  return rows;
}

const byDoc = collectStatements();
const allIds = [...byDoc.values()].flat();
const { cited, unknown } = collectCitations(allIds);
const docIds = docLevelIds();

/*
 * Unknown citations that are neither a doc-level id (legitimate: a document name), nor a
 * declared non-citation, are typos or stale renames — and a typo reads as coverage.
 */
const bogus = [...unknown.entries()]
  .filter(([id]) => !docIds.has(id) && !NOT_CITATIONS.has(id));

const testText = walk(join(ROOT, 'tests')).map((f) => readFileSync(f, 'utf-8')).join('\n');
const selectors = checkSelectors(testText);
const dangling = selectors.filter((s) => !s.resolves);

const covered = allIds.filter((id) => cited.get(id).length > 0);
const uncovered = allIds.filter((id) => cited.get(id).length === 0);

if (args.has('--list')) {
  for (const [doc, ids] of byDoc) {
    console.log(`\n${doc}`);
    for (const id of ids) {
      const tests = cited.get(id);
      console.log(`  ${tests.length ? '✓' : '·'} ${id}`);
      for (const t of tests) console.log(`      ${t}`);
    }
  }
  console.log('');
}

const pct = allIds.length ? Math.round((covered.length / allIds.length) * 1000) / 10 : 0;
console.log(`requirement traceability: ${covered.length}/${allIds.length} statements cited by a test (${pct}%)`);
for (const [doc, ids] of byDoc) {
  const n = ids.filter((id) => cited.get(id).length > 0).length;
  console.log(`  ${n === ids.length ? '✓' : ' '} ${basename(doc).padEnd(36)} ${n}/${ids.length}`);
}

if (args.has('--update')) {
  writeFileSync(BASELINE, `${JSON.stringify({
    /* Recorded so coverage cannot silently fall. Raise it by citing more statements; the
     * only legitimate way to lower it is deleting a covered requirement, which should be
     * a deliberate commit that says so. */
    statements: allIds.length,
    covered: covered.length,
    uncovered,
  }, null, 2)}\n`);
  console.log(`\nbaseline recorded: ${covered.length}/${allIds.length}`);
  process.exit(0);
}

let failed = false;

if (bogus.length) {
  failed = true;
  console.log('\nCITATIONS OF IDS THAT DO NOT EXIST — a typo here reads as coverage:');
  for (const [id, files] of bogus) console.log(`  ${id}  (${files.join(', ')})`);
}

let baseline = null;
try { baseline = JSON.parse(readFileSync(BASELINE, 'utf-8')); } catch {}
if (!baseline) {
  console.log('\nno baseline recorded yet; run with --update');
} else if (covered.length < baseline.covered) {
  failed = true;
  const lost = (baseline.uncovered ? allIds.filter((id) => cited.get(id).length === 0
    && !baseline.uncovered.includes(id)) : []);
  console.log(`\nCOVERAGE FELL: ${covered.length} cited, baseline was ${baseline.covered}`);
  for (const id of lost) console.log(`  lost its citation: ${id}`);
  console.log('If a requirement was deliberately deleted, re-record with --update in that commit.');
}

if (dangling.length) {
  /*
   * Reported, not failed. Every one found so far was naming drift over real coverage —
   * three scenarios consolidated into one test, one selector that lost a prefix — so
   * failing the build here would block on a documentation defect. It is still a defect: an
   * unresolvable selector means the chain cannot be followed without reading everything,
   * which is the whole reason to have it.
   */
  console.log(`\n${dangling.length} of ${selectors.length} spec Test: selectors do not resolve to a test title:`);
  for (const { spec, selector } of dangling) console.log(`  ${spec}  ${selector}`);
}

if (uncovered.length && !args.has('--list')) {
  console.log(`\n${uncovered.length} statements rest on prose alone (use --list to see all):`);
  for (const id of uncovered.slice(0, 12)) console.log(`  · ${id}`);
  if (uncovered.length > 12) console.log(`  … and ${uncovered.length - 12} more`);
}

process.exit(failed ? 1 : 0);
