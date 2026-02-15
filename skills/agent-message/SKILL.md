---
name: agent-message
description: Send structured messages between local agents via tmux send-keys. Use when one tmux-based agent needs to request work from another local agent, include a clear source tmux header, and require an explicit reply after completion.
---

# Agent Message

Use for local agent-to-agent requests over tmux.
## Sending a request

Build the payload as a single string with header + body + tool hint:
```
[AGENT_REQUEST] from_tmux:<S:I.P> to_tmux:<target> request_id:<id> reply_to:<S:I.P> task:<one-line-task> [/AGENT_REQUEST]
<task details — concise and actionable>
(To send messages between agents, use: agent-send "<target_pane>" "<message>")
```

Send with a single command:
```
agent-send "<target>" "<payload>"
```
This script handles tmux send-keys and Enter keystrokes automatically. Do NOT use raw `tmux send-keys` directly.
