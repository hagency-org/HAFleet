import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

describe('deletion tombstone', () => {
  let context;

  beforeAll(async () => {
    context = await createBackendTestContext('tombstone-test-', {
      agents: {
        doomed: {
          name: 'doomed',
          type: 'agent',
          kind: 'agent',
          online: false,
          manualDown: false,
          offlineReason: 'inactive',
        },
      },
    });
  });

  afterAll(() => {
    if (context) context.cleanup();
  });

  test('force-delete creates tombstone and blocks re-registration', async () => {
    // Verify agent exists
    await request(context.app).get('/api/agents/doomed').expect(200);

    // Force-delete
    const del = await request(context.app)
      .delete('/api/agents/doomed?force=true')
      .expect(200);
    expect(del.body).toMatchObject({ ok: true, deleted: true });

    // Tombstone file exists on disk
    const tombstones = readJson(path.join(context.runtimeDir, 'data', 'deleted_agents.json'));
    expect(tombstones.doomed).toBeDefined();
    expect(tombstones.doomed.reason).toBe('force-delete');
    expect(tombstones.doomed.deletedAt).toBeGreaterThan(0);

    // agents.json was saved immediately (no stale entry)
    const agents = readJson(path.join(context.runtimeDir, 'data', 'agents.json'));
    expect(agents.doomed).toBeUndefined();

    // Re-registration via POST /api/agents is blocked (410 Gone)
    const reg = await request(context.app)
      .post('/api/agents')
      .send({ name: 'doomed', type: 'agent' })
      .expect(410);
    expect(reg.body.error).toContain('permanently deleted');
  });

  test('undelete removes tombstone and allows re-registration', async () => {
    // Undelete
    const undel = await request(context.app)
      .post('/api/agents/doomed/undelete')
      .expect(200);
    expect(undel.body).toMatchObject({ ok: true, undeleted: true });

    // Tombstone file no longer has the entry
    const tombstones = readJson(path.join(context.runtimeDir, 'data', 'deleted_agents.json'));
    expect(tombstones.doomed).toBeUndefined();

    // Re-registration now succeeds
    const reg = await request(context.app)
      .post('/api/agents')
      .send({ name: 'doomed', type: 'agent' })
      .expect(200);
    expect(reg.body.agent).toBeDefined();
    expect(reg.body.agent.name).toBe('doomed');
  });

  test('undelete on non-tombstoned agent returns 404', async () => {
    await request(context.app)
      .post('/api/agents/nonexistent/undelete')
      .expect(404);
  });
});

describe('tombstoned agent with retained home manifest', () => {
  let context;
  let fakeHome;
  const AGENT_NAME = 'ghost';

  beforeAll(async () => {
    // Create a fake hafleet home with agent manifest on disk
    fakeHome = mkdtempSync(path.join(os.tmpdir(), 'tombstone-orphan-'));
    const agentDir = path.join(fakeHome, 'agents', `agent_${AGENT_NAME}`);
    const workdir = path.join(agentDir, 'workdir');
    const stateDir = path.join(agentDir, 'state');
    mkdirSync(workdir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(agentDir, 'agent.json'), JSON.stringify({
      name: AGENT_NAME,
      id: `agent_${AGENT_NAME}`,
      homeDir: agentDir,
      stateDir,
      workdir,
      type: 'claude',
      agentModelVersion: '1.0',
      layoutVersion: 1,
    }, null, 2));

    // Boot backend with tombstone pre-seeded + orphan home on disk
    context = await createBackendTestContext('tombstone-orphan-', {
      agents: {},
      deletedAgents: {
        [AGENT_NAME]: { deletedAt: Date.now(), reason: 'force-delete' },
      },
      env: { HAFLEET_HOMEDIR: fakeHome },
    });
  });

  afterAll(() => {
    if (context) context.cleanup();
    rmSync(fakeHome, { recursive: true, force: true });
  });

  test('orphan scan skips tombstoned agent without crashing', async () => {
    // Backend booted without crash — that alone proves the fix
    const res = await request(context.app).get('/api/agents').expect(200);
    const agentNames = res.body.map((a) => a.name);
    expect(agentNames).not.toContain(AGENT_NAME);
  });
});
