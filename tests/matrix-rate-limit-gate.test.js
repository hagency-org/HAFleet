import { describe, expect, test } from 'vitest';
import { MatrixRateLimitGate, createMatrixRateLimitGate } from '../src/matrix-rate-limit-gate.mjs';

// A manually-advanced clock keeps cooldown-expiry assertions deterministic without
// coupling this suite to vi.useFakeTimers() (bridge-matrix.test.js already relies on
// real timers/fake timers per-test; an independent clock avoids any interaction).
function makeClock(start = 1_000_000) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms) => { now += ms; };
  return clock;
}

function fakeResponse(status, body) {
  return {
    status,
    clone() { return this; },
    async json() { return body; },
  };
}

function matrixError({ statusCode = 429, errcode = 'M_LIMIT_EXCEEDED', retryAfterMs } = {}) {
  const error = new Error(`${errcode}: rate limited`);
  error.statusCode = statusCode;
  error.errcode = errcode;
  if (retryAfterMs !== undefined) error.retryAfterMs = retryAfterMs;
  return error;
}

describe('MatrixRateLimitGate', () => {
  test('factory creates a working gate instance', () => {
    const gate = createMatrixRateLimitGate();
    expect(gate).toBeInstanceOf(MatrixRateLimitGate);
    expect(gate.beforeRequest()).toBe(true);
  });

  test('starts without an active cooldown', () => {
    const gate = new MatrixRateLimitGate({ now: makeClock() });
    expect(gate.isCoolingDown()).toBe(false);
    expect(gate.beforeRequest()).toBe(true);
    expect(gate.cooldownRemainingMs()).toBe(0);
  });

  // Behavior 1: a 429 from ANY path updates the GLOBAL cooldown.
  test('a 429 response updates the global cooldown', async () => {
    const clock = makeClock();
    const gate = new MatrixRateLimitGate({ now: clock });

    const wasLimited = await gate.observeResponse(fakeResponse(429, { errcode: 'M_LIMIT_EXCEEDED' }));

    expect(wasLimited).toBe(true);
    expect(gate.isCoolingDown()).toBe(true);
    expect(gate.beforeRequest()).toBe(false);
  });

  test('a 429 seen on one "path" (request instance) blocks a completely independent caller', async () => {
    // Simulates two unrelated polling loops (e.g. agent-invite poll vs. room scan) sharing one gate.
    const clock = makeClock();
    const gate = new MatrixRateLimitGate({ now: clock });

    // Path A hits 429.
    await gate.observeResponse(fakeResponse(429, {}));

    // Path B, which never made a request itself, must also see the cooldown.
    expect(gate.beforeRequest()).toBe(false);
  });

  test('non-429 responses do not trigger a cooldown', async () => {
    const gate = new MatrixRateLimitGate({ now: makeClock() });

    expect(await gate.observeResponse(fakeResponse(200, {}))).toBe(false);
    expect(await gate.observeResponse(fakeResponse(500, {}))).toBe(false);
    expect(await gate.observeResponse(null)).toBe(false);
    expect(await gate.observeResponse(undefined)).toBe(false);
    expect(gate.isCoolingDown()).toBe(false);
    expect(gate.beforeRequest()).toBe(true);
  });

  // Behavior 2: retry_after_ms takes precedence over the default backoff.
  test('retry_after_ms from the response body sets the cooldown duration, not the default', async () => {
    const clock = makeClock();
    const gate = new MatrixRateLimitGate({ now: clock, defaultBackoffMs: 60_000, maxBackoffMs: 120_000 });

    await gate.observeResponse(fakeResponse(429, { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 5_000 }));

    // Just under the server-specified 5s → still cooling down.
    clock.advance(4_999);
    expect(gate.beforeRequest()).toBe(false);
    // Just past it → cooldown has cleared. If the 60s default had been used instead,
    // this would still be blocked.
    clock.advance(2);
    expect(gate.beforeRequest()).toBe(true);
  });

  test('falls back to the default backoff when no retry_after_ms is present', async () => {
    const clock = makeClock();
    const gate = new MatrixRateLimitGate({ now: clock, defaultBackoffMs: 60_000, maxBackoffMs: 120_000 });

    await gate.observeResponse(fakeResponse(429, {}));

    clock.advance(59_999);
    expect(gate.beforeRequest()).toBe(false);
    clock.advance(2);
    expect(gate.beforeRequest()).toBe(true);
  });

  test('retry_after_ms is capped at the configured maximum backoff', async () => {
    const clock = makeClock();
    const gate = new MatrixRateLimitGate({ now: clock, defaultBackoffMs: 60_000, maxBackoffMs: 120_000 });

    await gate.observeResponse(fakeResponse(429, { retry_after_ms: 999_999 }));

    clock.advance(120_000);
    expect(gate.beforeRequest()).toBe(true); // capped, not held for 999999ms
  });

  test('observeError recognizes a matrix-bot-sdk MatrixError-shaped rate-limit error', () => {
    const clock = makeClock();
    const gate = new MatrixRateLimitGate({ now: clock, defaultBackoffMs: 60_000 });

    const wasLimited = gate.observeError(matrixError({ retryAfterMs: 8_000 }));

    expect(wasLimited).toBe(true);
    expect(gate.beforeRequest()).toBe(false);
    clock.advance(8_001);
    expect(gate.beforeRequest()).toBe(true);
  });

  test('observeError recognizes a bare HTTP 429 statusCode without an errcode', () => {
    const gate = new MatrixRateLimitGate({ now: makeClock() });
    const error = new Error('rate limited');
    error.statusCode = 429;

    expect(gate.observeError(error)).toBe(true);
    expect(gate.beforeRequest()).toBe(false);
  });

  test('observeError ignores unrelated errors (network failure, 404, etc.)', () => {
    const gate = new MatrixRateLimitGate({ now: makeClock() });

    expect(gate.observeError(new Error('ECONNRESET'))).toBe(false);
    expect(gate.observeError(matrixError({ statusCode: 404, errcode: 'M_NOT_FOUND' }))).toBe(false);
    expect(gate.observeError(null)).toBe(false);
    expect(gate.observeError(undefined)).toBe(false);
    expect(gate.isCoolingDown()).toBe(false);
  });

  // Behavior 3: cooldown blocks OTHER polling paths from issuing requests.
  test('beforeRequest() blocks new requests for the full cooldown window, then reopens', async () => {
    const clock = makeClock();
    const gate = new MatrixRateLimitGate({ now: clock, defaultBackoffMs: 30_000 });

    expect(gate.beforeRequest()).toBe(true);
    await gate.observeResponse(fakeResponse(429, {}));
    expect(gate.beforeRequest()).toBe(false);

    clock.advance(15_000);
    expect(gate.beforeRequest()).toBe(false); // still mid-cooldown

    clock.advance(15_001);
    expect(gate.beforeRequest()).toBe(true); // cooldown window fully elapsed
  });

  // Behavior 4: a reconcile sweep aborts on first 429 instead of continuing across agents/rooms.
  test('a 429 mid-sweep is visible to the very next beforeRequest() check with no time elapsed', async () => {
    const clock = makeClock();
    const gate = new MatrixRateLimitGate({ now: clock });

    // Simulate a for-loop over rooms/agents that checks the gate before each item.
    const processed = [];
    const items = ['room-a', 'room-b', 'room-c'];
    for (const item of items) {
      if (!gate.beforeRequest()) break;
      processed.push(item);
      if (item === 'room-a') {
        // room-a's request comes back 429.
        await gate.observeResponse(fakeResponse(429, { retry_after_ms: 10_000 }));
      }
    }

    expect(processed).toEqual(['room-a']); // aborted before room-b/room-c, no clock advance needed
  });

  test('a 429 raised as a thrown matrix-bot-sdk error mid-sweep also aborts remaining iterations', () => {
    const gate = new MatrixRateLimitGate({ now: makeClock() });
    const processed = [];
    const items = ['agent-1', 'agent-2', 'agent-3'];

    for (const item of items) {
      if (!gate.beforeRequest()) break;
      processed.push(item);
      try {
        if (item === 'agent-1') throw matrixError({ retryAfterMs: 5_000 });
      } catch (error) {
        if (gate.observeError(error)) continue; // in real code: log + let the loop-top check abort
        throw error;
      }
    }

    expect(processed).toEqual(['agent-1']);
  });

  // Behavior 5: a successful request does NOT clear a still-valid cooldown.
  test('a success response observed mid-cooldown does not shorten or clear it', async () => {
    const clock = makeClock();
    const gate = new MatrixRateLimitGate({ now: clock, defaultBackoffMs: 60_000 });

    await gate.observeResponse(fakeResponse(429, {}));
    expect(gate.beforeRequest()).toBe(false);
    const remainingBefore = gate.cooldownRemainingMs();

    clock.advance(1_000);
    // Some other in-flight request (started before the cooldown) now resolves successfully.
    const wasLimited = await gate.observeResponse(fakeResponse(200, { ok: true }));

    expect(wasLimited).toBe(false);
    expect(gate.isCoolingDown()).toBe(true);
    expect(gate.beforeRequest()).toBe(false);
    // Remaining time only went down by the elapsed 1000ms — the success did not reset/clear it.
    expect(gate.cooldownRemainingMs()).toBe(remainingBefore - 1_000);
  });

  test('reset() clears an active cooldown (test/operator escape hatch)', async () => {
    const gate = new MatrixRateLimitGate({ now: makeClock() });
    await gate.observeResponse(fakeResponse(429, {}));
    expect(gate.beforeRequest()).toBe(false);

    gate.reset();

    expect(gate.beforeRequest()).toBe(true);
    expect(gate.isCoolingDown()).toBe(false);
  });

  test('a later, shorter retry_after_ms does not shrink an already-longer active cooldown', async () => {
    const clock = makeClock();
    const gate = new MatrixRateLimitGate({ now: clock });

    await gate.observeResponse(fakeResponse(429, { retry_after_ms: 60_000 }));
    clock.advance(1_000);
    // A second, independent path also gets 429'd, but with a shorter server-suggested wait.
    await gate.observeResponse(fakeResponse(429, { retry_after_ms: 2_000 }));

    // The longer of the two (59s remaining from the first) should still govern.
    clock.advance(3_000); // well past the second 2s hint, nowhere near the first 60s window
    expect(gate.beforeRequest()).toBe(false);
  });

  test('observeResponse tolerates a response with no usable JSON body', async () => {
    const gate = new MatrixRateLimitGate({ now: makeClock(), defaultBackoffMs: 42_000 });
    const brokenResponse = {
      status: 429,
      clone() { return this; },
      async json() { throw new Error('not json'); },
    };

    const wasLimited = await gate.observeResponse(brokenResponse);

    expect(wasLimited).toBe(true);
    expect(gate.cooldownRemainingMs()).toBe(42_000); // fell back to the default
  });
});
