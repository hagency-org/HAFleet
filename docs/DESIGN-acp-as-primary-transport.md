# DESIGN: ACP as HAFleet's primary agent transport

Status: **proposal, substantially weakened by review — do not action as written**
Author: drafted 2026-08-02
Scope: `lib/runtime/*`, `lib/frameworks/*`, `scripts/hafleet-acp-agent.mjs`

## Review outcome (2026-08-02, codex-agent)

Submitted for adversarial review and it did not survive intact. The reviewer's
bottom line, accepted:

> ACP is worth prototyping, but this document does not justify making it the
> primary transport. It establishes that screen scraping is fragile, not that the
> proposed ACP routes preserve HAFleet's required behaviour. "All four have an ACP
> path" is existence evidence, not compatibility or production-readiness evidence.

Four findings that change the plan rather than refine it:

1. **The permission gate is not a security boundary.** Phase 1 assumed it was. It
   only is if every adapter emits a permission request for every relevant action
   and cannot bypass it through its own filesystem, shell or MCP paths. This
   document itself states octos does its own I/O. Without a threat model — default
   deny, timeout and disconnect handling, path canonicalisation, replay
   resistance, concurrent prompts, audit records, behaviour when an agent ignores
   permissions — it is UI, not enforcement.

2. **"tmux stays as a fallback" hides the hard design.** An ACP session cannot be
   attached to by tmux, so falling back starts a *different* session. That is
   recovery by replacement, not fallback. Unaddressed: who selects it, how state
   reconciles, how duplicate execution is prevented. Maintaining both paths also
   doubles integration and test cost, which the effort table omits entirely.

3. **Phase 3 mapped method names, not semantics.** `session/hydrate` is not
   necessarily ACP `load`/`resume`; `agent/close` may not equal `session/close`;
   router modes may not map to ACP modes. Calling it "adapter work, not capability
   work" was name-matching presented as analysis. The admitted tenant/auth
   entanglement is evidence it is the opposite.

4. **Phase 2's rationale was inverted.** hermes was called lowest-risk *because* it
   has never been driven end to end. That makes it highest-uncertainty. Absence of
   something to break is not low risk.

Also accepted: Phase 0 is far beyond 140 lines once cancellation, ID ownership,
concurrency, backpressure, malformed frames and stdout contamination are counted;
"~80 lines per framework" excludes supervision, version pinning, event
normalisation, rollout and rollback; "runs beside tmux and is compared" is not a
test plan, and shadowing live turns would duplicate side effects; the risk list
omits supply-chain compromise of npm adapters in the execution path, protocol
version skew, subprocess orphaning, event loss and ordering, and secrets in
transcripts; and "roughly a week" contradicts the uncertainty the document itself
describes.

**Revised sequencing** (replaces the phase order below, which is retained for the
record):

- **Phase −1** — requirements, plus a *measured* tmux baseline: incident rate by
  framework, recovery time, what operator workflows actually depend on pane access.
- **Phase 0** — disposable compatibility spikes across all four agents producing a
  method/behaviour matrix. This precedes any implementation because it may reveal
  incompatible lifecycle or permission semantics that end the proposal.
- **Phase 1** — lifecycle, fallback and security design, including a threat model
  for permissions.
- **Phase 2** — minimal generic JSON-RPC core with a conformance and chaos harness.
- **Phase 3** — one canary framework with explicit acceptance gates.
- Only then per-framework migration decisions. Each framework independently
  eligible. ACP is not "primary" until it preserves the operator workflows above
  or HAFleet explicitly drops them.

The sections below are the original proposal, kept so the review has something to
refer to. Read them as the argument that was made, not the plan to execute.

## The problem

HAFleet drives three of its four frameworks by typing into a tmux pane and reading
the rendered screen back. Everything fragile about that has one root: the screen is
a picture, not data. Observed on real hosts:

- a tab became an underscore in pane output and every agent went offline
  (153 empty snapshots in one run)
- a framework's prompt symbol turned out to be a user-configurable theme setting,
  so readiness detection depended on the operator's colour scheme
- a readiness check fired on a blank pane

None of these are bugs in the parser. They are the cost of inferring state from a
rendering.

## Why now

The Agent Client Protocol stopped being a Zed project.

- co-developed by **JetBrains and Zed**, backed by Google; Apache 2.0
- registry at `github.com/agentclientprotocol/` — a neutral org, not `zed-industries`
- **50+ agents** registered; JetBrains and Zed native, Neovim/Emacs/VS Code/marimo
  via plugins
- ACP Registry launched 2026-01-28 with one-click install inside JetBrains IDEs

All four HAFleet frameworks have an ACP path:

| framework | today | ACP route |
|---|---|---|
| octos | `transport: acp` | native, 3 of 20 methods |
| hermes | tmux | native — `hermes acp` |
| codex | tmux | adapter — `@agentclientprotocol/codex-acp` |
| claude | tmux | adapter — `@zed-industries/claude-code-acp` |

## What ACP does and does not replace

ACP is richer where it overlaps and narrower overall. Measured, not asserted:

| | tmux | ACP |
|---|---|---|
| interrupt | `C-c`, unacknowledged | `session/cancel`, returns `StopReason::Cancelled` |
| what the agent is doing | regex a rendered screen | `ToolCall` + `ToolCallStatus`, typed |
| agent reasoning | only if it prints | `AgentThoughtChunk` — invisible in a pane |
| idle detection | pane-hash diff | implicit in the event stream, semantic |
| clear context | `/clear` keystroke | nothing in ACP |
| answer an arbitrary prompt | any keystroke | nothing |
| human takes over | `tmux attach` | nothing |
| session outlives launcher | yes, tmux owns the pane | only with `session/load` |

The last three have no ACP answer. **tmux stays as a fallback, not a default.**

## Non-goals

- Replacing tmux everywhere. Two capabilities above have no protocol equivalent.
- Adopting octos's `ui_protocol`. It is deeper (99 methods vs 20) but octos-only,
  internal, with no compatibility promise, and much of its depth is octos product
  surface — cron, voice, visual, profiles — that duplicates HAFleet's own task
  graph and approvals.

## Plan

### Phase 0 — bidirectional JSON-RPC (prerequisite, ~140 lines)

`lib/runtime/acp.js` is one-directional today. It matches responses by id and
handles `session/update`. An incoming *request* has both `id` and `method`, so it
falls through both branches and is silently dropped — the agent would hang waiting
for a response that never comes.

- dispatch incoming requests to registered handlers
- send results and JSON-RPC errors
- advertise client capabilities in `initialize` — advertising something
  unimplemented is worse than advertising nothing, because the agent will call it

### Phase 1 — `session/request_permission` (~80 lines on top of Phase 0)

Highest value per line. octos surfaces tool calls but does not block on permission
requests, so the sandbox chosen at launch is the only control that exists today.

Reuses `lib/approval-store.js` and `lib/runtime-approval-client.js`;
`lib/codex-permission-hook.js` (228 lines) is the precedent for the policy shape.
Better than that hook, which needs a digest-pinned trust file and a TTY.

### Phase 2 — hermes onto ACP

First framework to migrate, deliberately: native `hermes acp` with no adapter in
the chain, and it is the one framework never driven end to end. Lowest risk, and it
proves the path before touching anything that works.

### Phase 3 — contribute the missing methods to octos upstream

The semantics already exist in octos behind `ui_protocol`, and there is a shared
`trait AgentOrchestrator` both protocols can dispatch through. The 1.2.0 ACP crate
octos already depends on defines all 20 methods — no version bump.

| ACP method missing | octos already has |
|---|---|
| `session/fork` | `session/fork` |
| `session/list` | `session/list` |
| `session/delete` | `session/delete` |
| `session/load` / `resume` | `session/hydrate`, `session/open` |
| `session/close` | `agent/close` |
| `session/set_mode` | `router/set_mode` |
| `session/request_permission` | `approval/requested` + `approval/respond` |

Adapter work, not capability work. Do it in octos so every ACP client benefits,
rather than in HAFleet where only HAFleet does.

Separately, fix the MCP lifetime bug found on mini5: `McpClient::register_tools`
consumes `self` and drops `self.services` — the field whose own doc comment says it
exists to keep the stdio children alive. Log evidence: `MCP server started
server="node" tools=11` then `Child exited gracefully` 1ms later.

### Phase 4 — codex, then claude

Codex first: its adapter has 440 commits, neutral governance, and supports
permissions, MCP, subagents and `/compact`. Claude last: its tmux path works, and
its adapter reportedly lacks Plan Mode, `/compact` and many slash commands, with a
context-window bug (compacting at 120–200K against 1M on the CLI). HAFleet uses
`/clear` via `injectSlashClear` and carries `signals.compact`, so those gaps land
directly on us.

Each migration runs beside tmux on mini5 and is compared before switching.

### Phase 5 (optional, may never be needed) — `fs/*` and `terminal/*`

These invert the relationship: the agent asks the harness to read a file or run a
terminal. That is what makes HAFleet a *harness* rather than a caller.

Deferred because it is the largest chunk (~300 lines), the highest risk, and
currently speculative — no agent in the fleet calls them. octos does its own file
and terminal I/O. OpenClaw's own docs record the same gap: their bridge "does not
call the filesystem methods defined in the ACP specification."

Security floor if built: the agent names a path and HAFleet opens it, with
HAFleet's privileges rather than the agent's. Nothing in `lib/` does path
confinement today.

## Effort

| phase | impl | tests |
|---|---|---|
| 0 bidirectional | ~140 | ~150 |
| 1 permissions | ~80 | ~120 |
| 2 hermes | ~60 | ~100 |
| 3 octos upstream | unknown — separate repo | — |
| 4 codex, claude | ~80 each | ~150 |
| 5 fs + terminal | ~360 | ~250 |

Roughly a week for phases 0–2 and 4. Phase 3 is unestimated: `ui_protocol.rs` is
29,786 lines in one file, and how tangled its handlers are with session/tenant/auth
state that ACP has no notion of is the main unknown.

## Risks

1. **Adapters lag their agents.** claude-code-acp and codex-acp wrap proprietary
   interfaces and can only expose what those expose.
2. **Silent degradation.** The claude-code-acp context bug is the shape to fear:
   nothing errors, the agent just gets worse.
3. **Trading proven for standard.** Claude and Codex are driven end to end on tmux
   today. Migration must be measured, not assumed.
4. **Phase 5 may be unnecessary.** Building seven methods nothing calls.
5. **The agent we most want on ACP has the weakest ACP.** octos implements 3 of 20.

## Open questions

- Is the claude-code-acp gap list still current? Could not confirm.
- Does `hermes acp` support `session/load`? Its docs claim daemon-held state that
  "outlives any single project", which would be better than octos.
- Should HAFleet ship its own ACP adapter for agents that lack one, or wait?
- `acpx` (openclaw) already does headless multi-agent ACP orchestration explicitly
  to replace PTY scraping. Adopt, vendor, or ignore? It is alpha.
