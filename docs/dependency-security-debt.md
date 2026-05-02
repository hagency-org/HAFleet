# Dependency Security Debt

This project runs `npm audit --omit=dev` via `npm run audit:deps`.

## Current policy

- Block any newly introduced advisory ID.
- Temporarily allow only the known-unfixable advisories below.
- Use `npm run audit:deps:strict` when validating a migration branch.
- Enforce dependency isolation boundary with `bash scripts/check-dep-isolation.sh`.

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
4. Keep vulnerable chain isolated to `bridge-matrix.js` only (no direct `request` usage in other runtime modules).

## RLP7-B audit observation

As of 2026-05-03, `npm run audit:deps` reports 24 advisory ids and fails on 20 disallowed ids. The disallowed set has two different remediation classes:

- Fixable transitive locks under current root semver ranges: MCP SDK / Hono / @hono/node-server / express-rate-limit, Express `path-to-regexp`, `lodash`, and `postcss`.
- Matrix `request` chain debt: `uuid` is now reported through the same `matrix-bot-sdk -> request/request-promise` path, but is not yet in the allowlist.

Decision options:

1. approve a root lock refresh for the fixable transitive advisories, with no direct `package.json` semver changes;
2. approve adding `GHSA-w5hq-g745-h8pq` (`uuid`) to the temporary Matrix allowlist, or require Matrix migration before default audit can pass;
3. keep `audit:deps` out of blocking `verify:ci`/release verification until the selected policy is green and approved.

## Operator commands

- Default gate: `npm run audit:deps`
- Strict gate: `npm run audit:deps:strict`
- Full report: `npm audit --omit=dev`
- Isolation check: `bash scripts/check-dep-isolation.sh`
