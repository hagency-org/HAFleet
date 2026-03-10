# Inbox-Read Gate Design

## Goal
Prevent an agent from satisfying actionable notification work by reacting only to the pane-visible notification title/summary. The framework must require a real `check_inbox()` read before the agent can emit outbound progress or reply actions tied to that actionable notification.

## Current Root Cause
Today the backend and push relay can mark a notification as `requiresInboxCheck`, but that bit only rides along in notification metadata and prompt text.

Current hotfix on master/stable:
- actionable notifications now lead with `FIRST ACTION: call check_inbox() now`
- merged actionable unread notifications do the same

That hotfix improves visibility, but it is still prompt-only. The agent framework does not persist a canonical pending inbox-read gate and does not block outbound progress/reply actions until the agent actually calls `check_inbox()`.

## Minimal Canonical State
Keep the canonical state minimal and single-purpose. Do not expand this into generic task state.

Canonical object: `inboxGate`

Fields:
- `requiresInboxCheck: boolean`
- `sourceMsgId: string | null`
- `raisedAt: number | null`
- `reason: "actionable_notification" | "merged_actionable_unread" | null`

Meaning:
- `requiresInboxCheck=true` means the framework is waiting for a real inbox read before allowing outbound progress/reply actions.
- `sourceMsgId` identifies the actionable unread message that raised the gate. For merged unread batches, this is the latest actionable unread id already chosen by the notification builder.
- `raisedAt` is the time the gate was raised. It is operational/debug timing, not task state.
- `reason` distinguishes the two currently real raise paths without inventing a broader workflow taxonomy.

Why this is the minimum:
- `requiresInboxCheck` is the actual policy bit.
- `sourceMsgId` is the convergence anchor between notification delivery and later `check_inbox()` acknowledgement.
- `raisedAt` is enough to debug stale gates without introducing counters or a second inbox state machine.
- `reason` keeps the boundary explainable without creating a task system.

Not part of canonical state:
- unread counts
- human/request booleans
- queue ids
- full unread payload snapshots
- reply-routing instructions
- commentary/final text

Those remain transport or debug data, not the policy truth source.

## Raise Event
The gate is raised only when the framework already knows the notification is actionable.

Raise sources:
- backend actionable single notification where current code already sets `notifyMeta.requiresInboxCheck=true`
- backend merged unread actionable notification where current code already sets `notifyMeta.requiresInboxCheck=true`

Raise rule:
- when notification delivery is accepted for an actionable notification, persist `inboxGate.requiresInboxCheck=true` with `sourceMsgId`, `raisedAt`, and `reason`
- non-actionable notifications must not raise the gate
- MCP absence must not fake success; if there is no MCP path, the gate should not be raised by this mechanism

## Acknowledgement Event
The only acknowledgement event that clears the gate is a successful `check_inbox()` call that actually advances the agent’s inbox read boundary for the pending actionable unread set.

Canonical acknowledgement event:
- `inboxReadAck`

Fields:
- `sourceMsgId: string | null`
- `ackedAt: number`

Clear rule:
- after `check_inbox()` completes successfully, inspect the unread set that was returned/consumed
- if the pending `sourceMsgId` is no longer unread because that `check_inbox()` call advanced past it, write `inboxReadAck` and clear `inboxGate.requiresInboxCheck`
- if `check_inbox()` previews or otherwise fails to consume the pending actionable unread, do not clear the gate

Important boundary:
- the acknowledgement is tied to the real inbox cursor advance, not to the agent merely calling a tool named `check_inbox()`
- this keeps the gate aligned with the actual unread truth source already maintained by the backend cursor

## Where the Gate Runs
The gate should run in the agent execution framework boundary, not in prompt text and not in the backend notification builder.

Required enforcement point:
- before outbound progress/reply actions leave the agent runtime

Specifically, block until acknowledged before allowing:
- commentary/progress messages to the user/operator about handling the notified work
- outbound MCP replies such as `send_message(...)` or `post(...)`
- final channel replies that claim completion of the notified work

Specifically, do not block:
- the `check_inbox()` call itself
- safe local reads needed to decide what to do next
- internal planning/thinking that does not emit an outbound action

Why this boundary is correct:
- the failure mode is not that notifications are generated incorrectly; it is that the executor can continue outward without first reading inbox truth
- blocking only at backend delivery would not prove the agent actually read anything
- blocking only in prompt text remains advisory and bypassable

## Distinction From the Prompt Hotfix
Prompt-only hotfix on master/stable:
- changes notification wording so `check_inbox()` is the first visible instruction
- still allows an agent to ignore that instruction and continue with outbound progress or replies
- does not create a machine-checkable acknowledgement event

Framework-enforced boundary in this design:
- persists one canonical pending gate when actionable notification delivery occurs
- clears it only after a successful `check_inbox()` acknowledgement tied to real cursor advance
- denies outbound progress/reply actions while the gate is pending

In short:
- hotfix = better wording
- gate = real state + real acknowledgement + real enforcement

## Minimum Proof For a Future Implementation
A correct implementation should prove all of the following:
- actionable notification delivery raises `inboxGate.requiresInboxCheck=true`
- an outbound progress/reply attempt before `check_inbox()` is denied by the framework
- a successful `check_inbox()` that consumes the pending actionable unread clears the gate
- the same outbound action then succeeds without any prompt wording dependency
- non-actionable notifications do not raise the gate

## Non-Goals
This design does not introduce:
- a new task system
- inbox UI changes
- hook expansion
- unread payload persistence as canonical state
- generic workflow orchestration beyond the single inbox-read boundary
