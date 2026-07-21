# octos runtime

`octos` is supported as a third agent runtime alongside `claude` and `codex`.
It launches the [octos](https://github.com/…/octos) Rust CLI (`octos chat`) into
a tmux pane, joins the mesh via the agent-chat MCP server, and receives/replies
to messages like any other agent.

## Usage

```bash
agentchat up <name> <path> octos [--model <model>] [--extra-args "..."]
# or v1:
agentchat up-v1 <name> octos --project <path>
```

## How it differs from claude/codex

| Aspect | claude / codex | octos |
|---|---|---|
| MCP wiring | `.mcp.json` (claude) / `-c` TOML overrides (codex) | `<path>/.octos/config.json` `mcp_servers[]` (client config), **merged into** the user's existing octos config to preserve provider/model/key |
| Bootstrap prompt | passed as launch arg after `--` | typed into the REPL via `tmux send-keys` after a short delay (`octos chat` has no init-prompt arg that keeps the REPL open) |
| Resume | resume-id captured from session files | **none** — octos has no `--resume`/`--session-id`; continuity is via `--data-dir` (`<agent-data>/octos`). Effectively always `--fresh`. |
| Trust / subconscious hooks | claude/codex-specific | not applicable (type-gated no-ops) |
| MCP-presence probe | detectable | not detectable by agent-chat's claude-oriented probe → treated like codex in `agentExpectsMcp` to avoid a false `degraded` badge |

## Requirements

- `octos` on `PATH` (e.g. `~/.cargo/bin/octos`).
- A working octos provider/model configured (`octos init`, or an existing
  `~/.config/octos/config.json` / `~/.octos/config.json`). agent-up merges the
  MCP server into a copy of that config; if no provider is found it warns and
  octos will fail at LLM time.
- The agent's tmux pane cwd is the agent path, which is also octos's `--cwd`, so
  it finds `<path>/.octos/config.json` and any root `AGENTS.md`.

## Files changed to add this runtime

- `bin/agent-up`: accept `octos` (arg parse, framework guard, validation);
  `ensure_octos_mcp_config` (merge MCP server into octos config); `octos` launch
  branch (bare REPL + `--data-dir` + delayed bootstrap injection, no resume).
- `bin/agent-up-v1`, `scripts/provision-v1-agent-home.js`: accept `octos` type.
- `server.js`: pane-command runtime probe recognises `octos`.
- `lib/agent-state.js`: `agentExpectsMcp` treats octos like codex.
- `lib/bot-commands.js`: octos client label.

## Manual verification (not yet run end-to-end)

The bash/JS changes are syntax-checked and the config-merge logic is unit-tested
against a real octos config, but a full launch was not exercised. To verify:

1. `agentchat up octos-implementer /tmp/ws octos`
2. `tmux attach -t octos-implementer` — confirm `octos chat` REPL is up and the
   bootstrap prompt was typed and it called `check_inbox()`.
3. From another agent/human: `send_message(to="octos-implementer", ...)` and
   confirm push-relay delivers it and octos replies.
4. Check `<path>/.octos/config.json` contains both the provider block and the
   `agent-chat` `mcp_servers[]` entry.

The load-bearing unknown is step 2/3: whether octos's REPL reliably consumes
`tmux send-keys` injection and the AGENTS.md/prompt drives it to poll the inbox.
