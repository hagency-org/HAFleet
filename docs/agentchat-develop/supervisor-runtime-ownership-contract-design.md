# Supervisor Runtime Ownership Contract Design

## Scope
This batch is design only for the stable operational ownership contract of sibling supervisor runtimes.

It covers only:
- binary ownership for launched sibling supervisor runtimes
- env ownership and credential/runtime-profile ownership
- launch-failure reporting semantics
- the supported stable deployment shape for supervisor runtimes

It does not cover:
- implementation
- UI changes
- hook changes
- planner or orchestration expansion
- new control-plane objects

## Current Accepted Baseline
These facts are already accepted and must not be reopened by this note:
- canonical `task` state lives on the shared control-plane object
- supervisor classification and lifecycle derive from canonical task state plus time
- lifecycle is binary: `active` or `idle`
- runtime existence is a projection of lifecycle
- the sibling `supervisor/` workspace is real but non-canonical
- supervisor runtime-profile selection order is:
  1. `runtimeProfile.supervisor`
  2. `runtimeProfile.primary` fallback
  3. env/default
- real runtime launch currently uses a deterministic tmux session `supervisor-<agent>`

The missing contract is not whether launch works in dev. It is who owns the operational prerequisites and how failures are classified on stable.

## Problem Statement
The accepted runtime-launch slice proved that lifecycle can drive a real sibling runtime.

It did not yet freeze the stable ownership boundary for:
- who must provide the actual client binary used by the runtime
- who owns the launch env and required credentials
- how launch failures are reported without corrupting lifecycle truth
- which deployment shape is actually supported on stable

Without that boundary, stable would still blur:
- canonical supervision truth
- host provisioning failures
- per-agent profile selection

## Stable Contract
Stable should support exactly one supervisor runtime shape:
- a same-host sibling runtime
- launched by the local supervisor service
- in a deterministic tmux session `supervisor-<agent>`
- with cwd/home set to `<homeDir>/supervisor`
- using framework selected from the canonical shared `runtimeProfile`

Everything else should be treated as unsupported or compatibility-only, not as an implied stable promise.

## Ownership Matrix
### 1. Canonical control-plane ownership
Owned by the primary/shared control plane:
- `task`
- lifecycle derivation inputs
- `runtimeProfile.supervisor`
- `runtimeProfile.primary` fallback

Not owned by the launched supervisor runtime:
- `task.id`
- `task.status`
- `waiting_reason`
- `waiting_until`
- canonical runtime profile content

### 2. Binary ownership
Owned by the host/runtime environment, not by the per-agent control plane and not by the sibling workspace.

Stable rule:
- `runtimeProfile.supervisor.framework` chooses the framework family, not an install path
- the required binary for that framework must already exist on the host PATH visible to the tmux-launched process
- the repo may launch the runtime, but it does not become the package manager or binary installer for `claude`, `codex`, or future supervisor clients

Implication:
- missing binary is a host provisioning failure
- it must not be treated as a task-state failure or lifecycle contradiction

### 3. Env ownership
Owned by the supervisor launcher boundary in `supervisor/index.js`, not by the sibling workspace and not by ad hoc tmux pane state.

Stable rule:
- launch env must be explicitly constructed for every supervisor runtime start
- tmux server ambient env is not authoritative
- PATH must be injected explicitly
- canonical runtime-profile projection env must be injected explicitly
- repo/runtime root env needed for agent context must be injected explicitly

This is required because a tmux pane can exist while still lacking the binary resolution or env needed to run the selected framework.

### 4. Credential ownership
Owned by the host/process environment, not by `runtimeProfile` and not by files under `supervisor/`.

Stable rule:
- `runtimeProfile` may choose framework/provider/model/reasoning/extraArgs
- `runtimeProfile` must never carry secrets
- supervisor LLM keys or provider credentials remain process/host env concerns
- the launched sibling runtime only consumes those credentials if the selected framework/provider actually needs them

Implication:
- missing credential env is an operational launch/runtime failure
- it must not rewrite canonical task/lifecycle truth

### 5. Workspace ownership
Owned by the v1 home layout as durable local context only.

Allowed:
- `<homeDir>/supervisor/CLAUDE.md`
- `<homeDir>/supervisor/AGENTS.md`
- `<homeDir>/supervisor/docs/plan.md`
- `<homeDir>/supervisor/docs/progress.md`
- supervisor-local scratch/log/context files

Forbidden:
- `supervisor/task.json`
- `supervisor/runtime-profile.json`
- any launch-decision file that outranks canonical lifecycle
- any credential file that becomes the new supported source of truth

## Supported Stable Deployment Shape
Stable should support only this deployment shape for real supervisor runtimes:

1. Supervisor service and target agent home are on the same host
2. The host has a working tmux server
3. The selected framework binary is installed and reachable through the explicit launch PATH
4. The sibling workspace exists at `<homeDir>/supervisor`
5. Canonical `task` and `runtimeProfile` are readable from the shared control-plane object
6. Required credential env is already present in the launching process environment

Not part of the stable promise:
- cross-host supervisor runtime launch
- automatic binary installation
- supervisor-local credential discovery files
- a second runtime-profile file under `supervisor/`
- per-agent custom binary path ownership beyond what the selected framework/env already supports

This keeps stable honest: the runtime launch shape is local, sibling, tmux-backed, and host-provisioned.

## Launch Decision And Ownership Boundary
Launch ownership should be split cleanly:

### Supervisor service owns
- deciding whether runtime should exist from lifecycle
- selecting the framework/profile source from canonical runtimeProfile
- constructing the explicit launch env
- starting/stopping the tmux session
- persisting `runtimeLaunch` observational state

### Host/operator owns
- installed binary availability
- credential env availability
- base PATH and shell/runtime prerequisites
- tmux availability on the host

### Sibling runtime owns
- consuming the selected env/profile
- performing its local reasoning/work inside `supervisor/`
- writing only supervisor-local notes/logs that do not become canonical control-plane truth

## Launch-Failure Reporting Contract
Launch failures must be reported as runtime-launch failures only.

They must not:
- change canonical `task`
- rewrite lifecycle classification
- imply the task is done, waiting, or healthy
- create a fake second truth source in the sibling workspace

Stable reporting contract:
- lifecycle remains derived from canonical task state
- `runtimeLaunch.status` reports the runtime process state
- `runtimeLaunch.error` reports host/env/binary failure detail
- `runtimeLaunch.profileSource` reports which runtime-profile source was selected
- `runtimeLaunch.workspaceDir`, `sessionName`, and selected framework/provider/model remain observational launch metadata

### Failure classes
The design should explicitly separate these classes:

1. `unsupported-framework`
- canonical runtimeProfile selected an unsupported framework family
- lifecycle truth unchanged
- operator action: fix runtimeProfile or add support in code

2. `missing-workspace`
- v1 sibling workspace is absent or malformed
- lifecycle truth unchanged
- operator action: reprovision or repair the home

3. `missing-binary`
- selected framework binary is not resolvable on the explicit PATH
- lifecycle truth unchanged
- operator action: fix host provisioning

4. `missing-credential-env`
- selected runtime requires provider credentials that are absent
- lifecycle truth unchanged
- operator action: fix host env wiring

5. `tmux-launch-failed`
- tmux could not create or maintain the runtime session
- lifecycle truth unchanged
- operator action: fix tmux/host runtime

These are all operational/runtime failures. None should be recast as task-state transitions.

## Reporting Semantics In Supervisor State
The stable contract should keep `runtimeLaunch` observational and subordinate to lifecycle.

Required truth:
- `classification` answers the supervision question
- `lifecycleState` answers whether supervision should exist
- `runtimeLaunch` answers whether the projected runtime is actually running

Interpretation order:
1. read lifecycle/classification from canonical task state
2. read `runtimeLaunch` to see whether the runtime projection successfully matched that lifecycle
3. if they disagree, report runtime operational failure, not task-state drift

Example:
- lifecycle `active`
- `runtimeLaunch.status = launch-failed`
- this means supervision is still required, but the runtime failed to start
- it does not mean the task stopped being active

## Credential And Runtime-Profile Boundary
The stable contract must also prevent runtime-profile from becoming a secret/config dumping ground.

Allowed in `runtimeProfile.supervisor`:
- `framework`
- `provider`
- `model`
- `reasoning`
- `extraArgs`

Not allowed:
- API keys
- secret file paths
- per-agent launch ownership flags
- binary installation state

Reason:
- runtimeProfile is canonical workload intent
- credentials and binary availability are host execution prerequisites
- mixing them would blur operator responsibility and make launch failure semantics ambiguous

## Minimum Proof For The Later Implementation Slice
The later implementation should prove exactly these operational ownership claims:

1. Supported stable shape is local and sibling only
- launch succeeds when all prerequisites exist on one host
- cwd/home is `<homeDir>/supervisor`
- no second truth source appears under `supervisor/`

2. Missing binary is reported as operational launch failure
- lifecycle remains `active` when supervision is still needed
- `runtimeLaunch.status` becomes launch failure
- canonical task/lifecycle do not change

3. Missing credential env is reported separately from lifecycle truth
- lifecycle remains derived from canonical task
- launch/runtime failure is visible without mutating task/runtimeProfile

4. Explicit launch env owns PATH/profile projection
- tmux ambient env is not required for correctness
- selected profile source is visible in runtimeLaunch metadata

5. Unsupported deployment shapes are not silently treated as supported
- cross-host or supervisor-local shadow-config setups are rejected, ignored, or documented as unsupported

## Recommended Next Implementation Slice
After this design is accepted, the next narrow slice should not broaden supervisor features.

It should only:
- harden runtimeLaunch status/error taxonomy around the supported local sibling shape
- make missing-binary / missing-credential / missing-workspace failures explicit
- keep lifecycle truth untouched while surfacing those failures clearly

That is the smallest stable-facing slice that closes the remaining ownership ambiguity without reopening supervisor architecture.
