# Dependency security debt

## Current state

53 advisories reach production dependencies transitively: **1 critical, 14 high,
36 moderate, 2 low**. None originate in HAFleet's own code.

Regenerate the figures at any time:

```bash
node scripts/audit-baseline.mjs --summary
npm audit --omit=dev
```

## Where it comes from

Two direct dependencies account for essentially all of it:

| Direct dependency | Pulls in | Advisories |
|---|---|---|
| `@modelcontextprotocol/sdk` | `hono`, `@hono/node-server`, `fast-uri` (via `ajv`), `ip-address` (via `express-rate-limit`), `uuid`, `postcss`, `lodash` | the large majority, including most `hono` middleware issues |
| `matrix-bot-sdk` | `request` and its tree: `form-data`, `tough-cookie`, `qs` | the critical `form-data` issue and several moderates |

Bumping the MCP SDK from 1.26.0 to 1.30.0 (current latest) **does not clear
them** — verified. Several have no published fix, so `npm audit fix` cannot
resolve them either.

## Why they are not simply allowlisted

`scripts/audit-deps.sh` has a `KNOWN_UNFIXABLE_GHSAS` list, and it would be easy
to paste all 53 ids into it. That would be wrong: that list means *"reviewed and
cannot be fixed"*, and nobody has reviewed these.

So there are two mechanisms with different meanings, deliberately:

| Mechanism | Meaning | Gate |
|---|---|---|
| `KNOWN_UNFIXABLE_GHSAS` in `scripts/audit-deps.sh` | reviewed; no fix exists | `npm run audit:deps` — **not in CI yet** |
| `security/audit-baseline.json` | present; **not yet triaged** | `npm run audit:baseline` — **blocking in CI** |

## The ratchet

CI runs `npm run audit:baseline`, which fails when an advisory appears that is
not in the baseline. Existing debt does not block; regressions do.

Before this, the audit was excluded from CI altogether, so a genuinely new
critical would have gone unnoticed alongside the known noise. That was the actual
risk — not the 53 known items.

```bash
npm run audit:baseline          # CI gate: fail on anything new
npm run audit:baseline:update   # re-record after triage; review the diff
npm run audit:deps              # stricter, still fails against current debt
```

The baseline also reports advisories that have **disappeared**, prompting you to
shrink it. A baseline that only ever grows is not a ratchet.

## Likely reachability

An informed guess, recorded so triage has a starting point — **not** a
conclusion, and not a basis for treating anything as safe:

- Most `hono` / `@hono/node-server` advisories concern that framework's own
  server features — `serveStatic`, CORS middleware, JWT middleware, `toSSG()`,
  AWS Lambda adapters. HAFleet serves HTTP with **express**; the MCP SDK merely
  bundles hono. Those code paths are plausibly never entered.
- `form-data` / `tough-cookie` / `qs` arrive through `request` inside
  `matrix-bot-sdk`, which *is* exercised whenever the Matrix bridge runs.
  These deserve triage first.
- `fast-uri` arrives via `ajv` and is reachable during JSON-schema validation,
  which the MCP tool layer does perform.

## Reducing it

In rough order of value:

1. **Triage the `matrix-bot-sdk` / `request` chain.** It is genuinely exercised,
   and `request` has been deprecated for years. Replacing `matrix-bot-sdk` is
   also on the table independently — see the Rust-port discussion around
   `matrix-sdk`.
2. **Track MCP SDK releases** (Dependabot now opens weekly PRs) and re-check;
   the hono tree is upstream's to fix.
3. **Confirm hono unreachability** and move those ids from the baseline into
   `KNOWN_UNFIXABLE_GHSAS` with a written rationale. That converts untriaged
   noise into a reviewed decision.
4. **Then wire `npm run audit:deps` into CI** and retire the baseline.

## What is deliberately not claimed

- That the current debt is safe. It is recorded, not approved.
- That `--update` is routine. It records accepted debt; the diff must be read.
- That SBOM and provenance (added for published images in
  `.github/workflows/publish-image.yml`) mitigate any of this. They make the
  contents auditable; they do not fix a vulnerable dependency.
