import { afterEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

describe('task system API', () => {
  let context = null;

  afterEach(() => {
    context?.cleanup();
    context = null;
  });

  async function setup() {
    context = await createBackendTestContext('agent-chat-tasks-test-', {
      agents: {
        alpha: { name: 'alpha', type: 'agent', kind: 'agent', online: false, manualDown: true, offlineReason: 'idle' },
        beta: { name: 'beta', type: 'agent', kind: 'agent', online: false, manualDown: true, offlineReason: 'idle' },
      },
      groups: {},
    });
    return context;
  }

  test('creates a task and retrieves it by id', async () => {
    await setup();
    const create = await request(context.app)
      .post('/api/tasks')
      .send({ title: 'Fix the bug', description: 'Something is broken', assignee: 'alpha', priority: 'p1', labels: ['urgent'] });
    expect(create.status).toBe(200);
    expect(create.body.ok).toBe(true);
    expect(create.body.task.title).toBe('Fix the bug');
    expect(create.body.task.status).toBe('created');
    expect(create.body.task.priority).toBe('p1');
    expect(create.body.task.assignee).toBe('alpha');
    expect(create.body.task.labels).toEqual(['urgent']);
    expect(create.body.task.health).toBe(null);
    expect(create.body.task.id).toMatch(/^task_/);

    const get = await request(context.app).get(`/api/tasks/${create.body.task.id}`);
    expect(get.status).toBe(200);
    expect(get.body.title).toBe('Fix the bug');
  });

  test('lists tasks with filters', async () => {
    await setup();
    await request(context.app).post('/api/tasks').send({ title: 'A', assignee: 'alpha', priority: 'p0' });
    await request(context.app).post('/api/tasks').send({ title: 'B', assignee: 'beta', priority: 'p2' });
    await request(context.app).post('/api/tasks').send({ title: 'C', assignee: 'alpha', priority: 'p2' });

    const all = await request(context.app).get('/api/tasks');
    expect(all.body).toHaveLength(3);

    const byAssignee = await request(context.app).get('/api/tasks?assignee=alpha');
    expect(byAssignee.body).toHaveLength(2);

    const byPriority = await request(context.app).get('/api/tasks?priority=p0');
    expect(byPriority.body).toHaveLength(1);
    expect(byPriority.body[0].title).toBe('A');
  });

  test('operator PATCH updates all fields', async () => {
    await setup();
    const create = await request(context.app).post('/api/tasks').send({ title: 'Original', assignee: 'alpha' });
    const id = create.body.task.id;

    const patch = await request(context.app).patch(`/api/tasks/${id}`).send({ title: 'Updated', priority: 'p0' });
    expect(patch.status).toBe(200);
    expect(patch.body.task.title).toBe('Updated');
    expect(patch.body.task.priority).toBe('p0');
  });

  test('agent execution PATCH only updates heartbeat and waiting metadata', async () => {
    await setup();
    const create = await request(context.app).post('/api/tasks').send({ title: 'Exec test', assignee: 'alpha' });
    const id = create.body.task.id;

    const patch = await request(context.app)
      .patch(`/api/tasks/${id}/execution`)
      .send({ heartbeat_at: true, waiting_reason: 'waiting for CI' });
    expect(patch.status).toBe(200);
    expect(patch.body.task.heartbeat_at).not.toBe(null);
    expect(patch.body.task.waiting_reason).toBe('waiting for CI');
    // Title should remain unchanged
    expect(patch.body.task.title).toBe('Exec test');
  });

  test('deletes a task', async () => {
    await setup();
    const create = await request(context.app).post('/api/tasks').send({ title: 'Deletable' });
    const id = create.body.task.id;

    const del = await request(context.app).delete(`/api/tasks/${id}`);
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    const get = await request(context.app).get(`/api/tasks/${id}`);
    expect(get.status).toBe(404);
  });

  test('status transitions follow valid paths', async () => {
    await setup();
    const create = await request(context.app).post('/api/tasks').send({ title: 'Lifecycle', assignee: 'alpha' });
    const id = create.body.task.id;
    expect(create.body.task.status).toBe('created');

    // created → accepted
    const accept = await request(context.app).post(`/api/tasks/${id}/accept`);
    expect(accept.status).toBe(200);
    expect(accept.body.task.status).toBe('accepted');
    expect(accept.body.task.started_at).not.toBe(null);

    // accepted → in_progress
    const start = await request(context.app).post(`/api/tasks/${id}/transition`).send({ status: 'in_progress' });
    expect(start.status).toBe(200);
    expect(start.body.task.status).toBe('in_progress');

    // in_progress → blocked (with required metadata)
    const block = await request(context.app).post(`/api/tasks/${id}/transition`).send({
      status: 'blocked',
      waiting_reason: 'waiting for deploy',
      waiting_until: '2026-03-15T00:00:00Z',
    });
    expect(block.status).toBe(200);
    expect(block.body.task.status).toBe('blocked');
    expect(block.body.task.waiting_reason).toBe('waiting for deploy');

    // blocked → in_progress (clears waiting fields)
    const resume = await request(context.app).post(`/api/tasks/${id}/transition`).send({ status: 'in_progress' });
    expect(resume.status).toBe(200);
    expect(resume.body.task.status).toBe('in_progress');
    expect(resume.body.task.waiting_reason).toBe(null);

    // in_progress → done
    const done = await request(context.app).post(`/api/tasks/${id}/transition`).send({ status: 'done' });
    expect(done.status).toBe(200);
    expect(done.body.task.status).toBe('done');
    expect(done.body.task.completed_at).not.toBe(null);
  });

  test('rejects invalid status transitions', async () => {
    await setup();
    const create = await request(context.app).post('/api/tasks').send({ title: 'Bad transitions' });
    const id = create.body.task.id;

    // created → in_progress (must go through accepted first)
    const bad = await request(context.app).post(`/api/tasks/${id}/transition`).send({ status: 'in_progress' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('cannot transition');

    // created → blocked (invalid)
    const bad2 = await request(context.app).post(`/api/tasks/${id}/transition`).send({ status: 'blocked' });
    expect(bad2.status).toBe(400);
    expect(bad2.body.error).toContain('cannot transition');

    // created → done (must go through accepted→in_progress)
    const bad3 = await request(context.app).post(`/api/tasks/${id}/transition`).send({ status: 'done' });
    expect(bad3.status).toBe(400);
    expect(bad3.body.error).toContain('cannot transition');
  });

  test('rejects blocked transition without waiting metadata', async () => {
    await setup();
    const create = await request(context.app).post('/api/tasks').send({ title: 'Block test' });
    const id = create.body.task.id;

    // Move to in_progress
    await request(context.app).post(`/api/tasks/${id}/accept`);
    await request(context.app).post(`/api/tasks/${id}/transition`).send({ status: 'in_progress' });

    // blocked without waiting_reason
    const noReason = await request(context.app).post(`/api/tasks/${id}/transition`).send({
      status: 'blocked',
      waiting_until: '2026-03-15T00:00:00Z',
    });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error).toContain('waiting_reason');

    // blocked without waiting_until
    const noUntil = await request(context.app).post(`/api/tasks/${id}/transition`).send({
      status: 'blocked',
      waiting_reason: 'waiting for deploy',
    });
    expect(noUntil.status).toBe(400);
    expect(noUntil.body.error).toContain('waiting_until');

    // Verify task is still in_progress
    const get = await request(context.app).get(`/api/tasks/${id}`);
    expect(get.body.status).toBe('in_progress');
  });

  test('rejects task creation without title', async () => {
    await setup();
    const create = await request(context.app).post('/api/tasks').send({ assignee: 'alpha' });
    expect(create.status).toBe(400);
    expect(create.body.error).toContain('title');
  });

  test('lists tasks for a specific agent via /api/agents/:name/tasks', async () => {
    await setup();
    await request(context.app).post('/api/tasks').send({ title: 'Alpha task', assignee: 'alpha' });
    await request(context.app).post('/api/tasks').send({ title: 'Beta task', assignee: 'beta' });

    const agentTasks = await request(context.app).get('/api/agents/alpha/tasks');
    expect(agentTasks.status).toBe(200);
    expect(agentTasks.body).toHaveLength(1);
    expect(agentTasks.body[0].title).toBe('Alpha task');
  });

  test('returns 404 for non-existent task', async () => {
    await setup();
    const get = await request(context.app).get('/api/tasks/task_nonexistent');
    expect(get.status).toBe(404);
  });

  test('blocked→done is not allowed (must resume to in_progress first)', async () => {
    await setup();
    const create = await request(context.app).post('/api/tasks').send({ title: 'Blocked done test' });
    const id = create.body.task.id;

    await request(context.app).post(`/api/tasks/${id}/accept`);
    await request(context.app).post(`/api/tasks/${id}/transition`).send({ status: 'in_progress' });
    await request(context.app).post(`/api/tasks/${id}/transition`).send({
      status: 'blocked',
      waiting_reason: 'waiting',
      waiting_until: '2026-03-20T00:00:00Z',
    });

    const bad = await request(context.app).post(`/api/tasks/${id}/transition`).send({ status: 'done' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('cannot transition');
  });
});
