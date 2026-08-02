/**
 * The outbox protocol for paneless ACP agents.
 *
 * This exists because octos 2.0.2 has no way to reach HAFleet. It accepts the
 * mcpServers field on session/new and silently ignores it (claude and codex each
 * spawn an mcp-server.js child; octos spawns none). Its config.json has no MCP
 * section, and `octos mcp` only does OAuth login for remote servers. Its shell
 * cannot substitute either: the sandbox is network-isolated, verified on mini5
 * where the agent's own `nc -z 127.0.0.1 8090` reported PORT_CLOSED while the
 * backend was plainly listening there.
 *
 * The one thing it can do is write files in its workspace. So the agent drops a
 * JSON file and the host performs the action for it.
 *
 * The surface is deliberately two messaging verbs. Writing to a directory is not
 * authentication — the host trusts the file because it trusts the workspace — so
 * anything that mutates task state or answers an approval stays out until an ACP
 * agent can prove who it is.
 */

export const OUTBOX_ACTIONS = Object.freeze(['send_message', 'post']);

/**
 * @param {unknown} request parsed contents of one outbox file
 * @returns {string|null} a reason it cannot be used, or null when it can
 */
export function validateOutboxRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return 'not a JSON object';
  const action = request.action || 'send_message';
  if (!OUTBOX_ACTIONS.includes(action)) {
    return `unsupported action '${action}' (allowed: ${OUTBOX_ACTIONS.join(', ')})`;
  }
  if (action === 'send_message' && !String(request.to ?? '').trim()) return 'send_message requires "to"';
  if (action === 'post' && !String(request.group ?? '').trim()) return 'post requires "group"';
  if (!String(request.full ?? request.summary ?? '').trim()) return 'requires "summary" or "full"';
  return null;
}

/** Instructions handed to the agent, which has no tool list to discover. */
export const OUTBOX_PROTOCOL = [
  'To send a message yourself, write a JSON file into .hafleet/outbox/ in your',
  'working directory (any filename ending .json). It is picked up within seconds.',
  '  {"action":"send_message","to":"<agent-or-person>","summary":"short","full":"detail"}',
  '  {"action":"post","group":"<group>","summary":"short","full":"detail"}',
  'Add "reply_to":"<message-id>" to thread it. A rejected file is moved to',
  '.hafleet/outbox/rejected/ with a .error file beside it explaining why.',
].join('\n');
