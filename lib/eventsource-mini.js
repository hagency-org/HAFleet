// Minimal SSE client for Node.js using native http
import http from 'http';
import https from 'https';
import { EventEmitter } from 'events';
import { URL } from 'url';

export default class EventSource extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this._connect();
  }

  _connect() {
    const parsed = new URL(this.url);
    const mod = parsed.protocol === 'https:' ? https : http;

    const req = mod.get(this.url, { headers: { Accept: 'text/event-stream' } }, (res) => {
      if (res.statusCode !== 200) {
        this.emit('error', new Error(`SSE status ${res.statusCode}`));
        return;
      }

      let buf = '';
      let currentEvent = 'message';
      let currentData = '';

      res.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop(); // keep incomplete line

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            currentData += (currentData ? '\n' : '') + line.slice(6);
          } else if (line === '') {
            if (currentData) {
              this.emit(currentEvent, currentData);
              currentEvent = 'message';
              currentData = '';
            }
          }
          // ignore comments (lines starting with :)
        }
      });

      res.on('end', () => {
        this.emit('error', new Error('SSE connection ended'));
      });

      res.on('close', () => {
        this.emit('error', new Error('SSE connection closed'));
      });
    });

    req.on('error', (e) => {
      this.emit('error', e);
    });

    req.on('close', () => {
      this.emit('error', new Error('SSE request closed'));
    });
  }
}
