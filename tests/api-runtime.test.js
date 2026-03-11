import { afterEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function readSystemInfoSummaries(runtimeDir) {
  const filePath = path.join(runtimeDir, 'data', 'system-info.jsonl');
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line).summary);
}

describe('backend runtime API', () => {
  let context = null;

  afterEach(() => {
    context?.cleanup();
    context = null;
  });

  test('blocked notifications require two consecutive observed scans', async () => {
    context = await createBackendTestContext('agent-chat-runtime-test-', {
      agents: {
        alpha: {
          name: 'alpha',
          type: 'agent',
          kind: 'agent',
          online: true,
          manualDown: false,
          tmux: 'alpha:0.0',
        },
      },
      groups: {},
    });

    const first = await request(context.app)
      .post('/api/agents/alpha/runtime')
      .send({
        blocked: true,
        reason: 'plan-mode',
        tail: '1. Plan mode',
        command: 'claude',
      });
    expect(first.status).toBe(200);

    const runtimeAfterFirst = readJson(path.join(context.runtimeDir, 'data', 'agent_runtime.json'));
    expect(runtimeAfterFirst.alpha.blocked).toBe(true);
    expect(runtimeAfterFirst.alpha.blockedConsecutiveScans).toBe(1);
    expect(runtimeAfterFirst.alpha.blockedNotificationSent).toBe(false);
    expect(readSystemInfoSummaries(context.runtimeDir)).toEqual([]);

    const second = await request(context.app)
      .post('/api/agents/alpha/runtime')
      .send({
        blocked: true,
        reason: 'plan-mode',
        tail: '1. Plan mode',
        command: 'claude',
      });
    expect(second.status).toBe(200);

    const runtimeAfterSecond = readJson(path.join(context.runtimeDir, 'data', 'agent_runtime.json'));
    expect(runtimeAfterSecond.alpha.blockedConsecutiveScans).toBe(2);
    expect(runtimeAfterSecond.alpha.blockedNotificationSent).toBe(true);
    expect(readSystemInfoSummaries(context.runtimeDir)).toEqual([
      "Agent 'alpha' entered blocked state",
    ]);
  });

  test('blocked recovery resets debounce state after a notified block', async () => {
    context = await createBackendTestContext('agent-chat-runtime-test-', {
      agents: {
        alpha: {
          name: 'alpha',
          type: 'agent',
          kind: 'agent',
          online: true,
          manualDown: false,
          tmux: 'alpha:0.0',
        },
      },
      groups: {},
    });

    await request(context.app).post('/api/agents/alpha/runtime').send({
      blocked: true,
      reason: 'approval-mode-toggle',
      tail: 'bypass permissions on (shift+tab to cycle)',
      command: 'codex',
    });
    await request(context.app).post('/api/agents/alpha/runtime').send({
      blocked: true,
      reason: 'approval-mode-toggle',
      tail: 'bypass permissions on (shift+tab to cycle)',
      command: 'codex',
    });

    const recovery = await request(context.app)
      .post('/api/agents/alpha/runtime')
      .send({
        blocked: false,
        reason: null,
        tail: '',
        command: 'codex',
      });
    expect(recovery.status).toBe(200);

    const runtimeAfterRecovery = readJson(path.join(context.runtimeDir, 'data', 'agent_runtime.json'));
    expect(runtimeAfterRecovery.alpha.blocked).toBe(false);
    expect(runtimeAfterRecovery.alpha.blockedConsecutiveScans).toBe(0);
    expect(runtimeAfterRecovery.alpha.blockedNotificationSent).toBe(false);
    expect(readSystemInfoSummaries(context.runtimeDir)).toEqual([
      "Agent 'alpha' entered blocked state",
      "Agent 'alpha' recovered from blocked state",
    ]);
  });
});
