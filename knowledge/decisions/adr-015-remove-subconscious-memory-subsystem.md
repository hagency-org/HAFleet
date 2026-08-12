# ADR-015 — Remove the subconscious memory subsystem

Status: **accepted and built** (2026-08-12)
Decided by: operator ruling, during end-to-end validation of the contribution console.

## Decision

Delete the "subconscious" (潜意识) long-term memory subsystem in its entirety: the backend routes and
state machinery, the upstream integration module, the provisioning and launch wiring, the vendored
hook template, the dashboard tab, the console panel, the environment variables, and the tests that
pinned them.

`lib/memory-export-policy.js` is **kept**. It satisfies PRD R20 and its gate `SEC-R20-EGRESS`, and it
is the standing control for any future export path. Its subject is gone; the control is not.

## Why

Four findings, each sufficient on its own, discovered while walking the console end to end rather
than from a failing test.

**1. The console reported a state it never read.** `mockup/components/AgentTabs.jsx` rendered a panel
titled 引导通路(潜意识) whose every value was hardcoded: mode was a fixed string; the provider was
`agent.framework === 'hermes' ? 'deepseek' : 'inherit'`, which consults the framework name and
nothing else; and the key line printed a literal `DEEPSEEK_API_KEY` next to an **unconditional**
green "resolved" badge. `DEEPSEEK_API_KEY` was not in this repository's `.env` at all. An operator
asked why their codex agent used DeepSeek — a reasonable question about a panel that answered it
falsely.

**2. It was never wired for codex.** `docs/v1-agent-home-contract.md` said so plainly — "Codex
subconscious integration remains out of scope in this batch" — under a heading that read "Claude-only
runtime wiring". The two codex agents provisioned during validation had no `letta.json` and no
`subconscious/` directory. The feature the panel described had never been installed for them.

**3. The upstream it depends on is not present, and nothing fetches it.**
`lib/upstream-claude-subconscious.js` resolved a sibling checkout at `../claude-subconscious`, judged
by the presence of `Subconscious.af` and `scripts/agent_config.ts`, and reused six files from it
directly. No installer clones it. The backend already had a name for this state: `missing upstream
claude-subconscious root at <path>`.

**4. Its default was third-party egress.** This is the one that decides it.
`lib/memory-export-policy.js` was written to govern exactly this path, and records what it found:
the upstream "sends FULL session transcripts to its configured endpoint, and that endpoint defaulted
to `https://api.letta.com/v1` in seven places", while "the subconscious feature itself defaults to
ENABLED in two provisioning paths". It was fail-closed only by accident — the missing checkout and an
unset `LETTA_API_KEY` — so, in that module's own words, "drop a key next to that clone and full
transcripts flow to a third party with no further decision, no record, and no per-project
authorization."

A subsystem that cannot run, was never wired for the framework in use, lied about its status on the
one surface that showed it, and whose working configuration would ship full session transcripts to a
SaaS by default, is not a feature awaiting completion. Deleting it removes the egress path outright,
which is a stronger guarantee than the guard that was built on top of it.

## What was removed

| Area | Removed |
|---|---|
| `backend-v2.js` | 10 routes, 29 functions, the event log and store, the agent `subconsciousEnabled` field — 337 references to zero |
| `server.js` | the parallel implementation: 3 routes, 8 functions, the detail enrichment — 116 to zero |
| `lib/dashboard/render/agent-detail-page.js` | the Subconscious tab, its CSS, and 5 render/save functions — 272 to zero |
| `lib/dashboard/proxy-routes.js` | 6 proxy routes and both installers |
| `lib/upstream-claude-subconscious.js` | deleted (the egress source) |
| `scripts/configure-v1-subconscious.js`, `subconscious/claude-hafleet/` | deleted |
| `scripts/provision-v1-agent-home.js`, `bin/hafleet-up`, `bin/hafleet-up-v1` | provisioning and launch wiring, `letta.json` creation, launch-env injection |
| `lib/backend/auth-adapter.js` | `authorizeSubconsciousEventIngest`, `canAccessPrivilegedSubconsciousDetail`, the ingest-token exemption |
| `mockup/components/AgentTabs.jsx` | the fabricated panel, and the migration panel's three toast-only buttons beside it |
| env | `SUBCONSCIOUS_*`, `LETTA_*`, `HAFLEET_SUBCONSCIOUS_EVENT_TOKEN` |

## What was deliberately NOT removed

**Historical records.** `docs/design/reviews/*`, `docs/salt/*`, `docs/Hibiki/*` and
`docs/design/dashboard-relayout.md` still describe the subsystem, because they are dated artifacts of
decisions made while it existed. Editing them would make the archive claim those reviews discussed
something else. This repository keeps falsified theories on record for the same reason.

**`lib/memory-export-policy.js` and its tests.** See the Decision above. Note the consequence: its
header explains what it was governing in the present tense, and that subject no longer exists. The
module is now a control with no current caller — correct as a standing gate, and worth re-reading
before any future export path is added.

## Consequences

Good: no code path can send session transcripts off the machine; the console cannot report a memory
state that was never measured; `hafleet up` and provisioning are shorter and no longer write a
`letta.json` nobody reads.

Bad: HAFleet has no long-term agent memory. Nothing replaces it. If memory returns, it should be
designed against `lib/memory-export-policy.js` from the start rather than have a guard retrofitted
around a default that already leaked.

Neutral: the agent record no longer carries `subconsciousEnabled`. Existing `agent.json` manifests
and `meta.json` files may still contain the field; it is ignored rather than migrated, because an
ignored extra key costs nothing and a migration pass over every agent home costs a release.
