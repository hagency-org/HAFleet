import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

function writeJson(filePath, value) {
  writeFileSync(filePath, JSON.stringify(value, null, 2));
}

describe('backend API smoke', () => {
  let runtimeDir;
  let app;

  beforeAll(async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'agent-chat-api-smoke-'));
    const dataDir = path.join(runtimeDir, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeJson(path.join(dataDir, 'agents.json'), {
      alpha: {
        name: 'alpha',
        type: 'agent',
        kind: 'agent',
        online: false,
        manualDown: true,
        offlineReason: 'test-offline',
      },
    });
    writeJson(path.join(dataDir, 'groups.json'), {});
    writeJson(path.join(dataDir, 'messages.json'), []);
    writeJson(path.join(dataDir, 'cursors.json'), {});
    writeJson(path.join(dataDir, 'servers.json'), {});
    writeJson(path.join(dataDir, 'agent_runtime.json'), {});
    writeJson(path.join(dataDir, 'local_activity_sweep.json'), { selectionCursor: 0 });

    process.env.AGENT_CHAT_RUNTIME_DIR = runtimeDir;
    process.env.SUPERVISOR_ENABLED = 'false';
    process.env.AGENT_SCOPE_MONITOR_ENABLED = 'false';

    const backendUrl = pathToFileURL(path.resolve('backend-v2.js')).href;
    ({ app } = await import(`${backendUrl}?test=${Date.now()}`));
  });

  afterAll(() => {
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  test('GET /api/agents returns 200 and an array', async () => {
    const response = await request(app).get('/api/agents');
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body[0]?.name).toBe('alpha');
  });

  test('GET /api/agents?view=names returns 200 and a string array', async () => {
    const response = await request(app).get('/api/agents').query({ view: 'names' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(['alpha']);
  });

  test('POST /api/messages with valid message returns 200', async () => {
    const response = await request(app)
      .post('/api/messages')
      .send({
        from: 'system',
        to: 'alpha',
        type: 'inform',
        summary: 'smoke message',
        full: 'body',
      });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(typeof response.body.id).toBe('string');
  });

  test('POST /api/messages with schema returns 200 and schema is round-tripped', async () => {
    const createResponse = await request(app)
      .post('/api/messages')
      .send({
        from: 'system',
        to: 'alpha',
        type: 'inform',
        summary: 'schema smoke',
        full: 'body',
        schema: {
          kind: 'task_request',
          version: 1,
          payload: { taskId: 'T-1' },
        },
      });
    expect(createResponse.status).toBe(200);

    const readResponse = await request(app).get(`/api/messages/${createResponse.body.id}`);
    expect(readResponse.status).toBe(200);
    expect(readResponse.body.schema).toEqual({
      kind: 'task_request',
      version: 1,
      payload: { taskId: 'T-1' },
    });
  });

  test('POST /api/messages with invalid priority returns 400', async () => {
    const response = await request(app)
      .post('/api/messages')
      .send({
        from: 'system',
        to: 'alpha',
        type: 'inform',
        priority: 'panic',
        summary: 'bad priority',
        full: 'body',
      });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'priority must be one of: normal, high, urgent' });
  });
});
