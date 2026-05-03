// Alert Store — ticket management for system warnings and events.
// Factory pattern matching task-store.js.

const STATUSES = ['open', 'acknowledged', 'assigned', 'resolved', 'suppressed'];
const SEVERITIES = ['info', 'warning', 'critical'];
const SOURCES = ['backend', 'bridge', 'supervisor', 'system'];

const TRANSITIONS = new Map([
  ['open',         new Set(['acknowledged', 'assigned', 'resolved', 'suppressed'])],
  ['acknowledged', new Set(['assigned', 'resolved'])],
  ['assigned',     new Set(['resolved'])],
  ['suppressed',   new Set(['open', 'assigned'])],
  // 'resolved' is terminal
]);

// Recovery event → dedupeKey prefix it auto-resolves
const RECOVERY_MAP = {
  mcp_recovered:  'mcp_missing',
  server_online:  'server_offline',
  swap_clear:     'swap_high',
  agent_recovered: 'agent_blocked',
};

const ALERT_REOPEN_WINDOW_MS  = 300_000;       // 5 min
const ALERT_RESOLVED_TTL_MS   = 7 * 86400_000; // 7 days
const ALERT_SUPPRESS_DEFAULT_MS = 86400_000;    // 24 hours
const MAX_ACTIVE_ALERTS       = 1000;
const MAX_PAYLOAD_SIZE        = 4096;
const ACTIONABLE_REQUIRED_FIELDS = ['owner', 'runbook', 'impact', 'recoveryCondition', 'correlation'];

function generateAlertId() {
  const ts = Math.floor(Date.now() / 1000);
  const rand = Math.random().toString(36).slice(2, 8);
  return `alert_${ts}_${rand}`;
}

function alertError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function normalizeText(value, maxLen = 255) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t ? t.slice(0, maxLen) : null;
}

function normalizeSeverity(value) {
  if (typeof value !== 'string') return 'info';
  const v = value.trim().toLowerCase();
  return SEVERITIES.includes(v) ? v : 'info';
}

function normalizeSource(value) {
  if (typeof value !== 'string') return 'system';
  const v = value.trim().toLowerCase();
  return SOURCES.includes(v) ? v : 'system';
}

function truncatePayload(payload) {
  if (payload == null) return null;
  const s = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return s.length > MAX_PAYLOAD_SIZE ? s.slice(0, MAX_PAYLOAD_SIZE) : s;
}

function normalizeCorrelationValue(value) {
  if (typeof value === 'string') return normalizeText(value, 255);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const arr = value.map(normalizeCorrelationValue).filter(v => v !== null && v !== undefined).slice(0, 50);
    return arr.length ? arr : null;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 20)) {
      const safeKey = normalizeText(key, 64);
      if (!safeKey) continue;
      const safeValue = normalizeCorrelationValue(item);
      if (safeValue !== null && safeValue !== undefined) out[safeKey] = safeValue;
    }
    return Object.keys(out).length ? out : null;
  }
  return null;
}

function normalizeCorrelation(value, context = {}) {
  const base = (value && typeof value === 'object' && !Array.isArray(value))
    ? normalizeCorrelationValue(value) || {}
    : {};
  const out = { ...base };
  const dedupeKey = normalizeText(context.dedupeKey, 255);
  const sourceAgent = normalizeText(context.sourceAgent, 128);
  const alertType = normalizeText(context.alertType, 128);
  if (dedupeKey && out.dedupeKey === undefined) out.dedupeKey = dedupeKey;
  if (sourceAgent && out.sourceAgent === undefined) out.sourceAgent = sourceAgent;
  if (alertType && out.alertType === undefined) out.alertType = alertType;
  return out;
}

function buildActionability(input = {}) {
  const requestedSeverity = normalizeSeverity(input.severity);
  const owner = normalizeText(input.owner, 128);
  const assignee = normalizeText(input.assignee, 128);
  const runbook = normalizeText(input.runbook, 512);
  const impact = normalizeText(input.impact, 1024);
  const recoveryCondition = normalizeText(input.recoveryCondition ?? input.exitCondition, 1024);
  const correlation = normalizeCorrelation(input.correlation, {
    alertType: input.alertType,
    dedupeKey: input.dedupeKey,
    sourceAgent: input.sourceAgent,
  });

  const missingActionableFields = [];
  if (requestedSeverity === 'warning' || requestedSeverity === 'critical') {
    if (!owner && !assignee) missingActionableFields.push(ACTIONABLE_REQUIRED_FIELDS[0]);
    if (!runbook) missingActionableFields.push(ACTIONABLE_REQUIRED_FIELDS[1]);
    if (!impact) missingActionableFields.push(ACTIONABLE_REQUIRED_FIELDS[2]);
    if (!recoveryCondition) missingActionableFields.push(ACTIONABLE_REQUIRED_FIELDS[3]);
    if (!Object.keys(correlation).length) missingActionableFields.push(ACTIONABLE_REQUIRED_FIELDS[4]);
  }

  const pagingSeverity = requestedSeverity === 'warning' || requestedSeverity === 'critical';
  const actionable = pagingSeverity && missingActionableFields.length === 0;
  return {
    severity: pagingSeverity && !actionable ? 'info' : requestedSeverity,
    originalSeverity: pagingSeverity && !actionable ? requestedSeverity : null,
    actionable,
    missingActionableFields,
    owner: owner || null,
    runbook: runbook || null,
    impact: impact || null,
    recoveryCondition: recoveryCondition || null,
    correlation,
    assignee: assignee || null,
  };
}

export function createAlertStore({ initialData, save, emitEvent, now }) {
  const alerts = new Map();        // id → alert
  const dedupeIndex = new Map();   // dedupeKey → alertId (non-resolved only)
  const _now = now || (() => Date.now());

  // Load initial data, rebuild dedupeIndex
  if (Array.isArray(initialData)) {
    for (const alert of initialData) {
      if (alert && alert.id) {
        alerts.set(alert.id, alert);
        if (alert.status !== 'resolved' && alert.dedupeKey) {
          dedupeIndex.set(alert.dedupeKey, alert.id);
        }
      }
    }
  }

  function cloneAlert(alert) {
    return JSON.parse(JSON.stringify(alert));
  }

  function snapshotState() {
    return {
      alerts: new Map([...alerts.entries()].map(([id, alert]) => [id, cloneAlert(alert)])),
      dedupeIndex: new Map(dedupeIndex),
    };
  }

  function restoreState(snapshot) {
    alerts.clear();
    for (const [id, alert] of snapshot.alerts.entries()) {
      alerts.set(id, alert);
    }
    dedupeIndex.clear();
    for (const [key, id] of snapshot.dedupeIndex.entries()) {
      dedupeIndex.set(key, id);
    }
  }

  function persist() {
    let ok;
    try {
      ok = save([...alerts.values()]);
    } catch {
      throw alertError('persistence_failed', 'alert persistence failed');
    }
    if (ok === false) {
      throw alertError('persistence_failed', 'alert persistence failed');
    }
  }

  function _emit(eventName, alert) {
    if (emitEvent) emitEvent(eventName, alert);
  }

  function emitEvents(events = []) {
    for (const event of events) {
      _emit(event.name, event.alert);
    }
  }

  function commitMutation(mutator) {
    const snapshot = snapshotState();
    let outcome;
    try {
      outcome = mutator() || {};
      if (outcome.persist !== false) persist();
    } catch (error) {
      restoreState(snapshot);
      throw error;
    }
    emitEvents(outcome.events);
    return outcome.value;
  }

  function ingest({ alertType, dedupeKey, severity, source, sourceAgent, summary, detail, tags, owner, assignee, runbook, impact, recoveryCondition, exitCondition, correlation }) {
    if (!alertType) throw alertError('bad_request', 'alertType required');
    if (!dedupeKey) throw alertError('bad_request', 'dedupeKey required');
    if (!summary)   throw alertError('bad_request', 'summary required');

    const ts = _now();
    const actionability = buildActionability({
      alertType,
      dedupeKey,
      severity,
      sourceAgent,
      owner,
      assignee,
      runbook,
      impact,
      recoveryCondition,
      exitCondition,
      correlation,
    });

    // 1. Active alert with same dedupeKey — increment
    const existingId = dedupeIndex.get(dedupeKey);
    if (existingId) {
      const existing = alerts.get(existingId);
      if (existing) {
        return commitMutation(() => {
          existing.occurrences += 1;
          existing.lastSeenAt = ts;
          existing.lastPayload = truncatePayload(detail);
          existing.summary = normalizeText(summary, 1024) || existing.summary;
          // Bug 1 fix: if suppressed and suppressUntil has passed, reopen
          if (existing.status === 'suppressed' && existing.suppressUntil && ts > existing.suppressUntil) {
            existing.status = 'open';
            existing.suppressUntil = null;
          }
          return {
            value: { alert: existing, created: false },
            events: [{ name: 'alert_updated', alert: existing }],
          };
        });
      }
    }

    // 2. Recently resolved with same dedupeKey — reopen
    for (const a of alerts.values()) {
      if (a.dedupeKey === dedupeKey && a.status === 'resolved'
          && a.resolvedAt && (ts - a.resolvedAt) < ALERT_REOPEN_WINDOW_MS) {
        return commitMutation(() => {
          a.status = 'open';
          a.resolvedAt = null;
          a.resolvedBy = null;
          a.occurrences += 1;
          a.lastSeenAt = ts;
          a.lastPayload = truncatePayload(detail);
          a.summary = normalizeText(summary, 1024) || a.summary;
          dedupeIndex.set(dedupeKey, a.id);
          return {
            value: { alert: a, created: false },
            events: [{ name: 'alert_updated', alert: a }],
          };
        });
      }
    }

    return commitMutation(() => {
      const events = [];

      // 3. Enforce max active cap
      const activeCount = [...alerts.values()].filter(a => a.status !== 'resolved').length;
      if (activeCount >= MAX_ACTIVE_ALERTS) {
        const oldest = [...alerts.values()]
          .filter(a => a.status !== 'resolved' && a.severity === 'info')
          .sort((a, b) => a.firstSeenAt - b.firstSeenAt)[0];
        if (oldest) {
          oldest.status = 'resolved';
          oldest.resolvedAt = ts;
          oldest.resolvedBy = 'system';
          if (!Array.isArray(oldest.notes)) oldest.notes = [];
          oldest.notes.push({ author: 'system', text: 'auto-pruned: cap exceeded', ts });
          dedupeIndex.delete(oldest.dedupeKey);
          events.push({ name: 'alert_resolved', alert: oldest });
        }
      }

      // 4. Create new alert
      const alert = {
        id: generateAlertId(),
        alertType: normalizeText(alertType, 128),
        dedupeKey,
        severity: actionability.severity,
        source: normalizeSource(source),
        sourceAgent: normalizeText(sourceAgent, 128) || null,
        summary: normalizeText(summary, 1024),
        detail: truncatePayload(detail) || '',
        occurrences: 1,
        firstSeenAt: ts,
        lastSeenAt: ts,
        lastPayload: truncatePayload(detail),
        status: 'open',
        assignee: actionability.assignee,
        owner: actionability.owner,
        runbook: actionability.runbook,
        impact: actionability.impact,
        recoveryCondition: actionability.recoveryCondition,
        correlation: actionability.correlation,
        actionable: actionability.actionable,
        originalSeverity: actionability.originalSeverity,
        missingActionableFields: actionability.missingActionableFields,
        notes: [],
        linkedTaskId: null,
        suppressUntil: null,
        tags: Array.isArray(tags) ? tags.map(t => normalizeText(t, 64)).filter(Boolean).slice(0, 20) : [],
        resolvedAt: null,
        resolvedBy: null,
      };
      alerts.set(alert.id, alert);
      dedupeIndex.set(dedupeKey, alert.id);
      events.push({ name: 'alert_created', alert });
      return { value: { alert, created: true }, events };
    });
  }

  function autoResolve(dedupeKey) {
    const alertId = dedupeIndex.get(dedupeKey);
    if (!alertId) return null;
    const alert = alerts.get(alertId);
    if (!alert || alert.status === 'resolved') return null;
    const ts = _now();
    return commitMutation(() => {
      alert.status = 'resolved';
      alert.resolvedAt = ts;
      alert.resolvedBy = 'system';
      if (!Array.isArray(alert.notes)) alert.notes = [];
      alert.notes.push({ author: 'system', text: 'auto-resolved on recovery', ts });
      dedupeIndex.delete(dedupeKey);
      return {
        value: alert,
        events: [{ name: 'alert_resolved', alert }],
      };
    });
  }

  // Auto-resolve all alerts whose dedupeKey starts with a given prefix
  function autoResolveByPrefix(prefix) {
    const matches = [];
    for (const [key, alertId] of dedupeIndex) {
      if (key.startsWith(prefix)) matches.push([key, alertId]);
    }
    if (!matches.length) return [];
    return commitMutation(() => {
      const resolved = [];
      const events = [];
      for (const [key, alertId] of matches) {
        const alert = alerts.get(alertId);
        if (!alert || alert.status === 'resolved') continue;
        const ts = _now();
        alert.status = 'resolved';
        alert.resolvedAt = ts;
        alert.resolvedBy = 'system';
        if (!Array.isArray(alert.notes)) alert.notes = [];
        alert.notes.push({ author: 'system', text: 'auto-resolved on recovery', ts });
        dedupeIndex.delete(key);
        resolved.push(alert);
        events.push({ name: 'alert_resolved', alert });
      }
      return { value: resolved, events, persist: resolved.length > 0 };
    });
  }

  function getAlert(id) {
    return alerts.get(id) || null;
  }

  function listAlerts(filters = {}) {
    let result = [...alerts.values()];
    if (filters.status) {
      const statuses = filters.status.split(',');
      result = result.filter(a => statuses.includes(a.status));
    }
    if (filters.severity) {
      const severities = filters.severity.split(',');
      result = result.filter(a => severities.includes(a.severity));
    }
    if (filters.sourceAgent) {
      result = result.filter(a => a.sourceAgent === filters.sourceAgent);
    }
    if (filters.alertType) {
      result = result.filter(a => a.alertType === filters.alertType);
    }
    if (filters.assignee) {
      result = result.filter(a => a.assignee === filters.assignee);
    }
    // Sort by lastSeenAt desc
    result.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    // Pagination
    const limit = Math.min(parseInt(filters.limit) || 100, 500);
    const offset = parseInt(filters.offset) || 0;
    return result.slice(offset, offset + limit);
  }

  function transition(id, newStatus, meta = {}) {
    const alert = alerts.get(id);
    if (!alert) throw alertError('not_found', 'alert not found');
    const allowed = TRANSITIONS.get(alert.status);
    if (!allowed || !allowed.has(newStatus)) {
      throw alertError('bad_transition', `cannot transition from ${alert.status} to ${newStatus}`);
    }
    return commitMutation(() => {
      const ts = _now();
      alert.status = newStatus;
      if (newStatus === 'resolved') {
        alert.resolvedAt = ts;
        alert.resolvedBy = meta.actor || 'operator';
        dedupeIndex.delete(alert.dedupeKey);
      }
      if (newStatus === 'assigned' && meta.assignee) {
        alert.assignee = normalizeText(meta.assignee, 128);
      }
      if (newStatus === 'suppressed') {
        alert.suppressUntil = meta.suppressUntil || (ts + ALERT_SUPPRESS_DEFAULT_MS);
        // Keep in dedupeIndex so new occurrences still increment
      }
      if (newStatus === 'open' && alert.suppressUntil) {
        alert.suppressUntil = null;
      }
      return {
        value: alert,
        events: [{ name: newStatus === 'resolved' ? 'alert_resolved' : 'alert_updated', alert }],
      };
    });
  }

  function addNote(id, note) {
    const alert = alerts.get(id);
    if (!alert) throw alertError('not_found', 'alert not found');
    const author = normalizeText(note.author, 128);
    const text = normalizeText(note.text, 2048);
    if (!text) throw alertError('bad_request', 'note text required');
    return commitMutation(() => {
      if (!Array.isArray(alert.notes)) alert.notes = [];
      alert.notes.push({ author: author || 'anonymous', text, ts: _now() });
      return {
        value: alert,
        events: [{ name: 'alert_updated', alert }],
      };
    });
  }

  function updateAlert(id, fields) {
    const alert = alerts.get(id);
    if (!alert) throw alertError('not_found', 'alert not found');
    return commitMutation(() => {
      const actionFieldsTouched = fields.owner !== undefined
        || fields.assignee !== undefined
        || fields.runbook !== undefined
        || fields.impact !== undefined
        || fields.recoveryCondition !== undefined
        || fields.exitCondition !== undefined
        || fields.correlation !== undefined;
      if (Array.isArray(fields.tags)) {
        alert.tags = fields.tags.map(t => normalizeText(t, 64)).filter(Boolean).slice(0, 20);
      }
      if (fields.linkedTaskId !== undefined) {
        alert.linkedTaskId = normalizeText(fields.linkedTaskId, 128);
      }
      if (fields.owner !== undefined) alert.owner = normalizeText(fields.owner, 128);
      if (fields.assignee !== undefined) alert.assignee = normalizeText(fields.assignee, 128);
      if (fields.runbook !== undefined) alert.runbook = normalizeText(fields.runbook, 512);
      if (fields.impact !== undefined) alert.impact = normalizeText(fields.impact, 1024);
      if (fields.recoveryCondition !== undefined || fields.exitCondition !== undefined) {
        alert.recoveryCondition = normalizeText(fields.recoveryCondition ?? fields.exitCondition, 1024);
      }
      if (fields.correlation !== undefined) {
        const nextCorrelation = normalizeCorrelation(fields.correlation, {
          alertType: alert.alertType,
          dedupeKey: alert.dedupeKey,
          sourceAgent: alert.sourceAgent,
        });
        alert.correlation = { ...(alert.correlation || {}), ...nextCorrelation };
      }
      if (actionFieldsTouched) {
        const actionability = buildActionability({
          alertType: alert.alertType,
          dedupeKey: alert.dedupeKey,
          severity: alert.originalSeverity || alert.severity,
          sourceAgent: alert.sourceAgent,
          owner: alert.owner,
          assignee: alert.assignee,
          runbook: alert.runbook,
          impact: alert.impact,
          recoveryCondition: alert.recoveryCondition,
          correlation: alert.correlation,
        });
        alert.severity = actionability.severity;
        alert.owner = actionability.owner;
        alert.assignee = actionability.assignee;
        alert.runbook = actionability.runbook;
        alert.impact = actionability.impact;
        alert.recoveryCondition = actionability.recoveryCondition;
        alert.correlation = actionability.correlation;
        alert.actionable = actionability.actionable;
        alert.originalSeverity = actionability.originalSeverity;
        alert.missingActionableFields = actionability.missingActionableFields;
      }
      return {
        value: alert,
        events: [{ name: 'alert_updated', alert }],
      };
    });
  }

  function deleteAlert(id) {
    const alert = alerts.get(id);
    if (!alert) return null;
    return commitMutation(() => {
      alerts.delete(id);
      if (dedupeIndex.get(alert.dedupeKey) === id) {
        dedupeIndex.delete(alert.dedupeKey);
      }
      return { value: alert };
    });
  }

  function getStats() {
    const stats = { total: 0, byStatus: {}, bySeverity: {} };
    for (const s of STATUSES) stats.byStatus[s] = 0;
    for (const s of SEVERITIES) stats.bySeverity[s] = 0;
    for (const alert of alerts.values()) {
      stats.total++;
      stats.byStatus[alert.status] = (stats.byStatus[alert.status] || 0) + 1;
      if (alert.status !== 'resolved') {
        stats.bySeverity[alert.severity] = (stats.bySeverity[alert.severity] || 0) + 1;
      }
    }
    return stats;
  }

  function pruneResolved(maxAgeMs = ALERT_RESOLVED_TTL_MS) {
    const ts = _now();
    const prunable = [];
    for (const [id, alert] of alerts) {
      if (alert.status === 'resolved' && alert.resolvedAt && (ts - alert.resolvedAt) > maxAgeMs) {
        prunable.push(id);
      }
    }
    if (!prunable.length) return 0;
    return commitMutation(() => {
      for (const id of prunable) {
        alerts.delete(id);
      }
      return { value: prunable.length };
    });
  }

  function dump() { return [...alerts.values()]; }

  return {
    ingest, autoResolve, autoResolveByPrefix, getAlert, listAlerts,
    updateAlert, transition, addNote, deleteAlert, getStats, pruneResolved, dump,
  };
}

export { RECOVERY_MAP, SEVERITIES, STATUSES, SOURCES, TRANSITIONS };
