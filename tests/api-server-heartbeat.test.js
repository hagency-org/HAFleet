import { afterEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import { existsSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';
import {
  agentRuntimePath,
  agentsPath,
  baseSeed,
  makeAgent,
  postHeartbeat,
  readJson,
  readSystemInfo,
  serversPath,
  sleep,
  systemInfoPath,
} from './helpers/server-heartbeat-fixtures.js';

describe('server heartbeat api', () => {
  let context = null;

  afterEach(() => {
    context?.cleanup();
    context = null;
  });

  test('does not put the local host in maintenance when the maintenance list is unset', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', {
      agents: {},
      env: {
        AGENT_HEARTBEAT_TTL_MS: '5000',
        AGENT_SERVER_SWEEP_INTERVAL_MS: '60000',
      },
    });

    const response = await postHeartbeat(context.app, {
      server: os.hostname(),
      sessions: [],
      agents: [],
      instanceId: 'local-instance',
      bootTs: 1000,
    });

    expect(response.status).toBe(200);
    expect(response.body.maintenance).toBe(false);
    expect(response.body.ignored).toBe(false);
    const servers = await request(context.app).get('/api/servers');
    expect(servers.body.find(row => row.id === os.hostname())?.online).toBe(true);
  });

  test('an explicitly empty maintenance list clears stale persisted maintenance on startup', async () => {
    const serverId = os.hostname();
    context = await createBackendTestContext('api-server-heartbeat-test-', {
      agents: {},
      servers: {
        [serverId]: {
          id: serverId,
          online: false,
          maintenance: true,
          sessions: [],
          agents: [],
        },
      },
      env: {
        AGENT_HEARTBEAT_TTL_MS: '5000',
        AGENT_SERVER_SWEEP_INTERVAL_MS: '60000',
        AGENT_SERVER_MAINTENANCE_IDS: '',
      },
    });

    const response = await postHeartbeat(context.app, {
      server: serverId,
      sessions: [],
      agents: [],
      instanceId: 'local-instance',
      bootTs: 1000,
    });

    expect(response.status).toBe(200);
    expect(response.body.maintenance).toBe(false);
    expect(response.body.ignored).toBe(false);
    expect(readJson(serversPath(context.runtimeDir))[serverId].maintenance).toBe(false);
  });

  test('preserves persisted API maintenance when no maintenance env policy is configured', async () => {
    const serverId = os.hostname();
    context = await createBackendTestContext('api-server-heartbeat-test-', {
      agents: {},
      servers: {
        [serverId]: {
          id: serverId,
          online: false,
          maintenance: true,
          sessions: [],
          agents: [],
        },
      },
      env: {
        AGENT_HEARTBEAT_TTL_MS: '5000',
        AGENT_SERVER_SWEEP_INTERVAL_MS: '60000',
      },
    });

    const servers = await request(context.app).get('/api/servers');
    expect(servers.body.find(row => row.id === serverId)?.maintenance).toBe(true);
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
      'POST /api/agents/:name/heartbeat',
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

});
