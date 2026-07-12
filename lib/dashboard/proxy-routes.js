export function installSubconsciousProxyRoutes(app, {
  backendBaseUrl,
  backendFetch,
}) {
  app.post('/api/subconscious/upstream/bootstrap/:name', async (req, res) => {
    const name = req.params.name;
    if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });
    try {
      const r = await backendFetch(`${backendBaseUrl}/api/subconscious/upstream/bootstrap/${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const payload = await r.json().catch(() => ({ ok: false, error: `backend status ${r.status}` }));
      return res.status(r.status).json(payload);
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message || 'upstream bootstrap proxy failed' });
    }
  });

  app.post('/api/subconscious/upstream/session-start/:name', async (req, res) => {
    const name = req.params.name;
    if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });
    try {
      const r = await backendFetch(`${backendBaseUrl}/api/subconscious/upstream/session-start/${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body || {}),
      });
      const payload = await r.json().catch(() => ({ ok: false, error: `backend status ${r.status}` }));
      return res.status(r.status).json(payload);
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message || 'upstream session-start proxy failed' });
    }
  });

  app.post('/api/subconscious/upstream/user-prompt/:name', async (req, res) => {
    const name = req.params.name;
    if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });
    try {
      const r = await backendFetch(`${backendBaseUrl}/api/subconscious/upstream/user-prompt/${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body || {}),
      });
      const payload = await r.json().catch(() => ({ ok: false, error: `backend status ${r.status}` }));
      return res.status(r.status).json(payload);
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message || 'upstream user-prompt proxy failed' });
    }
  });

  app.post('/api/subconscious/upstream/pretool/:name', async (req, res) => {
    const name = req.params.name;
    if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });
    try {
      const r = await backendFetch(`${backendBaseUrl}/api/subconscious/upstream/pretool/${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body || {}),
      });
      const payload = await r.json().catch(() => ({ ok: false, error: `backend status ${r.status}` }));
      return res.status(r.status).json(payload);
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message || 'upstream pretool proxy failed' });
    }
  });
}

export function installTaskProxyRoutes(app, { backendBaseUrl, backendFetch }) {
  app.get('/api/tasks', async (req, res) => {
    try {
      const url = new URL(`${backendBaseUrl}/api/tasks`);
      for (const key of ['assignee', 'status', 'priority', 'label', 'limit', 'offset']) {
        if (typeof req.query[key] === 'string' && req.query[key].trim()) url.searchParams.set(key, req.query[key].trim());
      }
      const r = await backendFetch(url);
      const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
      res.status(r.status).json(data);
    } catch (e) { res.status(502).json({ error: 'backend unreachable', detail: e.message }); }
  });

  // matrix-Agent pool grid — proxy to the backend so the /pool dashboard page can fetch it.
  app.get('/api/pool', async (req, res) => {
    try {
      const url = new URL(`${backendBaseUrl}/api/pool`);
      for (const key of ['role', 'capability', 'state']) {
        if (typeof req.query[key] === 'string' && req.query[key].trim()) url.searchParams.set(key, req.query[key].trim());
      }
      const r = await backendFetch(url);
      const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
      res.status(r.status).json(data);
    } catch (e) { res.status(502).json({ error: 'backend unreachable', detail: e.message }); }
  });

  app.post('/api/tasks', async (req, res) => {
    try {
      const r = await backendFetch(`${backendBaseUrl}/api/tasks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body || {}),
      });
      const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
      res.status(r.status).json(data);
    } catch (e) { res.status(502).json({ error: 'backend unreachable', detail: e.message }); }
  });

  app.get('/api/tasks/:id', async (req, res) => {
    try {
      const r = await backendFetch(`${backendBaseUrl}/api/tasks/${encodeURIComponent(req.params.id)}`);
      const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
      res.status(r.status).json(data);
    } catch (e) { res.status(502).json({ error: 'backend unreachable', detail: e.message }); }
  });

  app.patch('/api/tasks/:id', async (req, res) => {
    try {
      const r = await backendFetch(`${backendBaseUrl}/api/tasks/${encodeURIComponent(req.params.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body || {}),
      });
      const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
      res.status(r.status).json(data);
    } catch (e) { res.status(502).json({ error: 'backend unreachable', detail: e.message }); }
  });

  app.delete('/api/tasks/:id', async (req, res) => {
    try {
      const r = await backendFetch(`${backendBaseUrl}/api/tasks/${encodeURIComponent(req.params.id)}`, { method: 'DELETE' });
      const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
      res.status(r.status).json(data);
    } catch (e) { res.status(502).json({ error: 'backend unreachable', detail: e.message }); }
  });

  app.post('/api/tasks/:id/transition', async (req, res) => {
    try {
      const r = await backendFetch(`${backendBaseUrl}/api/tasks/${encodeURIComponent(req.params.id)}/transition`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body || {}),
      });
      const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
      res.status(r.status).json(data);
    } catch (e) { res.status(502).json({ error: 'backend unreachable', detail: e.message }); }
  });

  app.post('/api/tasks/:id/comments', async (req, res) => {
    try {
      const r = await backendFetch(`${backendBaseUrl}/api/tasks/${encodeURIComponent(req.params.id)}/comments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body || {}),
      });
      const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
      res.status(r.status).json(data);
    } catch (e) { res.status(502).json({ error: 'backend unreachable', detail: e.message }); }
  });

  app.post('/api/task-graphs', async (req, res) => {
    try {
      const r = await backendFetch(`${backendBaseUrl}/api/task-graphs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body || {}),
      });
      const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
      res.status(r.status).json(data);
    } catch (e) {
      res.status(502).json({ error: 'backend unreachable', detail: e.message });
    }
  });

  app.get('/api/task-graphs', async (req, res) => {
    try {
      const url = new URL(`${backendBaseUrl}/api/task-graphs`);
      if (typeof req.query.status === 'string' && req.query.status.trim()) {
        url.searchParams.set('status', req.query.status.trim());
      }
      const r = await backendFetch(url);
      const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
      res.status(r.status).json(data);
    } catch (e) {
      res.status(502).json({ error: 'backend unreachable', detail: e.message });
    }
  });

  app.get('/api/task-graphs/:id', async (req, res) => {
    try {
      const r = await backendFetch(`${backendBaseUrl}/api/task-graphs/${encodeURIComponent(req.params.id)}`);
      const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
      res.status(r.status).json(data);
    } catch (e) {
      res.status(502).json({ error: 'backend unreachable', detail: e.message });
    }
  });

  app.delete('/api/task-graphs/:id', async (req, res) => {
    try {
      const r = await backendFetch(`${backendBaseUrl}/api/task-graphs/${encodeURIComponent(req.params.id)}`, {
        method: 'DELETE',
      });
      const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
      res.status(r.status).json(data);
    } catch (e) {
      res.status(502).json({ error: 'backend unreachable', detail: e.message });
    }
  });

  app.patch('/api/task-graphs/:id/nodes/:nodeId', async (req, res) => {
    try {
      const r = await backendFetch(
        `${backendBaseUrl}/api/task-graphs/${encodeURIComponent(req.params.id)}/nodes/${encodeURIComponent(req.params.nodeId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req.body || {}),
        }
      );
      const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
      res.status(r.status).json(data);
    } catch (e) {
      res.status(502).json({ error: 'backend unreachable', detail: e.message });
    }
  });
}

export function installSupervisorProxyRoutes(app, { backendBaseUrl, backendFetch }) {
  app.get('/api/supervisor/status', async (_req, res) => {
    try {
      const r = await backendFetch(`${backendBaseUrl}/api/supervisor/status`);
      const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
      res.status(r.status).json(data);
    } catch (e) {
      res.status(502).json({ error: 'backend unreachable', detail: e.message });
    }
  });

  app.get('/api/supervisor/agents', async (_req, res) => {
    try {
      const r = await backendFetch(`${backendBaseUrl}/api/supervisor/agents`);
      const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
      res.status(r.status).json(data);
    } catch (e) {
      res.status(502).json({ error: 'backend unreachable', detail: e.message });
    }
  });

  app.get('/api/supervisor/agents/:name', async (req, res) => {
    const name = req.params.name;
    if (!/^[\w\-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });
    const limitRaw = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 120;
    try {
      const r = await backendFetch(`${backendBaseUrl}/api/supervisor/agents/${encodeURIComponent(name)}?limit=${limit}`);
      const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
      res.status(r.status).json(data);
    } catch (e) {
      res.status(502).json({ error: 'backend unreachable', detail: e.message });
    }
  });

  app.get('/api/supervisor/control', async (_req, res) => {
    try {
      const r = await backendFetch(`${backendBaseUrl}/api/supervisor/control`);
      const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
      res.status(r.status).json(data);
    } catch (e) {
      res.status(502).json({ error: 'backend unreachable', detail: e.message });
    }
  });

  app.post('/api/supervisor/control', async (req, res) => {
    try {
      const r = await backendFetch(`${backendBaseUrl}/api/supervisor/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body || {}),
      });
      const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
      res.status(r.status).json(data);
    } catch (e) {
      res.status(502).json({ error: 'backend unreachable', detail: e.message });
    }
  });
}

export function installSubconsciousEventProxyRoutes(app, { backendBaseUrl, backendFetch }) {
  app.get('/api/subconscious/events', async (req, res) => {
    try {
      const url = new URL(`${backendBaseUrl}/api/subconscious/events`);
      if (typeof req.query.agent === 'string' && req.query.agent.trim()) {
        url.searchParams.set('agent', req.query.agent.trim());
      }
      const limitRaw = Number.parseInt(req.query.limit, 10);
      if (Number.isFinite(limitRaw) && limitRaw > 0) {
        url.searchParams.set('limit', String(Math.min(limitRaw, 500)));
      }
      const r = await backendFetch(url);
      const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
      res.status(r.status).json(data);
    } catch (e) {
      res.status(502).json({ error: 'backend unreachable', detail: e.message });
    }
  });

  app.get('/api/subconscious/events/:name', async (req, res) => {
    const name = req.params.name;
    if (!/^[\w.-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });
    try {
      const url = new URL(`${backendBaseUrl}/api/subconscious/events/${encodeURIComponent(name)}`);
      const limitRaw = Number.parseInt(req.query.limit, 10);
      if (Number.isFinite(limitRaw) && limitRaw > 0) {
        url.searchParams.set('limit', String(Math.min(limitRaw, 500)));
      }
      const r = await backendFetch(url);
      const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
      res.status(r.status).json(data);
    } catch (e) {
      res.status(502).json({ error: 'backend unreachable', detail: e.message });
    }
  });
}

export function installAlertProxyRoutes(app, { backendBaseUrl, backendFetch }) {
  function alertProxyGet(routeSuffix) {
    return async (req, res) => {
      try {
        const url = new URL(`${backendBaseUrl}/api/alerts${routeSuffix.replace(':id', encodeURIComponent(req.params.id || ''))}`);
        for (const [k, v] of Object.entries(req.query)) url.searchParams.set(k, v);
        const r = await backendFetch(url);
        const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
        res.status(r.status).json(data);
      } catch (e) { res.status(502).json({ error: 'backend unreachable', detail: e.message }); }
    };
  }
  function alertProxyMutate(routeSuffix, method) {
    return async (req, res) => {
      try {
        const path = routeSuffix.replace(':id', encodeURIComponent(req.params.id || ''));
        const r = await backendFetch(`${backendBaseUrl}/api/alerts${path}`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: method === 'DELETE' ? undefined : JSON.stringify(req.body || {}),
        });
        const data = await r.json().catch(() => ({ error: `backend status ${r.status}` }));
        res.status(r.status).json(data);
      } catch (e) { res.status(502).json({ error: 'backend unreachable', detail: e.message }); }
    };
  }
  app.get('/api/alerts', alertProxyGet(''));
  app.get('/api/alerts/stats', alertProxyGet('/stats'));
  app.get('/api/alerts/:id', alertProxyGet('/:id'));
  app.post('/api/alerts/:id/transition', alertProxyMutate('/:id/transition', 'POST'));
  app.post('/api/alerts/:id/notes', alertProxyMutate('/:id/notes', 'POST'));
  app.patch('/api/alerts/:id', alertProxyMutate('/:id', 'PATCH'));
  app.delete('/api/alerts/:id', alertProxyMutate('/:id', 'DELETE'));
}
