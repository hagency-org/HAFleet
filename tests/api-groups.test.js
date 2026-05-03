import { afterEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const API_TOKEN = 'groups-test-api-token';
const ALPHA_TOKEN = 'alpha-agent-token';
const BETA_TOKEN = 'beta-agent-token';

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function readDeliveryEvents(runtimeDir) {
  const filePath = path.join(runtimeDir, 'data', 'message-delivery-events.jsonl');
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function groupsPath(runtimeDir) {
  return path.join(runtimeDir, 'data', 'groups.json');
}

function messagesPath(runtimeDir) {
  return path.join(runtimeDir, 'data', 'messages.json');
}

function cursorsPath(runtimeDir) {
  return path.join(runtimeDir, 'data', 'cursors.json');
}

function makeAgent(name, overrides = {}) {
  return {
    name,
    type: 'agent',
    kind: 'agent',
    online: true,
    server: null,
    manualDown: false,
    offlineReason: null,
    ...overrides,
  };
}

function baseSeed(overrides = {}) {
  return {
    agents: {
      alpha: makeAgent('alpha'),
      beta: makeAgent('beta'),
      gamma: makeAgent('gamma', { online: false, offlineReason: 'idle' }),
      delta: makeAgent('delta'),
      ...(overrides.agents || {}),
    },
    groups: overrides.groups || {},
    messages: overrides.messages || [],
    cursors: overrides.cursors || {},
    servers: overrides.servers || {},
    agentRuntime: overrides.agentRuntime || {},
    agentTokens: overrides.agentTokens || {},
    env: overrides.env || {},
  };
}

describe('groups api', () => {
  let context = null;

  afterEach(() => {
    context?.cleanup();
    context = null;
  });

  test('creates a group with members', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed());

    const response = await request(context.app)
      .post('/api/groups')
      .send({ name: 'dev-team', members: ['alpha', 'beta'] });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.group.name).toBe('dev-team');
    expect(response.body.group.members).toEqual(['alpha', 'beta']);
    expect(Number.isFinite(response.body.group.createdAt)).toBe(true);

    const stored = readJson(groupsPath(context.runtimeDir));
    expect(stored['dev-team'].members).toEqual(['alpha', 'beta']);
  });

  test('rejects group creation without a name', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed());

    const emptyName = await request(context.app).post('/api/groups').send({ name: '', members: [] });
    const missingName = await request(context.app).post('/api/groups').send({ members: ['alpha'] });

    expect(emptyName.status).toBe(400);
    expect(emptyName.body).toEqual({ error: 'name required' });
    expect(missingName.status).toBe(400);
    expect(missingName.body).toEqual({ error: 'name required' });
  });

  test('rejects duplicate group names', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed());

    const first = await request(context.app).post('/api/groups').send({ name: 'dev-team', members: ['alpha'] });
    const second = await request(context.app).post('/api/groups').send({ name: 'dev-team', members: ['beta'] });

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: 'group already exists' });
  });

  test('deduplicates and normalizes member names on create', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed());

    const response = await request(context.app)
      .post('/api/groups')
      .send({ name: 'test', members: ['alpha', 'Alpha', ' ALPHA ', 'beta', ' beta '] });

    expect(response.status).toBe(200);
    expect(response.body.group.members).toEqual(['alpha', 'beta']);
  });

  test('allows creating groups with no members', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed());

    const implicit = await request(context.app).post('/api/groups').send({ name: 'empty-group' });
    const explicit = await request(context.app).post('/api/groups').send({ name: 'no-members', members: [] });

    expect(implicit.status).toBe(200);
    expect(implicit.body.group.members).toEqual([]);
    expect(explicit.status).toBe(200);
    expect(explicit.body.group.members).toEqual([]);
  });

  test('lists all groups', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed({
      groups: {
        g1: { name: 'g1', members: ['alpha'], createdAt: 1000 },
        g2: { name: 'g2', members: ['beta', 'gamma'], createdAt: 2000 },
      },
    }));

    const response = await request(context.app).get('/api/groups');

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(2);
    expect(response.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'g1', members: ['alpha'], createdAt: 1000 }),
      expect.objectContaining({ name: 'g2', members: ['beta', 'gamma'], createdAt: 2000 }),
    ]));
  });

  test('gets a single group and 404s for a missing group', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed({
      groups: {
        'dev-team': { name: 'dev-team', members: ['alpha'], createdAt: 1000 },
      },
    }));

    const found = await request(context.app).get('/api/groups/dev-team');
    const missing = await request(context.app).get('/api/groups/nonexistent');

    expect(found.status).toBe(200);
    expect(found.body).toEqual({ name: 'dev-team', members: ['alpha'], createdAt: 1000 });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'group not found' });
  });

  test('deletes a group and persists the removal', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed({
      groups: {
        temp: { name: 'temp', members: ['alpha'], createdAt: 1000 },
      },
    }));

    const firstDelete = await request(context.app).delete('/api/groups/temp');
    const secondDelete = await request(context.app).delete('/api/groups/temp');
    const list = await request(context.app).get('/api/groups');

    expect(firstDelete.status).toBe(200);
    expect(firstDelete.body).toEqual({ ok: true });
    expect(secondDelete.status).toBe(404);
    expect(secondDelete.body).toEqual({ error: 'group not found' });
    expect(list.body).toEqual([]);
    expect(readJson(groupsPath(context.runtimeDir))).toEqual({});
  });

  test('adds members to an existing group', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed({
      groups: {
        team: { name: 'team', members: ['alpha'], createdAt: 1000 },
      },
    }));

    const response = await request(context.app)
      .post('/api/groups/team/members')
      .send({ add: ['beta', 'gamma'] });

    expect(response.status).toBe(200);
    expect(response.body.group.members).toEqual(['alpha', 'beta', 'gamma']);
    expect(readJson(groupsPath(context.runtimeDir)).team.members).toEqual(['alpha', 'beta', 'gamma']);
  });

  test('removes members from an existing group', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed({
      groups: {
        team: { name: 'team', members: ['alpha', 'beta', 'gamma'], createdAt: 1000 },
      },
    }));

    const response = await request(context.app)
      .post('/api/groups/team/members')
      .send({ remove: ['beta'] });

    expect(response.status).toBe(200);
    expect(response.body.group.members).toEqual(['alpha', 'gamma']);
  });

  test('supports add and remove in the same membership update', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed({
      groups: {
        team: { name: 'team', members: ['alpha', 'beta'], createdAt: 1000 },
      },
    }));

    const response = await request(context.app)
      .post('/api/groups/team/members')
      .send({ add: ['gamma'], remove: ['alpha'] });

    expect(response.status).toBe(200);
    expect(response.body.group.members).toEqual(['beta', 'gamma']);
  });

  test('treats adding an existing member as idempotent', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed({
      groups: {
        team: { name: 'team', members: ['alpha'], createdAt: 1000 },
      },
    }));

    const response = await request(context.app)
      .post('/api/groups/team/members')
      .send({ add: ['alpha'] });

    expect(response.status).toBe(200);
    expect(response.body.group.members).toEqual(['alpha']);
  });

  test('deduplicates adds case-insensitively against existing members', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed({
      groups: {
        team: { name: 'team', members: ['alpha'], createdAt: 1000 },
      },
    }));

    const response = await request(context.app)
      .post('/api/groups/team/members')
      .send({ add: ['Alpha'] });

    expect(response.status).toBe(200);
    expect(response.body.group.members).toEqual(['alpha']);
  });

  test('returns 404 for membership updates on a missing group', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed());

    const response = await request(context.app)
      .post('/api/groups/nonexistent/members')
      .send({ remove: ['alpha'] });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'group not found' });
  });

  test('treats empty membership updates as no-ops', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed({
      groups: {
        team: { name: 'team', members: ['alpha'], createdAt: 1000 },
      },
    }));

    const explicit = await request(context.app)
      .post('/api/groups/team/members')
      .send({ add: [], remove: [] });
    const implicit = await request(context.app)
      .post('/api/groups/team/members')
      .send({});

    expect(explicit.status).toBe(200);
    expect(explicit.body.group.members).toEqual(['alpha']);
    expect(implicit.status).toBe(200);
    expect(implicit.body.group.members).toEqual(['alpha']);
  });

  test('posts a message to a group', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed({
      groups: {
        dev: { name: 'dev', members: ['alpha', 'beta'], createdAt: 1000 },
      },
    }));

    const response = await request(context.app)
      .post('/api/messages')
      .send({ from: 'alpha', group: 'dev', type: 'inform', summary: 'hello team', full: 'hello team' });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.delivery.targetKind).toBe(null);

    const stored = readJson(messagesPath(context.runtimeDir));
    expect(stored).toHaveLength(1);
    expect(stored[0].group).toBe('dev');
    expect(stored[0].to).toBe(null);
  });

  test('rejects group messages from non-members', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed({
      groups: {
        dev: { name: 'dev', members: ['alpha'], createdAt: 1000 },
      },
    }));

    const response = await request(context.app)
      .post('/api/messages')
      .send({ from: 'beta', group: 'dev', type: 'inform', summary: 'hello', full: 'hello' });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "sender 'beta' is not a member of group 'dev'" });
  });

  test('rejects messages that specify both to and group', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed({
      groups: {
        dev: { name: 'dev', members: ['alpha', 'beta'], createdAt: 1000 },
      },
    }));

    const response = await request(context.app)
      .post('/api/messages')
      .send({ from: 'alpha', to: 'beta', group: 'dev', type: 'inform', summary: 'x', full: 'x' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'to and group are mutually exclusive' });
  });

  test('returns 404 when posting to a missing group', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed());

    const response = await request(context.app)
      .post('/api/messages')
      .send({ from: 'alpha', group: 'nonexistent', type: 'inform', summary: 'x', full: 'x' });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'group not found: nonexistent' });
  });

  test('auto-creates the info group for system posts', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed());

    const response = await request(context.app)
      .post('/api/messages')
      .send({ from: 'system', group: 'info', type: 'inform', summary: 'sys msg', full: 'sys msg' });

    expect(response.status).toBe(200);
    const storedGroups = readJson(groupsPath(context.runtimeDir));
    expect(storedGroups.info).toBeDefined();
  });

  test('captures online group mentions without warnings', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed({
      groups: {
        dev: { name: 'dev', members: ['alpha', 'beta'], createdAt: 1000 },
      },
    }));

    const response = await request(context.app)
      .post('/api/messages')
      .send({ from: 'alpha', group: 'dev', type: 'inform', summary: '@beta check this', full: '@beta check this' });

    expect(response.status).toBe(200);
    const stored = readJson(messagesPath(context.runtimeDir));
    expect(stored[0].mentions).toEqual(['beta']);
    expect(response.body.warnings).toEqual([]);
    expect(response.body.delivery.suppressed).toEqual([]);
  });

  test('warns but does not suppress offline mentions in group messages', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed({
      groups: {
        dev: { name: 'dev', members: ['alpha', 'gamma'], createdAt: 1000 },
      },
    }));

    const response = await request(context.app)
      .post('/api/messages')
      .send({ from: 'alpha', group: 'dev', type: 'inform', summary: '@gamma check this', full: '@gamma check this' });

    expect(response.status).toBe(200);
    expect(response.body.warnings).toEqual([
      {
        code: 'mentions_offline',
        targets: [{ target: 'gamma', server: null, reason: 'idle' }],
      },
    ]);
    expect(response.body.delivery.suppressed).toEqual([]);
    const stored = readJson(messagesPath(context.runtimeDir));
    expect(stored[0].suppressedRecipients || []).toEqual([]);

    const inbox = await request(context.app).get('/api/inbox/gamma');
    expect(inbox.status).toBe(200);
    expect(inbox.body.group.map((row) => row.id)).toEqual([stored[0].id]);
  });

  test('warns and suppresses mentions for agents outside the group', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed({
      groups: {
        dev: { name: 'dev', members: ['alpha', 'beta'], createdAt: 1000 },
      },
    }));

    const response = await request(context.app)
      .post('/api/messages')
      .send({ from: 'alpha', group: 'dev', type: 'inform', summary: '@delta help', full: '@delta help' });

    expect(response.status).toBe(200);
    expect(response.body.warnings).toEqual([
      {
        code: 'mentions_not_in_group',
        targets: [{ target: 'delta', reason: 'not-in-group' }],
      },
    ]);
    expect(response.body.delivery.suppressed).toEqual(['delta']);
  });

  test('ignores unknown raw mentions that do not resolve to a known agent or member', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed({
      groups: {
        dev: { name: 'dev', members: ['alpha', 'beta'], createdAt: 1000 },
      },
    }));

    const response = await request(context.app)
      .post('/api/messages')
      .send({ from: 'alpha', group: 'dev', type: 'inform', summary: '@nobody help', full: '@nobody help' });

    expect(response.status).toBe(200);
    expect(response.body.warnings).toEqual([]);
    const stored = readJson(messagesPath(context.runtimeDir));
    expect(stored[0].mentions).toEqual([]);
    expect(stored[0].suppressedRecipients || []).toEqual([]);
  });

  test('splits group messages into unread and read based on the group cursor', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed({
      groups: {
        dev: { name: 'dev', members: ['alpha', 'beta'], createdAt: 1000 },
      },
      messages: [
        { id: 'msg_1', ts: 1000, from: 'alpha', group: 'dev', type: 'inform', priority: 'normal', summary: 'old msg', full: 'old msg', mentions: [], reply_to: null },
        { id: 'msg_2', ts: 2000, from: 'beta', group: 'dev', type: 'inform', priority: 'normal', summary: 'new msg', full: 'new msg', mentions: [], reply_to: null },
      ],
      cursors: {
        alpha: { inbox: 0, inboxId: null, groups: { dev: 1500 }, groupIds: { dev: 'msg_1' } },
      },
    }));

    const response = await request(context.app).get('/api/groups/dev/messages?agent=alpha&advance=none');

    expect(response.status).toBe(200);
    expect(response.body.unread.map((row) => row.id)).toEqual(['msg_2']);
    expect(response.body.read.map((row) => row.id)).toEqual(['msg_1']);
    expect(response.body.unread_total).toBe(1);
    expect(response.body.unread_returned).toBe(1);
    expect(response.body.unread_omitted).toBe(0);
  });

  test('requires a valid agent query param for group message reads', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed({
      groups: {
        dev: { name: 'dev', members: ['alpha'], createdAt: 1000 },
      },
    }));

    const missing = await request(context.app).get('/api/groups/dev/messages');
    const invalid = await request(context.app).get('/api/groups/dev/messages?agent=%20');
    const unknown = await request(context.app).get('/api/groups/dev/messages?agent=nonexistent');

    expect(missing.status).toBe(400);
    expect(missing.body).toEqual({ error: 'agent query param required' });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({ error: 'invalid agent query param' });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: 'agent not found' });
  });

  test('rejects group message reads for non-members', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed({
      groups: {
        dev: { name: 'dev', members: ['alpha'], createdAt: 1000 },
      },
    }));

    const response = await request(context.app).get('/api/groups/dev/messages?agent=beta');

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "agent 'beta' is not a member of group 'dev'" });
  });

  test('supports advance=none previews without moving the group cursor', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed({
      groups: {
        dev: { name: 'dev', members: ['alpha'], createdAt: 1000 },
      },
      messages: [
        { id: 'msg_1', ts: 1000, from: 'beta', group: 'dev', type: 'inform', priority: 'normal', summary: 'm1', full: 'm1', mentions: [], reply_to: null },
        { id: 'msg_2', ts: 2000, from: 'beta', group: 'dev', type: 'inform', priority: 'normal', summary: 'm2', full: 'm2', mentions: [], reply_to: null },
        { id: 'msg_3', ts: 3000, from: 'beta', group: 'dev', type: 'inform', priority: 'normal', summary: 'm3', full: 'm3', mentions: [], reply_to: null },
      ],
    }));

    const first = await request(context.app).get('/api/groups/dev/messages?agent=alpha&advance=none&unread_limit=10');
    const second = await request(context.app).get('/api/groups/dev/messages?agent=alpha&advance=none&unread_limit=10');

    expect(first.body.unread.map((row) => row.id)).toEqual(['msg_1', 'msg_2', 'msg_3']);
    expect(second.body.unread.map((row) => row.id)).toEqual(['msg_1', 'msg_2', 'msg_3']);
    const cursors = readJson(cursorsPath(context.runtimeDir));
    expect(cursors.alpha || null).toBe(null);
  });

  test('supports advance=all by consuming all unread group messages', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed({
      groups: {
        dev: { name: 'dev', members: ['alpha'], createdAt: 1000 },
      },
      messages: [
        { id: 'msg_1', ts: 1000, from: 'beta', group: 'dev', type: 'inform', priority: 'normal', summary: 'm1', full: 'm1', mentions: [], reply_to: null },
        { id: 'msg_2', ts: 2000, from: 'beta', group: 'dev', type: 'inform', priority: 'normal', summary: 'm2', full: 'm2', mentions: [], reply_to: null },
        { id: 'msg_3', ts: 3000, from: 'beta', group: 'dev', type: 'inform', priority: 'normal', summary: 'm3', full: 'm3', mentions: [], reply_to: null },
      ],
    }));

    const first = await request(context.app).get('/api/groups/dev/messages?agent=alpha&advance=all');
    const second = await request(context.app).get('/api/groups/dev/messages?agent=alpha&advance=none');

    expect(first.body.unread).toHaveLength(3);
    expect(second.body.unread).toHaveLength(0);
  });

  test('requires bearer or target agent token before advancing a group cursor when auth is configured', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed({
      groups: {
        dev: { name: 'dev', members: ['alpha', 'beta'], createdAt: 1000 },
      },
      messages: [
        { id: 'msg_1', ts: 1000, from: 'beta', group: 'dev', type: 'inform', priority: 'normal', summary: 'm1', full: 'm1', mentions: [], reply_to: null },
        { id: 'msg_2', ts: 2000, from: 'beta', group: 'dev', type: 'inform', priority: 'normal', summary: 'm2', full: 'm2', mentions: [], reply_to: null },
      ],
      agentTokens: { alpha: ALPHA_TOKEN, beta: BETA_TOKEN },
      env: { API_TOKEN },
    }));

    const anonymousPreview = await request(context.app).get('/api/groups/dev/messages?agent=alpha&advance=none');
    expect(anonymousPreview.status).toBe(401);
    expect(anonymousPreview.body).toEqual({ error: 'agent token required' });

    const anonymousAdvance = await request(context.app).get('/api/groups/dev/messages?agent=alpha&advance=all');
    expect(anonymousAdvance.status).toBe(401);
    expect(anonymousAdvance.body).toEqual({ error: 'agent token required' });
    expect(readJson(cursorsPath(context.runtimeDir)).alpha || null).toBe(null);

    const wrongAgentAdvance = await request(context.app)
      .get('/api/groups/dev/messages?agent=alpha&advance=all')
      .set('X-Agent-Token', BETA_TOKEN);
    expect(wrongAgentAdvance.status).toBe(403);
    expect(readJson(cursorsPath(context.runtimeDir)).alpha || null).toBe(null);

    const bearerPreview = await request(context.app)
      .get('/api/groups/dev/messages?agent=alpha&advance=none')
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(bearerPreview.status).toBe(200);
    expect(bearerPreview.body.unread.map((row) => row.id)).toEqual(['msg_1', 'msg_2']);

    const agentAdvance = await request(context.app)
      .get('/api/groups/dev/messages?agent=alpha&advance=all')
      .set('X-Agent-Token', ALPHA_TOKEN);
    expect(agentAdvance.status).toBe(200);
    expect(agentAdvance.body.unread).toHaveLength(2);
    expect(readJson(cursorsPath(context.runtimeDir)).alpha.groups.dev).toBe(2000);
  });

  test('supports advance=delivered by consuming only the returned unread subset', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed({
      groups: {
        dev: { name: 'dev', members: ['alpha'], createdAt: 1000 },
      },
      messages: [
        { id: 'msg_1', ts: 1000, from: 'beta', group: 'dev', type: 'inform', priority: 'normal', summary: 'm1', full: 'm1', mentions: [], reply_to: null },
        { id: 'msg_2', ts: 2000, from: 'beta', group: 'dev', type: 'inform', priority: 'normal', summary: 'm2', full: 'm2', mentions: [], reply_to: null },
        { id: 'msg_3', ts: 3000, from: 'beta', group: 'dev', type: 'inform', priority: 'normal', summary: 'm3', full: 'm3', mentions: [], reply_to: null },
      ],
    }));

    const first = await request(context.app).get('/api/groups/dev/messages?agent=alpha&advance=delivered&unread_limit=2');
    const second = await request(context.app).get('/api/groups/dev/messages?agent=alpha&advance=none&unread_limit=10');

    expect(first.body.unread_returned).toBe(2);
    expect(first.body.unread_omitted).toBe(1);
    expect(readDeliveryEvents(context.runtimeDir)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'group.read_ack',
        agent: 'alpha',
        messageId: 'msg_3',
        messageIds: ['msg_1', 'msg_2', 'msg_3'],
        reason: 'group-read-delivered',
        context: expect.objectContaining({
          returnedMessageIds: ['msg_2', 'msg_3'],
        }),
      }),
    ]));
    expect(second.body.unread_total).toBe(0);
    expect(second.body.unread).toEqual([]);
    expect(second.body.read.map((row) => row.id)).toEqual(['msg_1', 'msg_2', 'msg_3']);
  });

  test('caps returned unread group messages with unread_limit', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed({
      groups: {
        dev: { name: 'dev', members: ['alpha'], createdAt: 1000 },
      },
      messages: Array.from({ length: 10 }, (_, index) => ({
        id: `msg_${index + 1}`,
        ts: (index + 1) * 1000,
        from: 'beta',
        group: 'dev',
        type: 'inform',
        priority: 'normal',
        summary: `m${index + 1}`,
        full: `m${index + 1}`,
        mentions: [],
        reply_to: null,
      })),
    }));

    const response = await request(context.app).get('/api/groups/dev/messages?agent=alpha&unread_limit=3&advance=none');

    expect(response.status).toBe(200);
    expect(response.body.unread_total).toBe(10);
    expect(response.body.unread_returned).toBe(3);
    expect(response.body.unread_omitted).toBe(7);
    expect(response.body.unread.map((row) => row.id)).toEqual(['msg_8', 'msg_9', 'msg_10']);
  });

  test('caps returned read history with limit', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed({
      groups: {
        dev: { name: 'dev', members: ['alpha'], createdAt: 1000 },
      },
      messages: Array.from({ length: 10 }, (_, index) => ({
        id: `msg_${index + 1}`,
        ts: (index + 1) * 1000,
        from: 'beta',
        group: 'dev',
        type: 'inform',
        priority: 'normal',
        summary: `m${index + 1}`,
        full: `m${index + 1}`,
        mentions: [],
        reply_to: null,
      })),
      cursors: {
        alpha: { inbox: 0, inboxId: null, groups: { dev: 10000 }, groupIds: { dev: 'msg_10' } },
      },
    }));

    const response = await request(context.app).get('/api/groups/dev/messages?agent=alpha&limit=5');

    expect(response.status).toBe(200);
    expect(response.body.read).toHaveLength(5);
    expect(response.body.read.map((row) => row.id)).toEqual(['msg_6', 'msg_7', 'msg_8', 'msg_9', 'msg_10']);
  });

  test('lists groups for an agent with unread message and mention counts', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed({
      groups: {
        dev: { name: 'dev', members: ['alpha', 'beta'], createdAt: 1000 },
        ops: { name: 'ops', members: ['alpha'], createdAt: 1001 },
      },
      messages: [
        { id: 'msg_1', ts: 2000, from: 'beta', group: 'dev', type: 'inform', priority: 'normal', summary: '@alpha ping', full: '@alpha ping', mentions: ['alpha'], reply_to: null },
        { id: 'msg_2', ts: 3000, from: 'beta', group: 'dev', type: 'inform', priority: 'normal', summary: 'plain', full: 'plain', mentions: [], reply_to: null },
        { id: 'msg_3', ts: 4000, from: 'system', group: 'ops', type: 'inform', priority: 'normal', summary: '@alpha ops', full: '@alpha ops', mentions: ['alpha'], reply_to: null },
      ],
      cursors: {
        alpha: { inbox: 0, inboxId: null, groups: {}, groupIds: {} },
      },
    }));

    const response = await request(context.app).get('/api/agents/alpha/groups');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'dev', unread_messages: 2, unread_mentions: 1 }),
      expect.objectContaining({ name: 'ops', unread_messages: 1, unread_mentions: 1 }),
    ]));
  });

  test('returns an empty group list when an agent belongs to no groups', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed());

    const response = await request(context.app).get('/api/agents/delta/groups');

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });

  test('validates the agent name for group membership listings', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed());

    const invalid = await request(context.app).get('/api/agents/%20/groups');
    const missing = await request(context.app).get('/api/agents/nonexistent/groups');

    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({ error: 'invalid agent name' });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'agent not found' });
  });

  test('normalizes stored group membership when sender casing differs', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed({
      groups: {
        dev: { name: 'dev', members: ['Alpha'], createdAt: 1000 },
      },
    }));

    const response = await request(context.app)
      .post('/api/messages')
      .send({ from: 'alpha', group: 'dev', type: 'inform', summary: 'hi', full: 'hi' });

    expect(response.status).toBe(200);
    expect(readJson(groupsPath(context.runtimeDir)).dev.members).toEqual(['alpha']);
  });

  test('allows system to post to a group without membership', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed({
      groups: {
        dev: { name: 'dev', members: ['alpha'], createdAt: 1000 },
      },
    }));

    const response = await request(context.app)
      .post('/api/messages')
      .send({ from: 'system', group: 'dev', type: 'inform', summary: 'sys', full: 'sys' });

    expect(response.status).toBe(200);
  });

  test('excludes suppressed group messages from group reads', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed({
      groups: {
        dev: { name: 'dev', members: ['alpha'], createdAt: 1000 },
      },
      messages: [
        {
          id: 'msg_1',
          ts: 1000,
          from: 'beta',
          group: 'dev',
          type: 'inform',
          priority: 'normal',
          summary: 'hidden',
          full: 'hidden',
          mentions: ['alpha'],
          reply_to: null,
          suppressedRecipients: ['alpha'],
        },
      ],
    }));

    const response = await request(context.app).get('/api/groups/dev/messages?agent=alpha&advance=none');

    expect(response.status).toBe(200);
    expect(response.body.unread).toEqual([]);
    expect(response.body.read).toEqual([]);
  });

  test('includes group membership in agent detail responses', async () => {
    context = await createBackendTestContext('api-groups-test-', baseSeed({
      groups: {
        dev: { name: 'dev', members: ['alpha'], createdAt: 1000 },
        ops: { name: 'ops', members: ['alpha', 'beta'], createdAt: 1001 },
      },
    }));

    const response = await request(context.app).get('/api/agents/alpha');

    expect(response.status).toBe(200);
    expect(response.body.groups).toEqual(['dev', 'ops']);
  });
});
