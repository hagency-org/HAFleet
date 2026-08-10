/*
 * `fillable` must mean STAFFABLE, not "meets the tier bar".
 *
 * GET /api/capability computed `fillable: able.length`, which ignores the
 * cross-family rule reported in the very next field. On a deployment with a single
 * model family, `review` came back as `fillable: 1, crossFamilyOk: false` — two
 * properties of one object contradicting each other, with the headline number giving
 * the wrong answer. Review must be staffed from two different model families
 * (lib/matrix-agent.js:26), so one agent cannot fill it however strong it is.
 *
 * Found by standing up a clean single-agent install on a fresh machine. A deployment
 * with a mixed fleet never shows it, which is why it survived every run here.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

/** An agent plus the preset that gives it a tier, as the capability builder reads them. */
function fleet(agents) {
  const presets = agents.map((a, i) => ({
    id: `p${i}`, name: a.name, framework: a.framework, model: a.model, ceiling: null,
  }));
  const map = {};
  agents.forEach((a, i) => {
    map[a.name] = {
      name: a.name, type: a.framework, server: 'local', presetId: `p${i}`,
      runtimeProfile: { primary: { framework: a.framework, model: a.model } },
    };
  });
  return { agents: map, frameworkPresets: presets };
}

const roleNamed = (body, role) => body.roles.find((r) => r.role === role);

describe('capability: fillable respects the cross-family rule', () => {
  let single;
  let mixed;

  beforeAll(async () => {
    // One strong agent, one family. Clears the tier bar for every role.
    single = await createBackendTestContext('cap-single-', fleet([
      { name: 'octos-01', framework: 'octos', model: 'kimi-k3' },
    ]));
    // Two strong agents from DIFFERENT families — the configuration review needs.
    mixed = await createBackendTestContext('cap-mixed-', fleet([
      { name: 'octos-01', framework: 'octos', model: 'kimi-k3' },
      { name: 'octos-02', framework: 'octos', model: 'deepseek-v-flash' },
    ]));
  });

  afterAll(async () => {
    await single?.cleanup?.();
    await mixed?.cleanup?.();
  });

  test('one family cannot staff review, and fillable says so', async () => {
    const res = await request(single.app).get('/api/capability');
    expect(res.status).toBe(200);
    const review = roleNamed(res.body, 'review');
    expect(review.crossFamilyOk).toBe(false);
    expect(review.families).toEqual(['kimi']);
    // The defect: this used to be 1, contradicting crossFamilyOk on the same object.
    expect(review.fillable).toBe(0);
    // `able` still reports who clears the TIER bar — the two fields answer different
    // questions now, and neither is hidden.
    expect(review.able.map((a) => a.agent)).toEqual(['octos-01']);
  });

  test('a role with no cross-family requirement is unaffected', async () => {
    const res = await request(single.app).get('/api/capability');
    const coding = roleNamed(res.body, 'coding');
    expect(coding.crossFamily).toBe(false);
    expect(coding.fillable).toBe(1);
  });

  test('two families staff review, so the constraint is not merely refusing more', async () => {
    const res = await request(mixed.app).get('/api/capability');
    const review = roleNamed(res.body, 'review');
    expect(review.crossFamilyOk).toBe(true);
    expect(review.families.sort()).toEqual(['deepseek', 'kimi']);
    expect(review.fillable).toBe(2);
  });

  test('fillable never disagrees with crossFamilyOk on any role', async () => {
    // The invariant behind the specific case: the two fields describe one question
    // from two angles, and a caller reading either alone must not be misled.
    for (const ctx of [single, mixed]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(ctx.app).get('/api/capability');
      for (const role of res.body.roles) {
        if (!role.crossFamilyOk) {
          expect(role.fillable, `${role.role} is unstaffable but reports fillable`).toBe(0);
        }
      }
    }
  });
});
