# Licensing

**Status: resolved. HAFleet is Apache 2.0 and is distributable.**

Upstream [`shisuiki/agent-chat`](https://github.com/shisuiki/agent-chat) adopted
the Apache License 2.0 on 2026-07-29 (commit `aa8e5e5`, "Create LICENSE"),
which removes the blocker this document was originally written to describe.

Verify at any time:

```bash
gh repo view shisuiki/agent-chat --json licenseInfo
# {"licenseInfo":{"key":"apache-2.0","name":"Apache License 2.0"}}
```

## Why this mattered

HAFleet is a **fork**, and until that commit upstream published no license. A
public repository with no license is *all rights reserved*: GitHub's Terms of
Service grant the right to view and fork within GitHub and nothing more — no
right to redistribute or relicense elsewhere.

Since **717 commits** of this tree are inherited from upstream, HAFleet could not
adopt Apache 2.0 for the whole tree on its own. That is no longer the case:
upstream and HAFleet are now under the same license.

## Provenance, kept for attribution

Still relevant, because Apache 2.0 §4 requires retaining attribution. Measured
2026-07-29; the inherited count is fixed, ours grows with every commit.

| | Commits |
|---|---|
| Inherited from upstream | **717** |
| Added by us | 56 and counting |

Per-file, for the components that matter most:

| File | Upstream commits / total |
|---|---|
| `backend-v2.js` | 223 / 238 |
| `server.js` | 106 / 110 |
| `bridge-matrix.js` | 71 / 85 |
| `lib/mcp-server-core.js` | 22 / 23 |

Upstream authorship, recorded in `NOTICE`:

| Author | Upstream commits |
|---|---|
| `shisuiki` | 560 |
| `mayor` | 99 |
| `anantheparty` | 53 |
| `csheargm` | 3 |
| `确定下推自动机` | 2 |

Reproduce:

```bash
git remote add upstream https://github.com/shisuiki/agent-chat.git
git fetch upstream
git rev-list --count upstream/master..HEAD     # ours
git rev-list --count upstream/master           # inherited
git log --format='%an' upstream/master | sort | uniq -c | sort -rn
```

## What we ship

- `LICENSE` — Apache License 2.0
- `NOTICE` — attribution, including the upstream authors above
- `package.json` — `"license": "Apache-2.0"`

Note our `LICENSE` and upstream's are not byte-identical (10,774 vs 10,258
bytes); both are the same Apache License, Version 2.0, differing only in the
optional appendix. That is not a conflict.

## Obligations when distributing

Apache 2.0 §4 applies to HAFleet as it does to anything else. When you ship a
release, an image, or a fork:

1. include `LICENSE`;
2. retain the copyright, patent, trademark and attribution notices, which means
   shipping `NOTICE` too;
3. mark files you have changed as changed.

The release tarballs built by `scripts/build-release-package.sh` include both
`LICENSE` and `NOTICE`, because they come from `git archive` of the tracked tree.

## Borrowing from other Apache 2.0 projects

Permitted, subject to the same three obligations. Record any such borrowing in
`NOTICE` — for example if the credential gateway from
[`agentscope-ai/AgentTeams`](https://github.com/agentscope-ai/AgentTeams) is
lifted, note the source project and that the files were modified.

## History

This document previously blocked publication and listed three routes to resolve
the licensing question, the cheapest being "ask upstream to license it." That is
what happened. Kept as the record of why the provenance measurements exist and
why `NOTICE` names five upstream authors rather than one.
