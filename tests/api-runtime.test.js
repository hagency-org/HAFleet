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
      "Agent state summary: 1 blocked: alpha (soft)",
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
      "Agent state summary: 1 blocked: alpha (soft)",
    ]);

    const hardFirst = await request(context.app).post('/api/agents/alpha/runtime').send({
      blocked: true,
      reason: 'update-required',
      tail: 'update available: run agent-update',
      command: 'codex',
    });
    expect(hardFirst.status).toBe(200);
    expect(readSystemInfoSummaries(context.runtimeDir)).toEqual([
      "Agent state summary: 1 blocked: alpha (soft)",
    ]);

    const hardSecond = await request(context.app).post('/api/agents/alpha/runtime').send({
      blocked: true,
      reason: 'update-required',
      tail: 'update available: run agent-update',
      command: 'codex',
    });
    expect(hardSecond.status).toBe(200);
    expect(readSystemInfoSummaries(context.runtimeDir)).toEqual([
      "Agent state summary: 1 blocked: alpha (soft)",
      "Agent state summary: 1 blocked: alpha (hard)",
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
      "Agent state summary: 1 blocked: alpha (soft)",
      "Agent state summary: 1 blocked: alpha (hard)",
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
      "Agent state summary: 1 blocked: alpha (hard)",
      "Agent state summary: 1 recovered: alpha",
    ]);
  });

  test('blocked notifications observe a per-agent cooldown across episodes', async () => {
    context = await createBackendTestContext('agent-chat-runtime-test-', {
      env: {
        AGENT_BLOCKED_NOTIFICATION_COOLDOWN_MS: '1000',
      },
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

    for (let i = 0; i < 2; i += 1) {
      const response = await request(context.app).post('/api/agents/alpha/runtime').send({
        blocked: true,
        reason: 'update-required',
        tail: 'update available',
        command: 'codex',
      });
      expect(response.status).toBe(200);
    }

    const runtimeAfterFirstNotification = readJson(path.join(context.runtimeDir, 'data', 'agent_runtime.json'));
    const firstNotificationTs = runtimeAfterFirstNotification.alpha.lastBlockedNotificationTs;
    expect(firstNotificationTs).toBeGreaterThan(0);

    const recovery = await request(context.app)
      .post('/api/agents/alpha/runtime')
      .send({
        blocked: false,
        reason: null,
        tail: '',
        command: 'codex',
      });
    expect(recovery.status).toBe(200);

    for (let i = 0; i < 2; i += 1) {
      const response = await request(context.app).post('/api/agents/alpha/runtime').send({
        blocked: true,
        reason: 'update-required',
        tail: 'update available',
        command: 'codex',
      });
      expect(response.status).toBe(200);
    }

    const runtimeDuringCooldown = readJson(path.join(context.runtimeDir, 'data', 'agent_runtime.json'));
    expect(runtimeDuringCooldown.alpha.blocked).toBe(true);
    expect(runtimeDuringCooldown.alpha.blockedNotificationSent).toBe(false);
    expect(runtimeDuringCooldown.alpha.lastBlockedNotificationTs).toBe(firstNotificationTs);
    expect(readSystemInfoSummaries(context.runtimeDir)).toEqual([
      "Agent state summary: 1 blocked: alpha (hard)",
      "Agent state summary: 1 recovered: alpha",
    ]);

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const postCooldown = await request(context.app).post('/api/agents/alpha/runtime').send({
      blocked: true,
      reason: 'update-required',
      tail: 'update available',
      command: 'codex',
    });
    expect(postCooldown.status).toBe(200);

    const runtimeAfterCooldown = readJson(path.join(context.runtimeDir, 'data', 'agent_runtime.json'));
    expect(runtimeAfterCooldown.alpha.blockedNotificationSent).toBe(true);
    expect(runtimeAfterCooldown.alpha.lastBlockedNotificationTs).toBeGreaterThan(firstNotificationTs);
    expect(readSystemInfoSummaries(context.runtimeDir)).toEqual([
      "Agent state summary: 1 blocked: alpha (hard)",
      "Agent state summary: 1 recovered: alpha",
      "Agent state summary: 1 blocked: alpha (hard)",
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

  test('blocked human target snapshot updates after human message delivery and inbox read', async () => {
    context = await createBackendTestContext('agent-chat-runtime-test-', {
      env: {
        AGENT_BLOCKED_NOTIFICATION_COOLDOWN_MS: '0',
      },
      agents: {
        alpha: {
          name: 'alpha',
          type: 'agent',
          kind: 'agent',
          online: true,
          manualDown: false,
          tmux: 'alpha:0.0',
        },
        humanop: {
          name: 'humanop',
          type: 'human',
          kind: 'human',
          online: true,
          manualDown: false,
        },
      },
      groups: {},
    });

    const humanMessage = await request(context.app)
      .post('/api/messages')
      .send({
        from: 'humanop',
        to: 'alpha',
        type: 'human',
        source: 'matrix',
        summary: 'Need status',
        full: 'Need status',
      });
    expect(humanMessage.status).toBe(200);

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

    let events = readSystemInfoEvents(context.runtimeDir);
    expect(events).toHaveLength(1);
    expect(events[0].full).toContain('Pending human messages: yes');
    expect(events[0].full).toContain('Target humans: humanop');

    const inboxRead = await request(context.app).get('/api/inbox/alpha');
    expect(inboxRead.status).toBe(200);

    await request(context.app).post('/api/agents/alpha/runtime').send({
      blocked: false,
      reason: null,
      tail: '',
      command: 'codex',
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

    events = readSystemInfoEvents(context.runtimeDir);
    expect(events).toHaveLength(3);
    expect(events[2].full).toContain('Pending human messages: no');
    expect(events[2].full).toContain('Target humans: none');
  });

  test('stale remote heartbeat emits a system info disconnect alert and marks agents offline', async () => {
    const staleHeartbeatAt = Date.now() - 120_000;
    context = await createBackendTestContext('agent-chat-runtime-test-', {
      agents: {
        alpha: {
          name: 'alpha',
          type: 'agent',
          kind: 'agent',
          server: 'relay-west',
          online: true,
          manualDown: false,
          tmux: 'alpha:0.0',
        },
      },
      groups: {},
      servers: {
        'relay-west': {
          id: 'relay-west',
          online: true,
          heartbeatAt: staleHeartbeatAt,
          lastSeen: staleHeartbeatAt,
          updatedAt: staleHeartbeatAt,
          sessions: ['alpha'],
          agents: ['alpha'],
          agentCount: 1,
        },
      },
    });

    const response = await request(context.app).get('/health');
    expect(response.status).toBe(200);

    const serversAfter = readJson(path.join(context.runtimeDir, 'data', 'servers.json'));
    const agentsAfter = readJson(path.join(context.runtimeDir, 'data', 'agents.json'));
    const events = readSystemInfoEvents(context.runtimeDir);

    expect(serversAfter['relay-west'].online).toBe(false);
    expect(serversAfter['relay-west'].sessions).toEqual([]);
    expect(serversAfter['relay-west'].agents).toEqual([]);
    expect(serversAfter['relay-west'].agentCount).toBe(0);
    expect(agentsAfter.alpha.online).toBe(false);
    expect(agentsAfter.alpha.offlineReason).toBe('server-offline:relay-west');
    expect(events.map((event) => event.summary)).toContain("Remote server 'relay-west' offline");
    expect(events.find((event) => event.summary === "Remote server 'relay-west' offline")?.full || '')
      .toContain('heartbeat timed out');
  });
});
