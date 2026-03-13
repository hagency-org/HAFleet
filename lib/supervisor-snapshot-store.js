// SupervisorSnapshotStore — per-target supervisor state with JSON persistence.

const VALID_STATES = new Set(['focused', 'drifting', 'lost', 'stuck', 'idle', 'done']);
const VALID_ACTIONS = new Set(['none', 'nudge', 'escalate', 'interrupt']);
const VALID_DOMAINS = new Set(['core', 'adjacent', 'outside']);
const NEGATIVE_STATES = new Set(['drifting', 'lost', 'stuck']);
const EVENT_RING_LIMIT = 5000;
const DEFAULT_LEASE_TTL_MS = 120_000;
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_WARN_AFTER = 2;
const DEFAULT_WARN_COOLDOWN_MS = 300_000;
const DEFAULT_TRAILING_PERIODS = 3;

// Map supervisor-writer state → dashboard classification
const STATE_TO_CLASSIFICATION = {
  focused: 'active',
  drifting: 'suspected_eos',
  lost: 'suspected_eos',
  stuck: 'stalled_wait',
  idle: 'active',
  done: 'done',
};

// Map supervisor-writer state → dashboard event status
const STATE_TO_STATUS = {
  focused: 'FOCUSED',
  drifting: 'DRIFTING',
  lost: 'LOST',
  stuck: 'STUCK',
  idle: 'IDLE',
  done: 'DONE',
};

export {
  VALID_STATES, VALID_ACTIONS, VALID_DOMAINS, NEGATIVE_STATES,
  STATE_TO_CLASSIFICATION, STATE_TO_STATUS,
};

function normalizeText(v, max = 255) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function generateEventId(target) {
  const ts = Date.now();
  const r = Math.random().toString(36).slice(2, 8);
  return `supervisor_${ts}_${target}_${r}`;
}

export function createSupervisorSnapshotStore({ initialData, save }) {
  const targets = {};       // targetAgent → snapshot
  const events = [];        // ring buffer
  const leases = {};        // targetAgent → { supervisorAgent, expiresAt }

  let globalEnabled = true;
  let globalDisabledReason = null;

  // Load initial data
  if (initialData && typeof initialData === 'object') {
    if (initialData.targets) {
      for (const [k, v] of Object.entries(initialData.targets)) {
        targets[k] = v;
      }
    }
    if (Array.isArray(initialData.events)) {
      events.push(...initialData.events.slice(-EVENT_RING_LIMIT));
    }
    if (initialData.config) {
      if (typeof initialData.config.enabled === 'boolean') globalEnabled = initialData.config.enabled;
      if (initialData.config.disabledReason) globalDisabledReason = initialData.config.disabledReason;
    }
  }

  function persist() {
    save({
      targets,
      events: events.slice(-EVENT_RING_LIMIT),
      config: { enabled: globalEnabled, disabledReason: globalDisabledReason },
    });
  }

  function updateAssessment(targetAgent, supervisorAgent, assessment) {
    const state = normalizeText(assessment.state, 32);
    if (!state || !VALID_STATES.has(state)) {
      throw Object.assign(new Error(`invalid state: ${assessment.state}`), { code: 'invalid_state' });
    }
    const confidence = typeof assessment.confidence === 'number'
      ? Math.max(0, Math.min(1, assessment.confidence))
      : 0.5;
    const reason = normalizeText(assessment.reason, 2048) || '';
    const suggestedAction = normalizeText(assessment.suggested_action, 32) || 'none';
    if (!VALID_ACTIONS.has(suggestedAction)) {
      throw Object.assign(new Error(`invalid suggested_action: ${assessment.suggested_action}`), { code: 'invalid_action' });
    }
    const domain = normalizeText(assessment.domain, 32) || null;
    if (domain && !VALID_DOMAINS.has(domain)) {
      throw Object.assign(new Error(`invalid domain: ${assessment.domain}`), { code: 'invalid_domain' });
    }
    const pattern = normalizeText(assessment.pattern, 64) || null;
    const isNegative = NEGATIVE_STATES.has(state);

    const prev = targets[targetAgent];
    const wasNegative = prev ? NEGATIVE_STATES.has(prev.state) : false;
    const consecutiveNegative = isNegative
      ? ((prev?.consecutiveNegative || 0) + 1)
      : 0;

    const now = new Date().toISOString();
    const nowMs = Date.now();
    const classification = STATE_TO_CLASSIFICATION[state] || 'active';
    const lifecycleState = isLeaseActive(targetAgent) ? 'active' : 'idle';
    const eventId = generateEventId(targetAgent);

    const snapshot = {
      state,
      confidence,
      reason,
      suggested_action: suggestedAction,
      domain,
      pattern,
      supervisor: supervisorAgent,
      assessed_at: now,
      assessed_at_ms: nowMs,
      consecutiveNegative,
      classification,
      lifecycleState,
      negative: isNegative,
      lastEventId: eventId,
      // Action engine fields — preserved from previous
      lastWarningAt: prev?.lastWarningAt || null,
      lastNudgeAt: prev?.lastNudgeAt || null,
      lastNudgeCount: prev?.lastNudgeCount || 0,
      lastEscalationAt: prev?.lastEscalationAt || null,
      lastEscalationCount: prev?.lastEscalationCount || 0,
    };
    targets[targetAgent] = snapshot;

    // Append event
    const event = {
      id: eventId,
      ts: nowMs,
      agent: targetAgent,
      sweepAt: now,
      status: STATE_TO_STATUS[state] || state.toUpperCase(),
      domain,
      reason,
      pattern,
      suggestion: suggestedAction,
      negative: isNegative,
      state: { consecutiveNegative },
      supervisor: { classification, lifecycleState },
      llm: null,
      action: null,
    };
    events.push(event);
    if (events.length > EVENT_RING_LIMIT) {
      events.splice(0, events.length - EVENT_RING_LIMIT);
    }

    persist();
    return { snapshot, event };
  }

  function getTarget(targetAgent) {
    return targets[targetAgent] || null;
  }

  function getAllTargets() {
    return { ...targets };
  }

  function getEvents(targetAgent, limit = 120) {
    if (targetAgent) {
      return events.filter(e => e.agent === targetAgent).slice(-limit);
    }
    return events.slice(-limit);
  }

  // Lease management
  function renewLease(targetAgent, supervisorAgent, ttlMs = DEFAULT_LEASE_TTL_MS) {
    leases[targetAgent] = {
      supervisorAgent,
      expiresAt: Date.now() + ttlMs,
    };
  }

  function isLeaseActive(targetAgent) {
    const lease = leases[targetAgent];
    return lease ? lease.expiresAt > Date.now() : false;
  }

  function clearLease(targetAgent) {
    delete leases[targetAgent];
  }

  // Action engine bookkeeping
  function recordNudge(targetAgent) {
    const t = targets[targetAgent];
    if (!t) return;
    const now = Date.now();
    t.lastNudgeAt = now;
    t.lastNudgeCount = (t.lastNudgeCount || 0) + 1;
    t.lastWarningAt = now;
    persist();
  }

  function recordEscalation(targetAgent) {
    const t = targets[targetAgent];
    if (!t) return;
    const now = Date.now();
    t.lastEscalationAt = now;
    t.lastEscalationCount = (t.lastEscalationCount || 0) + 1;
    persist();
  }

  // Control
  function getControl(agentRegistry) {
    const allowedAgents = [];
    if (agentRegistry) {
      for (const name of Object.keys(agentRegistry)) {
        if (agentRegistry[`supervisor-${name}`]) {
          allowedAgents.push(name);
        }
      }
    }
    return {
      enabled: globalEnabled,
      disabledReason: globalDisabledReason,
      allowedAgents,
      allowlistMode: 'subset',
    };
  }

  function setEnabled(enabled) {
    globalEnabled = enabled;
    globalDisabledReason = enabled ? null : 'runtime-disabled';
    persist();
  }

  function isEnabled() {
    return globalEnabled;
  }

  // Global status aggregate
  function getStatus(agentRegistry) {
    const control = getControl(agentRegistry);
    const allSnapshots = Object.values(targets);
    const activeLeases = Object.keys(leases).filter(k => isLeaseActive(k));
    const recentAssessments = allSnapshots.filter(s =>
      s.assessed_at_ms && (Date.now() - s.assessed_at_ms) < DEFAULT_INTERVAL_MS * 2
    );
    const hasNegative = allSnapshots.some(s => s.negative);
    const hasActive = activeLeases.length > 0;
    const lastSweepAt = allSnapshots.reduce((max, s) => {
      return s.assessed_at_ms > max ? s.assessed_at_ms : max;
    }, 0) || null;

    return {
      enabled: control.enabled,
      disabledReason: control.disabledReason,
      intervalMs: DEFAULT_INTERVAL_MS,
      warnAfter: DEFAULT_WARN_AFTER,
      warnCooldownMs: DEFAULT_WARN_COOLDOWN_MS,
      heartbeatTtlMs: DEFAULT_LEASE_TTL_MS,
      trailingHeartbeatPeriods: DEFAULT_TRAILING_PERIODS,
      trailingWindowMs: DEFAULT_LEASE_TTL_MS * DEFAULT_TRAILING_PERIODS,
      matrixInfoGroup: null,
      matrixMentions: true,
      allowedAgents: control.allowedAgents,
      allowlistMode: 'subset',
      llm: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        endpoint: null,
        profileSource: 'agent',
      },
      runtime: {
        running: hasActive,
        lastSweepAt: lastSweepAt ? new Date(lastSweepAt).toISOString() : null,
        lastSweepDurationMs: 0,
        lastSweepError: null,
        lastSweepActive: activeLeases.length,
        lastSweepEvaluated: recentAssessments.length,
      },
      supervisorState: {
        mode: hasNegative ? 'attention' : (hasActive ? 'active' : 'idle'),
        lifecycleState: hasActive ? 'active' : 'idle',
      },
      eventCount: events.length,
    };
  }

  function dump() {
    return {
      targets,
      events: events.slice(-EVENT_RING_LIMIT),
      config: { enabled: globalEnabled, disabledReason: globalDisabledReason },
    };
  }

  return {
    updateAssessment, getTarget, getAllTargets, getEvents,
    renewLease, isLeaseActive, clearLease,
    recordNudge, recordEscalation,
    getControl, setEnabled, isEnabled, getStatus,
    dump,
  };
}
