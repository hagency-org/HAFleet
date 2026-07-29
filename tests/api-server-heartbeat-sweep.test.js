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

describe('server heartbeat api (sweep and lifecycle)', () => {
  let context = null;

  afterEach(() => {
    context?.cleanup();
    context = null;
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

  test('rejects non-local heartbeats that claim the local server identity', async () => {
    context = await createBackendTestContext('api-server-heartbeat-test-', baseSeed({
      env: {
        API_TOKEN: 'operator-token',
        AGENT_CHAT_SERVER: 'my-local',
      },
    }));

    const legacyLocal = await request(context.app)
      .post('/api/servers/heartbeat')
      .set('Authorization', 'Bearer operator-token')
      .set('X-Forwarded-For', '203.0.113.10')
      .send({
        server: 'local',
        instanceId: 'remote-claimed-local',
        bootTs: 1000,
        agents: [],
        sessions: [],
      });
    const configuredLocal = await request(context.app)
      .post('/api/servers/heartbeat')
      .set('Authorization', 'Bearer operator-token')
      .set('X-Forwarded-For', '203.0.113.10')
      .send({
        server: 'my-local',
        instanceId: 'remote-claimed-configured-local',
        bootTs: 1000,
        agents: [],
        sessions: [],
      });

    expect(legacyLocal.status).toBe(400);
    expect(legacyLocal.body).toMatchObject({
      error: 'remote server id must not be local',
      server: 'local',
    });
    expect(configuredLocal.status).toBe(400);
    expect(configuredLocal.body).toMatchObject({
      error: 'remote server id must not be local',
      server: 'my-local',
    });

    const servers = readJson(serversPath(context.runtimeDir));
    expect(servers.local).toBeUndefined();
    expect(servers['my-local']).toBeUndefined();
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

  test('classifies fleet inventory without mutating stale server rows', async () => {
    const now = Date.now();
    const seed = baseSeed({
      servers: {
        current: { id: 'current', online: true, heartbeatAt: now - 1000, lastSeen: now - 1000, version: 'cur1234', agents: ['a1'], agentCount: 1, relayInstanceId: 'i-current', relayBootTs: 1 },
        outdated: { id: 'outdated', online: true, heartbeatAt: now - 1000, lastSeen: now - 1000, version: 'old9999', agents: ['a2'], agentCount: 1 },
        unknown: { id: 'unknown', online: true, heartbeatAt: now - 1000, lastSeen: now - 1000, version: 'unknown-legacy', agents: [], agentCount: 0 },
        offline: { id: 'offline', online: false, heartbeatAt: 0, lastSeen: now - 1000, version: 'cur1234', agents: ['a3'], agentCount: 1 },
        stale: { id: 'stale', online: true, heartbeatAt: now - 10_000, lastSeen: now - 10_000, version: 'old9999', agents: ['a4'], agentCount: 1 },
        maintenance: { id: 'maintenance', online: false, heartbeatAt: 0, lastSeen: now - 1000, version: 'old9999', maintenance: true, agents: ['a5'], agentCount: 1 },
      },
    });
    delete seed.env.AGENT_SERVER_MAINTENANCE_IDS;
    context = await createBackendTestContext('api-server-heartbeat-test-', seed);

    const response = await request(context.app).get('/api/servers/fleet?expectVersion=cur1234');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      expectedVersion: 'cur1234',
      summary: {
        total: 6,
        current: 1,
        outdated: 1,
        unknown: 1,
        offline: 2,
        maintenance: 1,
      },
    });
    const byId = Object.fromEntries(response.body.servers.map((row) => [row.id, row]));
    expect(byId.current).toMatchObject({ versionStatus: 'current', versionStale: false, online: true, agentCount: 1, relayInstanceId: 'i-current', relayBootTs: 1 });
    expect(byId.outdated).toMatchObject({ versionStatus: 'outdated', versionStale: true, online: true, version: 'old9999' });
    expect(byId.unknown).toMatchObject({ versionStatus: 'unknown', versionStale: false, online: true, version: 'unknown-legacy' });
    expect(byId.offline).toMatchObject({ versionStatus: 'offline', versionStale: false, online: false, version: 'cur1234' });
    expect(byId.stale).toMatchObject({ versionStatus: 'offline', versionStale: true, online: true, version: 'old9999' });
    expect(byId.maintenance).toMatchObject({ versionStatus: 'maintenance', maintenance: true, online: false, version: 'old9999' });

    const persisted = readJson(serversPath(context.runtimeDir));
    expect(persisted.stale.online).toBe(true);
    expect(persisted.stale.heartbeatAt).toBe(now - 10_000);
  });
});
