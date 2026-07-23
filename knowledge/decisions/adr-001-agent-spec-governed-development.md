---
kind: decision
id: ADR-001
title: "Use agent-spec contracts and KLL as governed project truth"
status: Accepted
liveness: n/a
tags: [agent-spec, governance, knowledge]
---

## Context

agent-chat has accumulated implementation plans and architecture documents, but
security-sensitive behavior has not consistently been connected to executable
acceptance contracts or stable decision identifiers. This makes it difficult
for coding agents to distinguish current project truth from historical prose.

## Decision

The project uses agent-spec as its contract and knowledge workflow. Durable
requirements and decisions live in typed `knowledge/` artifacts, active work
lives in `specs/` Task Contracts, and task specs link back through `satisfies`.
`agent-spec parse`, `lint`, and `lifecycle` are required evidence for bounded
implementation tasks.

## Consequences

Good, because agents can retrieve stable decisions and mechanical acceptance
criteria instead of reconstructing intent from chat history.

Bad, because changes now carry additional authoring and maintenance work, and
the optional live-wiki generator cannot yet be enabled in this repository until
its traversal respects ignored runtime and dependency directories.

## Alternatives Considered

- Keep decisions only in `docs/`: rejected because prose has no stable liveness or task linkage.
- Put all project knowledge in generated wiki pages: rejected because generated working memory is not governed truth.
