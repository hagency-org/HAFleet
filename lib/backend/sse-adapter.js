export function createSseAdapter({ keepaliveMs = 30000 } = {}) {
  const clients = new Set();

  function writeFrame(client, frame) {
    try {
      client.write(frame);
      return true;
    } catch {
      clients.delete(client);
      return false;
    }
  }

  function broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) writeFrame(client, frame);
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
      for (const client of clients) writeFrame(client, ':\n\n');
    }, keepaliveMs);
  }

  return {
    broadcast,
    installRoute,
    startKeepalive,
    clients,
  };
}
