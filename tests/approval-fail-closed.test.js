/*
 * "Two surfaces or nothing" — the fail-closed path when a Matrix surface cannot be delivered.
 *
 * ADR-003: every remote-execution approval uses BOTH the encrypted owner DM and the redacted
 * public notice, or neither. The "or neither" half is what happens when delivery fails, and it
 * had no coverage of its own end to end. `denyPending` (store) has unit tests now; this file
 * pins the two surfaces above it: the `delivery-failed` ENDPOINT, and the BRIDGE integration
 * `onApprovalRequested` that calls it.
 *
 * Why it matters: a request left `pending` after a failed delivery is not benign. The owner
 * never saw the approve/deny buttons, so no verdict can ever arrive — the request sits until it
 * expires, and for its whole TTL an operator reading the queue sees a decision "awaiting the
 * owner" that the owner was never actually shown. Fail-closed turns that into an explicit denial
 * the moment delivery is known to have failed.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const BRIDGE_SECRET = 'test-bridge-secret';

const seedApproval = () => ({
  env: { MATRIX_BRIDGE_SECRET: BRIDGE_SECRET },
});

/*
 * Create a pending approval through the same door the bridge uses, so the record under test is
 * the real thing the endpoint operates on rather than a hand-written fixture. The binding is
 * required first (owner resolution), then the request lands pending.
 */
async function createPending(ctx) {
  await request(ctx.app).put('/api/approval-bindings')
    .set('X-Bridge-Secret', BRIDGE_SECRET)
    .send({
      agent: 'wf_coordinator',
      project: 'robrix2',
      project_room_id: '!project:hq.example',
      owner_mxid: '@alex:hq.example',
      owner_dm_room_id: '!owner-dm:hq.example',
    });
  const created = await request(ctx.app).post('/api/approvals')
    .set('X-Bridge-Secret', BRIDGE_SECRET)
    .send({
      agent: 'wf_coordinator',
      runtime: 'claude',
      project: 'robrix2',
      upstream_request_id: 'u-1',
      tool_name: 'Bash',
      description: 'Create a GitHub issue',
      input_preview: '{"command":"gh issue create"}',
    });
  // 201 Created for a fresh pending request; 200 only on an idempotent replay.
  expect(created.status).toBe(201);
  return created.body.approval;
}

describe('POST /api/approvals/:id/delivery-failed', () => {
  let ctx;
  afterEach(async () => { await ctx?.cleanup?.(); ctx = null; });

  test('denies a pending request and broadcasts the verdict', async () => {
    ctx = await createBackendTestContext('approval-failclosed-', seedApproval());
    const approval = await createPending(ctx);
    expect(approval.status).toBe('pending');

    const res = await request(ctx.app).post(`/api/approvals/${approval.id}/delivery-failed`)
      .set('X-Bridge-Secret', BRIDGE_SECRET)
      .send({ reason: 'matrix_delivery_failed' });

    expect(res.status).toBe(200);
    expect(res.body.approval).toMatchObject({ status: 'denied', denial_reason: 'matrix_delivery_failed' });

    // And it is actually denied in the store, not merely reported so — the queue must not still
    // show it awaiting the owner.
    // Read back through the bridge-secret /matrix variant — the plain GET is agent-token
    // guarded, and this test holds the bridge secret, not an agent token.
    const after = await request(ctx.app).get(`/api/approvals/${approval.id}/matrix`)
      .set('X-Bridge-Secret', BRIDGE_SECRET);
    expect(after.body.approval.status).toBe('denied');
  });

  test('requires the bridge secret — a project cannot deny its own pending approval', async () => {
    /*
     * The endpoint fires when the bridge could not deliver. Letting an unauthenticated caller
     * reach it would let anyone in a room force-deny a request that was about to be approved —
     * a denial-of-service on the owner's decision.
     */
    ctx = await createBackendTestContext('approval-failclosed-auth-', seedApproval());
    const approval = await createPending(ctx);

    const res = await request(ctx.app).post(`/api/approvals/${approval.id}/delivery-failed`)
      .send({ reason: 'matrix_delivery_failed' });

    expect(res.status).toBe(403);
    const after = await request(ctx.app).get(`/api/approvals/${approval.id}/matrix`)
      .set('X-Bridge-Secret', BRIDGE_SECRET);
    // Untouched: the unauthenticated deny attempt must not have moved it off pending.
    expect(after.body.approval.status).toBe('pending');
  });

  test('an unknown id is 404, not a silently created denial', async () => {
    ctx = await createBackendTestContext('approval-failclosed-404-', seedApproval());
    const res = await request(ctx.app).post('/api/approvals/$nope/delivery-failed')
      .set('X-Bridge-Secret', BRIDGE_SECRET)
      .send({ reason: 'matrix_delivery_failed' });
    expect(res.status).toBe(404);
  });
});

describe('bridge onApprovalRequested — deliver both surfaces or fail closed', () => {
  let runtimeDir;
  let MatrixBridge;
  const saved = {};

  const approval = {
    id: '$approval-1',
    agent: 'wf_coordinator',
    project: 'robrix2',
    project_room_id: '!project:hq.example',
    owner_mxid: '@alex:hq.example',
    owner_dm_room_id: '!owner-dm:hq.example',
    upstream_request_id: 'u-1',
    input_digest: 'a'.repeat(64),
    runtime: 'claude',
    tool_name: 'Bash',
    description: 'Create a GitHub issue',
    input_preview: '{"command":"gh issue create"}',
    expires_at: Date.now() + 60_000,
    status: 'pending',
  };

  beforeAll(async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'approval-failclosed-bridge-'));
    for (const k of ['HAFLEET_RUNTIME_DIR', 'MATRIX_AGENT_PREFIX']) saved[k] = process.env[k];
    process.env.HAFLEET_RUNTIME_DIR = runtimeDir;
    process.env.MATRIX_AGENT_PREFIX = 'ac_';
    const url = pathToFileURL(path.resolve('bridge-matrix.js')).href;
    ({ MatrixBridge } = await import(`${url}?failclosed-test=${Date.now()}`));
  });

  afterAll(() => {
    rmSync(runtimeDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /** A bridge whose backend calls and both senders are recorded. */
  function harness({ privateFails = false, publicResult = '$public' } = {}) {
    const backendCalls = [];
    const bridge = new MatrixBridge();
    bridge.callBackendApi = vi.fn().mockImplementation(async (method, routePath, body) => {
      backendCalls.push({ method, routePath, body });
      if (routePath.endsWith('/matrix')) return { approval };
      return { ok: true };
    });
    bridge.ensureApprovalDmSecurity = vi.fn().mockResolvedValue(undefined);
    bridge.botClient = {
      sendMessage: vi.fn().mockImplementation(async () => {
        if (privateFails) throw new Error('E2EE is unavailable for the owner DM');
        return '$private';
      }),
    };
    bridge.getAgentToken = vi.fn().mockReturnValue('agent-token');
    bridge.sendAsAgentContent = vi.fn().mockResolvedValue(publicResult);
    bridge.rememberMatrixEvent = vi.fn();
    return { bridge, backendCalls };
  }

  const deliveryFailedCall = (calls) =>
    calls.find((c) => c.method === 'POST' && c.routePath.includes('/delivery-failed'));

  test('when the private DM send fails, the request is failed closed — not left pending', async () => {
    /*
     * The encrypted owner DM is the surface that carries the approve/deny buttons. If it does not
     * arrive, the owner cannot decide, so leaving the request pending would wait forever. The
     * bridge must call delivery-failed. The public send must NOT have happened — "both or
     * neither" forbids a public status for a request whose owner was never asked.
     */
    const { bridge, backendCalls } = harness({ privateFails: true });

    const result = await bridge.onApprovalRequested({ request_id: approval.id });

    expect(result.ok).toBe(false);
    const failed = deliveryFailedCall(backendCalls);
    expect(failed, 'delivery-failed was not called').toBeTruthy();
    expect(failed.routePath).toContain(encodeURIComponent(approval.id));
    // The public notice must not go out for a request nobody can act on.
    expect(bridge.sendAsAgentContent).not.toHaveBeenCalled();
  });

  test('when the PUBLIC status send fails, it is also failed closed', async () => {
    /*
     * The second surface. A falsy return from the public send is a failure the code raises
     * itself ("public approval status delivery failed"), so a delivered private DM with no
     * public notice must not be left as a half-published approval.
     */
    const { bridge, backendCalls } = harness({ publicResult: null });

    const result = await bridge.onApprovalRequested({ request_id: approval.id });

    expect(result.ok).toBe(false);
    expect(deliveryFailedCall(backendCalls)).toBeTruthy();
  });

  test('a fail-closed update that itself fails does not throw out of the handler', async () => {
    /*
     * The last-ditch case: delivery failed AND the deny POST failed too (backend also down).
     * The handler must still return a structured failure rather than throwing, or the SSE
     * dispatch that called it loses the event with no record. The request stays pending — which
     * is why this path also logs — but the process does not fall over.
     */
    const backendCalls = [];
    const bridge = new MatrixBridge();
    bridge.callBackendApi = vi.fn().mockImplementation(async (method, routePath) => {
      backendCalls.push({ method, routePath });
      if (routePath.endsWith('/matrix')) return { approval };
      throw new Error('backend unreachable');
    });
    bridge.ensureApprovalDmSecurity = vi.fn().mockResolvedValue(undefined);
    bridge.botClient = { sendMessage: vi.fn().mockRejectedValue(new Error('E2EE down')) };
    bridge.getAgentToken = vi.fn().mockReturnValue('agent-token');
    bridge.sendAsAgentContent = vi.fn();
    bridge.rememberMatrixEvent = vi.fn();

    const result = await bridge.onApprovalRequested({ request_id: approval.id });

    expect(result.ok).toBe(false);
    // It TRIED to fail closed even though that call then threw.
    expect(backendCalls.some((c) => c.routePath.includes('/delivery-failed'))).toBe(true);
  });

  test('a request that is no longer pending is left alone, not re-published', async () => {
    // The owner may have already decided between the SSE event and this handler running.
    const { bridge } = harness();
    bridge.callBackendApi = vi.fn().mockResolvedValue({ approval: { ...approval, status: 'approved' } });

    const result = await bridge.onApprovalRequested({ request_id: approval.id });

    expect(result).toMatchObject({ ok: false, reason: 'request_not_pending' });
    expect(bridge.botClient.sendMessage).not.toHaveBeenCalled();
  });
});
