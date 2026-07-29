#!/usr/bin/env node
// Dependency-advisory ratchet.
//
// `npm run audit:deps` fails today: 53 advisories reach us transitively, mostly
// through @modelcontextprotocol/sdk (hono, fast-uri, express-rate-limit) and
// matrix-bot-sdk (request, form-data, tough-cookie, qs). Bumping the MCP SDK to
// 1.30.0 does not clear them, and several have no fix published.
//
// That is why the audit was left out of CI entirely — which meant a genuinely
// NEW vulnerability would also go unnoticed. This closes that gap without
// pretending the existing debt is acceptable.
//
// The distinction matters:
//   scripts/audit-deps.sh KNOWN_UNFIXABLE_GHSAS = "reviewed, cannot be fixed"
//   this baseline                               = "present, NOT yet triaged"
// Dumping 53 untriaged advisories (including criticals) into an
// unfixable-allowlist would assert a safety judgement nobody has made.
//
// Usage:
//   node scripts/audit-baseline.mjs            # fail if any advisory is not in the baseline
//   node scripts/audit-baseline.mjs --update   # rewrite the baseline (review the diff!)
//   node scripts/audit-baseline.mjs --summary  # print counts and exit 0

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const BASELINE_PATH = 'security/audit-baseline.json';
const SEVERITY_ORDER = ['critical', 'high', 'moderate', 'low', 'info'];

const args = process.argv.slice(2);
const UPDATE = args.includes('--update');
const SUMMARY_ONLY = args.includes('--summary');

function runAudit() {
  // npm audit exits non-zero when it finds anything, so failure is expected.
  let raw;
  try {
    raw = execFileSync('npm', ['audit', '--omit=dev', '--json'], {
      encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    raw = error.stdout || '';
  }
  if (!raw.trim()) {
    console.error('ERROR: npm audit produced no output; refusing to pass by default.');
    process.exit(2);
  }
  try {
    return JSON.parse(raw);
  } catch {
    console.error('ERROR: could not parse npm audit output.');
    process.exit(2);
  }
}

/** Flatten the advisory tree into one entry per GHSA id. */
function collectAdvisories(report) {
  const found = new Map();
  for (const [pkgName, node] of Object.entries(report.vulnerabilities || {})) {
    for (const via of node.via || []) {
      if (!via || typeof via !== 'object' || !via.url) continue;
      const id = String(via.url).split('/').pop().toUpperCase();
      if (!id.startsWith('GHSA-')) continue;
      if (!found.has(id)) {
        found.set(id, {
          id,
          severity: via.severity || 'unknown',
          package: via.name || pkgName,
          title: (via.title || '').trim(),
        });
      }
    }
  }
  return [...found.values()].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
      || a.id.localeCompare(b.id),
  );
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));
  } catch {
    console.error(`ERROR: ${BASELINE_PATH} is not valid JSON.`);
    process.exit(2);
  }
}

function writeBaseline(advisories) {
  mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  const payload = {
    $comment: [
      'Advisories known to be present and NOT yet triaged for reachability.',
      'This is a ratchet, not an approval: CI fails when a NEW id appears.',
      'Regenerate with: node scripts/audit-baseline.mjs --update',
      'Removing entries is the goal. See docs/SECURITY-DEBT.md.',
    ],
    generatedFrom: 'npm audit --omit=dev',
    advisories: advisories.map(({ id, severity, package: pkg, title }) => ({
      id, severity, package: pkg, title,
    })),
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`);
}

function countBySeverity(advisories) {
  const counts = {};
  for (const entry of advisories) counts[entry.severity] = (counts[entry.severity] || 0) + 1;
  return SEVERITY_ORDER
    .filter((s) => counts[s])
    .map((s) => `${counts[s]} ${s}`)
    .join(', ') || 'none';
}

const current = collectAdvisories(runAudit());

if (SUMMARY_ONLY) {
  console.log(`Advisories: ${current.length} (${countBySeverity(current)})`);
  process.exit(0);
}

if (UPDATE) {
  writeBaseline(current);
  console.log(`Wrote ${BASELINE_PATH}: ${current.length} advisories (${countBySeverity(current)})`);
  console.log('Review the diff before committing — this records accepted-for-now debt.');
  process.exit(0);
}

const baseline = loadBaseline();
if (!baseline) {
  console.error(`ERROR: ${BASELINE_PATH} is missing. Create it with --update.`);
  process.exit(2);
}

const baselineIds = new Set((baseline.advisories || []).map((a) => String(a.id).toUpperCase()));
const currentIds = new Set(current.map((a) => a.id));

const added = current.filter((a) => !baselineIds.has(a.id));
const resolved = [...baselineIds].filter((id) => !currentIds.has(id));

console.log(`Baseline: ${baselineIds.size} advisory id(s)`);
console.log(`Current:  ${current.length} advisory id(s) (${countBySeverity(current)})`);

if (resolved.length) {
  // Good news, but the baseline must shrink to match or it stops being a ratchet.
  console.log('');
  console.log(`${resolved.length} baseline advisory id(s) no longer present:`);
  for (const id of resolved.sort()) console.log(`  [GONE]  ${id}`);
  console.log('Shrink the baseline: node scripts/audit-baseline.mjs --update');
}

if (added.length) {
  console.log('');
  console.error(`${added.length} NEW advisory id(s) not in the baseline:`);
  for (const entry of added) {
    console.error(`  [NEW]   ${entry.id} (${entry.severity}) ${entry.package} — ${entry.title}`);
  }
  console.error('');
  console.error('Fix, or triage and record deliberately with --update. Do not update blindly.');
  process.exit(1);
}

console.log('');
console.log('No new advisories. Existing debt is unchanged and remains untriaged.');
process.exit(0);
