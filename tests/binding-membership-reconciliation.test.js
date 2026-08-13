/*
 * A binding claims a project can reach an agent. Is the agent actually in the room?
 *
 * B1, and it was found by an operator rather than by a test. They asked why their agent appeared in
 * three projects, and answering it required me to read `m.room.member` state for three rooms by
 * hand — because the binding lives in the backend's approval store and the membership lives in the
 * homeserver, and the two had never been compared in either direction. The console presents
 * bindings as "the record that actually lets a project reach the agent", so a binding for a room
 * the agent is not in is the console asserting reachability nobody checked.
 *
 * In that case all three were real. That is not reassurance: the answer took manual work precisely
 * because nothing could report it, and the same manual work would have been needed to discover the
 * opposite.
 *
 * THE FALSE CASE IS TESTED HERE RATHER THAN AGAINST THE LIVE STACK. Proving it there would mean
 * planting a binding for a room the agent is not in — fabricating a project in the operator's own
 * console, which is the exact pollution that had just been cleaned out of it.
 */

import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { ApprovalStore } from '../lib/approval-store.js';

const AGENT = 'wf_codex';
const ROOM = '!bound:hq.example';
const OWNER = '@alice:hq.example';

let dir;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

function store() {
  dir = mkdtempSync(path.join(tmpdir(), 'binding-membership-'));
  // `new ApprovalStore(filePath)` — a path string, not an options object. The factory takes the
  // same first argument; my first version passed `{ file }` and every case died in path.join.
  return new ApprovalStore(path.join(dir, 'approvals.json'));
}

const bind = (s, room = ROOM) => s.upsertBinding({
  agent: AGENT,
  project: 'acme/thing',
  project_room_id: room,
  owner_mxid: OWNER,
  owner_dm_room_id: '!dm:hq.example',
});

describe('an unobserved binding says so, rather than guessing', () => {
  test('a fresh binding reports membership as UNKNOWN, not as joined', () => {
    /*
     * The default has to be null. `true` would claim reachability nothing has checked — the exact
     * defect this field exists to close. `false` would accuse every binding of being broken before
     * the first observation, which would make the flag meaningless on day one.
     */
    const s = store();
    const b = bind(s);
    expect(b.agentJoined).toBeNull();
    expect(b.membershipCheckedAt).toBeNull();
  });
});

describe('observing membership', () => {
  test('a joined agent is recorded with the time it was checked', () => {
    const s = store();
    bind(s);
    const b = s.observeBindingMembership({ agent: AGENT, project_room_id: ROOM, agent_joined: true });
    expect(b.agentJoined).toBe(true);
    // The timestamp is the point: "confirmed" with no age is indistinguishable from "confirmed
    // once, months ago, by a bridge that has since stopped running".
    expect(typeof b.membershipCheckedAt).toBe('number');
  });

  test('THE CASE THAT MATTERS: a binding whose room the agent is not in is recorded as false', () => {
    const s = store();
    bind(s);
    const b = s.observeBindingMembership({ agent: AGENT, project_room_id: ROOM, agent_joined: false });
    expect(b.agentJoined).toBe(false);
    // And the binding is NOT deactivated by the observation. Reachability failing is not the same
    // as the contributor withdrawing permission, and only they may do the latter.
    expect(b.active).toBe(true);
  });

  test('an observation about a binding nobody made is refused, not stored', () => {
    /*
     * Returning null rather than creating a record. A membership report is evidence ABOUT a
     * binding; letting it create one would let the bridge manufacture reachability records from
     * whatever rooms an agent happens to be in — and an agent is in DM and approval rooms that are
     * nobody's project.
     */
    const s = store();
    expect(s.observeBindingMembership({
      agent: AGENT, project_room_id: '!never-bound:hq.example', agent_joined: true,
    })).toBeNull();
  });

  test('a non-boolean is refused, so "unknown" cannot arrive disguised as an answer', () => {
    const s = store();
    bind(s);
    for (const bad of [undefined, null, 'true', 1]) {
      expect(() => s.observeBindingMembership({
        agent: AGENT, project_room_id: ROOM, agent_joined: bad,
      }), String(bad)).toThrow(/agent_joined must be a boolean/);
    }
  });
});

describe('a binding write does not erase what was observed', () => {
  test('re-pushing a binding carries the last membership forward', () => {
    /*
     * The bridge re-pushes bindings routinely — `syncApprovalBindingForRoom` runs on invite
     * acceptance, room scans and trust changes. If an upsert reset membership to null, every push
     * would return the console to "never checked" and the flag would flicker instead of holding.
     */
    const s = store();
    bind(s);
    s.observeBindingMembership({ agent: AGENT, project_room_id: ROOM, agent_joined: false });
    const after = bind(s);
    expect(after.agentJoined).toBe(false);
    expect(after.membershipCheckedAt).not.toBeNull();
  });

  test('and a later observation still overrides it', () => {
    // Carrying forward must not mean freezing: the agent joining is exactly the transition the
    // console needs to reflect.
    const s = store();
    bind(s);
    s.observeBindingMembership({ agent: AGENT, project_room_id: ROOM, agent_joined: false });
    bind(s);
    const fixed = s.observeBindingMembership({ agent: AGENT, project_room_id: ROOM, agent_joined: true });
    expect(fixed.agentJoined).toBe(true);
  });
});

describe('bindings are per (agent, room)', () => {
  test('observing one room does not answer for another', () => {
    // Two bindings for the same agent are two separate claims, and an operator with one broken and
    // one sound needs to see which. A per-agent flag would have collapsed them.
    const s = store();
    bind(s, '!a:hq.example');
    bind(s, '!b:hq.example');
    s.observeBindingMembership({ agent: AGENT, project_room_id: '!a:hq.example', agent_joined: false });

    const all = s.listBindings({});
    const a = all.find((b) => b.projectRoomId === '!a:hq.example');
    const b = all.find((x) => x.projectRoomId === '!b:hq.example');
    expect(a.agentJoined).toBe(false);
    expect(b.agentJoined).toBeNull();
  });
});
