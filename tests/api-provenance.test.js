import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

function writeJson(filePath, value) {
  writeFileSync(filePath, JSON.stringify(value, null, 2));
}

describe('provenance metadata (5.8.3 Layer 1)', () => {
  let runtimeDir;
  let app;

  beforeAll(async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'agent-chat-provenance-'));
    const dataDir = path.join(runtimeDir, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeJson(path.join(dataDir, 'agents.json'), {
      alice: { name: 'alice', type: 'agent', kind: 'agent', online: false },
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
    const cacheBust = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    ({ app } = await import(`${backendUrl}?provenance-test=${cacheBust}`));
  });

  afterAll(() => {
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  test('Matrix message carries senderMxid through to inbox summary', async () => {
    // Post a message with sender_mxid (as bridge would)
    const postRes = await request(app)
      .post('/api/messages')
      .send({
        from: 'system',
        to: 'alice',
        type: 'human',
        summary: 'hello from matrix',
        full: 'hello from matrix',
        source: 'matrix',
        source_room: '!room1:matrix.test',
        sender_mxid: '@human:matrix.test',
      });
    expect(postRes.status).toBe(200);
    expect(postRes.body.ok).toBe(true);

    // Read inbox and verify provenance fields
    const inboxRes = await request(app).get('/api/inbox/alice');
    expect(inboxRes.status).toBe(200);
    const msg = inboxRes.body.dm.find(m => m.summary === 'hello from matrix');
    expect(msg).toBeDefined();
    expect(msg.source).toBe('matrix');
    expect(msg.sourceRoom).toBe('!room1:matrix.test');
    expect(msg.senderMxid).toBe('@human:matrix.test');
  });

  test('API-origin message has senderMxid=null', async () => {
    const postRes = await request(app)
      .post('/api/messages')
      .send({
        from: 'system',
        to: 'alice',
        type: 'inform',
        summary: 'api origin message',
        full: 'body',
      });
    expect(postRes.status).toBe(200);

    const inboxRes = await request(app).get('/api/inbox/alice');
    expect(inboxRes.status).toBe(200);
    const msg = inboxRes.body.dm.find(m => m.summary === 'api origin message');
    expect(msg).toBeDefined();
    expect(msg.source).toBe('api');
    expect(msg.sourceRoom).toBeNull();
    expect(msg.senderMxid).toBeNull();
  });

  test('sender_mxid is truncated at 255 chars for matrix source', async () => {
    const longMxid = '@' + 'a'.repeat(300) + ':matrix.test';
    const postRes = await request(app)
      .post('/api/messages')
      .send({
        from: 'system',
        to: 'alice',
        type: 'inform',
        summary: 'truncation test',
        full: 'body',
        source: 'matrix',
        sender_mxid: longMxid,
      });
    expect(postRes.status).toBe(200);

    const inboxRes = await request(app).get('/api/inbox/alice');
    const msg = inboxRes.body.dm.find(m => m.summary === 'truncation test');
    expect(msg.senderMxid).toBeDefined();
    expect(msg.senderMxid.length).toBeLessThanOrEqual(255);
  });

  test('API-origin message with forged sender_mxid is stored as null', async () => {
    const postRes = await request(app)
      .post('/api/messages')
      .send({
        from: 'system',
        to: 'alice',
        type: 'inform',
        summary: 'forged mxid attempt',
        full: 'body',
        sender_mxid: '@operator:matrix.test',
      });
    expect(postRes.status).toBe(200);

    const inboxRes = await request(app).get('/api/inbox/alice');
    const msg = inboxRes.body.dm.find(m => m.summary === 'forged mxid attempt');
    expect(msg).toBeDefined();
    expect(msg.senderMxid).toBeNull();
  });

  test('invalid MXID format is rejected even from matrix source', async () => {
    const postRes = await request(app)
      .post('/api/messages')
      .send({
        from: 'system',
        to: 'alice',
        type: 'inform',
        summary: 'bad mxid format',
        full: 'body',
        source: 'matrix',
        sender_mxid: 'not-a-valid-mxid',
      });
    expect(postRes.status).toBe(200);

    const inboxRes = await request(app).get('/api/inbox/alice');
    const msg = inboxRes.body.dm.find(m => m.summary === 'bad mxid format');
    expect(msg).toBeDefined();
    expect(msg.senderMxid).toBeNull();
  });

  test('Matrix message from operator MXID gets trustLevel=operator', async () => {
    const postRes = await request(app)
      .post('/api/messages')
      .send({
        from: 'system',
        to: 'alice',
        type: 'human',
        summary: 'operator trust test',
        full: 'operator trust test',
        source: 'matrix',
        sender_mxid: '@ops:matrix.test',
        trust_level: 'operator',
      });
    expect(postRes.status).toBe(200);

    const inboxRes = await request(app).get('/api/inbox/alice');
    const msg = inboxRes.body.dm.find(m => m.summary === 'operator trust test');
    expect(msg).toBeDefined();
    expect(msg.trustLevel).toBe('operator');
  });

  test('Matrix message from non-operator gets trustLevel=external', async () => {
    const postRes = await request(app)
      .post('/api/messages')
      .send({
        from: 'system',
        to: 'alice',
        type: 'human',
        summary: 'external trust test',
        full: 'external trust test',
        source: 'matrix',
        sender_mxid: '@rando:evil.test',
        trust_level: 'external',
      });
    expect(postRes.status).toBe(200);

    const inboxRes = await request(app).get('/api/inbox/alice');
    const msg = inboxRes.body.dm.find(m => m.summary === 'external trust test');
    expect(msg).toBeDefined();
    expect(msg.trustLevel).toBe('external');
  });

  test('non-Matrix message has trustLevel=null', async () => {
    const postRes = await request(app)
      .post('/api/messages')
      .send({
        from: 'system',
        to: 'alice',
        type: 'inform',
        summary: 'api no trust level',
        full: 'body',
        trust_level: 'operator',
      });
    expect(postRes.status).toBe(200);

    const inboxRes = await request(app).get('/api/inbox/alice');
    const msg = inboxRes.body.dm.find(m => m.summary === 'api no trust level');
    expect(msg).toBeDefined();
    expect(msg.trustLevel).toBeNull();
  });
});
