import { describe, expect, test } from 'vitest';
import { createSupervisorSnapshotStore } from '../lib/supervisor-snapshot-store.js';

function buildSnapshot(overrides = {}) {
  return {
    state: 'focused',
    confidence: 0.9,
    reason: 'working',
    suggested_action: 'none',
    domain: 'core',
    pattern: null,
    supervisor: 'supervisor-alpha',
    assessed_at: '2026-05-03T00:00:00.000Z',
    assessed_at_ms: 1,
    consecutiveNegative: 0,
    classification: 'active',
    lifecycleState: 'idle',
    negative: false,
    lastEventId: 'event_1',
    lastWarningAt: null,
    lastNudgeAt: null,
    lastNudgeCount: 0,
    lastEscalationAt: null,
    lastEscalationCount: 0,
    ...overrides,
  };
}

function buildEvent(overrides = {}) {
  return {
    id: 'event_1',
    ts: 1,
    agent: 'alpha',
    sweepAt: '2026-05-03T00:00:00.000Z',
    status: 'FOCUSED',
    domain: 'core',
    reason: 'working',
    pattern: null,
    suggestion: 'none',
    negative: false,
    state: { consecutiveNegative: 0 },
    supervisor: { classification: 'active', lifecycleState: 'idle' },
    llm: null,
    action: null,
    ...overrides,
  };
}

describe('supervisor snapshot store persistence failures', () => {
  test('updateAssessment fails closed without creating target or event', () => {
    const store = createSupervisorSnapshotStore({
      initialData: {},
      save: () => false,
    });

    expect(() => store.updateAssessment('alpha', 'supervisor-alpha', {
      state: 'focused',
      confidence: 0.9,
      reason: 'on task',
      suggested_action: 'none',
      domain: 'core',
    })).toThrow(/supervisor snapshot persistence failed/);
    expect(store.getTarget('alpha')).toBe(null);
    expect(store.getEvents('alpha')).toEqual([]);
  });

  test('failed update over existing snapshot leaves prior state unchanged', () => {
    const store = createSupervisorSnapshotStore({
      initialData: {
        targets: { alpha: buildSnapshot() },
        events: [buildEvent()],
      },
      save: () => false,
    });

    expect(() => store.updateAssessment('alpha', 'supervisor-alpha', {
      state: 'stuck',
      confidence: 0.95,
      reason: 'blocked',
      suggested_action: 'nudge',
    })).toThrow(/supervisor snapshot persistence failed/);
    expect(store.getTarget('alpha')).toMatchObject({ state: 'focused', consecutiveNegative: 0 });
    expect(store.getEvents('alpha').map(event => event.id)).toEqual(['event_1']);
  });

  test('failed recordNudge rolls back nudge bookkeeping', () => {
    const store = createSupervisorSnapshotStore({
      initialData: { targets: { alpha: buildSnapshot() } },
      save: () => false,
    });

    expect(() => store.recordNudge('alpha')).toThrow(/supervisor snapshot persistence failed/);
    expect(store.getTarget('alpha')).toMatchObject({
      lastNudgeAt: null,
      lastNudgeCount: 0,
      lastWarningAt: null,
    });
  });

  test('failed recordEscalation rolls back escalation bookkeeping', () => {
    const store = createSupervisorSnapshotStore({
      initialData: { targets: { alpha: buildSnapshot() } },
      save: () => false,
    });

    expect(() => store.recordEscalation('alpha')).toThrow(/supervisor snapshot persistence failed/);
    expect(store.getTarget('alpha')).toMatchObject({
      lastEscalationAt: null,
      lastEscalationCount: 0,
    });
  });

  test('failed setEnabled leaves control state unchanged', () => {
    const store = createSupervisorSnapshotStore({
      initialData: { config: { enabled: true } },
      save: () => false,
    });

    expect(() => store.setEnabled(false)).toThrow(/supervisor snapshot persistence failed/);
    expect(store.getControl().enabled).toBe(true);
    expect(store.getControl().disabledReason).toBe(null);
  });

  test('failed removeTarget leaves target and events unchanged', () => {
    const store = createSupervisorSnapshotStore({
      initialData: {
        targets: { alpha: buildSnapshot() },
        events: [buildEvent()],
      },
      save: () => false,
    });

    expect(() => store.removeTarget('alpha')).toThrow(/supervisor snapshot persistence failed/);
    expect(store.getTarget('alpha')).not.toBe(null);
    expect(store.getEvents('alpha').map(event => event.id)).toEqual(['event_1']);
  });
});
