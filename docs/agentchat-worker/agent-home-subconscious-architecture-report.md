# Agent Home + Subconscious Architecture Report

Date: 2026-03-06
Author: agentchat-worker
Status: design clarification before implementation

## Executive Summary

The real requirement is not "add claude-subconscious to agentchat".

The real requirement is:

1. Move from a project-centric agent model to an agent-centric runtime model.
2. Give each new agent a stable home directory that contains its own workspace, docs, projects, and runtime state.
3. Make Claude-only subconscious integration land on top of that new model instead of reinforcing the current scattered layout.
4. Expand the web from a passive audit view into an agent management surface for human-maintained metadata.

Subconscious is only one feature inside that larger change.

## What The Operator Is Actually Saying

The requested direction is:

1. Phase 1 only targets Claude Code agents. Codex is explicitly out of scope for now.
2. The current audit page is too narrow. Each agent needs a fuller management page.
3. The current system scatters an agent's identity across multiple repos and folders, so agents cannot reliably manage their own docs or project scope.
4. New-generation agents must be centered around one dedicated working directory per agent.
5. Runtime data should not live inside the `agent-chat` git repo by default.
6. Agent versions are real lifecycle boundaries. Old scattered agents are effectively `0.x`. New fully managed agents start at `1.0`.
7. Because Claude/Codex sessions cannot safely change `pwd` in-place, an agent version/layout cannot be upgraded live. Migration must create a new home or a new agent instance.
8. Project material should live under the agent's own `workdir/` and be managed there by the agent.
9. The immediate goal is to build the new structure first, without migrating arbitrary existing agents yet.

This is a host-model redesign.

## Current Reality In The Codebase

Today the system is still project-attached:

1. Runtime state is anchored under `data/agents/{name}` inside the repo.
2. `meta.json` stores a `path`, and most runtime features treat that path as the agent's real workspace.
3. Agent docs are resolved by searching `workspacePath/docs/{agent}`.
4. The launcher starts an agent directly inside that external project path.
5. Subconscious design drafts currently assume "read docs from the agent workspace", but that workspace is not yet agent-owned.

This means the current architecture still treats the agent as a process attached to some project directory, not as a first-class managed unit.

## Architectural Interpretation

Your intended v1 model is:

1. `agent-chat` repo is the development/deployment codebase.
2. `AGENTCHAT_HOMEDIR` is the runtime root for all managed agents.
3. Each v1 agent gets one dedicated home directory under that runtime root.
4. That home contains the agent's writable working directory, docs, project material, and runtime metadata.
5. Humans and web manage the agent through this home, not by chasing whichever repo the agent was launched from.

In other words:

- old model: agent belongs to a project
- new model: project material belongs to an agent

That distinction is the core redesign.

## Recommended Filesystem Contract

I do not recommend placing trusted runtime control files directly inside the same writable directory where the agent can modify anything. If the agent has arbitrary write access, it should not be able to accidentally or intentionally corrupt its own system-owned resume metadata.

Recommended shape:

```text
$AGENTCHAT_HOMEDIR/
  agents/
    <agent-slug>/
      agent.json
      state/
        runtime.json
        resume-id
        letta.json
        locks/
        history/
      workdir/
        docs/
          AGENTS.md
          CLAUDE.md
          plan.md
          progress.md
          projects.md
        projects/
          <project-a>/
          <project-b>/
        scratch/
        inbox/
        outputs/
```

For this phase, `workdir/projects/` is a required part of the ownership model, not an optional add-on.

## Why This Split Matters

`state/` and `workdir/` should have different ownership models:

1. `state/` is system-owned.
2. `workdir/` is agent-writable.
3. Humans may edit parts of `workdir/docs/` and selected config fields exposed by the web.

Without this separation, the agent can break its own launch invariants by editing files like `resume-id`, `letta.json`, or runtime lock files.

## Naming And Identity

I do not think agent name alone is a sufficient long-term storage key.

Recommendation:

1. Keep a human-facing `name`, for example `umiki-worker`.
2. Also assign a stable internal `slug` or `id`.
3. Use that stable key for home-directory layout and future renames.

Otherwise, a rename becomes a filesystem migration plus state rewrite plus resume mapping rewrite.

## Agent Version Semantics

The operator's "0.4", "1.0" idea is correct, but version must be defined precisely.

I recommend splitting version into two concepts:

1. `agentModelVersion`
   Meaning: the operational generation of the agent.
   Example: `0.x` for legacy project-attached agents, `1.x` for home-based managed agents.
2. `layoutVersion`
   Meaning: the on-disk schema of the agent home.

Why split them:

1. You may evolve the directory schema without redefining the whole product generation.
2. You may want a `1.1` management feature without changing the storage contract.

Minimum rule set:

1. Legacy scattered agents are `agentModelVersion=0.x`.
2. New per-agent-home agents start at `agentModelVersion=1.0`.
3. A running agent cannot be upgraded across model generations in place if that requires a different working directory root.
4. Migration is "create new home -> import docs/project state -> launch new session", not "mutate current session into v1".

## Claude-Only Subconscious Phase

The "Claude only first" decision is technically sound.

Reasons:

1. `claude-subconscious` already exists and has hook points.
2. Codex does not yet have an equivalent supported integration path here.
3. A mixed Claude/Codex rollout would conflate two hard problems: runtime-home redesign and dual-client hook abstraction.

Recommended scope boundary:

1. v1 agent-home contract applies to all future agents conceptually.
2. Subconscious integration Phase 1 is enabled only for Claude agents.
3. Codex remains outside subconscious scope until the agent-home contract and event flow are proven stable.

## Web Management Page: What It Should Actually Be

The current audit page is a telemetry view. What you want next is closer to an agent control plane.

That page should present at least five categories:

1. Identity
   Name, type, version, runtime status, created-at, owner, migration generation.
2. Responsibility
   Role, boundaries, project scope, adjacent systems, human notes.
3. Workspace
   Home path, workdir path, managed projects, hooks enabled, subconscious enabled, model settings.
4. Runtime
   Resume state, Letta state, latest warnings, audit history, blocked state, active session info.
5. Changeable human-managed metadata
   Docs links, editable role/scope notes, project assignments, lifecycle controls.

The critical insight is:

This page should not be "audit plus a few buttons".
It should be the canonical UI for agent definition.

## Strong Engineering Concerns

### 1. Do Not Store System Truth In Agent-Writable Space

If the agent can rewrite all of `workdir/`, then the source of truth for runtime state cannot live there.

### 2. Do Not Treat Project Copy Strategy As Trivial

If every agent gets its own `projects/` folder, you must decide how those project directories are materialized:

1. full clones,
2. git worktrees,
3. symlinks,
4. bind mounts,
5. imported snapshots.

This is not a cosmetic choice. It determines disk cost, drift risk, merge safety, and whether two agents can safely collaborate on the same repo.

My recommendation for shared-code development is separate git worktrees per agent, rooted inside that agent's `workdir/projects/`.

That preserves the "one agent, one pwd" rule while avoiding direct multi-agent writes into the same checkout.

### 3. The Current `docs/{agent}` Convention Needs A v1 Translation

Today docs live under project workspaces as `docs/{agent}/...`.
In v1, the more coherent form is likely:

```text
workdir/docs/
  AGENTS.md
  CLAUDE.md
  plan.md
  progress.md
  projects.md
```

That is simpler than nesting `docs/{agent}` inside an already agent-specific home.

This means the current docs convention likely needs a compatibility layer during migration.

### 4. Existing Runtime Paths Are Hard-Coded Across The System

Current code paths assume:

1. `data/agents/{name}` for metadata,
2. repo-relative `data/`,
3. workspace path coming from `meta.json.path`,
4. docs being discovered from that workspace path.

So `AGENTCHAT_HOMEDIR` is not a one-file change. It is a cross-cutting storage contract change.

### 5. Agent Version Upgrades Must Be Re-Provision, Not In-Place Mutation

Because working directory is operationally sticky, the safe upgrade path is:

1. provision new v1 agent home,
2. copy or import selected docs/projects,
3. start a new agent session there,
4. cut over,
5. archive the old `0.x` agent.

Trying to "upgrade the existing live agent" will create ambiguous state and broken resume guarantees.

### 6. Ports And Internal Service URLs Must Become Configurable

Current runtime still hard-codes key network coordinates in code, especially the local API/web ports and some internal `127.0.0.1` backend URLs.

That is acceptable for the current single-instance deployment, but it becomes a blocker for running a second dev stack on the same machine while leaving live untouched.

So after the current v1 structure batch, a dedicated follow-up should:

1. make backend port configurable,
2. make web port configurable,
3. make internal backend base URLs configurable,
4. keep safe defaults for current deployment,
5. support a second local dev profile without colliding with live ports.

This is not full CI/CD work. It is the minimum runtime parameterization needed for parallel local environments.

### 7. Global Claude/Codex Config Must Become Minimal

The current multi-agent system inherited too much behavior from shared global configuration.

That is fragile for three reasons:

1. global MCP configuration is hard to reason about when different agents need different tool surfaces,
2. global hook/plugin configuration makes rollout and rollback too coarse,
3. global skills/config cause drift between what a given agent should be and what the whole machine happens to expose.

With the v1 agent-home model, the preferred direction should be:

1. keep global Claude/Codex config minimal and generic,
2. move agent-specific MCP/hooks/skills/runtime behavior into the individual agent home,
3. expose those agent-scoped settings in the web management surface.

This aligns with the broader design principle that an agent should be self-contained and manageable through its own home, not through opaque shared machine state.

## Recommended v1 Agent Home Contract

Each v1 agent should have:

1. exactly one home directory,
2. exactly one primary workdir root,
3. exactly one runtime metadata root,
4. exactly one declared version,
5. zero hidden dependency on external project paths.

That last point matters. External paths may still exist, but they must be explicit imports, mirrors, or linked projects, not implicit identity.

## Implementation Strategy

Recommended staged implementation:

### Phase A: Schema Definition

Define and freeze:

1. `AGENTCHAT_HOMEDIR` root,
2. per-agent directory schema,
3. `agent.json` fields,
4. docs layout for v1,
5. project materialization strategy inside `workdir/projects/`.

### Phase B: New-Agent Provisioning

Create a new launcher/provision flow for v1 agents:

1. create agent home,
2. scaffold docs,
3. assign version,
4. materialize projects under `workdir/projects/`,
5. launch Claude from `workdir/`.

This phase does not migrate arbitrary existing agents.

### Phase C: Dual-Read Compatibility

Teach backend/web/CLI to read both:

1. legacy `0.x` repo-relative agents,
2. new `1.x` home-based agents.

Do not migrate everyone immediately.

### Phase D: Claude Subconscious Integration

Only after v1 provisioning exists:

1. inject Claude hooks into the v1 workdir,
2. create per-agent Letta mapping in `state/letta.json`,
3. send structured events back to agentchat.

### Phase E: Web Management Surface

Promote the agent page into the canonical management page for:

1. human-edited role/boundary/project metadata,
2. runtime state visibility,
3. subconscious state,
4. migration state.

### Phase F: Runtime Profile Parameterization

After the v1 structure and Claude-only subconscious batch is stable in dev:

1. parameterize ports and intra-service URLs,
2. define a parallel local dev profile,
3. verify that dev can run beside the existing live stack on the same machine without port collisions.

### Phase G: Agent-Scoped Config Management

After the real subconscious wiring is in place:

1. define what remains global versus what becomes agent-scoped for Claude and Codex,
2. minimize global config to the smallest stable baseline,
3. move MCP/hooks/skills-related behavior toward per-agent configuration,
4. surface those controls in the web management page.

## Suggested `agent.json` Fields

Minimum metadata:

```json
{
  "id": "agent_umiki_worker",
  "name": "umiki-worker",
  "type": "claude",
  "agentModelVersion": "1.0",
  "layoutVersion": 1,
  "homeDir": "/srv/agentchat/agents/agent_umiki_worker",
  "workdir": "/srv/agentchat/agents/agent_umiki_worker/workdir",
  "stateDir": "/srv/agentchat/agents/agent_umiki_worker/state",
  "subconsciousEnabled": true,
  "managedProjects": [
    {
      "name": "umiki",
      "path": "/srv/agentchat/agents/agent_umiki_worker/workdir/projects/umiki",
      "source": "git-worktree"
    }
  ]
}
```

## Interaction With Subconscious

Subconscious should read from the v1 agent workdir, not from arbitrary project roots.

For Claude Phase 1, the clean mental model is:

1. Claude runs inside the agent's `workdir/`.
2. `workdir/docs/` defines self-knowledge and obligations.
3. `workdir/projects/` contains the material it operates on.
4. `state/` contains Letta/runtime integration files that the system owns.
5. Agentchat web and backend read both the human-facing workdir docs and the system-owned state.

That is much more coherent than the current scattered model.

## Challenge Points To Resolve Before Coding

These are the questions I think must be answered explicitly:

1. Is `projects/` allowed to contain symlinks or must it contain real directories only?
2. Is a v1 agent allowed to operate on more than one project at a time?
3. Is renaming an agent supported, or is name immutable after creation?
4. Does `docs/{agent}` get replaced by flat `workdir/docs/*` for v1?
5. Where should `AGENTCHAT_HOMEDIR` live by default on local machines and remote servers?
6. Which files are human-editable in web UI versus filesystem-only?
7. Is `agentModelVersion` per agent immutable after creation?

If these are left fuzzy, implementation will drift.

## My Engineering Position

I agree with the redesign direction.

I also think the filesystem contract must be finalized before writing the subconscious integration, otherwise we will build hooks against the wrong workspace model and have to migrate twice.

So the correct priority order is:

1. define v1 agent-home contract,
2. implement new-agent provisioning without migrating arbitrary existing agents,
3. define the new agent management page as the canonical edit surface,
4. then integrate Claude subconscious on top of that model,
5. then define agent-scoped config management so global Claude/Codex config stays minimal,
6. then parameterize ports/internal URLs so a parallel local dev stack can coexist with live,
7. only after validation decide when legacy agents should migrate.

That is the stable order of operations.
