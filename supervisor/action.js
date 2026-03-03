function formatDurationSec(sec) {
  const s = Math.max(0, Number(sec) || 0);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

function statusLabel(status) {
  switch (status) {
    case 'DRIFTING': return 'drifting';
    case 'LOST': return 'lost';
    case 'STUCK': return 'stuck';
    default: return status.toLowerCase();
  }
}

export function buildWarningPayload(agentName, context, judgment, stateSnapshot, config) {
  const summary = `Supervisor warning: @${agentName} got ${stateSnapshot.consecutiveNegative} consecutive negative focus ratings`;
  const lines = [
    `Agent: ${agentName}`,
    `Status: ${judgment.status} (${statusLabel(judgment.status)})`,
    `Domain: ${judgment.domain}`,
    `Pattern: ${judgment.pattern || 'n/a'}`,
    `Reason: ${judgment.reason}`,
    `Current task: ${context.docs.currentTask || '(missing)'}`,
    `Runtime: active=${context.runtime.activeNow} blocked=${context.runtime.blocked} activeDuration=${formatDurationSec(context.runtime.activeDurationSec)}`,
    `Pane: ${context.pane.target || '(missing)'} (${context.pane.source})`,
    `Consecutive negative: ${stateSnapshot.consecutiveNegative}`,
  ];

  if (judgment.suggestion) lines.push(`Suggestion: ${judgment.suggestion}`);
  if (context.docs.planPath) lines.push(`plan.md: ${context.docs.planPath}`);
  if (context.docs.agentsPath) lines.push(`agents.md: ${context.docs.agentsPath}`);
  if (Array.isArray(config.matrixMentions) && config.matrixMentions.length > 0) {
    lines.push(`Mentions: ${config.matrixMentions.map(n => `@${n}`).join(' ')}`);
  }

  return { summary, full: lines.join('\n') };
}
