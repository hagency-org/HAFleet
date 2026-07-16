import { describe, expect, test, vi } from 'vitest';
import {
  AgentAlreadyLeasedError,
  DispatchLeaseStore,
  LeaseExpiredError,
  LeaseNotFoundError,
  LeaseOwnerMismatchError,
} from '../src/dispatch-lease-store.mjs';

// A controllable clock: `now()` reads `value`; `now.advance(ms)` moves it forward. Lets these
// tests express TTL/expiry scenarios as exact arithmetic instead of real or fake-global time.
function clock(start = 1_000_000) {
  let value = start;
  const now = () => value;
  now.advance = (ms) => { value += ms; };
  return now;
}

describe('DispatchLeaseStore', () => {
  test('create() returns an owned lease with leaseId + expiresAt derived from ttlMs', () => {
    const now = clock();
    const store = new DispatchLeaseStore({ ttlMs: 60_000, now, idFactory: () => 'lease-1' });
    const lease = store.create({ agent: 'cod1', owner: 'dispatcher-a', taskId: 'task-1' });
    expect(lease).toMatchObject({
      leaseId: 'lease-1',
      agent: 'cod1',
      owner: 'dispatcher-a',
      taskId: 'task-1',
      ticket: null,
      createdAt: 1_000_000,
      heartbeatAt: 1_000_000,
      expiresAt: 1_060_000,
    });
    expect(store.isBusy('cod1')).toBe(true);
    expect(store.getByAgent('cod1')).toMatchObject({ leaseId: 'lease-1' });
  });

  test('create() auto-generates a taskId when the caller does not supply one', () => {
    const store = new DispatchLeaseStore({ now: clock() });
    const lease = store.create({ agent: 'cod1', owner: 'a' });
    expect(typeof lease.taskId).toBe('string');
    expect(lease.taskId.length).toBeGreaterThan(0);
  });

  test('create() rejects a second lease for an already-leased agent', () => {
    const store = new DispatchLeaseStore({ now: clock() });
    store.create({ agent: 'cod1', owner: 'a' });
    expect(() => store.create({ agent: 'cod1', owner: 'b' })).toThrow(AgentAlreadyLeasedError);
  });

  test('renew() extends expiresAt from the current time, not from createdAt', () => {
    const now = clock();
    const store = new DispatchLeaseStore({ ttlMs: 60_000, now });
    const created = store.create({ agent: 'cod1', owner: 'a' });
    now.advance(50_000); // still inside the original TTL window
    const renewed = store.renew({ leaseId: created.leaseId, agent: 'cod1', owner: 'a' });
    expect(renewed.expiresAt).toBe(1_000_000 + 50_000 + 60_000);
    expect(renewed.expiresAt).toBeGreaterThan(created.expiresAt);
    expect(renewed.heartbeatAt).toBe(1_000_000 + 50_000);
  });

  test('renew()/release() reject an owner mismatch, and leave the lease untouched', () => {
    const store = new DispatchLeaseStore({ now: clock() });
    const lease = store.create({ agent: 'cod1', owner: 'dispatcher-a' });
    expect(() => store.renew({ leaseId: lease.leaseId, agent: 'cod1', owner: 'dispatcher-b' }))
      .toThrow(LeaseOwnerMismatchError);
    expect(() => store.release({ leaseId: lease.leaseId, agent: 'cod1', owner: 'dispatcher-b' }))
      .toThrow(LeaseOwnerMismatchError);
    expect(store.isBusy('cod1')).toBe(true); // the mismatched attempts didn't release it
  });

  test('renew()/release() reject a stale (superseded) leaseId', () => {
    const store = new DispatchLeaseStore({ now: clock() });
    const first = store.create({ agent: 'cod1', owner: 'a' });
    store.release({ leaseId: first.leaseId, agent: 'cod1', owner: 'a' });
    store.create({ agent: 'cod1', owner: 'a' }); // agent re-leased under a brand new leaseId
    expect(() => store.renew({ leaseId: first.leaseId, agent: 'cod1', owner: 'a' }))
      .toThrow(LeaseNotFoundError);
    expect(() => store.release({ leaseId: first.leaseId, agent: 'cod1', owner: 'a' }))
      .toThrow(LeaseNotFoundError);
  });

  test('renew()/release() reject a lease past expiresAt even before reapExpired() runs', () => {
    const now = clock();
    const store = new DispatchLeaseStore({ ttlMs: 1000, now });
    const lease = store.create({ agent: 'cod1', owner: 'a' });
    now.advance(1001);
    expect(() => store.renew({ leaseId: lease.leaseId, agent: 'cod1', owner: 'a' }))
      .toThrow(LeaseExpiredError);
    expect(() => store.release({ leaseId: lease.leaseId, agent: 'cod1', owner: 'a' }))
      .toThrow(LeaseExpiredError);
  });

  test('reapExpired(): invalidates the lease before freeing the agent (ordering)', () => {
    const now = clock();
    const store = new DispatchLeaseStore({ ttlMs: 1000, now });
    const lease = store.create({ agent: 'cod1', owner: 'a' });
    now.advance(1001);
    const invalidateSpy = vi.spyOn(store, '_invalidate');
    const freeSpy = vi.spyOn(store, '_freeAgent');
    const reaped = store.reapExpired();
    expect(reaped).toHaveLength(1);
    expect(reaped[0].lease.leaseId).toBe(lease.leaseId);
    expect(invalidateSpy).toHaveBeenCalledWith(lease.leaseId);
    expect(freeSpy).toHaveBeenCalledWith('cod1');
    expect(invalidateSpy.mock.invocationCallOrder[0]).toBeLessThan(freeSpy.mock.invocationCallOrder[0]);
    expect(store.isBusy('cod1')).toBe(false);
  });

  test('reapExpired(): a lease kept alive by renewal is never reaped, regardless of createdAt age', () => {
    const now = clock();
    const store = new DispatchLeaseStore({ ttlMs: 1000, now });
    const lease = store.create({ agent: 'cod1', owner: 'a' });
    for (let i = 0; i < 5; i += 1) {
      now.advance(700); // < ttlMs on each hop, so the lease never lapses …
      store.renew({ leaseId: lease.leaseId, agent: 'cod1', owner: 'a' });
    }
    // … even though total elapsed time (3500ms) is far past the original ttlMs (1000ms).
    expect(store.reapExpired()).toHaveLength(0);
    expect(store.isBusy('cod1')).toBe(true);
  });

  test('reapExpired(): requeues a lease with a durable ticket exactly once, then fails it', () => {
    const now = clock();
    const store = new DispatchLeaseStore({ ttlMs: 1000, now });
    const first = store.create({
      agent: 'cod1', owner: 'a', ticket: 'durable-1', role: 'coding', tier: 'medium', task: 'A',
    });
    now.advance(1001);
    const [firstReap] = store.reapExpired();
    expect(firstReap.outcome).toBe('requeued');
    expect(firstReap.lease.leaseId).toBe(first.leaseId);
    expect(firstReap.context).toMatchObject({ role: 'coding', tier: 'medium', task: 'A' });

    const second = store.create({ agent: 'cod1', owner: 'a', ticket: 'durable-1', role: 'coding', tier: 'medium' });
    now.advance(1001);
    const [secondReap] = store.reapExpired();
    expect(secondReap.outcome).toBe('failed'); // same ticket — already used its one requeue
    expect(secondReap.lease.leaseId).toBe(second.leaseId);
  });

  test('reapExpired(): a lease with no ticket always fails (never silently requeued)', () => {
    const now = clock();
    const store = new DispatchLeaseStore({ ttlMs: 1000, now });
    store.create({ agent: 'cod1', owner: 'a' }); // no ticket
    now.advance(1001);
    const [reaped] = store.reapExpired();
    expect(reaped.outcome).toBe('failed');
  });

  test('releaseByAgent(): tolerant legacy release, no ownership check, idempotent', () => {
    const store = new DispatchLeaseStore({ now: clock() });
    store.create({ agent: 'cod1', owner: 'dispatcher-a' });
    expect(store.releaseByAgent('cod1')).toMatchObject({ agent: 'cod1', owner: 'dispatcher-a' });
    expect(store.isBusy('cod1')).toBe(false);
    expect(store.releaseByAgent('cod1')).toBeNull(); // matches old dispatchBusy.delete() no-op semantics
  });

  test('size reflects the number of live leases', () => {
    const store = new DispatchLeaseStore({ now: clock() });
    expect(store.size).toBe(0);
    const lease = store.create({ agent: 'cod1', owner: 'a' });
    expect(store.size).toBe(1);
    store.release({ leaseId: lease.leaseId, agent: 'cod1', owner: 'a' });
    expect(store.size).toBe(0);
  });
});
