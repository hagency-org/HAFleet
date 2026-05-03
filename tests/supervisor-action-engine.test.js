import { afterEach, describe, expect, test } from 'vitest';
import { createSupervisorActionEngine } from '../lib/supervisor-action-engine.js';

const savedEnv = new Map();

function rememberEnv(key) {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
}

function restoreEnv() {
  for (const [key, value] of savedEnv.entries()) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
}

function buildSnapshot(overrides = {}) {
  return {
    negative: true,
    confidence: 0.9,
    consecutiveNegative: 1,
    state: 'stuck',
    reason: 'blocked',
    lastNudgeAt: null,
    lastEscalationAt: null,
    ...overrides,
  };
}

describe('supervisor action engine persistence ordering', () => {
  afterEach(() => {
    restoreEnv();
  });

  test('does not send nudge side effects when nudge bookkeeping fails', () => {
    rememberEnv('SUPERVISOR_WARN_AFTER');
    rememberEnv('SUPERVISOR_ESCALATE_AFTER');
    process.env.SUPERVISOR_WARN_AFTER = '1';
    process.env.SUPERVISOR_ESCALATE_AFTER = '99';
    const sent = [];
    const sse = [];
    const alerts = [];
    const engine = createSupervisorActionEngine({
      snapshotStore: {
        recordNudge() {
          const error = new Error('supervisor snapshot persistence failed');
          error.code = 'snapshot_persistence_failed';
          throw error;
        },
      },
      sendMessage: message => sent.push(message),
      broadcastSSE: (event, payload) => sse.push({ event, payload }),
      alertStore: { ingest: alert => alerts.push(alert) },
    });

    const result = engine.evaluateAction('alpha', buildSnapshot());

    expect(result).toEqual({ nudged: false, escalated: false });
    expect(sent).toEqual([]);
    expect(sse).toEqual([]);
    expect(alerts).toEqual([]);
  });

  test('does not send escalation side effects when escalation bookkeeping fails', () => {
    rememberEnv('SUPERVISOR_WARN_AFTER');
    rememberEnv('SUPERVISOR_ESCALATE_AFTER');
    process.env.SUPERVISOR_WARN_AFTER = '99';
    process.env.SUPERVISOR_ESCALATE_AFTER = '1';
    const sent = [];
    const sse = [];
    const alerts = [];
    const engine = createSupervisorActionEngine({
      snapshotStore: {
        recordEscalation() {
          const error = new Error('supervisor snapshot persistence failed');
          error.code = 'snapshot_persistence_failed';
          throw error;
        },
      },
      sendMessage: message => sent.push(message),
      broadcastSSE: (event, payload) => sse.push({ event, payload }),
      alertStore: { ingest: alert => alerts.push(alert) },
    });

    const result = engine.evaluateAction('alpha', buildSnapshot());

    expect(result).toEqual({ nudged: false, escalated: false });
    expect(sent).toEqual([]);
    expect(sse).toEqual([]);
    expect(alerts).toEqual([]);
  });
});
