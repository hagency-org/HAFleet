---
kind: decision
id: ADR-033
title: "Bound native controls to exact process and request evidence"
status: Accepted
tags: [herdr, verification, recovery]
---

## Context

The operator authorized repairing the remaining Robrix → HAgency → native
middle → Herdr/Octoloop closure failures. Q3 consumed its fixed window while
generated controls misread relative capture paths, split tokenized argv,
compared mutable process state, collided with readonly outputs and captured a
response fence after dispatch. All failed attempts remain evidence.

## Decision

Provide tested Node22 middle-agent helpers with exact process metadata,
create-only evidence and pre-send native request correlation. Keep the core
separate from a Darwin/Herdr adapter. Explicit readonly plans pin CLI input
bytes, supported operations and the existing goal identity. Every mutation
claims a unique operation and records intent before dispatch; uncertainty never
causes an automatic replay. A successful query or control is not whole-task
acceptance, and this helper does not write business implementation or task state.

Use the existing Darwin collector for birth metadata and Herdr's actual argv
arrays for foreground processes. Do not invent argv by splitting ps output or
turn a missing observation into permission. Unsupported platforms remain
explicitly unsupported until they have an adapter and verification.

## Alternatives and limits

Continuing to generate one-off scripts during the timed run reproduced the
same errors and delayed approvals. Enlarging the runtime deadline would hide
that cause. A broad arbitrary-command driver would make concrete review
harder. The selected tool therefore starts with inspect, pause and resume of
an existing goal; loop and fault orchestration remain separately reviewed
parts of the full acceptance workflow.

Tests exercise local files and child fixtures. Deployment and the remaining
live closure gates require their own evidence. Existing Q3 manifests and
consumed observer claims must not be altered to fit this implementation.
