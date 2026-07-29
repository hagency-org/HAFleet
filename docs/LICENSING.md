# Licensing

**Status: Apache 2.0 is the intended license and the files are in place, but the
repository cannot be distributed publicly until upstream consent is obtained.**

Read this before pushing, publishing a release, or publishing a container image.

## The problem

HAFleet is a **fork** of [`shisuiki/agent-chat`](https://github.com/shisuiki/agent-chat),
and that repository has **no license**:

```console
$ gh repo view shisuiki/agent-chat --json licenseInfo
{"licenseInfo": null}
```

A public repository with no license is *all rights reserved*. GitHub's Terms of
Service grant everyone the right to view and fork it **within GitHub**, and
nothing more — no right to redistribute, relicense, or publish derivative
works elsewhere.

HAFleet therefore cannot unilaterally adopt Apache 2.0 for the whole tree,
because most of that tree is not ours.

## Provenance, measured

Measured on this checkout with `upstream` pointing at `shisuiki/agent-chat`:

| | Commits |
|---|---|
| HAFleet total | 773 |
| Inherited from upstream | **717 (93%)** |
| Added by us | 56 (7%) |

Per-file, for the components that matter most:

| File | Upstream commits / total |
|---|---|
| `backend-v2.js` | 223 / 238 |
| `server.js` | 106 / 110 |
| `bridge-matrix.js` | 71 / 85 |
| `lib/mcp-server-core.js` | 22 / 23 |

Reproduce:

```bash
git remote add upstream https://github.com/shisuiki/agent-chat.git
git fetch upstream
git rev-list --count upstream/master..HEAD     # ours
git rev-list --count upstream/master           # inherited
git log --format='%an' upstream/master | sort | uniq -c | sort -rn
```

**Rewriting the upstream portion is not a viable route.** It is not a handful of
files; it is the backend, the dashboard, the bridge and the MCP layer.

## Whose consent is needed

Upstream commits are authored by **five** distinct contributors:

| Author | Upstream commits |
|---|---|
| `shisuiki` | 560 |
| `mayor` | 99 |
| `anantheparty` | 53 |
| `csheargm` | 3 |
| `确定下推自动机` | 2 |

Copyright rests with the authors (or their employers), not with the repository
owner, so a green light from `shisuiki` alone is **not** sufficient. Every author
whose code remains in the tree has to agree.

Our own contributors — `AlexZ` / `Alex` / `AlexZhang` (51) and `ymote` (5) — are
presumably straightforward to canvass internally.

## Routes, cheapest first

1. **Ask upstream to license `agent-chat` under Apache 2.0.** If upstream adopts
   it, our fork inherits a license for the inherited code and Apache 2.0 applies
   cleanly to the whole tree. One email, and the only genuinely clean outcome.
2. **Obtain a written license grant** from each upstream author covering this
   fork specifically. More work, and it must be recorded somewhere durable.
3. **Keep it private.** Entirely legitimate: nothing here requires publication.
   Internal use of an unlicensed fork you control is a different question from
   redistributing it.

Do not pursue "relicense and hope"; that is what this document exists to prevent.

## Suggested first message

> Hi — we maintain a fork of agent-chat at hagency-org/HAFleet and would like to
> contribute back and publish our changes. The repository currently has no
> LICENSE file, which means we cannot redistribute either the original or our
> fork. Would you be willing to add a license — Apache 2.0 would suit us, but MIT
> or BSD-3-Clause work equally well? If other contributors hold copyright in the
> tree, we are happy to help collect their agreement.

## What has already been done in-repo

The Apache 2.0 files are present so that nothing is blocked once consent lands:

- `LICENSE` — the Apache License 2.0 text
- `NOTICE` — attribution, including upstream
- `package.json` — `"license": "Apache-2.0"`

These arrived in a **single isolated commit** so they can be removed cleanly if
consent is refused:

```bash
git log --oneline --grep='chore(license)'
git revert <that commit>
```

## Until consent is confirmed

- **Do not** push this repository public.
- **Do not** publish releases (`.github/workflows/release.yml`).
- **Do not** publish container images (`.github/workflows/publish-image.yml`).
  Both are tag-triggered, so simply do not push a `v*` tag.
- `install/bootstrap.sh` fetches from a public URL and will not work until then.

## Borrowing *from* Apache 2.0 projects is already fine

The restriction is one-directional. Apache 2.0 permits incorporating code into a
proprietary or unlicensed work, provided you:

1. retain copyright, patent, trademark and attribution notices;
2. include a copy of the Apache License; and
3. mark files you changed as changed.

So lifting from `agentscope-ai/AgentTeams` (Apache 2.0) — the credential gateway
in `internal/gateway`, for instance — is legitimate today, as long as those three
obligations are met. Record any such borrowing in `NOTICE`.
