import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

function writeJson(filePath, value) {
  writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function v1AgentIdFromName(name) {
  const normalized = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+/, '')
    .replace(/_+$/, '');
  return normalized ? `agent_${normalized}` : null;
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
  writeJson(path.join(dataDir, 'alerts.json'), seed.alerts || []);
  writeJson(path.join(dataDir, 'framework-presets.json'), seed.frameworkPresets || []);
  writeJson(path.join(dataDir, 'supervisor_state.json'), seed.supervisorState || { agents: {}, selectionCursor: 0 });
  writeJson(path.join(dataDir, 'local_activity_sweep.json'), { selectionCursor: 0 });
  if (seed.deletedAgents) writeJson(path.join(dataDir, 'deleted_agents.json'), seed.deletedAgents);
  writeJson(path.join(dataDir, '.msg_counter'), seed.msgCounter || 0);
  if (seed.agentTokens && typeof seed.agentTokens === 'object') {
    for (const [name, token] of Object.entries(seed.agentTokens)) {
      const agentId = v1AgentIdFromName(name);
      if (!agentId) continue;
      const stateDir = path.join(runtimeDir, 'homes', 'agents', agentId, 'state');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(path.join(stateDir, 'agent-token'), String(token));
    }
  }

  const savedEnv = new Map();
  const rememberEnv = (key) => {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  };
  for (const key of [
    'AGENT_CHAT_RUNTIME_DIR',
    'AGENT_CHAT_SERVER',
    'AGENT_CHAT_RECORD_LOCAL_SERVER',
    'SUPERVISOR_ENABLED',
    'AGENT_SCOPE_MONITOR_ENABLED',
    'AGENT_JSON_WRITE_BATCH_MS',
    'AGENT_BLOCKED_INFO_AGGREGATE_WINDOW_MS',
    'API_TOKEN',
  ]) {
    rememberEnv(key);
  }
  if (seed.env && typeof seed.env === 'object') {
    for (const key of Object.keys(seed.env)) rememberEnv(key);
  }

  process.env.AGENT_CHAT_RUNTIME_DIR = runtimeDir;
  delete process.env.AGENT_CHAT_SERVER;
  delete process.env.AGENT_CHAT_RECORD_LOCAL_SERVER;
  process.env.SUPERVISOR_ENABLED = 'false';
  process.env.AGENT_SCOPE_MONITOR_ENABLED = 'false';
  process.env.AGENT_JSON_WRITE_BATCH_MS = '0';
  process.env.AGENT_BLOCKED_INFO_AGGREGATE_WINDOW_MS = '0';
  delete process.env.API_TOKEN; // tests run without Bearer auth unless explicitly configured
  if (seed.env && typeof seed.env === 'object') {
    for (const [key, value] of Object.entries(seed.env)) {
      process.env[key] = String(value);
    }
  }

  const backendUrl = pathToFileURL(path.resolve('backend-v2.js')).href;
  const cacheBust = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const backendModule = await import(`${backendUrl}?test=${cacheBust}`);
  const { app } = backendModule;
  const servers = new Set();

  return {
    app,
    backendModule,
    internals: backendModule.__backendV2TestInternals || {},
    runtimeDir,
    async listen(host = '127.0.0.1') {
      const server = await new Promise((resolve, reject) => {
        const instance = app.listen(0, host, () => resolve(instance));
        instance.on('error', reject);
      });
      if (typeof server.unref === 'function') server.unref();
      servers.add(server);
      const address = server.address();
      return {
        server,
        baseUrl: `http://${host}:${address.port}`,
        close() {
          return new Promise((resolve, reject) => {
            if (typeof server.closeAllConnections === 'function') {
              server.closeAllConnections();
            }
            server.close((error) => {
              servers.delete(server);
              if (error) reject(error);
              else resolve();
            });
          });
        },
      };
    },
    cleanup() {
      for (const server of servers) {
        try {
          server.close();
        } catch {
          // ignore close errors in test cleanup
        }
      }
      servers.clear();
      rmSync(runtimeDir, { recursive: true, force: true });
      for (const [key, value] of savedEnv.entries()) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}
