const FLOW_HEALTH_ACTIONABLE_ALERT_STATUSES = new Set(['open', 'acknowledged', 'assigned']);
const FLOW_HEALTH_ACTIONABLE_ALERT_SEVERITIES = new Set(['critical', 'warning']);

export function alertBacklogHealth(alerts = []) {
  const actionable = {
    total: 0,
    critical: 0,
    warning: 0,
    byStatus: { open: 0, acknowledged: 0, assigned: 0 },
  };
  for (const alert of alerts) {
    if (!FLOW_HEALTH_ACTIONABLE_ALERT_STATUSES.has(alert?.status)) continue;
    if (!FLOW_HEALTH_ACTIONABLE_ALERT_SEVERITIES.has(alert?.severity)) continue;
    actionable.total += 1;
    actionable[alert.severity] += 1;
    actionable.byStatus[alert.status] = (actionable.byStatus[alert.status] || 0) + 1;
  }
  return {
    status: actionable.critical > 0 ? 'unhealthy' : (actionable.warning > 0 ? 'degraded' : 'healthy'),
    actionable,
  };
}

export function serverFlowHealth(serverRows = [], {
  now = Date.now(),
  heartbeatTtlMs,
  isServerInMaintenance = () => false,
} = {}) {
  const total = serverRows.length;
  let online = 0;
  let maintenance = 0;
  let offline = 0;
  let stale = 0;
  for (const server of serverRows) {
    const inMaintenance = isServerInMaintenance(server?.id, server);
    if (inMaintenance) maintenance += 1;
    if (server?.online === true) online += 1;
    else if (!inMaintenance) offline += 1;
    const heartbeatAt = Number(server?.heartbeatAt) || 0;
    if (!inMaintenance && heartbeatAt > 0 && (now - heartbeatAt) > heartbeatTtlMs) stale += 1;
  }
  const status = total === 0
    ? 'unknown'
    : ((offline > 0 || stale > 0) ? 'unhealthy' : (maintenance > 0 || online < total ? 'degraded' : 'healthy'));
  return { status, total, online, offline, maintenance, stale };
}

export function agentFlowHealth(agentNames = [], {
  getAgentDeliveryState = () => ({}),
  getAgentRuntime = () => null,
} = {}) {
  const total = agentNames.length;
  let online = 0;
  let offline = 0;
  let blocked = 0;
  for (const name of agentNames) {
    const deliveryState = getAgentDeliveryState(name);
    if (deliveryState.online) online += 1;
    else offline += 1;
    if (getAgentRuntime(name)?.blocked === true) blocked += 1;
  }
  const status = total === 0
    ? 'unknown'
    : (online === 0 ? 'unhealthy' : ((offline > 0 || blocked > 0) ? 'degraded' : 'healthy'));
  return { status, total, online, offline, blocked };
}

export function runtimeFlowHealth(runtimeRows = [], {
  now = Date.now(),
  heartbeatTtlMs,
} = {}) {
  let blocked = 0;
  let stale = 0;
  const staleAfterMs = Math.max(heartbeatTtlMs * 2, 120000);
  for (const runtime of runtimeRows) {
    if (runtime.blocked === true) blocked += 1;
    const updatedAt = Number(runtime.updatedAt) || 0;
    if (updatedAt > 0 && (now - updatedAt) > staleAfterMs) stale += 1;
  }
  const status = runtimeRows.length === 0
    ? 'unknown'
    : ((blocked > 0 || stale > 0) ? 'degraded' : 'healthy');
  return { status, total: runtimeRows.length, blocked, stale, staleAfterMs };
}

export function authFlowHealth(agentTokenReadiness, serverCredentialReadiness) {
  const agentTokensDegraded = agentTokenReadiness?.behavior === 'enforce-loaded-tokens'
    && agentTokenReadiness.failClosedReady === false;
  return {
    status: agentTokensDegraded ? 'degraded' : 'healthy',
    agentTokenMode: agentTokenReadiness?.mode || null,
    missingManagedAgentTokenCount: Number(agentTokenReadiness?.missingManagedAgentTokenCount) || 0,
    serverCredentialBoundary: serverCredentialReadiness?.boundary || null,
  };
}

export function deliveryEventFlowHealth({
  readDeliveryEvents = () => [],
} = {}) {
  const events = readDeliveryEvents({ limit: 1000 });
  let lastEventAt = 0;
  const recentTypes = {};
  for (const event of events) {
    const ts = Number(event?.ts) || 0;
    if (ts > lastEventAt) lastEventAt = ts;
    if (event?.type) recentTypes[event.type] = (recentTypes[event.type] || 0) + 1;
  }
  return {
    status: events.length > 0 ? 'healthy' : 'unknown',
    enabled: true,
    recentCount: events.length,
    lastEventAt: lastEventAt || null,
    recentTypes,
  };
}

export function aggregateFlowHealthStatus(components, hasPrimarySignals) {
  const statuses = Object.values(components).map(component => component?.status).filter(Boolean);
  if (statuses.includes('unhealthy')) return 'unhealthy';
  if (statuses.includes('degraded')) return 'degraded';
  if (!hasPrimarySignals) return 'unknown';
  return 'healthy';
}

export function buildFlowHealth({
  serverRows = [],
  agentNames = [],
  agentTokenReadiness,
  serverCredentialReadiness,
  heartbeatTtlMs,
  isServerInMaintenance,
  getAgentDeliveryState,
  getAgentRuntime,
  getAgentRuntimeRows = () => [],
  listAlerts = () => [],
  readDeliveryEvents,
  messageCount = 0,
}) {
  const alerts = listAlerts();
  const components = {
    servers: serverFlowHealth(serverRows, { heartbeatTtlMs, isServerInMaintenance }),
    agents: agentFlowHealth(agentNames, { getAgentDeliveryState, getAgentRuntime }),
    runtime: runtimeFlowHealth(getAgentRuntimeRows(), { heartbeatTtlMs }),
    alerts: alertBacklogHealth(alerts),
    auth: authFlowHealth(agentTokenReadiness, serverCredentialReadiness),
    deliveryEvents: deliveryEventFlowHealth({ readDeliveryEvents }),
  };
  const hasPrimarySignals = serverRows.length > 0
    || agentNames.length > 0
    || messageCount > 0
    || alerts.length > 0;
  const status = aggregateFlowHealthStatus(components, hasPrimarySignals);
  const reasons = Object.entries(components)
    .filter(([, component]) => component?.status === 'unhealthy' || component?.status === 'degraded')
    .map(([name, component]) => `${name}:${component.status}`);
  if (status === 'unknown' && reasons.length === 0) reasons.push('no-health-signals');
  return {
    status,
    generatedAt: Date.now(),
    components,
    reasons,
  };
}
