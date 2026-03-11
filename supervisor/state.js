import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';

function safeReadJson(filePath, fallback) {
  try {
    if (!existsSync(filePath)) return fallback;
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function safeWriteJson(filePath, data) {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, filePath);
}

function isNegative(status) {
  return status === 'stalled_wait' || status === 'suspected_eos';
}

export class SupervisorStateStore {
  constructor(filePath, warnAfter, warnCooldownMs) {
    this.filePath = filePath;
    this.warnAfter = warnAfter;
    this.warnCooldownMs = warnCooldownMs;
    const loaded = safeReadJson(filePath, { agents: {}, selectionCursor: 0 });
    this.agents = loaded && typeof loaded === 'object' && loaded.agents && typeof loaded.agents === 'object'
      ? loaded.agents
      : {};
    this.selectionCursor = loaded && typeof loaded === 'object'
      ? Math.max(0, Number(loaded.selectionCursor) || 0)
      : 0;
  }

  snapshot(agentName) {
    const row = this.agents[agentName];
    if (!row) {
      return {
        lastStatus: null,
        consecutiveNegative: 0,
        lastWarningAt: 0,
        lastJudgedAt: 0,
        lastReason: null,
      };
    }
    return {
      lastStatus: row.lastStatus || null,
      consecutiveNegative: Number(row.consecutiveNegative) || 0,
      lastWarningAt: Number(row.lastWarningAt) || 0,
      lastNudgeAt: Number(row.lastNudgeAt) || 0,
      lastNudgeCount: Number(row.lastNudgeCount) || 0,
      lastEscalationAt: Number(row.lastEscalationAt) || 0,
      lastEscalationCount: Number(row.lastEscalationCount) || 0,
      lastJudgedAt: Number(row.lastJudgedAt) || 0,
      lastReason: row.lastReason || null,
      lastDomain: row.lastDomain || null,
      lastPattern: row.lastPattern || null,
      lastSuggestion: row.lastSuggestion || null,
      lastEventId: row.lastEventId || null,
      lastInputHash: row.lastInputHash || null,
      task: row.task || null,
      classification: row.classification || null,
      trailingUntilAt: Number(row.trailingUntilAt) || 0,
      lifecycleState: row.lifecycleState || null,
      lifecycleReason: row.lifecycleReason || null,
      runtimeLaunch: row.runtimeLaunch || null,
    };
  }

  clearMissingAgents(validAgentNames) {
    const keep = new Set(validAgentNames || []);
    for (const key of Object.keys(this.agents)) {
      if (!keep.has(key)) delete this.agents[key];
    }
  }

  getSelectionCursor() {
    return Math.max(0, Number(this.selectionCursor) || 0);
  }

  setSelectionCursor(value) {
    this.selectionCursor = Math.max(0, Number(value) || 0);
  }

  applyJudgment(agentName, judgment, now, eventId) {
    const prev = this.snapshot(agentName);
    const negative = isNegative(judgment.status);
    const consecutiveNegative = negative ? (prev.consecutiveNegative + 1) : 0;
    const cooledDown = (now - prev.lastWarningAt) >= this.warnCooldownMs;
    const shouldWarn = negative && consecutiveNegative >= this.warnAfter && cooledDown;

    const next = {
      lastStatus: judgment.status || null,
      consecutiveNegative,
      lastWarningAt: shouldWarn ? now : prev.lastWarningAt,
      lastNudgeAt: negative ? prev.lastNudgeAt : 0,
      lastNudgeCount: negative ? prev.lastNudgeCount : 0,
      lastEscalationAt: negative ? prev.lastEscalationAt : 0,
      lastEscalationCount: negative ? prev.lastEscalationCount : 0,
      lastJudgedAt: now,
      lastReason: judgment.reason || null,
      lastDomain: judgment.domain || null,
      lastPattern: judgment.pattern || null,
      lastSuggestion: judgment.suggestion || null,
      lastEventId: eventId || null,
      lastInputHash: judgment.inputHash || null,
      task: judgment.task || null,
      classification: judgment.classification || judgment.status || null,
      trailingUntilAt: Number(judgment.trailingUntilAt) || 0,
      lifecycleState: judgment.lifecycleState || null,
      lifecycleReason: judgment.lifecycleReason || null,
      runtimeLaunch: judgment.runtimeLaunch || null,
    };
    this.agents[agentName] = next;

    return {
      previous: prev,
      current: { ...next },
      shouldWarn,
      negative,
    };
  }

  markIntervention(agentName, patch = {}, now = Date.now()) {
    const prev = this.snapshot(agentName);
    const next = {
      ...prev,
      ...this.agents[agentName],
      lastJudgedAt: now,
    };
    if (Object.prototype.hasOwnProperty.call(patch, 'lastNudgeAt')) {
      next.lastNudgeAt = Number(patch.lastNudgeAt) || 0;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'lastNudgeCount')) {
      next.lastNudgeCount = Number(patch.lastNudgeCount) || 0;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'lastEscalationAt')) {
      next.lastEscalationAt = Number(patch.lastEscalationAt) || 0;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'lastEscalationCount')) {
      next.lastEscalationCount = Number(patch.lastEscalationCount) || 0;
    }
    this.agents[agentName] = next;
    return { ...next };
  }

  save() {
    safeWriteJson(this.filePath, {
      agents: this.agents,
      selectionCursor: this.getSelectionCursor(),
      updatedAt: Date.now(),
    });
  }
}
