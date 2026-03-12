import { afterEach, describe, expect, test, vi } from 'vitest';
import { NotificationRouter } from '../lib/notification-router.js';

describe('NotificationRouter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('cooldown: accept, reject within window, accept after window', () => {
    vi.useFakeTimers();
    const dispatched = [];
    const router = new NotificationRouter({
      test: { cooldownMs: 1000, sinks: ['out'] },
    }, {
      out: (_f, p) => dispatched.push(p),
    });
    expect(router.emit('test', { n: 1 })).toMatchObject({ accepted: true, reason: 'dispatched' });
    expect(router.emit('test', { n: 2 })).toMatchObject({ accepted: false, reason: 'cooldown' });
    vi.advanceTimersByTime(1001);
    expect(router.emit('test', { n: 3 })).toMatchObject({ accepted: true, reason: 'dispatched' });
    expect(dispatched).toHaveLength(2);
    router.destroy();
  });

  test('aggregation: events buffered and flushed as summary', () => {
    vi.useFakeTimers();
    const flushed = [];
    const router = new NotificationRouter({
      agg: {
        cooldownMs: 0,
        aggregateWindowMs: 500,
        aggregateFn: (buf) => ({ items: [...buf.values()] }),
        sinks: ['out'],
      },
    }, {
      out: (_f, p) => flushed.push(p),
    });
    router.emit('agg', { a: 1 }, { dedupeKey: 'k1' });
    router.emit('agg', { a: 2 }, { dedupeKey: 'k2' });
    expect(flushed).toHaveLength(0);
    vi.advanceTimersByTime(501);
    expect(flushed).toHaveLength(1);
    expect(flushed[0].items).toHaveLength(2);
    router.destroy();
  });

  test('circuit breaker: failures open circuit, rejects until cooldown', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const router = new NotificationRouter({
      cb: {
        cooldownMs: 0,
        circuitBreaker: { threshold: 2, cooldownMs: 500 },
        sinks: ['fail'],
      },
    }, {
      fail: () => {
        callCount++;
        return Promise.reject(new Error('fail'));
      },
    });
    router.emit('cb', { n: 1 });
    await vi.advanceTimersByTimeAsync(1);
    router.emit('cb', { n: 2 });
    await vi.advanceTimersByTimeAsync(1);
    // After 2 failures, circuit should be open
    const r = router.emit('cb', { n: 3 });
    expect(r).toMatchObject({ accepted: false, reason: 'circuit_open' });
    // Advance past cooldown
    vi.advanceTimersByTime(501);
    const r2 = router.emit('cb', { n: 4 });
    expect(r2.accepted).toBe(true);
    router.destroy();
  });

  test('burst cap: forced flush when maxBurst reached', () => {
    vi.useFakeTimers();
    const flushed = [];
    const router = new NotificationRouter({
      burst: {
        cooldownMs: 0,
        aggregateWindowMs: 60000,
        maxBurst: 3,
        aggregateFn: (buf) => ({ count: buf.size }),
        sinks: ['out'],
      },
    }, {
      out: (_f, p) => flushed.push(p),
    });
    router.emit('burst', { n: 1 }, { dedupeKey: 'k' });
    router.emit('burst', { n: 2 }, { dedupeKey: 'k' });
    expect(flushed).toHaveLength(0);
    router.emit('burst', { n: 3 }, { dedupeKey: 'k' }); // hits maxBurst
    expect(flushed).toHaveLength(1);
    router.destroy();
  });

  test('persisted cooldown: read/write hooks called', () => {
    const store = {};
    const router = new NotificationRouter({
      pc: {
        cooldownMs: 5000,
        persistedCooldown: {
          read: (k) => store[k] || 0,
          write: (k, ts) => { store[k] = ts; },
        },
        sinks: ['out'],
      },
    }, { out: () => {} });
    const r1 = router.emit('pc', {}, { dedupeKey: 'agent1' });
    expect(r1.accepted).toBe(true);
    expect(store.agent1).toBeGreaterThan(0);
    const r2 = router.emit('pc', {}, { dedupeKey: 'agent1' });
    expect(r2).toMatchObject({ accepted: false, reason: 'persisted_cooldown' });
    router.destroy();
  });

  test('clearAgent: removes state for the specified agent', () => {
    const router = new NotificationRouter({
      test: { cooldownMs: 60000, sinks: ['out'] },
    }, { out: () => {} });
    router.emit('test', {}, { dedupeKey: 'agentA:foo' });
    expect(router.emit('test', {}, { dedupeKey: 'agentA:foo' }).accepted).toBe(false);
    router.clearAgent('agentA');
    expect(router.emit('test', {}, { dedupeKey: 'agentA:foo' }).accepted).toBe(true);
    router.destroy();
  });

  test('dedupeKeyFn: different keys get independent cooldowns', () => {
    const router = new NotificationRouter({
      dk: {
        cooldownMs: 60000,
        dedupeKeyFn: (p) => p.key,
        sinks: ['out'],
      },
    }, { out: () => {} });
    expect(router.emit('dk', { key: 'a' }).accepted).toBe(true);
    expect(router.emit('dk', { key: 'b' }).accepted).toBe(true);
    expect(router.emit('dk', { key: 'a' }).accepted).toBe(false);
    expect(router.emit('dk', { key: 'b' }).accepted).toBe(false);
    router.destroy();
  });

  test('unknown family returns rejected', () => {
    const router = new NotificationRouter({}, {});
    expect(router.emit('nope', {})).toMatchObject({ accepted: false, reason: 'unknown_family' });
    router.destroy();
  });

  test('flush is no-op for non-aggregate family', () => {
    const router = new NotificationRouter({
      simple: { cooldownMs: 0, sinks: ['out'] },
    }, { out: () => {} });
    expect(() => router.flush('simple')).not.toThrow();
    router.destroy();
  });

  test('destroy flushes pending aggregation', () => {
    vi.useFakeTimers();
    const flushed = [];
    const router = new NotificationRouter({
      agg: {
        cooldownMs: 0,
        aggregateWindowMs: 60000,
        aggregateFn: (buf) => ({ count: buf.size }),
        sinks: ['out'],
      },
    }, { out: (_f, p) => flushed.push(p) });
    router.emit('agg', { n: 1 }, { dedupeKey: 'k1' });
    expect(flushed).toHaveLength(0);
    router.destroy();
    expect(flushed).toHaveLength(1);
    expect(flushed[0].count).toBe(1);
  });
});
