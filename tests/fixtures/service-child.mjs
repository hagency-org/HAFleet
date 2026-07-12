import { appendFileSync } from 'node:fs';
import http from 'node:http';

const name = process.env.SERVICE_CHILD_NAME || 'unknown';
const eventLog = process.env.SERVICE_EVENT_LOG || '';
const servicePortName = `SERVICE_CHILD_${name.toUpperCase()}_PORT`;
const port = Number(process.env.SERVICE_CHILD_PORT || process.env[servicePortName] || 0);

function record(event) {
  if (eventLog) appendFileSync(eventLog, `${JSON.stringify({ name, event, pid: process.pid })}\n`);
}

let server = null;
if (port > 0) {
  server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, '127.0.0.1', () => record('ready'));
} else {
  record('ready');
}

function shutdown() {
  record('stopped');
  if (server) server.close(() => process.exit(0));
  else process.exit(0);
  setTimeout(() => process.exit(0), 250).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
setInterval(() => {}, 1000);
