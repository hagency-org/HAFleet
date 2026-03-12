// Minimal SSE client for Node.js using native http
import http from 'http';
import https from 'https';
import { EventEmitter } from 'events';
import { URL } from 'url';

export default class EventSource extends EventEmitter {
  constructor(url, options = {}) {
    super();
    this.url = url;
    this.headers = options.headers || {};
    // Activity timeout: if no data (including keepalive comments) received
    // within this period, treat connection as dead. Default 45s.
    this._activityTimeoutMs = options.activityTimeoutMs || 45000;
    this._activityTimer = null;
    this._req = null;
    this._connect();
  }

  _resetActivityTimer() {
    if (this._activityTimer) clearTimeout(this._activityTimer);
    this._activityTimer = setTimeout(() => {
      this._activityTimer = null;
      // Kill the request so 'close'/'error' events fire and trigger reconnect
      if (this._req) { try { this._req.destroy(); } catch (_) {} }
      this.emit('error', new Error('SSE activity timeout — no data received'));
    }, this._activityTimeoutMs);
  }

  close() {
    if (this._activityTimer) { clearTimeout(this._activityTimer); this._activityTimer = null; }
    if (this._req) { try { this._req.destroy(); } catch (_) {} this._req = null; }
  }

  _connect() {
    const parsed = new URL(this.url);
    const mod = parsed.protocol === 'https:' ? https : http;

    this._resetActivityTimer();

    const req = mod.get(this.url, { headers: { Accept: 'text/event-stream', ...this.headers } }, (res) => {
      if (res.statusCode !== 200) {
        this.emit('error', new Error(`SSE status ${res.statusCode}`));
        return;
      }

      this._resetActivityTimer();

      let buf = '';
      let currentEvent = 'message';
      let currentData = '';

      res.on('data', (chunk) => {
        this._resetActivityTimer();
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
          // ignore comments (lines starting with :) — but they still reset the activity timer above
        }
      });

      res.on('end', () => {
        this.emit('error', new Error('SSE connection ended'));
      });

      res.on('close', () => {
        this.emit('error', new Error('SSE connection closed'));
      });
    });

    this._req = req;

    req.on('error', (e) => {
      this.emit('error', e);
    });

    req.on('close', () => {
      this.emit('error', new Error('SSE request closed'));
    });
  }
}
