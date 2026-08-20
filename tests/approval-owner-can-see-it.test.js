/*
 * A DELIVERED APPROVAL IS NOT A SEEN ONE.
 *
 * `onApprovalRequested` reports success on an event id. An event id proves a message landed in a room. It
 * does not prove that the human who has to decide is IN that room — and on a live rig those two came apart
 * in the most ordinary way imaginable: `bridge-state.json` held a `botDmRooms` entry for `@operator:…`
 * whose only joined member was the BOT. The operator had been invited and had never accepted. The room
 * existed, was recorded, and was exactly the room `HAFLEET_OWNER_DM_ROOM` would have been pointed at.
 *
 * Every approval sent there would have been delivered, reported delivered, and waited for a decision from
 * somebody who could not see it being asked for — until the request expired and was denied for timing out.
 * Nothing in the product checks this: `resolveOwnerFor` takes the mxid and the room id as given, and
 * `upsertBinding` requires both without checking that one is in the other. The backend cannot check, since
 * reading a room's membership needs a Matrix credential for a room usually on HAFleet's own homeserver.
 *
 * So the check lives at the one place holding both the room and a credential for it, it runs AFTER the
 * send, and it never blocks one — a message keeps, and a human who joins later will read it. What was
 * missing was anybody being told.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { pathToFileURL } from 'url';
import { restoreEnv, snapshotEnv } from './helpers/env.js';

const joinedMembersOnSide = vi.fn();

vi.mock('../lib/matrix-representative.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, joinedMembersOnSide: (...args) => joinedMembersOnSide(...args) };
});

const OURS = 'hafleet.test';
const OWNER = `@alex:${OURS}`;
const DM = `!owner-dm:${OURS}`;
const SIDE = 'customer.test';

const approvalOn = (roomId, owner = OWNER) => ({
  id: '$a-1', agent: 'wf_coordinator', owner_mxid: owner, owner_dm_room_id: roomId,
});
const serverOf = (roomId) => String(roomId ?? '').slice(String(roomId ?? '').indexOf(':') + 1).toLowerCase();

let bridgeModule;
let runtimeDir;
let envSnapshot;

beforeAll(async () => {
  envSnapshot = snapshotEnv(['HAFLEET_RUNTIME_DIR', 'MATRIX_SERVER_NAME']);
  runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'approval-owner-visible-'));
  process.env.HAFLEET_RUNTIME_DIR = runtimeDir;
  process.env.MATRIX_SERVER_NAME = OURS;
  bridgeModule = await import(`${pathToFileURL(path.resolve('bridge-matrix.js')).href}?as-owner-visible`);
});

afterAll(() => {
  restoreEnv(envSnapshot);
  rmSync(runtimeDir, { recursive: true, force: true });
});

beforeEach(() => { joinedMembersOnSide.mockReset(); });

/** The minimum the check reads. `members` may be an array, or a function that throws. */
function selfWith({ members = [], sides = {} } = {}) {
  const it = {
    warnings: [],
    postWarning(message, meta) { this.warnings.push({ message, ...meta }); },
    actingSideFor: (id) => sides[String(id).toLowerCase()] ?? null,
    botClient: {
      getJoinedRoomMembers: async () => (typeof members === 'function' ? members() : members),
    },
  };
  return it;
}

const check = (it, approval) => bridgeModule.MatrixBridge.prototype.warnIfOwnerCannotSeeApprovalRoom
  .call(it, approval, serverOf(approval.owner_dm_room_id));

const said = (it) => it.warnings.map((w) => w.message).join(' ');

describe('the owner DM room on our own homeserver', () => {
  test('THE DEFECT: an owner who is not in the room is reported, with the remedy', async () => {
    const it = selfWith({ members: ['@hafleet:hafleet.test'] });
    await check(it, approvalOn(DM));

    expect(it.warnings).toHaveLength(1);
    expect(said(it)).toContain(OWNER);
    expect(said(it)).toContain(DM);
    // The two ways it happens, both worth naming: never accepted, or left afterwards.
    expect(said(it)).toMatch(/invited and never joined, or since departed/);
    expect(said(it)).toMatch(/HAFLEET_OWNER_DM_ROOM/);
    // Deduped per ROOM: twenty approvals against one bad room file one alert, not twenty.
    expect(it.warnings[0].scope).toBe(DM);
    expect(it.warnings[0].kind).toBe('approval-owner-absent');
  });

  test('an owner who IS in the room says nothing at all', async () => {
    const it = selfWith({ members: ['@hafleet:hafleet.test', OWNER] });
    await check(it, approvalOn(DM));
    expect(it.warnings).toEqual([]);
  });

  test('the mxid comparison is case-insensitive, because Matrix localparts are', async () => {
    // A false alarm here would train an operator to ignore the alarm that matters.
    const it = selfWith({ members: [`@ALEX:${OURS.toUpperCase()}`] });
    await check(it, approvalOn(DM));
    expect(it.warnings).toEqual([]);
  });

  test('AN UNREADABLE MEMBERSHIP SAYS NOTHING — "I could not ask" is not "the owner is absent"', async () => {
    const it = selfWith({ members: () => { throw new Error('M_FORBIDDEN'); } });
    await check(it, approvalOn(DM));
    expect(it.warnings).toEqual([]);
  });

  test('nor does a shape that is not a member list', async () => {
    const it = selfWith({ members: null });
    await check(it, approvalOn(DM));
    expect(it.warnings).toEqual([]);
  });

  test('with no bot at all it is skipped, not guessed', async () => {
    // #119's bot-less mode: the inbound path stays alive without a bot, and a check that needs one
    // must decline rather than report an absence it cannot see.
    const it = selfWith({ members: [] });
    it.botClient = null;
    await check(it, approvalOn(DM));
    expect(it.warnings).toEqual([]);
  });
});

describe('an owner DM room on a project side', () => {
  const acting = {
    side: { serverName: SIDE, apiBaseUrl: 'http://127.0.0.1:8008' },
    credential: { kind: 'appservice', asToken: 'as_secret_never_logged', senderLocalpart: 'hafleet', namespace: '@ac_.*' },
  };
  const theirDm = `!owner-dm:${SIDE}`;
  const theirOwner = `@borrower:${SIDE}`;

  test('read with the SIDE\'s credential, because the bot has no account there', async () => {
    /*
     * ADR-016: an approval is the borrower's decision, so the room goes where the decider is — on their
     * homeserver, where `getJoinedRoomMembers` cannot reach. Asking with the bot would fail and the
     * check would silently never run.
     */
    const it = selfWith({ sides: { [SIDE]: acting } });
    joinedMembersOnSide.mockResolvedValue({ known: true, members: ['@hafleet:customer.test'], reason: null });

    await check(it, approvalOn(theirDm, theirOwner));

    expect(joinedMembersOnSide).toHaveBeenCalledTimes(1);
    const [args] = joinedMembersOnSide.mock.calls[0];
    expect(args.credential).toEqual(acting.credential);
    expect(args.roomId).toBe(theirDm);
    expect(said(it)).toContain(theirOwner);
  });

  test('a borrower who is in their own room says nothing', async () => {
    const it = selfWith({ sides: { [SIDE]: acting } });
    joinedMembersOnSide.mockResolvedValue({ known: true, members: [theirOwner], reason: null });
    await check(it, approvalOn(theirDm, theirOwner));
    expect(it.warnings).toEqual([]);
  });

  test('`known: false` is silence, not an absence', async () => {
    const it = selfWith({ sides: { [SIDE]: acting } });
    joinedMembersOnSide.mockResolvedValue({ known: false, members: [], reason: 'membership unreadable: 502' });
    await check(it, approvalOn(theirDm, theirOwner));
    expect(it.warnings).toEqual([]);
  });

  test('a side we hold no credential for is skipped without asking', async () => {
    const it = selfWith({ sides: {} });
    await check(it, approvalOn(theirDm, theirOwner));
    expect(joinedMembersOnSide).not.toHaveBeenCalled();
    expect(it.warnings).toEqual([]);
  });
});

/*
 * AND THAT ANYTHING CALLS IT.
 *
 * A MUTATION SURVIVED without this. Deleting the call from `onApprovalRequested` left every test above
 * green, because they drive the method directly — the same hole `tests/join-backfill.test.js` documents
 * about itself, and the same one the appservice invite path fell through for months. A method that works
 * and is never invoked is indistinguishable from no method at all.
 */
describe('the publish path invokes it', () => {
  const approval = {
    id: '$approval-wired', agent: 'wf_coordinator', project: 'acme',
    project_room_id: `!project:${OURS}`, owner_mxid: OWNER, owner_dm_room_id: DM,
    upstream_request_id: 'u-1', input_digest: 'a'.repeat(64), runtime: 'claude',
    tool_name: 'Bash', description: 'do a thing', input_preview: '{}',
    expires_at: 4_000_000_000_000, status: 'pending',
  };

  /** A bridge with both surfaces stubbed to succeed, so only the visibility check is under test. */
  function wired({ members }) {
    const bridge = new bridgeModule.MatrixBridge();
    const warnings = [];
    bridge.callBackendApi = async (_method, routePath) => (
      routePath.endsWith('/matrix') ? { approval } : { ok: true }
    );
    bridge.ensureApprovalDmSecurity = async () => {};
    bridge.botClient = {
      sendMessage: async () => '$private',
      getJoinedRoomMembers: async () => members,
    };
    bridge.getAgentToken = () => 'agent-token';
    bridge.sendAsAgentContent = async () => '$public';
    bridge.rememberMatrixEvent = () => {};
    bridge.postWarning = (message, meta) => { warnings.push({ message, ...meta }); };
    return { bridge, warnings };
  }

  test('an approval whose owner is absent warns, and the delivery still succeeds', async () => {
    const { bridge, warnings } = wired({ members: ['@hafleet:hafleet.test'] });
    const result = await bridge.onApprovalRequested({ request_id: approval.id });

    // BOTH halves. The warning must not come at the cost of the delivery it is warning about.
    expect(result.ok).toBe(true);
    expect(result.privateEventId).toBe('$private');
    expect(warnings.map((w) => w.message).join(' ')).toContain(OWNER);
    expect(warnings[0].kind).toBe('approval-owner-absent');
  });

  test('and an approval whose owner is present warns about nothing', async () => {
    const { bridge, warnings } = wired({ members: ['@hafleet:hafleet.test', OWNER] });
    const result = await bridge.onApprovalRequested({ request_id: approval.id });
    expect(result.ok).toBe(true);
    expect(warnings).toEqual([]);
  });
});

/*
 * AND THE OTHER SURFACE — the redacted public notice, which could not be sent AT ALL for the agents this
 * product actually dispatches.
 *
 * ADR-003 is "both surfaces or neither", so a public notice that cannot go out fails the whole approval
 * closed. `onApprovalRequested` resolved that sender with `getAgentToken`, and an appservice project side
 * mints NO per-agent token — the namespace is what makes the agent ours to act for, which is the entire
 * reason a project-side agent needs no registration. So the throw fired for exactly the normal case.
 *
 * Walked on the rig before the fix: an approval for `soaker` in its own project room logged
 * `missing Matrix token for approval agent soaker` and came back `status: denied`. A request its owner was
 * never asked about, refused on the requester's behalf, with the reason visible only in a log.
 *
 * `agentSenderFor` is the resolver every other agent send already uses, and it asks the question the ROOM
 * asks rather than the one the credential inventory answers.
 */
describe('the public notice, for an agent with no token of its own', () => {
  const approvalFor = (roomId) => ({
    id: '$approval-public', agent: 'soaker', project: 'soakroom', project_room_id: roomId,
    owner_mxid: OWNER, owner_dm_room_id: DM, upstream_request_id: 'u-1',
    input_digest: 'a'.repeat(64), runtime: 'claude', tool_name: 'Bash', description: 'do it',
    input_preview: '{}', expires_at: 4_000_000_000_000, status: 'pending',
  });

  /*
   * THE SHAPE `actingCredentials` STORES, not the one `actingSideFor` returns — a distinction that cost
   * two failing tests. The map holds the raw rows the backend's acting-credentials endpoint sends; the
   * `{ side, credential }` pair is what the lookup BUILDS from a row. A fixture written in the return
   * shape makes every lookup answer null, and the code under test then reports "no credential" correctly
   * about a fixture that was wrong.
   */
  const acting = (serverName) => ({
    sideId: serverName, serverName, apiBaseUrl: 'http://127.0.0.1:8008',
    kind: 'appservice', asToken: 'as_secret_never_logged', senderLocalpart: 'hafleet', namespace: '@ac_.*',
  });

  /** A bridge with the private surface stubbed and the PUBLIC one recorded, sender shape and all. */
  function publishing({ approval, sides = new Map(), token = null }) {
    const bridge = new bridgeModule.MatrixBridge();
    const sent = [];
    bridge.callBackendApi = async (_m, routePath) => (routePath.endsWith('/matrix') ? { approval } : { ok: true });
    bridge.ensureApprovalDmSecurity = async () => {};
    bridge.botClient = { sendMessage: async () => '$private', getJoinedRoomMembers: async () => [OWNER] };
    bridge.actingCredentials = sides;
    bridge.getAgentToken = () => token;
    bridge.sendAsAgentContent = async (sender, roomId, content) => {
      sent.push({ sender, roomId, content });
      return '$public';
    };
    bridge.rememberMatrixEvent = () => {};
    bridge.postWarning = () => {};
    return { bridge, sent };
  }

  test('THE DEFECT: a room on a project side is spoken into by that side\'s appservice', async () => {
    const roomId = `!project:${SIDE}`;
    const { bridge, sent } = publishing({
      approval: approvalFor(roomId), sides: new Map([[SIDE, acting(SIDE)]]),
    });

    const result = await bridge.onApprovalRequested({ request_id: '$approval-public' });

    expect(result).toMatchObject({ ok: true, privateEventId: '$private', publicEventId: '$public' });
    expect(sent).toHaveLength(1);
    expect(sent[0].sender.kind).toBe('appservice');
    expect(sent[0].sender.agentUserId).toBe(`@ac_soaker:${SIDE}`);
    expect(sent[0].sender.credential.asToken).toBe('as_secret_never_logged');
    // Still redacted — the fix changes WHO speaks, never WHAT the project room is told.
    expect(JSON.stringify(sent[0].content)).not.toContain('input_preview');
  });

  test('and so is a room on OUR server when we hold that side\'s credential — the co-located case', async () => {
    /*
     * `sideForRoom` deliberately answers null for our own server, so this reaches the fallback branch
     * instead. It is the shape the walkthrough rig runs: one homeserver serving both HAFleet and the
     * customer, which is the topology the operator guide documents.
     */
    const roomId = `!project:${OURS}`;
    const { bridge, sent } = publishing({
      approval: approvalFor(roomId), sides: new Map([[OURS, acting(OURS)]]),
    });

    const result = await bridge.onApprovalRequested({ request_id: '$approval-public' });
    expect(result.ok).toBe(true);
    expect(sent[0].sender.kind).toBe('appservice');
    expect(sent[0].sender.agentUserId).toBe(`@ac_soaker:${OURS}`);
  });

  test('with NO sender available it still fails closed, and says which room', async () => {
    /*
     * "Both surfaces or neither" is not relaxed by this. What changes is that the refusal now happens
     * only when there is genuinely no way to speak, rather than whenever an agent holds no token.
     */
    const roomId = `!project:${SIDE}`;
    const { bridge, sent } = publishing({ approval: approvalFor(roomId), sides: new Map() });
    const failures = [];
    bridge.callBackendApi = async (_m, routePath) => {
      if (routePath.endsWith('/matrix')) return { approval: approvalFor(roomId) };
      if (routePath.includes('/delivery-failed')) failures.push(routePath);
      return { ok: true };
    };

    const result = await bridge.onApprovalRequested({ request_id: '$approval-public' });
    expect(result.ok).toBe(false);
    expect(sent).toHaveLength(0);
    expect(failures).toHaveLength(1);
  });
});

describe('what it refuses to do', () => {
  test('an approval naming no room or no owner is not a warning', async () => {
    const it = selfWith({ members: [] });
    await check(it, { ...approvalOn(DM), owner_dm_room_id: null });
    await check(it, { ...approvalOn(DM), owner_mxid: null });
    expect(it.warnings).toEqual([]);
  });

  test('IT NEVER BLOCKS THE DELIVERY IT IS CHECKING', async () => {
    /*
     * The ordering that matters. Refusing to deliver, or throwing out of this, would turn "the owner may
     * not see this" into "the owner definitely did not get it" — a strictly worse outcome, and one that
     * `onApprovalRequested` would fail closed on.
     */
    const it = selfWith({ members: () => { throw new Error('everything is on fire'); } });
    await expect(check(it, approvalOn(DM))).resolves.toBeUndefined();
  });
});
