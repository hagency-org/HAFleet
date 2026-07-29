# Rollback

Two paths deploy code, so there are two rollback stories. Both are automatic;
this document is for understanding and for the cases where automation gives up.

| Path | Trigger | Rollback |
|---|---|---|
| Auto-deploy watcher | a commit lands on the deploy branch | automatic + quarantine |
| `upgrade.sh` | an operator runs it | automatic revert to the pre-upgrade ref |

## The failure mode this replaced

A failed deploy used to set `deploy_pending=true` and continue. Because
`origin/<branch>` had not moved, the next poll re-deployed **the same bad
commit** — every 30 seconds, indefinitely. `last-successful-ref` was already
being written but was only read to pick a dependency-install base; nothing ever
reset back to it.

## Auto-deploy watcher

On a health-gate failure the watcher now:

1. **quarantines** the failed ref in `<state>/quarantined-ref`;
2. **rolls back** — resets the live checkout to `last-successful-ref`, reinstalls
   dependencies for it, restarts, and re-runs the health gate;
3. **records** the failure to `<state>/last-failure` as JSON;
4. **alerts**, if `AGENTCHAT_ALERT_URL` and `AGENTCHAT_ALERT_TOKEN` are set
   (best-effort — an alerting failure never masks the deploy failure);
5. **holds.** The quarantined ref is not retried. The watcher logs `HOLDING`
   once and waits for a new commit.

Pushing any new commit clears the quarantine automatically, so shipping a fix is
the normal recovery. No manual state cleanup.

State lives in `$(git rev-parse --absolute-git-dir)/agentchat-autodeploy/`
unless `AGENTCHAT_DEPLOY_STATE_DIR` overrides it:

| File | Meaning |
|---|---|
| `last-successful-ref` | last ref that passed its health gate — the rollback target |
| `quarantined-ref` | ref that failed; will not be retried |
| `last-failure` | `{"ref","stage","rollback","at"}` |
| `install-needed` | dependency install must be retried |

### Retryable versus quarantined

Not every failure quarantines, and the distinction is deliberate:

- **Dependency install failure** → retried. Usually transient (registry blip),
  and retrying costs nothing. Tracked by `install-needed`.
- **Health-gate failure** → quarantined. The commit itself is bad; retrying
  produces the same result and keeps the service down.

### Checking state

```bash
STATE="$(git rev-parse --absolute-git-dir)/agentchat-autodeploy"
cat "$STATE/last-failure"        # what failed, and whether rollback worked
cat "$STATE/quarantined-ref"     # what is being held
cat "$STATE/last-successful-ref" # what is running now
journalctl -u agent-chat-stable-autodeploy -n 100
```

## Operator-driven upgrade

```bash
./upgrade.sh --list            # current version and available releases
./upgrade.sh --to v1.3.0       # gate, apply, health-check, revert on failure
./upgrade.sh --to v1.3.0 --dry-run
```

`upgrade.sh` refuses to run on a dirty tree, because a dirty tree cannot be
restored reliably. It gates the **target** ref in a throwaway worktree, so a
target that fails `verify:ci` never touches the live checkout. If the new
version starts but is unhealthy, it reverts to the pre-upgrade ref, reinstalls,
and restarts.

Exit codes:

| Code | Meaning |
|---|---|
| `0` | upgraded, healthy |
| `1` | upgrade failed, **rollback succeeded** — host is on the old version |
| `2` | upgrade failed **and rollback failed** — needs manual recovery |

Exit `2` is the only outcome requiring a human.

## Manual recovery

If rollback itself failed, both paths print the exact commands. In full:

```bash
cd /path/to/install
systemctl stop agent-chat agent-chat-push-relay bridge-matrix

# Return to the last ref known to have been healthy.
STATE="$(git rev-parse --absolute-git-dir)/agentchat-autodeploy"
git checkout --force "$(cat "$STATE/last-successful-ref")"
npm install --production

systemctl restart agent-chat-v2
curl -sf http://127.0.0.1:8090/api/agents >/dev/null && echo "backend healthy"
systemctl restart agent-chat agent-chat-push-relay
```

If `last-successful-ref` is also unhealthy, pin a known-good release instead:

```bash
git fetch --tags
./upgrade.sh --to v1.2.0 --skip-gate --yes
```

## Data is not rolled back

Code rolls back; **`data/` does not.** Nothing here reverts JSON state, and a
release that changes on-disk layout is a breaking change requiring a migration
(see [RELEASING.md](RELEASING.md)). Before upgrading across such a release:

```bash
systemctl stop agent-chat agent-chat-v2
tar -czf ~/hafleet-data-$(date -u +%Y%m%dT%H%M%SZ).tar.gz data/
```

`.env` and `~/.agentchat` are likewise untouched by rollback, which is
deliberate — the uninstaller makes the same guarantee.
