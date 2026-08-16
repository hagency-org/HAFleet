import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
  /*
   * Files OUTSIDE data/ — the delivery queue persists under logs/, and a test that needs a corrupt
   * logs/queue.json in place BEFORE the module loads cannot use rawDataFiles, which is rooted in data/.
   * Paths are relative to the runtime dir.
   */
  if (seed.rawRuntimeFiles && typeof seed.rawRuntimeFiles === 'object') {
    for (const [name, contents] of Object.entries(seed.rawRuntimeFiles)) {
      const filePath = path.join(runtimeDir, name);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, String(contents));
    }
  }
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
  /*
   * THE DIRECTORY IS RIGHT — IS THE DATA VISIBLE? Those are different questions, and only the first was
   * being asked. The check above proves the module bound to the path we meant; it cannot prove the module
   * READ what we wrote there, and every recorded flake in docs/TESTING.md has the same shape: a value that
   * should exist comes back `undefined` or `404`, in a file that passes alone.
   *
   * Measured before writing this: of 28 logged failures, 25 failed in under half a second — assertion
   * failures, not timeouts. So the suspicion is not "slow" but "looking at the wrong data", and this turns
   * that suspicion into a labelled failure AT SETUP instead of an unexplained assertion two hundred lines
   * later. It does not fix the flake. It makes the next one say what it is.
   *
   * Cheap on purpose: one in-process read of the store the backend already loaded, no HTTP, and only when
   * agents were seeded — which is most contexts and never an empty one.
   */
  const seededNames = Object.keys(seed.agents || {});
  if (seededNames.length) {
    /*
     * EVERY RECORD, not only the agent-shaped ones. The store holds humans too (`kind: 'human'`), and
     * `inferRecordKind` decides which is which — so comparing seeded keys against agents-only reports a
     * human seed as missing. That is not a hypothetical: the first version of this check did exactly that
     * and deterministically broke two files while I was describing it as having caught a flake.
     */
    const snapshot = backendModule.__backendV2TestInternals?.storeSnapshotForTest?.() ?? null;
    const visible = Array.isArray(snapshot?.records) ? snapshot.records : null;
    if (visible) {
      const missing = seededNames.filter((name) => !visible.includes(name));
      if (missing.length) {
        /*
         * WHICH OF THE TWO WENT WRONG. "The module sees the wrong records" has exactly two causes with
         * opposite fixes: the module read a different directory, or the seed was written somewhere else.
         * Re-reading the file this helper claims to have written separates them.
         */
        let onDisk = '(unreadable)';
        try {
          const raw = JSON.parse(readFileSync(path.join(runtimeDir, 'data', 'agents.json'), 'utf8'));
          onDisk = Object.keys(raw).join(', ') || '(empty)';
        } catch (error) {
          onDisk = `(unreadable: ${error.message})`;
        }
        throw new Error(
          `backend bound to ${runtimeDir} but cannot see ${missing.length} seeded record(s): `
          + `${missing.join(', ')}. The module sees [${visible.join(', ')}]; the file at that path holds `
          + `[${onDisk}]. If those two disagree the MODULE read another directory; if the file itself is `
          + 'wrong the SEED was written elsewhere. This is the shape every whole-suite flake in '
          + 'docs/TESTING.md has taken, and the two halves have opposite fixes.',
        );
      }
    }
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
