# Stable Merge-Execution Hygiene Plan

## Scope
This note covers only the merge-execution hygiene needed after the accepted final merge-readiness confirmation.

It covers:
- the final human/operator sanity pass against the accepted maturity contract
- the branch choreography for `master -> stable`
- the required stable-update and release-note obligations
- the minimum work that must remain post-merge rather than silently reopening merge gating

It does not cover:
- new implementation
- UI expansion
- hook expansion
- new architecture work unless a fresh blocker is actually proven during the sanity pass

## Preconditions
This plan assumes the following accepted baseline is still the current branch truth:
- no explicit structural blocker remains before `master -> stable`
- default subconscious detail is upstream-authoritative by default
- manual guidance is fallback-only on the default operational surface
- local subconscious runtime, memory, and conversation are transitional rather than co-equal authority
- privileged subconscious internals remain debug-only
- supervisor lifecycle truth remains separate from observational `runtimeLaunch`
- v1 manifest-first reads remain authoritative for v1-owned fields

If any of those stop being true during the sanity pass, the merge should pause and the newly proven blocker should be recorded explicitly.

## 1. Final Human/Operator Sanity Pass
This pass is not a new design review. It is a final check that the branch still matches the already accepted contract.

### Required route/surface checks
1. Verify default subconscious operational detail still matches the accepted authority split.
- Check backend and web proxy `GET /api/subconscious/detail/:name`.
- Confirm default detail still presents:
  - authoritative upstream behavior path
  - fallback-only manual guidance
  - transitional local runtime/memory/conversation
- Confirm default detail still does not expose debug-only internals or local-runtime behavior as stable authority.

2. Verify privileged debug detail is still gated.
- Check backend `GET /api/subconscious/detail/:name?debug=1`.
- Confirm privileged upstream/runtime file/path detail is available only there.
- Confirm default route still omits those fields.

3. Verify explicit control-plane routes still carry configuration-only detail.
- Check `GET /api/agents/detail/:name`.
- Confirm writable guidance text remains there rather than reappearing on the default subconscious route.

4. Verify unified Agent Detail still reflects the accepted stable framing.
- Check `GET /agents/:name`.
- Confirm the page still leads with the authority/fallback/transitional framing rather than older dual-path ambiguity.

5. Verify supervisor routes still preserve truth-source separation.
- Check `GET /api/supervisor/agents/:name` on backend and web.
- Confirm `classification` and `lifecycleState` remain canonical supervisor truth.
- Confirm `runtimeLaunch` remains observational runtime state rather than a substitute truth source.

6. Verify no new merge-scope drift has landed.
- Review the diff intended for `stable`.
- Confirm there is no accidental new feature surface, new architectural branch, or unreviewed behavior outside the accepted convergence set.

### Decision rule
- If every check passes, proceed to merge choreography.
- If a check fails but the failure is documentation or release-note hygiene only, fix the hygiene item and continue.
- If a check proves a new structural truth mismatch, stop the merge and record it as a blocker rather than improvising a hidden exception.

## 2. Branch Choreography And Merge Sequence
The merge should be treated as a controlled promotion of an already accepted contract, not as another development pass.

### Recommended sequence
1. Freeze the merge scope to the accepted convergence set.
- Do not bundle extra cleanup, convenience refactors, or opportunistic feature work into the merge.

2. Refresh local branch awareness.
- Confirm current branch is `master`.
- Confirm target branch is `stable`.
- Confirm there is no ambiguity about which committed state is intended to move.

3. Review the effective `master -> stable` delta as a release candidate.
- Use the final merge-readiness confirmation and this hygiene plan as the review contract.
- Human-review the diff for contract drift, not for reopening accepted architecture debates.

4. Apply the final sanity pass on the exact candidate state.
- Run the route/surface checks above immediately before the merge.
- Avoid checking against stale prior observations.

5. Merge `master` into `stable` with a clean, auditable branch step.
- Keep the merge action separate from unrelated local experimentation.
- Preserve a clear merge boundary for later rollback or release-note reference.

6. Perform the minimum post-merge smoke confirmation on `stable`.
- Re-run the small route set that proves the accepted maturity contract:
  - default subconscious detail
  - privileged debug detail
  - explicit agent-detail control plane
  - unified Agent Detail page
  - supervisor agent detail

7. Record the stable merge result.
- Append the outcome and any narrowly scoped post-merge follow-up items.
- Do not silently treat post-merge drift as already accepted.

## 3. Required Stable-Update And Release-Note Obligations
The stable update should document the contract that is now being promised, including what is intentionally not promised yet.

### Stable release note must state
1. Newly stable surfaces.
- canonical v1 manifest-first ownership for v1-owned fields
- canonical `task` and `runtimeProfile` control-plane behavior
- minimal supervisor classification/lifecycle model
- same-host tmux-backed sibling supervisor runtime shape and explicit failure taxonomy
- upstream-authoritative default subconscious behavior path
- accepted upstream-backed subconscious slices:
  - `SessionStart`
  - `UserPromptSubmit`
  - `PreToolUse`
  - `Stop`
- inbox-read gate enforcement before outbound message actions

2. Transitional surfaces that remain intentionally non-authoritative.
- local subconscious runtime, memory, and conversation journal surfaces
- manual guidance as fallback/configuration rather than authoritative behavior
- v1 compatibility mirror and backend-row derivative projections for v1-owned fields

3. Debug-only surfaces that are intentionally not part of the default operational contract.
- privileged subconscious detail internals
- raw upstream/runtime file and path detail
- deep runtime troubleshooting detail beyond the default routes

4. Boundaries that remain unchanged.
- no new hook family beyond the accepted upstream-backed slices
- no new stable guarantee that local transitional runtime is behavior-authoritative
- no new stable guarantee that compatibility mirror surfaces are peer truth sources

### Stable update should also call out
- that the merge is a convergence promotion, not a new architecture milestone
- that future cleanup will continue by reducing transitional/compatibility surfaces rather than redefining the stable contract just merged

## 4. Minimum Post-Merge Cleanup That Must Remain Post-Merge Work
These items should stay explicitly post-merge. They are worthwhile, but they are not reasons to delay the current merge unless one becomes a newly proven blocker.

1. Reduce or remove the remaining v1 compatibility-mirror dependency.
- Goal: make `meta.json` more clearly optional and compatibility-only.

2. Further shrink transitional subconscious local-runtime exposure.
- Goal: keep narrowing compatibility/debug-only surfaces without reopening the accepted authority contract.

3. Refine supervisor runtime operations ergonomics.
- Goal: improve operational tooling and observability without changing canonical lifecycle/task truth.

4. Clean up release and contract documentation after the merge lands.
- Goal: align stable-facing docs with the merged maturity contract and remove any stale pre-convergence wording.

These are cleanup and hardening tasks. They should be tracked after merge, not bundled into the merge gate by default.

## Merge Recommendation
Proceed with `master -> stable` if the final sanity pass confirms the already accepted contract on the exact candidate state.

At this stage, the gating work is execution hygiene only:
- verify the accepted contract one last time
- merge with a clean branch boundary
- publish the stable contract truthfully
- keep remaining cleanup explicitly post-merge

## Bottom Line
No new architecture slice is required by this plan.

The correct next move is a disciplined merge process:
- confirm the accepted contract on the exact candidate
- merge `master -> stable`
- document the stable/transitional/debug-only boundary truthfully
- keep further cleanup as explicit post-merge work
