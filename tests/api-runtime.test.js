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

function readSystemInfoEvents(runtimeDir) {
  const filePath = path.join(runtimeDir, 'data', 'system-info.jsonl');
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

describe('backend runtime API', () => {
  let context = null;

  afterEach(() => {
    context?.cleanup();
    context = null;
  });

  test('blocked notifications use tiered debounce and never notify transient blockers', async () => {
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

    for (let i = 0; i < 4; i += 1) {
      const response = await request(context.app)
        .post('/api/agents/alpha/runtime')
        .send({
          blocked: true,
          reason: 'plan-mode',
          tail: '1. Plan mode',
          command: 'claude',
        });
      expect(response.status).toBe(200);
    }

    const runtimeAfterTransient = readJson(path.join(context.runtimeDir, 'data', 'agent_runtime.json'));
    expect(runtimeAfterTransient.alpha.blocked).toBe(true);
    expect(runtimeAfterTransient.alpha.blockedTier).toBe(0);
    expect(runtimeAfterTransient.alpha.blockedConsecutiveScans).toBe(4);
    expect(runtimeAfterTransient.alpha.blockedNotificationSent).toBe(false);
    expect(readSystemInfoSummaries(context.runtimeDir)).toEqual([]);

    for (let i = 0; i < 5; i += 1) {
      const response = await request(context.app)
        .post('/api/agents/alpha/runtime')
        .send({
          blocked: true,
          reason: 'interactive-confirm',
          tail: 'Press enter to continue',
          command: 'claude',
        });
      expect(response.status).toBe(200);
    }

    const runtimeAfterSoftFive = readJson(path.join(context.runtimeDir, 'data', 'agent_runtime.json'));
    expect(runtimeAfterSoftFive.alpha.blockedTier).toBe(1);
    expect(runtimeAfterSoftFive.alpha.blockedConsecutiveScans).toBe(5);
    expect(runtimeAfterSoftFive.alpha.blockedNotificationSent).toBe(false);
    expect(readSystemInfoSummaries(context.runtimeDir)).toEqual([]);

    const sixth = await request(context.app)
      .post('/api/agents/alpha/runtime')
      .send({
        blocked: true,
        reason: 'interactive-confirm',
        tail: 'Press enter to continue',
        command: 'claude',
      });
    expect(sixth.status).toBe(200);

    const runtimeAfterSoftSix = readJson(path.join(context.runtimeDir, 'data', 'agent_runtime.json'));
    expect(runtimeAfterSoftSix.alpha.blockedTier).toBe(1);
    expect(runtimeAfterSoftSix.alpha.blockedConsecutiveScans).toBe(6);
    expect(runtimeAfterSoftSix.alpha.blockedNotificationSent).toBe(true);
    expect(runtimeAfterSoftSix.alpha.blockedNotifiedTier).toBe(1);
    expect(readSystemInfoSummaries(context.runtimeDir)).toEqual([
      "Agent 'alpha' entered blocked state",
    ]);
  });

  test('severity rebroadcast only happens when blocked tier increases', async () => {
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

    for (let i = 0; i < 6; i += 1) {
      const response = await request(context.app).post('/api/agents/alpha/runtime').send({
        blocked: true,
        reason: 'interactive-confirm',
        tail: 'choose an option',
        command: 'codex',
      });
      expect(response.status).toBe(200);
    }

    expect(readSystemInfoSummaries(context.runtimeDir)).toEqual([
      "Agent 'alpha' entered blocked state",
    ]);

    const hardFirst = await request(context.app).post('/api/agents/alpha/runtime').send({
      blocked: true,
      reason: 'update-required',
      tail: 'update available: run agent-update',
      command: 'codex',
    });
    expect(hardFirst.status).toBe(200);
    expect(readSystemInfoSummaries(context.runtimeDir)).toEqual([
      "Agent 'alpha' entered blocked state",
    ]);

    const hardSecond = await request(context.app).post('/api/agents/alpha/runtime').send({
      blocked: true,
      reason: 'update-required',
      tail: 'update available: run agent-update',
      command: 'codex',
    });
    expect(hardSecond.status).toBe(200);
    expect(readSystemInfoSummaries(context.runtimeDir)).toEqual([
      "Agent 'alpha' entered blocked state",
      "Agent 'alpha' entered blocked state",
    ]);

    const sameTierFirst = await request(context.app).post('/api/agents/alpha/runtime').send({
      blocked: true,
      reason: 'hard-custom',
      tail: 'custom hard blocker',
      command: 'codex',
    });
    expect(sameTierFirst.status).toBe(200);
    const sameTierSecond = await request(context.app).post('/api/agents/alpha/runtime').send({
      blocked: true,
      reason: 'hard-custom',
      tail: 'custom hard blocker',
      command: 'codex',
    });
    expect(sameTierSecond.status).toBe(200);

    const runtimeAfterHard = readJson(path.join(context.runtimeDir, 'data', 'agent_runtime.json'));
    expect(runtimeAfterHard.alpha.blockedTier).toBe(2);
    expect(runtimeAfterHard.alpha.blockedNotifiedTier).toBe(2);
    expect(readSystemInfoSummaries(context.runtimeDir)).toEqual([
      "Agent 'alpha' entered blocked state",
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
      reason: 'update-required',
      tail: 'update available: run agent-update',
      command: 'codex',
    });
    await request(context.app).post('/api/agents/alpha/runtime').send({
      blocked: true,
      reason: 'update-required',
      tail: 'update available: run agent-update',
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
    expect(runtimeAfterRecovery.alpha.blockedTier).toBe(null);
    expect(runtimeAfterRecovery.alpha.blockedConsecutiveScans).toBe(0);
    expect(runtimeAfterRecovery.alpha.blockedNotificationSent).toBe(false);
    expect(runtimeAfterRecovery.alpha.blockedNotifiedTier).toBe(null);
    expect(readSystemInfoSummaries(context.runtimeDir)).toEqual([
      "Agent 'alpha' entered blocked state",
      "Agent 'alpha' recovered from blocked state",
    ]);
  });

  test('blocked system info only targets humans with unread pending messages', async () => {
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
      messages: [
        {
          id: 'msg_old',
          ts: 1000,
          from: 'human-old',
          to: 'alpha',
          type: 'human',
          summary: 'Old question',
        },
      ],
      cursors: {
        alpha: {
          inbox: 1000,
          inboxId: 'msg_old',
          groups: {},
          groupIds: {},
        },
      },
    });

    await request(context.app).post('/api/agents/alpha/runtime').send({
      blocked: true,
      reason: 'update-required',
      tail: 'update available: run agent-update',
      command: 'codex',
    });
    await request(context.app).post('/api/agents/alpha/runtime').send({
      blocked: true,
      reason: 'update-required',
      tail: 'update available: run agent-update',
      command: 'codex',
    });

    const events = readSystemInfoEvents(context.runtimeDir);
    expect(events).toHaveLength(1);
    expect(events[0].full).toContain('Pending human messages: no');
    expect(events[0].full).toContain('Target humans: none');
  });
});
