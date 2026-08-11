import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const AGENT_TOKEN = 'approval-agent-token';
const BRIDGE_SECRET = 'approval-bridge-secret';

describe('owner approval API', () => {
  let context;

  beforeAll(async () => {
    context = await createBackendTestContext('hafleet-approval-api-', {
      agents: {
        wf_coordinator: { name: 'wf_coordinator', type: 'agent', kind: 'agent', online: true },
        unbound: { name: 'unbound', type: 'agent', kind: 'agent', online: true },
      },
      agentTokens: { wf_coordinator: AGENT_TOKEN, unbound: 'unbound-token' },
      env: {
        MATRIX_BRIDGE_SECRET: BRIDGE_SECRET,
        HAFLEET_AGENT_TOKEN_MODE: 'hard',
        HAFLEET_APPROVAL_TTL_MS: '60000',
      },
    });
  });

  afterAll(() => context.cleanup());

  test('bridge-owned binding and one-shot verdict flow are enforced', async () => {
    /*
     * REQ-OWNER-UI-APPROVAL-AUTHORITY. Read the forged verdict below carefully: it arrives
     * WITH the bridge secret, quoting the real request id, the real digest, the real agent,
     * the real project room and the real owner DM. Only the sender differs, and the backend
     * returns 403. So a client's structured event — and the bridge relaying it — buys no
     * authorization; hafleet re-derives the answer from its own binding every time. The 403
     * on the unauthenticated PUT above says the same about bindings: the presentation layer
     * cannot install the authority it would then be judged against.
     *
     * Scope note: this is the hafleet half of the statement. "Robrix2 MUST remain a rendering
     * and event-emission client" is a property of a client that lives outside this repo and
     * no test here can assert it.
     *
     * REQ-OWNER-UI-APPROVAL-LIFETIME's at-most-once half is also asserted end-to-end here:
     * verdict 200, identical replay 409, consume 200 — over HTTP, not just in the store.
     */
    const binding = {
      agent: 'wf_coordinator',
      project: 'robrix2',
      project_room_id: '!project:palpo.test',
      owner_mxid: '@alex:palpo.test',
      owner_dm_room_id: '!owner-dm:palpo.test',
    };

    const unauthenticatedBinding = await request(context.app)
      .put('/api/approval-bindings')
      .send(binding);
    expect(unauthenticatedBinding.status).toBe(403);

    const bound = await request(context.app)
      .put('/api/approval-bindings')
      .set('X-Bridge-Secret', BRIDGE_SECRET)
      .send(binding);
    expect(bound.status).toBe(200);

    const created = await request(context.app)
      .post('/api/approvals')
      .set('X-Agent-Token', AGENT_TOKEN)
      .send({
        agent: 'wf_coordinator',
        runtime: 'claude',
        project: 'robrix2',
        upstream_request_id: 'abcde',
        tool_name: 'Bash',
        description: 'Create issue',
        input_preview: '{"command":"gh issue create"}',
      });
    expect(created.status).toBe(201);
    expect(created.body.approval).toMatchObject({ status: 'pending', owner_mxid: '@alex:palpo.test' });
    expect(created.body.approval).not.toHaveProperty('input_preview');

    const id = created.body.approval.id;
    const matrixView = await request(context.app)
      .get(`/api/approvals/${id}/matrix`)
      .set('X-Bridge-Secret', BRIDGE_SECRET);
    expect(matrixView.status).toBe(200);
    expect(matrixView.body.approval).toMatchObject({
      tool_name: 'Bash',
      description: 'Create issue',
      input_preview: '{"command":"gh issue create"}',
    });

    const forged = await request(context.app)
      .post(`/api/approvals/${id}/verdict`)
      .set('X-Bridge-Secret', BRIDGE_SECRET)
      .send({
        sender_mxid: '@coworker:palpo.test',
        room_id: '!owner-dm:palpo.test',
        agent: 'wf_coordinator',
        project: 'robrix2',
        project_room_id: '!project:palpo.test',
        input_digest: created.body.approval.input_digest,
        action: 'approve_once',
        event_id: '$forged',
      });
    expect(forged.status).toBe(403);

    const accepted = await request(context.app)
      .post(`/api/approvals/${id}/verdict`)
      .set('X-Bridge-Secret', BRIDGE_SECRET)
      .send({
        sender_mxid: '@alex:palpo.test',
        room_id: '!owner-dm:palpo.test',
        agent: 'wf_coordinator',
        project: 'robrix2',
        project_room_id: '!project:palpo.test',
        input_digest: created.body.approval.input_digest,
        action: 'approve_once',
        event_id: '$accepted',
      });
    expect(accepted.status).toBe(200);
    expect(accepted.body.approval.status).toBe('approved');

    const replay = await request(context.app)
      .post(`/api/approvals/${id}/verdict`)
      .set('X-Bridge-Secret', BRIDGE_SECRET)
      .send({
        sender_mxid: '@alex:palpo.test',
        room_id: '!owner-dm:palpo.test',
        agent: 'wf_coordinator',
        project: 'robrix2',
        project_room_id: '!project:palpo.test',
        input_digest: created.body.approval.input_digest,
        action: 'approve_once',
        event_id: '$replay',
      });
    expect(replay.status).toBe(409);

    const consumed = await request(context.app)
      .post(`/api/approvals/${id}/consume`)
      .set('X-Agent-Token', AGENT_TOKEN)
      .send({ agent: 'wf_coordinator', input_digest: created.body.approval.input_digest });
    expect(consumed.status).toBe(200);
    expect(consumed.body).toMatchObject({ ok: true, decision: 'allow' });
  });

  test('missing_owner_denies_without_admin_fallback', async () => {
    const response = await request(context.app)
      .post('/api/approvals')
      .set('X-Agent-Token', 'unbound-token')
      .send({
        agent: 'unbound',
        runtime: 'codex',
        upstream_request_id: 'turn-1:Bash',
        tool_name: 'Bash',
        description: 'Publish externally',
        input_preview: '{"command":"gh issue create"}',
      });

    expect(response.status).toBe(200);
    expect(response.body.approval).toMatchObject({
      status: 'denied',
      decision: 'deny',
      denial_reason: 'owner_binding_missing',
      owner_mxid: null,
    });
  });

  test('bridge approval routes fail closed when the bridge secret is not configured', async () => {
    const configured = process.env.MATRIX_BRIDGE_SECRET;
    delete process.env.MATRIX_BRIDGE_SECRET;
    try {
      const response = await request(context.app)
        .put('/api/approval-bindings')
        .send({
          agent: 'wf_coordinator',
          project: 'robrix2',
          project_room_id: '!project:palpo.test',
          owner_mxid: '@alex:palpo.test',
          owner_dm_room_id: '!owner-dm:palpo.test',
        });
      expect(response.status).toBe(503);
      expect(response.body.error).toBe('MATRIX_BRIDGE_SECRET is required for approval authorization');
    } finally {
      process.env.MATRIX_BRIDGE_SECRET = configured;
    }
  });
});
