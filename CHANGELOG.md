# Changelog

All notable changes to HAFleet are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release process and the compatibility contract live in [docs/RELEASING.md](docs/RELEASING.md).

## [Unreleased]

### Changed

- Both READMEs rewritten around the name **HAFleet**, covering the five install
  paths, the upgrade and rollback story, release artifacts, and an explicit
  security-posture section separating what is enforced from what is assumed.
- Internal identifiers (`agent-chat`, `agentchat`, `AGENT_CHAT_`, `AGENTCHAT_`)
  are deliberately unchanged: unit names, CLI commands, `.env` variables, the MCP
  server name and `~/.agentchat` are all covered by the compatibility contract in
  docs/RELEASING.md, so renaming them is a major version with a migration.

## [1.2.0] - 2026-07-28

First tagged release. The repository carried 768 commits with no tags, no
releases, and `package.json` pinned at `1.0.0`, so nothing was installable at a
pinned version and a failed deploy had no artifact to fall back to. `1.2.0` is
the starting point: above the stale `1.0.0` without implying a `2.0` rewrite.

### Added

- **Release identity.** `lib/version.js` resolves release (semver) and revision
  (commit) separately, so `verify-remote --expect-version` keeps its existing
  meaning. `scripts/stamp-version.sh` writes `build-info.json` at build time,
  which fixes generated standalone packages reporting no version at all.
- **Tag-driven release pipeline** (`.github/workflows/release.yml`): refuses to
  build when the tag disagrees with `package.json`, runs the full gate, and
  publishes a reproducible tarball plus `SHA256SUMS`.
- **Systemd sandboxing** on every unit — previously zero hardening directives
  across all of them — plus resource limits and restart rate limits.
- `tests/systemd-hardening.test.js`, which asserts both the directives that must
  be present and the two that must never be added.

### Changed

- **The auto-deploy watcher no longer runs as root.** It was `User=root` with
  `Restart=always`, so anything pushed to the deploy branch executed as root
  within one poll interval. It now runs as the service user and escalates only
  for `systemctl restart`, through a narrow sudoers rule.
- **The release gate is on by default.** `AGENTCHAT_RELEASE_GATE` defaulted to
  `none`, meaning untested commits deployed. It now defaults to `worktree`,
  which builds the candidate ref in a detached worktree and runs
  `verify:cd-preflight` before the live checkout is touched.
- CI now gates pull requests targeting `master`. Since `master` is the default
  branch, those PRs previously received no CI at all and were only checked
  after merge.

### Fixed

- `--with-bridge` produced an install that reported success while
  `bridge-matrix.service` was dead: `MATRIX_BRIDGE_SECRET` was never validated
  (the bridge fail-closes without it) and `verify_installation` did not check
  the bridge. The secret is now generated when absent, a missing
  `MATRIX_BOT_PASSWORD` fails the install with guidance, and the bridge is
  verified when requested.
- The README quick-start cloned `shisuiki/agent-chat` — the upstream, not this
  fork — so following the documented steps did not produce HAFleet.

### Known gaps

- Systemd unit changes have not been smoke-tested on a live `systemctl`; they
  were authored on macOS, where `install-full.sh` refuses to run.
- ~~The repository has no `LICENSE`.~~ **Resolved 2026-07-29:** upstream adopted
  Apache 2.0 (commit `aa8e5e5`), so HAFleet is now Apache 2.0 and distributable.
  See [docs/LICENSING.md](docs/LICENSING.md).

[Unreleased]: https://github.com/hagency-org/HAFleet/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/hagency-org/HAFleet/releases/tag/v1.2.0
