/*
 * The console's window onto 项目方 — and an ALLOW-LIST, not a pass-through.
 *
 * The backend has thirteen `/api/project-sides` routes and three of them return a credential: an
 * `as_token` is a whole namespace on a homeserver HAFleet does not administer, and this repository has
 * already shipped two cases of API text reaching a UI nobody intended to show it. So this file names the
 * routes the console may reach, one at a time, and a route absent from it is unreachable from the
 * browser rather than reachable-by-default.
 *
 * WHAT IS DELIBERATELY NOT HERE, and why each:
 *
 *   GET  /:id/inbound-credentials    returns `hsToken` — the bridge's, never a browser's
 *   GET  /acting-credentials         returns `asToken` — the widest grant in the system
 *   PUT  /:id/credential             a WRITE of a secret. Not refused on principle: entering an
 *                                    `as_token` in a browser form means it transits the dashboard tier,
 *                                    which is a new secret path and ADR-016 decision 8's open question.
 *                                    That decision has not been made, so the form does not exist yet.
 *   POST /:id/registration           renders a registration YAML containing both tokens
 *   POST /:id/verify                 makes a live authenticated call to somebody else's homeserver;
 *                                    a page refresh must not be able to trigger that
 *
 * `backendFetch` attaches the operator bearer, so anything reachable here is reachable as the operator.
 * That is exactly why the list is short.
 */

const SIDE_ID = /^[A-Za-z0-9._:-]+$/;

export function installProjectSideProxyRoutes(app, { backendBaseUrl, backendFetch }) {
  /*
   * The id is a SERVER NAME, and it is interpolated into a URL path. Validated rather than only
   * encoded: `encodeURIComponent` would make `../acting-credentials` inert, but a validated shape says
   * so at the boundary instead of relying on a reader knowing that. A refusal here is a 400, not a
   * proxied request.
   */
  const sideId = (req, res) => {
    const raw = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    if (!raw || !SIDE_ID.test(raw)) {
      res.status(400).json({ error: 'invalid project side id' });
      return null;
    }
    return encodeURIComponent(raw);
  };

  const pass = async (res, promise) => {
    try {
      const r = await promise;
      const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
      res.status(r.status).json(data);
    } catch (e) {
      res.status(502).json({ error: 'backend unreachable', detail: e.message });
    }
  };

  app.get('/api/project-sides', async (req, res) => {
    const url = new URL(`${backendBaseUrl}/api/project-sides`);
    if (req.query.active === 'true') url.searchParams.set('active', 'true');
    await pass(res, backendFetch(url));
  });

  app.get('/api/project-sides/:id/budget', async (req, res) => {
    const id = sideId(req, res);
    if (!id) return;
    await pass(res, backendFetch(`${backendBaseUrl}/api/project-sides/${id}/budget`));
  });

  app.post('/api/project-sides', async (req, res) => {
    await pass(res, backendFetch(`${backendBaseUrl}/api/project-sides`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body || {}),
    }));
  });

  app.put('/api/project-sides/:id/allocation', async (req, res) => {
    const id = sideId(req, res);
    if (!id) return;
    await pass(res, backendFetch(`${backendBaseUrl}/api/project-sides/${id}/allocation`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body || {}),
    }));
  });

  /*
   * WRITTEN OUT, not looped. A `for (const action of [...])` registering
   * `/api/project-sides/:id/${action}` is two fewer lines and INVISIBLE to
   * `check:architecture-boundaries`, which reads route paths out of the source: it reported the literal
   * template as one undeclared route and both real ones as missing. A route the ownership gate cannot
   * see is a route nobody has to declare an owner for, which is the whole thing that gate prevents.
   */
  const standDown = (action) => async (req, res) => {
    const id = sideId(req, res);
    if (!id) return;
    await pass(res, backendFetch(`${backendBaseUrl}/api/project-sides/${id}/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }));
  };
  app.post('/api/project-sides/:id/deactivate', standDown('deactivate'));
  app.post('/api/project-sides/:id/reactivate', standDown('reactivate'));

  /*
   * `force` is forwarded rather than assumed. Without it the backend answers 409 `side_active` and
   * takes nothing down, which is the safe default and the one the page relies on: it asks for
   * confirmation only after the backend has said the side is still active.
   */
  app.delete('/api/project-sides/:id', async (req, res) => {
    const id = sideId(req, res);
    if (!id) return;
    const url = new URL(`${backendBaseUrl}/api/project-sides/${id}`);
    if (req.query.force === 'true') url.searchParams.set('force', 'true');
    await pass(res, backendFetch(url, { method: 'DELETE' }));
  });
}
