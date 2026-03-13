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

  function persist() { save([...alerts.values()]); }

  function _emit(eventName, alert) {
    if (emitEvent) emitEvent(eventName, alert);
  }

  function ingest({ alertType, dedupeKey, severity, source, sourceAgent, summary, detail, tags }) {
    if (!alertType) throw alertError('bad_request', 'alertType required');
    if (!dedupeKey) throw alertError('bad_request', 'dedupeKey required');
    if (!summary)   throw alertError('bad_request', 'summary required');

    const ts = _now();

    // 1. Active alert with same dedupeKey — increment
    const existingId = dedupeIndex.get(dedupeKey);
    if (existingId) {
      const existing = alerts.get(existingId);
      if (existing) {
        existing.occurrences += 1;
        existing.lastSeenAt = ts;
        existing.lastPayload = truncatePayload(detail);
        existing.summary = normalizeText(summary, 1024) || existing.summary;
        persist();
        _emit('alert_updated', existing);
        return { alert: existing, created: false };
      }
    }

    // 2. Recently resolved with same dedupeKey — reopen
    for (const a of alerts.values()) {
      if (a.dedupeKey === dedupeKey && a.status === 'resolved'
          && a.resolvedAt && (ts - a.resolvedAt) < ALERT_REOPEN_WINDOW_MS) {
        a.status = 'open';
        a.resolvedAt = null;
        a.resolvedBy = null;
        a.occurrences += 1;
        a.lastSeenAt = ts;
        a.lastPayload = truncatePayload(detail);
        a.summary = normalizeText(summary, 1024) || a.summary;
        dedupeIndex.set(dedupeKey, a.id);
        persist();
        _emit('alert_updated', a);
        return { alert: a, created: false };
      }
    }

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
        _emit('alert_resolved', oldest);
      }
    }

    // 4. Create new alert
    const alert = {
      id: generateAlertId(),
      alertType: normalizeText(alertType, 128),
      dedupeKey,
      severity: normalizeSeverity(severity),
      source: normalizeSource(source),
      sourceAgent: normalizeText(sourceAgent, 128) || null,
      summary: normalizeText(summary, 1024),
      detail: truncatePayload(detail) || '',
      occurrences: 1,
      firstSeenAt: ts,
      lastSeenAt: ts,
      lastPayload: truncatePayload(detail),
      status: 'open',
      assignee: null,
      notes: [],
      linkedTaskId: null,
      suppressUntil: null,
      tags: Array.isArray(tags) ? tags.map(t => normalizeText(t, 64)).filter(Boolean).slice(0, 20) : [],
      resolvedAt: null,
      resolvedBy: null,
    };
    alerts.set(alert.id, alert);
    dedupeIndex.set(dedupeKey, alert.id);
    persist();
    _emit('alert_created', alert);
    return { alert, created: true };
  }

  function autoResolve(dedupeKey) {
    const alertId = dedupeIndex.get(dedupeKey);
    if (!alertId) return null;
    const alert = alerts.get(alertId);
    if (!alert || alert.status === 'resolved') return null;
    const ts = _now();
    alert.status = 'resolved';
    alert.resolvedAt = ts;
    alert.resolvedBy = 'system';
    if (!Array.isArray(alert.notes)) alert.notes = [];
    alert.notes.push({ author: 'system', text: 'auto-resolved on recovery', ts });
    dedupeIndex.delete(dedupeKey);
    persist();
    _emit('alert_resolved', alert);
    return alert;
  }

  // Auto-resolve all alerts whose dedupeKey starts with a given prefix
  function autoResolveByPrefix(prefix) {
    const resolved = [];
    for (const [key, alertId] of dedupeIndex) {
      if (!key.startsWith(prefix)) continue;
      const alert = alerts.get(alertId);
      if (!alert || alert.status === 'resolved') continue;
      const ts = _now();
      alert.status = 'resolved';
      alert.resolvedAt = ts;
      alert.resolvedBy = 'system';
      if (!Array.isArray(alert.notes)) alert.notes = [];
      alert.notes.push({ author: 'system', text: 'auto-resolved on recovery', ts });
      dedupeIndex.delete(key);
      _emit('alert_resolved', alert);
      resolved.push(alert);
    }
    if (resolved.length) persist();
    return resolved;
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
    persist();
    _emit(newStatus === 'resolved' ? 'alert_resolved' : 'alert_updated', alert);
    return alert;
  }

  function addNote(id, note) {
    const alert = alerts.get(id);
    if (!alert) throw alertError('not_found', 'alert not found');
    const author = normalizeText(note.author, 128);
    const text = normalizeText(note.text, 2048);
    if (!text) throw alertError('bad_request', 'note text required');
    if (!Array.isArray(alert.notes)) alert.notes = [];
    alert.notes.push({ author: author || 'anonymous', text, ts: _now() });
    persist();
    _emit('alert_updated', alert);
    return alert;
  }

  function updateAlert(id, fields) {
    const alert = alerts.get(id);
    if (!alert) throw alertError('not_found', 'alert not found');
    if (Array.isArray(fields.tags)) {
      alert.tags = fields.tags.map(t => normalizeText(t, 64)).filter(Boolean).slice(0, 20);
    }
    if (fields.linkedTaskId !== undefined) {
      alert.linkedTaskId = normalizeText(fields.linkedTaskId, 128);
    }
    persist();
    _emit('alert_updated', alert);
    return alert;
  }

  function deleteAlert(id) {
    const alert = alerts.get(id);
    if (!alert) return null;
    alerts.delete(id);
    if (dedupeIndex.get(alert.dedupeKey) === id) {
      dedupeIndex.delete(alert.dedupeKey);
    }
    persist();
    return alert;
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
    let pruned = 0;
    for (const [id, alert] of alerts) {
      if (alert.status === 'resolved' && alert.resolvedAt && (ts - alert.resolvedAt) > maxAgeMs) {
        alerts.delete(id);
        pruned++;
      }
    }
    if (pruned > 0) persist();
    return pruned;
  }

  function dump() { return [...alerts.values()]; }

  return {
    ingest, autoResolve, autoResolveByPrefix, getAlert, listAlerts,
    updateAlert, transition, addNote, deleteAlert, getStats, pruneResolved, dump,
  };
}

export { RECOVERY_MAP, SEVERITIES, STATUSES, SOURCES, TRANSITIONS };
