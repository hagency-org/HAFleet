const ANSI_RE = /\x1B\[[0-9;?]*[ -/]*[@-~]/g;

function recentPaneText(text, maxLines = 14) {
  return String(text || '')
    .replace(ANSI_RE, '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-Math.max(1, maxLines))
    .join('\n');
}

export function detectPaneBusyState(text) {
  const recent = recentPaneText(text);
  if (!recent) return { busy: false, reason: null };

  if (/(?:^|\n)\s*[•●]\s*Working\b[^\n]*\besc to interrupt\b/i.test(recent)) {
    return { busy: true, reason: 'codex-working' };
  }

  if (/\b(?:Working|Running|Thinking|Processing)\b[^\n]*\besc to interrupt\b/i.test(recent)) {
    return { busy: true, reason: 'interactive-client-working' };
  }

  if (/\besc to interrupt\b[^\n]*\b(?:Working|Running|Thinking|Processing)\b/i.test(recent)) {
    return { busy: true, reason: 'interactive-client-working' };
  }

  return { busy: false, reason: null };
}
