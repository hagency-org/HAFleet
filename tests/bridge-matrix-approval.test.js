import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { restoreEnv, snapshotEnv } from './helpers/env.js';

describe('Matrix owner approval bridge', () => {
  let runtimeDir;
  let envSnapshot;
  let MatrixBridge;
  let buildOwnerApprovalRequest;
  let buildPublicApprovalNotice;
  let parseApprovalVerdictEvent;
  let approvalRoomPowerLevels;
  let isPrivateControlRoomName;
  let resolveApprovalDmMode;
  let markRoomTrusted;

  const approval = {
    id: 'approval_0123456789abcdef0123456789abcdef',
    agent: 'wf_coordinator',
    project: 'robrix2',
    project_room_id: '!project:palpo.test',
    owner_mxid: '@alex:palpo.test',
    owner_dm_room_id: '!approval-dm:palpo.test',
    upstream_request_id: 'abcde',
    input_digest: 'a'.repeat(64),
    runtime: 'claude',
    tool_name: 'Bash',
    description: 'Create a GitHub issue',
    input_preview: '{"command":"gh issue create --repo private/repo"}',
    expires_at: Date.now() + 60_000,
    status: 'pending',
  };

  beforeAll(async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'agent-chat-bridge-approval-'));
    envSnapshot = snapshotEnv(['AGENT_CHAT_RUNTIME_DIR', 'MATRIX_AGENT_PREFIX']);
    process.env.AGENT_CHAT_RUNTIME_DIR = runtimeDir;
    process.env.MATRIX_AGENT_PREFIX = 'ac_';
    const bridgeUrl = pathToFileURL(path.resolve('bridge-matrix.js')).href;
    ({
      MatrixBridge,
      buildOwnerApprovalRequest,
      buildPublicApprovalNotice,
      parseApprovalVerdictEvent,
      approvalRoomPowerLevels,
      isPrivateControlRoomName,
      resolveApprovalDmMode,
      markRoomTrusted,
    } = await import(`${bridgeUrl}?approval-test=${Date.now()}`));
  });

  afterAll(() => {
    rmSync(runtimeDir, { recursive: true, force: true });
    restoreEnv(envSnapshot);
  });

  test('public_approval_notice_is_redacted_and_non_actionable', () => {
    const content = buildPublicApprovalNotice(approval);
    const serialized = JSON.stringify(content);

    expect(content).toMatchObject({
      msgtype: 'com.agentchat.approval.status.v1',
      'com.agentchat.approval': {
        version: 1,
        kind: 'status',
        agent: 'wf_coordinator',
        project: 'robrix2',
        state: 'waiting_for_owner',
      },
    });
    expect(serialized).not.toContain('gh issue create');
    expect(serialized).not.toContain(approval.id);
    expect(serialized).not.toContain(approval.input_digest);
    expect(serialized).not.toContain('actions');
  });

  test('owner_dm_approval_request_contains_structured_actions', () => {
    const content = buildOwnerApprovalRequest(approval);

    expect(content.msgtype).toBe('com.agentchat.approval.request.v1');
    expect(content['com.agentchat.approval']).toMatchObject({
      agent: 'wf_coordinator',
      project: 'robrix2',
      project_room_id: '!project:palpo.test',
      request_id: approval.id,
      input_digest: approval.input_digest,
      actions: [
        { id: 'approve_once', style: 'primary' },
        { id: 'deny', style: 'danger' },
      ],
    });
    expect(content.body).toContain('Text replies are not approval');
  });

  test('approval_text_message_is_ignored', () => {
    expect(parseApprovalVerdictEvent('!approval-dm:palpo.test', {
      event_id: '$text',
      sender: '@alex:palpo.test',
      content: { msgtype: 'm.text', body: '批准创建' },
    })).toBeNull();
  });

  test('structured verdict preserves authenticated Matrix sender and binding fields', () => {
    const parsed = parseApprovalVerdictEvent('!approval-dm:palpo.test', {
      event_id: '$verdict',
      sender: '@alex:palpo.test',
      content: {
        msgtype: 'com.agentchat.approval.verdict.v1',
        body: 'Approval response submitted',
        'com.agentchat.approval': {
          version: 1,
          kind: 'verdict',
          agent: approval.agent,
          project: approval.project,
          project_room_id: approval.project_room_id,
          request_id: approval.id,
          input_digest: approval.input_digest,
          action: 'approve_once',
        },
      },
    });

    expect(parsed).toEqual({
      request_id: approval.id,
      sender_mxid: '@alex:palpo.test',
      room_id: '!approval-dm:palpo.test',
      agent: approval.agent,
      project: approval.project,
      project_room_id: approval.project_room_id,
      input_digest: approval.input_digest,
      action: 'approve_once',
      event_id: '$verdict',
    });
  });

  test('delayed_room_key_retries_encrypted_owner_verdict', async () => {
    const roomId = '!approval-delayed-key:palpo.test';
    const encrypted = {
      type: 'm.room.encrypted',
      event_id: '$encrypted-verdict',
      sender: approval.owner_mxid,
      origin_server_ts: Date.now(),
      content: {
        algorithm: 'm.megolm.v1.aes-sha2',
        ciphertext: 'ciphertext',
        session_id: 'session-id',
      },
    };
    const clearEvent = {
      ...encrypted,
      type: 'm.room.message',
      content: {
        msgtype: 'com.agentchat.approval.verdict.v1',
        body: 'Approval response submitted',
        'com.agentchat.approval': {
          version: 1,
          kind: 'verdict',
          agent: approval.agent,
          project: approval.project,
          project_room_id: approval.project_room_id,
          request_id: approval.id,
          input_digest: approval.input_digest,
          action: 'approve_once',
        },
      },
    };
    const records = new Map();
    const pendingEncryptedEventStore = {
      put: vi.fn(({ roomId: queuedRoomId, event }) => {
        records.set(event.event_id, {
          eventId: event.event_id,
          roomId: queuedRoomId,
          event,
          receivedAt: Date.now(),
        });
      }),
      list: vi.fn(() => [...records.values()]),
      remove: vi.fn((eventId) => records.delete(eventId)),
      prune: vi.fn(() => []),
    };
    const bridge = new MatrixBridge({ pendingEncryptedEventStore });
    markRoomTrusted(roomId, {
      approvalDm: true,
      agent: approval.agent,
      ownerMxid: approval.owner_mxid,
    });
    bridge.onRoomMessage = vi.fn().mockResolvedValue({ ok: true });
    const client = {
      emit: vi.fn(),
      crypto: {
        decryptRoomEvent: vi.fn()
          .mockRejectedValueOnce(new Error('missing room key'))
          .mockResolvedValueOnce({ raw: clearEvent }),
      },
    };
    bridge.configureReliableBotSync(client);

    await client.agentChatSyncHandler(
      'room.failed_decryption',
      roomId,
      encrypted,
      new Error('missing room key'),
    );
    expect(pendingEncryptedEventStore.put).toHaveBeenCalledWith({ roomId, event: encrypted });
    expect(bridge.onRoomMessage).not.toHaveBeenCalled();

    await bridge.retryPendingApprovalDecryptions(client);
    expect(bridge.onRoomMessage).not.toHaveBeenCalled();
    expect(pendingEncryptedEventStore.remove).not.toHaveBeenCalled();

    await bridge.retryPendingApprovalDecryptions(client);
    expect(bridge.onRoomMessage).toHaveBeenCalledOnce();
    expect(bridge.onRoomMessage).toHaveBeenCalledWith(roomId, clearEvent);
    expect(pendingEncryptedEventStore.remove).toHaveBeenCalledWith(encrypted.event_id);
    expect(records.size).toBe(0);
  });

  test('publishes encrypted private details before redacted public status', async () => {
    const bridge = new MatrixBridge();
    const order = [];
    bridge.callBackendApi = vi.fn().mockResolvedValue({ ok: true, approval });
    bridge.ensureApprovalDmEncrypted = vi.fn().mockImplementation(async () => { order.push('encrypted'); });
    bridge.botClient = {
      sendMessage: vi.fn().mockImplementation(async (_room, content) => {
        order.push('private');
        expect(content['com.agentchat.approval'].input_preview).toContain('gh issue create');
        return '$private';
      }),
    };
    bridge.getAgentToken = vi.fn().mockReturnValue('agent-token');
    bridge.sendAsAgentContent = vi.fn().mockImplementation(async (_token, _room, content) => {
      order.push('public');
      expect(JSON.stringify(content)).not.toContain('gh issue create');
      return '$public';
    });
    bridge.rememberMatrixEvent = vi.fn();

    const result = await bridge.onApprovalRequested({ request_id: approval.id });

    expect(result).toMatchObject({ ok: true, privateEventId: '$private', publicEventId: '$public' });
    expect(order).toEqual(['encrypted', 'private', 'public']);
  });

  test('plaintext approval diagnostics require explicit non-production opt-in', () => {
    expect(resolveApprovalDmMode({})).toBe('required');
    expect(() => resolveApprovalDmMode({
      AGENTCHAT_APPROVAL_DM_MODE: 'plaintext-test',
    })).toThrow('AGENTCHAT_ALLOW_PLAINTEXT_APPROVAL_TEST=1');
    expect(() => resolveApprovalDmMode({
      AGENTCHAT_APPROVAL_DM_MODE: 'plaintext-test',
      AGENTCHAT_ALLOW_PLAINTEXT_APPROVAL_TEST: '1',
      NODE_ENV: 'production',
    })).toThrow('forbidden in production');
    expect(resolveApprovalDmMode({
      AGENTCHAT_APPROVAL_DM_MODE: 'plaintext-test',
      AGENTCHAT_ALLOW_PLAINTEXT_APPROVAL_TEST: '1',
      NODE_ENV: 'test',
    })).toBe('plaintext-test');
  });

  test('plaintext approval diagnostic accepts only a room without encryption state', async () => {
    const bridge = new MatrixBridge({ approvalDmMode: 'plaintext-test' });
    bridge.botClient = {
      getRoomStateEvent: vi.fn().mockRejectedValue({
        errcode: 'M_NOT_FOUND',
        message: 'state event not found',
      }),
    };

    await expect(bridge.ensureApprovalDmSecurity('!plaintext-approval:palpo.test'))
      .resolves.toBe(true);

    bridge.botClient.getRoomStateEvent.mockResolvedValue({
      algorithm: 'm.megolm.v1.aes-sha2',
    });
    await expect(bridge.ensureApprovalDmSecurity('!encrypted-approval:palpo.test'))
      .rejects.toThrow('already encrypted');
  });

  test('plaintext approval diagnostic room name remains a private control room', () => {
    expect(isPrivateControlRoomName('Approval Test (UNENCRYPTED): wf_coordinator')).toBe(true);
    expect(isPrivateControlRoomName('Approval: wf_coordinator')).toBe(true);
    expect(isPrivateControlRoomName('robrix2-board')).toBe(false);
  });

  test('approval room cannot publish without E2EE support', async () => {
    const bridge = new MatrixBridge();
    bridge.botClient = {};
    await expect(bridge.ensureApprovalDmEncrypted('!approval-dm:palpo.test'))
      .rejects.toThrow('E2EE is unavailable');
  });

  test('approval room membership changes are bridge-only', async () => {
    const botUserId = '@agent-bridge:palpo.test';
    const powerLevels = approvalRoomPowerLevels(botUserId);

    expect(powerLevels).toMatchObject({
      invite: 100,
      kick: 100,
      ban: 100,
      redact: 100,
      state_default: 100,
      events_default: 0,
      users_default: 0,
      users: { [botUserId]: 100 },
    });
    expect(Object.keys(powerLevels.users)).toEqual([botUserId]);
  });

  test('existing approval rooms are upgraded to bridge-only membership', async () => {
    const bridge = new MatrixBridge();
    bridge.botUserId = '@agent-bridge:palpo.test';
    bridge.botClient = {
      getRoomStateEvent: vi.fn().mockResolvedValue({
        invite: 0,
        users: { '@agent-bridge:palpo.test': 100 },
        users_default: 0,
      }),
      sendStateEvent: vi.fn().mockResolvedValue('$power-levels'),
    };

    await expect(bridge.ensureApprovalDmRestricted('!approval-dm:palpo.test'))
      .resolves.toBe(true);
    expect(bridge.botClient.sendStateEvent).toHaveBeenCalledWith(
      '!approval-dm:palpo.test',
      'm.room.power_levels',
      '',
      approvalRoomPowerLevels('@agent-bridge:palpo.test'),
    );
  });
});
