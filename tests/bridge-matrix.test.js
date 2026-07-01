import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { pathToFileURL } from 'url';
import { restoreEnv, snapshotEnv } from './helpers/env.js';

describe('bridge matrix behavior', () => {
  let runtimeDir;
  let MatrixBridge;
  let buildMessageUrlForTest;
  let generateAvatarPngForTest;
  let resetBridgeMatrixTestHooks;
  let resolveMessageBaseUrlForTest;
  let setBridgeMatrixTestHooks;
  let envSnapshot;

  beforeAll(async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'agent-chat-bridge-test-'));
    envSnapshot = snapshotEnv(['AGENT_CHAT_RUNTIME_DIR', 'MATRIX_IGNORED_SENDER_MXIDS']);
    process.env.AGENT_CHAT_RUNTIME_DIR = runtimeDir;
    process.env.MATRIX_IGNORED_SENDER_MXIDS = '@octosbot:matrix.example.test';
    const bridgeUrl = pathToFileURL(path.resolve('bridge-matrix.js')).href;
    ({
      MatrixBridge,
      buildMessageUrlForTest,
      generateAvatarPngForTest,
      resetBridgeMatrixTestHooks,
      resolveMessageBaseUrlForTest,
      setBridgeMatrixTestHooks,
    } = await import(`${bridgeUrl}?test=${Date.now()}-${Math.random().toString(36).slice(2, 10)}`));
  });

  afterAll(() => {
    rmSync(runtimeDir, { recursive: true, force: true });
    restoreEnv(envSnapshot);
  });

  afterEach(() => {
    resetBridgeMatrixTestHooks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test('submitHumanMessage retries once on timeout before surfacing delivery failure', async () => {
    const bridge = new MatrixBridge();
    const timeoutError = new Error('The operation was aborted due to timeout');
    timeoutError.name = 'TimeoutError';

    bridge.callBackendApi = vi.fn()
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce({ ok: true, id: 'msg_1' });
    bridge.handleMessageDeliveryFeedback = vi.fn().mockResolvedValue(undefined);
    bridge.sendDeliveryNotice = vi.fn().mockResolvedValue(undefined);
    bridge.sleep = vi.fn().mockResolvedValue(undefined);

    const result = await bridge.submitHumanMessage('!room:test', { from: 'alice' });

    expect(result).toEqual({ ok: true, id: 'msg_1' });
    expect(bridge.callBackendApi).toHaveBeenCalledTimes(2);
    expect(bridge.sleep).toHaveBeenCalledTimes(1);
    expect(bridge.sendDeliveryNotice).not.toHaveBeenCalled();
    expect(bridge.handleMessageDeliveryFeedback).toHaveBeenCalledWith('!room:test', { ok: true, id: 'msg_1' });
  });

  test('submitHumanMessage reports a retry failure only after the second timeout', async () => {
    const bridge = new MatrixBridge();
    const timeoutError = new Error('The operation was aborted due to timeout');
    timeoutError.name = 'TimeoutError';

    bridge.callBackendApi = vi.fn()
      .mockRejectedValueOnce(timeoutError)
      .mockRejectedValueOnce(timeoutError);
    bridge.handleMessageDeliveryFeedback = vi.fn().mockResolvedValue(undefined);
    bridge.sendDeliveryNotice = vi.fn().mockResolvedValue(undefined);
    bridge.sleep = vi.fn().mockResolvedValue(undefined);

    const result = await bridge.submitHumanMessage('!room:test', { from: 'alice' });

    expect(result).toEqual({ error: 'timeout' });
    expect(bridge.callBackendApi).toHaveBeenCalledTimes(2);
    expect(bridge.sleep).toHaveBeenCalledTimes(1);
    expect(bridge.sendDeliveryNotice).toHaveBeenCalledWith(
      '!room:test',
      '⚠️ Message delivery failed after retry (timeout).'
    );
  });

  test('onAgentRecovered sends an all-clear to the same rooms that received blocked alerts', async () => {
    const bridge = new MatrixBridge();
    bridge.sendDeliveryNotice = vi.fn().mockResolvedValue(undefined);

    await bridge.onAgentBlocked({
      agent: 'alpha',
      reason: 'plan-mode',
      targets: [
        { roomId: '!room:test', human: 'alice', pending: true },
      ],
    });
    await bridge.onAgentRecovered({ agent: 'alpha' });

    expect(bridge.sendDeliveryNotice).toHaveBeenNthCalledWith(
      1,
      '!room:test',
      '⚠️ Agent @alpha appears blocked (plan-mode). It may not process messages until manually handled. There are still unread human messages pending for this agent.'
    );
    expect(bridge.sendDeliveryNotice).toHaveBeenNthCalledWith(
      2,
      '!room:test',
      '✅ Agent @alpha recovered from blocked state.'
    );
  });

  test('onRoomMessage skips forwarding messages prefixed with [AGENTIGNORE]', async () => {
    const bridge = new MatrixBridge();
    bridge.submitHumanMessage = vi.fn().mockResolvedValue({ ok: true });
    bridge.botClient = {
      getJoinedRoomMembers: vi.fn().mockResolvedValue(['@agent-bridge:matrix.example.test']),
    };

    await bridge.onRoomMessage('!room:test', {
      event_id: '$event-1',
      sender: '@alice:matrix.example.test',
      content: {
        msgtype: 'm.text',
        body: '[AGENTIGNORE] private coordination note',
      },
    });

    expect(bridge.submitHumanMessage).not.toHaveBeenCalled();
  });

  test('onRoomMessage skips configured external Matrix bot senders', async () => {
    const bridge = new MatrixBridge();
    const roomId = '!octos-sender-room:matrix.example.test';
    bridge.botUserId = '@agent-bridge:matrix.example.test';
    bridge.getBridgeState().roomGroupMap[roomId] = 'software-factory';
    bridge.botClient = {
      getJoinedRoomMembers: vi.fn().mockResolvedValue([
        '@agent-bridge:matrix.example.test',
        '@alice:matrix.example.test',
        '@octosbot:matrix.example.test',
      ]),
    };
    bridge.submitHumanMessage = vi.fn().mockResolvedValue({ ok: true });

    try {
      await bridge.onRoomMessage(roomId, {
        event_id: '$octos-sender-1',
        sender: '@octosbot:matrix.example.test',
        content: {
          msgtype: 'm.text',
          body: 'Octos status update',
        },
      });

      expect(bridge.submitHumanMessage).not.toHaveBeenCalled();
    } finally {
      delete bridge.getBridgeState().roomGroupMap[roomId];
    }
  });

  test('onRoomMessage ignores non-agent Matrix bot mentions in group routing', async () => {
    const bridge = new MatrixBridge();
    const roomId = '!octos-room:matrix.example.test';
    bridge.botUserId = '@agent-bridge:matrix.example.test';
    bridge.addKnownAgent('wf_coordinator');
    bridge.getBridgeState().roomGroupMap[roomId] = 'software-factory';
    bridge.botClient = {
      getJoinedRoomMembers: vi.fn().mockResolvedValue([
        '@agent-bridge:matrix.example.test',
        '@alice:matrix.example.test',
        '@octosbot:matrix.example.test',
      ]),
    };
    bridge.submitHumanMessage = vi.fn().mockResolvedValue({ ok: true, id: 'msg_1' });

    try {
      await bridge.onRoomMessage(roomId, {
        event_id: '$octos-mention-1',
        sender: '@alice:matrix.example.test',
        content: {
          msgtype: 'm.text',
          body: 'wf_coordinator 和 octosbot 在吗',
          'm.mentions': {
            user_ids: [
              '@ac_wf_coordinator:matrix.example.test',
              '@octosbot:matrix.example.test',
            ],
          },
        },
      });

      expect(bridge.submitHumanMessage).toHaveBeenCalledTimes(1);
      expect(bridge.submitHumanMessage.mock.calls[0][1]).toMatchObject({
        group: 'software-factory',
        mentions: ['wf_coordinator'],
      });
      expect(bridge.submitHumanMessage.mock.calls[0][1].mentions).not.toContain('octosbot');
    } finally {
      delete bridge.getBridgeState().roomGroupMap[roomId];
    }
  });

  test('pollRegistrations fetches agent names via view=names and provisions new tokens', async () => {
    const bridge = new MatrixBridge();
    bridge.callBackendApi = vi.fn().mockResolvedValue(['alpha', 'beta']);
    bridge.ensureAgentToken = vi.fn().mockResolvedValue('token');
    bridge.discoverAndGreetHumans = vi.fn().mockResolvedValue(undefined);

    await bridge.pollRegistrations();

    expect(bridge.callBackendApi).toHaveBeenCalledWith('GET', '/api/agents?view=names');
    expect(bridge.ensureAgentToken).toHaveBeenCalledTimes(2);
    expect(bridge.ensureAgentToken).toHaveBeenNthCalledWith(1, 'alpha', 'registration_poll');
    expect(bridge.ensureAgentToken).toHaveBeenNthCalledWith(2, 'beta', 'registration_poll');
    expect(bridge.isKnownAgentName('alpha')).toBe(true);
    expect(bridge.isKnownAgentName('beta')).toBe(true);
  });

  test('formatted message links derive from the public dashboard URL', () => {
    expect(resolveMessageBaseUrlForTest({
      AGENT_CHAT_WEB_URL: 'https://agentchat.example.test/',
      MSG_BASE_URL: 'https://legacy.example.test/msg',
    })).toBe('https://agentchat.example.test/msg');
    expect(resolveMessageBaseUrlForTest({
      AGENT_CHAT_WEB_URL: 'https://agentchat.example.test/msg/',
    })).toBe('https://agentchat.example.test/msg');
    expect(resolveMessageBaseUrlForTest({
      MSG_BASE_URL: 'https://legacy.example.test/msg/',
    })).toBe('https://legacy.example.test/msg');
    expect(resolveMessageBaseUrlForTest({
      AGENT_CHAT_WEB_PORT: '18184',
    })).toBe('http://127.0.0.1:18184/msg');
    expect(buildMessageUrlForTest('msg_1', 'token value', 'https://agentchat.example.test/msg'))
      .toBe('https://agentchat.example.test/msg/msg_1?view=token%20value');
  });

  test('discoverAndGreetHumans greets configured seed users when user directory is empty', async () => {
    const seedRuntimeDir = mkdtempSync(path.join(os.tmpdir(), 'agent-chat-bridge-greet-seed-'));
    const seedEnv = snapshotEnv([
      'AGENT_CHAT_RUNTIME_DIR',
      'MATRIX_BOT_USERNAME',
      'MATRIX_GREETING_MXIDS',
      'MATRIX_SERVER_NAME',
    ]);

    try {
      process.env.AGENT_CHAT_RUNTIME_DIR = seedRuntimeDir;
      process.env.MATRIX_BOT_USERNAME = 'agent-bridge';
      process.env.MATRIX_GREETING_MXIDS = '@kamico:matrix.example.test,alice';
      process.env.MATRIX_SERVER_NAME = 'matrix.example.test';
      const bridgeUrl = pathToFileURL(path.resolve('bridge-matrix.js')).href;
      const { MatrixBridge: SeedBridge } = await import(`${bridgeUrl}?test=greet-seed-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
      const bridge = new SeedBridge();
      bridge.ensureBotDmRoom = vi.fn().mockResolvedValue('!dm:test');
      bridge.botClient = {
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue({ results: [], limited: false }),
      }));

      await bridge.discoverAndGreetHumans();

      expect(bridge.ensureBotDmRoom).toHaveBeenNthCalledWith(1, 'kamico', '@kamico:matrix.example.test');
      expect(bridge.ensureBotDmRoom).toHaveBeenNthCalledWith(2, 'alice', '@alice:matrix.example.test');
      expect(bridge.botClient.sendMessage).toHaveBeenCalledTimes(2);
    } finally {
      restoreEnv(seedEnv);
      rmSync(seedRuntimeDir, { recursive: true, force: true });
    }
  });

  test('discoverAndGreetHumans keeps seeded greetings independent of directory failures', async () => {
    const seedRuntimeDir = mkdtempSync(path.join(os.tmpdir(), 'agent-chat-bridge-greet-failure-'));
    const seedEnv = snapshotEnv([
      'AGENT_CHAT_RUNTIME_DIR',
      'MATRIX_GREETING_MXIDS',
      'MATRIX_SERVER_NAME',
    ]);

    try {
      process.env.AGENT_CHAT_RUNTIME_DIR = seedRuntimeDir;
      process.env.MATRIX_GREETING_MXIDS = 'alice';
      process.env.MATRIX_SERVER_NAME = 'matrix.example.test';
      const bridgeUrl = pathToFileURL(path.resolve('bridge-matrix.js')).href;
      const { MatrixBridge: SeedBridge } = await import(`${bridgeUrl}?test=greet-failure-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
      const bridge = new SeedBridge();
      bridge.ensureBotDmRoom = vi.fn().mockResolvedValue('!dm:test');
      bridge.botClient = {
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('directory down')));

      await bridge.discoverAndGreetHumans();

      expect(bridge.ensureBotDmRoom).toHaveBeenCalledWith('alice', '@alice:matrix.example.test');
      expect(bridge.botClient.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      restoreEnv(seedEnv);
      rmSync(seedRuntimeDir, { recursive: true, force: true });
    }
  });

  test('discoverAndGreetHumans deduplicates seeds and skips non-human accounts', async () => {
    const seedRuntimeDir = mkdtempSync(path.join(os.tmpdir(), 'agent-chat-bridge-greet-dedupe-'));
    const seedEnv = snapshotEnv([
      'AGENT_CHAT_RUNTIME_DIR',
      'MATRIX_AGENT_PREFIX',
      'MATRIX_BOT_USERNAME',
      'MATRIX_GREETING_MXIDS',
      'MATRIX_SERVER_NAME',
    ]);

    try {
      process.env.AGENT_CHAT_RUNTIME_DIR = seedRuntimeDir;
      process.env.MATRIX_AGENT_PREFIX = 'ac_';
      process.env.MATRIX_BOT_USERNAME = 'agent-bridge';
      process.env.MATRIX_GREETING_MXIDS = [
        '@kamico:matrix.example.test',
        'kamico',
        '@agent-bridge:matrix.example.test',
        '@ac_alpha:matrix.example.test',
        '_system',
        'conduit',
      ].join(',');
      process.env.MATRIX_SERVER_NAME = 'matrix.example.test';
      const bridgeUrl = pathToFileURL(path.resolve('bridge-matrix.js')).href;
      const { MatrixBridge: SeedBridge } = await import(`${bridgeUrl}?test=greet-dedupe-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
      const bridge = new SeedBridge();
      bridge.ensureBotDmRoom = vi.fn().mockResolvedValue('!dm:test');
      bridge.botClient = {
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue({
          results: [
            { user_id: '@kamico:matrix.example.test' },
            { user_id: '@bob:matrix.example.test' },
          ],
          limited: false,
        }),
      }));

      await bridge.discoverAndGreetHumans();

      expect(bridge.ensureBotDmRoom).toHaveBeenCalledTimes(2);
      expect(bridge.ensureBotDmRoom).toHaveBeenNthCalledWith(1, 'kamico', '@kamico:matrix.example.test');
      expect(bridge.ensureBotDmRoom).toHaveBeenNthCalledWith(2, 'bob', '@bob:matrix.example.test');
      expect(bridge.botClient.sendMessage).toHaveBeenCalledTimes(2);
    } finally {
      restoreEnv(seedEnv);
      rmSync(seedRuntimeDir, { recursive: true, force: true });
    }
  });

  test('callBackendApi rejects non-2xx backend responses with HTTP status details', async () => {
    const bridge = new MatrixBridge();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue('{"error":"boom"}'),
    }));

    await expect(bridge.callBackendApi('GET', '/api/agents')).rejects.toThrow(
      'backend API GET /api/agents failed with HTTP 500 body={"error":"boom"}'
    );
  });

  test('postWarning deduplicates the same warning family within the window', async () => {
    const bridge = new MatrixBridge();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue('null'),
    }));

    bridge.postWarning('Failed to reconcile room !a:test ↔ group "g1": timeout', { kind: 'reconcile', scope: '!a:test:g1' });
    bridge.postWarning('Failed to reconcile room !a:test ↔ group "g1": timeout', { kind: 'reconcile', scope: '!a:test:g1' });
    bridge.postWarning('Failed to reconcile room !a:test ↔ group "g1": timeout', { kind: 'reconcile', scope: '!a:test:g1' });

    // Only the first call should go through — same dedupe key
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('postWarning allows different warning families through', async () => {
    const bridge = new MatrixBridge();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue('null'),
    }));

    bridge.postWarning('Failed for room A', { kind: 'reconcile', scope: '!a:test' });
    bridge.postWarning('Failed for room B', { kind: 'reconcile', scope: '!b:test' });

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('postWarning circuit breaker stops calls after consecutive failures', async () => {
    const bridge = new MatrixBridge();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    // Trigger 3 failures (each with unique scope to bypass dedupe)
    bridge.postWarning('err1', { kind: 'a', scope: '1' });
    bridge.postWarning('err2', { kind: 'a', scope: '2' });
    bridge.postWarning('err3', { kind: 'a', scope: '3' });

    // Wait for async rejections to settle
    await new Promise(r => setTimeout(r, 50));

    // Circuit should be open — 4th call should be suppressed
    bridge.postWarning('err4', { kind: 'a', scope: '4' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  test('onSystemInfo filters info alerts and cools down warning alerts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-27T00:00:00.000Z'));
    const bridge = new MatrixBridge();
    bridge.groupRoomMap.info = '!info:test';
    bridge.botClient = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };

    await bridge.onSystemInfo({
      id: 'sys-info',
      summary: 'Agent alpha MCP process recovered',
      alertType: 'mcp_recovered',
      dedupeKey: 'mcp_missing:alpha',
    });
    expect(bridge.botClient.sendMessage).not.toHaveBeenCalled();

    await bridge.onSystemInfo({
      id: 'sys-warning-1',
      summary: "Agent 'alpha' missing MCP process",
      alertType: 'mcp_missing',
      dedupeKey: 'mcp_missing:alpha',
    });
    await bridge.onSystemInfo({
      id: 'sys-warning-2',
      summary: "Agent 'alpha' still missing MCP process",
      alertType: 'mcp_missing',
      dedupeKey: 'mcp_missing:alpha',
    });
    expect(bridge.botClient.sendMessage).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(300_001);
    await bridge.onSystemInfo({
      id: 'sys-warning-3',
      summary: "Agent 'alpha' missing MCP process again",
      alertType: 'mcp_missing',
      dedupeKey: 'mcp_missing:alpha',
    });
    await bridge.onSystemInfo({
      id: 'sys-critical',
      summary: 'Swap usage is high',
      alertType: 'swap_high',
      dedupeKey: 'swap_high',
    });

    expect(bridge.botClient.sendMessage).toHaveBeenCalledTimes(3);
    expect(bridge.botClient.sendMessage).toHaveBeenNthCalledWith(
      1,
      '!info:test',
      { msgtype: 'm.text', body: "ℹ️ Agent 'alpha' missing MCP process" }
    );
    expect(bridge.botClient.sendMessage).toHaveBeenNthCalledWith(
      3,
      '!info:test',
      { msgtype: 'm.text', body: 'ℹ️ Swap usage is high' }
    );
  });

  test('onSystemInfo does not commit warning cooldown when Matrix send fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-27T00:00:00.000Z'));
    const bridge = new MatrixBridge();
    bridge.groupRoomMap.info = '!info:test';
    bridge.botClient = {
      sendMessage: vi.fn()
        .mockRejectedValueOnce(new Error('network down'))
        .mockResolvedValueOnce(undefined),
    };

    await bridge.onSystemInfo({
      id: 'sys-warning-fail-1',
      summary: "Agent 'alpha' missing MCP process",
      alertType: 'mcp_missing',
      dedupeKey: 'mcp_missing:alpha',
    });
    await bridge.onSystemInfo({
      id: 'sys-warning-fail-2',
      summary: "Agent 'alpha' still missing MCP process",
      alertType: 'mcp_missing',
      dedupeKey: 'mcp_missing:alpha',
    });

    expect(bridge.botClient.sendMessage).toHaveBeenCalledTimes(2);
  });

  test('reconcileRoomGroupMembership skips when backend is unhealthy', async () => {
    const bridge = new MatrixBridge();
    bridge._backendHealthy = false;
    bridge.callBackendApi = vi.fn();

    await bridge.reconcileRoomGroupMembership('!room:test', 'test-group');

    expect(bridge.callBackendApi).not.toHaveBeenCalled();
  });

  test('reconcileRoomGroupMembership proceeds when backend is healthy', async () => {
    const bridge = new MatrixBridge();
    bridge._backendHealthy = true;
    bridge.botClient = {
      getJoinedRoomMembers: vi.fn().mockResolvedValue([]),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue('{"members":[]}'),
    }));

    await bridge.reconcileRoomGroupMembership('!room:test', 'test-group');

    // Should have called backend to get group info
    expect(fetch).toHaveBeenCalled();
  });

  test('avatar rendering falls back after a timed out icon convert', async () => {
    const execMock = vi.fn(async (_file, args, options) => {
      expect(options.timeout).toBe(10_000);
      if (args.includes('/tmp/icon.png[0]')) {
        const err = new Error('convert timed out');
        err.code = 'ETIMEDOUT';
        throw err;
      }
      return { stdout: Buffer.from('png-bytes'), stderr: Buffer.alloc(0) };
    });
    setBridgeMatrixTestHooks({ execFileAsync: execMock });

    const png = await generateAvatarPngForTest('alpha', { badge: 'DEV', iconPath: '/tmp/icon.png' });

    expect(Buffer.isBuffer(png)).toBe(true);
    expect(png.toString()).toBe('png-bytes');
    expect(execMock).toHaveBeenCalledTimes(2);
  });
});
