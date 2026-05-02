# Repair Table

Date: 2026-05-02

Status: draft pending audit consolidation and ac-topleader review.

| ID | Priority | Scope | Problem | Proposed repair | Verification | Approval |
| --- | --- | --- | --- | --- | --- | --- |
| R-001 | P0 | Kernel auth/cursors | Group message reads can advance another agent's group cursor anonymously. | Add auth to `GET /api/groups/:name/messages`; require target agent token for cursor advancement. | Add API test for anonymous read/no-advance and tokened advance. | Implemented in Batch 1 |
| R-002 | P0 | Kernel privacy | Message detail endpoints expose full chat memory without auth. | Add message visibility auth to `GET /api/messages/:id` and `/msg/:id`; sanitize or remove HTML rendering. | Add API tests for unauthenticated denial and allowed sender/recipient/member access. | Implemented in Batch 1 |
| R-003 | P0 | Kernel auth | Agent-token mode is fail-open by default and missing managed tokens allow core writes. | Make production managed-agent writes fail closed; keep audit/off as explicit development/test modes only. | Token mode tests plus launch/provisioning token presence check. | Deferred: requires bulk token provisioning first |
| R-004 | P1 | Inbox semantics | Offline group mentions can be suppressed from inbox permanently. | Split push suppression from inbox suppression; offline push skip must not add `suppressedRecipients`. | Add regression test: offline mention appears in later `check_inbox`. | Implemented in Batch 2 |
| R-005 | P1 | Task graph trust | Non-assignees can spoof task graph node results. | Validate `msg.from === node.assignee` and bind result to dispatch `reply_to` or nonce. | Add spoofed schema-message test. | Implemented assignee + dispatch `reply_to` validation in Batch 2 |
| R-006 | P2 | Task model | Task truth is split across agent records, task store, and task graph store. | Declare `taskStore` canonical; migrate or demote legacy `agents[agent].task`. | Source-of-truth test and migration compatibility check. | Design-only doc added |
| R-007 | P2 | Alerts | Notification aggregation writes cooldown before actual flush. | Move cooldown persistence after successful flush or persist aggregate buffer. | Unit test simulated exit/flush ordering. | Pending |
| R-008 | P2 | Agent home | `agent-home-v1` accepts relative paths after `path.resolve`. | Check `path.isAbsolute(trimmed)` before resolving. | Add manifest path normalization test. | Pending |
| R-009 | P1 | Runtime status | MCP presence detection is Linux-specific and misreports on macOS. | Replace `/proc` check with cross-platform `ps` or shared pid/state contract. | macOS relay unit/smoke test and existing push relay tests. | Pending |
| R-010 | P1 | Remote CLI | Remote CLI advertises commands that are not packaged. | Include scripts or remove remote-only unsupported dispatch entries; audit dispatch targets. | Remote audit command plus dispatch-target existence test. | Pending |
| R-011 | P1 | MCP auth | Codex MCP launch auth can be incomplete for non-v1 agents. | Coordinate with active `agent-up` work; inject auth env explicitly or rely on generated agent tokens. | MCP authenticated backend smoke test. | Pending; do not edit `bin/agent-up` yet |
| R-012 | P2 | MCP media | MCP cache writes into current project directory. | Move cache under agent state tmp or runtime data dir. | Attachment localization test verifying cache path. | Pending |
| R-013 | P2 | CLI shutdown | `agent-down --kill` can be blocked by backend outage. | Add explicit emergency local kill path; backend offline mark best-effort. | CLI test with backend unavailable. | Pending |
| R-014 | P2 | Remote sync | Remote `agent-up` drifted from root launch behavior. | Coordinate with active launch work; regenerate remote package and enforce sync. | `npm run build:remote:check`. | Pending; do not edit `remote/bin/agent-up` yet |
| R-015 | P2 | CLI portability | `agent-service` uses bash 4 associative arrays. | Replace with bash 3.2-compatible implementation. | macOS bash 3.2 smoke plus `bash -n`. | Pending |
| R-016 | P3 | Push delivery | Tmux injection sequence is over-defensive. | Use paste-buffer plus one submit; introduce CLI adapter behavior. | Manual Claude/Codex tmux delivery smoke. | Pending |
| R-017 | P1 | Dashboard auth | Dashboard is a privileged unauthenticated proxy and tmux write surface. | Add dashboard auth/local-only gates and protect queue mutation/injection paths. | Supertest coverage for unauthenticated mutating APIs plus local-only config smoke. | Pending |
| R-018 | P1 | Matrix trust | Matrix trust and command ACL defaults are fail-open. | Default mutating commands to enforce trust; empty ACL permits only public/read-only commands. | Bot command ACL tests for empty config and untrusted rooms. | Pending |
| R-019 | P2 | Supervisor boundary | Backend initializes Supervisor lifecycle side effects. | Gate lifecycle with explicit enablement or move it out of backend; keep snapshot API only. | Backend startup test with lifecycle disabled; supervisor parity check. | Pending |
| R-020 | P3 | Supervisor CLI | `write-supervisor-state start` advertises a registration path it lacks. | Fix command wording or add actual registration/provisioning call. | CLI help/output test. | Pending |
| R-021 | P3 | Supervisor routing | Escalation target is hard-coded to `ac-topleader`. | Add configurable target/group with startup validation. | Unit test target config and missing target fallback. | Pending |
| R-022 | P1 | Remote package | Remote package sync checks fail and standalone push relay paths are inconsistent. | Coordinate active launch work, regenerate remote package, and require sync checks in CI. | `npm run build:remote:check` and `npm run check:remote-sync`. | Pending; do not edit `remote/bin/agent-up` yet |
| R-023 | P2 | Subconscious edge auth | Upstream/runtime endpoints have weaker per-agent auth than event ingest. | Require hook token or agent token for all per-agent subconscious writes/invokes. | API tests for cross-agent local caller denial. | Pending |
| R-024 | P1 | Dependency security | Dependency audit fails and CI does not enforce dependency/remote checks. | Upgrade/replace vulnerable dependency chain or document temporary allowlist; add dependency and remote checks to CI after drift is reconciled. | `npm run audit:deps`, remote audit, CI run. | Pending |
| R-025 | P1 | Data contract | Production JSON stores lack schema versions and migrations. | Add schema/version/migration contract for core stores before larger refactors. | Store fixture migration tests and normalization tests. | Pending |
| R-026 | P2 | Config truth | `.env.example` documents unsupported/misleading auth and Supervisor options. | Implement documented behavior or update env docs to match code. | Env usage grep plus token mode tests. | Pending |
| R-027 | P2 | Data safety | Backend startup can mutate real data during read/check. | Add read-only/check-data mode and dry-run migration path. | Corrupt JSON and migration dry-run tests. | Pending |
| R-028 | P2 | Test harness | Backend test helper has stale supervisor filename and env restoration gaps. | Update helper to current files and restore all changed env vars. | Targeted helper cleanup regression test. | Pending |
| R-029 | P3 | Local verification | Current checkout lacks installed dev dependencies. | Run/document `npm ci` before local verification; avoid production-only install for dev. | `npm ci && npm test`. | Pending |
| R-030 | Medium | Docs | Existing docs mix current v1 flat workspace rules with old `docs/{agent}` conventions and stale route tables. | Create a stale-doc/archive index, update or archive old docs after approval, and make README/docs agree on kernel/edge boundaries. | Documentation link check plus route grep. | Pending |

## Approval Gate

Implementation starts only after this table is complete enough for ac-topleader review.
