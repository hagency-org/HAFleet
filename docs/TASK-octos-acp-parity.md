# TASK: bring octos's ACP implementation to parity

**Repo to change:** the octos Rust workspace (not HAFleet). Reference checkout used
while writing this: `/Users/yuechen/home/octos` @ `34030c2ec`, v2.0.2-rc.13.
**Independent of:** any HAFleet-side ui-protocol work. Nothing here blocks on that.
**Audience:** an agent who has not seen this investigation.

---

## 0. Orientation — read these before writing code

| file | lines | why |
|---|---|---|
| `crates/octos-cli/src/commands/acp.rs` | 2,207 | the entire ACP surface today |
| `crates/octos-bus/src/session.rs` | 3,417 | `SessionManager` — the persistence ACP does not use |
| `crates/octos-core/src/types.rs:491` | — | `SessionKey` |
| `crates/octos-cli/tests/acp_integration.rs` | 448 | the existing test harness; extend it |
| `crates/octos-agent/src/mcp.rs:334` | — | `McpClient`, for task 1 |

**The one-sentence summary of the problem:** octos's ACP layer is a parallel
universe. It implements 3 of the ACP's 20 methods, and it does not reference
`SessionManager` at all — `AcpSession` (acp.rs:144) keeps `history:
Mutex<Vec<Message>>` in memory, so every session dies with the process. The REST
and WebSocket paths use `SessionManager` and get persistence, fork and list for
free. ACP gets none of it.

Handlers register in a builder chain around acp.rs:802:

```rust
.on_receive_request(handle_new_session, on_receive_request!())
```

Adding a method is one handler function plus one chain entry. The *wiring* is
cheap everywhere. The cost is in what backs each method.

---

## 1. ~~Fix the MCP client lifetime bug~~ — WITHDRAWN, the diagnosis was wrong

**Do not do this.** An earlier version of this document called for changing
`McpClient::register_tools` because it consumes `self` and drops `self.services`,
"the field whose own comment says it keeps the stdio children alive".

That reading was wrong. `McpService` is
`Arc<RunningService<RoleClient, ClientInfo>>` (`crates/octos-agent/src/mcp.rs:40`).
Each registered `McpTool` holds a clone, so dropping the `services` vec only
decrements a refcount. The doc comment describes an invariant `Arc` already
provides, and the eleven identical call sites are all fine.

**What actually kills the transport is profile narrowing.**
`finalize_tool_registry` (acp.rs:197) ends with `profile.apply_to_registry(tools)`,
which calls `ToolRegistry::filter_by_profile` (registry.rs:839). For an
`AllowList` profile that is a `retain()` over tool names. MCP tool names are not in
the lean `coding` profile's list, so they are evicted — and eviction drops the last
`Arc` references, which cancels the rmcp service and exits the child.

Log signature, captured live:

```
MCP server started server="node" tools=11 concurrency_class=Safe
task cancelled
Child exited gracefully exit status: 0
```

**There is no octos code change required.** Two configuration changes fix it:

1. declare HAFleet's MCP server in `~/.config/octos/config.json` under
   `mcp_servers` — ACP ignores `mcpServers` on `session/new` but does load them
   from config (acp.rs:431)
2. run with `--profile coding-full` so narrowing does not evict them

Verified end to end: octos called `whoami` and `check_inbox` and returned their
real output, with `tools=52` in the LLM call.

**A genuine octos issue remains, smaller than the one claimed.** Operator-configured
MCP tools being silently evicted by profile narrowing is surprising, and the failure
is invisible — the transport dies with an INFO-level log and the agent simply lacks
the tools. Worth raising upstream as either "profile narrowing should preserve
explicitly configured MCP tools" or "warn when narrowing evicts an MCP tool". Not a
blocker for HAFleet.

## 2. Tier 1 — methods needing no new state

Small and independent. Each is a handler plus a chain entry.

- **`session/set_mode`** — back with the existing router mode machinery
  (ui-protocol exposes `router/set_mode`).
- **`session/close`** — `AcpSession` already carries a `shutdown:
  Arc<AtomicBool>`; teardown exists in `handle_cancel`. Close is that plus
  removing the session from the map.

**Advertise nothing you have not implemented.** `AgentCapabilities` is built at
acp.rs:1007 and deliberately does not advertise `loadSession`. Keep that
discipline: a client that sees a capability will call it, and a method that is
advertised but unimplemented hangs the client rather than erroring.

**Acceptance:** extend `acp_integration.rs`. Its existing pattern drives the binary
over stdio with literal JSON-RPC lines — follow it rather than inventing a harness.

---

## 3. Tier 2 — put ACP sessions on `SessionManager`

This is the substantial task, and it unlocks four methods at once: `session/list`,
`session/load`, `session/resume`, `session/fork`, `session/delete`.

All of them already exist on `SessionManager`:

```
list_sessions()                     session.rs:939
load(&SessionKey) -> Option<Session> session.rs:1221
fork(...)                           session.rs:1972
persist_message_through_canonical_path()  session.rs:2388
```

**The identity question, resolved.** I originally flagged the ACP/SessionManager
identity mismatch as the main risk and estimated 1–2 weeks at low confidence. That
was wrong. `SessionKey` is a newtype over a formatted string
(`crates/octos-core/src/types.rs:491`):

```rust
pub struct SessionKey(pub String);
pub fn new(channel: &str, chat_id: &str) -> Self { Self(format!("{channel}:{chat_id}")) }
```

An ACP session maps to `SessionKey::new("acp", session_id)`. There is no tenant or
user struct to reconcile — the "channel" dimension is exactly the seam needed, and
`acp` becomes a channel alongside the existing ones. **Revised estimate: days, not
weeks.** Verify this before building on it; it is the single assumption the rest of
this tier rests on.

**Work:**
1. Replace `AcpSession.history: Mutex<Vec<Message>>` with a `SessionKey` and route
   reads/writes through `SessionManager`.
2. Implement the five methods against it.
3. Advertise `loadSession` in `AgentCapabilities` **only once load actually
   restores state** — see the comment already at acp.rs:1008.

**Acceptance:** start a session, prompt it, kill the process, start a new one,
`session/load` the same id, and confirm the prior turn is in context. Fork a
session and confirm the two diverge without cross-contamination.

---

## 4. Tier 3 — `session/request_permission`

**Behavioural change, not plumbing.** acp.rs:53 records the current state: octos
surfaces tool calls "but do not block on ACP `session/request_permission` in v1."
Making it block means changing the agent loop, not the protocol layer.

The backing exists — ui-protocol has `approval/requested`, `approval/respond`,
`approval/decided`, `approval/auto_resolved`, `approval/scopes/list`.

**Security requirements, which are the point of the task.** A permission gate is
only a boundary if it cannot be bypassed. Specify and test:

- default **deny** on timeout, on client disconnect, and on malformed response
- behaviour when the client does not advertise the capability (do not silently
  proceed — either refuse the tool or refuse the session, and say which)
- path canonicalisation before the decision, so a decision about `/a/b` cannot be
  replayed against `/a/../b`
- concurrent prompts within one turn
- an audit record per decision
- **coverage**: every tool path that touches filesystem, shell or network must
  emit a request. A gate the agent can walk around via its own tools is UI, not
  enforcement. Enumerate the tool registry and assert coverage in a test.

---

## 5. Tier 4 — `fs/*` and `terminal/*` (client-provided)

These invert the relationship: the agent asks the *client* to read a file or run a
terminal, rather than doing it itself.

```
fs/read_text_file · fs/write_text_file
terminal/create · terminal/output · terminal/kill · terminal/release · terminal/wait_for_exit
```

Implementing them means octos's own tool implementations route through ACP when
running under ACP — that touches the tool registry, not the protocol layer. Largest
and deepest change.

**Do this last, or not at all.** It is currently speculative: no known client in
this fleet calls them, and OpenClaw's ACP bridge documents the same gap on their
side. Build it when a client asks for it.

---

## 6. Sequencing and estimates

| task | estimate | confidence | blocks |
|---|---|---|---|
| 1. ~~MCP lifetime fix~~ | withdrawn — config, not code | — | nothing |
| 2. Tier 1 | ~1 day | high | nothing |
| 3. Tier 2 | days | medium — rests on the `SessionKey` finding | 4 is easier after |
| 4. Tier 3 | ~1 week | medium | — |
| 5. Tier 4 | 2+ weeks | low | — |

Tasks 1 and 2 are independent and can run in parallel with anything.

**Do not treat this as a single month-long project.** Task 1 turned out to be
configuration rather than code, and it alone delivered coordination parity with the
tmux frameworks. Stop after Tier 3 unless a client needs Tier 4.

---

## 7. Verification

- Extend `crates/octos-cli/tests/acp_integration.rs` (448 lines) — it already
  drives the binary over stdio with literal JSON-RPC. Do not build a new harness.
- Every new method needs a test that exercises the **failure** path, not only the
  happy one: malformed params, unknown session id, method called before
  `initialize`, client disconnect mid-request.
- **Capture stderr when debugging.** ACP reserves stdout for the protocol, so all
  octos diagnostics go to stderr. A silent misconfiguration is invisible without
  it — that is how the MCP bug in task 1 stayed hidden through two rounds of
  source reading.

## 8. Known unknowns

- Whether `SessionManager::fork` semantics match ACP `session/fork`. Names match;
  semantics unverified. Check before relying on it.
- Whether `router/set_mode` modes map onto ACP session modes, or are a different
  concept with a similar name.
- Whether the agent loop can be made to block on permissions without restructuring
  the tool-execution path.

These three were name-matched during investigation, not verified. Treat every
"octos already has X" claim in this document as a lead to confirm, not a fact.
