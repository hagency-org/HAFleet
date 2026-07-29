# Releasing

## Versioning

HAFleet follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Because this is an operator-facing deployment rather than a library, the public
surface that governs a major bump is:

| Surface | Covered by SemVer |
|---|---|
| REST API paths, request/response shapes | Yes |
| MCP tool names and schemas | Yes |
| `agentchat` CLI subcommands and flags | Yes |
| `.env` variable names and defaults | Yes |
| Message `schema.kind` contracts (`task_request`, `task_result`, …) | Yes |
| systemd unit names | Yes |
| On-disk JSON layout under `data/` | Yes — a breaking change needs a migration |
| Internal module paths under `lib/` | No |
| Dashboard HTML/CSS structure | No |
| Log line wording | No |

- **Major** — removing or repurposing anything in the covered rows.
- **Minor** — additive: new endpoints, tools, flags, optional env vars.
- **Patch** — fixes that keep every covered surface intact.

Pre-releases use `-beta.N` / `-rc.N` and publish as GitHub pre-releases.

## Release and revision are different things

Two identities, deliberately separate — do not conflate them:

- **release** — the semver, e.g. `1.2.0`. Answers "which release is this?"
- **revision** — the git short SHA, e.g. `7d64e3a`. Answers "which commit?"

`verify-remote --expect-version` compares the **revision**, and the server
registry records it. That meaning predates release versioning and must not
change. `lib/version.js` exposes both, and `resolveBuildIdentity()` returns them
together.

Resolution order, highest first:

1. `build-info.json` — written by `scripts/stamp-version.sh` at build time
2. `package.json` version (release) / `git rev-parse --short HEAD` (revision)

The stamp exists because generated standalone packages have no `.git`, so
`git rev-parse` returned nothing there and those builds carried no identity at
all.

## Cutting a release

```bash
# 1. Land everything, then verify from a clean tree.
npm run verify:ci
npm test

# 2. Move Unreleased into a version section, with today's date.
$EDITOR CHANGELOG.md

# 3. Bump package.json. The tag and this value must agree or the workflow fails.
npm version 1.3.0 --no-git-tag-version

# 4. Commit, tag, push.
git commit -am "chore(release): 1.3.0"
git tag v1.3.0
git push origin master --follow-tags
```

Pushing the tag triggers `.github/workflows/release.yml`, which:

1. refuses to continue if the tag disagrees with `package.json`;
2. runs `verify:ci` and `npm test`;
3. builds **both** artifacts and stamps them `channel=release`:
   - `hafleet-<version>.tar.gz` — full stack, from `git archive` at the tag so
     uncommitted work cannot leak in, with `build-info.json` stamped because the
     unpacked tree has no `.git`
   - `hafleet-remote-<version>.tar.gz` — remote relay package
4. produces reproducible tarballs plus `SHA256SUMS`;
5. creates the GitHub Release using the matching `CHANGELOG.md` section.

Re-cut an existing tag with the `workflow_dispatch` input if a publish step
failed. Note the tarball is byte-reproducible for a given tag, so re-cutting
yields the same checksum.

## Rolling back

See [docs/ROLLBACK.md](ROLLBACK.md). Rollback depends on tagged releases — that
is why release identity landed first.

## Deliberately not published

- **npm.** `package.json` keeps `"private": true`. This is a deployed service,
  not a library, and nothing imports it as a dependency.
- **Container images.** See Phase 3 in [docs/DEPLOYMENT.md](DEPLOYMENT.md).
- Anything at all, publicly, until [docs/LICENSING.md](LICENSING.md) is
  resolved. The repository currently has no license.
