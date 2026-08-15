/*
 * The queue's mutation boundary — which writes a NON-LOCAL caller may make.
 *
 * This file used to boot server.js, the web portal's process. The portal is deleted and the delivery
 * queue moved into the backend, so the boundary moved with it: local requests stay open (the `hafleet
 * send` and `hafleet reminder` CLIs run on this host with no credential), and a non-local caller needs
 * the OPERATOR BEARER. The enforcement is the backend's GLOBAL /api middleware — not a per-route guard;
 * the first version of this port added one and found the global layer answering first. The portal's
 * HAFLEET_DASHBOARD_TOKEN died with the portal.
 *
 * WHAT DIED WITH THE OLD FILE, so nobody hunts for the coverage: the agent down/roster/status tests
 * exercised portal-only routes (`/api/agents/:name/down`, `/api/agents/all`, `/api/agents/status`)
 * that had no consumer outside the portal's own pages; the sync-child-process check asserted server.js
 * never called execFileSync — that concern now lives in the delivery-queue tests, against the module
 * that actually shells out.
 */

import { afterEach, describe, expect, test } from 'vitest';
import { existsSync, readdirSync } from 'fs';
import path from 'path';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const OPERATOR = 'queue-boundary-operator-token';

let context = null;
afterEach(() => { context?.cleanup(); context = null; });

async function boot({ env = {} } = {}) {
  context = await createBackendTestContext('queue-boundary-', {
    agents: {},
    env: { API_TOKEN: OPERATOR, ...env },
  });
  return context;
}

/**
 * Supertest always connects over loopback, and `isLocalRequest` deliberately ignores forwarded
 * headers — trusting a header any caller can set would let a remote caller claim to be local. So the
 * non-local branch is reached the way the old process reached it in tests: an explicit override hook.
 */
function remoteFor(ctx) {
  ctx.internals.setLocalRequestOverrideForTest(() => false);
  return () => ctx.internals.setLocalRequestOverrideForTest(null);
}

describe('queue mutations: local open, non-local needs the operator bearer', () => {
  test('keeps local queue mutation compatible', async () => {
    const { app } = await boot();
    const create = await request(app)
      .post('/api/queue')
      .send({ from: 'operator', to: 'alpha:0.0', payload: 'hello' });
    expect(create.status).toBe(200);
    expect(create.body).toMatchObject({ ok: true, position: 1 });

    const list = await request(app).get('/api/queue');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ from: 'operator', to: 'alpha:0.0', payload: 'hello' });
  });

  test('blocks non-local queue mutation', async () => {
    const ctx = await boot();
    const restore = remoteFor(ctx);
    try {
      const res = await request(ctx.app).post('/api/queue')
        .send({ from: 'x', to: 'alpha:0.0', payload: 'nope' });
      /*
       * 401 from the GLOBAL /api middleware, not a queue-specific 403. The first version of this port
       * added a per-route guard and these tests came back 401 — because `createApiAuthMiddleware`
       * already refuses non-local callers without the operator bearer for every /api route. The queue
       * inherits the boundary instead of duplicating it; asserting the global layer's own words keeps
       * this test pointed at the thing that actually answers.
       */
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('unauthorized');
    } finally { restore(); }
    expect((await request(ctx.app).get('/api/queue')).body).toEqual([]);
  });

  test('allows non-local mutation with the operator bearer only', async () => {
    const ctx = await boot();
    const restore = remoteFor(ctx);
    try {
      const wrong = await request(ctx.app).post('/api/queue')
        .set('Authorization', 'Bearer not-the-operator')
        .send({ from: 'x', to: 'alpha:0.0', payload: 'nope' });
      expect(wrong.status).toBe(401);

      const right = await request(ctx.app).post('/api/queue')
        .set('Authorization', `Bearer ${OPERATOR}`)
        .send({ from: 'x', to: 'alpha:0.0', payload: 'yes' });
      expect(right.status).toBe(200);
    } finally { restore(); }
  });

  test('reminders sit behind the same boundary', async () => {
    const ctx = await boot();
    const restore = remoteFor(ctx);
    try {
      expect((await request(ctx.app).post('/api/reminders')
        .send({ target: 'a:0.0', delay: 60, msg: 'x' })).status).toBe(401);
      // Non-local GETs meet the same global layer — the portal-era "GETs are open" only survives for
      // LOCAL callers, which is who the CLIs are.
      expect((await request(ctx.app).get('/api/reminders')).status).toBe(401);
    } finally { restore(); }
    expect((await request(ctx.app).post('/api/reminders')
      .send({ target: 'a:0.0', delay: 60, msg: 'x' })).status).toBe(200);
  });
});

describe('queue persistence at startup', () => {
  test('backs up unreadable queue files on startup', async () => {
    /*
     * A corrupt queue.json must not take the backend down or silently become an empty queue that
     * overwrites the evidence. The unreadable file is moved aside with a timestamped name and the
     * queue starts empty — the operator can still read what was there.
     */
    context = await createBackendTestContext('queue-boundary-corrupt-', {
      agents: {},
      env: { API_TOKEN: OPERATOR },
      rawRuntimeFiles: { 'logs/queue.json': '{not-json' },
    });
    const { app, runtimeDir } = context;

    const queuePath = path.join(runtimeDir, 'logs', 'queue.json');
    const backups = readdirSync(path.dirname(queuePath))
      .filter((name) => name.startsWith('queue.json.corrupt-'));
    expect(existsSync(queuePath)).toBe(false);
    expect(backups).toHaveLength(1);

    const list = await request(app).get('/api/queue');
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);
  });
});
