import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import request from 'supertest';
import { generateKeyPairSync, sign, verify, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  agentOpsGrantProofMaterial,
  agentOpsSessionProofMaterial,
  canonicalAgentOpsJson,
} from '../lib/agent-ops-client-auth.js';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const AUDIENCE = 'http://127.0.0.1:8090';
const OWNER = '@owner:test';
const OWNER_DM = '!approval:test';
const PROJECT_ROOM = '!project:test';
const DEVICE_ID = 'OWNERDEVICE';
const DEVICE_ED25519 = Buffer.alloc(32, 7).toString('base64').replace(/=+$/u, '');
const DEVICE_CURVE25519 = Buffer.alloc(32, 9).toString('base64').replace(/=+$/u, '');
const validateContract = new Ajv2020({ allErrors: true, strict: false }).compile(JSON.parse(
  readFileSync(new URL('../specs/fixtures/agent-ops-client-v1/contract.schema.json', import.meta.url), 'utf8'),
));

function expectCanonical(value) {
  expect(validateContract(value), JSON.stringify(validateContract.errors)).toBe(true);
}

function signature(privateKey, material) {
  return sign(null, Buffer.from(canonicalAgentOpsJson(material)), privateKey).toString('base64url');
}

function proofNonce(label = 'proof') {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe('scoped Agent Operations backend client boundary', () => {
  let context;
  let client;
  let session;
  let bootstrapGrant;
  let grantExchangeBody;
  let inspectionState;

  beforeAll(async () => {
    context = await createBackendTestContext('hafleet-agent-ops-client-', {
      env: {
        HAFLEET_THREAD_SESSIONS: '1',
        HAFLEET_ROUTER_TASK_CUTOVER: '1',
        HAFLEET_AGENT_OPS_CLIENT: '1',
        HAFLEET_AGENT_OPS_LOOPBACK_ORIGIN: AUDIENCE,
        MATRIX_BRIDGE_SECRET: 'agent-ops-bridge-secret',
        API_TOKEN: 'agent-ops-dashboard-token',
      },
      agents: {
        worker: {
          name: 'worker', agentId: 'agent_worker', type: 'codex', role: 'coding',
          kind: 'agent', workdir: process.cwd(), workspaceMode: 'shared', online: true,
        },
        other: {
          name: 'other', agentId: 'agent_other', type: 'codex', role: 'coding',
          kind: 'agent', workdir: process.cwd(), workspaceMode: 'shared', online: true,
        },
      },
      agentTokens: { worker: 'worker-token', other: 'other-token' },
    });
    context.internals.stopRouterPumpForTest();
    client = generateKeyPairSync('ed25519');

    const binding = await request(context.app)
      .put('/api/approval-bindings')
      .set('X-Bridge-Secret', 'agent-ops-bridge-secret')
      .send({
        agent: 'worker', project: 'project', project_room_id: PROJECT_ROOM,
        owner_mxid: OWNER, owner_dm_room_id: OWNER_DM,
      });
    expect(binding.status).toBe(200);

    const enrollment = await request(context.app)
      .put('/api/agent-ops/v1/operator/device-enrollment')
      .set('Authorization', 'Bearer agent-ops-dashboard-token')
      .send({
        agent: 'worker', project_room_id: PROJECT_ROOM,
        owner_mxid: OWNER, owner_dm_room_id: OWNER_DM,
        matrix_device_id: DEVICE_ID,
        matrix_device_ed25519: DEVICE_ED25519,
        matrix_device_curve25519: DEVICE_CURVE25519,
      });
    expect(enrollment.status, JSON.stringify(enrollment.body)).toBe(200);

    const clientPublicJwk = client.publicKey.export({ format: 'jwk' });
    const bootstrap = await request(context.app)
      .post('/api/agent-ops/v1/control/bootstrap')
      .set('X-Bridge-Secret', 'agent-ops-bridge-secret')
      .send({
        schema: 'com.hafleet.agent_ops.v1', agent: 'worker',
        project_room_id: PROJECT_ROOM, owner_mxid: OWNER, owner_dm_room_id: OWNER_DM,
        matrix_event_id: '$agent-ops-bootstrap', matrix_device_id: DEVICE_ID,
        matrix_device_ed25519: DEVICE_ED25519, matrix_device_curve25519: DEVICE_CURVE25519,
        client_nonce: 'client-bootstrap-nonce', client_public_jwk: clientPublicJwk,
        was_encrypted: true, device_self_signature_verified: true, room_members_verified: true,
      });
    expect(bootstrap.status, JSON.stringify(bootstrap.body)).toBe(201);
    bootstrapGrant = bootstrap.body;
    expectCanonical(bootstrap.body);
    expect(bootstrap.body).toMatchObject({
      schema: 'com.hafleet.agent_ops.v1', kind: 'client_session_grant',
      audience: AUDIENCE, client_nonce: 'client-bootstrap-nonce',
    });
    const serverUnsigned = { ...bootstrap.body };
    delete serverUnsigned.server_signature;
    delete serverUnsigned.idempotent_request_replay;
    expect(verify(
      null,
      Buffer.from(canonicalAgentOpsJson(serverUnsigned)),
      createPublicKey({ key: bootstrap.body.server_public_jwk, format: 'jwk' }),
      Buffer.from(bootstrap.body.server_signature, 'base64url'),
    )).toBe(true);

    const exchangeBody = {
      grant_jti: bootstrap.body.grant_jti,
      client_nonce: bootstrap.body.client_nonce,
      server_challenge: bootstrap.body.server_challenge,
      audience: AUDIENCE,
    };
    grantExchangeBody = exchangeBody;
    const nonce = proofNonce('exchange');
    const exchangeMaterial = agentOpsGrantProofMaterial({
      grantJti: exchangeBody.grant_jti,
      clientNonce: exchangeBody.client_nonce,
      serverChallenge: exchangeBody.server_challenge,
      proofNonce: nonce,
      method: 'POST',
      requestPath: '/api/agent-ops/v1/session/exchange',
      body: exchangeBody,
      audience: AUDIENCE,
    });
    const exchanged = await request(context.app)
      .post('/api/agent-ops/v1/session/exchange')
      .set('Host', '127.0.0.1:8090')
      .set('X-Agent-Ops-Proof-Nonce', nonce)
      .set('X-Agent-Ops-Proof', signature(client.privateKey, exchangeMaterial))
      .send(exchangeBody);
    expect(exchanged.status, JSON.stringify(exchanged.body)).toBe(201);
    session = exchanged.body;
    expectCanonical(session);
  });

  afterAll(() => {
    context?.internals.routerStoreForTest?.close();
    context?.cleanup();
  });

  async function signedGet(path, nonce = proofNonce('get')) {
    const material = agentOpsSessionProofMaterial({
      clientSessionId: session.client_session_id,
      proofNonce: nonce,
      method: 'GET',
      requestPath: path,
      body: null,
      audience: AUDIENCE,
    });
    return request(context.app)
      .get(path)
      .set('Host', '127.0.0.1:8090')
      .set('Authorization', `AgentOps ${session.session_capability}`)
      .set('X-Agent-Ops-Client-Session', session.client_session_id)
      .set('X-Agent-Ops-Proof-Nonce', nonce)
      .set('X-Agent-Ops-Proof', signature(client.privateKey, material));
  }

  async function signedPost(path, body, nonce = proofNonce('post')) {
    const material = agentOpsSessionProofMaterial({
      clientSessionId: session.client_session_id,
      proofNonce: nonce,
      method: 'POST',
      requestPath: path,
      body,
      audience: AUDIENCE,
    });
    return request(context.app)
      .post(path)
      .set('Host', '127.0.0.1:8090')
      .set('Authorization', `AgentOps ${session.session_capability}`)
      .set('X-Agent-Ops-Client-Session', session.client_session_id)
      .set('X-Agent-Ops-Proof-Nonce', nonce)
      .set('X-Agent-Ops-Proof', signature(client.privateKey, material))
      .send(body);
  }

  test('agent_ops_client_rejects_dashboard_bearer', async () => {
    const denied = await request(context.app)
      .get('/api/agent-ops/v1/snapshot')
      .set('Host', '127.0.0.1:8090')
      .set('Authorization', 'Bearer agent-ops-dashboard-token');
    expect(denied.status).toBe(401);
    expect(denied.body.code).toBe('invalid_capability');
  });

  test('agent_ops_client_bootstrap_and_exchange_are_single_use', async () => {
    const nonce = proofNonce('exchange-replay');
    const material = agentOpsGrantProofMaterial({
      grantJti: grantExchangeBody.grant_jti,
      clientNonce: grantExchangeBody.client_nonce,
      serverChallenge: grantExchangeBody.server_challenge,
      proofNonce: nonce,
      method: 'POST',
      requestPath: '/api/agent-ops/v1/session/exchange',
      body: grantExchangeBody,
      audience: AUDIENCE,
    });
    const replay = await request(context.app)
      .post('/api/agent-ops/v1/session/exchange')
      .set('Host', '127.0.0.1:8090')
      .set('X-Agent-Ops-Proof-Nonce', nonce)
      .set('X-Agent-Ops-Proof', signature(client.privateKey, material))
      .send(grantExchangeBody);
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe('capability_consumed');
    expect(session.session_capability).toBeTruthy();
    expect(JSON.stringify(context.internals.routerStoreForTest.snapshot())).not.toContain(session.session_capability);
  });

  test('agent_ops_client_requires_operator_device_enrollment', async () => {
    const projectRoom = '!other-project:test';
    const binding = await request(context.app)
      .put('/api/approval-bindings')
      .set('X-Bridge-Secret', 'agent-ops-bridge-secret')
      .send({
        agent: 'other', project: 'other-project', project_room_id: projectRoom,
        owner_mxid: OWNER, owner_dm_room_id: OWNER_DM,
      });
    expect(binding.status).toBe(200);
    const response = await request(context.app)
      .post('/api/agent-ops/v1/control/bootstrap')
      .set('X-Bridge-Secret', 'agent-ops-bridge-secret')
      .send({
        schema: 'com.hafleet.agent_ops.v1', agent: 'other',
        project_room_id: projectRoom, owner_mxid: OWNER, owner_dm_room_id: OWNER_DM,
        matrix_event_id: '$unenrolled-bootstrap', matrix_device_id: DEVICE_ID,
        matrix_device_ed25519: DEVICE_ED25519, matrix_device_curve25519: DEVICE_CURVE25519,
        client_nonce: 'unenrolled-client-nonce', client_public_jwk: client.publicKey.export({ format: 'jwk' }),
        was_encrypted: true, device_self_signature_verified: true, room_members_verified: true,
      });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('device_enrollment_required');
  });

  test('agent_ops_client_bootstrap_rejects_identity_substitution', async () => {
    const before = context.internals.routerStoreForTest.db
      .prepare('SELECT COUNT(*) AS count FROM agent_ops_grants').get().count;
    const substitutions = [
      { matrix_event_id: '$wrong-device', matrix_device_id: 'OTHERDEVICE' },
      { matrix_event_id: '$wrong-device-key', matrix_device_ed25519: Buffer.alloc(32, 3).toString('base64') },
      { matrix_event_id: '$wrong-room', owner_dm_room_id: '!wrong-owner-room:test' },
      { matrix_event_id: '$wrong-owner', owner_mxid: '@attacker:test' },
    ];
    for (const override of substitutions) {
      const response = await request(context.app)
        .post('/api/agent-ops/v1/control/bootstrap')
        .set('X-Bridge-Secret', 'agent-ops-bridge-secret')
        .send({
          schema: 'com.hafleet.agent_ops.v1', agent: 'worker',
          project_room_id: PROJECT_ROOM, owner_mxid: OWNER, owner_dm_room_id: OWNER_DM,
          matrix_event_id: '$substitution', matrix_device_id: DEVICE_ID,
          matrix_device_ed25519: DEVICE_ED25519, matrix_device_curve25519: DEVICE_CURVE25519,
          client_nonce: 'substitution-nonce', client_public_jwk: client.publicKey.export({ format: 'jwk' }),
          was_encrypted: true, device_self_signature_verified: true, room_members_verified: true,
          ...override,
        });
      expect([401, 403]).toContain(response.status);
    }
    const after = context.internals.routerStoreForTest.db
      .prepare('SELECT COUNT(*) AS count FROM agent_ops_grants').get().count;
    expect(after).toBe(before);
  });

  test('agent_ops_client_request_requires_pop_and_rejects_replay', async () => {
    const missing = await request(context.app)
      .get('/api/agent-ops/v1/snapshot')
      .set('Host', '127.0.0.1:8090')
      .set('Authorization', `AgentOps ${session.session_capability}`)
      .set('X-Agent-Ops-Client-Session', session.client_session_id);
    expect(missing.status).toBe(401);

    const nonce = proofNonce('single');
    const first = await signedGet('/api/agent-ops/v1/snapshot', nonce);
    expect(first.status).toBe(200);
    const replay = await signedGet('/api/agent-ops/v1/snapshot', nonce);
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe('capability_consumed');
  });

  test('agent_ops_client_data_plane_is_loopback_and_server_pinned', async () => {
    const wrongHost = await request(context.app)
      .get('/api/agent-ops/v1/snapshot')
      .set('Host', 'localhost:8090');
    expect(wrongHost.status).toBe(403);
    expect(wrongHost.body.code).toBe('host_mismatch');
    expectCanonical(wrongHost.body);
    const browserOrigin = await request(context.app)
      .get('/api/agent-ops/v1/snapshot')
      .set('Host', '127.0.0.1:8090')
      .set('Origin', 'http://127.0.0.1:8090');
    expect(browserOrigin.status).toBe(403);
    expect(browserOrigin.body.code).toBe('browser_origin_forbidden');
    expect(bootstrapGrant.server_key_fingerprint).toMatch(/^sha256:/);
    expect(session.server_key_fingerprint).toBe(bootstrapGrant.server_key_fingerprint);
  });

  test('agent_ops_projection_is_scope_and_privacy_filtered', async () => {
    const router = context.internals.routerStoreForTest;
    const workerInput = router.ingestMessage({
      messageId: 'agent-ops-worker-input', roomId: PROJECT_ROOM,
      matrixEventId: '$agent-ops-worker-input', threadRootEventId: '$worker-thread',
      senderMxid: OWNER, senderName: 'owner', recipientAgentId: 'agent_worker',
      recipientAgentName: 'worker', normalizedBody: 'inspect the worker queue',
    });
    expect(workerInput).toMatchObject({ ok: true });
    const otherInput = router.ingestMessage({
      messageId: 'agent-ops-other-input', roomId: '!other:test',
      matrixEventId: '$agent-ops-other-input', threadRootEventId: '$other-thread',
      senderMxid: OWNER, senderName: 'owner', recipientAgentId: 'agent_other',
      recipientAgentName: 'other', normalizedBody: 'private input outside the client scope',
    });
    expect(otherInput).toMatchObject({ ok: true });
    router.registerWorkspace({ resourceId: 'worker-workspace', safeLabel: '/Users/private/workspace', backendPath: '/Users/private/workspace' });
    router.registerWorkspace({ resourceId: 'other-workspace', safeLabel: 'Other workspace', backendPath: '/tmp/other' });
    const queued = router.enqueueDispatch({
      sessionId: workerInput.session.sessionId, framework: 'codex', localServerId: 'local',
      workspaceResourceId: 'worker-workspace', namedResourceIds: ['worker-workspace'],
      mayWrite: false, payload: {},
    });
    expect(queued, JSON.stringify(queued)).toMatchObject({ ok: true, state: 'queued' });
    const claim = router.claimDispatch({ runnerId: 'parked-agent-ops-runner', leaseMs: 60_000, capabilityTtlMs: 60_000, maxLiveRunners: 8 });
    expect(claim.dispatchId).toBe(queued.dispatchId);
    const capability = {
      dispatchId: claim.dispatchId, runnerId: claim.runnerId,
      fenceGeneration: claim.fenceGeneration, capability: claim.capability,
    };
    expect(router.takePayload(capability)).toMatchObject({ ok: true });
    expect(router.parkForApproval({
      ...capability, approvalId: 'agent-ops-parked-approval',
      operationDigest: 'a'.repeat(64), maxParkedRunners: 4,
    })).toMatchObject({ ok: true });
    const otherQueued = router.enqueueDispatch({
      sessionId: otherInput.session.sessionId, framework: 'codex', localServerId: 'local',
      workspaceResourceId: 'other-workspace', mayWrite: false, payload: {},
    });
    expect(otherQueued, JSON.stringify(otherQueued)).toMatchObject({ ok: true, state: 'queued' });

    const response = await signedGet('/api/agent-ops/v1/snapshot');
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.schema).toBe('com.hafleet.agent_ops.v1');
    expect(response.body.scope).toMatchObject({ agent_id: 'agent_worker', project_room_id: PROJECT_ROOM });
    expect(response.body.queue).toHaveLength(1);
    expect(response.body.attention[0]).toMatchObject({ kind: 'parked_approval', dispatch_id: queued.dispatchId });
    expect(response.body.worktrees).toHaveLength(1);
    expect(response.body.worktrees[0].label).toBe('Workspace');
    expectCanonical(response.body);
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('/Users/private');
    expect(serialized).not.toContain('other-workspace');
  });

  test('agent_ops_projection_carries_epoch_fence_and_monotonic_seq', async () => {
    const first = await signedGet('/api/agent-ops/v1/snapshot');
    const ingested = context.internals.routerStoreForTest.ingestMessage({
      messageId: 'agent-ops-seq-change', roomId: PROJECT_ROOM,
      matrixEventId: '$agent-ops-seq-change', threadRootEventId: '$seq-thread',
      senderMxid: OWNER, senderName: 'owner', recipientAgentId: 'agent_worker',
      recipientAgentName: 'worker', normalizedBody: 'advance the projection sequence',
    });
    expect(ingested).toMatchObject({ ok: true });
    const second = await signedGet('/api/agent-ops/v1/snapshot');
    expect(second.body).toMatchObject({
      schema: first.body.schema,
      projection_id: first.body.projection_id,
      stream_epoch: first.body.stream_epoch,
      auth_fence_generation: first.body.auth_fence_generation,
    });
    expect(second.body.seq).toBeGreaterThan(first.body.seq);
  });

  test('agent_ops_projection_reports_backend_blocking_chain', async () => {
    const router = context.internals.routerStoreForTest;
    const input = router.ingestMessage({
      messageId: 'agent-ops-blocked-input', roomId: PROJECT_ROOM,
      matrixEventId: '$agent-ops-blocked-input', threadRootEventId: '$blocked-thread',
      senderMxid: OWNER, senderName: 'owner', recipientAgentId: 'agent_worker',
      recipientAgentName: 'worker', normalizedBody: 'wait behind the parked workspace lease',
    });
    expect(input).toMatchObject({ ok: true });
    const queued = router.enqueueDispatch({
      sessionId: input.session.sessionId, framework: 'codex', localServerId: 'local',
      workspaceResourceId: 'worker-workspace', namedResourceIds: ['worker-workspace'],
      mayWrite: false, payload: {},
    });
    expect(queued).toMatchObject({ ok: true, state: 'queued' });
    const response = await signedGet('/api/agent-ops/v1/snapshot');
    const waiting = response.body.queue.find((row) => row.dispatch_id === queued.dispatchId);
    expect(waiting).toMatchObject({
      waiting_on: 'waiting for workspace lease',
      held_by_dispatch_id: expect.any(String),
    });
    expect(waiting.held_by_dispatch_id).not.toBe(queued.dispatchId);
  });

  test('agent_ops_cancel_dispatch_is_capability_bound_and_idempotent', async () => {
    const snapshotResponse = await signedGet('/api/agent-ops/v1/snapshot');
    const snapshot = snapshotResponse.body;
    const attention = snapshot.attention.find((item) => item.kind === 'parked_approval');
    const action = attention.available_actions[0];
    const body = {
      schema: snapshot.schema,
      request_id: 'cancel-parked-once',
      client_session_id: session.client_session_id,
      scope_id: snapshot.scope.scope_id,
      projection_id: snapshot.projection_id,
      stream_epoch: snapshot.stream_epoch,
      auth_fence_generation: snapshot.auth_fence_generation,
      snapshot_seq: snapshot.seq,
      action_capability: action.capability,
      target: action.target,
    };
    const path = '/api/agent-ops/v1/commands/cancel-dispatch';
    const first = await signedPost(path, body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expectCanonical(first.body);
    expect(first.body).toMatchObject({ state: 'outcome_unknown', idempotent_request_replay: false });
    const replay = await signedPost(path, body);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.idempotent_request_replay).toBe(true);
    const stored = context.internals.routerStoreForTest.snapshot().dispatches
      .find((row) => row.dispatchId === body.target.entity_id);
    expect(stored).toMatchObject({ state: 'outcome_unknown' });
  });

  test('agent_ops_mutation_rejects_stale_entity_and_resource_preconditions', async () => {
    const snapshotResponse = await signedGet('/api/agent-ops/v1/snapshot');
    const snapshot = snapshotResponse.body;
    const attention = snapshot.attention.find((item) => item.kind === 'outcome_unknown');
    const action = attention.available_actions[0];
    context.internals.routerStoreForTest.db.prepare(
      'UPDATE dispatches SET terminal_reason = terminal_reason WHERE dispatch_id = ?',
    ).run(action.target.entity_id);
    const response = await signedPost('/api/agent-ops/v1/commands/begin-outcome-inspection', {
      schema: snapshot.schema,
      request_id: 'stale-dispatch-version',
      client_session_id: session.client_session_id,
      scope_id: snapshot.scope.scope_id,
      projection_id: snapshot.projection_id,
      stream_epoch: snapshot.stream_epoch,
      auth_fence_generation: snapshot.auth_fence_generation,
      snapshot_seq: snapshot.seq,
      action_capability: action.capability,
      target: action.target,
      resource_precondition: action.resource_precondition,
    });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('precondition_failed');
  });

  test('agent_ops_mark_inspected_requires_non_quarantine_resource', async () => {
    const router = context.internals.routerStoreForTest;
    const unknown = router.snapshot().dispatches.find((row) => row.state === 'outcome_unknown');
    router.db.prepare(
      `UPDATE resources SET dirty = 1, dirty_reason = 'fixture inspection required',
       dirty_generation = dirty_generation + 1, dirty_dispatch_id = NULL
       WHERE resource_id = 'worker-workspace'`,
    ).run();
    const snapshotResponse = await signedGet('/api/agent-ops/v1/snapshot');
    const snapshot = snapshotResponse.body;
    const worktree = snapshot.worktrees.find((row) => row.resource_id === 'worker-workspace');
    const action = worktree.available_actions.find((item) => item.kind === 'mark_resource_inspected');
    expect(action).toBeTruthy();
    router.db.prepare(
      'UPDATE resources SET dirty_dispatch_id = ? WHERE resource_id = ?',
    ).run(unknown.dispatchId, 'worker-workspace');
    const response = await signedPost('/api/agent-ops/v1/commands/mark-resource-inspected', {
      schema: snapshot.schema,
      request_id: 'reject-quarantine-clear',
      client_session_id: session.client_session_id,
      scope_id: snapshot.scope.scope_id,
      projection_id: snapshot.projection_id,
      stream_epoch: snapshot.stream_epoch,
      auth_fence_generation: snapshot.auth_fence_generation,
      snapshot_seq: snapshot.seq,
      action_capability: action.capability,
      target: action.target,
      resource_precondition: action.resource_precondition,
    });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('inspection_required');
    const resource = router.inspectWorkspace('worker-workspace');
    expect(resource).toMatchObject({ dirty: true, quarantinedByDispatchId: unknown.dispatchId });
  });

  test('agent_ops_begin_outcome_inspection_issues_bound_resolution', async () => {
    const snapshotResponse = await signedGet('/api/agent-ops/v1/snapshot');
    const snapshot = snapshotResponse.body;
    const attention = snapshot.attention.find((item) => item.kind === 'outcome_unknown');
    const action = attention.available_actions[0];
    const beginBody = {
      schema: snapshot.schema,
      request_id: 'begin-inspection-once',
      client_session_id: session.client_session_id,
      scope_id: snapshot.scope.scope_id,
      projection_id: snapshot.projection_id,
      stream_epoch: snapshot.stream_epoch,
      auth_fence_generation: snapshot.auth_fence_generation,
      snapshot_seq: snapshot.seq,
      action_capability: action.capability,
      target: action.target,
      resource_precondition: action.resource_precondition,
    };
    const inspected = await signedPost('/api/agent-ops/v1/commands/begin-outcome-inspection', beginBody);
    expect(inspected.status, JSON.stringify(inspected.body)).toBe(201);
    expectCanonical(inspected.body);
    expect(inspected.body.resolution_action.allowed_resolutions).toEqual(['continue']);
    expect(inspected.body.inspection_token).toBeTruthy();
    expect(JSON.stringify(context.internals.routerStoreForTest.snapshot())).not.toContain(inspected.body.inspection_token);
    inspectionState = inspected.body;
  });

  test('agent_ops_terminal_resolution_rejects_recovery_instruction', async () => {
    const resolution = inspectionState.resolution_action;
    const rejected = await signedPost('/api/agent-ops/v1/commands/resolve-outcome', {
      schema: inspectionState.schema,
      request_id: 'reject-terminal-recovery',
      client_session_id: session.client_session_id,
      scope_id: inspectionState.scope_id,
      projection_id: inspectionState.projection_id,
      stream_epoch: inspectionState.stream_epoch,
      auth_fence_generation: inspectionState.auth_fence_generation,
      snapshot_seq: inspectionState.snapshot_seq,
      action_capability: resolution.capability,
      target: resolution.target,
      resource_precondition: resolution.resource_precondition,
      inspection_id: inspectionState.inspection_id,
      inspection_token: inspectionState.inspection_token,
      operator_note: 'Terminal outcome was inspected.',
      resolution: {
        kind: 'accept_completed',
        recovery_instruction: 'This field must be rejected.',
      },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe('bad_request');
  });

  test('agent_ops_resolve_continue_creates_new_dispatch_once', async () => {
    const resolution = inspectionState.resolution_action;
    const resolveBody = {
      schema: inspectionState.schema,
      request_id: 'resolve-continue-once',
      client_session_id: session.client_session_id,
      scope_id: inspectionState.scope_id,
      projection_id: inspectionState.projection_id,
      stream_epoch: inspectionState.stream_epoch,
      auth_fence_generation: inspectionState.auth_fence_generation,
      snapshot_seq: inspectionState.snapshot_seq,
      action_capability: resolution.capability,
      target: resolution.target,
      resource_precondition: resolution.resource_precondition,
      inspection_id: inspectionState.inspection_id,
      inspection_token: inspectionState.inspection_token,
      operator_note: 'Inspected the uncertain workspace and confirmed the partial changes.',
      resolution: {
        kind: 'continue',
        recovery_instruction: 'Continue from the inspected workspace without replaying completed commands.',
      },
    };
    const resolved = await signedPost('/api/agent-ops/v1/commands/resolve-outcome', resolveBody);
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(201);
    expectCanonical(resolved.body);
    expect(resolved.body.resolution).toBe('continue');
    expect(resolved.body.replacement_dispatch_id).not.toBe(resolveBody.target.entity_id);
    const replay = await signedPost('/api/agent-ops/v1/commands/resolve-outcome', resolveBody);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      idempotent_request_replay: true,
      replacement_dispatch_id: resolved.body.replacement_dispatch_id,
    });
    const original = context.internals.routerStoreForTest.snapshot().dispatches
      .find((row) => row.dispatchId === resolveBody.target.entity_id);
    expect(original).toMatchObject({ state: 'outcome_unknown', resolutionAction: 'continue' });
  });

  test('agent_ops_scope_revocation_invalidates_sessions_and_actions', async () => {
    const revoked = await request(context.app)
      .post('/api/agent-ops/v1/operator/revoke')
      .set('Authorization', 'Bearer agent-ops-dashboard-token')
      .send({ scope_id: session.scope_id });
    expect(revoked.status).toBe(200);
    const denied = await signedGet('/api/agent-ops/v1/snapshot');
    expect(denied.status).toBe(401);
    expect(denied.body.code).toBe('auth_fence_stale');
  });
});

describe('Agent Operations feature gate', () => {
  test('agent_ops_client_feature_off_preserves_existing_backend_contracts', async () => {
    const context = await createBackendTestContext('hafleet-agent-ops-off-');
    try {
      const health = await request(context.app).get('/health');
      expect(health.status).toBe(200);
      const unavailable = await request(context.app).get('/api/agent-ops/v1/snapshot');
      expect(unavailable.status).toBe(404);
      expect(context.internals.agentOpsServiceForTest).toBeNull();
    } finally {
      context.cleanup();
    }
  });
});
