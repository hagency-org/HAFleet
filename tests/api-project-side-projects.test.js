/*
 * 项目方 → 项目 → 外派员工 — the three levels, and why the third is a JOIN rather than a field.
 *
 * The operator's model: HAFleet is a construction crew (施工队). It sends a representative INTO each
 * customer's Matrix server to take orders; the customer does not come to us. So there is no such thing
 * as "our" homeserver — every server is a 项目方 — and one 项目方 has several projects, each with its
 * own room, sharing one representative and one budget (their ruling: 「项目方一个,但每个项目可以单独指定
 * 房间」, 「项目方一份总额度」).
 *
 * WHAT A PROJECT ADDS is the one thing this product never stored: a NAME. The bridge computes
 * `groupForRoom(projectRoomId) || meta.group || projectRoomId`, which degrades to a raw room id — which
 * is why every binding in this deployment displays `!aXbY7pQ2:hq.example`.
 *
 * WHY THE THIRD LEVEL IS DERIVED. A binding already says "this agent can be reached in this room"; a
 * project already says "this room is that project". Who staffs a project is the intersection of two
 * existing records. An `agent.project` field would be a third copy, and it would drift the first time a
 * binding was deactivated without anyone remembering to clear it — which decision 7's cascade does
 * routinely.
 *
 * ARCHIVE, NEVER DELETE, on the operator's instruction: 「项目方暂时不可以删除,可以 archive 掉」. Same
 * reason they gave for agents — 「删除会有合规问题」 — and it applies harder here, because a project's
 * room carries the engagements served through it.
 */

import { afterEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const SIDE = 'palpo.test';
const ROOM_A = `!alpha:${SIDE}`;
const ROOM_B = `!beta:${SIDE}`;

let context = null;
afterEach(() => { context?.cleanup(); context = null; });

async function boot(seed = {}) {
  context = await createBackendTestContext('project-side-projects-', { agents: {}, ...seed });
  const app = context.app;
  await request(app).post('/api/project-sides')
    .send({ server_name: SIDE, api_base_url: 'http://127.0.0.1:8008', label: '本地 Palpo' });
  return app;
}

const addProject = (app, body) => request(app).post(`/api/project-sides/${SIDE}/projects`).send(body);
const side = async (app) => (await request(app).get(`/api/project-sides/${SIDE}`)).body.side;
const projects = async (app) => (await side(app)).projects;

describe('a project is a name and a room under one 项目方', () => {
  test('it is created, and the id is derived from the name rather than invented', async () => {
    const app = await boot();
    const r = await addProject(app, { name: 'BigLittle refactor', room_id: ROOM_A });
    expect(r.status).toBe(200);
    expect(r.body.project).toMatchObject({
      id: 'biglittle-refactor', name: 'BigLittle refactor', roomId: ROOM_A, archived: false,
    });
  });

  test('A CHINESE NAME SURVIVES, which the first implementation silently destroyed', async () => {
    /*
     * Found by running it, not by reading it. The slug was `[^a-z0-9._-]` → `-`, so
     * "BigLittle 重构" became "biglittle" and a wholly Chinese name became the EMPTY STRING, which then
     * failed as "must contain a usable character" about a name that plainly had several. This
     * product's operator writes Chinese; an ASCII slug quietly refuses their vocabulary.
     */
    const app = await boot();
    const r = await addProject(app, { name: '重构支付网关', room_id: ROOM_A });
    expect(r.status).toBe(200);
    expect(r.body.project.id).toBe('重构支付网关');

    const mixed = await addProject(app, { name: 'BigLittle 重构', room_id: ROOM_B });
    expect(mixed.body.project.id).toBe('biglittle-重构');
  });

  test('a name with no letter or digit at all is refused, and says which rule', async () => {
    const app = await boot();
    const r = await addProject(app, { name: '---', room_id: ROOM_A });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/must contain a letter or digit/);
  });

  test('the room must be ON this side, or the 接单员 could never enter it', async () => {
    /*
     * A room on another homeserver cannot be reached with this side's credential, and the budget
     * attribution reads the server out of the room id — so recording it here would both create an
     * unreachable project and charge the wrong customer.
     */
    const app = await boot();
    const r = await addProject(app, { name: 'elsewhere', room_id: '!x:other.example' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/is on other\.example, but this project side is palpo\.test/);
  });

  test('a room id that is not a room id is refused', async () => {
    const app = await boot();
    const r = await addProject(app, { name: 'no sigil', room_id: `alpha:${SIDE}` });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/must be a room id starting with !/);
  });

  test('two projects cannot claim one room', async () => {
    /*
     * Refused rather than reassigned: a room that silently moved between projects would take its
     * engagements' attribution with it, so a past month's work would change whose it was.
     */
    const app = await boot();
    await addProject(app, { name: 'first', room_id: ROOM_A });
    const r = await addProject(app, { name: 'second', room_id: ROOM_A });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/already belongs to project first/);
  });

  test('a project may exist BEFORE its room does', async () => {
    /*
     * A project is usually named before its room is created. Refusing to record it until then pushes
     * the operator back to a notebook — which is where project names live today, since nothing in this
     * system stores one.
     */
    const app = await boot();
    const r = await addProject(app, { name: 'not started yet' });
    expect(r.status).toBe(200);
    expect(r.body.project.roomId).toBe(null);

    // And the room can be attached later without creating a second project.
    const later = await addProject(app, { name: 'not started yet', room_id: ROOM_A });
    expect(later.body.project.roomId).toBe(ROOM_A);
    expect(await projects(app)).toHaveLength(1);
  });

  test('re-adding the same name UPDATES rather than duplicating', async () => {
    const app = await boot();
    await addProject(app, { name: 'one', room_id: ROOM_A, note: 'first note' });
    await addProject(app, { name: 'one', note: 'second note' });
    const rows = await projects(app);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ note: 'second note', roomId: ROOM_A });
  });

  test('a project cannot be added to a side that does not exist', async () => {
    const app = await boot();
    const r = await request(app).post('/api/project-sides/nosuch.example/projects').send({ name: 'x' });
    expect(r.status).toBe(404);
  });
});

describe('archive, and no delete', () => {
  test('archiving keeps the record and is REVERSIBLE', async () => {
    /*
     * An archive that cannot be undone is a delete with a gentler name. The room stays attached, so the
     * engagements served through it remain attributable.
     */
    const app = await boot();
    await addProject(app, { name: 'winding down', room_id: ROOM_A });
    const off = await request(app).post(`/api/project-sides/${SIDE}/projects/winding-down/archive`).send({});
    expect(off.body.project).toMatchObject({ archived: true, roomId: ROOM_A });
    expect(typeof off.body.project.archivedAt).toBe('number');

    const on = await request(app).post(`/api/project-sides/${SIDE}/projects/winding-down/archive`)
      .send({ archived: false });
    expect(on.body.project).toMatchObject({ archived: false, archivedAt: null });
  });

  test('an archived project is still LISTED, because hiding it would be deleting it', async () => {
    const app = await boot();
    await addProject(app, { name: 'gone quiet', room_id: ROOM_A });
    await request(app).post(`/api/project-sides/${SIDE}/projects/gone-quiet/archive`).send({});
    const rows = await projects(app);
    expect(rows).toHaveLength(1);
    expect(rows[0].archived).toBe(true);
  });

  test('archiving something that is not there is 404, not a silent success', async () => {
    const app = await boot();
    const r = await request(app).post(`/api/project-sides/${SIDE}/projects/nosuch/archive`).send({});
    expect(r.status).toBe(404);
  });
});

describe('外派员工 — the third level is a join, not a field', () => {
  /** A real binding through the real route, so the join is tested against the record it reads. */
  async function bind(app, agent, roomId) {
    const r = await request(app).put('/api/approval-bindings')
      .set('X-Bridge-Secret', 'binding-secret')
      .send({
        agent, project: 'whatever the bridge computed', projectRoomId: roomId,
        ownerMxid: `@alex:${SIDE}`, ownerDmRoomId: `!dm:${SIDE}`,
      });
    expect(r.status).toBe(200);
  }

  const seedWith = (agents) => ({
    agents,
    env: { MATRIX_BRIDGE_SECRET: 'binding-secret' },
  });

  test('an agent bound to a project\'s room appears under that project', async () => {
    const app = await boot(seedWith({
      worker: { name: 'worker', type: 'agent', kind: 'agent', online: true, role: 'coding' },
    }));
    await addProject(app, { name: 'staffed', room_id: ROOM_A });
    await bind(app, 'worker', ROOM_A);

    const rows = await projects(app);
    expect(rows[0].agents).toEqual([
      { name: 'worker', bound: true, online: true, retiredAt: null, role: 'coding' },
    ]);
  });

  test('a project with no room, and a project whose room nobody serves, both report NO agents', async () => {
    const app = await boot(seedWith({}));
    await addProject(app, { name: 'roomless' });
    await addProject(app, { name: 'empty room', room_id: ROOM_A });
    const rows = await projects(app);
    expect(rows.find((p) => p.id === 'roomless').agents).toEqual([]);
    expect(rows.find((p) => p.id === 'empty-room').agents).toEqual([]);
  });

  test('two agents on one project are both listed, sorted', async () => {
    const app = await boot(seedWith({
      zeta: { name: 'zeta', type: 'agent', kind: 'agent', online: true },
      alpha: { name: 'alpha', type: 'agent', kind: 'agent', online: false },
    }));
    await addProject(app, { name: 'two', room_id: ROOM_A });
    await bind(app, 'zeta', ROOM_A);
    await bind(app, 'alpha', ROOM_A);
    const rows = await projects(app);
    expect(rows[0].agents.map((a) => a.name)).toEqual(['alpha', 'zeta']);
    expect(rows[0].agents.map((a) => a.online)).toEqual([false, true]);
  });

  test("an agent on ANOTHER project's room does not leak across", async () => {
    const app = await boot(seedWith({
      a: { name: 'a', type: 'agent', kind: 'agent', online: true },
      b: { name: 'b', type: 'agent', kind: 'agent', online: true },
    }));
    await addProject(app, { name: 'left', room_id: ROOM_A });
    await addProject(app, { name: 'right', room_id: ROOM_B });
    await bind(app, 'a', ROOM_A);
    await bind(app, 'b', ROOM_B);
    const rows = await projects(app);
    expect(rows.find((p) => p.id === 'left').agents.map((x) => x.name)).toEqual(['a']);
    expect(rows.find((p) => p.id === 'right').agents.map((x) => x.name)).toEqual(['b']);
  });

  test('A RETIRED AGENT STAYS VISIBLE under the project it served', async () => {
    /*
     * Decision 7 keeps the record precisely so history stays attributable. A tree that hid retired
     * agents would present a project as having been staffed by nobody — which is the accounting
     * equivalent of losing the invoice.
     */
    const app = await boot(seedWith({
      old: {
        name: 'old', type: 'agent', kind: 'agent', online: false,
        retiredAt: 1_700_000_000_000, offlineReason: `retired:project-side-removed:${SIDE}`,
      },
    }));
    await addProject(app, { name: 'past work', room_id: ROOM_A });
    await bind(app, 'old', ROOM_A);
    const rows = await projects(app);
    expect(rows[0].agents[0]).toMatchObject({ name: 'old', retiredAt: 1_700_000_000_000, online: false });
  });

  test('a DEACTIVATED binding still appears, marked unreachable rather than dropped', async () => {
    /*
     * `listBindings` hides inactive bindings by default, and that default is right for every other
     * caller — "which projects can reach this agent right now". This read asks a different question, so
     * it opts in. Without `includeInactive` decision 7's cascade would erase the very history it
     * deactivates rather than deletes in order to preserve.
     *
     * SEEDED, because no route produces this state without also destroying the tree.
     * `DELETE /api/approval-bindings/:agent/:roomId` calls `removeBinding` — a HARD delete, which is why
     * an earlier version of this test saw an empty list — and the only caller of `deactivateBinding` is
     * the project-side cascade, which removes the side and its projects in the same act. So the state is
     * seeded directly: this test is about what the READ does with an inactive binding, not about how one
     * comes to exist.
     */
    const app = await boot({
      agents: { stood_down: { name: 'stood_down', type: 'agent', kind: 'agent', online: false } },
      env: { MATRIX_BRIDGE_SECRET: 'binding-secret' },
      rawDataFiles: {
        'approvals.json': JSON.stringify({
          version: 1,
          bindings: {
            [`stood_down\u0000${ROOM_A}`]: {
              agent: 'stood_down', project: 'ended', projectRoomId: ROOM_A,
              ownerMxid: `@alex:${SIDE}`, ownerDmRoomId: `!dm:${SIDE}`,
              active: false, deactivatedAt: 1_700_000_000_000,
              deactivatedReason: `project side ${SIDE} removed`,
              addedAt: 1, updatedAt: 1, agentJoined: null, membershipCheckedAt: null,
            },
          },
          requests: {}, audit: [],
        }),
      },
    });
    await addProject(app, { name: 'ended', room_id: ROOM_A });

    const rows = await projects(app);
    expect(rows[0].agents).toEqual([
      { name: 'stood_down', bound: false, online: false, retiredAt: null, role: null },
    ]);
  });

  test('and an ACTIVE binding on the same read is still marked reachable', async () => {
    // The other half: `includeInactive` must not flatten the distinction it exists to preserve.
    const app = await boot({
      agents: { live_one: { name: 'live_one', type: 'agent', kind: 'agent', online: true } },
      env: { MATRIX_BRIDGE_SECRET: 'binding-secret' },
    });
    await addProject(app, { name: 'running', room_id: ROOM_A });
    await bind(app, 'live_one', ROOM_A);
    expect((await projects(app))[0].agents[0].bound).toBe(true);
  });

  test('a binding naming an agent with no record reports online: null, not false', async () => {
    // Three states. `false` would claim the agent is down; the truth is that there is no such record.
    const app = await boot(seedWith({}));
    await addProject(app, { name: 'ghost', room_id: ROOM_A });
    await bind(app, 'vanished', ROOM_A);
    const rows = await projects(app);
    expect(rows[0].agents[0]).toMatchObject({ name: 'vanished', online: null });
  });

  test('the list read and the single read agree', async () => {
    // A page that drilled into a side and lost its third level would look like the agents had gone.
    const app = await boot(seedWith({
      w: { name: 'w', type: 'agent', kind: 'agent', online: true },
    }));
    await addProject(app, { name: 'same', room_id: ROOM_A });
    await bind(app, 'w', ROOM_A);
    const fromList = (await request(app).get('/api/project-sides')).body.sides
      .find((s) => s.id === SIDE).projects;
    expect(fromList).toEqual(await projects(app));
  });
});

describe('a room spelling this route does not read', () => {
  /*
   * THE FIFTH INSTANCE OF ONE DEFECT, which is why this is a refusal and not a fourth alias.
   *
   * `upsertProject` reads `room_id`, `roomId` and `room`. A caller sending `project_room_id` — the spelling
   * `upsertBinding` takes, and the concept the engagement API carries as `projectRoomId` — got `ok: true`
   * and a project with NO ROOM. The store's own note counts four earlier writes found the same way: success
   * reported, payload dropped, discoverable only by reading the record back. I found the fifth by writing a
   * test that passed for the wrong reason.
   *
   * Aliases do not converge; each one added makes the next miss more surprising. Naming the right spelling
   * at the moment of the mistake is the only version that ends the series.
   */
  test('project_room_id is refused, and the message names the spellings that work', async () => {
    const app = await boot();
    const res = await addProject(app, { name: 'p', project_room_id: `!r:${SIDE}` });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error).toMatch(/room_id/);

    // AND NOTHING WAS CREATED. A refusal that still wrote the roomless project would be the same defect
    // with a louder log.
    expect(await projects(app)).toEqual([]);
  });

  test('all three accepted spellings still store the room', async () => {
    // The refusal must not be a rename. These are the callers that already work.
    const app = await boot();
    for (const [i, body] of [
      { name: 'via-snake', room_id: `!a:${SIDE}` },
      { name: 'via-camel', roomId: `!b:${SIDE}` },
      { name: 'via-short', room: `!c:${SIDE}` },
    ].entries()) {
      const res = await addProject(app, body);
      expect(res.status).toBe(200);
      expect(res.body.project.roomId).toBe(`!${'abc'[i]}:${SIDE}`);
    }
  });

  test('an unrelated extra field is still ignored, not refused', async () => {
    // The check is narrow: only keys that clearly mean a room. Rejecting every unknown key would break
    // callers that send more than this function reads.
    const app = await boot();
    const res = await addProject(app, { name: 'p', note: 'fine', whatever: 1 });
    expect(res.status).toBe(200);
  });
});
