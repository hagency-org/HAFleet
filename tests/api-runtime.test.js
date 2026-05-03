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

function readDeliveryEvents(runtimeDir) {
  const filePath = path.join(runtimeDir, 'data', 'message-delivery-events.jsonl');
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

  test('runtime reports persist backend-derived observation provenance', async () => {
    context = await createBackendTestContext('agent-chat-runtime-provenance-test-', {
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
      agentRuntime: {
        alpha: {
          observation: {
            observerSource: 'legacy-source',
            observerServer: 'legacy-host',
            observedAt: 'not-a-number',
          },
        },
      },
      groups: {},
    });

    const before = Date.now();
    const response = await request(context.app)
      .post('/api/agents/alpha/runtime')
      .send({
        blocked: false,
        reason: null,
        tail: '',
        command: 'codex',
        server: ' relay-west ',
        activeNow: true,
        observation: {
          observerSource: 'client-forged',
          observerServer: 'evil-host',
          observedAt: 1,
        },
        observerSource: 'client-forged-top-level',
        observerServer: 'evil-host',
      });

    expect(response.status).toBe(200);
    expect(response.body.runtime.observation).toMatchObject({
      observerSource: 'runtime-api',
      observerServer: 'relay-west',
    });
    expect(response.body.runtime.observation.observedAt).toBeGreaterThanOrEqual(before);

    const runtime = readJson(path.join(context.runtimeDir, 'data', 'agent_runtime.json'));
    expect(runtime.alpha.observation).toEqual(response.body.runtime.observation);
    expect(runtime.alpha.observation.observerSource).not.toBe('client-forged');
    expect(runtime.alpha.observation.observerServer).not.toBe('evil-host');

    const agent = await request(context.app).get('/api/agents/alpha').expect(200);
    expect(agent.body.runtimeObservation).toEqual(response.body.runtime.observation);
  });

  test('remote runtime reports keep API_TOKEN compatibility and do not accept server token yet', async () => {
    context = await createBackendTestContext('agent-chat-runtime-auth-test-', {
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
      env: {
        API_TOKEN: 'operator-token',
        AGENTCHAT_SERVER_TOKEN: 'server-token',
      },
    });

    const payload = {
      blocked: false,
      command: 'codex',
      server: 'relay-west',
    };

    const missingBearer = await request(context.app)
      .post('/api/agents/alpha/runtime')
      .set('X-Forwarded-For', '203.0.113.10')
      .send(payload);
    const serverBearer = await request(context.app)
      .post('/api/agents/alpha/runtime')
      .set('X-Forwarded-For', '203.0.113.10')
      .set('Authorization', 'Bearer server-token')
      .send(payload);
    const operatorBearer = await request(context.app)
      .post('/api/agents/alpha/runtime')
      .set('X-Forwarded-For', '203.0.113.10')
      .set('Authorization', 'Bearer operator-token')
      .send(payload);

    expect(missingBearer.status).toBe(401);
    expect(missingBearer.body).toEqual({ error: 'unauthorized' });
    expect(serverBearer.status).toBe(401);
    expect(operatorBearer.status).toBe(200);
  });

  test('runtime reports preserve unknown activity instead of reporting idle', async () => {
    context = await createBackendTestContext('agent-chat-runtime-unknown-activity-test-', {
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

    const response = await request(context.app)
      .post('/api/agents/alpha/runtime')
      .send({
        blocked: false,
        reason: null,
        tail: '',
        command: 'codex',
        server: 'relay-west',
        activeNow: null,
        activeDurationSec: 0,
        idleDurationSec: 0,
        lastTmuxActivitySec: null,
      });

    expect(response.status).toBe(200);
    expect(response.body.runtime.activeNow).toBeNull();
    expect(response.body.runtime.activeDurationSec).toBe(0);
    expect(response.body.runtime.idleDurationSec).toBe(0);

    const runtime = readJson(path.join(context.runtimeDir, 'data', 'agent_runtime.json'));
    expect(runtime.alpha.activeNow).toBeNull();

    const agent = await request(context.app).get('/api/agents/alpha').expect(200);
    expect(agent.body.activeNow).toBeNull();
  });

  test('push-delivered ignores stale queue acknowledgements', async () => {
    context = await createBackendTestContext('agent-chat-runtime-push-delivered-test-', {
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
      messages: [
        {
          id: 'msg_older',
          ts: 800,
          from: 'system',
          to: 'alpha',
          group: null,
          type: 'inform',
          summary: 'older notification source',
          full: 'older notification source',
          mentions: [],
          reply_to: null,
          source: 'system',
        },
        {
          id: 'msg_old',
          ts: 900,
          from: 'system',
          to: 'alpha',
          group: null,
          type: 'inform',
          summary: 'old notification source',
          full: 'old notification source',
          mentions: [],
          reply_to: null,
          source: 'system',
        },
      ],
      agentRuntime: {
        alpha: {
          lastPushNotifyAt: 2000,
          lastPushQueuedAt: 1900,
          lastPushQueueEntryId: 9,
          lastPushDeliveredAt: 2000,
          lastPushDeliveryDelayMs: 100,
          lastActionablePushAt: 2000,
          lastPushKind: 'single_actionable',
          lastPushNeedsInboxCheck: true,
          lastPushUnreadCount: 1,
          lastPushSourceMsgId: 'msg_new',
          inboxGate: {
            requiresInboxCheck: true,
            sourceMsgId: 'msg_new',
            raisedAt: 2000,
            reason: 'actionable_notification',
          },
          lastSeen: 2000,
          updatedAt: 2000,
        },
      },
      groups: {},
    });

    const response = await request(context.app)
      .post('/api/runtime/push-delivered')
      .send({
        agent: 'alpha',
        deliveredAt: 1000,
        queuedAt: 900,
        queueEntryId: 8,
        notifyMeta: {
          kind: 'single_actionable',
          requiresInboxCheck: true,
          sourceMsgId: 'msg_old',
          messageIds: ['msg_older', 'msg_old'],
          unreadCount: 1,
        },
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      agent: 'alpha',
      ignored: 'stale-push-delivered',
    });

    const runtime = readJson(path.join(context.runtimeDir, 'data', 'agent_runtime.json'));
    expect(runtime.alpha.lastPushQueueEntryId).toBe(9);
    expect(runtime.alpha.lastPushDeliveredAt).toBe(2000);
    expect(runtime.alpha.lastPushSourceMsgId).toBe('msg_new');
    expect(runtime.alpha.lastActionablePushAt).toBe(2000);
    expect(runtime.alpha.inboxGate).toMatchObject({
      requiresInboxCheck: true,
      sourceMsgId: 'msg_new',
      raisedAt: 2000,
      reason: 'actionable_notification',
    });

    const rows = readDeliveryEvents(context.runtimeDir);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'push.delivered_ack',
        agent: 'alpha',
        messageId: 'msg_old',
        messageIds: ['msg_older', 'msg_old'],
        queueEntryId: 8,
        result: 'ignored',
        reason: 'stale-push-delivered',
      }),
    ]));

    const query = await request(context.app)
      .get('/api/messages/msg_old/delivery?agent=alpha')
      .expect(200);
    expect(query.body.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'push.delivered_ack',
        messageId: 'msg_old',
        agent: 'alpha',
      }),
    ]));

    const olderQuery = await request(context.app)
      .get('/api/messages/msg_older/delivery?agent=alpha')
      .expect(200);
    expect(olderQuery.body.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'push.delivered_ack',
        messageIds: ['msg_older', 'msg_old'],
        agent: 'alpha',
      }),
    ]));
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

  test('stale remote heartbeat marks server and agents offline', async () => {
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
    // emitSystemInfo for server_offline removed in 5.43 (lid-close spam)
  });

  test('codex agent reports mcpPresent=null and does not trigger mcp_missing', async () => {
    context = await createBackendTestContext('agent-chat-mcp-type-test-', {
      agents: {
        codexbot: {
          name: 'codexbot',
          type: 'codex',
          kind: 'agent',
          online: true,
          manualDown: false,
          tmux: 'codexbot:0.0',
        },
      },
    });

    // Report mcpPresent=false from push-relay (codex has no MCP process)
    for (let i = 0; i < 8; i++) {
      await request(context.app).post('/api/agents/codexbot/runtime').send({
        blocked: false,
        reason: null,
        tail: '',
        command: 'codex',
        mcpPresent: false,
      });
    }

    const runtime = readJson(path.join(context.runtimeDir, 'data', 'agent_runtime.json'));
    expect(runtime.codexbot.mcpPresent).toBeNull();

    const agent = (await request(context.app).get('/api/agents/codexbot').expect(200)).body;
    expect(agent.offlineReason).not.toBe('mcp-missing:auto');

    const events = readSystemInfoSummaries(context.runtimeDir);
    const mcpMissing = events.filter(s => s.includes('missing MCP'));
    expect(mcpMissing).toHaveLength(0);
  });
});
