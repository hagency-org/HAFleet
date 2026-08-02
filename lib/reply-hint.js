/**
 * When an agent should be told to reply, and with what.
 *
 * Not every message wants an answer. A `task` is work to do; a `human` or
 * `request` is someone waiting. Telling an agent to reply to everything turns a
 * fleet's message log into an echo of itself.
 *
 * Shared because it was not. The tmux path applied this rule via
 * buildMcpReplyActionHint while the ACP host told its agent to reply
 * unconditionally, so the same `hafleet tell` produced silence from claude and
 * codex and a message from octos. Verified by sending one task to all three:
 * all answered "Au", only octos posted it. That is octos over-replying, not the
 * others failing — and it is why its message count reached 26 against codex's 3.
 */

/** Trim, drop empties, and cap length. Mirrors the backend's helper. */
function normalizeTarget(value, maxLen = 255) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

/** Message kinds that are someone waiting on an answer, rather than work to do. */
export const REPLYABLE_TYPES = Object.freeze(['human', 'request']);

/**
 * @param {object|null} msg   a summarized message (id, from, type, group)
 * @param {string|null} [replyTo] override for the reply target
 * @param {string} [mcpName]  the MCP server namespace, for the instruction text
 * @returns {string|null} the instruction, or null when no reply is wanted
 */
export function buildReplyHint(msg, replyTo = null, mcpName = 'hafleet') {
  if (!msg || !REPLYABLE_TYPES.includes(msg.type)) return null;
  if (msg.group) {
    return `Reply after ALL WORK is done, using the ${mcpName} MCP tool: post(group="${msg.group}", summary="your reply", full="detailed reply", reply_to="${msg.id}")`;
  }
  const target = normalizeTarget(replyTo || msg.from);
  if (!target) return null;
  return `Reply after ALL WORK is done, using the ${mcpName} MCP tool: send_message(to="${target}", summary="your reply", full="detailed reply", reply_to="${msg.id}")`;
}

/** True when any message in a batch wants an answer. */
export function anyReplyable(messages = []) {
  return messages.some((m) => m && REPLYABLE_TYPES.includes(m.type));
}
