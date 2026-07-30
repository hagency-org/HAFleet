# Deployment

Five supported install paths. Pick by what the host is for.

| Path | Host | Use when |
|---|---|---|
| [Bootstrap](#1-bootstrap-recommended) | Linux + systemd | The normal case: this machine owns the backend, dashboard and local agents |
| [Manual clone](#2-manual-clone) | Linux + systemd | You want the checkout somewhere specific, or to review before installing |
| [macOS](#3-macos) | macOS | A Mac host: launchd + the supervised-services runtime |
| [Containers](#4-containers) | Linux, macOS, Windows | Backend and dashboard only, no local agents |
| [Remote relay](#5-remote-relay) | Linux or macOS | This machine only runs agents reporting to a backend elsewhere |

## 1. Bootstrap (recommended)

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/hagency-org/HAFleet/master/install/bootstrap.sh)
```

Clones at the newest release tag and hands off to `install-full.sh`. Installer
flags go after `--`:

```bash
bash <(curl -fsSL .../bootstrap.sh) -- --dry-run
bash <(curl -fsSL .../bootstrap.sh) --ref v1.2.0 -- --with-bridge
bash <(curl -fsSL .../bootstrap.sh) --list          # available releases
```

It downloads the published release tarball and **verifies it against
`SHA256SUMS`** before unpacking — no git required, and the bytes are exactly what
CI built. A checksum mismatch aborts outright rather than falling back. It clones
only when installing a branch or commit, or when a tag has no published artifact.

It pins a release rather than a branch tip, so installs are reproducible. If no
tags exist yet it falls back to `master` and **says so** — that is a moving
target, not a release.

## 2. Manual clone

```bash
git clone https://github.com/hagency-org/HAFleet.git
cd HAFleet
git checkout v1.2.0        # pin a release
./install-full.sh --dry-run # review first
./install-full.sh
```

`--dry-run` prints every action without touching the system, including the
rendered unit files.

### With the Matrix bridge

```bash
./install-full.sh --with-bridge
```

The installer generates `MATRIX_BRIDGE_SECRET` if absent, but
`MATRIX_BOT_PASSWORD` must already exist in `.env` — it authenticates against an
account on your homeserver and cannot be minted locally. The install fails with
guidance rather than leaving a dead bridge behind.

## 3. macOS

`install-full.sh` refuses to run on macOS because it renders systemd units. Use:

```bash
./install/install-macos.sh --dry-run    # review first
./install/install-macos.sh
```

What differs from the Linux install, all deliberate:

| | Linux | macOS |
|---|---|---|
| Process management | systemd system units | launchd user agent |
| Supervisor | systemd | `services/agentchat-services.mjs` |
| Matrix bridge | opt-in via `--with-bridge` | opt-in via `--with-bridge` |
| Auto-deploy watcher | yes | **no** (tracked as CD-003) |

The launchd agent runs a generated wrapper that sources `.env` (the supervisor
does not auto-load it) and puts Homebrew's prefix on `PATH`, since launchd jobs
start with a minimal environment.

Missing prerequisites (`node >= 22`, `tmux`) are installed with Homebrew unless
you pass `--skip-brew`.

### It will refuse if you already have tmux sessions

HAFleet discovers tmux sessions and registers them as agents; the push relay then
delivers messages by **typing into their panes**. On a host with unrelated tmux
sessions that means HAFleet can type into someone else's work — observed for real
on a fleet host, where a fresh install claimed five pre-existing sessions.

The installer lists them, explains the consequence, and stops. Either stop or
rename them first, or pass `--allow-existing-tmux` to accept the risk knowingly.

### Managing it

```bash
node services/agentchat-services.mjs status --profile services-macos.json
node services/agentchat-services.mjs doctor --profile services-macos.json
launchctl bootout gui/$(id -u)/io.hafleet.services      # stop
tail -50 logs/launchd.err.log
```

## 4. Containers (team profile, Linux only)

Not the supported install path — paths 1–3 are. This is the team Compose profile
from `services/FSF0-B1-IMPLEMENTATION-PLAN.md`, kept because it is tested
(`tests/services-team-compose.test.js`, `tests/bridge-container-owner.test.js`),
not because it is recommended.

```bash
docker compose -f services/services-team.compose.yml up -d
```

Builds `services/Dockerfile` locally. No image is published to any registry.

Uses `network_mode: host` throughout (and `pid: host` for the bridge), so it does
**not** work on Docker Desktop for macOS or Windows. Because it shares the host
network namespace, the services keep their loopback defaults — do not set
`AGENT_CHAT_BACKEND_HOST` / `AGENT_CHAT_WEB_HOST` here.

`services/run-bridge-container.sh` wraps the bridge in `flock` so two containers
cannot both claim bridge ownership.

### It does not run local agents

The relay injects notifications into agents' tmux panes via `tmux send-keys`.
That needs the host's tmux server socket at `/tmp/tmux-<uid>`, which a container
cannot reach — each container gets its own `/tmp`. A containerised relay would
consume the SSE stream and deliver nothing.

Agent-facing delivery therefore stays on the host. If you need local agents, use
path 1, 2, or 3.

### Binding

On a bare host leave `AGENT_CHAT_BACKEND_HOST` / `AGENT_CHAT_WEB_HOST` unset. The
default is loopback, and the auth boundary's loopback trust check assumes the
listener is unreachable off-box. A non-loopback bind is logged loudly every
start; a malformed value falls back to loopback rather than widening it.

Set them only when something in front of the listener terminates access — a
reverse proxy, or a bridge-networked container you have built yourself.

## 5. Remote relay

For machines that only run agents:

```bash
cd remote && ./install-remote.sh
```

Supports Linux (systemd) and macOS (launchd). See [remote/README.md](../remote/README.md).

macOS is behind on one point: the autodeploy watcher is installed only on Linux
(tracked as CD-003). Everything else is at parity.

## Platform support

| Platform | Full stack | Containers | Remote relay |
|---|---|---|---|
| Linux + systemd | Yes | Yes (both profiles) | Yes |
| macOS | via `install/install-macos.sh` | Portable profile only | Yes (launchd) |
| Windows | No | Portable profile only | No |

`install-full.sh` refuses to run on non-Linux rather than half-installing; use
`install/install-macos.sh` there instead. It provides the full stack under
launchd, minus the auto-deploy watcher.

## Upgrading and rolling back

See [RELEASING.md](RELEASING.md) and [ROLLBACK.md](ROLLBACK.md).

```bash
./upgrade.sh --list         # current version, available releases
./upgrade.sh --to v1.3.0    # gate, apply, health-check, auto-revert on failure
```

## Verifying an install

```bash
systemctl status agent-chat-v2 agent-chat agent-chat-push-relay
node services/standalone-doctor.mjs        # cross-component health
agentchat check-mcp                        # MCP registration
node -e 'import("./lib/version.js").then(m=>console.log(m.formatBuildIdentity()))'
```

## Service hardening

All units ship with systemd sandboxing (`NoNewPrivileges`, `ProtectSystem=full`,
capability and syscall restrictions, resource limits). Two directives are
deliberately **absent** and must not be added:

- **`PrivateTmp`** — hides tmux's server socket at `/tmp/tmux-<uid>`.
- **`ProtectHome`** — the runtime tree (`WorkingDirectory`, `data/`, `logs/`)
  lives under the service user's home.

`tests/systemd-hardening.test.js` asserts both the required directives and the
absence of these two.

### Verified on real systemd

Previously this was reasoning only. Validated 2026-07-30 on Amazon Linux 2023
(systemd 252, node 22.23.2):

| Check | Result |
|---|---|
| `install-full.sh` end to end | completed |
| All three units | `active` |
| **`systemd-analyze security`** | **2.4 OK** on each unit |
| `NoNewPrivileges`, `ProtectSystem=full`, `RestrictSUIDSGID`, `LockPersonality`, `SystemCallFilter` | confirmed in effect via `systemctl show`, not just present in the file |
| `PrivateTmp=no`, `ProtectHome=no` | confirmed |
| **tmux reachable through the sandbox** | confirmed — `tmux ls` run under the unit's exact properties via `systemd-run` listed the session, and the backend enumerated it within 5s |
| `--with-bridge` without `MATRIX_BOT_PASSWORD` | refused, naming the variable |
| Install from the published release | checksum verified, no git required |

The tmux result is the one that mattered most: omitting `PrivateTmp` was a
judgement call about the socket at `/tmp/tmux-<uid>`, and it is now demonstrated
rather than argued.

The auto-deploy watcher runs unprivileged and escalates only for
`systemctl restart`, via `/etc/sudoers.d/agentchat-autodeploy`:

```
<user> ALL=(root) NOPASSWD: /usr/bin/systemctl restart agent-chat agent-chat-v2 bridge-matrix
```

Its sandbox set is intentionally smaller than the Node services': `NoNewPrivileges`,
`RestrictSUIDSGID` and an empty `CapabilityBoundingSet` all break `sudo`.
