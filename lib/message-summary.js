/**
 * Build the short form of a message without lying about it.
 *
 * The summary is not a label. It is what the relay types into a tmux agent's
 * pane and what a reader sees first, so a summary cut mid-sentence is a wrong
 * instruction rather than a shortened one. `hafleet tell` cut at 72 characters
 * and a 73-character message arrived as "CODEX-FINA"; the agent did exactly what
 * it was told, which was the wrong thing, and nothing reported an error.
 *
 * Shared so the two places that build summaries — the operator CLI and the ACP
 * host replying on an agent's behalf — cannot drift apart on the rule.
 */

/** Longest summary that passes through whole. */
export const SUMMARY_LIMIT = 240;

/**
 * @param {string} text full message body
 * @param {number} [limit]
 * @returns {string} the text unchanged when short enough, else cut on a word
 *   boundary and marked with an ellipsis so the reader can tell it is partial.
 */
export function buildSummary(text, limit = SUMMARY_LIMIT) {
  const collapsed = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (collapsed.length <= limit) return collapsed;
  // Reserve one character for the ellipsis, then drop the partial trailing word.
  const cut = collapsed.slice(0, limit - 1).replace(/\s\S*$/, '');
  // A single word longer than the limit has no boundary to fall back to; cutting
  // it is still better than emitting something over the limit.
  return `${cut || collapsed.slice(0, limit - 1)}…`;
}
