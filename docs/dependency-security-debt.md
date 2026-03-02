# Dependency Security Debt

This project runs `npm audit --omit=dev` via `npm run audit:deps`.

## Current policy

- Block any newly introduced advisory ID.
- Temporarily allow only the known-unfixable advisories below.
- Use `npm run audit:deps:strict` when validating a migration branch.

## Temporarily allowed advisories

These advisories currently come from `matrix-bot-sdk@0.8.0` transitive `request` chain.

1. `GHSA-fjxv-7rqg-78g4` (`form-data`)
2. `GHSA-6rw7-vpxm-498p` (`qs`)
3. `GHSA-72xf-g2v4-qvf3` (`tough-cookie`)
4. `GHSA-p8p7-x288-28g6` (`request`)

## Why still allowed

- `matrix-bot-sdk` latest release still depends on `request` / `request-promise`.
- Upstream currently provides no semver-safe fix path for these transitive vulnerabilities.
- Force-overriding to incompatible major versions is high risk for Matrix bridge runtime stability.

## Exit plan

1. Track `matrix-bot-sdk` updates for removal of `request` chain.
2. If no upstream timeline, scope migration of `bridge-matrix.js` to a maintained Matrix client stack.
3. Remove allowlist entries immediately after migration or upstream fix.

## Operator commands

- Default gate: `npm run audit:deps`
- Strict gate: `npm run audit:deps:strict`
- Full report: `npm audit --omit=dev`
