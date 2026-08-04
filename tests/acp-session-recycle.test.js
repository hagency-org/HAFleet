import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';

// codex-acp-agent went permanently deaf. One turn ended with stopReason null and an
// unfinished tool call; the next delivery, ten hours later, timed out after the full
// 600s. Every subsequent nudge would have done the same, because nothing replaced
// the session — the host logged "delivery failed" and carried on holding a dead
// transport. A manual restart fixed it instantly, which is the diagnosis: the
// session was dead, not the agent.
//
// Idle time is NOT the trigger. Verified by driving the same agent after 3h42m idle
// on a resumed session: it answered in 10s.

const host = readFileSync('scripts/hafleet-acp-agent.mjs', 'utf-8');

describe('a session that stops answering is replaced', () => {
  test('a timed-out delivery triggers a recycle', () => {
    expect(host).toMatch(/if \(\/timed out\/\.test\(error\.message \|\| ''\)\) await recycleSession\(\);/);
  });

  test('the recycle resumes from the stored id rather than starting blank', () => {
    // Rebuilding the transport should not also throw away the conversation.
    const fn = host.slice(host.indexOf('async function recycleSession()'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toMatch(/resumeSessionId: recallSessionId\(\)/);
    expect(body).toMatch(/rememberSessionId\(resumed\)/);
  });

  test('it stops the old session before opening a new one', () => {
    const fn = host.slice(host.indexOf('async function recycleSession()'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body.indexOf('runtime.stop(name)')).toBeLessThan(body.indexOf('runtime.startSession'));
  });

  test('recycling is bounded and escalates to a host restart', () => {
    // Retrying forever would leave a dead agent reporting itself alive. The
    // supervisor restart is the heavier hammer that is known to work.
    expect(host).toMatch(/MAX_CONSECUTIVE_RECYCLES = 3/);
    const fn = host.slice(host.indexOf('async function recycleSession()'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toMatch(/process\.exit\(1\)/);
    expect(body).toMatch(/supervisor restarts this host/);
  });

  test('the bound counts CONSECUTIVE failures, not lifetime ones', () => {
    // As a lifetime total, three unrelated timeouts days apart would kill the agent.
    expect(host).toMatch(/consecutiveRecycles = 0;/);
    const reset = host.indexOf('consecutiveRecycles = 0;', host.indexOf('turn finished'));
    expect(reset, 'the counter is never reset after a successful turn').toBeGreaterThan(-1);
  });

  test('a stop that throws does not prevent the reopen', () => {
    // The old session is already broken; failing to close it tidily is not a reason
    // to leave the agent without a working one.
    const fn = host.slice(host.indexOf('async function recycleSession()'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    const stopBlock = body.slice(body.indexOf('runtime.stop(name)'));
    expect(stopBlock).toMatch(/catch \(error\)/);
    expect(stopBlock).toMatch(/continuing/);
  });

  test('a null stopReason is reported rather than logged as a clean finish', () => {
    // It was the state the session was in immediately before it wedged, printed
    // indistinguishably from a normal end_turn.
    expect(host).toMatch(/stopReason was null — the turn did not end cleanly/);
  });

  test('the failure log serializes error.data instead of stringifying an object', () => {
    // `${error.data}` printed "[object Object]" here, the same bug already fixed in
    // the session-open path and missed in this one.
    const failure = host.slice(host.indexOf('delivery failed:') - 400, host.indexOf('delivery failed:') + 200);
    expect(failure).toMatch(/JSON\.stringify\(error\.data\)/);
    expect(host).not.toMatch(/delivery failed: \$\{error\.message\}\$\{error\.data \? ` — \$\{error\.data\}`/);
  });
});
