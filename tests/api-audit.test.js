import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

function readAuditLog(runtimeDir) {
  const filePath = path.join(runtimeDir, 'data', 'audit.jsonl');
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

describe('audit logging', () => {
  let context;

  beforeAll(async () => {
    context = await createBackendTestContext('audit-test-', {
      agents: {
        alpha: {
          name: 'alpha',
          type: 'agent',
          kind: 'agent',
          online: true,
          manualDown: false,
          tmux: 'alpha:0.0',
        },
      },
    });
  });

  afterAll(() => {
    if (context) context.cleanup();
  });

  test('POST /api/agents creates audit entry', async () => {
    await request(context.app)
      .post('/api/agents')
      .send({ name: 'newbot', type: 'agent' })
      .expect(200);
    const entries = readAuditLog(context.runtimeDir);
    const entry = entries.find(e => e.method === 'POST' && e.route === '/api/agents' && e.agent === 'newbot');
    expect(entry).toBeDefined();
    expect(entry.ts).toBeDefined();
    expect(entry.summary.type).toBe('agent');
  });

  test('PATCH /api/agents/:name creates audit entry', async () => {
    await request(context.app)
      .patch('/api/agents/alpha')
      .send({ role: 'developer' })
      .expect(200);
    const entries = readAuditLog(context.runtimeDir);
    const entry = entries.find(e => e.method === 'PATCH' && e.agent === 'alpha');
    expect(entry).toBeDefined();
    expect(entry.summary.fields).toContain('role');
  });

  test('DELETE /api/agents/:name creates audit entry', async () => {
    await request(context.app)
      .delete('/api/agents/newbot?force=true')
      .expect(200);
    const entries = readAuditLog(context.runtimeDir);
    const entry = entries.find(e => e.method === 'DELETE' && e.agent === 'newbot');
    expect(entry).toBeDefined();
    expect(entry.summary.action).toBe('force-delete');
  });

  test('POST /api/agents/:name/runtime creates audit entry', async () => {
    await request(context.app)
      .post('/api/agents/alpha/runtime')
      .send({ blocked: false, reason: null, tail: '', command: 'claude' })
      .expect(200);
    const entries = readAuditLog(context.runtimeDir);
    const entry = entries.find(e => e.route.includes('/alpha/runtime'));
    expect(entry).toBeDefined();
    expect(entry.agent).toBe('alpha');
    expect(entry.summary).toHaveProperty('blocked');
  });

  test('POST /api/agents/:name/undelete creates audit entry', async () => {
    // Force-delete then undelete
    await request(context.app)
      .post('/api/agents')
      .send({ name: 'tempbot', type: 'agent' })
      .expect(200);
    await request(context.app)
      .delete('/api/agents/tempbot?force=true')
      .expect(200);
    await request(context.app)
      .post('/api/agents/tempbot/undelete')
      .expect(200);
    const entries = readAuditLog(context.runtimeDir);
    const entry = entries.find(e => e.route.includes('/tempbot/undelete'));
    expect(entry).toBeDefined();
    expect(entry.summary.action).toBe('undelete');
  });

  test('POST /api/servers/heartbeat creates audit entry', async () => {
    await request(context.app)
      .post('/api/servers/heartbeat')
      .send({ server: 'relay-test', agents: ['alpha'], sessions: ['alpha'] })
      .expect(200);
    const entries = readAuditLog(context.runtimeDir);
    const entry = entries.find(e => e.route === '/api/servers/heartbeat');
    expect(entry).toBeDefined();
    expect(entry.summary.server).toBe('relay-test');
    expect(entry.summary.agents).toBe(1);
  });

  test('heartbeat audit uses effective agent count from sessions fallback', async () => {
    await request(context.app)
      .post('/api/servers/heartbeat')
      .send({ server: 'relay-sessions', sessions: ['alpha', 'newbot2'] })
      .expect(200);
    const entries = readAuditLog(context.runtimeDir);
    const entry = entries.reverse().find(e => e.route === '/api/servers/heartbeat' && e.summary.server === 'relay-sessions');
    expect(entry).toBeDefined();
    expect(entry.summary.agents).toBe(2);
  });

  test('runtime audit logs normalized mcpPresent for non-MCP agent', async () => {
    // Register a codex agent (doesn't expect MCP)
    await request(context.app)
      .post('/api/agents')
      .send({ name: 'codexbot', type: 'codex' })
      .expect(200);
    await request(context.app)
      .post('/api/agents/codexbot/runtime')
      .send({ blocked: false, reason: null, tail: '', command: 'codex', mcpPresent: false })
      .expect(200);
    const entries = readAuditLog(context.runtimeDir);
    const entry = entries.reverse().find(e => e.route.includes('/codexbot/runtime'));
    expect(entry).toBeDefined();
    expect(entry.summary.mcpPresent).toBeNull();
  });

  test('non-force DELETE creates unregister audit entry', async () => {
    await request(context.app)
      .delete('/api/agents/codexbot')
      .expect(200);
    const entries = readAuditLog(context.runtimeDir);
    const entry = entries.reverse().find(e => e.method === 'DELETE' && e.agent === 'codexbot');
    expect(entry).toBeDefined();
    expect(entry.summary.action).toBe('unregister');
  });
});
