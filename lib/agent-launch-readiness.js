/*
 * Is this agent home ready to launch a runtime whose permission requests can reach a human?
 *
 * ONE OWNER FOR ONE QUESTION. ADR-005 requires that "the launcher verifies every required adapter
 * before it creates tmux". Two launchers honoured that (`bin/hafleet-up` and its remote twin) and a
 * third did not: `lib/supervisor-lifecycle-manager.js` applied ADR-004's sandbox defaults and none
 * of ADR-005, so a supervisor-launched Claude agent ran `--permission-mode auto` in a detached pane
 * with no permission relay. Auto mode then either hard-denies or opens a native prompt inside a
 * pane nobody is watching — the state `REQ-OWNER-UI-APPROVAL-BACKGROUND` names and forbids.
 *
 * A security precondition that runs at two of three entry points does not exist at the third, and
 * "add the checks to the third launcher too" would make a third copy of logic whose drift is
 * exactly what this audit round kept finding. So the question gets one owner, and callers ask it.
 *
 * VERIFY-ONLY, AND THAT IS THE DESIGN, NOT A SHORTCUT.
 *
 * `bin/hafleet-up`'s preflight ESTABLISHES readiness: it mints the agent token, installs Claude ask
 * rules, writes Codex hook config, and — for Codex — asks the operator to confirm hook trust at a
 * TTY. `confirmHookTrust` returns false when `!input.isTTY`, and its caller aborts the launch. That
 * is correct for provisioning and impossible for a daemon: the supervisor sweep runs inside the
 * backend process with no terminal, so it could never complete an establishing preflight.
 *
 * It does not need to. The supervisor launches into an ALREADY PROVISIONED home — it resolves a v1
 * manifest for an existing agent — so the artifacts exist or the agent was never provisioned. What
 * the supervisor was missing is the check that they are still there, not the ability to create them.
 * Hence: this module reads, never writes, never prompts, and fails closed with a reason a human can
 * act on.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK. Codex hook TRUST state, which requires an App Server
 * connection and can require a confirmation. That check belongs to provisioning, and duplicating it
 * here would either reintroduce the TTY dependency or weaken it into a guess. What is checked is
 * that the hook CONFIG the trust applies to exists — its absence means provisioning never ran.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** Frameworks whose permission requests must reach a human through an adapter. */
const GATED_FRAMEWORKS = new Set(['claude', 'codex']);

const nonEmptyFile = (file) => {
  try {
    return existsSync(file) && statSync(file).isFile() && statSync(file).size > 0;
  } catch {
    return false;
  }
};

/**
 * The agent's own approval token — the credential its runtime uses to submit an approval request.
 *
 * Without it the runtime cannot reach the backend at all, so a permission request has nowhere to
 * go and the runtime falls back to whatever it does alone — for auto-mode Claude, a prompt nobody
 * sees. `bin/hafleet-up` MINTS this when missing; here its absence means provisioning never ran
 * for this agent, which a daemon must report rather than repair.
 */
function checkAgentToken(stateDir) {
  const file = path.join(stateDir, 'agent-token');
  if (!nonEmptyFile(file)) {
    return {
      ok: false,
      reason: 'missing_agent_approval_token',
      detail: `no owner-approval token at ${file}; run \`hafleet up\` for this agent to provision it`,
    };
  }
  return { ok: true };
}

/**
 * Claude reaches a human over the MCP permission channel, which needs an MCP server declared.
 *
 * Mirrors what `bin/hafleet-up`'s preflight checks for the same framework: the channel not disabled,
 * and an MCP server configuration the runtime will actually load. The `claude --help` probe that
 * the shell preflight also runs is deliberately NOT repeated — it spawns a process, and a sweep
 * loop that shells out on every wake is a different kind of problem.
 */
function checkClaude(agentPath, env) {
  if (String(env.HAFLEET_CLAUDE_PERMISSION_CHANNEL ?? 'true') === 'false') {
    return {
      ok: false,
      reason: 'claude_permission_channel_disabled',
      detail: 'HAFLEET_CLAUDE_PERMISSION_CHANNEL=false turns off the only channel by which this '
        + 'runtime can ask a human; a background launch would fall back to a prompt in an '
        + 'unwatched pane',
    };
  }
  const local = path.join(agentPath, '.mcp.json');
  const managed = '/etc/claude-code/managed-mcp.json';
  if (!nonEmptyFile(local) && !nonEmptyFile(managed)) {
    return {
      ok: false,
      reason: 'claude_mcp_config_missing',
      detail: `neither ${local} nor ${managed} exists, so the permission channel is not declared`,
    };
  }
  return { ok: true };
}

/**
 * Codex reaches a human through a synchronous `PermissionRequest` hook.
 *
 * The hook CONFIG is what is checked. Its trust state is not — see the module note: trust needs an
 * App Server connection and possibly a confirmation, so it stays with provisioning. A missing
 * config, though, means there is no hook for trust to apply to.
 */
function checkCodex(agentDataDir) {
  const file = path.join(agentDataDir, 'codex-approval-hook.json');
  if (!nonEmptyFile(file)) {
    return {
      ok: false,
      reason: 'codex_hook_config_missing',
      detail: `no Codex permission-hook config at ${file}; run \`hafleet up\` for this agent, `
        + 'which writes it and confirms hook trust at a terminal',
    };
  }
  /*
   * Parsed rather than merely present. A truncated or hand-edited config is worse than a missing
   * one: Codex would start, read no usable hook, and run with no approval path — the failure this
   * whole check exists to prevent, wearing a valid-looking filename.
   */
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
  } catch (error) {
    return {
      ok: false,
      reason: 'codex_hook_config_unreadable',
      detail: `${file} is not readable JSON (${error.message}); Codex would start with no approval path`,
    };
  }
  return { ok: true };
}

/**
 * May a background launcher start this framework in this home?
 *
 * @param framework  the runtime being launched
 * @param agentPath  the agent's home directory (holds `.mcp.json`)
 * @param stateDir   the agent's state directory (holds `agent-token`)
 * @param dataDir    the agent's data directory (holds `codex-approval-hook.json`)
 * @returns `{ ok: true }`, or `{ ok: false, reason, detail }`
 *
 * An unknown framework returns ok. ACP runtimes (`hermes`, `octos`, `codex-acp`) answer permission
 * requests through their own client-side path — `scripts/hafleet-acp-agent.mjs` declines anything
 * that is not a hafleet coordination tool — so they have no adapter for this to verify. Returning
 * a refusal for them would block launches for a reason that does not apply; the set is explicit
 * rather than a default so adding a gated framework means adding it here.
 */
export function verifyRuntimeApprovalReadiness({
  framework,
  agentPath,
  stateDir,
  dataDir,
  env = process.env,
} = {}) {
  if (!GATED_FRAMEWORKS.has(framework)) return { ok: true, reason: 'framework_not_gated' };
  if (!agentPath || !stateDir || !dataDir) {
    return {
      ok: false,
      reason: 'agent_home_unresolved',
      detail: 'cannot verify the approval adapter without the agent home, state and data paths',
    };
  }

  const token = checkAgentToken(stateDir);
  if (!token.ok) return token;

  if (framework === 'claude') return checkClaude(agentPath, env);
  return checkCodex(dataDir);
}
