import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import os from 'os';
import path from 'path';
import { ApprovalStore } from '../lib/approval-store.js';

const roots = [];

function makeStore(options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hafleet-approval-store-'));
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
    /*
     * REQ-OWNER-UI-APPROVAL-BINDING and REQ-OWNER-UI-APPROVAL-LIFETIME.
     *
     * BINDING is established by construction rather than by a field-presence check:
     * `verdict(created)` builds the response out of the created record's own agent, project,
     * project_room_id, owner_mxid (as sender) and owner_dm_room_id, and submitMatrixVerdict
     * compares all of them against the record. A record missing or misreporting any one of
     * those fields makes this accepted verdict fail with a `*_mismatch` code, so the
     * `{ ok: true, code: 'approved' }` below is exactly the claim that the request bound
     * them. The digest is pinned separately by the 64-hex assertion.
     *
     * LIFETIME's at-most-once half is the two pairs that follow: a replayed verdict is
     * `not_pending`, and the second consumeDecision is `consumed` — with the on-disk status
     * read back, so the atomic transition is what persisted, not just what was returned.
     */
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
    /*
     * REQ-OWNER-UI-APPROVAL-IDENTITY. Everything about this verdict is correct except the
     * MXID: right request id, right room, right agent, right digest, right action. It is
     * refused on `senderMxid_mismatch` alone and the request stays pending, which is what
     * "authorize using the event's complete sender MXID" means in practice — no other field
     * can stand in for it, and room membership does not confer authority.
     */
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
    /*
     * REQ-OWNER-UI-APPROVAL-LIFETIME, the expiry half: the clock is moved one millisecond
     * past the TTL and the owner's own otherwise-valid verdict is refused as `expired`, with
     * the record transitioned to `expired` rather than left pending. A request that merely
     * stops being answerable would satisfy neither.
     */
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
    /*
     * REQ-OWNER-UI-APPROVAL-FAIL-CLOSED, the "missing" state. With no binding at all the
     * request is born `denied` — not pending-and-unanswerable, which would leave something an
     * administrator could later approve. `owner_mxid: null` and the empty binding list
     * together say no fallback owner was invented to carry it.
     */
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
    /*
     * REQ-OWNER-UI-APPROVAL-FAIL-CLOSED, the "ambiguous" state — the one where a fallback is
     * most tempting, because two candidate owners exist and picking either would let the
     * request proceed. `owner_binding_ambiguous` is a denial, so neither is picked.
     */
    const { store } = makeStore();
    store.upsertBinding(binding({ project: 'project-a', project_room_id: '!a:palpo.test' }));
    store.upsertBinding(binding({ project: 'project-b', project_room_id: '!b:palpo.test' }));

    const created = store.createRequest(request({ project: '' }));

    expect(created).toMatchObject({ status: 'denied', denial_reason: 'owner_binding_ambiguous' });
  });

  test('owner binding change denies existing pending requests', () => {
    /*
     * REQ-OWNER-UI-APPROVAL-FAIL-CLOSED, the "mismatched" state. Re-binding the room to a new
     * owner does not silently re-target the live request at whoever now holds the room; the
     * request that was raised under the old binding transitions to `denied`. Carrying it over
     * would hand a pending approval to an owner who never saw the request that created it.
     */
    const { store } = makeStore();
    store.upsertBinding(binding());
    const created = store.createRequest(request());
    store.upsertBinding(binding({ owner_mxid: '@new-owner:palpo.test', owner_dm_room_id: '!new-dm:palpo.test' }));

    expect(store.getRequest(created.id)).toMatchObject({ status: 'denied', denial_reason: 'owner_binding_changed' });
  });
});
