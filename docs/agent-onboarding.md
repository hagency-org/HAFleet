# Onboarding an agent

There are two transports, and which one an agent uses is decided by its framework
adapter, not by you. `lib/frameworks/<id>.json` declares `transport`, and the
launcher refuses the wrong path with a reason rather than half-starting something.

| framework | transport | start it with |
|---|---|---|
| `claude` | tmux | `hafleet up` |
| `codex` | tmux | `hafleet up` |
| `octos` | acp | `hafleet acp-up` |
| `hermes` | acp | `hafleet acp-up` |
| `codex-acp` | acp | `hafleet acp-up` |

`hafleet ls` shows the transport in the `TRANS` column.

## ACP agents

```
hafleet acp-up <name> <workspace> <framework> --supervised
```

`--supervised` is what you almost always want. It registers the agent in the
service profile so the local supervisor restarts it if it dies and brings it back
after a reboot. Without it the agent is a detached process that dies with its
launcher and is never restarted.

The command signals the running supervisor to reload rather than restarting it, so
adding an agent does not disturb the others. It then waits for the agent to become
healthy *and stay* healthy before reporting success — a crash-looping agent fails
onboarding with the reason and the log, rather than being reported as running.

To remove one:

```
hafleet acp-down <name>            # deregister and stop
hafleet acp-down <name> --keep-running   # deregister only
```

This also signals rather than restarts, so removing an agent leaves the rest of
the fleet untouched.

### What onboarding does

1. Refuses the framework if it is not an ACP one, or if `--model` cannot be
   delivered — see *Models* below.
2. Provisions `~/.hafleet/agents/agent_<name>/state/agent-token` (mode 600) if it
   does not already exist. The backend picks up a token minted after it started
   when the agent registers, so no restart is needed.
3. Registers the agent in the service profile (supervised) or spawns a detached
   host (unsupervised).
4. Waits for the host's readiness marker, then reports.

### Models

The model flag an agent's *CLI* accepts is not necessarily the one its *ACP entry
point* accepts. `octos acp` takes `--model`; `hermes-acp` and `codex-acp` do not —
hermes dies on it outright and codex-acp accepts it and silently ignores it. Each
adapter declares `launch.acpModelFlag`, and `acp-up` refuses a `--model` it cannot
actually deliver instead of pretending. Select the model inside the agent
(`hermes model`, `codex` config) when its adapter declares none.

### One agent, one host

An agent must have exactly one host process. Both directions are guarded: going
supervised stops a running unsupervised host, and an unsupervised start is refused
when the supervisor already owns that agent. Two hosts would both poll the same
inbox and both reply.

## tmux agents

```
hafleet up <name> <workspace> <framework>
```

The launcher creates a tmux session, types the init prompt in, and waits for the
framework's declared readiness signal before doing so — without that wait the
keystrokes race process startup and are silently lost.

On a host that already has tmux sessions, the installer needs a stance:
`--deny-existing-tmux` adds them to `HAFLEET_SESSION_DENYLIST` so HAFleet will not
adopt them as agents, `--allow-existing-tmux` proceeds anyway.

## Framework-specific install notes

**hermes** needs two extras, not one: `uv pip install -e ".[acp,mcp]"`. The `acp`
extra provides the protocol library; the `mcp` extra provides the MCP *client*
hermes uses to reach HAFleet's tools. With only `[acp]`, `register_mcp_servers()`
returns nothing at debug level and hermes still logs "refreshed tool surface after
ACP MCP registration (23 tools)" — the count is its own built-ins. The agent starts,
reports healthy, and then declines to answer because it cannot see `check_inbox`.

hermes also needs a model provider of its own. Any of its 35 registry providers
works; the flag-free path is an API key:

    hermes auth add <provider> --type api-key    # prompts, so nothing lands in history
    hermes model                                 # interactive picker, needs a TTY

Or set it directly in `~/.hermes/config.yaml`:

    model: deepseek-v4-flash

Check what a key actually grants before choosing a model name — `hermes model
--refresh` re-fetches each provider's live `/v1/models`.

## Troubleshooting

**"did not stay healthy (restarts=N)"** — the agent starts and dies repeatedly.
The log tail printed underneath carries the real reason. It stays in the profile
and the supervisor keeps retrying; `hafleet acp-down <name>` takes it out.

**"takes no model flag over ACP"** — drop `--model` and set the model inside the
agent.

**"already registered with the supervisor"** — the agent is already supervised.
Use `hafleet service status` to see it, or `acp-down` first to run it unsupervised.

**"is not an ACP framework"** — use `hafleet up` instead.

**An ACP agent stops answering** — the host recycles a session that times out, and
exits after three consecutive failures so the supervisor restarts it. If it is
stuck, `hafleet service status` shows a rising restart count.
