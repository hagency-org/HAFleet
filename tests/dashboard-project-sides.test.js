/*
 * 项目方 in the console — the page, and the ALLOW-LIST that stands between it and a credential.
 *
 * ADR-016 decision 1 gave project sides a record and ten endpoints; nothing rendered them, so the only
 * way to see or set an allocation was `curl`. That is not a cosmetic gap: decision 6's budget refusal
 * and decision 7's cascade are driven entirely by fields on this page, so neither of the two behaviours
 * the operator asked for could be observed from the surface they actually use.
 *
 * THE HEAVIEST GROUP HERE IS THE ALLOW-LIST, for the same reason it is in tests/api-project-sides.test.js:
 * three of the backend's thirteen `/api/project-sides` routes return a credential, an `as_token` is a
 * whole namespace on a homeserver HAFleet does not administer, and this repository has already shipped
 * two cases of API text reaching a UI nobody intended to show it. Reachability is asserted per route
 * rather than sampled, and the assertion is that the excluded ones are NOT PROXIED AT ALL — not that
 * they are filtered, which would be a filter someone has to maintain.
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { installProjectSideProxyRoutes } from '../lib/dashboard/project-side-proxy-routes.js';
import { renderProjectSidesPage } from '../lib/dashboard/render/project-sides-page.js';

/** A dashboard app with only the routes under test, so a 404 means "not proxied" and nothing else. */
function harness({ status = 200, body = { ok: true } } = {}) {
  const seen = [];
  const backendFetch = vi.fn(async (url, init) => {
    seen.push({ url: String(url), method: init?.method || 'GET', body: init?.body ?? null });
    return { status, json: async () => body };
  });
  const app = express();
  app.use(express.json());
  installProjectSideProxyRoutes(app, { backendBaseUrl: 'http://backend.test', backendFetch });
  return { app, seen, backendFetch };
}

afterEach(() => vi.restoreAllMocks());

describe('the project-side proxy is an allow-list', () => {
  /*
   * Every route that returns or writes a secret, asserted UNREACHABLE. 404 is the right assertion
   * because it proves absence: a 403 would mean the route exists and something decided to refuse it,
   * which is a decision that can regress. Absence cannot.
   */
  test.each([
    ['GET', '/api/project-sides/palpo.test/inbound-credentials', 'returns hsToken'],
    ['GET', '/api/project-sides/acting-credentials', 'returns asToken — the widest grant in the system'],
    ['PUT', '/api/project-sides/palpo.test/credential', 'WRITES a secret through the dashboard tier'],
    ['POST', '/api/project-sides/palpo.test/registration', 'renders a YAML containing both tokens'],
    ['POST', '/api/project-sides/palpo.test/verify', 'calls another operator\'s homeserver'],
  ])('%s %s is not proxied (%s)', async (method, path) => {
    const { app, backendFetch } = harness();
    const res = await request(app)[method.toLowerCase()](path).send({});
    expect(res.status).toBe(404);
    // And nothing reached the backend, which is the part that would leak.
    expect(backendFetch).not.toHaveBeenCalled();
  });

  test('the six routes the console needs DO proxy, with the method preserved', async () => {
    /*
     * The other direction. Without it, a proxy that had simply stopped working would pass every
     * assertion above — the excluded routes would still be 404, for the wrong reason.
     */
    const { app, seen } = harness();
    await request(app).get('/api/project-sides').expect(200);
    await request(app).get('/api/project-sides/palpo.test/budget').expect(200);
    await request(app).post('/api/project-sides').send({ server_name: 'palpo.test' }).expect(200);
    await request(app).put('/api/project-sides/palpo.test/allocation').send({ allocated_tokens: 5 }).expect(200);
    await request(app).post('/api/project-sides/palpo.test/deactivate').expect(200);
    await request(app).post('/api/project-sides/palpo.test/reactivate').expect(200);
    await request(app).delete('/api/project-sides/palpo.test').expect(200);

    expect(seen.map((s) => `${s.method} ${s.url.replace('http://backend.test', '')}`)).toEqual([
      'GET /api/project-sides',
      'GET /api/project-sides/palpo.test/budget',
      'POST /api/project-sides',
      'PUT /api/project-sides/palpo.test/allocation',
      'POST /api/project-sides/palpo.test/deactivate',
      'POST /api/project-sides/palpo.test/reactivate',
      'DELETE /api/project-sides/palpo.test',
    ]);
  });
});

describe('the side id is validated at the boundary, not just encoded', () => {
  test('what reaches the validator is refused with 400, and nothing reaches the backend', async () => {
    /*
     * `encodeURIComponent` alone would make these inert, and that is exactly why the check exists
     * separately: a reader should not have to know that to be sure. The refusal states the rule.
     */
    const { app, backendFetch } = harness();
    for (const bad of ['../acting-credentials', 'palpo test', 'a/b']) {
      const res = await request(app).get(`/api/project-sides/${encodeURIComponent(bad)}/budget`);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid project side id/);
    }
    expect(backendFetch).not.toHaveBeenCalled();
  });

  test('TWO LAYERS: a bare .. never reaches the validator at all, and is 404 rather than 400', async () => {
    /*
     * Measured, not assumed — the first version of the test above expected 400 for these and got 404.
     * `encodeURIComponent('..')` is `..` (a dot is unreserved), so the URL stays
     * `/api/project-sides/../budget` and the HTTP layer path-normalises it to `/api/budget` BEFORE
     * express routes it. An empty id collapses to a double slash and matches no route either.
     *
     * So the traversal defence is two independent layers, and this asserts the outer one exists rather
     * than quietly widening the expectation to "400 or 404" — which would have hidden which layer was
     * doing the work, and would still have passed if the validator were deleted.
     */
    const { app, backendFetch } = harness();
    for (const bad of ['..', '']) {
      expect((await request(app).get(`/api/project-sides/${bad}/budget`)).status).toBe(404);
    }
    expect(backendFetch).not.toHaveBeenCalled();
  });

  test('a real server name — dots and colons — passes', async () => {
    const { app, seen } = harness();
    await request(app).get('/api/project-sides/matrix.customer.example:8448/budget').expect(200);
    expect(seen[0].url).toContain('matrix.customer.example%3A8448/budget');
  });
});

describe('force is forwarded, because the two deletes mean different things', () => {
  test('without force the backend sees no force, and with it, it does', async () => {
    /*
     * The page depends on this: it sends the unforced delete FIRST, so the backend's own 409
     * `side_active` is what triggers the confirmation. A proxy that always forced would destroy the
     * safety of that first attempt, and a proxy that never forwarded it would make removal impossible.
     */
    const { app, seen } = harness();
    await request(app).delete('/api/project-sides/palpo.test').expect(200);
    expect(seen[0].url).not.toContain('force');
    await request(app).delete('/api/project-sides/palpo.test?force=true').expect(200);
    expect(seen[1].url).toContain('force=true');
  });

  test('a non-true force value is not forwarded', async () => {
    const { app, seen } = harness();
    await request(app).delete('/api/project-sides/palpo.test?force=yes').expect(200);
    expect(seen[0].url).not.toContain('force');
  });
});

describe('the backend status and body survive the proxy', () => {
  test('a 409 refusal is passed through, not flattened into a 200 or a 500', async () => {
    /*
     * The page reads `code === 'side_active'` off a 409 to decide whether to confirm. A proxy that
     * normalised the status would turn a refusal into an apparent success, and the operator would be
     * told the side was removed when it was not.
     */
    const { app } = harness({ status: 409, body: { error: 'side is active', code: 'side_active' } });
    const res = await request(app).delete('/api/project-sides/palpo.test');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'side is active', code: 'side_active' });
  });

  test('an unreachable backend is 502 with a reason, not a hang or a 200', async () => {
    const app = express();
    app.use(express.json());
    installProjectSideProxyRoutes(app, {
      backendBaseUrl: 'http://backend.test',
      backendFetch: async () => { throw new Error('ECONNREFUSED'); },
    });
    const res = await request(app).get('/api/project-sides');
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ error: 'backend unreachable', detail: 'ECONNREFUSED' });
  });
});

describe('the page itself', () => {
  const html = renderProjectSidesPage();

  test('renders, and says what an unset allocation means rather than showing a zero', () => {
    /*
     * The store draws three states — null is UNALLOCATED and refuses all work, 0 is a real allocation
     * that closes the side while leaving it configured, a number is a budget. A UI that rendered null
     * as 0 would erase the distinction the store exists to keep, and this repository's own rule is that
     * blank is never a zero.
     */
    expect(html).toContain('PROJECT SIDES');
    expect(html).toContain('not set');
    expect(html).toMatch(/UNALLOCATED/);
    expect(html).toMatch(/refuses all work/);
  });

  test('never mentions a credential value, only whether one is configured', () => {
    // The page must not acquire a credential field by accident later; this is the guard for that.
    for (const forbidden of ['asToken', 'hsToken', 'as_token', 'hs_token', 'registrationToken', 'senderLocalpart']) {
      expect(html).not.toContain(forbidden);
    }
    expect(html).toContain('credentialKind');
  });

  test('the remove confirmation says what the cascade will DO, not just that it is dangerous', () => {
    /*
     * "Are you sure?" is not consent to something the operator cannot see. Decision 7's whole point is
     * that nothing is deleted — records are stood down and kept — and a warning that failed to say so
     * would make an operator refuse a safe action for fear of an unsafe one.
     */
    expect(html).toMatch(/END its active engagements/);
    expect(html).toMatch(/DEACTIVATE its approval bindings/);
    expect(html).toMatch(/RETIRE/);
    expect(html).toMatch(/Nothing is deleted/);
  });

  test('an empty allocation box is sent as an explicit null, so an allocation can be withdrawn', () => {
    // Treating blank as "no change" would leave no way to un-budget a side from this page at all.
    expect(html).toMatch(/raw === '' \? null : Number\(raw\)/);
  });
});
