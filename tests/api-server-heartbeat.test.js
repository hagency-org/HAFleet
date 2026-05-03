import { afterEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function serversPath(runtimeDir) {
  return path.join(runtimeDir, 'data', 'servers.json');
}

function agentsPath(runtimeDir) {
  return path.join(runtimeDir, 'data', 'agents.json');
}

function agentRuntimePath(runtimeDir) {
  return path.join(runtimeDir, 'data', 'agent_runtime.json');
}

function systemInfoPath(runtimeDir) {
  return path.join(runtimeDir, 'data', 'system-info.jsonl');
}

function readSystemInfo(runtimeDir) {
  const filePath = systemInfoPath(runtimeDir);
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, 'utf-8').trim();
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function makeAgent(name, overrides = {}) {
  return {
    name,
    type: 'agent',
    kind: 'agent',
    online: false,
    server: null,
    manualDown: false,
    offlineReason: null,
    ...overrides,
  };
}

function baseSeed(overrides = {}) {
  return {
    agents: {
      'remote-agent': makeAgent('remote-agent', { server: 'remote-host-1' }),
      'local-agent': makeAgent('local-agent', { online: true, server: null }),
      ...(overrides.agents || {}),
    },
    groups: overrides.groups || {},
    messages: overrides.messages || [],
    cursors: overrides.cursors || {},
    servers: overrides.servers || {},
    agentRuntime: overrides.agentRuntime || {},
    env: {
      AGENT_HEARTBEAT_TTL_MS: '5000',
      AGENT_SERVER_SWEEP_INTERVAL_MS: '60000',
      AGENT_SERVER_MAINTENANCE_IDS: '',
      ...(overrides.env || {}),
    },
  };
}

async function postHeartbeat(app, body) {
  return request(app).post('/api/servers/heartbeat').send(body);
}

describe('server heartbeat api', () => {
  let context = null;

  afterEach(() => {
    context?.cleanup();
    context = null;
  });

  test('registers a server on first heartbeat', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed());

    const response = await postHeartbeat(context.app, {
      server: 'remote-host-1',
      sessions: ['remote-agent:0.0'],
      agents: ['remote-agent'],
      instanceId: 'inst-abc',
      bootTs: 1000,
    });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.maintenance).toBe(false);
    expect(response.body.ignored).toBe(false);

    const servers = readJson(serversPath(context.runtimeDir));
    expect(servers['remote-host-1']).toMatchObject({
      id: 'remote-host-1',
      relayInstanceId: 'inst-abc',
      relayBootTs: 1000,
      agentCount: 1,
      online: true,
    });
    expect(Number(servers['remote-host-1'].heartbeatAt)).toBeGreaterThan(0);
    expect(Number(servers['remote-host-1'].lastSeen)).toBeGreaterThan(0);
  });

  test('heartbeat does not overwrite runtime observation provenance', async () => {
    const observation = {
      observerSource: 'runtime-api',
      observerServer: 'remote-host-1',
      observedAt: 12345,
    };
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed({
      agents: {
        'remote-agent': makeAgent('remote-agent', {
          online: true,
          server: 'remote-host-1',
          tmux: 'remote-agent:0.0',
        }),
      },
      agentRuntime: {
        'remote-agent': {
          blocked: false,
          activeNow: true,
          observation,
        },
      },
    }));

    const response = await postHeartbeat(context.app, {
      server: 'remote-host-1',
      sessions: ['remote-agent:0.0'],
      agents: ['remote-agent'],
      instanceId: 'inst-abc',
      bootTs: 1000,
    });

    expect(response.status).toBe(200);
    const runtime = readJson(agentRuntimePath(context.runtimeDir));
    expect(runtime['remote-agent'].observation).toEqual(observation);
    const agent = await request(context.app).get('/api/agents/remote-agent').expect(200);
    expect(agent.body.runtimeObservation).toEqual(observation);
  });

  test('marks heartbeat agents online and assigns their server', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed({
      agents: {
        'remote-agent': makeAgent('remote-agent', { online: false, server: 'remote-host-1' }),
      },
    }));

    const heartbeat = await postHeartbeat(context.app, {
      server: 'remote-host-1',
      agents: ['remote-agent'],
      sessions: ['remote-agent:0.0'],
      instanceId: 'inst-1',
      bootTs: 1000,
    });
    const agent = await request(context.app).get('/api/agents/remote-agent');

    expect(heartbeat.status).toBe(200);
    expect(agent.status).toBe(200);
    expect(agent.body.online).toBe(true);
    expect(agent.body.server).toBe('remote-host-1');
  });

  test('requires a server id on heartbeat', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed());

    const missing = await postHeartbeat(context.app, {});
    const empty = await postHeartbeat(context.app, { server: '' });
    const blank = await postHeartbeat(context.app, { server: '   ' });

    expect(missing.status).toBe(400);
    expect(empty.status).toBe(400);
    expect(blank.status).toBe(400);
    expect(missing.body).toEqual({ error: 'server required' });
    expect(empty.body).toEqual({ error: 'server required' });
    expect(blank.body).toEqual({ error: 'server required' });
  });

  test('creates missing agent records from heartbeat payloads', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', {
      agents: {},
      groups: {},
      messages: [],
      cursors: {},
      servers: {},
      agentRuntime: {},
      env: {
        AGENT_HEARTBEAT_TTL_MS: '5000',
        AGENT_SERVER_SWEEP_INTERVAL_MS: '60000',
        AGENT_SERVER_MAINTENANCE_IDS: '',
      },
    });

    const heartbeat = await postHeartbeat(context.app, {
      server: 'remote-host-1',
      agents: ['new-agent'],
      sessions: ['new-agent:0.0'],
      instanceId: 'inst-1',
      bootTs: 1000,
    });
    const agent = await request(context.app).get('/api/agents/new-agent');

    expect(heartbeat.status).toBe(200);
    expect(agent.status).toBe(200);
    expect(agent.body.server).toBe('remote-host-1');
    expect(agent.body.kind).toBe('agent');
    expect(agent.body.online).toBe(true);
  });

  test('marks agents missing from a heartbeat snapshot offline', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed({
      agents: {
        'agent-a': makeAgent('agent-a', { online: true, server: 'remote-host-1', tmux: 'agent-a:0.0' }),
        'agent-b': makeAgent('agent-b', { online: true, server: 'remote-host-1', tmux: 'agent-b:0.0' }),
      },
    }));

    const response = await postHeartbeat(context.app, {
      server: 'remote-host-1',
      agents: ['agent-a'],
      sessions: ['agent-a:0.0'],
      instanceId: 'inst-1',
      bootTs: 1000,
    });
    const agents = readJson(agentsPath(context.runtimeDir));

    expect(response.status).toBe(200);
    expect(agents['agent-a'].online).toBe(true);
    expect(agents['agent-b'].online).toBe(false);
    expect(agents['agent-b'].offlineReason).toBe('heartbeat-missing:remote-host-1');
    expect(agents['agent-b'].tmux).toBe(null);
  });

  test('accepts repeated heartbeats from the same instance lease', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed());

    const first = await postHeartbeat(context.app, {
      server: 's1',
      instanceId: 'inst-A',
      bootTs: 1000,
      agents: [],
      sessions: [],
    });
    const second = await postHeartbeat(context.app, {
      server: 's1',
      instanceId: 'inst-A',
      bootTs: 1000,
      agents: [],
      sessions: [],
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.ok).toBe(true);
  });

  test('rejects a different instance while an active lease is held', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed());

    await postHeartbeat(context.app, {
      server: 's1',
      instanceId: 'inst-A',
      bootTs: 1000,
      agents: [],
      sessions: [],
    });
    const second = await postHeartbeat(context.app, {
      server: 's1',
      instanceId: 'inst-B',
      bootTs: 1000,
      agents: [],
      sessions: [],
    });

    expect(second.status).toBe(409);
    expect(second.body.error).toBe('heartbeat_lease_rejected');
    expect(second.body.reason).toBe('older-boot');
    expect(readJson(serversPath(context.runtimeDir)).s1.relayInstanceId).toBe('inst-A');
  });

  test('accepts takeover from a newer boot timestamp', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed());

    await postHeartbeat(context.app, {
      server: 's1',
      instanceId: 'inst-A',
      bootTs: 1000,
      agents: [],
      sessions: [],
    });
    const second = await postHeartbeat(context.app, {
      server: 's1',
      instanceId: 'inst-B',
      bootTs: 2000,
      agents: [],
      sessions: [],
    });

    expect(second.status).toBe(200);
    expect(readJson(serversPath(context.runtimeDir)).s1.relayInstanceId).toBe('inst-B');
  });

  test('rejects takeover from an older boot timestamp', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed());

    await postHeartbeat(context.app, {
      server: 's1',
      instanceId: 'inst-A',
      bootTs: 2000,
      agents: [],
      sessions: [],
    });
    const second = await postHeartbeat(context.app, {
      server: 's1',
      instanceId: 'inst-B',
      bootTs: 1000,
      agents: [],
      sessions: [],
    });

    expect(second.status).toBe(409);
    expect(second.body.reason).toBe('older-boot');
  });

  test('accepts a new instance after the lease becomes stale', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed({
      env: {
        AGENT_HEARTBEAT_TTL_MS: '100',
      },
    }));

    await postHeartbeat(context.app, {
      server: 's1',
      instanceId: 'inst-A',
      bootTs: 1000,
      agents: [],
      sessions: [],
    });
    await sleep(200);
    const second = await postHeartbeat(context.app, {
      server: 's1',
      instanceId: 'inst-B',
      bootTs: 3000,
      agents: [],
      sessions: [],
    });

    expect(second.status).toBe(200);
    expect(readJson(serversPath(context.runtimeDir)).s1.relayInstanceId).toBe('inst-B');
  });

  test('accepts heartbeats without an instance id when no active lease exists', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed());

    const response = await postHeartbeat(context.app, {
      server: 's1',
      agents: [],
      sessions: [],
    });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  test('rejects missing instance id while an active lease exists', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed());

    await postHeartbeat(context.app, {
      server: 's1',
      instanceId: 'inst-A',
      bootTs: 1000,
      agents: [],
      sessions: [],
    });
    const second = await postHeartbeat(context.app, {
      server: 's1',
      agents: [],
      sessions: [],
    });

    expect(second.status).toBe(409);
    expect(second.body.reason).toBe('missing-instance-id-while-lease-active');
  });

  test('marks a server offline after its heartbeat ttl expires', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed({
      agents: {
        'agent-a': makeAgent('agent-a', { online: false, server: 's1' }),
      },
      env: {
        AGENT_HEARTBEAT_TTL_MS: '100',
      },
    }));

    await postHeartbeat(context.app, {
      server: 's1',
      instanceId: 'inst-1',
      bootTs: 1000,
      agents: ['agent-a'],
      sessions: ['agent-a:0.0'],
    });
    await sleep(200);
    const servers = await request(context.app).get('/api/servers');
    const agents = readJson(agentsPath(context.runtimeDir));

    expect(servers.status).toBe(200);
    expect(servers.body[0].online).toBe(false);
    expect(agents['agent-a'].online).toBe(false);
    expect(agents['agent-a'].offlineReason).toBe('server-offline:s1');

    const alerts = await request(context.app).get('/api/alerts?status=open&alertType=server_offline');
    expect(alerts.status).toBe(200);
    expect(alerts.body).toEqual([
      expect.objectContaining({
        alertType: 'server_offline',
        dedupeKey: 'server_offline:s1',
        severity: 'critical',
        sourceAgent: 's1',
        summary: "Remote server 's1' is offline",
        actionable: true,
        owner: 'remote-runtime',
        runbook: 'docs/runbooks/remote-server-offline.md',
        impact: 'remote agents on this server are marked offline and direct push delivery is unavailable until the relay recovers',
        recoveryCondition: 'the next accepted heartbeat from this server auto-resolves this alert',
        correlation: expect.objectContaining({
          dedupeKey: 'server_offline:s1',
          serverId: 's1',
          affectedAgents: ['agent-a'],
        }),
      }),
    ]);
    expect(alerts.body[0].detail).toContain('Affected agents: agent-a');
    expect(alerts.body[0].detail).toContain('Runbook:');
    expect(alerts.body[0].detail).toContain('Recovery condition:');
  });

  test('heartbeat recovery resolves only the matching server outage alert', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed({
      agents: {
        'agent-a': makeAgent('agent-a', { online: false, server: 's1' }),
        'agent-b': makeAgent('agent-b', { online: false, server: 's2' }),
      },
      env: {
        AGENT_HEARTBEAT_TTL_MS: '100',
      },
    }));

    await postHeartbeat(context.app, {
      server: 's1',
      instanceId: 'inst-1',
      bootTs: 1000,
      agents: ['agent-a'],
      sessions: ['agent-a:0.0'],
    });
    await postHeartbeat(context.app, {
      server: 's2',
      instanceId: 'inst-2',
      bootTs: 1000,
      agents: ['agent-b'],
      sessions: ['agent-b:0.0'],
    });
    await sleep(200);
    await request(context.app).get('/api/servers');

    const openBefore = await request(context.app).get('/api/alerts?status=open&alertType=server_offline');
    expect(openBefore.body.map((alert) => alert.dedupeKey).sort()).toEqual(['server_offline:s1', 'server_offline:s2']);

    await postHeartbeat(context.app, {
      server: 's1',
      instanceId: 'inst-3',
      bootTs: 3000,
      agents: ['agent-a'],
      sessions: ['agent-a:0.0'],
    });

    const openAfter = await request(context.app).get('/api/alerts?status=open&alertType=server_offline');
    expect(openAfter.body.map((alert) => alert.dedupeKey)).toEqual(['server_offline:s2']);
    const resolved = await request(context.app).get('/api/alerts?status=resolved&alertType=server_offline');
    expect(resolved.body).toEqual(expect.arrayContaining([
      expect.objectContaining({
        dedupeKey: 'server_offline:s1',
        resolvedBy: 'system',
      }),
    ]));
  });

  test('keeps a server online when heartbeats renew before ttl expiry', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed({
      env: {
        AGENT_HEARTBEAT_TTL_MS: '500',
      },
    }));

    await postHeartbeat(context.app, {
      server: 's1',
      instanceId: 'inst-1',
      bootTs: 1000,
      agents: [],
      sessions: [],
    });
    await sleep(300);
    await postHeartbeat(context.app, {
      server: 's1',
      instanceId: 'inst-1',
      bootTs: 1000,
      agents: [],
      sessions: [],
    });
    await sleep(300);
    const servers = await request(context.app).get('/api/servers');

    expect(servers.status).toBe(200);
    expect(servers.body[0].online).toBe(true);
  });

  test('reports server counts through /health', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', {
      agents: {},
      groups: {},
      messages: [],
      cursors: {},
      servers: {},
      agentRuntime: {},
      env: {
        AGENT_HEARTBEAT_TTL_MS: '5000',
        AGENT_SERVER_SWEEP_INTERVAL_MS: '60000',
        AGENT_SERVER_MAINTENANCE_IDS: '',
      },
    });

    await postHeartbeat(context.app, {
      server: 's1',
      instanceId: 'i1',
      bootTs: 1,
      agents: ['a1'],
      sessions: ['a1:0.0'],
    });
    await postHeartbeat(context.app, {
      server: 's2',
      instanceId: 'i2',
      bootTs: 1,
      agents: ['a2'],
      sessions: ['a2:0.0'],
    });
    const health = await request(context.app).get('/health');

    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({
      ok: true,
      servers: 2,
      onlineServers: 2,
      agents: 2,
      onlineAgents: 2,
      health: {
        status: 'healthy',
        components: {
          servers: expect.objectContaining({ status: 'healthy', total: 2, online: 2 }),
          agents: expect.objectContaining({ status: 'healthy', total: 2, online: 2 }),
          alerts: expect.objectContaining({
            status: 'healthy',
            actionable: expect.objectContaining({ total: 0, critical: 0, warning: 0 }),
          }),
        },
      },
    });
    expect(Number.isFinite(health.body.health.generatedAt)).toBe(true);
  });

  test('reports unknown flow health for an empty install', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', {
      agents: {},
      groups: {},
      messages: [],
      cursors: {},
      servers: {},
      agentRuntime: {},
      env: {
        AGENT_HEARTBEAT_TTL_MS: '5000',
        AGENT_SERVER_SWEEP_INTERVAL_MS: '60000',
        AGENT_SERVER_MAINTENANCE_IDS: '',
      },
    });

    const health = await request(context.app).get('/health');

    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(true);
    expect(health.body.health).toMatchObject({
      status: 'unknown',
      components: {
        servers: expect.objectContaining({ status: 'unknown', total: 0 }),
        agents: expect.objectContaining({ status: 'unknown', total: 0 }),
      },
    });
  });

  test('summarizes actionable alert backlog without changing top-level ok', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed());

    await request(context.app).post('/api/system/info')
      .send({ summary: 'MCP missing', full: 'warn detail', alertType: 'mcp_missing', dedupeKey: 'mcp_missing:alpha', sourceAgent: 'alpha' });
    let health = await request(context.app).get('/health');
    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(true);
    expect(health.body.health).toMatchObject({
      status: 'degraded',
      components: {
        alerts: expect.objectContaining({
          status: 'degraded',
          actionable: expect.objectContaining({ total: 1, critical: 0, warning: 1 }),
        }),
      },
    });

    await request(context.app).post('/api/system/info')
      .send({ summary: 'Swap high diagnostic', full: 'missing action fields', alertType: 'swap_high', dedupeKey: 'swap_high:diagnostic' });
    health = await request(context.app).get('/health');
    expect(health.body.health.components.alerts).toMatchObject({
      status: 'degraded',
      actionable: expect.objectContaining({ total: 1, critical: 0, warning: 1 }),
    });

    await request(context.app).post('/api/system/info')
      .send({ summary: 'Server offline', full: 'critical detail', alertType: 'server_offline', dedupeKey: 'server_offline:s1', sourceAgent: 's1' });
    health = await request(context.app).get('/health');
    expect(health.body.health).toMatchObject({
      status: 'unhealthy',
      components: {
        alerts: expect.objectContaining({
          status: 'unhealthy',
          actionable: expect.objectContaining({ total: 2, critical: 1, warning: 1 }),
        }),
      },
    });

    const critical = (await request(context.app).get('/api/alerts?alertType=server_offline')).body[0];
    await request(context.app).post(`/api/alerts/${critical.id}/transition`).send({ status: 'suppressed' });
    health = await request(context.app).get('/health');
    expect(health.body.health).toMatchObject({
      status: 'degraded',
      components: {
        alerts: expect.objectContaining({
          status: 'degraded',
          actionable: expect.objectContaining({ total: 1, critical: 0, warning: 1 }),
        }),
      },
    });
  });

  test('health reports the server credential compatibility boundary', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed({
      env: {
        API_TOKEN: 'operator-token',
        AGENTCHAT_SERVER_TOKEN: 'server-token',
      },
    }));

    const health = await request(context.app).get('/health');

    expect(health.status).toBe(200);
    expect(health.body.auth.serverCredential).toMatchObject({
      boundary: 'compat-api-token',
      behavior: 'server-routes-require-api-token',
      operatorBearerConfigured: true,
      serverTokenConfigured: true,
      serverTokenAccepted: false,
      serverTokenEnforced: false,
      futureCredential: 'AGENTCHAT_SERVER_TOKEN',
    });
    expect(health.body.auth.serverCredential.serverOwnedRoutes).toEqual([
      'POST /api/servers/heartbeat',
      'POST /api/servers/:id/offline',
      'POST /api/agents/:name/runtime',
      'POST /api/runtime/compact',
    ]);
    expect(health.body.auth.serverCredential.operatorOwnedRoutes).toEqual([
      'POST /api/servers/:id/maintenance',
    ]);
    expect(health.body.auth.serverCredential.relayReadRoutes).toEqual([
      'GET /api/stream',
    ]);
  });

  test('server routes keep API_TOKEN compatibility and do not accept server token yet', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed({
      env: {
        API_TOKEN: 'operator-token',
        AGENTCHAT_SERVER_TOKEN: 'server-token',
      },
    }));

    const heartbeatPayload = {
      server: 's1',
      instanceId: 'inst-1',
      bootTs: 1000,
      agents: [],
      sessions: [],
    };

    const missingHeartbeatAuth = await request(context.app)
      .post('/api/servers/heartbeat')
      .send(heartbeatPayload);
    const serverTokenHeartbeat = await request(context.app)
      .post('/api/servers/heartbeat')
      .set('Authorization', 'Bearer server-token')
      .send(heartbeatPayload);
    const operatorHeartbeat = await request(context.app)
      .post('/api/servers/heartbeat')
      .set('Authorization', 'Bearer operator-token')
      .send(heartbeatPayload);

    expect(missingHeartbeatAuth.status).toBe(401);
    expect(serverTokenHeartbeat.status).toBe(401);
    expect(operatorHeartbeat.status).toBe(200);

    const serverTokenOffline = await request(context.app)
      .post('/api/servers/s1/offline')
      .set('Authorization', 'Bearer server-token')
      .send({ instanceId: 'inst-1' });
    const operatorOffline = await request(context.app)
      .post('/api/servers/s1/offline')
      .set('Authorization', 'Bearer operator-token')
      .send({ instanceId: 'inst-1' });

    expect(serverTokenOffline.status).toBe(401);
    expect(operatorOffline.status).toBe(200);
  });

  test('server token does not grant operator maintenance access in compatibility mode', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed({
      env: {
        API_TOKEN: 'operator-token',
        AGENTCHAT_SERVER_TOKEN: 'server-token',
      },
    }));

    const serverTokenMaintenance = await request(context.app)
      .post('/api/servers/s1/maintenance')
      .set('Authorization', 'Bearer server-token')
      .send({ enabled: true });
    const operatorMaintenance = await request(context.app)
      .post('/api/servers/s1/maintenance')
      .set('Authorization', 'Bearer operator-token')
      .send({ enabled: true });

    expect(serverTokenMaintenance.status).toBe(401);
    expect(operatorMaintenance.status).toBe(200);
    expect(operatorMaintenance.body.server.maintenance).toBe(true);
  });

  test('supports explicit offline reports from the active instance', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed({
      agents: {
        'agent-a': makeAgent('agent-a', { online: false, server: 's1' }),
      },
    }));

    await postHeartbeat(context.app, {
      server: 's1',
      instanceId: 'inst-1',
      bootTs: 1000,
      agents: ['agent-a'],
      sessions: ['agent-a:0.0'],
    });
    const offline = await request(context.app)
      .post('/api/servers/s1/offline')
      .send({ instanceId: 'inst-1' });

    expect(offline.status).toBe(200);
    expect(offline.body.ok).toBe(true);
    expect(offline.body.server.online).toBe(false);

    const servers = readJson(serversPath(context.runtimeDir));
    const agents = readJson(agentsPath(context.runtimeDir));
    expect(servers.s1.heartbeatAt).toBe(0);
    expect(agents['agent-a'].online).toBe(false);
  });

  test('rejects explicit offline from a different live instance', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed());

    await postHeartbeat(context.app, {
      server: 's1',
      instanceId: 'inst-A',
      bootTs: 1000,
      agents: [],
      sessions: [],
    });
    const offline = await request(context.app)
      .post('/api/servers/s1/offline')
      .send({ instanceId: 'inst-B' });

    expect(offline.status).toBe(409);
    expect(offline.body.error).toBe('offline_lease_rejected');
    expect(readJson(serversPath(context.runtimeDir)).s1.online).toBe(true);
  });

  test('accepts explicit offline without instance id when no lease is active', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed());

    await postHeartbeat(context.app, {
      server: 's1',
      agents: [],
      sessions: [],
    });
    const offline = await request(context.app)
      .post('/api/servers/s1/offline')
      .send({});

    expect(offline.status).toBe(200);
    expect(offline.body.ok).toBe(true);
  });

  test('cascades explicit offline only to agents on the targeted server', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed({
      agents: {
        a1: makeAgent('a1', { online: true, server: 's1', tmux: 'a1:0.0' }),
        a2: makeAgent('a2', { online: true, server: 's1', tmux: 'a2:0.0' }),
        a3: makeAgent('a3', { online: true, server: 's2', tmux: 'a3:0.0' }),
      },
    }));

    await postHeartbeat(context.app, {
      server: 's1',
      instanceId: 'i1',
      bootTs: 1,
      agents: ['a1', 'a2'],
      sessions: ['a1:0.0', 'a2:0.0'],
    });
    await request(context.app).post('/api/servers/s1/offline').send({ instanceId: 'i1' });
    const agents = readJson(agentsPath(context.runtimeDir));

    expect(agents.a1.online).toBe(false);
    expect(agents.a2.online).toBe(false);
    expect(agents.a3.online).toBe(true);

    const alerts = await request(context.app).get('/api/alerts?status=open&alertType=server_offline');
    expect(alerts.body).toEqual([
      expect.objectContaining({
        dedupeKey: 'server_offline:s1',
        sourceAgent: 's1',
      }),
    ]);
    expect(alerts.body[0].detail).toContain('Affected agents: a1, a2');
  });

  test('enables maintenance mode and forces the server offline', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed({
      agents: {
        'agent-a': makeAgent('agent-a', { online: false, server: 's1' }),
      },
    }));

    await postHeartbeat(context.app, {
      server: 's1',
      instanceId: 'i1',
      bootTs: 1,
      agents: ['agent-a'],
      sessions: ['agent-a:0.0'],
    });
    const maintenance = await request(context.app)
      .post('/api/servers/s1/maintenance')
      .send({ enabled: true });

    expect(maintenance.status).toBe(200);
    expect(maintenance.body.server.maintenance).toBe(true);
    expect(maintenance.body.server.online).toBe(false);
    expect(readJson(agentsPath(context.runtimeDir))['agent-a'].online).toBe(false);

    const alerts = await request(context.app).get('/api/alerts?status=open&alertType=server_offline');
    expect(alerts.body).toEqual([]);
  });

  test('ignores heartbeats during maintenance while still updating lastSeen', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed());

    await request(context.app).post('/api/servers/s1/maintenance').send({ enabled: true });
    const before = readJson(serversPath(context.runtimeDir)).s1.lastSeen || 0;
    await sleep(25);
    const heartbeat = await postHeartbeat(context.app, {
      server: 's1',
      instanceId: 'i1',
      bootTs: 1,
      agents: ['agent-a'],
      sessions: ['agent-a:0.0'],
    });
    const servers = readJson(serversPath(context.runtimeDir));

    expect(heartbeat.status).toBe(200);
    expect(heartbeat.body.maintenance).toBe(true);
    expect(heartbeat.body.ignored).toBe(true);
    expect(servers.s1.online).toBe(false);
    expect(Number(servers.s1.lastSeen)).toBeGreaterThan(before);
  });

  test('disables maintenance mode and allows normal heartbeats again', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed());

    await request(context.app).post('/api/servers/s1/maintenance').send({ enabled: true });
    const disable = await request(context.app).post('/api/servers/s1/maintenance').send({ enabled: false });
    const heartbeat = await postHeartbeat(context.app, {
      server: 's1',
      instanceId: 'i1',
      bootTs: 1,
      agents: [],
      sessions: [],
    });

    expect(disable.status).toBe(200);
    expect(disable.body.server.maintenance).toBe(false);
    expect(heartbeat.status).toBe(200);
    expect(heartbeat.body.maintenance).toBe(false);
    expect(heartbeat.body.ignored).toBe(false);
  });

  test('requires a boolean enabled flag for maintenance updates', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed());

    const missing = await request(context.app).post('/api/servers/s1/maintenance').send({});
    const invalid = await request(context.app).post('/api/servers/s1/maintenance').send({ enabled: 'yes' });

    expect(missing.status).toBe(400);
    expect(missing.body).toEqual({ error: 'enabled boolean required' });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({ error: 'enabled boolean required' });
  });

  test('honors env-configured maintenance server ids', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed({
      env: {
        AGENT_SERVER_MAINTENANCE_IDS: 'auto-maint-server',
      },
    }));

    const heartbeat = await postHeartbeat(context.app, {
      server: 'auto-maint-server',
      instanceId: 'i1',
      bootTs: 1,
      agents: [],
      sessions: [],
    });
    const servers = await request(context.app).get('/api/servers');

    expect(heartbeat.status).toBe(200);
    expect(heartbeat.body.maintenance).toBe(true);
    expect(heartbeat.body.ignored).toBe(true);
    expect(servers.body[0]).toMatchObject({ id: 'auto-maint-server', maintenance: true, online: false });
  });

  test('treats agents on the local server id as local rather than remote', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed({
      agents: {
        'local-a': makeAgent('local-a', { server: 'my-local', online: true, tmux: 'local-a:0.0' }),
      },
      env: {
        AGENT_CHAT_SERVER: 'my-local',
      },
    }));

    const response = await request(context.app).get('/health');
    const agent = await request(context.app).get('/api/agents/local-a');

    expect(response.status).toBe(200);
    expect(agent.status).toBe(200);
    expect(agent.body.server).toBe('my-local');
    expect(agent.body.online).toBe(true);
  });

  test('custom local server rows do not make live local agents undeliverable', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed({
      agents: {
        'local-a': makeAgent('local-a', { server: 'my-local', online: true, tmux: 'local-a:0.0' }),
      },
      servers: {
        'my-local': {
          id: 'my-local',
          online: false,
          lastSeen: Date.now() - 60_000,
          heartbeatAt: 0,
          updatedAt: Date.now() - 60_000,
          sessions: [],
          agents: [],
          agentCount: 0,
          sourceIp: 'local',
        },
      },
      env: {
        AGENT_CHAT_SERVER: 'my-local',
      },
    }));

    const agent = await request(context.app).get('/api/agents/local-a');
    const message = await request(context.app)
      .post('/api/messages')
      .send({
        from: 'local-a',
        to: 'local-a',
        target_type: 'agent',
        type: 'inform',
        summary: 'hello local',
        full: 'hello local',
      });

    expect(agent.status).toBe(200);
    expect(agent.body.online).toBe(true);
    expect(agent.body.serverOnline).toBe(true);
    expect(message.status).toBe(200);
    expect(message.body.warnings.some((warning) => warning.code === 'target_offline')).toBe(false);
  });

  test('stale custom local server rows do not cascade remote-offline state to local agents', async () => {
    const staleTs = Date.now() - 10_000;
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed({
      agents: {
        'local-a': makeAgent('local-a', { server: 'my-local', online: true, tmux: 'local-a:0.0' }),
      },
      servers: {
        'my-local': {
          id: 'my-local',
          online: true,
          lastSeen: staleTs,
          heartbeatAt: staleTs,
          updatedAt: staleTs,
          sessions: ['local-a:0.0'],
          agents: ['local-a'],
          agentCount: 1,
          sourceIp: 'local',
        },
      },
      env: {
        AGENT_CHAT_SERVER: 'my-local',
        AGENT_HEARTBEAT_TTL_MS: '100',
      },
    }));

    const servers = await request(context.app).get('/api/servers');
    const agents = readJson(agentsPath(context.runtimeDir));

    expect(servers.status).toBe(200);
    expect(servers.body[0]).toMatchObject({ id: 'my-local', online: false });
    expect(agents['local-a'].online).toBe(true);
    expect(agents['local-a'].tmux).toBe('local-a:0.0');
    expect(agents['local-a'].offlineReason).toBeNull();
  });

  test('records the local runtime host only when the local server record flag is enabled', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed({
      agents: {
        'local-a': makeAgent('local-a', { server: 'my-local', online: true, tmux: 'local-a:0.0' }),
        'remote-a': makeAgent('remote-a', { server: 'remote-host-1', online: true, tmux: 'remote-a:0.0' }),
      },
      env: {
        AGENT_CHAT_SERVER: 'my-local',
        AGENT_CHAT_RECORD_LOCAL_SERVER: '1',
      },
    }));

    const response = await request(context.app).get('/api/servers');

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0]).toMatchObject({
      id: 'my-local',
      online: true,
      agentCount: 1,
      sourceIp: 'local',
    });
    const servers = readJson(serversPath(context.runtimeDir));
    expect(servers['my-local'].agents).toEqual(['local-a']);
    expect(servers['my-local'].sessions).toEqual(['local-a:0.0']);
    expect(servers['my-local'].relayInstanceId).toBeNull();
    expect(servers['my-local'].relayBootTs).toBe(0);
  });

  test('tracks multiple interleaved remote servers and sorts them by lastSeen', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed({
      agents: {},
    }));

    await postHeartbeat(context.app, {
      server: 's1',
      instanceId: 'i1',
      bootTs: 1,
      agents: ['a1'],
      sessions: ['a1:0.0'],
    });
    await sleep(10);
    await postHeartbeat(context.app, {
      server: 's2',
      instanceId: 'i2',
      bootTs: 1,
      agents: ['a2'],
      sessions: ['a2:0.0'],
    });
    const servers = await request(context.app).get('/api/servers');
    const agents = readJson(agentsPath(context.runtimeDir));

    expect(servers.status).toBe(200);
    expect(servers.body.map((row) => row.id)).toEqual(['s2', 's1']);
    expect(agents.a1.server).toBe('s1');
    expect(agents.a2.server).toBe('s2');
  });

  test('updates an agent when it moves between remote servers', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed({
      agents: {},
    }));

    await postHeartbeat(context.app, {
      server: 's1',
      instanceId: 'i1',
      bootTs: 1,
      agents: ['mobile-agent'],
      sessions: ['mobile-agent:0.0'],
    });
    await postHeartbeat(context.app, {
      server: 's1',
      instanceId: 'i1',
      bootTs: 1,
      agents: [],
      sessions: [],
    });
    await postHeartbeat(context.app, {
      server: 's2',
      instanceId: 'i2',
      bootTs: 1,
      agents: ['mobile-agent'],
      sessions: ['mobile-agent:0.0'],
    });
    const agent = await request(context.app).get('/api/agents/mobile-agent');

    expect(agent.status).toBe(200);
    expect(agent.body.server).toBe('s2');
    expect(agent.body.online).toBe(true);
  });

  test('stores version from heartbeat payload in server record', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed());

    await postHeartbeat(context.app, {
      server: 's1',
      instanceId: 'i1',
      bootTs: 1,
      agents: [],
      sessions: [],
      version: 'abc1234',
    });
    const servers = readJson(serversPath(context.runtimeDir));

    expect(servers.s1.version).toBe('abc1234');
  });

  test('exposes version via GET /api/servers response', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed());

    await postHeartbeat(context.app, {
      server: 's1',
      instanceId: 'i1',
      bootTs: 1,
      agents: [],
      sessions: [],
      version: 'def5678',
    });
    const response = await request(context.app).get('/api/servers');

    expect(response.status).toBe(200);
    expect(response.body[0].version).toBe('def5678');
  });

  test('preserves last known version when heartbeat omits it', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed());

    await postHeartbeat(context.app, {
      server: 's1',
      instanceId: 'i1',
      bootTs: 1,
      agents: [],
      sessions: [],
      version: 'abc1234',
    });
    await postHeartbeat(context.app, {
      server: 's1',
      instanceId: 'i1',
      bootTs: 1,
      agents: [],
      sessions: [],
    });
    const servers = readJson(serversPath(context.runtimeDir));

    expect(servers.s1.version).toBe('abc1234');
  });

  test('returns an empty server list before any heartbeat is received', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed());

    const response = await request(context.app).get('/api/servers');

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });

  test('persists server records to disk after heartbeat updates', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed());

    await postHeartbeat(context.app, {
      server: 's1',
      instanceId: 'i1',
      bootTs: 1,
      agents: [],
      sessions: [],
    });
    const servers = readJson(serversPath(context.runtimeDir));

    expect(servers.s1).toMatchObject({
      id: 's1',
      online: true,
      relayInstanceId: 'i1',
      relayBootTs: 1,
      agentCount: 0,
      sessions: [],
      agents: [],
    });
    expect(Number.isFinite(Number(servers.s1.lastSeen))).toBe(true);
    expect(Number.isFinite(Number(servers.s1.updatedAt))).toBe(true);
  });
});
