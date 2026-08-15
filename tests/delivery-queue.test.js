/*
 * The delivery semantics that MOVED — from server.js (deleted with the portal) into
 * lib/delivery-queue.js (hosted by the backend).
 *
 * This file replaces tests/server-delivery.test.js, which drove the portal process over HTTP and is
 * gone. The ledger of what happened to its subjects, so nobody hunts for lost coverage:
 *
 *   KEPT, RE-POINTED AT THE MODULE (here): the two-stage tmux delivery and its partial/failed verdicts,
 *   the message-log append, idle gating and the urgent bypass, content-based idle detection, queue
 *   persistence with rollback and crash recovery, idempotency, redirect application, backend-notification
 *   supersession and stale-dropping, reminder merge/fire/persistence, the force-send route, and the
 *   no-sync-exec rule.
 *
 *   DIED WITH THE PORTAL (deliberately untested): SSE frame fan-out to portal clients, the backend-SSE
 *   reconnect forwarder, pollMessageLogTail, and every proxy route the portal served. Their consumers
 *   were the portal's own pages.
 *
 * The module is driven DIRECTLY — init() with a temp logsRoot, injected sinks, a fake execFileAsync —
 * because that is what it is now: a library the backend hosts, not a process to boot. Route behaviour
 * is exercised through a bare express app with the module's own installRoutes, and the auth boundary is
 * NOT re-tested here: that lives in server-mutation-boundary.test.js against the backend's global layer.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import express from 'express';
import request from 'supertest';

let q = null;            // the module, cache-busted per test
let logsRoot = null;
let sinkLog = null;      // every sink call, for assertions

async function importQueue() {
  const url = pathToFileURL(path.resolve('lib/delivery-queue.js')).href;
  return import(`${url}?delivery-test=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}


/**
 * The module's own log appends are fire-and-forget (`appendFile(...).catch(() => {})`) — delivery must
 * not wait on diagnostics. So a test that reads the file right after the call races it and loses; this
 * polls briefly instead of sprinkling sleeps sized by hope.
 */
async function waitForFileContent(filePath, predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(filePath)) {
      const text = readFileSync(filePath, 'utf-8');
      if (predicate(text)) return text;
    }
    if (Date.now() > deadline) {
      return existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

function fakeExec(handler) {
  return async (cmd, args, _opts) => {
    const out = handler(cmd, args);
    if (out instanceof Error) throw out;
    return { stdout: out ?? '', stderr: '' };
  };
}

/** tmux that always works: panes exist, captures are stable, send-keys succeeds. */
function obedientTmux(paneText = 'idle prompt >') {
  return fakeExec((cmd, args) => {
    if (args[0] === 'list-panes') return 'alpha:0.0\nbeta:0.0\n';
    if (args[0] === 'capture-pane') return paneText;
    if (args[0] === 'send-keys') return '';
    return '';
  });
}

async function initQueue({ sinks = {}, idleThresholdMs = 50 } = {}) {
  q = await importQueue();
  logsRoot = mkdtempSync(path.join(os.tmpdir(), 'delivery-queue-test-'));
  sinkLog = { events: [], pushDelivered: [], broadcasts: [] };
  q.initDeliveryQueue({
    logsRoot,
    idleThresholdMs,
    emitDeliveryEvent: (row) => { sinkLog.events.push(row); },
    recordPushDelivered: async (body) => { sinkLog.pushDelivered.push(body); return { ok: true, status: 200 }; },
    unreadSnapshot: sinks.unreadSnapshot ?? (async () => null),
    offlineLocalTmuxSessions: async () => new Set(),
    broadcast: (event, data) => { sinkLog.broadcasts.push({ event, data }); },
    ...sinks,
  });
  return q;
}

function appFor(queueModule) {
  const app = express();
  app.use(express.json());
  queueModule.installDeliveryQueueRoutes(app);
  return app;
}

afterEach(() => {
  q?.stopDeliveryQueueLoops?.();
  q?.resetDeliveryQueueHooks?.();
  q = null;
  if (logsRoot) rmSync(logsRoot, { recursive: true, force: true });
  logsRoot = null;
  vi.useRealTimers();
});

describe('deliverMessage: two tmux calls, and the difference between failed and partial', () => {
  test('delivers, appends to messages.jsonl, and acks push-delivered for backend notifications', async () => {
    await initQueue();
    q.setDeliveryQueueHooks({ execFileAsync: obedientTmux() });
    const entry = {
      id: 1, from: 'hafleet-backend', to: 'alpha:0.0',
      payload: '[NOTIFICATION] check your inbox', queuedAt: Date.now(),
      notifyMeta: { kind: 'inbox', sourceMsgId: 'msg_1' },
    };
    const result = await q.deliverMessage(entry);
    expect(result.ok).toBe(true);

    const log = (await waitForFileContent(
      path.join(logsRoot, 'messages.jsonl'), (t) => t.trim().length > 0,
    )).trim();
    expect(JSON.parse(log)).toMatchObject({ from: 'hafleet-backend', to: 'alpha:0.0' });
    // The ack reached the backend sink — this used to be an HTTP POST to ourselves.
    expect(sinkLog.pushDelivered).toHaveLength(1);
    expect(sinkLog.pushDelivered[0]).toMatchObject({ agent: 'alpha', queueEntryId: 1 });
    expect(sinkLog.events.some((e) => e.type === 'tmux.delivered')).toBe(true);
  });

  test('a payload-stage failure is FAILED (retriable), an enter-stage failure is PARTIAL', async () => {
    /*
     * The distinction is the whole point of sending payload and Enter separately: if the payload never
     * landed the message can be retried safely, but if only Enter failed the text is SITTING IN THE
     * PANE — retrying would type it twice, so partial is terminal and archived, never requeued.
     */
    await initQueue();
    q.setDeliveryQueueHooks({
      execFileAsync: fakeExec((cmd, args) => (args[0] === 'send-keys' ? new Error('no pane') : '')),
    });
    const failed = await q.deliverMessage({ id: 2, from: 'x', to: 'a:0.0', payload: 'p', queuedAt: Date.now() });
    expect(failed).toMatchObject({ ok: false, stage: 'payload', partial: false });

    let call = 0;
    q.setDeliveryQueueHooks({
      execFileAsync: fakeExec((cmd, args) => {
        if (args[0] !== 'send-keys') return '';
        call += 1;
        if (call === 1) return '';            // payload lands
        return new Error('pane died');        // Enter fails
      }),
    });
    const partial = await q.deliverMessage({ id: 3, from: 'x', to: 'a:0.0', payload: 'p', queuedAt: Date.now() });
    expect(partial).toMatchObject({ ok: false, stage: 'enter', partial: true });
    expect(sinkLog.events.some((e) => e.type === 'tmux.delivery_partial')).toBe(true);
  });

  test('the module never shells out synchronously', () => {
    /*
     * Ported from the old process's own rule. A synchronous execFileSync in the delivery path blocks
     * the event loop of what is now the BACKEND — every API request on this deployment — for as long
     * as tmux takes. The one place it would be tempting is exactly the place it must not be.
     */
    const src = readFileSync('lib/delivery-queue.js', 'utf-8');
    expect(src).not.toMatch(/execFileSync|execSync|spawnSync/);
  });
});

describe('the queue routes, driven through the module\'s own installRoutes', () => {
  test('enqueue → snapshot → deliver via force-send', async () => {
    await initQueue();
    q.setDeliveryQueueHooks({ execFileAsync: obedientTmux() });
    const app = appFor(q);

    const created = await request(app).post('/api/queue')
      .send({ from: 'op', to: 'alpha:0.0', payload: 'hello' });
    expect(created.body).toMatchObject({ ok: true, id: 1, position: 1 });

    const sent = await request(app).post('/api/queue/1/send');
    expect(sent.body).toMatchObject({ ok: true, delivered: 1 });
    expect((await request(app).get('/api/queue')).body).toEqual([]);
  });

  test('idempotency: same key dedupes, and the ledger survives a restart', async () => {
    await initQueue();
    const app = appFor(q);
    const first = await request(app).post('/api/queue')
      .set('Idempotency-Key', 'k1').send({ from: 'op', to: 'a:0.0', payload: 'x' });
    const second = await request(app).post('/api/queue')
      .set('Idempotency-Key', 'k1').send({ from: 'op', to: 'a:0.0', payload: 'x' });
    expect(first.body.deduped).toBeUndefined();
    expect(second.body).toMatchObject({ deduped: true, id: first.body.id });

    // Reload from disk into the same module: the key still dedupes.
    q.initDeliveryQueue({ logsRoot, emitDeliveryEvent: () => {} });
    const third = await request(appFor(q)).post('/api/queue')
      .set('Idempotency-Key', 'k1').send({ from: 'op', to: 'a:0.0', payload: 'x' });
    expect(third.body.deduped).toBe(true);
  });

  test('a redirect in redirects.json is applied at enqueue and disclosed', async () => {
    /*
     * The CRUD for redirects died with the portal — nothing outside it ever called those routes — but
     * the FILE still works: a rename recorded there keeps steering messages, which is what an existing
     * deployment relies on. Editing the file by hand is the interface until something needs more.
     */
    q = await importQueue();
    logsRoot = mkdtempSync(path.join(os.tmpdir(), 'delivery-queue-test-'));
    writeFileSync(path.join(logsRoot, 'redirects.json'), JSON.stringify({ 'old:0.0': 'new:0.0' }));
    q.initDeliveryQueue({ logsRoot, emitDeliveryEvent: () => {} });

    const res = await request(appFor(q)).post('/api/queue')
      .send({ from: 'op', to: 'old:0.0', payload: 'x' });
    expect(res.body.redirected).toBe('old:0.0');
    const snapshot = q.queueSnapshot();
    expect(snapshot[0]).toMatchObject({ to: 'new:0.0', redirectedFrom: 'old:0.0' });
  });

  test('a newer backend notification supersedes the queued one for the same target', async () => {
    await initQueue();
    const app = appFor(q);
    const mk = (n) => ({
      from: 'hafleet-backend', to: 'alpha:0.0', payload: `[NOTIFICATION] v${n}`,
      notifyMeta: { kind: 'inbox', sourceMsgId: `msg_${n}` },
    });
    await request(app).post('/api/queue').send(mk(1));
    await request(app).post('/api/queue').send(mk(2));
    const rows = (await request(app).get('/api/queue')).body;
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toBe('[NOTIFICATION] v2');
    expect(sinkLog.events.some((e) => e.type === 'queue.superseded')).toBe(true);
  });

  test('DELETE /api/queue/:id refuses while delivery is in flight', async () => {
    await initQueue();
    const app = appFor(q);
    await request(app).post('/api/queue').send({ from: 'op', to: 'a:0.0', payload: 'x' });
    // Claim it the way the tick does, then try to cancel it out from under the delivery.
    const entry = q.queueSnapshot()[0];
    expect(entry.deliveryState).toBeUndefined();
    // Force-send with a hanging tmux so the entry sits in `delivering`.
    let release;
    const gate = new Promise((r) => { release = r; });
    q.setDeliveryQueueHooks({
      execFileAsync: async (cmd, args) => { if (args[0] === 'send-keys') await gate; return { stdout: '', stderr: '' }; },
    });
    const sending = request(app).post(`/api/queue/${entry.id}/send`).then((r) => r);
    await new Promise((r) => setTimeout(r, 50));
    const del = await request(app).delete(`/api/queue/${entry.id}`);
    expect(del.status).toBe(409);
    release();
    await sending;
  });

  test('clearing an agent\'s notifications drops only notifications, only that agent\'s', async () => {
    await initQueue();
    const app = appFor(q);
    await request(app).post('/api/queue').send({
      from: 'hafleet-backend', to: 'alpha:0.0', payload: '[NOTIFICATION] x',
      notifyMeta: { kind: 'inbox', sourceMsgId: 'm1' },
    });
    await request(app).post('/api/queue').send({ from: 'human', to: 'alpha:0.0', payload: 'real message' });
    await request(app).post('/api/queue').send({
      from: 'hafleet-backend', to: 'beta:0.0', payload: '[NOTIFICATION] y',
      notifyMeta: { kind: 'inbox', sourceMsgId: 'm2' },
    });

    const res = await request(app).delete('/api/queue/agents/alpha/notifications');
    expect(res.body).toMatchObject({ ok: true, removed: 1 });
    const rows = (await request(app).get('/api/queue')).body;
    expect(rows.map((r) => r.payload).sort()).toEqual(['[NOTIFICATION] y', 'real message']);
  });
});

describe('the tick: idle gating, urgency, staleness', () => {
  async function seedPaneAndSettle(target = 'alpha:0.0') {
    // Two identical captures make the pane "observed and unchanged"; with idleThresholdMs=50 the
    // second observation after a pause reads as idle.
    await q.updatePaneSnapshot(target);
    await new Promise((r) => setTimeout(r, 80));
    await q.updatePaneSnapshot(target);
  }

  test('not idle → held; idle → delivered', async () => {
    await initQueue({ idleThresholdMs: 50 });
    q.setDeliveryQueueHooks({ execFileAsync: obedientTmux() });
    const app = appFor(q);
    await request(app).post('/api/queue').send({ from: 'op', to: 'alpha:0.0', payload: 'x' });

    // Busy pane: a fresh single observation counts as active, so the tick holds the message.
    await q.updatePaneSnapshot('alpha:0.0');
    await q.processQueueTick();
    expect(q.queueSnapshot()).toHaveLength(1);

    await seedPaneAndSettle();
    await q.processQueueTick();
    expect(q.queueSnapshot()).toEqual([]);
    expect(sinkLog.events.some((e) => e.type === 'tmux.delivered')).toBe(true);
  });

  test('urgent priority bypasses the idle gate', async () => {
    await initQueue({ idleThresholdMs: 60_000 });   // nothing could ever look idle
    q.setDeliveryQueueHooks({ execFileAsync: obedientTmux() });
    const app = appFor(q);
    await request(app).post('/api/queue').send({ from: 'op', to: 'alpha:0.0', payload: 'now', priority: 'urgent' });
    await q.updatePaneSnapshot('alpha:0.0');       // observed, and by construction never idle
    await q.processQueueTick();
    expect(q.queueSnapshot()).toEqual([]);
  });

  test('a backend notification whose unread state has moved on is dropped, not delivered', async () => {
    /*
     * The notification says "you have unread messages"; if the agent has since read them, typing it
     * into the pane is a false alarm that costs a working agent its focus. The unread snapshot is the
     * backend's own — the sink that used to be an HTTP call to ourselves.
     */
    await initQueue({
      idleThresholdMs: 50,
      sinks: { unreadSnapshot: async () => ({ unread_total: 0 }) },
    });
    q.setDeliveryQueueHooks({ execFileAsync: obedientTmux() });
    const app = appFor(q);
    await request(app).post('/api/queue').send({
      from: 'hafleet-backend', to: 'alpha:0.0', payload: '[NOTIFICATION] stale',
      notifyMeta: { kind: 'inbox', sourceMsgId: 'gone', unreadCount: 3 },
    });
    await seedPaneAndSettle();
    await q.processQueueTick();
    expect(q.queueSnapshot()).toEqual([]);
    expect(sinkLog.events.some((e) => e.type === 'tmux.delivered')).toBe(false);
    const dropped = await waitForFileContent(
      path.join(logsRoot, 'queue-dropped.jsonl'), (t) => t.includes('stale-notification'),
    );
    expect(dropped).toContain('stale-notification');
  });
});

describe('persistence and crash recovery', () => {
  test('an in-flight entry WITHOUT an idempotency ledger match is recovered to queued', async () => {
    q = await importQueue();
    logsRoot = mkdtempSync(path.join(os.tmpdir(), 'delivery-queue-test-'));
    writeFileSync(path.join(logsRoot, 'queue.json'), JSON.stringify({
      idCounter: 7,
      items: [{ id: 7, from: 'op', to: 'a:0.0', payload: 'x', queuedAt: 1, deliveryState: 'delivering', deliveringAt: 2 }],
      idempotencyKeys: [],
    }));
    q.initDeliveryQueue({ logsRoot, emitDeliveryEvent: () => {} });
    const rows = q.queueSnapshot();
    expect(rows).toHaveLength(1);
    expect(rows[0].deliveryState).toBeUndefined();
  });

  test('an in-flight entry WITH a ledger match is suppressed: the outcome is uncertain', async () => {
    /*
     * The crash happened between "typed into the pane" and "recorded delivered". Retrying might type it
     * twice; dropping silently might lose it. The original chose suppression with an event, and the
     * choice survives the move.
     */
    q = await importQueue();
    logsRoot = mkdtempSync(path.join(os.tmpdir(), 'delivery-queue-test-'));
    const events = [];
    writeFileSync(path.join(logsRoot, 'queue.json'), JSON.stringify({
      idCounter: 7,
      items: [{
        id: 7, from: 'op', to: 'a:0.0', payload: 'x', queuedAt: 1,
        deliveryState: 'delivering', idempotencyKey: 'k7',
      }],
      idempotencyKeys: [['k7', { id: 7, queuedAt: 1, position: 1 }]],
    }));
    q.initDeliveryQueue({ logsRoot, emitDeliveryEvent: (row) => events.push(row) });
    expect(q.queueSnapshot()).toEqual([]);
    expect(events.some((e) => e.type === 'queue.recovery_suppressed')).toBe(true);
  });

  test('terminal markers on disk are discarded on load, not re-delivered', async () => {
    q = await importQueue();
    logsRoot = mkdtempSync(path.join(os.tmpdir(), 'delivery-queue-test-'));
    writeFileSync(path.join(logsRoot, 'queue.json'), JSON.stringify({
      idCounter: 2,
      items: [
        { id: 1, from: 'op', to: 'a:0.0', payload: 'done', queuedAt: 1, deliveryState: 'delivered' },
        { id: 2, from: 'op', to: 'a:0.0', payload: 'live', queuedAt: 2 },
      ],
      idempotencyKeys: [],
    }));
    q.initDeliveryQueue({ logsRoot, emitDeliveryEvent: () => {} });
    expect(q.queueSnapshot().map((r) => r.payload)).toEqual(['live']);
  });

  test('a corrupt queue file is backed up aside, never overwritten silently', async () => {
    q = await importQueue();
    logsRoot = mkdtempSync(path.join(os.tmpdir(), 'delivery-queue-test-'));
    writeFileSync(path.join(logsRoot, 'queue.json'), '{definitely-not-json');
    q.initDeliveryQueue({ logsRoot, emitDeliveryEvent: () => {} });
    expect(existsSync(path.join(logsRoot, 'queue.json'))).toBe(false);
    expect(readdirSync(logsRoot).filter((n) => n.startsWith('queue.json.corrupt-'))).toHaveLength(1);
  });
});

describe('reminders: scheduled, fired, merged', () => {
  test('a due reminder becomes ONE queue entry, and a second due reminder merges into it', async () => {
    /*
     * Two reminders firing while an agent is busy must not stack two prompts: the merge keeps one entry
     * whose payload lists both, so the agent reads one message with the full history.
     */
    await initQueue();
    const app = appFor(q);
    await request(app).post('/api/reminders').send({ target: 'alpha:0.0', delay: 0.01, msg: '第一件事' });
    await request(app).post('/api/reminders').send({ target: 'alpha:0.0', delay: 0.01, msg: '第二件事' });
    await new Promise((r) => setTimeout(r, 30));
    q.processDueReminders();

    const rows = q.queueSnapshot();
    expect(rows).toHaveLength(1);
    expect(rows[0].isReminder).toBe(true);
    expect(rows[0].reminderCount).toBe(2);
    expect(rows[0].payload).toContain('第一件事');
    expect(rows[0].payload).toContain('第二件事');
    expect((await request(app).get('/api/reminders')).body).toEqual([]);
  });

  test('reminders persist across a reload, and DELETE cancels one', async () => {
    await initQueue();
    const app = appFor(q);
    const created = await request(app).post('/api/reminders')
      .send({ target: 'alpha:0.0', delay: 3600, msg: '很久以后' });
    expect(created.body.ok).toBe(true);

    q.initDeliveryQueue({ logsRoot, emitDeliveryEvent: () => {} });
    const listed = (await request(appFor(q)).get('/api/reminders')).body;
    expect(listed).toHaveLength(1);

    const del = await request(appFor(q)).delete(`/api/reminders/${listed[0].id}`);
    expect(del.body).toMatchObject({ ok: true });
    expect((await request(appFor(q)).get('/api/reminders')).body).toEqual([]);
  });
});
