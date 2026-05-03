export function createSseAdapter({ keepaliveMs = 30000 } = {}) {
  const clients = new Set();

  function broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) client.write(frame);
  }

  function installRoute(app, route = '/api/stream') {
    app.get(route, (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(':\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
    });
  }

  function startKeepalive(setIntervalFn = setInterval) {
    return setIntervalFn(() => {
      for (const client of clients) {
        try { client.write(':\n\n'); } catch (_) { clients.delete(client); }
      }
    }, keepaliveMs);
  }

  return {
    broadcast,
    installRoute,
    startKeepalive,
    clients,
  };
}
