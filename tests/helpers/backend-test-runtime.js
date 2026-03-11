import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

function writeJson(filePath, value) {
  writeFileSync(filePath, JSON.stringify(value, null, 2));
}

export async function createBackendTestContext(prefix, seed = {}) {
  const runtimeDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  const dataDir = path.join(runtimeDir, 'data');
  mkdirSync(dataDir, { recursive: true });

  writeJson(path.join(dataDir, 'agents.json'), seed.agents || {});
  writeJson(path.join(dataDir, 'groups.json'), seed.groups || {});
  writeJson(path.join(dataDir, 'messages.json'), seed.messages || []);
  writeJson(path.join(dataDir, 'cursors.json'), seed.cursors || {});
  writeJson(path.join(dataDir, 'servers.json'), seed.servers || {});
  writeJson(path.join(dataDir, 'agent_runtime.json'), seed.agentRuntime || {});
  writeJson(path.join(dataDir, 'local_activity_sweep.json'), { selectionCursor: 0 });
  writeJson(path.join(dataDir, '.msg_counter'), seed.msgCounter || 0);

  process.env.AGENT_CHAT_RUNTIME_DIR = runtimeDir;
  process.env.SUPERVISOR_ENABLED = 'false';
  process.env.AGENT_SCOPE_MONITOR_ENABLED = 'false';
  process.env.AGENT_JSON_WRITE_BATCH_MS = '0';
  if (seed.env && typeof seed.env === 'object') {
    for (const [key, value] of Object.entries(seed.env)) {
      process.env[key] = String(value);
    }
  }

  const backendUrl = pathToFileURL(path.resolve('backend-v2.js')).href;
  const cacheBust = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const { app } = await import(`${backendUrl}?test=${cacheBust}`);

  return {
    app,
    runtimeDir,
    cleanup() {
      rmSync(runtimeDir, { recursive: true, force: true });
    },
  };
}
