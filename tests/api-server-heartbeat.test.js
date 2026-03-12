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
    });
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
