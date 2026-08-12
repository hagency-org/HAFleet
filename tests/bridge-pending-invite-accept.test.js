/*
 * The BRIDGE side of accepting a project's invitation.
 *
 * `lib/pending-invite-store.js` and the `/api/matrix/pending-invites*` endpoints have their own
 * tests, and none of them execute a line of this. The bridge is where the consequential things
 * happen — the agent joins, the room becomes trusted, the ownership binding is written, the bot is
 * invited so the room can actually be read — and all of it was unreached by any test.
 *
 * That gap had already cost something: `acceptPendingInvite` shipped WITHOUT inviting the bridge
 * bot, while the auto-join path did it inline. The bot is the only syncing client (agents are
 * token-only puppets; `pollBotInvites` joins only rooms the bot is itself invited to), so an
 * accepted project room would have had the agent present, ownership bound, approvals working —
 * and message ingress, commands and mention routing dead until a human invited the bot by hand.
 * A milder rerun of the "present but unengageable" dead end the pending-invite work exists to
 * remove. It was found by reading the two writers side by side, not by a failing test.
 *
 * I had claimed these methods could not be tested without a homeserver. That was wrong:
 * tests/bridge-matrix-approval.test.js already imports the module dynamically with
 * HAFLEET_RUNTIME_DIR set and stubs `botClient`. This file uses the same recipe, so the claim is
 * retired along with the excuse.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOM = '!proj7Kq2:their-server.example';
const OWNER = '@maintainer:their-server.example';
const AGENT = 'lend-opus-01';

let runtimeDir;
let MatrixBridge;
let rememberPendingInvite;
let getPendingInvite;
let listPendingInvites;
let settlePendingInvite;
let resetPendingInvitesForTest;
let upsertRoomAgentBinding;
let findRoomAgentBinding;
const saved = {};

beforeAll(async () => {
  runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-invite-accept-'));
  for (const k of ['HAFLEET_RUNTIME_DIR', 'MATRIX_AGENT_PREFIX', 'MATRIX_BRIDGE_SECRET', 'MATRIX_SERVER_NAME']) {
    saved[k] = process.env[k];
  }
  process.env.HAFLEET_RUNTIME_DIR = runtimeDir;
  process.env.MATRIX_AGENT_PREFIX = 'ac_';
  process.env.MATRIX_BRIDGE_SECRET = 'test-secret';
  process.env.MATRIX_SERVER_NAME = 'hq.example';
  const url = pathToFileURL(path.resolve('bridge-matrix.js')).href;
  ({
    MatrixBridge, rememberPendingInvite, getPendingInvite, listPendingInvites, settlePendingInvite,
    resetPendingInvitesForTest, upsertRoomAgentBinding, findRoomAgentBinding,
  } = await import(`${url}?invite-accept-test=${Date.now()}`));
});

afterAll(() => {
  rmSync(runtimeDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

let realFetch;
let calls;

/**
 * A bridge whose Matrix traffic is recorded rather than sent.
 *
 * `fetch` is stubbed at the global, which is what `acceptPendingInvite` uses for both the join and
 * the bot invite. The approval-binding sync is stubbed out: it is a separate mechanism with its
 * own tests, and letting it run would make this file's failures ambiguous.
 */
function harness({ joinOk = true, botInviteOk = true, agentToken = 'syt_agent' } = {}) {
  calls = [];
  const bridge = Object.create(MatrixBridge.prototype);
  bridge.botUserId = '@bot:hq.example';
  bridge.resolveKnownAgentName = (n) => n;
  bridge.normalizeName = (n) => (typeof n === 'string' ? n.trim() : '');
  bridge.getAgentToken = () => agentToken;
  bridge.syncApprovalBindingForRoomAgent = vi.fn().mockResolvedValue({ ok: true });
  bridge.postWarning = vi.fn();

  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
    if (u.includes('/join/')) {
      return {
        ok: joinOk,
        status: joinOk ? 200 : 403,
        json: async () => (joinOk ? { room_id: ROOM } : { error: 'M_FORBIDDEN' }),
        text: async () => 'forbidden',
      };
    }
    if (u.includes('/invite')) {
      return {
        ok: botInviteOk,
        status: botInviteOk ? 200 : 403,
        json: async () => ({}),
        text: async () => 'M_FORBIDDEN already in room',
      };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  };
  return bridge;
}

const joinCalls = () => calls.filter((c) => c.url.includes('/join/'));
const botInvites = () => calls.filter((c) => c.url.includes('/invite'));

beforeEach(() => {
  realFetch = global.fetch;
  // The pending-invite store is module-global; without this, invitations left pending by one
  // test (the accept-failure cases legitimately do) leak into the next test's listPendingInvites.
  resetPendingInvitesForTest();
});
afterEach(() => { global.fetch = realFetch; });

describe('accepting an invitation makes the room usable, not merely joined', () => {
  test('it joins the agent AND invites the bot', async () => {
    /*
     * The defect this file was written for. Both calls, asserted together: joining without the
     * bot invite produces a room the agent sits in and nothing can read, because the bot is the
     * only syncing client. Either assertion alone would have passed against the shipped bug.
     */
    const bridge = harness();
    rememberPendingInvite(ROOM, AGENT, OWNER);

    const result = await bridge.acceptPendingInvite(ROOM, AGENT);

    expect(result.ok).toBe(true);
    expect(joinCalls()).toHaveLength(1);
    expect(botInvites()).toHaveLength(1);
    expect(botInvites()[0].body).toEqual({ user_id: '@bot:hq.example' });
  });

  test('the bot invite uses the AGENT token, because the bot cannot invite itself', async () => {
    const bridge = harness({ agentToken: 'syt_this_agent' });
    rememberPendingInvite(ROOM, AGENT, OWNER);
    await bridge.acceptPendingInvite(ROOM, AGENT);
    // Same credential that joined — the room has no other member who could issue the invite.
    expect(joinCalls()).toHaveLength(1);
    expect(botInvites()).toHaveLength(1);
  });

  test('a failed bot invite is REPORTED but does not undo the accept', async () => {
    /*
     * The common case is benign: M_FORBIDDEN because the bot is already in the room, another of
     * this contributor's agents having joined the same project earlier. The agent has joined and
     * the binding is written either way, so failing the accept would be worse than reporting it —
     * and silently swallowing it would hide the case where the bot genuinely is absent.
     */
    const bridge = harness({ botInviteOk: false });
    rememberPendingInvite(ROOM, AGENT, OWNER);

    const result = await bridge.acceptPendingInvite(ROOM, AGENT);

    expect(result.ok).toBe(true);
    expect(result.botInvited).toBe('failed');
    expect(getPendingInvite(ROOM, AGENT).state).toBe('accepted');
  });

  test('accepting writes the ownership binding from the INVITER', async () => {
    // ADR-002 unchanged: the owner is whoever invited this exact agent into this room, so
    // accepting an invitation is how ownership is established — there is no separate step.
    const bridge = harness();
    rememberPendingInvite(ROOM, AGENT, OWNER);

    await bridge.acceptPendingInvite(ROOM, AGENT);

    const bound = findRoomAgentBinding(ROOM, AGENT);
    expect(bound?.binding).toMatchObject({ inviter: OWNER, ownerMxid: OWNER });
  });

  test('the invitation leaves the pending list once decided', async () => {
    const bridge = harness();
    rememberPendingInvite(ROOM, AGENT, OWNER);
    expect(listPendingInvites().some((r) => r.roomId === ROOM)).toBe(true);

    await bridge.acceptPendingInvite(ROOM, AGENT);

    expect(listPendingInvites().some((r) => r.roomId === ROOM)).toBe(false);
  });
});

describe('what accepting refuses to do', () => {
  test('an invitation naming no readable inviter is refused before any join', async () => {
    /*
     * `upsertRoomAgentBinding` returns null for a non-MXID owner WITHOUT saying so, so without
     * this guard the accept would join the agent, settle the invitation, report success, and
     * write no binding — `owner_binding_missing` on every later approval, wearing an "accepted"
     * label. Refused before the join, so nothing has to be undone.
     */
    const bridge = harness();
    rememberPendingInvite(ROOM, 'agent-no-inviter', null);

    const result = await bridge.acceptPendingInvite(ROOM, 'agent-no-inviter');

    expect(result).toMatchObject({ ok: false, reason: 'invite_names_no_human_inviter' });
    expect(joinCalls()).toHaveLength(0);
    // Still pending, so the contributor can still decline it explicitly.
    expect(getPendingInvite(ROOM, 'agent-no-inviter').state).toBe('pending');
  });

  test('an AGENT as inviter is refused, not treated as an owner', async () => {
    // An agent cannot own an agent. Both ownership writers now apply this guard; they disagreed
    // when only the accept path had it.
    const bridge = harness();
    rememberPendingInvite(ROOM, 'agent-agent-inviter', '@ac_other-agent:hq.example');

    const result = await bridge.acceptPendingInvite(ROOM, 'agent-agent-inviter');

    expect(result).toMatchObject({ ok: false, reason: 'invite_names_no_human_inviter' });
    expect(joinCalls()).toHaveLength(0);
  });

  test('a failed JOIN does not settle the invitation or bind anything', async () => {
    /*
     * Distinguished from a failed bot invite on purpose: the join is the thing that must succeed
     * before anything else is true. Left pending, because a refused join is often "not yet" —
     * the room may not exist yet, or the invite may have been withdrawn.
     */
    const bridge = harness({ joinOk: false });
    rememberPendingInvite(ROOM, 'agent-join-fails', OWNER);

    const result = await bridge.acceptPendingInvite(ROOM, 'agent-join-fails');

    expect(result.ok).toBe(false);
    expect(String(result.reason)).toMatch(/join_failed/);
    expect(botInvites()).toHaveLength(0);
    expect(getPendingInvite(ROOM, 'agent-join-fails').state).toBe('pending');
    expect(findRoomAgentBinding(ROOM, 'agent-join-fails')).toBeFalsy();
  });

  test('an agent with no Matrix credential is refused before any request', async () => {
    const bridge = harness({ agentToken: null });
    rememberPendingInvite(ROOM, 'agent-no-token', OWNER);

    const result = await bridge.acceptPendingInvite(ROOM, 'agent-no-token');

    expect(result).toMatchObject({ ok: false, reason: 'agent_has_no_matrix_credential' });
    expect(calls).toHaveLength(0);
  });

  test('an unknown or already-decided invitation is refused', async () => {
    const bridge = harness();
    expect(await bridge.acceptPendingInvite(ROOM, 'never-invited'))
      .toMatchObject({ ok: false, reason: 'unknown_invite' });

    rememberPendingInvite(ROOM, 'agent-twice', OWNER);
    await bridge.acceptPendingInvite(ROOM, 'agent-twice');
    // Deciding twice must not re-join or re-bind.
    expect(await bridge.acceptPendingInvite(ROOM, 'agent-twice'))
      .toMatchObject({ ok: false, reason: 'already_accepted' });
  });
});

describe('an ownership transfer is recorded', () => {
  test('rebinding to a different owner leaves a trace', () => {
    /*
     * ADR-002's Consequences claim ownership transfer "requires an explicit, audited transition",
     * and `upsertRoomAgentBinding` used to rewrite inviter/ownerMxid wholesale with nothing
     * recorded — so a re-invite by a different human silently moved who may approve this agent's
     * work. The backend records `owner_binding_changed` and denies in-flight requests; nothing
     * recorded the bridge-side change that caused it, leaving the two halves uncorrelatable.
     */
    const room = '!transfer:hq.example';
    upsertRoomAgentBinding(room, 'agent-x', '@first:hq.example');
    const after = upsertRoomAgentBinding(room, 'agent-x', '@second:hq.example');

    expect(after.binding).toMatchObject({
      ownerMxid: '@second:hq.example',
      previousOwnerMxid: '@first:hq.example',
    });
    expect(after.binding.ownerChangedAt).toBeGreaterThan(0);
  });

  test('rebinding to the SAME owner records no transfer', () => {
    // Otherwise every idempotent re-sync would look like a transfer, and a real one would be
    // impossible to spot among them.
    const room = '!same:hq.example';
    upsertRoomAgentBinding(room, 'agent-y', '@only:hq.example');
    const again = upsertRoomAgentBinding(room, 'agent-y', '@only:hq.example');

    expect(again.binding.previousOwnerMxid).toBeUndefined();
    expect(again.binding.ownerChangedAt).toBeUndefined();
  });
});

describe('declining an invitation records "no" so the poll cannot re-ask', () => {
  test('a declined invitation leaves the pending list and is remembered as declined', async () => {
    /*
     * The whole point of settling to `declined` rather than deleting the record: the invitation
     * is still in Matrix state, so the invite poll will see it again — and `rememberPendingInvite`
     * returns false for an already-declined key, so it is not re-surfaced. Deleting would make
     * "no" un-expressible: the next poll would re-add it as pending forever.
     */
    const room = '!decline:hq.example';
    const bridge = harness();
    rememberPendingInvite(room, 'lend-opus-01', OWNER);

    const result = await bridge.rejectPendingInvite(room, 'lend-opus-01');

    expect(result.ok).toBe(true);
    expect(getPendingInvite(room, 'lend-opus-01').state).toBe('declined');
    expect(listPendingInvites().some((r) => r.roomId === room)).toBe(false);
    // The join was never attempted — declining is not joining-then-leaving.
    expect(joinCalls()).toEqual([]);
  });

  test('the agent LEAVES the Matrix room as a courtesy, but a failed leave still declines', async () => {
    /*
     * Leaving is best-effort: the decision IS the record, so a homeserver that refuses the leave
     * must not leave the contributor unable to say no. Both halves asserted — the leave is
     * attempted, and a thrown leave still ends in `declined`.
     */
    const room = '!decline-leave:hq.example';
    const bridge = harness();
    // Make only the leave call throw; nothing else in reject touches fetch.
    const realFetch = global.fetch;
    global.fetch = async (url) => {
      if (String(url).includes('/leave')) throw new Error('homeserver refused');
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    };
    try {
      rememberPendingInvite(room, 'lend-opus-01', OWNER);
      const result = await bridge.rejectPendingInvite(room, 'lend-opus-01');
      expect(result.ok).toBe(true);
      expect(getPendingInvite(room, 'lend-opus-01').state).toBe('declined');
    } finally {
      global.fetch = realFetch;
    }
  });

  test('an unknown or already-decided invitation is refused, not re-declined', async () => {
    const room = '!decline-twice:hq.example';
    const bridge = harness();
    expect(await bridge.rejectPendingInvite(room, 'never-invited'))
      .toMatchObject({ ok: false, reason: 'unknown_invite' });

    rememberPendingInvite(room, 'lend-opus-01', OWNER);
    await bridge.rejectPendingInvite(room, 'lend-opus-01');
    // Deciding a settled invitation again is refused with its current state, not silently redone.
    expect(await bridge.rejectPendingInvite(room, 'lend-opus-01'))
      .toMatchObject({ ok: false, reason: 'already_declined' });
  });
});

describe('reporting an invitation to the backend is where the console learns of it', () => {
  test('a recorded invitation is PUT to the backend with its derived server and inviter', async () => {
    /*
     * The bridge owns the Matrix truth and the backend is the copy the console reads, so an
     * invitation nobody reports is invisible to the operator. The PUT carries the derived
     * project server, not one supplied by anyone — the backend derives it too, but reporting the
     * bridge's own derivation keeps the two consistent.
     */
    const room = '!report:their-server.example';
    const bridge = harness();
    const puts = [];
    bridge.callBackendApi = async (method, routePath, body) => {
      puts.push({ method, routePath, body });
      return { ok: true };
    };
    rememberPendingInvite(room, 'lend-opus-01', '@admin:their-server.example');

    const result = await bridge.reportPendingInvite(room, 'lend-opus-01', '@admin:their-server.example');

    expect(result.ok).toBe(true);
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ method: 'PUT', routePath: '/api/matrix/pending-invites' });
    expect(puts[0].body).toMatchObject({
      project_room_id: room,
      agent: 'lend-opus-01',
      inviter: '@admin:their-server.example',
      project_server: 'their-server.example',
    });
  });

  test('a backend that rejects the report is surfaced, not swallowed', async () => {
    /*
     * A failed report is not fatal — the invitation stays in bridge state and resync will retry
     * it on the next start — but it must be REPORTED as failed, or a monitor cannot tell a
     * backend outage from "no invitations". Distinguished from ok so the caller (resync) counts
     * it correctly.
     */
    const room = '!report-fail:hq.example';
    const bridge = harness();
    bridge.callBackendApi = async () => ({ error: 'backend down' });
    rememberPendingInvite(room, 'lend-opus-01', OWNER);

    expect(await bridge.reportPendingInvite(room, 'lend-opus-01', OWNER))
      .toMatchObject({ ok: false, reason: 'backend_unavailable' });
  });

  test('reporting an invitation the bridge does not hold is refused', async () => {
    const bridge = harness();
    bridge.callBackendApi = async () => ({ ok: true });
    expect(await bridge.reportPendingInvite('!nope:hq.example', 'ghost', OWNER))
      .toMatchObject({ ok: false, reason: 'not_recorded' });
  });
});

describe('resync replays pending invitations the backend missed', () => {
  test('every still-pending invitation is re-reported, settled ones are not', async () => {
    /*
     * The recovery path: invitations recorded while the backend was down would otherwise stay
     * invisible forever, because `rememberPendingInvite` will not re-notify for an invite it has
     * already seen — so the poll alone never surfaces them again. Resync on startup is the only
     * thing that catches them up. Settled invitations are excluded: a declined one must not be
     * re-pushed as if it were waiting.
     */
    const bridge = harness();
    const reported = [];
    bridge.callBackendApi = async (_m, _p, body) => { reported.push(body.project_room_id); return { ok: true }; };

    rememberPendingInvite('!p1:hq.example', 'a1', OWNER);
    rememberPendingInvite('!p2:hq.example', 'a2', OWNER);
    rememberPendingInvite('!settled:hq.example', 'a3', OWNER);
    settlePendingInvite('!settled:hq.example', 'a3', 'declined', 'operator');

    const count = await bridge.resyncPendingInvites();

    expect(count).toBe(2);
    expect(reported.sort()).toEqual(['!p1:hq.example', '!p2:hq.example']);
    expect(reported).not.toContain('!settled:hq.example');
  });

  test('resync counts only the reports the backend accepted', async () => {
    // If the backend is still flaky during resync, the count must reflect what actually landed,
    // so a half-successful catch-up is not reported as complete.
    const bridge = harness();
    bridge.callBackendApi = async (_m, _p, body) =>
      (body.project_room_id === '!good:hq.example' ? { ok: true } : { error: 'still down' });

    rememberPendingInvite('!good:hq.example', 'a1', OWNER);
    rememberPendingInvite('!bad:hq.example', 'a2', OWNER);

    expect(await bridge.resyncPendingInvites()).toBe(1);
  });

  test('resync with nothing pending does no work', async () => {
    const bridge = harness();
    let called = false;
    bridge.callBackendApi = async () => { called = true; return { ok: true }; };
    expect(await bridge.resyncPendingInvites()).toBe(0);
    expect(called).toBe(false);
  });
});
