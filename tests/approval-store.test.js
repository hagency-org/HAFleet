import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import os from 'os';
import path from 'path';
import { ApprovalStore } from '../lib/approval-store.js';

const roots = [];

function makeStore(options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agent-chat-approval-store-'));
  roots.push(root);
  const file = path.join(root, 'approvals.json');
  return { store: new ApprovalStore(file, options), file };
}

function binding(overrides = {}) {
  return {
    agent: 'wf_coordinator',
    project: 'robrix2',
    project_room_id: '!project:palpo.test',
    owner_mxid: '@alex:palpo.test',
    owner_dm_room_id: '!owner-dm:palpo.test',
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    agent: 'wf_coordinator',
    runtime: 'claude',
    project: 'robrix2',
    upstream_request_id: 'abcde',
    tool_name: 'Bash',
    description: 'Create a GitHub issue',
    input_preview: '{"command":"gh issue create"}',
    ...overrides,
  };
}

function verdict(record, overrides = {}) {
  return {
    sender_mxid: record.owner_mxid,
    room_id: record.owner_dm_room_id,
    agent: record.agent,
    project: record.project,
    project_room_id: record.project_room_id,
    input_digest: record.input_digest,
    action: 'approve_once',
    event_id: '$verdict',
    ...overrides,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('owner approval store', () => {
  test('owner_ui_verdict_is_consumed_once', () => {
    let now = 1_000;
    const { store, file } = makeStore({ now: () => now, ttlMs: 60_000 });
    store.upsertBinding(binding());
    const created = store.createRequest(request());

    expect(created.status).toBe('pending');
    expect(created.input_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(store.submitMatrixVerdict(created.id, verdict(created))).toMatchObject({ ok: true, code: 'approved' });
    expect(store.submitMatrixVerdict(created.id, verdict(created, { event_id: '$replay' }))).toMatchObject({ ok: false, code: 'not_pending' });
    expect(store.consumeDecision(created.id, 'wf_coordinator', created.input_digest)).toMatchObject({ ok: true, decision: 'allow' });
    expect(store.consumeDecision(created.id, 'wf_coordinator', created.input_digest)).toMatchObject({ ok: false, code: 'consumed' });

    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8')).requests[created.id].status).toBe('consumed');
  });

  test('non_owner_ui_verdict_is_rejected', () => {
    const { store } = makeStore();
    store.upsertBinding(binding());
    const created = store.createRequest(request());

    const result = store.submitMatrixVerdict(created.id, verdict(created, {
      sender_mxid: '@coworker:palpo.test',
    }));

    expect(result).toMatchObject({ ok: false, code: 'senderMxid_mismatch' });
    expect(store.getRequest(created.id).status).toBe('pending');
    expect(store.listAudit()).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'approval.verdict_rejected', reason: 'senderMxid_mismatch' }),
    ]));
  });

  test('expired_or_replayed_ui_verdict_is_rejected', () => {
    let now = 10_000;
    const { store } = makeStore({ now: () => now, ttlMs: 1_000 });
    store.upsertBinding(binding());
    const created = store.createRequest(request());
    now = 11_001;

    expect(store.submitMatrixVerdict(created.id, verdict(created))).toMatchObject({ ok: false, code: 'expired' });
    expect(store.getRequest(created.id).status).toBe('expired');
  });

  test('approved verdict remains consumable after request expiry boundary', () => {
    let now = 10_000;
    const { store } = makeStore({ now: () => now, ttlMs: 1_000 });
    store.upsertBinding(binding());
    const created = store.createRequest(request());
    expect(store.submitMatrixVerdict(created.id, verdict(created))).toMatchObject({
      ok: true,
      code: 'approved',
    });

    now = 11_001;
    expect(store.consumeDecision(created.id, 'wf_coordinator', created.input_digest)).toMatchObject({
      ok: true,
      code: 'consumed',
      decision: 'allow',
    });
  });

  test('missing_owner_denies_without_admin_fallback', () => {
    const { store } = makeStore();
    const created = store.createRequest(request());

    expect(created).toMatchObject({
      status: 'denied',
      decision: 'deny',
      denial_reason: 'owner_binding_missing',
      owner_mxid: null,
    });
    expect(store.listBindings()).toEqual([]);
  });

  test('ambiguous room ownership denies instead of selecting an administrator', () => {
    const { store } = makeStore();
    store.upsertBinding(binding({ project: 'project-a', project_room_id: '!a:palpo.test' }));
    store.upsertBinding(binding({ project: 'project-b', project_room_id: '!b:palpo.test' }));

    const created = store.createRequest(request({ project: '' }));

    expect(created).toMatchObject({ status: 'denied', denial_reason: 'owner_binding_ambiguous' });
  });

  test('owner binding change denies existing pending requests', () => {
    const { store } = makeStore();
    store.upsertBinding(binding());
    const created = store.createRequest(request());
    store.upsertBinding(binding({ owner_mxid: '@new-owner:palpo.test', owner_dm_room_id: '!new-dm:palpo.test' }));

    expect(store.getRequest(created.id)).toMatchObject({ status: 'denied', denial_reason: 'owner_binding_changed' });
  });
});
