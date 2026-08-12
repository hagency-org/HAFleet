import { describe, it, expect, beforeEach } from 'vitest';
import {
  createTaskStore, STATUSES, PRIORITIES, GRANULARITIES, TRANSITIONS,
} from '../lib/task-store.js';

/*
 * lib/task-store.js is the one signal /api/usage declares as MEASURED
 * (backend-v2.js:11193 — `tasks: { available: true, source: 'lib/task-store.js' }`),
 * and it had no test file. Everything a contributor is shown about what their agent
 * actually did is derived from this Map.
 *
 * The two claims these tests exist to defend:
 *
 * 1. THE STATUS MACHINE IS THE AUTHORISATION BOUNDARY. /api/tasks/:id/transition and
 *    /api/tasks/:id/execution are agent-callable (backend-v2.js:10194, 10225) while
 *    /api/tasks/:id is operator-only. So TRANSITIONS is the only thing stopping an
 *    agent marking a fresh task `done`, and updateTaskExecution's narrow field list is
 *    the only thing stopping it going round the machine altogether.
 *
 * 2. A FAILED WRITE LEAVES NO PHANTOM. commitMutation snapshots, mutates, persists,
 *    and restores on failure. Two things make that non-trivial and both are tested
 *    below: the snapshot must be DEEP (the mutators push into task.comments and assign
 *    to task fields in place), and a `save` that THROWS must roll back as well as one
 *    that returns false — `save` is backend-v2.js's saveJson, which can do either.
 *
 * A task that exists in memory and not on disk is the specific failure worth guarding:
 * the assignee has already been notified (backend-v2.js:10131), the caller was told
 * `ok: true`, and the task vanishes on the next restart.
 */

/** A store with a counting, controllable persist adapter. */
function makeStore({ initialData, mode = 'ok' } = {}) {
  const state = { saves: 0, lastSaved: null, mode };
  const store = createTaskStore({
    initialData,
    save: (data) => {
      state.saves += 1;
      state.lastSaved = data;
      if (state.mode === 'throw') throw new Error('ENOSPC');
      if (state.mode === 'false') return false;
      return true;
    },
  });
  return { store, state };
}

const newTask = (store, over = {}) => store.createTask({ title: 'a task', ...over });

/** Drives a task to a given status through the legal path. */
function advanceTo(store, id, status) {
  if (status === 'created') return store.getTask(id);
  store.transitionTask(id, 'accepted');
  if (status === 'accepted') return store.getTask(id);
  store.transitionTask(id, 'in_progress');
  if (status === 'in_progress') return store.getTask(id);
  if (status === 'blocked') {
    return store.transitionTask(id, 'blocked', { waiting_reason: 'r', waiting_until: '2026-01-01T00:00:00Z' });
  }
  return store.transitionTask(id, 'done');
}

// ── the vocabulary the API and the console both index by ──────────────
describe('the declared vocabulary', () => {
  it('exports exactly the five statuses /api/usage buckets by', () => {
    /*
     * backend-v2.js:11087 hard-codes the same five names to build tasksByStatus. A
     * status this module accepts but that list does not know about is counted nowhere:
     * the task exists, the console shows it, and the usage row says the agent has zero
     * tasks in any state.
     */
    expect([...STATUSES].sort()).toEqual(['accepted', 'blocked', 'created', 'done', 'in_progress']);
    expect([...PRIORITIES].sort()).toEqual(['p0', 'p1', 'p2', 'p3']);
    expect([...GRANULARITIES].sort()).toEqual(['epic', 'subtask', 'task']);
  });

  it('declares no outbound transition from done', () => {
    // `done` is terminal by ABSENCE from the table rather than by a check, so this is
    // the assertion that keeps it terminal: adding a key for it would silently reopen
    // completed work.
    expect(TRANSITIONS.has('done')).toBe(false);
    expect([...TRANSITIONS.keys()].sort()).toEqual(['accepted', 'blocked', 'created', 'in_progress']);
  });
});

// ── createTask ────────────────────────────────────────────────────────
describe('createTask', () => {
  let store;
  let state;
  beforeEach(() => { ({ store, state } = makeStore()); });

  it('requires a real title', () => {
    // The title is the only field a human reads in a task list. A whitespace-only title
    // would produce a row that cannot be identified or searched for.
    for (const bad of [undefined, null, '', '   ', 42, {}]) {
      expect(() => store.createTask({ title: bad }), JSON.stringify(bad)).toThrow(/title is required/);
    }
    expect(store.dump()).toEqual([]);
    expect(state.saves).toBe(0);
  });

  it('starts every task in created, with the lifecycle timestamps unset', () => {
    /*
     * `created` is the only status TRANSITIONS accepts as a starting point. A task born
     * in any other state would be unreachable by the machine — /accept would answer
     * invalid_transition forever. The null timestamps matter because `started_at` is the
     * elapsed-time anchor and a pre-set one would date the task from creation rather
     * than from when work began.
     */
    const task = newTask(store, { title: 'seed' });
    expect(task).toMatchObject({
      status: 'created',
      started_at: null,
      completed_at: null,
      heartbeat_at: null,
      waiting_reason: null,
      waiting_until: null,
      health: null,
      comments: [],
      description: '',
      priority: 'p2',
      granularity: 'task',
      assignee: null,
      parent_id: null,
    });
    expect(task.created_at).toBe(task.updated_at);
    expect(task.id).toMatch(/^task_\d+_[a-z0-9]+$/);
  });

  it('rejects an out-of-vocabulary priority or granularity instead of defaulting it', () => {
    /*
     * Decoy pair: `undefined` legitimately defaults, so an unknown value must NOT take
     * the same path. The console filters by priority and groups by granularity, so a
     * task stored as `p9` is filtered out of every view and effectively lost.
     */
    expect(() => newTask(store, { priority: 'p9' })).toThrow(/invalid priority: p9/);
    expect(() => newTask(store, { priority: 'P0' })).toThrow(/invalid priority/);
    expect(() => newTask(store, { granularity: 'story' })).toThrow(/invalid granularity: story/);
    expect(newTask(store, { priority: undefined }).priority).toBe('p2');
    expect(newTask(store, { granularity: undefined }).granularity).toBe('task');
    expect(newTask(store, { priority: 'p0', granularity: 'epic' }))
      .toMatchObject({ priority: 'p0', granularity: 'epic' });
  });

  it('refuses a parent that does not exist, and persists nothing', () => {
    // An orphaned parent_id is a dangling reference in tasks.json that no later
    // validation revisits, so the check has to happen at the door.
    expect(() => newTask(store, { parent_id: 'task_does_not_exist' }))
      .toThrow(/parent task not found: task_does_not_exist/);
    expect(state.saves).toBe(0);
    const parent = newTask(store, { title: 'parent' });
    expect(newTask(store, { parent_id: parent.id }).parent_id).toBe(parent.id);
  });

  it('bounds the label list: deduped, blank-free, capped at 20, each truncated to 64', () => {
    /*
     * Labels are a filter key and they are rewritten into tasks.json on every single
     * mutation of the task, so an unbounded array is paid for on every save forever.
     *
     * The duplicates come FIRST and the 21st distinct label comes LAST, so dropping the
     * dedupe changes which labels survive the cap rather than merely adding entries —
     * without that ordering a broken cap and a broken dedupe look identical.
     */
    const labels = ['dup', 'dup', 'dup', '   ', '', ...Array.from({ length: 20 }, (_, i) => `L${i}`)];
    const task = newTask(store, { labels });
    expect(task.labels).toHaveLength(20);
    expect(task.labels[0]).toBe('dup');
    expect(task.labels.filter((l) => l === 'dup')).toHaveLength(1);
    // 'dup' plus L0..L18 fills the cap; L19 is the one that does not fit.
    expect(task.labels).not.toContain('L19');
    expect(task.labels.some((l) => l.trim() === '')).toBe(false);
    expect(newTask(store, { labels: ['x'.repeat(100)] }).labels[0]).toHaveLength(64);
    expect(newTask(store, { labels: 'not-an-array' }).labels).toEqual([]);
  });

  it('truncates rather than rejects an over-long title and description', () => {
    // The lengths are the durable-record bound. Rejecting a long description would lose
    // a whole task over a paste; storing it unbounded puts an arbitrary blob in a file
    // that is rewritten whole on every mutation.
    const task = newTask(store, { title: 't'.repeat(400), description: 'd'.repeat(5000) });
    expect(task.title).toHaveLength(255);
    expect(task.description).toHaveLength(4096);
  });

  it('leaves NO task behind when the write fails', () => {
    /*
     * The phantom-task case. The endpoint answers `ok: true` with the task and notifies
     * the assignee (backend-v2.js:10131-10134); if the store kept a task the write had
     * rejected, an agent would be told to work on something that disappears at restart.
     */
    const failing = makeStore({ mode: 'false' });
    expect(() => newTask(failing.store)).toThrow(/task persistence failed/);
    expect(failing.store.dump()).toEqual([]);

    const throwing = makeStore({ mode: 'throw' });
    let error;
    try { newTask(throwing.store); } catch (e) { error = e; }
    expect(error.code).toBe('persistence_failed');
    expect(throwing.store.dump()).toEqual([]);
  });
});

// ── initial load ──────────────────────────────────────────────────────
describe('loading tasks.json', () => {
  it('drops rows with no id and keeps the last of any duplicate', () => {
    /*
     * tasks.json is loaded with a `[]` fallback and is hand-edited during incidents. A
     * row without an id would be keyed `undefined`, reachable by nothing, and still
     * rewritten on every save — a task that exists on disk and cannot be seen, closed
     * or deleted.
     */
    const { store } = makeStore({
      initialData: [
        { title: 'no id' },
        null,
        { id: 't1', title: 'first' },
        { id: 't1', title: 'second' },
        { id: 't2', title: 'other' },
      ],
    });
    expect(store.dump().map((t) => t.id)).toEqual(['t1', 't2']);
    expect(store.getTask('t1').title).toBe('second');
  });

  it('tolerates a non-array on disk instead of refusing to start', () => {
    // A corrupt tasks.json must not take the backend down; storage-adapter already
    // quarantines unparseable files, and this is the layer for a parseable wrong shape.
    expect(makeStore({ initialData: { not: 'an array' } }).store.dump()).toEqual([]);
    expect(makeStore({ initialData: undefined }).store.dump()).toEqual([]);
  });
});

// ── the status machine ────────────────────────────────────────────────
describe('transitionTask', () => {
  let store;
  let state;
  beforeEach(() => { ({ store, state } = makeStore()); });

  it('permits exactly the transitions TRANSITIONS declares, and no others', () => {
    /*
     * Exhaustive, because this table is the authorisation boundary for
     * /api/tasks/:id/transition — a route an agent calls with its own token. The cases
     * that matter most are the skips: created -> in_progress (never accepted), and
     * anything -> done from a status that is not in_progress. Without them an agent
     * could close a task it had not started, and the usage view would report completed
     * work that nobody did.
     */
    const legal = new Set([
      'created>accepted', 'accepted>in_progress',
      'in_progress>blocked', 'in_progress>done', 'blocked>in_progress',
    ]);
    for (const from of [...STATUSES]) {
      for (const to of [...STATUSES]) {
        const task = advanceTo(store, newTask(store, { title: `${from}->${to}` }).id, from);
        expect(task.status, `setup for ${from}`).toBe(from);
        const extra = { waiting_reason: 'r', waiting_until: '2026-01-01T00:00:00Z' };
        const key = `${from}>${to}`;
        if (legal.has(key)) {
          expect(store.transitionTask(task.id, to, extra).status, key).toBe(to);
        } else {
          expect(() => store.transitionTask(task.id, to, extra), key)
            .toThrow(/cannot transition from/);
          expect(store.getTask(task.id).status, key).toBe(from);
        }
      }
    }
  });

  it('separates an unknown status from an illegal one', () => {
    /*
     * The status check runs before the table lookup, and the two errors map to different
     * API responses. `invalid_status` means the client sent a word this product does not
     * have; `invalid_transition` means the word is real and the task is in the wrong
     * state. An agent retrying on the second is sensible and on the first is a bug.
     */
    const task = newTask(store);
    let unknown;
    try { store.transitionTask(task.id, 'archived'); } catch (e) { unknown = e; }
    expect(unknown.code).toBe('invalid_status');
    let illegal;
    try { store.transitionTask(task.id, 'done'); } catch (e) { illegal = e; }
    expect(illegal.code).toBe('invalid_transition');
    expect(store.getTask(task.id).status).toBe('created');
  });

  it('validates blocked metadata BEFORE touching the task, as the module claims', () => {
    /*
     * lib/task-store.js:259 says "Validate blocked metadata BEFORE mutating task state".
     * This is that claim.
     *
     * If it were validated after, a task would be left `blocked` with no reason and no
     * waiting_until — the triage view would show a blocked row it cannot explain, and
     * there would be no timestamp for anything to sweep on, so the block would never
     * time out. The save count is asserted too: a rejected transition must not rewrite
     * tasks.json at all.
     */
    const task = advanceTo(store, newTask(store).id, 'in_progress');
    const savesBefore = state.saves;

    let noReason;
    try { store.transitionTask(task.id, 'blocked', { waiting_until: '2026-01-01T00:00:00Z' }); } catch (e) { noReason = e; }
    expect(noReason.code).toBe('missing_waiting_reason');

    let noUntil;
    try { store.transitionTask(task.id, 'blocked', { waiting_reason: 'waiting on review' }); } catch (e) { noUntil = e; }
    expect(noUntil.code).toBe('missing_waiting_until');

    expect(() => store.transitionTask(task.id, 'blocked', {})).toThrow(/waiting_reason is required/);

    const after = store.getTask(task.id);
    expect(after.status).toBe('in_progress');
    expect(after.waiting_reason).toBeNull();
    expect(after.waiting_until).toBeNull();
    expect(state.saves).toBe(savesBefore);

    /*
     * And the TASK OBJECT ITSELF was never touched — this is the assertion that pins
     * "BEFORE", rather than merely observing that commitMutation swept up afterwards.
     *
     * `task` here is the live record the store handed out, which is the same object
     * listTasks() and dump() return and the same one backend-v2.js broadcasts over SSE.
     * If validation ran after `task.status = newStatus`, the rollback would put a clean
     * CLONE back into the map while leaving this reference mutated and detached — the
     * store would answer correctly and every handle already in flight would say
     * `blocked`.
     */
    expect(task.status).toBe('in_progress');
    expect(task.waiting_reason).toBeNull();
  });

  it('records the waiting metadata on block and CLEARS it on unblock', () => {
    /*
     * A stale waiting_reason on a running task makes the console claim an agent is
     * waiting on something while it is working — the triage view's whole job is to
     * distinguish those two, so leaving the field set would make it lie in the one
     * direction an operator acts on.
     */
    const task = advanceTo(store, newTask(store).id, 'in_progress');
    const blocked = store.transitionTask(task.id, 'blocked', {
      waiting_reason: '  needs an operator decision  ',
      waiting_until: '2026-03-01T00:00:00Z',
    });
    expect(blocked.waiting_reason).toBe('needs an operator decision');
    expect(blocked.waiting_until).toBe('2026-03-01T00:00:00Z');

    const resumed = store.transitionTask(task.id, 'in_progress');
    expect(resumed.waiting_reason).toBeNull();
    expect(resumed.waiting_until).toBeNull();
  });

  it('clears the waiting metadata and stamps completed_at on done', () => {
    /*
     * A finished task that still carries a waiting_reason is counted as blocked by
     * anything reading the field rather than the status, and `completed_at` is the only
     * record of when the work ended.
     *
     * The waiting note is set through updateTaskExecution and the task goes straight
     * from in_progress to done. Routing through `blocked` and back would ALSO clear the
     * fields — via the in_progress branch — so the fixture would satisfy itself and the
     * `done` branch could be deleted without this test noticing. An agent leaving a
     * "waiting on review" note and then finishing the work is the ordinary path anyway.
     */
    const task = advanceTo(store, newTask(store).id, 'in_progress');
    store.updateTaskExecution(task.id, {
      waiting_reason: 'waiting on review', waiting_until: '2026-05-01T00:00:00Z',
    });
    expect(store.getTask(task.id).waiting_reason).toBe('waiting on review');

    const done = store.transitionTask(task.id, 'done');
    expect(done.status).toBe('done');
    expect(done.completed_at).toBeTruthy();
    expect(done.waiting_reason).toBeNull();
    expect(done.waiting_until).toBeNull();
  });

  it('sets started_at ONCE and never moves it', () => {
    /*
     * `if (!task.started_at)`. started_at is the only anchor for elapsed time, so
     * re-stamping it on each accepted/in_progress transition would reset the age of
     * every task that is ever unblocked — a task blocked for three days would report as
     * freshly started the moment it resumed, and every duration derived from it would
     * be wrong in the direction that hides a stalled agent.
     *
     * The anchor is seeded from disk with a date in the past rather than being created
     * in-process. Two same-process transitions land in the same millisecond, so
     * `toISOString()` produces an identical string either way and a re-stamping bug is
     * invisible — the test would pass on a clock artefact rather than on the guard.
     * A task reloaded from tasks.json after days of work is also the case that matters.
     */
    const { store: seeded } = makeStore({
      initialData: [{
        id: 'task_long_running',
        title: 'running since Monday',
        status: 'blocked',
        priority: 'p1',
        granularity: 'task',
        started_at: '2026-01-05T09:00:00.000Z',
        waiting_reason: 'waiting on review',
        waiting_until: '2026-01-06T09:00:00.000Z',
        comments: [],
        labels: [],
      }],
    });
    const resumed = seeded.transitionTask('task_long_running', 'in_progress');
    expect(resumed.started_at).toBe('2026-01-05T09:00:00.000Z');
    expect(seeded.transitionTask('task_long_running', 'done').started_at)
      .toBe('2026-01-05T09:00:00.000Z');

    // ...and a task that has never started does get an anchor, so the guard is not
    // simply never assigning one.
    const fresh = newTask(store);
    expect(fresh.started_at).toBeNull();
    expect(store.transitionTask(fresh.id, 'accepted').started_at).toBeTruthy();
  });

  it('rolls the WHOLE transition back when the write fails', () => {
    /*
     * Not just the status: completed_at and the cleared waiting fields too. A partial
     * rollback would leave a task reported as blocked with its completion timestamp
     * already set, and the next legal transition computed from an inconsistent row.
     */
    const { store: s, state: st } = makeStore();
    const task = advanceTo(s, newTask(s).id, 'in_progress');
    s.transitionTask(task.id, 'blocked', { waiting_reason: 'because', waiting_until: '2026-01-01' });
    const before = JSON.parse(JSON.stringify(s.getTask(task.id)));

    st.mode = 'false';
    expect(() => s.transitionTask(task.id, 'in_progress')).toThrow(/task persistence failed/);
    expect(s.getTask(task.id)).toEqual(before);

    st.mode = 'throw';
    expect(() => s.transitionTask(task.id, 'in_progress')).toThrow(/task persistence failed/);
    expect(s.getTask(task.id)).toEqual(before);

    // And it still works once the write does: the rollback must not have wedged the task.
    st.mode = 'ok';
    expect(s.transitionTask(task.id, 'in_progress').status).toBe('in_progress');
  });

  it('refuses to transition a task that does not exist', () => {
    let error;
    try { store.transitionTask('task_nope', 'accepted'); } catch (e) { error = e; }
    expect(error.code).toBe('not_found');
  });
});

// ── updateTask: the operator-only route ───────────────────────────────
describe('updateTask', () => {
  let store;
  let state;
  beforeEach(() => { ({ store, state } = makeStore()); });

  it('does NOT write when the patch changed nothing', () => {
    /*
     * `persist: changed`. tasks.json is rewritten whole on every save, and a dashboard
     * that PATCHes on every keystroke or a poller sending an empty body would otherwise
     * rewrite the entire task file for nothing. The decoy is the second half: a patch
     * that only sets `description` DOES write, so this is not just asserting that saves
     * are rare.
     */
    const task = newTask(store);
    const baseline = state.saves;
    const unchanged = store.updateTask(task.id, {});
    expect(state.saves).toBe(baseline);
    expect(unchanged.updated_at).toBe(task.updated_at);

    store.updateTask(task.id, { description: 'now set' });
    expect(state.saves).toBe(baseline + 1);
  });

  it('will not clear a title, but will clear an assignee', () => {
    /*
     * The asymmetry is deliberate and worth pinning because it reads like an oversight.
     * An empty title is dropped (a task must stay identifiable); an empty assignee is
     * stored as null, because UNASSIGNING is a real operation and the only way to
     * express it. If the assignee branch behaved like the title branch, a task could
     * never be taken off an agent.
     */
    const task = newTask(store, { title: 'keep me', assignee: 'alpha' });
    expect(store.updateTask(task.id, { title: '   ' }).title).toBe('keep me');
    expect(store.updateTask(task.id, { assignee: '   ' }).assignee).toBeNull();
    expect(store.updateTask(task.id, { assignee: 'beta' }).assignee).toBe('beta');
  });

  it('applies NO part of a patch that contains an invalid field', () => {
    /*
     * The invalid-priority check throws from inside the mutator, after the title has
     * already been assigned in place. Without commitMutation's rollback the task would
     * keep the new title while the caller was told the update failed — a partially
     * applied PATCH, which is the hardest kind of inconsistency to notice because the
     * response looks like a clean rejection.
     */
    const task = newTask(store, { title: 'original', priority: 'p1' });
    expect(() => store.updateTask(task.id, { title: 'renamed', priority: 'p9' }))
      .toThrow(/invalid priority/);
    const after = store.getTask(task.id);
    expect(after.title).toBe('original');
    expect(after.priority).toBe('p1');

    expect(() => store.updateTask(task.id, { description: 'new desc', granularity: 'saga' }))
      .toThrow(/invalid granularity/);
    expect(store.getTask(task.id).description).toBe('');
  });

  it('refuses to reparent onto a task that does not exist, leaving the old parent', () => {
    const parent = newTask(store, { title: 'parent' });
    const child = newTask(store, { title: 'child', parent_id: parent.id });
    expect(() => store.updateTask(child.id, { parent_id: 'task_ghost' })).toThrow(/parent task not found/);
    expect(store.getTask(child.id).parent_id).toBe(parent.id);
    // Explicitly detaching is allowed: null is a valid parent.
    expect(store.updateTask(child.id, { parent_id: null }).parent_id).toBeNull();
  });

  it('rolls back a failed write, including the timestamp', () => {
    // updated_at is what a client uses to decide whether its cached copy is stale. A
    // rollback that restored the fields but kept the new timestamp would make every
    // client discard a fresh cache on a write that never happened.
    const { store: s, state: st } = makeStore();
    const task = newTask(s, { title: 'original' });
    const before = JSON.parse(JSON.stringify(s.getTask(task.id)));
    st.mode = 'false';
    expect(() => s.updateTask(task.id, { title: 'renamed', priority: 'p0' })).toThrow(/persistence failed/);
    expect(s.getTask(task.id)).toEqual(before);
  });

  it('refuses to update a task that does not exist', () => {
    let error;
    try { store.updateTask('task_nope', { title: 'x' }); } catch (e) { error = e; }
    expect(error.code).toBe('not_found');
  });
});

// ── updateTaskExecution: the agent-callable route ─────────────────────
describe('updateTaskExecution', () => {
  let store;
  beforeEach(() => { ({ store } = makeStore()); });

  it('ignores every field that is not heartbeat or waiting metadata', () => {
    /*
     * THE MOST IMPORTANT ASSERTION IN THIS FILE.
     *
     * /api/tasks/:id/execution is authenticated with the ASSIGNEE'S agent token
     * (backend-v2.js:10194), while /api/tasks/:id needs the operator bearer. If this
     * function honoured `status`, an agent would close, reopen or reprioritise its own
     * task by PATCHing execution metadata — bypassing TRANSITIONS entirely and making
     * the operator-only route decorative.
     *
     * The forbidden fields are listed FIRST in the patch so a mutator that iterated the
     * patch object instead of naming its three fields would apply them before reaching
     * heartbeat_at, and this test would catch it.
     */
    const task = newTask(store, { title: 'agent task', assignee: 'alpha', priority: 'p3' });
    const updated = store.updateTaskExecution(task.id, {
      status: 'done',
      priority: 'p0',
      title: 'renamed by agent',
      assignee: 'someone-else',
      completed_at: '2020-01-01T00:00:00Z',
      parent_id: 'task_ghost',
      labels: ['injected'],
      heartbeat_at: true,
    });
    expect(updated.status).toBe('created');
    expect(updated.priority).toBe('p3');
    expect(updated.title).toBe('agent task');
    expect(updated.assignee).toBe('alpha');
    expect(updated.completed_at).toBeNull();
    expect(updated.parent_id).toBeNull();
    expect(updated.labels).toEqual([]);
    expect(updated.heartbeat_at).toBeTruthy();
  });

  it('stamps the heartbeat with the server clock, not the value the agent sent', () => {
    /*
     * `task.heartbeat_at = now` — the patch value is used only as a flag. An agent that
     * could choose its own heartbeat timestamp could forward-date it and appear alive
     * indefinitely, which is precisely what the heartbeat exists to detect.
     */
    const task = newTask(store, { title: 't', assignee: 'alpha' });
    const updated = store.updateTaskExecution(task.id, { heartbeat_at: '1999-01-01T00:00:00Z' });
    expect(updated.heartbeat_at).not.toBe('1999-01-01T00:00:00Z');
    expect(new Date(updated.heartbeat_at).getUTCFullYear()).toBeGreaterThan(2000);
  });

  it('lets an agent set and clear its own waiting note without changing status', () => {
    /*
     * The legitimate use. Note the status stays put: writing a waiting_reason is how an
     * agent explains itself, and it is deliberately NOT the same act as transitioning to
     * blocked — which requires both fields and goes through the machine.
     */
    const task = advanceTo(store, newTask(store, { title: 't', assignee: 'alpha' }).id, 'in_progress');
    const noted = store.updateTaskExecution(task.id, {
      waiting_reason: 'waiting on a code review',
      waiting_until: '2026-04-01T00:00:00Z',
    });
    expect(noted.status).toBe('in_progress');
    expect(noted.waiting_reason).toBe('waiting on a code review');
    expect(store.updateTaskExecution(task.id, { waiting_reason: '' }).waiting_reason).toBeNull();
  });

  it('does not write when the patch carried none of its three fields', () => {
    // Agents heartbeat on a loop. A no-op patch that still rewrote tasks.json would put
    // the whole task file on the write path of every agent's poll interval.
    const { store: s, state: st } = makeStore();
    const task = newTask(s, { title: 't' });
    const baseline = st.saves;
    s.updateTaskExecution(task.id, { status: 'done', priority: 'p0' });
    expect(st.saves).toBe(baseline);
  });

  it('rolls back a failed heartbeat write', () => {
    const { store: s, state: st } = makeStore();
    const task = newTask(s, { title: 't' });
    st.mode = 'false';
    expect(() => s.updateTaskExecution(task.id, { heartbeat_at: true })).toThrow(/persistence failed/);
    expect(s.getTask(task.id).heartbeat_at).toBeNull();
  });
});

// ── comments ──────────────────────────────────────────────────────────
describe('addComment', () => {
  let store;
  beforeEach(() => { ({ store } = makeStore()); });

  it('requires text and names an unattributed author rather than leaving it empty', () => {
    // The console renders the author string. A null author would render as blank or as
    // "null" beside a comment nobody can trace, so the store supplies the word.
    const task = newTask(store);
    expect(() => store.addComment(task.id, { text: '   ' })).toThrow(/comment text is required/);
    expect(() => store.addComment(task.id, { author: 'alpha' })).toThrow(/comment text is required/);
    const withComment = store.addComment(task.id, { text: 'a note' });
    expect(withComment.comments).toHaveLength(1);
    expect(withComment.comments[0]).toMatchObject({ author: 'anonymous', text: 'a note' });
    expect(withComment.comments[0].ts).toBeTruthy();
  });

  it('caps a task at 100 comments', () => {
    /*
     * Comments are stored inline in the task and the whole task file is rewritten on
     * every mutation, so an uncapped thread makes every later save on the deployment
     * more expensive. The boundary is asserted from both sides: the 100th must succeed,
     * or a legitimate thread is cut short one comment early.
     */
    const task = newTask(store);
    for (let i = 0; i < 100; i += 1) store.addComment(task.id, { text: `c${i}` });
    expect(store.getTask(task.id).comments).toHaveLength(100);
    let error;
    try { store.addComment(task.id, { text: 'one too many' }); } catch (e) { error = e; }
    expect(error.code).toBe('limit_exceeded');
    expect(store.getTask(task.id).comments).toHaveLength(100);
  });

  it('creates the comments array on a task loaded from disk without one', () => {
    // tasks.json predates the comments field and is hand-edited. Without the guard the
    // first comment on such a task throws a TypeError out of the endpoint.
    const { store: s } = makeStore({ initialData: [{ id: 't1', title: 'legacy', status: 'created' }] });
    expect(s.addComment('t1', { text: 'first' }).comments).toHaveLength(1);
  });

  it('does not leave the comment behind when the write fails', () => {
    /*
     * This is the case a SHALLOW snapshot would pass and a deep one catches.
     * commitMutation clones with JSON.parse(JSON.stringify(task)); a spread copy would
     * share the `comments` ARRAY with the live task, so the pushed comment would survive
     * the rollback and the store would hold a comment the caller was told had failed.
     */
    const { store: s, state: st } = makeStore();
    const task = newTask(s);
    s.addComment(task.id, { text: 'the one that stuck' });
    st.mode = 'false';
    expect(() => s.addComment(task.id, { text: 'the one that failed' })).toThrow(/persistence failed/);
    const comments = s.getTask(task.id).comments;
    expect(comments).toHaveLength(1);
    expect(comments[0].text).toBe('the one that stuck');
  });

  it('refuses to comment on a task that does not exist', () => {
    let error;
    try { store.addComment('task_nope', { text: 'x' }); } catch (e) { error = e; }
    expect(error.code).toBe('not_found');
  });
});

// ── listTasks ─────────────────────────────────────────────────────────
describe('listTasks', () => {
  let store;
  beforeEach(() => {
    ({ store } = makeStore());
    // Decoy first in every case below: the row that each filter must EXCLUDE is created
    // before the row it must include, so removing a filter changes the result rather
    // than merely lengthening it.
    store.createTask({ title: 'decoy', assignee: 'beta', priority: 'p3', labels: ['other'] });
    const wanted = store.createTask({ title: 'wanted', assignee: 'alpha', priority: 'p0', labels: ['urgent'] });
    advanceTo(store, wanted.id, 'in_progress');
    store.createTask({ title: 'legacy-no-labels', assignee: 'alpha' });
  });

  it('filters by assignee, priority and label', () => {
    // /api/usage attributes tasks per agent by assignee, and the console's queue views
    // are priority- and label-scoped. A filter that silently matched everything would
    // credit one agent with the whole fleet's work.
    expect(store.listTasks({ assignee: 'alpha' }).map((t) => t.title))
      .toEqual(['wanted', 'legacy-no-labels']);
    expect(store.listTasks({ priority: 'p0' }).map((t) => t.title)).toEqual(['wanted']);
    expect(store.listTasks({ label: 'urgent' }).map((t) => t.title)).toEqual(['wanted']);
    expect(store.listTasks({ assignee: 'nobody' })).toEqual([]);
  });

  it('accepts a comma-separated status list and trims it', () => {
    // The console asks for several states at once (`?status=in_progress,blocked`). The
    // trimming matters because the query string is built by joining chips in the UI.
    expect(store.listTasks({ status: 'in_progress' }).map((t) => t.title)).toEqual(['wanted']);
    expect(store.listTasks({ status: ' created , in_progress ' }).map((t) => t.title))
      .toEqual(['decoy', 'wanted', 'legacy-no-labels']);
    expect(store.listTasks({ status: 'done' })).toEqual([]);
  });

  it('returns everything when the status filter names no status at all', () => {
    /*
     * `if (statuses.length)`. A cleared filter in the console sends `?status=` or
     * `?status=,`, and without the guard the split would produce an empty list of
     * statuses that matches nothing — so clearing a filter would empty the board and
     * look like every task had been deleted.
     */
    expect(store.listTasks({ status: ',' })).toHaveLength(3);
    expect(store.listTasks({ status: '   ' })).toHaveLength(3);
    expect(store.listTasks({})).toHaveLength(3);
  });

  it('combines filters rather than replacing them', () => {
    expect(store.listTasks({ assignee: 'alpha', status: 'created' }).map((t) => t.title))
      .toEqual(['legacy-no-labels']);
    expect(store.listTasks({ assignee: 'beta', priority: 'p0' })).toEqual([]);
  });

  it('does not throw on a task whose labels field is absent', () => {
    // Rows loaded from an older tasks.json have no labels array. A label filter is a
    // read path served on every console poll; a TypeError here would 500 the board.
    const { store: s } = makeStore({ initialData: [{ id: 't1', title: 'legacy' }] });
    expect(s.listTasks({ label: 'urgent' })).toEqual([]);
  });
});

// ── deleteTask ────────────────────────────────────────────────────────
describe('deleteTask', () => {
  it('returns null for an unknown id instead of throwing', () => {
    // backend-v2.js:10206 maps null to a 404. If this threw, DELETE of an
    // already-deleted task would be a 500 — and a retried delete is the normal case.
    const { store, state } = makeStore();
    expect(store.deleteTask('task_nope')).toBeNull();
    expect(state.saves).toBe(0);
  });

  it('removes the task and hands the caller the record it deleted', () => {
    // The returned record is what is broadcast as `task_deleted` over SSE, so it has to
    // be the task itself and not just an acknowledgement.
    const { store } = makeStore();
    const task = newTask(store, { title: 'doomed' });
    expect(store.deleteTask(task.id)).toMatchObject({ id: task.id, title: 'doomed' });
    expect(store.getTask(task.id)).toBeNull();
    expect(store.dump()).toEqual([]);
  });

  it('restores the task when the write fails', () => {
    /*
     * A delete that half-succeeds is the worst direction: the caller is told the delete
     * failed, so it stops; the task is gone from the API; and it is still in tasks.json,
     * so it returns at the next restart.
     */
    const { store, state } = makeStore();
    const task = newTask(store, { title: 'doomed' });
    state.mode = 'false';
    expect(() => store.deleteTask(task.id)).toThrow(/persistence failed/);
    expect(store.getTask(task.id)).toMatchObject({ id: task.id, title: 'doomed' });
    expect(store.dump()).toHaveLength(1);
  });
});

// ── persistence shape ─────────────────────────────────────────────────
describe('what gets persisted', () => {
  it('saves the full task list, not a delta', () => {
    /*
     * backend-v2.js:3007 wires `save: (data) => saveJson('tasks.json', data)`, which
     * REPLACES the file. So the argument has to be every task; passing only the changed
     * one would truncate tasks.json to a single row on the next mutation.
     */
    const { store, state } = makeStore();
    newTask(store, { title: 'one' });
    newTask(store, { title: 'two' });
    store.addComment(state.lastSaved[0].id, { text: 'note' });
    expect(state.lastSaved).toHaveLength(2);
    expect(state.lastSaved.map((t) => t.title)).toEqual(['one', 'two']);
    // And what is handed over is serialisable as-is, since it goes straight to
    // JSON.stringify inside the storage adapter.
    expect(JSON.parse(JSON.stringify(state.lastSaved))).toEqual(state.lastSaved);
  });

  it('reports a persistence failure with a code the API can map, not a raw adapter error', () => {
    /*
     * backend-v2.js's respondTaskStoreError switches on error.code. An ENOSPC leaking
     * through with no code would fall to the generic branch and answer 500 with the
     * filesystem error text — which both loses the retryable/not distinction and puts a
     * server path in the response body.
     */
    const { store } = makeStore({ mode: 'throw' });
    let error;
    try { newTask(store); } catch (e) { error = e; }
    expect(error.code).toBe('persistence_failed');
    expect(error.message).toBe('task persistence failed');
    expect(error.message).not.toContain('ENOSPC');
  });
});
