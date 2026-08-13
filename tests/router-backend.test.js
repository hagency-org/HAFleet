import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('thread-session backend integration', () => {
  let context;

  beforeAll(async () => {
    context = await createBackendTestContext('hafleet-router-backend-', {
      env: {
        HAFLEET_THREAD_SESSIONS: '1',
        HAFLEET_ROUTER_TASK_CUTOVER: '1',
        HAFLEET_CODEX_RUNNER_BIN: path.join(fixtures, 'fake-codex-app-server.mjs'),
        HAFLEET_APPROVAL_TTL_MS: '900000',
        MATRIX_BRIDGE_SECRET: 'router-bridge-secret',
        API_TOKEN: 'router-api-token',
      },
      groups: {
        robrix2: { name: 'robrix2', members: ['worker'], createdAt: 1 },
        frontdesk: { name: 'frontdesk', members: ['coordinator', 'worker'], createdAt: 2 },
      },
      agents: {
        worker: {
          name: 'worker', agentId: 'agent_worker', type: 'codex', role: 'coding',
          kind: 'agent', workdir: process.cwd(), workspaceMode: 'shared', online: true,
        },
        multiroom_worker: {
          name: 'multiroom_worker', agentId: 'agent_multiroom_worker', type: 'codex', role: 'coding',
          kind: 'agent', workdir: process.cwd(), workspaceMode: 'shared', online: true,
        },
        coordinator: {
          name: 'coordinator', agentId: 'agent_coordinator', type: 'claude', role: 'architect',
          kind: 'agent', workdir: process.cwd(), workspaceMode: 'shared', online: true,
        },
        coordinator_gap: {
          name: 'coordinator_gap', agentId: 'agent_coordinator_gap', type: 'claude', role: 'architect',
          kind: 'agent', workdir: process.cwd(), workspaceMode: 'shared', online: true,
        },
        multiroom_coordinator: {
          name: 'multiroom_coordinator', agentId: 'agent_multiroom_coordinator', type: 'claude', role: 'architect',
          kind: 'agent', workdir: process.cwd(), workspaceMode: 'shared', online: true,
        },
        remote_worker: {
          name: 'remote_worker', agentId: 'agent_remote', type: 'codex', role: 'coding',
          kind: 'agent', workdir: process.cwd(), server: 'remote-server', online: true,
        },
        octos_worker: {
          name: 'octos_worker', agentId: 'agent_octos', type: 'octos', role: 'coding',
          kind: 'agent', workdir: process.cwd(), online: true,
        },
        broken_worker: {
          name: 'broken_worker', agentId: 'agent_broken', type: 'codex', role: 'coding',
          kind: 'agent', workdir: fixtures,
          worktreesDir: path.join(fixtures, 'worktrees-never-created'), workspaceMode: 'worktree', online: true,
        },
      },
      agentTokens: {
        worker: 'worker-router-token', coordinator: 'coordinator-router-token',
        multiroom_worker: 'multiroom-worker-router-token',
        coordinator_gap: 'coordinator-gap-router-token',
        multiroom_coordinator: 'multiroom-coordinator-router-token',
        remote_worker: 'remote-router-token', octos_worker: 'octos-router-token',
        broken_worker: 'broken-router-token',
      },
    });
  });

  afterAll(() => {
    context.internals.routerStoreForTest?.close();
    context.cleanup();
  });

  test('runner workspace configuration is not settable through the agent API', async () => {
    // Workspace/runner config comes from the agent record (agents.json /
    // provision flows), never from the self-report API: the fields are
    // ignored on both create and patch, for agent tokens and operator
    // bearers alike, so the API cannot become a write path for it. A
    // dedicated operator runner-config route is future work.
    const created = await request(context.app)
      .post('/api/agents')
      .set('Authorization', 'Bearer router-api-token')
      .send({
        name: 'config-probe-agent', type: 'codex', workdir: process.cwd(),
        workspace_mode: 'worktree', worktrees_dir: path.join(process.cwd(), '.hafleet-worktrees'),
        worktree_bootstrap: ['/usr/bin/true'],
      });
    expect(created.status).toBe(200);
    expect(created.body.agent.workspaceMode ?? 'shared').toBe('shared');
    expect(created.body.agent.worktreesDir ?? null).toBeNull();

    const patched = await request(context.app)
      .patch('/api/agents/worker')
      .set('X-Agent-Token', 'worker-router-token')
      .send({ worktree_bootstrap: ['/usr/bin/true'] });
    expect(patched.status).toBe(200);
    expect(patched.body.agent.worktreeBootstrap ?? []).toEqual([]);
  });

  test('test_direct_worker_mention_uses_confirmed_task_thread_path', async () => {
    const accepted = await request(context.app)
      .post('/api/messages')
      .set('X-Bridge-Secret', 'router-bridge-secret')
      .send({
        from: 'alice', group: 'robrix2', type: 'human', source: 'matrix',
        summary: '@worker implement isolated sessions', full: '@worker implement isolated sessions',
        mentions: ['worker'], source_room: '!robrix2:test', source_event_id: '$human-root',
        sender_mxid: '@alice:test',
      });
    expect(accepted.status).toBe(200);

    const claim = await request(context.app)
      .post('/api/router/matrix-outbox/claim')
      .set('X-Bridge-Secret', 'router-bridge-secret')
      .send({ claim_ms: 30_000 });
    expect(claim.status).toBe(200);
    expect(claim.body.command).toMatchObject({
      roomId: '!robrix2:test', threadRootEventId: '$human-root', senderAgentName: 'worker',
    });
    expect(context.internals.routerStoreForTest.snapshot().dispatches).toHaveLength(0);

    const activated = await request(context.app)
      .post(`/api/router/matrix-outbox/${claim.body.command.commandId}/delivered`)
      .set('X-Bridge-Secret', 'router-bridge-secret')
      .send({ claim_token: claim.body.command.claimToken, event_id: '$agent-anchor' });
    expect(activated.status).toBe(200);
    expect(activated.body.activation).toMatchObject({
      agentId: 'agent_worker', roomId: '!robrix2:test',
      threadRootEventId: '$human-root', threadAnchorEventId: '$agent-anchor',
    });

    let reply = null;
    for (let attempt = 0; attempt < 50 && !reply; attempt += 1) {
      const response = await request(context.app)
        .post('/api/router/reply-outbox/claim')
        .set('X-Bridge-Secret', 'router-bridge-secret')
        .send({ claim_ms: 30_000 });
      if (response.status === 200) reply = response.body.command;
      else await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(reply).toMatchObject({
      roomId: '!robrix2:test', threadRootEventId: '$human-root',
      senderAgentName: 'worker', body: 'denied result',
    });
  });

  test('explicit /task promotes exactly once and never enters the coordinator front-desk session', async () => {
    const accepted = await request(context.app)
      .post('/api/messages')
      .set('X-Bridge-Secret', 'router-bridge-secret')
      .send({
        from: 'alice', group: 'frontdesk', type: 'human', source: 'matrix',
        summary: '/task @coordinator @worker fix the isolated bug',
        full: '/task @coordinator @worker fix the isolated bug',
        mentions: ['coordinator', 'worker'], source_room: '!explicit:test',
        source_event_id: '$explicit-root', sender_mxid: '@alice:test',
      });
    expect(accepted.status).toBe(200);

    expect(context.internals.routerStoreForTest.snapshot().sessions
      .filter((row) => row.roomId === '!explicit:test')).toHaveLength(0);

    const claim = await request(context.app)
      .post('/api/router/matrix-outbox/claim')
      .set('X-Bridge-Secret', 'router-bridge-secret')
      .send({ claim_ms: 30_000 });
    expect(claim.status).toBe(200);
    expect(claim.body.command).toMatchObject({
      roomId: '!explicit:test',
      threadRootEventId: '$explicit-root',
      senderAgentName: 'worker',
    });
    const delivered = await request(context.app)
      .post(`/api/router/matrix-outbox/${claim.body.command.commandId}/delivered`)
      .set('X-Bridge-Secret', 'router-bridge-secret')
      .send({ claim_token: claim.body.command.claimToken, event_id: '$explicit-anchor' });
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
    expect(delivered.body.activation).toMatchObject({
      agentId: 'agent_worker',
      roomId: '!explicit:test',
      threadRootEventId: '$explicit-root',
      threadAnchorEventId: '$explicit-anchor',
    });
    const explicitSessions = context.internals.routerStoreForTest.snapshot().sessions
      .filter((row) => row.roomId === '!explicit:test');
    expect(explicitSessions).toHaveLength(1);
    expect(explicitSessions[0]).toMatchObject({
      agentId: 'agent_worker',
      scopeKind: 'thread',
      threadRootEventId: '$explicit-root',
    });
  });

  async function expectUnsupportedAgent(agent, status, code) {
    const response = await request(context.app)
      .post('/api/messages')
      .set('X-Bridge-Secret', 'router-bridge-secret')
      .send({
        from: 'alice', to: agent, target_type: 'agent', type: 'human', source: 'matrix',
        summary: `@${agent} work`, full: `@${agent} work`, mentions: [agent],
        source_room: '!robrix2:test', source_event_id: `$unsupported-${agent}`,
        sender_mxid: '@alice:test',
      });
    expect(response.status).toBe(status);
    expect(response.body.error).toContain(code);
    expect(context.internals.routerStoreForTest.snapshot().dispatches
      .filter((row) => row.state === 'queued')).toHaveLength(0);
  }

  test('test_remote_agent_rejected_from_thread_session_dispatch', async () => {
    await expectUnsupportedAgent('remote_worker', 422, 'remote_runner_unsupported');
  });

  test('test_octos_agent_rejected_from_thread_session_dispatch', async () => {
    await expectUnsupportedAgent('octos_worker', 422, 'unsupported_framework');
  });

  test('thread-session inbox HTTP fails closed without a complete capability and returns one session with it', async () => {
    const router = context.internals.routerStoreForTest;
    const first = router.ingestMessage({
      messageId: 'http-inbox-a', roomId: '!http-inbox-a:test', matrixEventId: '$http-inbox-a',
      senderName: 'alice', recipientAgentId: 'agent_worker', recipientAgentName: 'worker',
      normalizedBody: 'private content for session A',
    });
    router.ingestMessage({
      messageId: 'http-inbox-b', roomId: '!http-inbox-b:test', matrixEventId: '$http-inbox-b',
      senderName: 'bob', recipientAgentId: 'agent_worker', recipientAgentName: 'worker',
      normalizedBody: 'private content for session B',
    });
    router.registerWorkspace({
      resourceId: 'http-inbox-workspace', safeLabel: 'HTTP inbox workspace', backendPath: process.cwd(),
    });
    const queued = router.enqueueDispatch({
      sessionId: first.session.sessionId, framework: 'codex', localServerId: 'local',
      workspaceResourceId: 'http-inbox-workspace', mayWrite: false, payload: {},
    });
    const claim = router.claimDispatch({
      runnerId: 'http-inbox-runner', leaseMs: 60_000,
      capabilityTtlMs: 60_000, maxLiveRunners: 8,
    });
    expect(claim).toMatchObject({ ok: true, dispatchId: queued.dispatchId });
    expect(router.takePayload(claim)).toMatchObject({ ok: true });

    const tokenOnly = await request(context.app)
      .get('/api/inbox/worker')
      .set('X-Agent-Token', 'worker-router-token');
    expect(tokenOnly.status).toBe(401);
    expect(tokenOnly.body.code).toBe('runner_capability_required');

    const partial = await request(context.app)
      .get('/api/inbox/worker')
      .set('X-Agent-Token', 'worker-router-token')
      .set('X-HAFleet-Dispatch-Id', claim.dispatchId);
    expect(partial.status).toBe(401);
    expect(partial.body.code).toBe('runner_capability_required');

    const scoped = await request(context.app)
      .get('/api/inbox/worker')
      .set('X-Agent-Token', 'worker-router-token')
      .set('X-HAFleet-Dispatch-Capability', claim.capability)
      .set('X-HAFleet-Dispatch-Id', claim.dispatchId)
      .set('X-HAFleet-Runner-Id', claim.runnerId)
      .set('X-HAFleet-Fence-Generation', String(claim.fenceGeneration));
    expect(scoped.status).toBe(200);
    expect(scoped.body.session_scoped).toBe(true);
    expect(scoped.body.dm.map((message) => message.id)).toContain('http-inbox-a');
    expect(scoped.body.dm.map((message) => message.id)).not.toContain('http-inbox-b');

    expect(router.settleAndRelease({
      dispatchId: claim.dispatchId, runnerId: claim.runnerId,
      fenceGeneration: claim.fenceGeneration, capability: claim.capability,
      outcome: 'completed', output: { text: 'session A handled' },
    })).toMatchObject({ ok: true, state: 'completed' });
  });

  test('Codex runner approval timeout is derived from the configured server TTL', () => {
    expect(context.internals.approvalAdapterTimeoutMsForTest).toBe(960_000);
  });

  test('Codex owner approval selects the dispatch room when one agent has multiple owner bindings', async () => {
    for (const binding of [
      {
        agent: 'multiroom_worker', project: 'room-a', project_room_id: '!approval-room-a:test',
        owner_mxid: '@owner-a:test', owner_dm_room_id: '!owner-a:test',
      },
      {
        agent: 'multiroom_worker', project: 'room-b', project_room_id: '!approval-room-b:test',
        owner_mxid: '@owner-b:test', owner_dm_room_id: '!owner-b:test',
      },
    ]) {
      const response = await request(context.app)
        .put('/api/approval-bindings')
        .set('X-Bridge-Secret', 'router-bridge-secret')
        .send(binding);
      expect(response.status).toBe(200);
    }

    const accepted = await request(context.app)
      .post('/api/messages')
      .set('X-Bridge-Secret', 'router-bridge-secret')
      .send({
        from: 'alice', to: 'multiroom_worker', target_type: 'agent', type: 'human', source: 'matrix',
        summary: '@multiroom_worker perform protected work',
        full: '@multiroom_worker perform protected work', mentions: ['multiroom_worker'],
        source_room: '!approval-room-a:test', source_event_id: '$multiroom-root',
        sender_mxid: '@alice:test',
      });
    expect(accepted.status).toBe(200);
    const command = await request(context.app)
      .post('/api/router/matrix-outbox/claim')
      .set('X-Bridge-Secret', 'router-bridge-secret')
      .send({ claim_ms: 30_000 });
    expect(command.status).toBe(200);
    const delivered = await request(context.app)
      .post(`/api/router/matrix-outbox/${command.body.command.commandId}/delivered`)
      .set('X-Bridge-Secret', 'router-bridge-secret')
      .send({ claim_token: command.body.command.claimToken, event_id: '$multiroom-anchor' });
    expect(delivered.status).toBe(200);

    let approval = null;
    for (let attempt = 0; attempt < 100 && !approval; attempt += 1) {
      approval = context.internals.approvalStoreForTest.listRequests({ status: 'pending' })
        .find((row) => row.agent === 'multiroom_worker') || null;
      if (!approval) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(approval).toMatchObject({
      status: 'pending', project: 'room-a', project_room_id: '!approval-room-a:test',
      owner_mxid: '@owner-a:test', owner_dm_room_id: '!owner-a:test',
    });
    const verdict = await request(context.app)
      .post(`/api/approvals/${approval.id}/verdict`)
      .set('X-Bridge-Secret', 'router-bridge-secret')
      .send({
        sender_mxid: '@owner-a:test', room_id: '!owner-a:test', agent: 'multiroom_worker',
        project: 'room-a', project_room_id: '!approval-room-a:test',
        input_digest: approval.input_digest, action: 'approve_once', event_id: '$multiroom-verdict',
      });
    expect(verdict.status).toBe(200);

    let completed = null;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      completed = context.internals.routerStoreForTest.snapshot().dispatches.find(
        (row) => row.taskId === delivered.body.activation.taskId,
      );
      if (completed?.state === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(completed).toMatchObject({ state: 'completed' });
    expect(context.internals.approvalStoreForTest.getRequest(approval.id)).toMatchObject({
      status: 'consumed', project_room_id: '!approval-room-a:test',
    });
    expect(context.internals.routerStoreForTest.db.prepare(
      `SELECT r.room_id, r.thread_root_event_id, r.body
       FROM reply_outbox r JOIN dispatches d ON d.dispatch_id = r.dispatch_id
       WHERE d.task_id = ?`,
    ).get(delivered.body.activation.taskId)).toMatchObject({
      room_id: '!approval-room-a:test', thread_root_event_id: '$multiroom-root', body: 'approved result',
    });
  });

  test('confirmed task with unavailable workspace stays visible and never becomes a Matrix delivery failure', async () => {
    const accepted = await request(context.app)
      .post('/api/messages')
      .set('X-Bridge-Secret', 'router-bridge-secret')
      .send({
        from: 'alice', to: 'broken_worker', target_type: 'agent', type: 'human', source: 'matrix',
        summary: '@broken_worker use a missing worktree', full: '@broken_worker use a missing worktree',
        mentions: ['broken_worker'], source_room: '!broken:test', source_event_id: '$broken-root',
        sender_mxid: '@alice:test',
      });
    expect(accepted.status).toBe(200);
    const claim = await request(context.app)
      .post('/api/router/matrix-outbox/claim')
      .set('X-Bridge-Secret', 'router-bridge-secret')
      .send({ claim_ms: 30_000 });
    expect(claim.status).toBe(200);
    const delivered = await request(context.app)
      .post(`/api/router/matrix-outbox/${claim.body.command.commandId}/delivered`)
      .set('X-Bridge-Secret', 'router-bridge-secret')
      .send({ claim_token: claim.body.command.claimToken, event_id: '$broken-anchor' });
    expect(delivered.status).toBe(200);
    expect(delivered.body).toMatchObject({
      ok: true,
      dispatch: null,
      dispatch_refusal: { code: 'resource_unavailable' },
      attention: { ok: true, state: 'blocked' },
    });
    const snapshot = context.internals.routerStoreForTest.snapshot();
    expect(snapshot.dispatches.filter((row) => row.taskId === delivered.body.activation.taskId)).toHaveLength(0);
    expect(snapshot.tasks.find((row) => row.taskId === delivered.body.activation.taskId))
      .toMatchObject({ status: 'blocked' });
    expect(context.internals.routerStoreForTest.db.prepare(
      'SELECT room_id, thread_root_event_id, sender_agent_name, body FROM notice_outbox WHERE task_id = ?',
    ).get(delivered.body.activation.taskId)).toMatchObject({
      room_id: '!broken:test',
      thread_root_event_id: '$broken-root',
      sender_agent_name: 'broken_worker',
      body: expect.stringContaining('execution could not start'),
    });
  });

  test('Claude owner approval is parked, consumed, applied, and resumed under one dispatch capability', async () => {
    const router = context.internals.routerStoreForTest;
    const ingested = router.ingestMessage({
      messageId: 'claude-approval-input', roomId: '!approval:test', matrixEventId: '$approval-input',
      senderName: 'alice', recipientAgentId: 'agent_coordinator', recipientAgentName: 'coordinator',
      normalizedBody: 'coordinate with an approved operation',
    });
    router.registerWorkspace({ resourceId: 'coordinator-workspace', safeLabel: 'coordinator', backendPath: process.cwd() });
    const queued = router.enqueueDispatch({
      sessionId: ingested.session.sessionId, framework: 'claude', localServerId: 'local',
      workspaceResourceId: 'coordinator-workspace', mayWrite: false, payload: {},
    });
    const claim = router.claimDispatch({
      runnerId: 'claude-approval-runner', leaseMs: 60_000,
      capabilityTtlMs: 60_000, maxLiveRunners: 8,
    });
    router.takePayload(claim);
    const capabilityHeaders = {
      'X-Agent-Token': 'coordinator-router-token',
      'X-HAFleet-Dispatch-Capability': claim.capability,
      'X-HAFleet-Dispatch-Id': claim.dispatchId,
      'X-HAFleet-Runner-Id': claim.runnerId,
      'X-HAFleet-Fence-Generation': String(claim.fenceGeneration),
    };
    const binding = {
      agent: 'coordinator', project: 'robrix2', project_room_id: '!approval:test',
      owner_mxid: '@alex:test', owner_dm_room_id: '!owner:test',
    };
    expect((await request(context.app)
      .put('/api/approval-bindings')
      .set('X-Bridge-Secret', 'router-bridge-secret')
      .send(binding)).status).toBe(200);
    const parked = await request(context.app)
      .post('/api/router/approvals/claude')
      .set(capabilityHeaders)
      .send({
        agent: 'coordinator', request_id: 'claude-request-1', tool_name: 'Bash',
        description: 'protected action', input_preview: '{"command":"safe"}',
      });
    expect(parked.status).toBe(201);
    expect(router.snapshot().dispatches.find((row) => row.dispatchId === queued.dispatchId)?.state).toBe('parked');
    const approval = parked.body.approval;
    const verdict = await request(context.app)
      .post(`/api/approvals/${approval.id}/verdict`)
      .set('X-Bridge-Secret', 'router-bridge-secret')
      .send({
        sender_mxid: '@alex:test', room_id: '!owner:test', agent: 'coordinator',
        project: 'robrix2', project_room_id: '!approval:test',
        input_digest: approval.input_digest, action: 'approve_once', event_id: '$approval-verdict',
      });
    expect(verdict.status).toBe(200);
    const consumed = await request(context.app)
      .post(`/api/approvals/${approval.id}/consume`)
      .set('X-Agent-Token', 'coordinator-router-token')
      .send({ agent: 'coordinator', input_digest: approval.input_digest });
    expect(consumed.status).toBe(200);
    const applied = await request(context.app)
      .post('/api/router/approvals/claude/apply')
      .set(capabilityHeaders)
      .send({
        agent: 'coordinator', approval_request_id: approval.id,
        router_approval_id: parked.body.router_approval_id,
        operation_digest: parked.body.operation_digest,
      });
    expect(applied.status).toBe(200);
    expect(applied.body.behavior).toBe('allow');
    expect(router.snapshot().dispatches.find((row) => row.dispatchId === queued.dispatchId)?.state).toBe('started');
    expect(router.settleAndRelease({
      dispatchId: claim.dispatchId, runnerId: claim.runnerId,
      fenceGeneration: claim.fenceGeneration, capability: claim.capability,
      outcome: 'completed', output: { text: 'approved' },
    })).toMatchObject({ ok: true, state: 'completed' });
  });

  test('Claude owner approval selects the dispatch room when one agent has multiple owner bindings', async () => {
    const router = context.internals.routerStoreForTest;
    for (const binding of [
      {
        agent: 'multiroom_coordinator', project: 'claude-room-a', project_room_id: '!claude-room-a:test',
        owner_mxid: '@claude-owner-a:test', owner_dm_room_id: '!claude-owner-a:test',
      },
      {
        agent: 'multiroom_coordinator', project: 'claude-room-b', project_room_id: '!claude-room-b:test',
        owner_mxid: '@claude-owner-b:test', owner_dm_room_id: '!claude-owner-b:test',
      },
    ]) {
      expect((await request(context.app)
        .put('/api/approval-bindings')
        .set('X-Bridge-Secret', 'router-bridge-secret')
        .send(binding)).status).toBe(200);
    }
    const ingested = router.ingestMessage({
      messageId: 'multiroom-claude-input', roomId: '!claude-room-a:test', matrixEventId: '$multiroom-claude-input',
      senderName: 'alice', recipientAgentId: 'agent_multiroom_coordinator', recipientAgentName: 'multiroom_coordinator',
      normalizedBody: 'perform an operation in room A',
    });
    router.registerWorkspace({
      resourceId: 'multiroom-claude-workspace', safeLabel: 'multiroom coordinator', backendPath: process.cwd(),
    });
    const queued = router.enqueueDispatch({
      sessionId: ingested.session.sessionId, framework: 'claude', localServerId: 'local',
      workspaceResourceId: 'multiroom-claude-workspace', mayWrite: false, payload: {},
    });
    const claim = router.claimDispatch({
      runnerId: 'multiroom-claude-runner', leaseMs: 60_000,
      capabilityTtlMs: 60_000, maxLiveRunners: 8,
    });
    expect(claim).toMatchObject({ ok: true, dispatchId: queued.dispatchId });
    expect(router.takePayload(claim)).toMatchObject({ ok: true });
    const capabilityHeaders = {
      'X-Agent-Token': 'multiroom-coordinator-router-token',
      'X-HAFleet-Dispatch-Capability': claim.capability,
      'X-HAFleet-Dispatch-Id': claim.dispatchId,
      'X-HAFleet-Runner-Id': claim.runnerId,
      'X-HAFleet-Fence-Generation': String(claim.fenceGeneration),
    };
    const parked = await request(context.app)
      .post('/api/router/approvals/claude')
      .set(capabilityHeaders)
      .send({
        agent: 'multiroom_coordinator', request_id: 'multiroom-claude-request',
        tool_name: 'Bash', description: 'room-scoped operation', input_preview: '{"command":"safe"}',
      });
    expect(parked.status).toBe(201);
    expect(parked.body.approval).toMatchObject({
      status: 'pending', project: 'claude-room-a', project_room_id: '!claude-room-a:test',
      owner_mxid: '@claude-owner-a:test', owner_dm_room_id: '!claude-owner-a:test',
    });
    const approval = parked.body.approval;
    expect((await request(context.app)
      .post(`/api/approvals/${approval.id}/verdict`)
      .set('X-Bridge-Secret', 'router-bridge-secret')
      .send({
        sender_mxid: '@claude-owner-a:test', room_id: '!claude-owner-a:test',
        agent: 'multiroom_coordinator', project: 'claude-room-a',
        project_room_id: '!claude-room-a:test', input_digest: approval.input_digest,
        action: 'approve_once', event_id: '$multiroom-claude-verdict',
      })).status).toBe(200);
    expect((await request(context.app)
      .post(`/api/approvals/${approval.id}/consume`)
      .set('X-Agent-Token', 'multiroom-coordinator-router-token')
      .send({ agent: 'multiroom_coordinator', input_digest: approval.input_digest })).status).toBe(200);
    expect((await request(context.app)
      .post('/api/router/approvals/claude/apply')
      .set(capabilityHeaders)
      .send({
        agent: 'multiroom_coordinator', approval_request_id: approval.id,
        router_approval_id: parked.body.router_approval_id,
        operation_digest: parked.body.operation_digest,
      })).status).toBe(200);
    expect(router.settleAndRelease({
      ...claim, outcome: 'completed', output: { text: 'approved in room A' },
    })).toMatchObject({ ok: true, state: 'completed' });
  });

  test('test_consumed_approval_is_not_delivered_before_router_application', async () => {
    const router = context.internals.routerStoreForTest;
    const ingested = router.ingestMessage({
      messageId: 'approval-gap-input', roomId: '!approval-gap:test', matrixEventId: '$approval-gap-input',
      senderName: 'alice', recipientAgentId: 'agent_coordinator_gap', recipientAgentName: 'coordinator_gap',
      normalizedBody: 'exercise the consumed-but-not-applied gap',
    });
    router.registerWorkspace({ resourceId: 'approval-gap-workspace', safeLabel: 'approval gap', backendPath: process.cwd() });
    const queued = router.enqueueDispatch({
      sessionId: ingested.session.sessionId, framework: 'claude', localServerId: 'local',
      workspaceResourceId: 'approval-gap-workspace', mayWrite: false, payload: {},
    });
    const claim = router.claimDispatch({
      runnerId: 'approval-gap-runner', leaseMs: 60_000,
      capabilityTtlMs: 60_000, maxLiveRunners: 8,
    });
    router.takePayload(claim);
    const headers = {
      'X-Agent-Token': 'coordinator-gap-router-token',
      'X-HAFleet-Dispatch-Capability': claim.capability,
      'X-HAFleet-Dispatch-Id': claim.dispatchId,
      'X-HAFleet-Runner-Id': claim.runnerId,
      'X-HAFleet-Fence-Generation': String(claim.fenceGeneration),
    };
    await request(context.app)
      .put('/api/approval-bindings')
      .set('X-Bridge-Secret', 'router-bridge-secret')
      .send({
        agent: 'coordinator_gap', project: 'robrix2-gap', project_room_id: '!approval-gap:test',
        owner_mxid: '@alex:test', owner_dm_room_id: '!owner:test',
      });
    const parked = await request(context.app)
      .post('/api/router/approvals/claude')
      .set(headers)
      .send({
        agent: 'coordinator_gap', request_id: 'approval-gap-request', tool_name: 'Bash',
        description: 'protected gap action', input_preview: '{"command":"safe"}',
      });
    expect(parked.status).toBe(201);
    const approval = parked.body.approval;
    expect((await request(context.app)
      .post(`/api/approvals/${approval.id}/verdict`)
      .set('X-Bridge-Secret', 'router-bridge-secret')
      .send({
        sender_mxid: '@alex:test', room_id: '!owner:test', agent: 'coordinator_gap',
        project: 'robrix2-gap', project_room_id: '!approval-gap:test',
        input_digest: approval.input_digest, action: 'approve_once', event_id: '$approval-gap-verdict',
      })).status).toBe(200);
    expect((await request(context.app)
      .post(`/api/approvals/${approval.id}/consume`)
      .set('X-Agent-Token', 'coordinator-gap-router-token')
      .send({ agent: 'coordinator_gap', input_digest: approval.input_digest })).status).toBe(200);
    expect(router.readApprovalDecision({
      dispatchId: claim.dispatchId, runnerId: claim.runnerId,
      fenceGeneration: claim.fenceGeneration, capability: claim.capability,
      approvalId: parked.body.router_approval_id, operationDigest: parked.body.operation_digest,
    })).toMatchObject({ ok: true, decision: null });
    const failedApply = await request(context.app)
      .post('/api/router/approvals/claude/apply')
      .set(headers)
      .send({
        agent: 'coordinator_gap', approval_request_id: approval.id,
        router_approval_id: parked.body.router_approval_id,
        operation_digest: '0'.repeat(64),
      });
    expect(failedApply.status).toBe(400);
    expect(router.snapshot().dispatches.find((row) => row.dispatchId === queued.dispatchId)?.state).toBe('parked');
    const applied = await request(context.app)
      .post('/api/router/approvals/claude/apply')
      .set(headers)
      .send({
        agent: 'coordinator_gap', approval_request_id: approval.id,
        router_approval_id: parked.body.router_approval_id,
        operation_digest: parked.body.operation_digest,
      });
    expect(applied.status).toBe(200);
    expect(applied.body.behavior).toBe('allow');
    expect(router.settleAndRelease({
      dispatchId: claim.dispatchId, runnerId: claim.runnerId,
      fenceGeneration: claim.fenceGeneration, capability: claim.capability,
      outcome: 'completed', output: { text: 'approval gap verified' },
    })).toMatchObject({ ok: true, state: 'completed' });
  });

  test('operator endpoints cancel queued work and clear inspected dirty state', async () => {
    const router = context.internals.routerStoreForTest;
    const ingested = router.ingestMessage({
      messageId: 'operator-cancel-input', roomId: '!operator:test', matrixEventId: '$operator-input',
      senderName: 'alice', recipientAgentId: 'agent_coordinator', recipientAgentName: 'coordinator',
      normalizedBody: 'cancel this queued request',
    });
    router.registerWorkspace({ resourceId: 'operator-workspace', safeLabel: 'operator workspace', backendPath: process.cwd() });
    const queued = router.enqueueDispatch({
      sessionId: ingested.session.sessionId, framework: 'claude', localServerId: 'local',
      workspaceResourceId: 'operator-workspace', mayWrite: false, payload: {},
    });
    const denied = await request(context.app).post(`/api/router/dispatches/${queued.dispatchId}/cancel`);
    expect(denied.status).toBe(401);
    const cancelled = await request(context.app)
      .post(`/api/router/dispatches/${queued.dispatchId}/cancel`)
      .set('Authorization', 'Bearer router-api-token');
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.result.state).toBe('cancelled_before_start');
    router.db.prepare("UPDATE resources SET dirty=1, dirty_reason='inspect me' WHERE resource_id='operator-workspace'").run();
    const cleared = await request(context.app)
      .post('/api/router/resources/operator-workspace/clear-dirty')
      .set('Authorization', 'Bearer router-api-token');
    expect(cleared.status).toBe(200);
    expect(router.inspectWorkspace('operator-workspace')).toMatchObject({ dirty: false });
  });

  test('authenticated outcome inspection recovers with a new dispatch and cannot bypass quarantine', async () => {
    const router = context.internals.routerStoreForTest;
    const root = router.storeTaskMessage({
      messageId: 'backend-recovery-root',
      roomId: '!backend-recovery:test',
      matrixEventId: '$backend-recovery-root',
      senderMxid: '@alice:test',
      senderName: 'alice',
      recipientAgentId: 'agent_worker',
      recipientAgentName: 'worker',
      normalizedBody: 'Start work that will need an inspected recovery.',
    });
    expect(root).toMatchObject({ ok: true });
    const intent = router.createTaskIntent({
      requestScope: 'backend-recovery-test',
      requestKey: '$backend-recovery-root',
      roomId: '!backend-recovery:test',
      threadRootEventId: '$backend-recovery-root',
      rootMessageId: 'backend-recovery-root',
      inputMessageIds: ['backend-recovery-root'],
      task: {
        title: 'Backend recovery test',
        assigneeAgentId: 'agent_worker',
        assigneeName: 'worker',
      },
    });
    expect(intent).toMatchObject({ ok: true });
    const matrixCommand = router.claimMatrixCommand();
    expect(matrixCommand).toMatchObject({ taskId: intent.taskId });
    const activated = router.recordMatrixDelivery({
      commandId: matrixCommand.commandId,
      claimToken: matrixCommand.claimToken,
      eventId: '$backend-recovery-anchor',
    });
    expect(activated).toMatchObject({ ok: true, taskId: intent.taskId });
    router.registerWorkspace({
      resourceId: 'backend-recovery-workspace',
      safeLabel: 'worker recovery workspace',
      backendPath: process.cwd(),
    });
    const original = router.enqueueDispatch({
      sessionId: activated.sessionId,
      taskId: activated.taskId,
      framework: 'codex',
      localServerId: 'local',
      workspaceResourceId: 'backend-recovery-workspace',
      mayWrite: true,
      payload: { kind: 'task_turn', rebuildTokenBudget: 12_000 },
    });
    expect(original).toMatchObject({ ok: true, state: 'queued' });
    const claim = router.claimDispatch({
      runnerId: 'backend-recovery-dead-runner',
      leaseMs: 60_000,
      capabilityTtlMs: 60_000,
      maxLiveRunners: 8,
    });
    const capability = {
      dispatchId: claim.dispatchId,
      runnerId: claim.runnerId,
      fenceGeneration: claim.fenceGeneration,
      capability: claim.capability,
    };
    expect(router.takePayload(capability)).toMatchObject({ ok: true });
    expect(router.settleAndRelease({
      ...capability,
      outcome: 'outcome_unknown',
      reason: 'backend_test_runner_died_after_start',
    })).toMatchObject({ ok: true, state: 'outcome_unknown' });

    const unauthenticated = await request(context.app)
      .post(`/api/router/dispatches/${original.dispatchId}/outcome-inspection`);
    expect(unauthenticated.status).toBe(401);
    const bypass = await request(context.app)
      .post('/api/router/resources/backend-recovery-workspace/clear-dirty')
      .set('Authorization', 'Bearer router-api-token');
    expect(bypass.status).toBe(409);
    expect(bypass.body.code).toBe('inspection_required');

    const inspected = await request(context.app)
      .post(`/api/router/dispatches/${original.dispatchId}/outcome-inspection`)
      .set('Authorization', 'Bearer router-api-token');
    expect(inspected.status).toBe(201);
    expect(inspected.body.inspection).toMatchObject({
      dispatchId: original.dispatchId,
      resource: { safeLabel: 'worker recovery workspace', dirtyGeneration: 1 },
    });
    expect(JSON.stringify(inspected.body)).not.toContain(process.cwd());
    expect(router.db.prepare('SELECT token_hash FROM outcome_inspections WHERE inspection_id = ?')
      .get(inspected.body.inspection.inspectionId).token_hash)
      .not.toBe(inspected.body.inspection.inspectionToken);

    const recoveryBody = {
      inspection_id: inspected.body.inspection.inspectionId,
      inspection_token: inspected.body.inspection.inspectionToken,
      request_id: 'backend-recovery-resolution-1',
      action: 'continue',
      operator_note: 'Inspected git status and diff; the partial work is safe to continue.',
      recovery_instruction: 'Continue from the inspected partial work and finish the task without replaying prior commands.',
    };
    const recovered = await request(context.app)
      .post(`/api/router/dispatches/${original.dispatchId}/resolve-outcome`)
      .set('Authorization', 'Bearer router-api-token')
      .send(recoveryBody);
    expect(recovered.status).toBe(201);
    expect(recovered.body.resolution).toMatchObject({
      dispatchId: original.dispatchId,
      action: 'continue',
      replayed: false,
    });
    expect(recovered.body.resolution.replacementDispatchId).not.toBe(original.dispatchId);
    const replayed = await request(context.app)
      .post(`/api/router/dispatches/${original.dispatchId}/resolve-outcome`)
      .set('Authorization', 'Bearer router-api-token')
      .send(recoveryBody);
    expect(replayed.status).toBe(200);
    expect(replayed.body.resolution).toMatchObject({ replayed: true });

    let replacement = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      replacement = router.snapshot().dispatches.find(
        (row) => row.dispatchId === recovered.body.resolution.replacementDispatchId,
      );
      if (replacement?.state === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(replacement).toMatchObject({ state: 'completed' });
    expect(router.snapshot().dispatches.find((row) => row.dispatchId === original.dispatchId))
      .toMatchObject({ state: 'outcome_unknown', resolutionAction: 'continue' });
    expect(router.inspectWorkspace('backend-recovery-workspace')).toMatchObject({
      dirty: false,
      quarantinedByDispatchId: null,
    });
  });
});
