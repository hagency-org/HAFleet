#!/usr/bin/env bash
set -euo pipefail

STRICT=false
while [ $# -gt 0 ]; do
  case "$1" in
    --strict)
      STRICT=true
      ;;
    -h|--help)
      cat <<'USAGE'
Usage: scripts/audit-deps.sh [--strict]

Runs `npm audit --omit=dev --json` and fails on:
- Any vulnerability not in the known-unfixable allowlist.
- In --strict mode: any vulnerability.
USAGE
      exit 0
      ;;
    *)
      echo "Error: unknown argument '$1'" >&2
      exit 1
      ;;
  esac
  shift
done

AUDIT_JSON="$(npm audit --omit=dev --json 2>/dev/null || true)"
if [ -z "$AUDIT_JSON" ]; then
  echo "Error: npm audit returned empty output." >&2
  exit 1
fi

KNOWN_UNFIXABLE_GHSAS=(
  "GHSA-FJXV-7RQG-78G4" # form-data via request/matrix-bot-sdk
  "GHSA-6RW7-VPXM-498P" # qs via request
  "GHSA-72XF-G2V4-QVF3" # tough-cookie via request
  "GHSA-P8P7-X288-28G6" # request SSRF
)
ALLOWED_GHSA_CSV="$(IFS=,; echo "${KNOWN_UNFIXABLE_GHSAS[*]}")"

TMP_AUDIT_JSON="$(mktemp)"
trap 'rm -f "$TMP_AUDIT_JSON"' EXIT
printf '%s' "$AUDIT_JSON" > "$TMP_AUDIT_JSON"

REPORT_JSON="$(ALLOWED_GHSA_CSV="$ALLOWED_GHSA_CSV" AUDIT_JSON_FILE="$TMP_AUDIT_JSON" node <<'NODE'
const fs = require('fs');

const raw = fs.readFileSync(process.env.AUDIT_JSON_FILE, 'utf8');
let data;
try {
  data = JSON.parse(raw);
} catch (err) {
  console.log(JSON.stringify({ error: `invalid-json:${err.message}` }));
  process.exit(0);
}

const allow = new Set(
  (process.env.ALLOWED_GHSA_CSV || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

function extractGhsa(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const source = typeof obj.source === 'string' ? obj.source.trim() : '';
  if (source.startsWith('GHSA-')) return source;
  const title = typeof obj.title === 'string' ? obj.title : '';
  const titleMatch = title.match(/GHSA-[0-9a-z-]+/i);
  if (titleMatch) return titleMatch[0].toUpperCase();
  const url = typeof obj.url === 'string' ? obj.url : '';
  const urlMatch = url.match(/GHSA-[0-9a-z-]+/i);
  if (urlMatch) return urlMatch[0].toUpperCase();
  return null;
}

const found = new Map();
const vulnerabilities = data && data.vulnerabilities && typeof data.vulnerabilities === 'object'
  ? data.vulnerabilities
  : {};

for (const [pkg, meta] of Object.entries(vulnerabilities)) {
  const via = Array.isArray(meta?.via) ? meta.via : [];
  for (const item of via) {
    if (!item || typeof item !== 'object') continue;
    const id = extractGhsa(item) || `UNKNOWN:${pkg}`;
    if (!found.has(id)) {
      found.set(id, {
        id,
        packages: new Set(),
        severity: item.severity || meta?.severity || 'unknown',
        title: item.title || '',
        url: item.url || '',
      });
    }
    found.get(id).packages.add(pkg);
  }
}

const entries = [...found.values()].map((item) => ({
  id: item.id,
  severity: item.severity,
  title: item.title,
  url: item.url,
  packages: [...item.packages].sort(),
  allowed: allow.has(item.id),
}));
entries.sort((a, b) => a.id.localeCompare(b.id));

const totals = {
  total: entries.length,
  allowed: entries.filter((e) => e.allowed).length,
  disallowed: entries.filter((e) => !e.allowed).length,
};

console.log(JSON.stringify({ totals, entries }));
NODE
)"

if printf '%s' "$REPORT_JSON" | rg -q '"error"'; then
  echo "Error: failed to parse npm audit report" >&2
  printf '%s\n' "$REPORT_JSON" >&2
  exit 1
fi

TOTAL_COUNT="$(printf '%s' "$REPORT_JSON" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(String(d.totals.total||0));')"
DISALLOWED_COUNT="$(printf '%s' "$REPORT_JSON" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(String(d.totals.disallowed||0));')"

if [ "$TOTAL_COUNT" -eq 0 ] 2>/dev/null; then
  echo "Dependency audit clean: no vulnerabilities."
  exit 0
fi

echo "Dependency audit summary: $TOTAL_COUNT advisory id(s), $DISALLOWED_COUNT disallowed."
printf '%s' "$REPORT_JSON" | node -e '
const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
for (const e of data.entries) {
  const tag = e.allowed ? "ALLOW" : "BLOCK";
  const pkg = e.packages.join(",");
  const title = e.title ? ` | ${e.title}` : "";
  console.log(`[${tag}] ${e.id} (${e.severity}) packages=${pkg}${title}`);
}
'

if [ "$STRICT" = true ]; then
  echo "Strict mode enabled: failing because vulnerabilities are present." >&2
  exit 1
fi

if [ "$DISALLOWED_COUNT" -gt 0 ] 2>/dev/null; then
  echo "Dependency audit failed: disallowed vulnerabilities detected." >&2
  exit 1
fi

echo "Dependency audit passed with known-unfixable allowlist only."
