import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { pathToFileURL } from 'url';
import { restoreEnv, snapshotEnv } from './helpers/env.js';

describe('bridge matrix behavior', () => {
  let runtimeDir;
  let MatrixBridge;
  let ReliableMatrixClient;
  let rememberPendingInvite;
  let getPendingInvite;
  let resetPendingInvitesForTest;
  let buildMessageUrlForTest;
  let generateAvatarPngForTest;
  let resetBridgeMatrixTestHooks;
  let resolveMessageBaseUrlForTest;
  let resolveInvitePollMsForTest;
  let resolveRoomScanPollMsForTest;
  let matrixRateLimitGateForTest;
  let matrixDefaultWakeEnabled;
  let resolveInboundRoute;
  let pickDefaultGroupRecipient;
  let preferredDmRoom;
  let resolveOutboundDmRoom;
  let resolveGroupReplyRelation;
  let parseInboundTextMessage;
  let parseAgentOpsClientControlEvent;
  let markRoomTrusted;
  let signedCurve25519CountFromKeysUpload;
  let signedCurve25519CountFromSync;
  let setBridgeMatrixTestHooks;
  let envSnapshot;

  beforeAll(async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-bridge-test-'));
    envSnapshot = snapshotEnv([
      'HAFLEET_RUNTIME_DIR',
      'MATRIX_AGENT_PREFIX',
      'MATRIX_IGNORED_SENDER_MXIDS',
      'MATRIX_TRUSTED_INVITER_MXIDS',
      'HAFLEET_AGENT_OPS_CLIENT',
    ]);
    process.env.HAFLEET_RUNTIME_DIR = runtimeDir;
    process.env.MATRIX_AGENT_PREFIX = 'ac_';
    process.env.MATRIX_IGNORED_SENDER_MXIDS = '@octosbot:matrix.example.test';
    process.env.MATRIX_TRUSTED_INVITER_MXIDS = '@alice:matrix.example.com';
    const bridgeUrl = pathToFileURL(path.resolve('bridge-matrix.js')).href;
    ({
      MatrixBridge,
      ReliableMatrixClient,
      rememberPendingInvite,
      getPendingInvite,
      resetPendingInvitesForTest,
      buildMessageUrlForTest,
      generateAvatarPngForTest,
      resetBridgeMatrixTestHooks,
      resolveMessageBaseUrlForTest,
      resolveInvitePollMsForTest,
      resolveRoomScanPollMsForTest,
      matrixRateLimitGateForTest,
      matrixDefaultWakeEnabled,
      resolveInboundRoute,
      pickDefaultGroupRecipient,
      preferredDmRoom,
      resolveOutboundDmRoom,
      resolveGroupReplyRelation,
      parseInboundTextMessage,
      parseAgentOpsClientControlEvent,
      markRoomTrusted,
      signedCurve25519CountFromKeysUpload,
      signedCurve25519CountFromSync,
      setBridgeMatrixTestHooks,
    } = await import(`${bridgeUrl}?test=${Date.now()}-${Math.random().toString(36).slice(2, 10)}`));
  });

  test('missing sync count field preserves unchanged-count semantics', () => {
    /*
     * REQ-OWNER-UI-APPROVAL-OTK, the clause that names the actual bug: "an absent sync field
     * MUST NOT be rewritten as zero on every sync". Null, not 0, is the whole assertion — a
     * zero would read as "no one-time keys left" and drive an upload on every single sync,
     * and the third case shows a present count is still passed through unchanged.
     */
    expect(signedCurve25519CountFromSync({})).toBeNull();
    expect(signedCurve25519CountFromSync({ device_one_time_keys_count: {} })).toBeNull();
    expect(signedCurve25519CountFromSync({
      device_one_time_keys_count: { signed_curve25519: 18 },
    })).toBe(18);
  });

  test('keys upload response supplies an authoritative reconciliation count', () => {
    /*
     * REQ-OWNER-UI-APPROVAL-OTK: the count that replaces a missing sync figure has to come
     * from somewhere authoritative. Here /keys/upload's own response is that source, and the
     * asymmetry with the sync reader above is the point — an empty `one_time_key_counts` from
     * a keys-upload response genuinely means zero, so it maps to 0 rather than null.
     */
    expect(signedCurve25519CountFromKeysUpload({ one_time_key_counts: {} })).toBe(0);
    expect(signedCurve25519CountFromKeysUpload({
      one_time_key_counts: { signed_curve25519: 42 },
    })).toBe(42);
  });

  test('Agent Operations control parser rejects malformed key and scope substitution', () => {
    const valid = parseAgentOpsClientControlEvent('!owner-dm:matrix.test', {
      event_id: '$agent-ops-request',
      sender: '@owner:matrix.test',
      content: {
        msgtype: 'com.hafleet.agent_ops.client_session.request.v1',
        body: 'Agent Operations bootstrap',
        'com.hafleet.agent_ops': {
          schema: 'com.hafleet.agent_ops.v1',
          agent: 'worker',
          project_room_id: '!project:matrix.test',
          client_nonce: 'client-nonce-1',
          client_public_jwk: {
            kty: 'OKP', crv: 'Ed25519',
            x: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc',
          },
        },
      },
    });
    expect(valid).toMatchObject({
      kind: 'request', roomId: '!owner-dm:matrix.test', eventId: '$agent-ops-request',
      senderMxid: '@owner:matrix.test', agent: 'worker', projectRoomId: '!project:matrix.test',
    });
    expect(parseAgentOpsClientControlEvent('!owner-dm:matrix.test', {
      event_id: '$bad-key', sender: '@owner:matrix.test',
      content: {
        msgtype: 'com.hafleet.agent_ops.client_session.request.v1',
        'com.hafleet.agent_ops': {
          ...valid,
          schema: 'com.hafleet.agent_ops.v1', agent: 'worker',
          project_room_id: '!project:matrix.test', client_nonce: 'nonce',
          client_public_jwk: { kty: 'OKP', crv: 'Ed25519', x: 'short' },
        },
      },
    })).toMatchObject({ invalid: true, eventId: '$bad-key' });
  });

  test('Matrix device-list changes become durable Agent Operations revocation work', async () => {
    const client = new ReliableMatrixClient('https://matrix.test', 'test-token', {
      getSyncToken: vi.fn().mockResolvedValue(null),
      setSyncToken: vi.fn().mockResolvedValue(undefined),
    });
    client.crypto = null;
    client.onSyncSuccess = null;
    client._lastOtkCountReconciliationAt = Date.now();
    const emitted = [];
    await client.processSync({
      device_lists: {
        changed: ['@owner:matrix.test', '@owner:matrix.test'],
        left: ['@departed:matrix.test'],
      },
      device_one_time_keys_count: { signed_curve25519: 1 },
    }, async (eventName, ...payload) => emitted.push([eventName, ...payload]));
    expect(emitted).toContainEqual([
      'device_lists.changed',
      ['@owner:matrix.test', '@departed:matrix.test'],
    ]);

    const prior = process.env.HAFLEET_AGENT_OPS_CLIENT;
    process.env.HAFLEET_AGENT_OPS_CLIENT = '1';
    try {
      const approvalRoom = `!agent-ops-device-${Date.now()}:matrix.test`;
      markRoomTrusted(approvalRoom, {
        approvalDm: true,
        ownerMxid: '@owner:matrix.test',
        agent: 'worker',
      });
      const bridge = new MatrixBridge();
      bridge.callBackendApi = vi.fn().mockResolvedValue({ ok: true, revoked_scope_count: 1 });
      await expect(bridge.onAgentOpsDeviceListsChanged([
        '@owner:matrix.test', '@unrelated:matrix.test',
      ])).resolves.toEqual({ revoked: 1 });
      expect(bridge.callBackendApi).toHaveBeenCalledOnce();
      expect(bridge.callBackendApi).toHaveBeenCalledWith(
        'POST',
        '/api/agent-ops/v1/control/revoke',
        { owner_mxid: '@owner:matrix.test', clear_device: true },
        'context=agent-ops:device-list-revoke owner=@owner:matrix.test',
      );
    } finally {
      if (prior === undefined) delete process.env.HAFLEET_AGENT_OPS_CLIENT;
      else process.env.HAFLEET_AGENT_OPS_CLIENT = prior;
    }
  });

  test('OTK count reconciliation is bounded to one probe per interval', async () => {
    /*
     * REQ-OWNER-UI-APPROVAL-OTK, the bounded-cadence clause. Two calls one millisecond apart:
     * the first probes and returns 42, the second returns null having probed nothing, and the
     * single updateSyncData call proves the authoritative count — not a fabricated one — is
     * what reaches the crypto state machine that replenishes keys.
     *
     * Partially covers the statement: the first sentence, "maintain enough signed Curve25519
     * one-time keys", is delegated to the crypto state machine here and no test asserts that
     * keys are actually uploaded when the count runs low.
     */
    const client = Object.create(ReliableMatrixClient.prototype);
    client.crypto = { updateSyncData: vi.fn().mockResolvedValue(undefined) };
    client._lastOtkCountReconciliationAt = 0;
    client.probeSignedCurve25519Count = vi.fn().mockResolvedValue(42);

    await expect(client.reconcileSignedCurve25519CountIfDue(400_000)).resolves.toBe(42);
    await expect(client.reconcileSignedCurve25519CountIfDue(400_001)).resolves.toBeNull();

    expect(client.probeSignedCurve25519Count).toHaveBeenCalledOnce();
    expect(client.crypto.updateSyncData).toHaveBeenCalledOnce();
    expect(client.crypto.updateSyncData).toHaveBeenCalledWith(
      [],
      { signed_curve25519: 42 },
      [],
      [],
      [],
    );
  });

  test('a FAILING otk probe still consumes the interval', async () => {
    /*
     * The throttle counts attempts, not successes, and this is the case that proves it.
     *
     * The stamp used to be written after both awaits, so a probe that threw recorded nothing —
     * and `processSync` swallows the error, so the next sync round found the throttle unset and
     * probed again. Measured before the fix: five rounds one millisecond apart produced FIVE
     * POSTs with the stamp still at 0.
     *
     * The consequence inverted the intent. `syncingTimeout` defaults to 30s, so a homeserver
     * answering 429 or 5xx received one empty `/keys/upload` per sync round — about ten times
     * the interval this method exists to enforce, for as long as the failure lasted, and hardest
     * on a server already struggling. It also refuted ADR-006's own Consequence that an affected
     * homeserver "requires one additional bounded count probe".
     */
    const client = Object.create(ReliableMatrixClient.prototype);
    client.crypto = { updateSyncData: vi.fn().mockResolvedValue(undefined) };
    client._lastOtkCountReconciliationAt = 0;
    client.probeSignedCurve25519Count = vi.fn().mockRejectedValue(new Error('429 rate limited'));

    /*
     * Five sync rounds one millisecond apart, as a rate-limited server would produce. Only the
     * FIRST reaches the network — the four after it are throttled and return null, which is the
     * fix stated as an observation: before it, all five probed.
     */
    await expect(client.reconcileSignedCurve25519CountIfDue(400_000)).rejects.toThrow('429');
    for (let i = 1; i < 5; i += 1) {
      await expect(client.reconcileSignedCurve25519CountIfDue(400_000 + i)).resolves.toBeNull();
    }

    expect(client.probeSignedCurve25519Count).toHaveBeenCalledOnce();
    expect(client._lastOtkCountReconciliationAt).toBe(400_000);
    // And nothing was fed to the crypto layer, so a failed probe cannot report a bogus count.
    expect(client.crypto.updateSyncData).not.toHaveBeenCalled();
  });

  test('a probe that lands but whose updateSyncData fails also consumes the interval', async () => {
    /*
     * The second await, which the original code left equally unguarded. Distinguished from the
     * case above because it fails AFTER the network request, so retrying it re-sends a request
     * that already succeeded — the throttle is the only thing preventing that.
     */
    const client = Object.create(ReliableMatrixClient.prototype);
    client.crypto = { updateSyncData: vi.fn().mockRejectedValue(new Error('crypto not ready')) };
    client._lastOtkCountReconciliationAt = 0;
    client.probeSignedCurve25519Count = vi.fn().mockResolvedValue(7);

    await expect(client.reconcileSignedCurve25519CountIfDue(400_000)).rejects.toThrow('crypto not ready');
    await expect(client.reconcileSignedCurve25519CountIfDue(400_001)).resolves.toBeNull();

    expect(client.probeSignedCurve25519Count).toHaveBeenCalledOnce();
  });

  test('the interval is still honoured exactly, and reopens after it', async () => {
    /*
     * Bounds the fix in the other direction. Stamping earlier must not make the throttle
     * permanent — the previous test pins that a failure consumes the interval, and this pins
     * that the interval then EXPIRES. Without it, `_lastOtkCountReconciliationAt = now` moved to
     * the top would pass while never reconciling again.
     *
     * Also pins the boundary as an equality rather than a range: the existing cadence test only
     * proved (1ms, 400_000ms], which would pass with a two-second or a four-hundred-second
     * interval. Five minutes is now asserted, not merely a constant in the source.
     */
    const client = Object.create(ReliableMatrixClient.prototype);
    client.crypto = { updateSyncData: vi.fn().mockResolvedValue(undefined) };
    client._lastOtkCountReconciliationAt = 0;
    client.probeSignedCurve25519Count = vi.fn().mockResolvedValue(11);

    await expect(client.reconcileSignedCurve25519CountIfDue(1_000_000)).resolves.toBe(11);
    // One millisecond short of five minutes: still closed.
    await expect(client.reconcileSignedCurve25519CountIfDue(1_000_000 + 299_999)).resolves.toBeNull();
    // Exactly five minutes: open again.
    await expect(client.reconcileSignedCurve25519CountIfDue(1_000_000 + 300_000)).resolves.toBe(11);
    expect(client.probeSignedCurve25519Count).toHaveBeenCalledTimes(2);
  });

  test('threaded_group_reply_rebuilds_matrix_relation', () => {
    /*
     * REQ-MATRIX-THREAD-RELATION. Both halves of "target the source primary event and retain
     * the original thread root" are asserted on one object: `m.in_reply_to` carries the
     * source event `$human-reply`, and `event_id` under `m.thread` stays `$thread-root`
     * rather than becoming the event being replied to — which is the mistake that would
     * silently start a new thread per reply.
     */
    const resolution = resolveGroupReplyRelation({
      group: 'robrix2-board',
      source: 'matrix',
      matrixContext: {
        roomId: '!board:matrix.test',
        eventId: '$human-reply',
        threadRootEventId: '$thread-root',
      },
    }, {
      group: 'robrix2-board',
      roomId: '!board:matrix.test',
    });

    expect(resolution).toEqual({
      kind: 'relation',
      threadRootEventId: '$thread-root',
      relation: {
        rel_type: 'm.thread',
        event_id: '$thread-root',
        is_falling_back: true,
        'm.in_reply_to': { event_id: '$human-reply' },
      },
    });
  });

  test('inbound Matrix thread parser keeps root and rich-reply target', () => {
    expect(parseInboundTextMessage({
      msgtype: 'm.text',
      body: '> <@agent:test> old\n\ncontinue',
      'm.relates_to': {
        rel_type: 'm.thread',
        event_id: '$thread-root',
        is_falling_back: true,
        'm.in_reply_to': { event_id: '$agent-target' },
      },
    })).toEqual({
      skip: false,
      body: 'continue',
      replyEventId: '$agent-target',
      threadRootEventId: '$thread-root',
    });
  });

  test('top_level_group_reply_does_not_start_thread', () => {
    /*
     * REQ-MATRIX-RICH-REPLY. "Without implicitly creating a thread" is a negative, so the
     * equality on the whole relation object is what establishes it: any `rel_type`/`event_id`
     * pair the resolver added would fail the toEqual. The explicit rel_type assertion below
     * names the field that would carry the accidental thread.
     */
    const resolution = resolveGroupReplyRelation({
      group: 'robrix2-board',
      source: 'matrix',
      matrixContext: {
        roomId: '!board:matrix.test',
        eventId: '$top-level',
        threadRootEventId: null,
      },
    }, {
      group: 'robrix2-board',
      roomId: '!board:matrix.test',
    });

    expect(resolution).toEqual({
      kind: 'relation',
      threadRootEventId: null,
      relation: {
        'm.in_reply_to': { event_id: '$top-level' },
      },
    });
    expect(resolution.relation.rel_type).toBeUndefined();
  });

  test('multi_hop_agent_reply_uses_persisted_primary_delivery', () => {
    /*
     * REQ-MATRIX-THREAD-RELATION for the agent-to-agent hop. `source: 'api'` makes the
     * resolver read `matrixDelivery.primaryEventId` instead of the inbound `matrixContext`,
     * so this is the case where the source event id came from a persisted record rather than
     * from a live Matrix event — the hand-off that used to break on bridge restart. The
     * relation still targets the source primary event and keeps the inherited root.
     */
    const resolution = resolveGroupReplyRelation({
      group: 'robrix2-board',
      source: 'api',
      matrixDelivery: {
        roomId: '!board:matrix.test',
        primaryEventId: '$agent-a-primary',
        threadRootEventId: '$thread-root',
      },
    }, {
      group: 'robrix2-board',
      roomId: '!board:matrix.test',
    });

    expect(resolution.relation).toEqual({
      rel_type: 'm.thread',
      event_id: '$thread-root',
      is_falling_back: true,
      'm.in_reply_to': { event_id: '$agent-a-primary' },
    });
  });

  test('cross_room_group_reply_fails_closed', async () => {
    /*
     * REQ-MATRIX-THREAD-ROOM-BOUNDARY, for the "another Matrix room" half. The gate asserted
     * here is `resolveOutboundGroupRelation`, which runs before the send in onAgentMessage
     * (`if (!thread.ok) return;`), so an ok:false is the rejection the requirement asks for.
     *
     * PARTIAL: the requirement says "another known group OR Matrix room". This fixture keeps
     * the group equal and varies only roomId, so it pins `source_room_mismatch`. The sibling
     * `source_group_mismatch` branch in resolveGroupReplyRelation has no test.
     */
    const bridge = new MatrixBridge();
    bridge.callBackendApi = vi.fn().mockResolvedValue({
      id: 'msg_source',
      group: 'robrix2-board',
      source: 'api',
      matrixDelivery: {
        roomId: '!other:matrix.test',
        primaryEventId: '$other-event',
        threadRootEventId: '$other-root',
      },
    });
    bridge.postWarning = vi.fn();

    const resolution = await bridge.resolveOutboundGroupRelation({
      id: 'msg_reply',
      group: 'robrix2-board',
      reply_to: 'msg_source',
    }, '!board:matrix.test');

    expect(resolution).toMatchObject({ ok: false, reason: 'source_room_mismatch' });
    expect(bridge.postWarning).toHaveBeenCalledWith(
      expect.stringContaining('Blocked Matrix group reply'),
      expect.objectContaining({ kind: 'thread-routing' }),
    );
  });

  test('missing_matrix_delivery_falls_back_to_top_level', async () => {
    /*
     * REQ-MATRIX-THREAD-COMPATIBILITY. The source message deliberately has no matrixDelivery,
     * which is what every message written before threading existed looks like. Both halves of
     * the requirement are asserted: ok:true with a null relation is the top-level degrade
     * (a legacy reply must not be blocked), and postWarning is what makes the miss
     * operator-visible instead of silent.
     */
    const bridge = new MatrixBridge();
    bridge.callBackendApi = vi.fn().mockResolvedValue({
      id: 'msg_legacy',
      group: 'robrix2-board',
      source: 'api',
    });
    bridge.postWarning = vi.fn();

    const resolution = await bridge.resolveOutboundGroupRelation({
      id: 'msg_reply',
      group: 'robrix2-board',
      reply_to: 'msg_legacy',
    }, '!board:matrix.test');

    expect(resolution).toMatchObject({ ok: true, relation: null, fallback: true });
    expect(bridge.postWarning).toHaveBeenCalledWith(
      expect.stringContaining('sent at room top level'),
      expect.objectContaining({ kind: 'thread-compatibility' }),
    );
  });

  test('a backend LOOKUP FAILURE is not conflated with a compatibility miss', async () => {
    /*
     * REQ-MATRIX-THREAD-COMPATIBILITY, the distinction the fallback used to erase. A transient
     * backend error and a legacy message both used to return null from the metadata lookup, and
     * both mapped to `source_metadata_missing` → silent top-level send. But they are not the same:
     * a legacy message never had thread context, while a failed lookup means the context PROBABLY
     * EXISTS and is about to be lost permanently, because the reply is sent and cannot be recalled.
     *
     * The fix does not block — ADR-007 chose fallback over blocking so one failed lookup cannot
     * wedge later workflow — but it now SAYS which case it is: a distinct reason and a distinct
     * warning kind, so a backend problem is not filed as "these were all legacy replies".
     */
    const bridge = new MatrixBridge();
    // Every lookup throws: the backend is down for the whole of this attempt, retry included.
    bridge.callBackendApi = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    bridge.postWarning = vi.fn();

    const resolution = await bridge.resolveOutboundGroupRelation({
      id: 'msg_reply',
      group: 'robrix2-board',
      reply_to: 'msg_source',
    }, '!board:matrix.test');

    // Falls back (does not block), but with the reason that names it a failure, not a blank.
    expect(resolution).toMatchObject({ ok: true, relation: null, fallback: true, reason: 'source_lookup_failed' });
    expect(bridge.postWarning).toHaveBeenCalledWith(
      expect.stringContaining('could not be read'),
      expect.objectContaining({ kind: 'thread-lookup-failed' }),
    );
    // It is a retry, not a loop: exactly two attempts, no more.
    expect(bridge.callBackendApi).toHaveBeenCalledTimes(2);
  });

  test('a lookup that fails ONCE then succeeds keeps the thread intact', async () => {
    /*
     * The reason the retry exists. A backend momentarily busy loses one call and answers the
     * next; without the retry that live thread would have degraded to top-level for good. The
     * second call returns real delivery metadata, so the reply threads correctly.
     */
    const bridge = new MatrixBridge();
    let calls = 0;
    bridge.callBackendApi = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error('503 momentarily busy');
      return {
        id: 'msg_source',
        group: 'robrix2-board',
        source: 'api',
        matrixDelivery: { roomId: '!board:matrix.test', primaryEventId: '$src-event', threadRootEventId: null },
      };
    });
    bridge.postWarning = vi.fn();

    const resolution = await bridge.resolveOutboundGroupRelation({
      id: 'msg_reply',
      group: 'robrix2-board',
      reply_to: 'msg_source',
    }, '!board:matrix.test');

    expect(resolution.ok).toBe(true);
    expect(resolution.fallback).toBeUndefined();
    expect(resolution.relation).toMatchObject({ 'm.in_reply_to': { event_id: '$src-event' } });
    // No warning: nothing degraded.
    expect(bridge.postWarning).not.toHaveBeenCalled();
  });

  test('source_group_mismatch is rejected, not sent to the wrong group', async () => {
    /*
     * REQ-MATRIX-THREAD-ROOM-BOUNDARY's other half, which the audit found untested — the sibling
     * of `cross_room_group_reply_fails_closed`. There the room varied and the group held; here the
     * GROUP differs, so the reply_to points at a message from a different group entirely. A reply
     * threaded across that boundary would leak one group's context into another; it must be
     * refused, and the refusal must block the send (`ok: false`), not fall back.
     */
    const bridge = new MatrixBridge();
    bridge.callBackendApi = vi.fn().mockResolvedValue({
      id: 'msg_source',
      group: 'some-other-group',
      source: 'api',
      matrixDelivery: { roomId: '!board:matrix.test', primaryEventId: '$x', threadRootEventId: null },
    });
    bridge.postWarning = vi.fn();

    const resolution = await bridge.resolveOutboundGroupRelation({
      id: 'msg_reply',
      group: 'robrix2-board',
      reply_to: 'msg_source',
    }, '!board:matrix.test');

    expect(resolution).toMatchObject({ ok: false, reason: 'source_group_mismatch' });
    expect(bridge.postWarning).toHaveBeenCalledWith(
      expect.stringContaining('Blocked Matrix group reply'),
      expect.objectContaining({ kind: 'thread-routing' }),
    );
  });

  test('pending_delivery_replays_after_restart', async () => {
    /*
     * REQ-MATRIX-THREAD-DELIVERY. The requirement's force is in "before the delivery is
     * considered complete": Matrix already accepted the body event, so if the backend upsert
     * were simply dropped the association would be lost with no way to notice. A fresh
     * MatrixBridge (the restart) replays the journalled record to the same message with the
     * same primaryEventId and only then marks it committed.
     */
    const pending = {
      messageId: 'msg_pending',
      roomId: '!board:matrix.test',
      primaryEventId: '$primary',
      threadRootEventId: '$root',
      state: 'pending',
    };
    const journal = {
      pending: vi.fn().mockReturnValue([pending]),
      markCommitted: vi.fn().mockReturnValue({ ...pending, state: 'committed' }),
    };
    const restarted = new MatrixBridge({ matrixDeliveryJournal: journal });
    restarted.callBackendApi = vi.fn().mockResolvedValue({ ok: true });

    await expect(restarted.replayPendingMatrixDeliveries()).resolves.toBe(1);
    expect(restarted.callBackendApi).toHaveBeenCalledWith(
      'PUT',
      '/api/messages/msg_pending/matrix-delivery',
      {
        room_id: '!board:matrix.test',
        primary_event_id: '$primary',
        thread_root_event_id: '$root',
      },
      expect.stringContaining('message=msg_pending'),
    );
    expect(journal.markCommitted).toHaveBeenCalledWith('msg_pending');
  });

  test('encrypted_approval_send_does_not_create_group_delivery', async () => {
    /*
     * REQ-MATRIX-THREAD-PLAINTEXT-SCOPE, first clause. The approval send reaches
     * sendAsAgentContent without a delivery argument, so persistPrimary is false and the
     * journal is never touched — the thread sender's durable path stays out of the approval
     * room. The second clause (encrypted approvals keep their crypto-client path) is asserted
     * in tests/bridge-matrix-approval.test.js, which is where the botClient send lives.
     *
     * PARTIAL: this pins the approval call site, not an encryption check inside the sender —
     * nothing asserts that a persistPrimary send into an encrypted room is refused.
     */
    const journal = {
      get: vi.fn(),
      recordPending: vi.fn(),
      markCommitted: vi.fn(),
      pending: vi.fn().mockReturnValue([]),
    };
    const bridge = new MatrixBridge({ matrixDeliveryJournal: journal });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ event_id: '$approval-event' }),
    }));

    await expect(bridge.sendAsAgentContent(
      'agent-token',
      '!approval:matrix.test',
      { msgtype: 'com.hafleet.approval.request.v1', body: 'approval' },
      'approval_123',
    )).resolves.toBe('$approval-event');

    expect(journal.get).not.toHaveBeenCalled();
    expect(journal.recordPending).not.toHaveBeenCalled();
  });

  test('router outbox delivery uses backend sender route and stable transaction metadata', async () => {
    const bridge = new MatrixBridge();
    bridge.getAgentToken = vi.fn().mockReturnValue('worker-token');
    bridge.sendAsAgentContent = vi.fn().mockResolvedValue('$worker-reply');
    bridge.callBackendApi = vi.fn().mockResolvedValue({ ok: true });

    await bridge.deliverRouterCommand('matrix', {
      commandId: 'matrix-command', claimToken: 'claim-token',
      transactionId: 'agentchat_stable_txn', senderAgentName: 'worker',
      roomId: '!robrix2:test', threadRootEventId: '$human-root', body: 'Task created',
    });

    expect(bridge.sendAsAgentContent).toHaveBeenCalledWith(
      'worker-token',
      '!robrix2:test',
      {
        msgtype: 'm.text',
        body: 'Task created',
        'm.relates_to': {
          rel_type: 'm.thread', event_id: '$human-root', is_falling_back: true,
          'm.in_reply_to': { event_id: '$human-root' },
        },
      },
      null,
      { transactionId: 'agentchat_stable_txn', throwOnFailure: true },
    );
    expect(bridge.callBackendApi).toHaveBeenCalledWith(
      'POST',
      '/api/router/matrix-outbox/matrix-command/delivered',
      { claim_token: 'claim-token', event_id: '$worker-reply' },
      'context=router-matrix-delivery',
    );
  });

  test('explicit router transaction id is used verbatim for idempotent Matrix send', async () => {
    const bridge = new MatrixBridge();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ event_id: '$stable-event' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(bridge.sendAsAgentContent(
      'worker-token', '!robrix2:test', { msgtype: 'm.text', body: 'reply' }, null,
      { transactionId: 'agentchat_fixed_123', throwOnFailure: true },
    )).resolves.toBe('$stable-event');

    expect(fetchMock.mock.calls[0][0]).toContain('/send/m.room.message/agentchat_fixed_123');
  });

  test('primary group send journals before upsert and retry does not send twice', async () => {
    /*
     * REQ-MATRIX-THREAD-DELIVERY on the happy path. `stored.state === 'committed'` is the
     * assertion that carries the requirement: markCommitted only runs after the backend
     * upsert resolves, so a committed record proves the primary event id was durably
     * associated with the backend message and not merely sent. The single-fetch assertion
     * shows the second attempt reuses that record instead of emitting a second body event.
     */
    let stored = null;
    const journal = {
      get: vi.fn(() => stored),
      pending: vi.fn(() => stored?.state === 'pending' ? [stored] : []),
      recordPending: vi.fn((record) => {
        stored = { ...record, state: 'pending' };
        return stored;
      }),
      markCommitted: vi.fn(() => {
        stored = { ...stored, state: 'committed' };
        return stored;
      }),
    };
    const bridge = new MatrixBridge({ matrixDeliveryJournal: journal });
    bridge.callBackendApi = vi.fn().mockResolvedValue({ ok: true });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ event_id: '$agent-primary' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const relation = {
      rel_type: 'm.thread',
      event_id: '$thread-root',
      is_falling_back: true,
      'm.in_reply_to': { event_id: '$human-reply' },
    };

    const first = await bridge.sendAsAgent(
      'agent-token',
      '!board:matrix.test',
      'done',
      null,
      'msg_agent',
      {
        persistPrimary: true,
        relation,
        threadRootEventId: '$thread-root',
      },
    );
    const replay = await bridge.sendAsAgent(
      'agent-token',
      '!board:matrix.test',
      'done',
      null,
      'msg_agent',
      {
        persistPrimary: true,
        relation,
        threadRootEventId: '$thread-root',
      },
    );

    expect(first).toBe('$agent-primary');
    expect(replay).toBe('$agent-primary');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)['m.relates_to']).toEqual(relation);
    expect(journal.recordPending).toHaveBeenCalledOnce();
    expect(bridge.callBackendApi).toHaveBeenCalledOnce();
    expect(stored).toMatchObject({
      messageId: 'msg_agent',
      primaryEventId: '$agent-primary',
      threadRootEventId: '$thread-root',
      state: 'committed',
    });
  });

  afterAll(() => {
    rmSync(runtimeDir, { recursive: true, force: true });
    restoreEnv(envSnapshot);
  });

  afterEach(() => {
    resetBridgeMatrixTestHooks();
    rmSync(path.join(runtimeDir, 'data', 'matrix', 'processed-events.jsonl'), { force: true });
    rmSync(path.join(runtimeDir, 'data', 'matrix', 'pending-matrix-deliveries.jsonl'), { force: true });
    rmSync(path.join(runtimeDir, 'data', 'health'), { recursive: true, force: true });
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

  test('backend_failure_keeps_sync_event_replayable', async () => {
    const bridge = new MatrixBridge();
    const timeoutError = new Error('The operation was aborted due to timeout');
    timeoutError.name = 'TimeoutError';

    bridge.callBackendApi = vi.fn()
      .mockRejectedValueOnce(timeoutError)
      .mockRejectedValueOnce(timeoutError);
    bridge.handleMessageDeliveryFeedback = vi.fn().mockResolvedValue(undefined);
    bridge.sendDeliveryNotice = vi.fn().mockResolvedValue(undefined);
    bridge.sleep = vi.fn().mockResolvedValue(undefined);

    await expect(bridge.submitHumanMessage('!room:test', { from: 'alice' }))
      .rejects.toThrow('timeout');
    expect(bridge.callBackendApi).toHaveBeenCalledTimes(2);
    expect(bridge.sleep).toHaveBeenCalledTimes(1);
    expect(bridge.sendDeliveryNotice).toHaveBeenCalledWith(
      '!room:test',
      '⚠️ Message delivery failed after retry (timeout).'
    );
  });

  test('configured sync handler waits for durable routing', async () => {
    const bridge = new MatrixBridge();
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    bridge.onRoomMessage = vi.fn().mockImplementation(() => pending);
    bridge.onRoomEvent = vi.fn().mockResolvedValue(undefined);
    bridge.handleBotInvite = vi.fn().mockResolvedValue({ accepted: true });
    const client = { emit: vi.fn() };

    bridge.configureReliableBotSync(client);
    const handled = client.agentChatSyncHandler('room.message', '!room:test', { event_id: '$event' });
    let settled = false;
    handled.finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await handled;

    expect(client.persistTokenAfterSync).toBe(true);
    expect(bridge.onRoomMessage).toHaveBeenCalledOnce();
  });

  test('createRoomForGroup includes human members in the Matrix invite list', async () => {
    const bridge = new MatrixBridge();
    const fetchMock = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({ errcode: 'M_TEST_STOP' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await bridge.createRoomForGroup('demo', ['alice']);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    const request = JSON.parse(options.body);
    expect(url).toMatch(/\/_matrix\/client\/v3\/createRoom$/);
    expect(request).toEqual(expect.objectContaining({
      name: 'demo',
      invite: [`@alice:${new URL(url).host}`],
    }));
  });

  test('sdk_sync_waits_for_durable_handler', async () => {
    const bridge = new MatrixBridge();
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    bridge.onRoomMessage = vi.fn().mockImplementation(() => pending);
    bridge.onRoomEvent = vi.fn().mockResolvedValue(undefined);
    bridge.handleBotInvite = vi.fn().mockResolvedValue({ accepted: true });

    let client;
    const storage = {
      getSyncToken: vi.fn().mockResolvedValue(null),
      setSyncToken: vi.fn().mockImplementation(async () => {
        client.stopSyncing = true;
      }),
    };
    client = new ReliableMatrixClient('https://matrix.test', 'test-token', storage);
    client.doSync = vi.fn().mockResolvedValue({
      next_batch: 'durable-token',
      rooms: {
        join: {
          '!room:test': {
            timeline: {
              events: [{
                type: 'm.room.message',
                event_id: '$sdk-event',
                sender: '@alice:matrix.test',
                content: { msgtype: 'm.text', body: 'durable event' },
              }],
            },
          },
        },
      },
    });
    bridge.configureReliableBotSync(client);

    await client.startSync();
    await vi.waitFor(() => expect(bridge.onRoomMessage).toHaveBeenCalledOnce());
    expect(storage.setSyncToken).not.toHaveBeenCalled();

    release();
    await vi.waitFor(() => expect(storage.setSyncToken).toHaveBeenCalledWith('durable-token'));
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

  test('onRoomMessage routes mapped rooms only to an explicitly mentioned coordinator', async () => {
    const bridge = new MatrixBridge();
    const roomId = '!mapped-single-agent-room:matrix.example.test';
    bridge.botUserId = '@agent-bridge:matrix.example.test';
    bridge.addKnownAgent('wf_coordinator');
    bridge.getBridgeState().roomGroupMap[roomId] = 'website';
    bridge.botClient = {
      getJoinedRoomMembers: vi.fn().mockResolvedValue([
        '@agent-bridge:matrix.example.test',
        '@alice:matrix.example.test',
        '@ac_wf_coordinator:matrix.example.test',
      ]),
    };
    bridge.submitHumanMessage = vi.fn().mockResolvedValue({ ok: true, id: 'msg_website_1' });

    try {
      await bridge.onRoomMessage(roomId, {
        event_id: '$mapped-room-1',
        sender: '@alice:matrix.example.test',
        content: {
          msgtype: 'm.text',
          body: '@wf_coordinator Please start the Website task',
          'm.mentions': { user_ids: ['@ac_wf_coordinator:matrix.example.test'] },
        },
      });

      expect(bridge.submitHumanMessage).toHaveBeenCalledTimes(1);
      expect(bridge.submitHumanMessage).toHaveBeenCalledWith(roomId, expect.objectContaining({
        from: 'alice',
        group: 'website',
        mentions: ['wf_coordinator'],
        source: 'matrix',
        source_room: roomId,
      }));
      expect(bridge.submitHumanMessage.mock.calls[0][1]).not.toHaveProperty('to');
    } finally {
      delete bridge.getBridgeState().roomGroupMap[roomId];
    }
  });

  test('inbound_thread_context_is_forwarded_with_backend_reply_id', async () => {
    const bridge = new MatrixBridge();
    const roomId = '!mapped-thread-room:matrix.example.test';
    bridge.botUserId = '@agent-bridge:matrix.example.test';
    bridge.addKnownAgent('wf_coordinator');
    bridge.getBridgeState().roomGroupMap[roomId] = 'website';
    bridge.botClient = {
      getJoinedRoomMembers: vi.fn().mockResolvedValue([
        '@agent-bridge:matrix.example.test',
        '@alice:matrix.example.test',
        '@ac_wf_coordinator:matrix.example.test',
      ]),
    };
    bridge.rememberMatrixEvent('$agent-target', 'msg_agent_target');
    bridge.submitHumanMessage = vi.fn().mockResolvedValue({ ok: true, id: 'msg_human_thread' });

    try {
      await bridge.onRoomMessage(roomId, {
        event_id: '$human-thread-reply',
        sender: '@alice:matrix.example.test',
        content: {
          msgtype: 'm.text',
          body: '> <@ac_wf_coordinator:matrix.example.test> old\n\n@wf_coordinator continue',
          'm.mentions': { user_ids: ['@ac_wf_coordinator:matrix.example.test'] },
          'm.relates_to': {
            rel_type: 'm.thread',
            event_id: '$thread-root',
            is_falling_back: true,
            'm.in_reply_to': { event_id: '$agent-target' },
          },
        },
      });

      expect(bridge.submitHumanMessage).toHaveBeenCalledWith(roomId, expect.objectContaining({
        group: 'website',
        reply_to: 'msg_agent_target',
        source_event_id: '$human-thread-reply',
        thread_root_event_id: '$thread-root',
      }));
    } finally {
      delete bridge.getBridgeState().roomGroupMap[roomId];
    }
  });

  test('unmapped managed room fails closed unless its agent is explicitly mentioned', async () => {
    const bridge = new MatrixBridge();
    const roomId = '!managed-project-room:matrix.example.test';
    bridge.botUserId = '@agent-bridge:matrix.example.test';
    bridge.addKnownAgent('wf_coordinator');
    markRoomTrusted(roomId, {
      agent: 'wf_coordinator',
      inviter: '@alice:matrix.example.test',
    });
    bridge.botClient = {
      getJoinedRoomMembers: vi.fn().mockRejectedValue(new Error('bot is not joined')),
    };
    bridge.submitHumanMessage = vi.fn().mockResolvedValue({ ok: true, id: 'msg_managed_mention' });

    const ignored = await bridge.onRoomMessage(roomId, {
      event_id: '$managed-unaddressed',
      sender: '@alice:matrix.example.test',
      content: { msgtype: 'm.text', body: 'please inspect this' },
    });

    expect(ignored).toEqual({ ignored: true, reason: 'managed_room_unaddressed' });
    expect(bridge.submitHumanMessage).not.toHaveBeenCalled();

    await bridge.onRoomMessage(roomId, {
      event_id: '$managed-mentioned',
      sender: '@alice:matrix.example.test',
      content: {
        msgtype: 'm.text',
        body: 'wf_coordinator please inspect this',
        'm.mentions': { user_ids: ['@ac_wf_coordinator:matrix.example.test'] },
      },
    });

    expect(bridge.submitHumanMessage).toHaveBeenCalledOnce();
    expect(bridge.submitHumanMessage).toHaveBeenCalledWith(roomId, expect.objectContaining({
      to: 'wf_coordinator',
      source: 'matrix',
      source_room: roomId,
    }));
  });

  test('onRoomMessage routes an explicit mention when the bot cannot inspect a trusted agent room', async () => {
    const bridge = new MatrixBridge();
    const roomId = '!agent-room-no-bot:matrix.example.test';
    bridge.botUserId = '@agent-bridge:matrix.example.test';
    bridge.addKnownAgent('wf_coordinator');
    markRoomTrusted(roomId, {
      agent: 'wf_coordinator',
      inviter: '@alice:matrix.example.test',
    });
    bridge.botClient = {
      getJoinedRoomMembers: vi.fn().mockRejectedValue(new Error('not in room')),
    };
    bridge.submitHumanMessage = vi.fn().mockResolvedValue({ ok: true, id: 'msg_agent_room_1' });

    await bridge.onRoomMessage(roomId, {
      event_id: '$agent-room-message',
      sender: '@alice:matrix.example.test',
      content: {
        msgtype: 'm.text',
        body: 'wf_coordinator /create-issue build a local blog',
        'm.mentions': { user_ids: ['@ac_wf_coordinator:matrix.example.test'] },
      },
    });

    expect(bridge.submitHumanMessage).toHaveBeenCalledWith(roomId, expect.objectContaining({
      from: 'alice',
      to: 'wf_coordinator',
      source: 'matrix',
      source_room: roomId,
      target_type: 'agent',
    }));
  });

  test('backfillAgentManagedRooms uses the agent token when the bot is not in an agent room', async () => {
    const bridge = new MatrixBridge();
    const roomId = '!agent-room:matrix.example.test';
    bridge.addKnownAgent('cursor_agent');
    markRoomTrusted(roomId, {
      agent: 'cursor_agent',
      inviter: '@alice:matrix.example.test',
    });
    const eventTs = bridge.startupTs + 1000;
    bridge.getAgentToken = vi.fn((agentName) => agentName === 'cursor_agent' ? 'agent-token' : null);
    bridge.onRoomMessage = vi.fn().mockResolvedValue(undefined);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        chunk: [
          {
            event_id: '$create-issue',
            type: 'm.room.message',
            origin_server_ts: eventTs,
            sender: '@alice:matrix.example.test',
            content: {
              msgtype: 'm.text',
              body: '/create-issue build a local blog',
            },
          },
        ],
      }),
    }));

    await bridge.backfillAgentManagedRooms();

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/_matrix/client/v3/rooms/!agent-room%3Amatrix.example.test/messages?dir=b&limit=25'),
      expect.objectContaining({
        headers: { Authorization: 'Bearer agent-token' },
      }),
    );
    expect(bridge.onRoomMessage).toHaveBeenCalledWith(roomId, expect.objectContaining({
      event_id: '$create-issue',
      sender: '@alice:matrix.example.test',
    }));

    bridge.onRoomMessage.mockClear();
    await bridge.backfillAgentManagedRooms();
    expect(bridge.onRoomMessage).not.toHaveBeenCalledWith(roomId, expect.objectContaining({
      event_id: '$create-issue',
    }));

    // Runtime state is isolated to this test module's temporary runtime dir.
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
      HAFLEET_WEB_URL: 'https://hafleet.example.test/',
      MSG_BASE_URL: 'https://legacy.example.test/msg',
    })).toBe('https://hafleet.example.test/msg');
    expect(resolveMessageBaseUrlForTest({
      HAFLEET_WEB_URL: 'https://hafleet.example.test/msg/',
    })).toBe('https://hafleet.example.test/msg');
    expect(resolveMessageBaseUrlForTest({
      MSG_BASE_URL: 'https://legacy.example.test/msg/',
    })).toBe('https://legacy.example.test/msg');
    expect(resolveMessageBaseUrlForTest({
      HAFLEET_WEB_PORT: '18184',
    })).toBe('http://127.0.0.1:18184/msg');
    expect(buildMessageUrlForTest('msg_1', 'token value', 'https://hafleet.example.test/msg'))
      .toBe('https://hafleet.example.test/msg/msg_1?view=token%20value');
  });

  test('discoverAndGreetHumans greets configured seed users when user directory is empty', async () => {
    const seedRuntimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-bridge-greet-seed-'));
    const seedEnv = snapshotEnv([
      'HAFLEET_RUNTIME_DIR',
      'MATRIX_BOT_USERNAME',
      'MATRIX_GREETING_MXIDS',
      'MATRIX_SERVER_NAME',
    ]);

    try {
      process.env.HAFLEET_RUNTIME_DIR = seedRuntimeDir;
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
    const seedRuntimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-bridge-greet-failure-'));
    const seedEnv = snapshotEnv([
      'HAFLEET_RUNTIME_DIR',
      'MATRIX_GREETING_MXIDS',
      'MATRIX_SERVER_NAME',
    ]);

    try {
      process.env.HAFLEET_RUNTIME_DIR = seedRuntimeDir;
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
    const seedRuntimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-bridge-greet-dedupe-'));
    const seedEnv = snapshotEnv([
      'HAFLEET_RUNTIME_DIR',
      'MATRIX_AGENT_PREFIX',
      'MATRIX_BOT_USERNAME',
      'MATRIX_GREETING_MXIDS',
      'MATRIX_SERVER_NAME',
    ]);

    try {
      process.env.HAFLEET_RUNTIME_DIR = seedRuntimeDir;
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

  test('pickDefaultGroupRecipient prefers and defaults to the factory coordinator', () => {
    const nameFromId = id => id.replace(/^@ac_/, '').replace(/:.*/, '');

    // Coordinator wins even when several agents are present.
    expect(pickDefaultGroupRecipient(
      ['@ac_wf_implementer:m.test', '@ac_wf_coordinator:m.test'],
      nameFromId,
    )).toBe('wf_coordinator');

    // A mapped room with exactly one non-coordinator still wakes the coordinator.
    expect(pickDefaultGroupRecipient(['@ac_solo:m.test'], nameFromId)).toBe('wf_coordinator');

    // Multiple agents, none a coordinator → nobody (defer to explicit mentions).
    expect(pickDefaultGroupRecipient(
      ['@ac_alpha:m.test', '@ac_beta:m.test'],
      nameFromId,
    )).toBeNull();

    // Empty / non-array input → null.
    expect(pickDefaultGroupRecipient([], nameFromId)).toBeNull();
    expect(pickDefaultGroupRecipient(undefined, nameFromId)).toBeNull();
  });

  test('matrix default wake is mention-only unless legacy auto is explicitly enabled', () => {
    expect(matrixDefaultWakeEnabled({})).toBe(false);
    expect(matrixDefaultWakeEnabled({ MATRIX_DEFAULT_WAKE: 'off' })).toBe(false);
    expect(matrixDefaultWakeEnabled({ MATRIX_DEFAULT_WAKE: 'invalid' })).toBe(false);
    expect(matrixDefaultWakeEnabled({ MATRIX_DEFAULT_WAKE: 'auto' })).toBe(true);
  });

  test('resolveInboundRoute prioritizes bot-DM then group over agent-DM', () => {
    expect(resolveInboundRoute({ groupName: 'g', targetAgent: 'a', isBotDm: true })).toBe('bot-dm');
    // Group mapping wins over DM auto-detection (Change 1).
    expect(resolveInboundRoute({ groupName: 'g', targetAgent: 'a', isBotDm: false })).toBe('group');
    expect(resolveInboundRoute({ groupName: null, targetAgent: 'a', isBotDm: false })).toBe('agent-dm');
    expect(resolveInboundRoute({ groupName: null, targetAgent: null, isBotDm: false })).toBe('ignore');
  });

  test('realtime bot invite handler delegates to handleBotInvite', async () => {
    const bridge = new MatrixBridge();
    let handler = null;
    bridge.botClient = {
      on: vi.fn((name, callback) => {
        if (name === 'room.invite') handler = callback;
      }),
    };
    bridge.handleBotInvite = vi.fn().mockResolvedValue({ accepted: false, reason: 'untrusted_inviter' });

    bridge.installBotInviteHandler();
    await handler('!room:m.test', { sender: '@evil:m.test' });

    expect(bridge.handleBotInvite).toHaveBeenCalledWith(
      '!room:m.test',
      { sender: '@evil:m.test' },
      { source: 'bot-invite' },
    );
  });

  test('bot accepts an invite from the exact local agent managing a trusted room', async () => {
    const bridge = new MatrixBridge();
    const roomId = '!managed-agent-invite:matrix.example.test';
    bridge.addKnownAgent('wf_coordinator');
    markRoomTrusted(roomId, {
      agent: 'wf_coordinator',
      inviter: '@alice:matrix.example.test',
    });
    bridge.botClient = {
      joinRoom: vi.fn().mockResolvedValue(undefined),
      leaveRoom: vi.fn().mockResolvedValue(undefined),
    };

    const result = await bridge.handleBotInvite(roomId, {
      sender: '@ac_wf_coordinator:matrix.example.com',
    });

    expect(result).toMatchObject({
      accepted: true,
      reason: 'managed_agent',
      inviter: '@ac_wf_coordinator:matrix.example.com',
    });
    expect(bridge.botClient.joinRoom).toHaveBeenCalledWith(roomId);
    expect(bridge.botClient.leaveRoom).not.toHaveBeenCalled();
  });

  test('one project room retains independent owner bindings for multiple local agents', async () => {
    /*
     * REQ-OWNER-UI-APPROVAL-MULTI-AGENT. One room, two managed agents, and the assertions are
     * about plurality: both room-agent bindings survive the sync, callBackendApi is called
     * exactly TWICE, and the two PUTs carry distinct owner_dm_room_ids for the same project
     * room. A implementation that overwrote the first binding, or reused one approval room for
     * both agents, fails on the call count and on the second matcher respectively — which is
     * the failure this requirement exists to prevent, since a shared approval room would let
     * one agent's owner answer for the other's agent.
     *
     * This is also the test the spec's `project room retains independent room-agent approval
     * bindings` selector means; the title drifted, the coverage did not.
     */
    const bridge = new MatrixBridge();
    const roomId = '!multi-hafleet-project:matrix.example.test';
    const ownerMxid = '@alice:matrix.example.com';
    bridge.addKnownAgent('wf_coordinator');
    bridge.addKnownAgent('wf_codex');
    markRoomTrusted(roomId, {
      agent: 'wf_coordinator',
      inviter: ownerMxid,
      ownerMxid,
    });
    bridge.recordRoomAgentBinding(roomId, 'wf_codex', ownerMxid);
    bridge.getBridgeState().roomGroupMap[roomId] = 'robrix2-board';
    bridge.ensureApprovalDmRoom = vi.fn().mockImplementation(async (agentName) => ({
      ok: true,
      ready: true,
      roomId: `!approval-${agentName}:matrix.example.test`,
    }));
    bridge.callBackendApi = vi.fn().mockResolvedValue({ ok: true });

    try {
      const result = await bridge.syncApprovalBindingForRoom(roomId);

      expect(result).toMatchObject({ ok: true });
      expect(bridge.roomAgentBindings(roomId)).toEqual(expect.arrayContaining([
        expect.objectContaining({ agentName: 'wf_coordinator', ownerMxid }),
        expect.objectContaining({ agentName: 'wf_codex', ownerMxid }),
      ]));
      expect(bridge.callBackendApi).toHaveBeenCalledTimes(2);
      expect(bridge.callBackendApi).toHaveBeenCalledWith(
        'PUT',
        '/api/approval-bindings',
        expect.objectContaining({
          agent: 'wf_coordinator',
          project_room_id: roomId,
          owner_mxid: ownerMxid,
          owner_dm_room_id: '!approval-wf_coordinator:matrix.example.test',
        }),
        expect.any(String),
      );
      expect(bridge.callBackendApi).toHaveBeenCalledWith(
        'PUT',
        '/api/approval-bindings',
        expect.objectContaining({
          agent: 'wf_codex',
          project_room_id: roomId,
          owner_mxid: ownerMxid,
          owner_dm_room_id: '!approval-wf_codex:matrix.example.test',
        }),
        expect.any(String),
      );
    } finally {
      delete bridge.getBridgeState().roomGroupMap[roomId];
      delete bridge.getBridgeState().roomAgentBindings[roomId];
    }
  });

  test('a second agent creates its approval binding even when the bridge bot is already joined', async () => {
    /*
     * REQ-OWNER-UI-APPROVAL-MULTI-AGENT, the other half — "adding one agent MUST NOT ... reuse
     * another agent's approval room" implies the second agent gets set up at all. The third
     * fetch here returns 403 "already joined" for the bridge bot, and the assertions are that
     * syncApprovalBindingForRoom still ran for wf_codex and its inviter/owner binding was
     * recorded. Treating the already-joined bot as a failure would silently leave the second
     * agent with no approval channel while the first agent's kept working.
     */
    const bridge = new MatrixBridge();
    const roomId = '!bot-already-joined:matrix.example.com';
    const ownerMxid = '@alice:matrix.example.com';
    bridge.botUserId = '@agent-bridge:matrix.example.com';
    bridge.knownAgents = new Set(['wf_codex']);
    bridge.getAgentToken = vi.fn().mockReturnValue('codex-token');
    bridge.syncApprovalBindingForRoom = vi.fn().mockResolvedValue({
      ok: false,
      reason: 'owner_invite_pending',
    });
    bridge.pollBotInvites = vi.fn().mockResolvedValue(undefined);
    bridge.scanJoinedRooms = vi.fn().mockResolvedValue(undefined);
    bridge.backfillAgentManagedRooms = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          rooms: {
            invite: {
              [roomId]: {
                invite_state: {
                  events: [{
                    type: 'm.room.member',
                    state_key: '@ac_wf_codex:matrix.example.com',
                    sender: ownerMxid,
                  }],
                },
              },
            },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ room_id: roomId }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => '{"errcode":"M_FORBIDDEN","error":"already joined"}',
      });
    vi.stubGlobal('fetch', fetchMock);

    await bridge.pollAgentInvites();

    expect(bridge.syncApprovalBindingForRoom).toHaveBeenCalledWith(roomId, 'wf_codex');
    expect(bridge.roomAgentBindings(roomId)).toEqual([
      expect.objectContaining({
        agentName: 'wf_codex',
        inviter: ownerMxid,
        ownerMxid,
      }),
    ]);
    expect(bridge.pollBotInvites).toHaveBeenCalledOnce();
    expect(bridge.scanJoinedRooms).toHaveBeenCalledOnce();
    expect(bridge.backfillAgentManagedRooms).toHaveBeenCalledOnce();
    delete bridge.getBridgeState().roomAgentBindings[roomId];
  });

  test('a different local agent does not receive managed-agent invite trust', () => {
    const bridge = new MatrixBridge();
    const roomId = '!managed-agent-spoof:matrix.example.test';
    bridge.addKnownAgent('wf_coordinator');
    bridge.addKnownAgent('wf_implementer');
    markRoomTrusted(roomId, {
      agent: 'wf_coordinator',
      inviter: '@alice:matrix.example.test',
    });
    expect(bridge.managedAgentBotInviteTrust(
      roomId,
      '@ac_wf_implementer:matrix.example.com',
    )).toBeNull();
  });

  test('polled bot invites delegate to handleBotInvite', async () => {
    const bridge = new MatrixBridge();
    bridge.botUserId = '@agent-bridge:m.test';
    bridge.getBotToken = vi.fn().mockReturnValue('bot-token');
    bridge.handleBotInvite = vi.fn().mockResolvedValue({ accepted: false, reason: 'untrusted_inviter' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({
        rooms: {
          invite: {
            '!room:m.test': {
              invite_state: {
                events: [{
                  type: 'm.room.member',
                  state_key: '@agent-bridge:m.test',
                  sender: '@evil:m.test',
                }],
              },
            },
          },
        },
      }),
    }));

    await bridge.pollBotInvites();

    expect(bridge.handleBotInvite).toHaveBeenCalledWith(
      '!room:m.test',
      { sender: '@evil:m.test' },
      { source: 'bot-invite-poll' },
    );
  });

  test('preferredDmRoom resolves the room a human last wrote from', () => {
    const humanDmKey = name => (typeof name === 'string' && name.startsWith('@') && name.includes(':')
      ? name.slice(1, name.indexOf(':'))
      : name);
    const state = { lastHumanRoom: { 'dm:wf_coordinator:overseer': '!watched:m.test' } };

    expect(preferredDmRoom(state, 'wf_coordinator', 'overseer', humanDmKey)).toBe('!watched:m.test');
    // MXID normalizes to localpart, matching the recorded key.
    expect(preferredDmRoom(state, 'wf_coordinator', '@overseer:m.test', humanDmKey)).toBe('!watched:m.test');
    // No record for this pair → null.
    expect(preferredDmRoom(state, 'wf_coordinator', 'someone_else', humanDmKey)).toBeNull();
    // No lastHumanRoom state at all → null.
    expect(preferredDmRoom({}, 'wf_coordinator', 'overseer', humanDmKey)).toBeNull();
  });

  test('resolveOutboundDmRoom prefers the reply_to thread over the last room', () => {
    const decision = resolveOutboundDmRoom({ replyToRoom: '!thread:m.test', lastRoom: '!last:m.test' });
    expect(decision.room).toBe('!thread:m.test');
    expect(decision.source).toBe('reply_thread');
    // The last room is still a fallback candidate for send-failure cascade.
    expect(decision.candidates).toEqual([
      { room: '!thread:m.test', source: 'reply_thread' },
      { room: '!last:m.test', source: 'last_room' },
    ]);
  });

  test('resolveOutboundDmRoom falls back to the last room when there is no reply thread', () => {
    const decision = resolveOutboundDmRoom({ replyToRoom: null, lastRoom: '!last:m.test' });
    expect(decision.room).toBe('!last:m.test');
    expect(decision.source).toBe('last_room');
    expect(decision.candidates).toEqual([{ room: '!last:m.test', source: 'last_room' }]);
  });

  test('resolveOutboundDmRoom yields null when neither room is known', () => {
    const decision = resolveOutboundDmRoom({ replyToRoom: null, lastRoom: null });
    expect(decision.room).toBeNull();
    expect(decision.source).toBeNull();
    expect(decision.candidates).toEqual([]);
    // Missing argument object behaves the same (caller falls to ensureDmRoom).
    expect(resolveOutboundDmRoom().candidates).toEqual([]);
  });

  test('resolveOutboundDmRoom de-duplicates when reply thread and last room match', () => {
    const decision = resolveOutboundDmRoom({ replyToRoom: '!same:m.test', lastRoom: '!same:m.test' });
    expect(decision.room).toBe('!same:m.test');
    expect(decision.source).toBe('reply_thread');
    expect(decision.candidates).toEqual([{ room: '!same:m.test', source: 'reply_thread' }]);
  });

  test('lookupMessageSourceRoom returns source_room and caches the result', async () => {
    const bridge = new MatrixBridge();
    bridge.callBackendApi = vi.fn().mockResolvedValue({ id: 'm1', source_room: '!thread:m.test' });

    expect(await bridge.lookupMessageSourceRoom('m1')).toBe('!thread:m.test');
    // Second call is served from cache — no extra backend hit.
    expect(await bridge.lookupMessageSourceRoom('m1')).toBe('!thread:m.test');
    expect(bridge.callBackendApi).toHaveBeenCalledTimes(1);
  });

  test('lookupMessageSourceRoom caches a confirmed miss but not a transient error', async () => {
    const bridge = new MatrixBridge();
    // Message exists but carries no source_room → confirmed miss (cached).
    bridge.callBackendApi = vi.fn().mockResolvedValue({ id: 'm2' });
    expect(await bridge.lookupMessageSourceRoom('m2')).toBeNull();
    expect(await bridge.lookupMessageSourceRoom('m2')).toBeNull();
    expect(bridge.callBackendApi).toHaveBeenCalledTimes(1);

    // A thrown lookup is not cached — the next call retries.
    const throwing = new MatrixBridge();
    throwing.callBackendApi = vi.fn().mockRejectedValue(new Error('backend down'));
    expect(await throwing.lookupMessageSourceRoom('m3')).toBeNull();
    expect(await throwing.lookupMessageSourceRoom('m3')).toBeNull();
    expect(throwing.callBackendApi).toHaveBeenCalledTimes(2);
  });

  function outboundHumanMessage(id, replyTo) {
    return {
      id,
      from: 'wf_coordinator',
      to: 'alex',
      group: null,
      type: 'reply',
      summary: 'private approval detail',
      full: '',
      mentions: [],
      reply_to: replyTo,
    };
  }

  function prepareOutboundHumanBridge(replyMessage) {
    const bridge = new MatrixBridge();
    bridge.addKnownAgent('wf_coordinator');
    bridge.ensureAgentToken = vi.fn().mockResolvedValue('agent-token');
    bridge.callBackendApi = vi.fn().mockResolvedValue(replyMessage);
    bridge.ensureDmRoom = vi.fn().mockResolvedValue('!private:matrix.example.test');
    bridge.sendAsAgent = vi.fn().mockResolvedValue(undefined);
    bridge.sendAttachmentsForMessage = vi.fn().mockResolvedValue(undefined);
    return bridge;
  }

  test('direct_human_reply_to_group_uses_private_dm', async () => {
    /*
     * REQ-MATRIX-DM-PRIVACY-ROUTE (the "has no group" clause) and
     * REQ-MATRIX-DM-PRIVACY-FALLBACK (the "came from a group" case). This is the original
     * leak: a private reply whose reply_to points at a public project-room message. The
     * assertion that establishes it is on the room argument, not on the call count —
     * sendAsAgent receives `!private:…`, so `!public:…` was never even a candidate, and
     * ensureDmRoom shows the fallback resolved the pair's own room.
     */
    const bridge = prepareOutboundHumanBridge({
      id: 'msg_group',
      from: 'alex',
      to: null,
      group: 'robrix2-board',
      sourceRoom: '!public:matrix.example.test',
      senderMxid: '@alex:matrix.example.test',
    });

    await bridge.onAgentMessage(outboundHumanMessage('msg_private_group_reply', 'msg_group'));

    expect(bridge.sendAsAgent).toHaveBeenCalledTimes(1);
    expect(bridge.sendAsAgent.mock.calls[0][1]).toBe('!private:matrix.example.test');
    expect(bridge.ensureDmRoom).toHaveBeenCalledWith('wf_coordinator', 'alex');
  });

  test('direct_human_reply_to_matching_dm_reuses_reply_room', async () => {
    /*
     * REQ-MATRIX-DM-PRIVACY-ROUTE, the positive direction. "MUST reuse ... only when" is a
     * biconditional, and the three sibling tests only show rooms being rejected; without this
     * one the requirement would also be satisfied by a bridge that never reuses a reply room
     * at all. Here group is null and senderMxid proves the same human-agent pair, so the
     * referenced DM room is used and ensureDmRoom is not consulted.
     */
    const bridge = prepareOutboundHumanBridge({
      id: 'msg_matching_dm',
      from: 'alex',
      to: 'wf_coordinator',
      group: null,
      sourceRoom: '!matching-dm:matrix.example.test',
      senderMxid: '@alex:matrix.example.com',
    });

    await bridge.onAgentMessage(outboundHumanMessage('msg_private_matching_reply', 'msg_matching_dm'));

    expect(bridge.sendAsAgent).toHaveBeenCalledTimes(1);
    expect(bridge.sendAsAgent.mock.calls[0][1]).toBe('!matching-dm:matrix.example.test');
    expect(bridge.ensureDmRoom).not.toHaveBeenCalled();
  });

  test('direct_human_reply_to_mismatched_pair_uses_private_dm', async () => {
    /*
     * REQ-MATRIX-DM-PRIVACY-ROUTE (the "same pair" clause), REQ-MATRIX-DM-PRIVACY-FALLBACK
     * (the "another pair" case), and REQ-MATRIX-DM-PRIVACY-FAIL-CLOSED (the "mismatched"
     * case). The referenced message is a genuine group-less DM, so it passes every privacy
     * check except identity — the room is private, just not private *to this human*. Sending
     * alex's content into tyrese's DM room would be a leak between two private rooms.
     */
    const bridge = prepareOutboundHumanBridge({
      id: 'msg_other_dm',
      from: 'tyrese',
      to: 'wf_coordinator',
      group: null,
      sourceRoom: '!other-dm:matrix.example.test',
      senderMxid: '@tyrese:matrix.example.test',
    });

    await bridge.onAgentMessage(outboundHumanMessage('msg_private_mismatch_reply', 'msg_other_dm'));

    expect(bridge.sendAsAgent).toHaveBeenCalledTimes(1);
    expect(bridge.sendAsAgent.mock.calls[0][1]).toBe('!private:matrix.example.test');
    expect(bridge.ensureDmRoom).toHaveBeenCalledWith('wf_coordinator', 'alex');
  });

  test('direct_human_reply_lookup_failure_uses_private_dm', async () => {
    /*
     * REQ-MATRIX-DM-PRIVACY-FAIL-CLOSED, the "unavailable" case. A rejected metadata lookup
     * is the one where failing open is tempting, because the bridge has a room id in hand and
     * no evidence against it. The assertion is that an unproven room is still not used: the
     * send goes to the pair's private room even though nothing was learned about reply_to.
     */
    const bridge = prepareOutboundHumanBridge(null);
    bridge.callBackendApi = vi.fn().mockRejectedValue(new Error('backend unavailable'));

    await bridge.onAgentMessage(outboundHumanMessage('msg_private_lookup_failure', 'msg_unknown'));

    expect(bridge.sendAsAgent).toHaveBeenCalledTimes(1);
    expect(bridge.sendAsAgent.mock.calls[0][1]).toBe('!private:matrix.example.test');
    expect(bridge.ensureDmRoom).toHaveBeenCalledWith('wf_coordinator', 'alex');
  });

  test('direct_human_reply_with_missing_group_uses_private_dm', async () => {
    /*
     * REQ-MATRIX-DM-PRIVACY-FAIL-CLOSED, the "missing" case. The fixture omits `group`
     * entirely rather than setting it to null, so the record is unclassified — and the pair
     * does match, meaning a `group == null` check written as falsy would let this room
     * through. Absent classification is not proof of privacy; the private room is used.
     */
    const bridge = prepareOutboundHumanBridge({
      id: 'msg_unclassified',
      from: 'alex',
      to: 'wf_coordinator',
      sourceRoom: '!unclassified:matrix.example.test',
      senderMxid: '@alex:matrix.example.com',
    });

    await bridge.onAgentMessage(outboundHumanMessage('msg_private_unclassified_reply', 'msg_unclassified'));

    expect(bridge.sendAsAgent).toHaveBeenCalledTimes(1);
    expect(bridge.sendAsAgent.mock.calls[0][1]).toBe('!private:matrix.example.test');
    expect(bridge.ensureDmRoom).toHaveBeenCalledWith('wf_coordinator', 'alex');
  });

  test('MATRIX_INVITE_POLL_MS defaults to 60s and clamps to a 5s floor', () => {
    // Default raised from 15s → 60s (Task 5: 收敛 Matrix 429) to reduce poll pressure
    // on rate-limited homeservers like matrix.palpo.im.
    expect(resolveInvitePollMsForTest({})).toBe(60000);
    expect(resolveInvitePollMsForTest({ MATRIX_INVITE_POLL_MS: '20000' })).toBe(20000);
    // Below the floor → clamped up to protect rate-limited homeservers.
    expect(resolveInvitePollMsForTest({ MATRIX_INVITE_POLL_MS: '3000' })).toBe(5000);
    // Non-numeric → fall back to the 60s default.
    expect(resolveInvitePollMsForTest({ MATRIX_INVITE_POLL_MS: 'not-a-number' })).toBe(60000);
  });

  test('MATRIX_ROOM_SCAN_POLL_MS defaults to 120s and clamps to a 30s floor', () => {
    expect(resolveRoomScanPollMsForTest({})).toBe(120000);
    expect(resolveRoomScanPollMsForTest({ MATRIX_ROOM_SCAN_POLL_MS: '180000' })).toBe(180000);
    // Below the floor → clamped up. A room scan issues O(rooms) requests per cycle
    // (membership + state lookups), so it needs a higher floor than the invite poll.
    expect(resolveRoomScanPollMsForTest({ MATRIX_ROOM_SCAN_POLL_MS: '1000' })).toBe(30000);
    // Non-numeric → fall back to the 120s default.
    expect(resolveRoomScanPollMsForTest({ MATRIX_ROOM_SCAN_POLL_MS: 'not-a-number' })).toBe(120000);
  });

  describe('the invite polls actually run', () => {
    /*
     * WHY THESE EXIST. `pollBotInvites` contained a ReferenceError — a reconciliation loop that
     * referenced `agentName`, a variable in scope in `pollAgentInvites` and NOT in that method.
     * It threw on every cycle, the catch logged "Bot invite poll failed: agentName is not
     * defined", and the whole bot invite poll aborted before joining anything. 490 occurrences in
     * one log before a human read it.
     *
     * Three layers failed to see it. `node --check` is syntax-only and cannot resolve an
     * identifier; the repo has no ESLint, so nothing checks `no-undef`; and the one test that
     * reaches this code **mocked the method out** —
     * `bridge.pollBotInvites = vi.fn().mockResolvedValue(undefined)` — to keep an unrelated
     * assertion focused. A mock of the method containing the bug is the perfect blind spot.
     *
     * So these invoke both polls for real against a stubbed fetch. They assert almost nothing
     * about behaviour on purpose: the point is that the method RUNS. A ReferenceError anywhere
     * inside it fails the test, which is the guarantee that was missing.
     */
    /*
     * A JOINED ROOM, NOT AN EMPTY SYNC. This is the difference between a test that runs the method
     * and a test that runs past it: an undefined reference only throws when its line EXECUTES, so
     * a sync with `join: {}` leaves any reconciliation loop empty and the bug unreached. The first
     * version of this test used an empty sync, and the mutant that restored the original
     * ReferenceError passed it — the test asserted "the method runs" while never entering the code
     * that was broken.
     *
     * One joined room and one pending record are the minimum that makes the loop body run.
     */
    const syncWithJoinedRoom = (roomId = '!poll-probe:matrix.example.com') => ({
      ok: true,
      status: 200,
      clone() { return this; },
      json: async () => ({ rooms: { join: { [roomId]: {} }, invite: {} } }),
      text: async () => '{}',
    });

    test('pollBotInvites runs to completion — no undefined reference', async () => {
      const bridge = new MatrixBridge();
      bridge.botUserId = '@agent-bridge:matrix.example.com';
      bridge.knownAgents = new Set(['wf_codex']);
      /*
       * `getBotToken()`, not `botClient`. The method's first line is
       * `const token = this.getBotToken(); if (!token) return;` — with that unstubbed it returned
       * immediately, so the earlier version of this test exercised nothing and the mutant that
       * restored the original ReferenceError passed twice over. A test of "does this run" has to
       * get past the guards that stop it running.
       */
      bridge.getBotToken = vi.fn().mockReturnValue('bot-token');
      bridge.handleBotInvite = vi.fn().mockResolvedValue({ ok: true });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // A pending record for the joined room, so any reconciliation loop has a body to run.
      resetPendingInvitesForTest();
      rememberPendingInvite('!poll-probe:matrix.example.com', 'wf_codex', null);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(syncWithJoinedRoom()));

      await bridge.pollBotInvites();

      /*
       * The assertion that catches this class: the method swallows its own errors, so a throw is
       * invisible in the return value and shows up ONLY as this warning. Checking the warning is
       * therefore checking that nothing threw.
       */
      const failures = warn.mock.calls.map((c) => String(c[0])).filter((m) => /invite poll failed/i.test(m));
      expect(failures, failures.join(' | ')).toEqual([]);
      warn.mockRestore();
      resetPendingInvitesForTest();
    });

    test('pollAgentInvites reconciles a stale pending record against the AGENT\'s membership', async () => {
      /*
       * And the behaviour the broken loop was supposed to provide, now that it sits where the
       * facts are. The first version read the BOT's `rooms.join`, which says nothing about whether
       * the agent joined — so even had it run, it would have settled records on the wrong
       * evidence. This sync is the agent's own.
       */
      const bridge = new MatrixBridge();
      const roomId = '!stale-pending:matrix.example.com';
      bridge.botUserId = '@agent-bridge:matrix.example.com';
      bridge.knownAgents = new Set(['wf_codex']);
      bridge.getAgentToken = vi.fn().mockReturnValue('codex-token');
      bridge.pollBotInvites = vi.fn().mockResolvedValue(undefined);
      bridge.scanJoinedRooms = vi.fn().mockResolvedValue(undefined);
      bridge.backfillAgentManagedRooms = vi.fn().mockResolvedValue(undefined);

      /*
       * Seeded through the exported writer, not through `getBridgeState()`. That method returns a
       * PROJECTION — a fresh object literal over selected fields — so assigning `pendingInvites`
       * on it writes to a throwaway and the record never reaches the module state the code reads.
       * The first version of this test did exactly that and asserted `undefined`.
       *
       * `inviter: null` on purpose: that is the shape this reconciliation exists for — a record
       * written while the invite state did not name a sender, which /projects renders as
       * 「读不到发起人」 with Accept disabled for a room the agent is demonstrably in.
       */
      resetPendingInvitesForTest();
      rememberPendingInvite(roomId, 'wf_codex', null);

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        clone() { return this; },
        json: async () => ({ rooms: { join: { [roomId]: {} }, invite: {} } }),
        text: async () => '{}',
      }));

      await bridge.pollAgentInvites();

      // Settled, and NOT credited to a person who never decided.
      const record = getPendingInvite(roomId, 'wf_codex');
      expect(record?.state).toBe('accepted');
      expect(record?.decidedBy).toBe('trusted-inviter');
      resetPendingInvitesForTest();
    });
  });

  // ── Task 5: shared Matrix 429 rate-limit gate wiring ──────────────────
  describe('shared Matrix 429 rate-limit gate wiring', () => {
    function rateLimitedFetchResponse(retryAfterMs = 5000) {
      return {
        status: 429,
        ok: false,
        clone() { return this; },
        json: async () => ({ errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: retryAfterMs }),
        text: async () => JSON.stringify({ errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: retryAfterMs }),
      };
    }

    function matrixSdkRateLimitError(retryAfterMs = 5000) {
      const error = new Error('M_LIMIT_EXCEEDED: too many requests');
      error.statusCode = 429;
      error.errcode = 'M_LIMIT_EXCEEDED';
      error.retryAfterMs = retryAfterMs;
      return error;
    }

    test('pollAgentInvites: a 429 on the first agent aborts the round — no further agents, no trailing scan/backfill', async () => {
      const bridge = new MatrixBridge();
      bridge.knownAgents = new Set(['agent_alpha', 'agent_beta', 'agent_gamma']);
      bridge.getAgentToken = vi.fn().mockReturnValue('agent-token');
      bridge.pollBotInvites = vi.fn().mockResolvedValue(undefined);
      bridge.scanJoinedRooms = vi.fn().mockResolvedValue(undefined);
      bridge.backfillAgentManagedRooms = vi.fn().mockResolvedValue(undefined);
      const fetchMock = vi.fn().mockResolvedValue(rateLimitedFetchResponse());
      vi.stubGlobal('fetch', fetchMock);

      await bridge.pollAgentInvites();

      // Only agent_alpha's sync request should have fired — agent_beta/agent_gamma
      // must never be reached once the shared cooldown is active.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(bridge.pollBotInvites).not.toHaveBeenCalled();
      expect(bridge.scanJoinedRooms).not.toHaveBeenCalled();
      expect(bridge.backfillAgentManagedRooms).not.toHaveBeenCalled();
    });

    test('pollAgentInvites: skips every agent when a cooldown is already active from another path', async () => {
      const bridge = new MatrixBridge();
      bridge.knownAgents = new Set(['agent_alpha', 'agent_beta']);
      bridge.getAgentToken = vi.fn().mockReturnValue('agent-token');
      bridge.pollBotInvites = vi.fn().mockResolvedValue(undefined);
      bridge.scanJoinedRooms = vi.fn().mockResolvedValue(undefined);
      bridge.backfillAgentManagedRooms = vi.fn().mockResolvedValue(undefined);
      const fetchMock = vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({}) });
      vi.stubGlobal('fetch', fetchMock);

      // A completely unrelated request source (e.g. matrix-bot-sdk) already tripped the gate.
      matrixRateLimitGateForTest.observeError(matrixSdkRateLimitError(30000));

      await bridge.pollAgentInvites();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(bridge.pollBotInvites).not.toHaveBeenCalled();
    });

    test('pollBotInvites: a 429 on the sync call aborts before processing any invited room', async () => {
      const bridge = new MatrixBridge();
      bridge.botUserId = '@agent-bridge:matrix.example.test';
      bridge.getBotToken = vi.fn().mockReturnValue('bot-token');
      bridge.handleBotInvite = vi.fn().mockResolvedValue({ accepted: true });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rateLimitedFetchResponse()));

      await bridge.pollBotInvites();

      expect(bridge.handleBotInvite).not.toHaveBeenCalled();
    });

    test('scanJoinedRooms: a matrix-bot-sdk 429 while mapping the first room aborts remaining rooms', async () => {
      const bridge = new MatrixBridge();
      bridge._backendHealthy = true;
      const rooms = ['!gate-scan-a:matrix.example.test', '!gate-scan-b:matrix.example.test', '!gate-scan-c:matrix.example.test'];
      const getJoinedRoomMembers = vi.fn().mockImplementation(async (roomId) => {
        if (roomId === rooms[0]) throw matrixSdkRateLimitError(9000);
        return ['@someone:matrix.example.test'];
      });
      bridge.botClient = {
        getJoinedRooms: vi.fn().mockResolvedValue(rooms),
        getJoinedRoomMembers,
      };

      await bridge.scanJoinedRooms();

      // tryMapRoom's first botClient call 429s on room A; rooms B and C must be untouched.
      expect(getJoinedRoomMembers).toHaveBeenCalledTimes(1);
      expect(getJoinedRoomMembers).toHaveBeenCalledWith(rooms[0]);
    });

    test('scanJoinedRooms: skips the whole scan when a cooldown is already active from another path', async () => {
      const bridge = new MatrixBridge();
      bridge._backendHealthy = true;
      const getJoinedRooms = vi.fn().mockResolvedValue(['!gate-scan-skip:matrix.example.test']);
      bridge.botClient = { getJoinedRooms };

      matrixRateLimitGateForTest.observeError(matrixSdkRateLimitError(30000));

      await bridge.scanJoinedRooms();

      expect(getJoinedRooms).not.toHaveBeenCalled();
    });

    test('backfillAgentManagedRooms: a 429 on the first managed room aborts remaining rooms', async () => {
      const bridge = new MatrixBridge();
      bridge.addKnownAgent('gate_agent_one');
      bridge.addKnownAgent('gate_agent_two');
      markRoomTrusted('!gate-backfill-a:matrix.example.test', { agent: 'gate_agent_one', inviter: '@x:matrix.example.test' });
      markRoomTrusted('!gate-backfill-b:matrix.example.test', { agent: 'gate_agent_two', inviter: '@x:matrix.example.test' });
      bridge.getAgentToken = vi.fn((name) => (name.startsWith('gate_agent') ? `${name}-token` : null));
      bridge.onRoomMessage = vi.fn().mockResolvedValue(undefined);
      const fetchMock = vi.fn().mockResolvedValue(rateLimitedFetchResponse());
      vi.stubGlobal('fetch', fetchMock);

      await bridge.backfillAgentManagedRooms();

      // Single attempt against the first managed room; the second room is never fetched
      // because the per-room loop checks the shared gate before each iteration.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('a 429 observed via one path is still blocking a different path\'s beforeRequest() with no time elapsed', () => {
      matrixRateLimitGateForTest.observeError(matrixSdkRateLimitError(15000));
      expect(matrixRateLimitGateForTest.beforeRequest()).toBe(false);
    });

    test('a successful response observed after a 429 does not clear the shared cooldown', async () => {
      matrixRateLimitGateForTest.observeError(matrixSdkRateLimitError(15000));
      expect(matrixRateLimitGateForTest.beforeRequest()).toBe(false);

      await matrixRateLimitGateForTest.observeResponse({ status: 200, ok: true, json: async () => ({}) });

      expect(matrixRateLimitGateForTest.beforeRequest()).toBe(false);
    });

    // discoverAndGreetHumans (the 7th Matrix request source: user_directory/search on
    // pollRegistrations' 30s interval) — flagged as a gap in the original wiring pass,
    // ratified as in-scope since a single ungated fetch reproduces the exact amplification
    // the gate exists to prevent.
    test('discoverAndGreetHumans: skips the user directory search when a cooldown is already active', async () => {
      const bridge = new MatrixBridge();
      const fetchMock = vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({ results: [] }) });
      vi.stubGlobal('fetch', fetchMock);

      matrixRateLimitGateForTest.observeError(matrixSdkRateLimitError(30000));

      await bridge.discoverAndGreetHumans();

      expect(fetchMock).not.toHaveBeenCalled();
    });

    test('discoverAndGreetHumans: a 429 from the user directory search updates the shared cooldown', async () => {
      const bridge = new MatrixBridge();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rateLimitedFetchResponse()));

      expect(matrixRateLimitGateForTest.beforeRequest()).toBe(true);

      await bridge.discoverAndGreetHumans();

      expect(matrixRateLimitGateForTest.beforeRequest()).toBe(false);
    });

    // Review follow-up: the candidates loop itself (createRoom via ensureBotDmRoom, then
    // sendMessage via greetHuman) had no beforeRequest() check between iterations, so a
    // 429 partway through a batch (full server first run / large MATRIX_GREETING_MXIDS)
    // tripped the shared cooldown but the remaining candidates were attempted anyway.
    test('discoverAndGreetHumans: a 429 on createRoom for the first candidate aborts the remaining candidates', async () => {
      const bridge = new MatrixBridge();
      bridge.botClient = { sendMessage: vi.fn().mockResolvedValue(undefined) };
      const users = [
        '@gate-multi-a:matrix.example.test',
        '@gate-multi-b:matrix.example.test',
        '@gate-multi-c:matrix.example.test',
      ];
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ status: 200, ok: true, json: async () => ({ results: users.map(u => ({ user_id: u })) }) })
        .mockResolvedValueOnce(rateLimitedFetchResponse());
      vi.stubGlobal('fetch', fetchMock);

      await bridge.discoverAndGreetHumans();

      // 1 search + 1 createRoom (gate-multi-a, 429) — gate-multi-b/c's createRoom never fires.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(bridge.botClient.sendMessage).not.toHaveBeenCalled();
    });

    test('discoverAndGreetHumans: a 429 from sendMessage (matrix-bot-sdk) for the first candidate aborts the remaining candidates', async () => {
      const bridge = new MatrixBridge();
      const sendMessage = vi.fn()
        .mockRejectedValueOnce(matrixSdkRateLimitError(4000))
        .mockResolvedValue(undefined);
      bridge.botClient = { sendMessage };
      const users = ['@gate-send-a:matrix.example.test', '@gate-send-b:matrix.example.test'];
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ status: 200, ok: true, json: async () => ({ results: users.map(u => ({ user_id: u })) }) })
        .mockResolvedValue({ status: 200, ok: true, json: async () => ({ room_id: '!gate-send-dm:matrix.example.test' }) });
      vi.stubGlobal('fetch', fetchMock);

      await bridge.discoverAndGreetHumans();

      // Only gate-send-a's sendMessage is attempted; gate-send-b's greetHuman (createRoom
      // + sendMessage) never runs once the shared cooldown trips.
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  // Task 8: standalone cross-component doctor. The bridge self-reports a small,
  // non-secret business-health record to data/health/matrix-bridge.json so the
  // standalone doctor can check it cross-process without holding Matrix credentials.
  describe('Task 8: business-health record', () => {
    test('ReliableMatrixClient invokes onSyncSuccess after each processed sync round, including an empty one', async () => {
      let client;
      const storage = {
        getSyncToken: vi.fn().mockResolvedValue(null),
        setSyncToken: vi.fn().mockImplementation(async () => { client.stopSyncing = true; }),
      };
      client = new ReliableMatrixClient('https://matrix.test', 'test-token', storage);
      client.doSync = vi.fn().mockResolvedValue({ next_batch: 'health-sync-token' }); // no rooms/events
      const onSyncSuccess = vi.fn();
      client.onSyncSuccess = onSyncSuccess;

      await client.startSync();

      await vi.waitFor(() => expect(onSyncSuccess).toHaveBeenCalledOnce());
    });

    test('_recordMembershipDetail sets agentJoined true (case-insensitively) and records the joined-agent list', () => {
      const bridge = new MatrixBridge();
      bridge._requiredMembershipSummary.set('!health-detail-1:test', {
        roomId: '!health-detail-1:test', group: 'acceptance', requiredAgent: 'reviewer-agent',
        botJoined: true, agentJoined: null, joinedAgentNames: [],
      });

      bridge._recordMembershipDetail('!health-detail-1:test', ['Reviewer-Agent', 'coordinator-agent']);

      const entry = bridge._requiredMembershipSummary.get('!health-detail-1:test');
      expect(entry.joinedAgentNames).toEqual(['Reviewer-Agent', 'coordinator-agent']);
      expect(entry.agentJoined).toBe(true);
    });

    test('_recordMembershipDetail sets agentJoined false when the required agent is absent from the joined list', () => {
      const bridge = new MatrixBridge();
      bridge._requiredMembershipSummary.set('!health-detail-2:test', {
        roomId: '!health-detail-2:test', group: 'acceptance', requiredAgent: 'reviewer-agent',
        botJoined: true, agentJoined: null, joinedAgentNames: [],
      });

      bridge._recordMembershipDetail('!health-detail-2:test', ['someone-else-agent']);

      expect(bridge._requiredMembershipSummary.get('!health-detail-2:test').agentJoined).toBe(false);
    });

    test('_recordMembershipDetail leaves agentJoined null for a group room with no single required agent', () => {
      const bridge = new MatrixBridge();
      bridge._requiredMembershipSummary.set('!health-detail-3:test', {
        roomId: '!health-detail-3:test', group: 'acceptance', requiredAgent: null,
        botJoined: true, agentJoined: null, joinedAgentNames: [],
      });

      bridge._recordMembershipDetail('!health-detail-3:test', ['reviewer-agent', 'coordinator-agent']);

      const entry = bridge._requiredMembershipSummary.get('!health-detail-3:test');
      expect(entry.joinedAgentNames).toEqual(['reviewer-agent', 'coordinator-agent']);
      expect(entry.agentJoined).toBeNull();
    });

    test('_recordMembershipDetail is a no-op for a room with no existing summary entry', () => {
      const bridge = new MatrixBridge();
      expect(() => bridge._recordMembershipDetail('!health-detail-unknown:test', ['x'])).not.toThrow();
      expect(bridge._requiredMembershipSummary.has('!health-detail-unknown:test')).toBe(false);
    });

    test('_syncRequiredMembershipBotPresence builds one entry per trusted managed room, reflecting current joined-room membership', () => {
      const bridge = new MatrixBridge();
      markRoomTrusted('!health-scan-a:test', { group: 'acceptance' });
      markRoomTrusted('!health-scan-b:test', { agent: 'reviewer-agent' });

      bridge._syncRequiredMembershipBotPresence(['!health-scan-a:test']); // bot currently joined to scan-a only

      const summary = new Map(bridge._requiredMembershipSummary);
      expect(summary.get('!health-scan-a:test')).toMatchObject({
        roomId: '!health-scan-a:test', group: 'acceptance', requiredAgent: null, botJoined: true,
      });
      expect(summary.get('!health-scan-b:test')).toMatchObject({
        roomId: '!health-scan-b:test', requiredAgent: 'reviewer-agent', botJoined: false,
      });
    });

    test('_syncRequiredMembershipBotPresence preserves previously recorded agent-membership detail across a refresh', () => {
      const bridge = new MatrixBridge();
      markRoomTrusted('!health-scan-c:test', { group: 'acceptance' });
      bridge._requiredMembershipSummary.set('!health-scan-c:test', {
        roomId: '!health-scan-c:test', group: 'acceptance', requiredAgent: null, botJoined: true,
        agentJoined: null, joinedAgentNames: ['reviewer-agent'],
      });

      bridge._syncRequiredMembershipBotPresence(['!health-scan-c:test']);

      expect(bridge._requiredMembershipSummary.get('!health-scan-c:test').joinedAgentNames).toEqual(['reviewer-agent']);
    });

    test('_syncRequiredMembershipBotPresence skips DM and bot-DM rooms (summary covers group/managed-agent rooms only)', () => {
      const bridge = new MatrixBridge();
      markRoomTrusted('!health-scan-dm:test', { dm: true });
      markRoomTrusted('!health-scan-botdm:test', { botDm: true, human: 'alice' });

      bridge._syncRequiredMembershipBotPresence(['!health-scan-dm:test', '!health-scan-botdm:test']);

      expect(bridge._requiredMembershipSummary.has('!health-scan-dm:test')).toBe(false);
      expect(bridge._requiredMembershipSummary.has('!health-scan-botdm:test')).toBe(false);
    });

    test('writeHealthRecord persists a bridge health record reflecting in-memory state, with restrictive permissions', () => {
      const bridge = new MatrixBridge();
      bridge._lastSuccessfulSyncAtMs = Date.now() - 500;
      bridge._requiredMembershipSummary.set('!health-write-a:test', {
        roomId: '!health-write-a:test', group: 'acceptance', requiredAgent: 'reviewer-agent',
        botJoined: true, agentJoined: true, joinedAgentNames: ['reviewer-agent'],
      });

      bridge.writeHealthRecord();

      const healthPath = path.join(runtimeDir, 'data', 'health', 'matrix-bridge.json');
      const written = JSON.parse(readFileSync(healthPath, 'utf8'));
      expect(written.component).toBe('matrix-bridge');
      expect(written.process.pid).toBe(process.pid);
      expect(typeof written.lastSuccessfulSyncAt).toBe('string');
      expect(written.managedRoomCount).toBeGreaterThanOrEqual(1);
      expect(written.requiredMembership.some((entry) => entry.roomId === '!health-write-a:test' && entry.agentJoined === true)).toBe(true);
      expect(statSync(healthPath).mode & 0o777).toBe(0o600);
    });

    test('writeHealthRecord reflects a recent successful backend delivery after a successful backend API call', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{"ok":true}' }));
      const bridge = new MatrixBridge();

      await bridge.callBackendApi('GET', '/api/agents?view=names');
      bridge.writeHealthRecord();

      const healthPath = path.join(runtimeDir, 'data', 'health', 'matrix-bridge.json');
      const written = JSON.parse(readFileSync(healthPath, 'utf8'));
      expect(written.lastSuccessfulBackendDeliveryAt).not.toBeNull();
      expect(Date.now() - new Date(written.lastSuccessfulBackendDeliveryAt).getTime()).toBeLessThan(5000);
    });

    test('writeHealthRecord reflects the shared rate-limit gate\'s last-observed-429 timestamp', () => {
      const bridge = new MatrixBridge();
      const rateLimitError = new Error('rate limited');
      rateLimitError.statusCode = 429;
      matrixRateLimitGateForTest.observeError(rateLimitError);

      bridge.writeHealthRecord();

      const healthPath = path.join(runtimeDir, 'data', 'health', 'matrix-bridge.json');
      const written = JSON.parse(readFileSync(healthPath, 'utf8'));
      expect(written.lastObservedRateLimitAt).not.toBeNull();
      expect(Date.now() - new Date(written.lastObservedRateLimitAt).getTime()).toBeLessThan(5000);
    });
  });
});

// Bridge-side half of "bridge secret missing or mismatched fails closed" (Task 6 row 4).
// The backend's half (missing/wrong X-Bridge-Secret on /api/messages -> 503/401) is covered by
// tests/api-messages.test.js ("Matrix ingestion fails closed when bridge secret or event id is
// missing") and tests/api-provenance.test.js ("wrong bridge secret rejects senderMxid +
// trustLevel", "missing bridge secret header rejects..."). This is the bridge process's own
// guard: it refuses to even start when it has no secret to send, rather than relying solely on
// the backend to reject its (unauthenticated) requests.
describe('bridge start() fails closed without a bridge secret', () => {
  test('start() rejects immediately when MATRIX_BRIDGE_SECRET is unset', async () => {
    const runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-bridge-no-secret-'));
    const envSnapshot = snapshotEnv(['HAFLEET_RUNTIME_DIR', 'MATRIX_BRIDGE_SECRET']);
    process.env.HAFLEET_RUNTIME_DIR = runtimeDir;
    delete process.env.MATRIX_BRIDGE_SECRET;
    try {
      const bridgeUrl = pathToFileURL(path.resolve('bridge-matrix.js')).href;
      const cacheBust = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const { MatrixBridge: NoSecretMatrixBridge } = await import(`${bridgeUrl}?no-bridge-secret=${cacheBust}`);
      const bridge = new NoSecretMatrixBridge();

      await expect(bridge.start()).rejects.toThrow(/MATRIX_BRIDGE_SECRET is required/);
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
      restoreEnv(envSnapshot);
    }
  });
});
