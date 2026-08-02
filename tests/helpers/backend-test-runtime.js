import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

/** Serialises the env-set/import window. See createBackendTestContext. */
let importLock = Promise.resolve();
function acquireImportLock() {
  let release;
  const next = new Promise((resolve) => { release = resolve; });
  const waitFor = importLock;
  importLock = importLock.then(() => next);
  return waitFor.then(() => release);
}

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
  if (seed.rawDataFiles && typeof seed.rawDataFiles === 'object') {
    for (const [name, contents] of Object.entries(seed.rawDataFiles)) {
      const filePath = path.join(dataDir, name);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, String(contents));
    }
  }
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
    'HAFLEET_RUNTIME_DIR',
    'HAFLEET_SERVER',
    'HAFLEET_RECORD_LOCAL_SERVER',
    'SUPERVISOR_ENABLED',
    'AGENT_SCOPE_MONITOR_ENABLED',
    'AGENT_JSON_WRITE_BATCH_MS',
    'AGENT_BLOCKED_INFO_AGGREGATE_WINDOW_MS',
    'AGENT_SERVER_MAINTENANCE_IDS',
    'AGENT_TMUX_MISSING_THRESHOLD',
    'API_TOKEN',
  ]) {
    rememberEnv(key);
  }
  if (seed.env && typeof seed.env === 'object') {
    for (const key of Object.keys(seed.env)) rememberEnv(key);
  }

  process.env.HAFLEET_RUNTIME_DIR = runtimeDir;
  delete process.env.HAFLEET_SERVER;
  delete process.env.HAFLEET_RECORD_LOCAL_SERVER;
  process.env.SUPERVISOR_ENABLED = 'false';
  process.env.AGENT_SCOPE_MONITOR_ENABLED = 'false';
  process.env.AGENT_JSON_WRITE_BATCH_MS = '0';
  process.env.AGENT_BLOCKED_INFO_AGGREGATE_WINDOW_MS = '0';
  delete process.env.AGENT_SERVER_MAINTENANCE_IDS;
  delete process.env.AGENT_TMUX_MISSING_THRESHOLD;
  delete process.env.API_TOKEN; // tests run without Bearer auth unless explicitly configured
  if (seed.env && typeof seed.env === 'object') {
    for (const [key, value] of Object.entries(seed.env)) {
      process.env[key] = String(value);
    }
  }

  const backendUrl = pathToFileURL(path.resolve('backend-v2.js')).href;
  const cacheBust = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  // Serialise env-set through import.
  //
  // backend-v2.js reads HAFLEET_RUNTIME_DIR at module-evaluation time and loads
  // agents.json from it immediately. process.env is process-global and `await
  // import()` yields, so between setting the variable above and the module body
  // running, any other context doing the same — or any cleanup() restoring the
  // previous value — silently rebinds this module to the wrong directory. There
  // are 18 such assignment sites across 12 test files.
  //
  // A module bound to the wrong directory finds no seeded agents and answers 404
  // to everything, which is how "GET /api/agents/doomed -> 404" and
  // "DELETE /api/agents/deletetest -> 404" appeared for agents that were plainly
  // seeded: rare, a different file each time, and passing in isolation.
  const release = await acquireImportLock();
  let backendModule;
  try {
    process.env.HAFLEET_RUNTIME_DIR = runtimeDir;
    backendModule = await import(`${backendUrl}?test=${cacheBust}`);
  } finally {
    release();
  }

  // Belt and braces: the lock only covers contexts created through this helper,
  // and twelve files set the variable themselves. If one of them lands mid-import
  // anyway, fail here with the reason rather than as a 404 several assertions later.
  const boundRoot = backendModule.__backendV2TestInternals?.runtimeRootForTest;
  if (boundRoot && path.resolve(boundRoot) !== path.resolve(runtimeDir)) {
    throw new Error(
      `backend bound to the wrong runtime dir: expected ${runtimeDir}, got ${boundRoot}. `
      + 'Another test mutated HAFLEET_RUNTIME_DIR during this import.',
    );
  }
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
      // Stop the module's background loops before the runtime dir is deleted
      // underneath them.
      //
      // Each context imports backend-v2.js under a unique ?test= URL to get a
      // fresh instance. A unique URL is a permanent ESM registry entry, so every
      // context in a run stays resident, and until now nothing stopped the sweep
      // and heartbeat intervals those instances started. stopServer() already
      // exists and does exactly that (stopBackgroundLoops -> clearLifecycleHandles,
      // endSseClients); the helper simply never called it.
      //
      // Scope of what this fixes, honestly: it stops the loop leak. It did NOT
      // change the intermittent failures — measured before and after on the same
      // machine, the counts were unchanged. Those remain unexplained; see
      // docs/TESTING.md. Do not cite this as their fix.
      //
      // The sync work happens before stopServer()'s first await, and it returns
      // early when no server was started — the case here, since tests drive `app`
      // through supertest. So the timers are gone once this returns, nothing to await.
      try {
        const stopping = backendModule?.stopServer?.();
        if (stopping && typeof stopping.catch === 'function') stopping.catch(() => {});
      } catch {
        // A context that failed mid-import may have no stopServer; nothing to stop.
      }

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
