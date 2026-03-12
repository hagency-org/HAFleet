import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { pathToFileURL } from 'url';

describe('bridge matrix behavior', () => {
  let runtimeDir;
  let MatrixBridge;
  let generateAvatarPngForTest;
  let resetBridgeMatrixTestHooks;
  let setBridgeMatrixTestHooks;

  beforeAll(async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'agent-chat-bridge-test-'));
    process.env.AGENT_CHAT_RUNTIME_DIR = runtimeDir;
    const bridgeUrl = pathToFileURL(path.resolve('bridge-matrix.js')).href;
    ({
      MatrixBridge,
      generateAvatarPngForTest,
      resetBridgeMatrixTestHooks,
      setBridgeMatrixTestHooks,
    } = await import(`${bridgeUrl}?test=${Date.now()}-${Math.random().toString(36).slice(2, 10)}`));
  });

  afterAll(() => {
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  afterEach(() => {
    resetBridgeMatrixTestHooks();
    vi.unstubAllGlobals();
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
