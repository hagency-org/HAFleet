import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
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
