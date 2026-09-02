import { describe, expect, test } from 'vitest';
import { execSync, spawn } from 'child_process';
import { mkdtempSync, readdirSync, statSync, readFileSync, writeFileSync, rmSync } from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

const repoRoot = path.resolve('.');

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** Snapshot a directory tree: relative path → { bytes } (content hash by length+first/last bytes). */
function snap(dir) {
  const out = {};
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    const st = statSync(abs);
    if (st.isDirectory()) {
      for (const e of readdirSync(abs)) walk(rel ? `${rel}/${e}` : e);
    } else {
      const b = readFileSync(abs);
      out[rel] = `${b.length}:${b.length ? b[0] : ''}:${b.length ? b[b.length - 1] : ''}`;
    }
  };
  walk('');
  return out;
}

describe('12-r2: --print-pane-target is zero-side-effect', () => {
  test('no runtime files created, no backend requests, output =<session>:1.1', async () => {
    const runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-12r2-'));
    // Pre-create the runtime skeleton the script would use, so we can detect writes to it.
    const agentsDir = path.join(runtimeDir, 'agents');
    const tmpDir = path.join(runtimeDir, 'tmp');
    for (const d of [agentsDir, tmpDir]) {
      spawnSyncSafe(`mkdir -p ${d}`);
    }
    const requests = [];
    const { server, port } = await listen((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });

    // Isolated tmux server with base-index 1 + PATH shim for `tmux`.
    const conf = path.join(runtimeDir, 'tmux.conf');
    writeFileSync(conf, 'set -g base-index 1\nset -g pane-base-index 1\n');
    const sock = 'hafleet-12r2-test';
    const binDir = path.join(runtimeDir, 'bin');
    spawnSyncSafe(`mkdir -p ${binDir}`);
    writeFileSync(path.join(binDir, 'tmux'), `#!/usr/bin/env bash\nexec /usr/bin/tmux -L ${sock} "$@"\n`);
    spawnSyncSafe(`chmod +x ${path.join(binDir, 'tmux')}`);
    spawnSyncSafe(`/usr/bin/tmux -L ${sock} -f ${conf} new-session -d -s t12 'sleep 8'`);

    const before = snap(runtimeDir);
    const out = spawnSyncSafe(
      `cd ${repoRoot} && PATH=${JSON.stringify(binDir)}:$PATH HAFLEET_INTERNAL_DISPATCH=1 HAFLEET_RUNTIME_DIR=${JSON.stringify(runtimeDir)} HAFLEET_API=http://127.0.0.1:${port} bash bin/hafleet-up --print-pane-target t12`,
    );

    expect(out.stderr).not.toMatch(/Error|error/);
    expect(out.stdout.trim()).toBe('=t12:1.1');

    // ZERO side effects: the runtime tree is byte-identical (same files, same fingerprints)
    const after = snap(runtimeDir);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const k of Object.keys(before)) expect(after[k]).toBe(before[k]);
    // and the backend saw NOTHING — no lifecycle, no registration, no heartbeat
    expect(requests).toEqual([]);

    spawnSyncSafe(`/usr/bin/tmux -L ${sock} kill-server`);
    server.close();
    rmSync(runtimeDir, { recursive: true, force: true });
  });
});

function spawnSyncSafe(cmd) {
  if (cmd.startsWith('cd ')) {
    try {
      const stdout = execSync(cmd, { shell: '/bin/bash', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { stdout: stdout ?? '', stderr: '' };
    } catch (e) {
      return { stdout: e.stdout ?? '', stderr: (e.stderr || '') + String(e.message) };
    }
  }
  execSync(cmd, { stdio: 'ignore' });
  return { stdout: '', stderr: '' };
}
