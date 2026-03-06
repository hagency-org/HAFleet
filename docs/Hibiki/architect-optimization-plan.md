# Claude Code Architect-Mode Optimization Plan

## Context

This plan is for a Claude Code agent to investigate and implement changes that optimize Claude Code sessions for sustained, multi-hour, multi-agent architectural reasoning work. The operator runs autonomous agents with custom scaffolding, context injection/recovery, living document worktrees, and real-time heartbeats. **No human-blocking interactions are permitted** — do not use interactive modes, do not prompt for confirmation mid-task, do not use /plan interactively.

The core problem: Claude Code's default system prompt and configuration aggressively optimize for token efficiency and terse code-execution behavior, which degrades reasoning quality for architectural and design work. We need to identify what's consuming context, trim waste, and reshape behavioral instructions toward deeper thinking.

---

## Phase 1: Audit Current Context Composition

**Goal:** Understand exactly what occupies the context window before a single user message is processed.

### 1.1 Extract and measure system prompt components

```bash
# Check Claude Code version
claude --version

# If npm-installed, find the cli.js:
which claude
ls -la $(which claude)
# Follow symlinks to find the actual cli.js or binary

# For npm installs, the main JS is typically at:
# ~/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js
# or in the node_modules path shown by: npm list -g @anthropic-ai/claude-code

# Record file size and modification date
ls -la <path-to-cli.js>
```

### 1.2 Install and run tweakcc to extract prompt files

```bash
npx tweakcc
# Navigate to system-prompts menu
# This will create ~/.tweakcc/ with individual markdown files for each prompt component
```

After extraction, catalog every prompt file and its token count:

```bash
# List all extracted prompt files with sizes
find ~/.tweakcc/ -name "*.md" -exec wc -w {} \; | sort -n
```

### 1.3 Measure tool definition overhead

Tool definitions are loaded into context even when idle. Catalog which tools are defined:

```bash
# Inside a Claude Code session, run:
# /context
# This shows what's consuming context space

# Also check MCP servers:
# /mcp
# Each MCP server adds tool definitions to system prompt tokens
```

**Deliverable:** A file listing every system prompt component, tool definition, and MCP server with approximate token counts. Save to `audit/context-composition.md` in the project.

---

## Phase 2: Identify and Remove Unused Tool Definitions

**Goal:** Reduce baseline context consumption by removing tools the operator doesn't use.

### 2.1 Determine which tools are actually used

The operator reports using only "organic model use" — a sparse subset of built-in tools. The likely essential set is:

- **Bash** — essential (1074 tokens + git instructions at 1613 tokens)
- **Write** — essential (159 tokens)
- **Edit** — essential (278 tokens)
- **ReadFile** — essential (439 tokens)
- **Grep** — likely essential (300 tokens)
- **Glob** — likely essential (122 tokens)
- **Task** — essential for multi-agent (1055 tokens + async note 202 tokens)

Likely removable for this use case:

- **TodoWrite** — 2167 tokens, very large, may not be needed if operator has own task tracking
- **WebFetch** — 278 tokens, if not used
- **WebSearch** — 334 tokens, if not used
- **NotebookEdit** — 121 tokens, if no Jupyter use
- **LSP** — 172 tokens, if not used
- **SlashCommand** — 355 tokens, if operator doesn't use slash commands
- **EnterPlanMode / ExitPlanMode** — 773 + 450 = 1223 tokens, explicitly not wanted
- **Skill** — 279 tokens, if not using built-in skills

**Potential savings: ~5,000+ tokens** from tool definitions alone.

### 2.2 Implement via tweakcc toolsets

tweakcc supports custom toolsets that completely hide tools from the model (they aren't sent at all, not just disabled):

```bash
npx tweakcc
# Navigate to Toolsets
# Create a new toolset called "architect" with only the essential tools
# Create a second toolset called "execution" if you want a fuller set for code-only work
```

Alternatively, if not using tweakcc, configure in `.claude/settings.json`:

```json
{
  "permissions": {
    "deny": ["TodoWrite", "NotebookEdit", "WebFetch", "WebSearch"]
  }
}
```

Note: `deny` prevents use but may not prevent the tool definition from being loaded into context. tweakcc toolsets are more thorough because they prevent the definition from being sent entirely.

### 2.3 Audit and trim MCP servers

```bash
# List configured MCP servers
cat ~/.claude/settings.json | jq '.mcpServers'
# Also check project-level:
cat .claude/settings.json | jq '.mcpServers'
```

Each MCP server adds tool definitions to context even when idle. Disable any that aren't actively needed. If servers are needed intermittently, document a quick enable/disable workflow rather than leaving them always-on.

**Deliverable:** Updated toolset configuration. Document removed tools and estimated token savings in `audit/tool-trimming.md`.

---

## Phase 3: Modify System Prompt Behavioral Instructions

**Goal:** Replace token-minimizing behavioral instructions with architect-quality reasoning instructions.

### 3.1 Identify and modify the main system prompt

Using tweakcc's extracted files (or the Piebald-AI reference), locate the main system prompt. The critical lines to modify are:

**REMOVE or soften these instructions:**

```
# FIND AND REMOVE/REPLACE:
"You MUST answer concisely with fewer than 4 lines of text (not including tool use or code generation), unless user asks for detail."

"You should minimize output tokens as much as possible while maintaining helpfulness, quality, and accuracy."

"You should NOT answer with unnecessary preamble or postamble (such as explaining your code or summarizing your action), unless the user asks you to."

"Do not add additional code explanation summary unless requested by the user."

"After working on a file, just stop, rather than providing an explanation of what you did."

"Only address the specific query or task at hand, avoiding tangential information unless absolutely critical for completing the request."
```

**REPLACE with:**

```markdown
You are operating as an architect-level reasoning agent in sustained autonomous sessions.

Behavioral guidelines:
- Think thoroughly before acting. Consider alternatives, tradeoffs, failure modes, and second-order effects.
- When making design decisions, explain your reasoning in full paragraphs. Do not compress reasoning into terse status updates.
- Push back on assumptions in CLAUDE.md or prior context if they appear incorrect or incomplete. Flag inconsistencies.
- When uncertain between approaches, enumerate options with explicit tradeoffs rather than picking one silently.
- After completing a significant action, provide a brief (2-3 sentence) summary of what was done and why, unless operating in a tight execution loop where the action is self-evident.
- Do not sacrifice reasoning quality for token efficiency. Depth of thought is the priority.
- When reading code or architecture, identify patterns, anti-patterns, and structural concerns proactively — do not wait to be asked.
```

### 3.2 Trim system reminders

Review the system reminders that get injected during sessions. The plan-mode reminders (1211 tokens for the enhanced version) should be removed since interactive plan mode is not used. Check for other conditional reminders that aren't relevant to the operator's workflow.

### 3.3 Trim or simplify git commit instructions

The Bash tool's git commit and PR creation instructions are 1613 tokens. If the operator handles git workflow through their own scaffolding, these can be significantly shortened or removed.

### 3.4 Apply changes

```bash
# After editing the markdown files in ~/.tweakcc/:
npx tweakcc --apply

# Verify changes took effect by starting a new session and checking /context
```

**Deliverable:** Modified prompt files. Document exact changes in `audit/prompt-modifications.md` with before/after diffs.

---

## Phase 4: Environment Variable Configuration

**Goal:** Set up environment variables optimized for architectural reasoning.

### 4.1 Create or update settings.json with env vars

In `~/.claude/settings.json` (user-level) or `.claude/settings.json` (project-level):

```json
{
  "env": {
    "MAX_THINKING_TOKENS": "31999",
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "60"
  }
}
```

Or as shell aliases for session-specific control:

```bash
# In ~/.bashrc or ~/.zshrc:

# Architect sessions: max thinking, earlier compaction, Opus
alias claude-arch='MAX_THINKING_TOKENS=31999 CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=60 claude --model claude-opus-4-6'

# Execution sessions: default thinking, standard compaction, Sonnet
alias claude-exec='claude --model claude-sonnet-4-6'

# Deep research sessions: max everything
alias claude-deep='MAX_THINKING_TOKENS=31999 CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50 claude --model claude-opus-4-6'
```

### 4.2 Autocompact tuning rationale

- Default threshold is likely ~80% of context window
- Setting to 60% means compaction triggers earlier, keeping you in the "smart zone" (sub-75k tokens for Claude models)
- Tradeoff: older conversation context is lost sooner
- For multi-agent sessions with context injection/recovery scaffolding, this is acceptable since the scaffolding handles long-term state anyway
- **Start at 60%, monitor quality, adjust in 5% increments** — if compaction is triggering too frequently and losing important recent context, bump to 65-70%

### 4.3 Disable non-essential traffic

If running in environments where network overhead matters:

```json
{
  "env": {
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  }
}
```

This bundles disabling autoupdater, bug command, error reporting, and telemetry.

**Deliverable:** Final environment configuration documented in `audit/env-configuration.md`.

---

## Phase 5: Implement Context Backpressure

**Goal:** Reduce token waste from verbose command output using the HumanLayer backpressure pattern and rtk.

### 5.1 Install rtk

```bash
# macOS
brew install rtk-ai/tap/rtk

# Linux
curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/master/scripts/install.sh | bash

# Verify
rtk --version
```

Configure rtk to intercept common verbose commands. Review rtk's default rules and customize for the project's specific test/build/lint toolchain.

### 5.2 Implement run_silent hook

Create a backpressure wrapper script:

```bash
#!/usr/bin/env bash
# .claude/hooks/run_silent.sh

run_silent() {
    local description="$1"
    local command="$2"
    local tmp_file=$(mktemp)

    if eval "$command" > "$tmp_file" 2>&1; then
        printf "  ✓ %s\n" "$description"
        rm -f "$tmp_file"
        return 0
    else
        local exit_code=$?
        printf "  ✗ %s (exit %d)\n" "$description" "$exit_code"
        # Only show relevant failure output, not full verbose log
        tail -n 30 "$tmp_file"
        rm -f "$tmp_file"
        return $exit_code
    fi
}
```

### 5.3 Configure Claude Code hooks

In `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "# Hook to validate output size and warn if excessive"
          }
        ]
      }
    ]
  }
}
```

### 5.4 Add CLAUDE.md instructions for context discipline

```markdown
# Context Efficiency Rules
- NEVER pipe test/build/lint output to /dev/null, head, or tail. The hooks handle output management.
- NEVER re-run a passing test suite to verify. Trust the ✓ from run_silent.
- Use --bail / --failfast / -x flags on test runners. Fix one failure at a time.
- When reading files, use targeted line ranges rather than reading entire files when you know what you're looking for.
- Prefer grep/glob for discovery over reading directory trees manually.
```

**Deliverable:** Installed and configured rtk + hooks. Document in `audit/backpressure-setup.md`.

---

## Phase 6: Custom Compaction Instructions

**Goal:** Ensure that when compaction triggers, it preserves architectural decisions and reasoning while discarding execution noise.

### 6.1 Add compaction instructions to CLAUDE.md

```markdown
# Compaction Priorities

When compacting conversation context, preserve in order of priority:
1. Architectural decisions and their rationale (WHY something was chosen)
2. Identified risks, failure modes, and open questions
3. Interface contracts and API boundaries
4. Current task state and remaining work
5. File paths and key code locations referenced

Discard freely:
- Verbose command output (test results, build logs)
- File contents that can be re-read
- Intermediate debugging steps that led to resolved issues
- Tool call metadata and status confirmations
```

### 6.2 Test compaction behavior

Run a medium-length session, trigger compaction manually with `/compact`, and review what's preserved vs. dropped. Adjust priorities based on what's lost.

---

## Phase 7: Validation and Measurement

### 7.1 Baseline measurement

Before applying changes, run a representative architectural task and record:
- Total tokens consumed (via /cost)
- Number of compactions triggered
- Subjective quality of reasoning (save the conversation)
- Time to completion

### 7.2 Post-change measurement

After applying all changes, run the same or equivalent task and compare:
- Token consumption delta
- Compaction frequency
- Reasoning quality (compare saved conversations side-by-side)
- Any regressions in code execution capability

### 7.3 Iterate

- If reasoning quality improved but token costs increased: acceptable, that's the intended tradeoff
- If compaction triggers too frequently at 60%: bump to 65%
- If removed tools are needed occasionally: add them back to the toolset but consider keeping them out of the "architect" toolset
- If system prompt changes cause the model to become too verbose during execution phases: consider maintaining two tweakcc prompt profiles (architect vs. execution) and switching between them

---

## File Structure for Deliverables

```
audit/
├── context-composition.md    # Phase 1: Full context audit
├── tool-trimming.md          # Phase 2: Removed tools and savings
├── prompt-modifications.md   # Phase 3: System prompt diffs
├── env-configuration.md      # Phase 4: Environment setup
├── backpressure-setup.md     # Phase 5: rtk + hooks config
└── validation-results.md     # Phase 7: Before/after measurements
```

---

## Summary of Expected Impact

| Change | Est. Token Savings | Reasoning Quality Impact |
|---|---|---|
| Remove unused tool definitions | ~5,000 tokens/session | Indirect: less noise in context |
| Trim system prompt verbosity constraints | ~200 tokens | **High: unlocks deeper reasoning** |
| Replace behavioral instructions | ~300 tokens added | **High: reshapes model identity** |
| Lower autocompact threshold (80%→60%) | Variable | **High: stays in smart zone** |
| rtk + backpressure hooks | 60-90% reduction on command output | Medium: cleaner context |
| Custom compaction priorities | N/A (reshapes what survives) | **High: preserves decisions** |
| Remove plan mode prompts | ~1,500 tokens | Minor: frees context budget |
| Trim git commit instructions | ~1,000 tokens | Minor: frees context budget |

**Total estimated context savings: 7,000-8,000+ tokens of baseline overhead**, plus 60-90% reduction in runtime command output tokens, plus higher quality utilization of remaining context through behavioral changes and smarter compaction.
