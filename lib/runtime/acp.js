/**
 * Agent Client Protocol runtime.
 *
 * HAFleet's other runtime drives agents by typing into a tmux pane and reading
 * the rendered screen back. That works, but everything fragile about it comes
 * from the same root: the screen is a picture, not data. A tab silently became an
 * underscore on one host and every agent went offline; a framework's prompt
 * symbol turned out to be a user-configurable theme setting; a readiness check
 * fired on a blank pane. octos-tui is a full-screen TUI drawn with box characters,
 * which is the worst case for that approach.
 *
 * ACP replaces the picture with JSON-RPC over stdio: sessions are created, prompts
 * are sent, and the agent reports progress as `session/update` notifications. No
 * scraping, no readiness markers, no dialect problems.
 *
 * WHAT THIS RUNTIME CANNOT DO, deliberately:
 *
 *   capabilities.keys === false      There is no prompt to press keys into.
 *                                    injectSlashClear and every send-keys caller
 *                                    must check this and degrade.
 *   capabilities.capture === false   There is no pane to capture. Progress comes
 *                                    from session/update, not from a screen.
 *
 * Callers that assume tmux semantics will get honest "not supported" answers
 * rather than silently wrong ones — which is exactly why sendKeys was made a
 * declared capability rather than an assumed method.
 *
 * Verified against octos 2.0.2 (`octos acp`). Its v1 reports loadSession:false and
 * empty sessionCapabilities, so resume and fork are NOT available; sessions live
 * only as long as the child process. Its own source also records that it surfaces
 * tool calls but does not block on ACP session/request_permission in v1, so this
 * runtime observes permission activity and cannot answer it. The sandbox level
 * chosen at launch remains the real control.
 */

import { spawn } from 'node:child_process';

import { RUNTIME_CAPABILITIES, emptyPaneListing } from './index.js';

const DEFAULT_TIMEOUT_MS = Object.freeze({
  initialize: 15000,
  newSession: 60000,
  prompt: 600000,
});

/** JSON-RPC framing: one compact JSON object per line, both directions. */
function createLineDecoder(onMessage) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        // A non-JSON line is the agent writing to the wrong stream. Ignore it
        // rather than tearing down a working session over log noise.
      }
    }
  };
}

/**
 * @param {object} [options]
 * @param {string} [options.command] binary providing the ACP agent
 * @param {string[]} [options.args]  arguments placing it in ACP mode
 * @param {Function} [options.spawnFn] injectable for tests
 */
export function createAcpRuntime({
  command = 'octos',
  args = ['acp'],
  spawnFn = spawn,
  timeouts = DEFAULT_TIMEOUT_MS,
  env = process.env,
} = {}) {
  /** sessionName -> { child, sessionId, pending, nextId, updates, exited } */
  const sessions = new Map();

  function teardown(name) {
    const entry = sessions.get(name);
    if (!entry) return;
    for (const { reject } of entry.pending.values()) {
      reject(new Error(`acp session ${name} closed`));
    }
    entry.pending.clear();
    try { entry.child.kill(); } catch { /* already gone */ }
    sessions.delete(name);
  }

  function request(entry, method, params, timeoutMs) {
    const id = entry.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        entry.pending.delete(id);
        reject(new Error(`acp ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      entry.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      entry.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  function notify(entry, method, params) {
    entry.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async function start(name, { cwd, mcpServers = [] }) {
    if (sessions.has(name)) return sessions.get(name);
    const child = spawnFn(command, [...args, '--cwd', cwd], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    const entry = {
      child,
      sessionId: null,
      pending: new Map(),
      nextId: 1,
      // Bounded: a long turn emits a great many updates and this is a
      // liveness signal, not a transcript.
      updates: [],
      // Lifetime count, so a cursor stays meaningful after the bounded buffer
      // has dropped its oldest entries.
      updatesSeen: 0,
      stderr: '',
      exited: false,
      exitCode: null,
    };
    sessions.set(name, entry);

    child.stdout.on('data', createLineDecoder((message) => {
      if (message.id !== undefined && entry.pending.has(message.id)) {
        const { resolve, reject } = entry.pending.get(message.id);
        entry.pending.delete(message.id);
        if (message.error) reject(Object.assign(new Error(message.error.message || 'acp error'), { data: message.error.data }));
        else resolve(message.result);
        return;
      }
      if (message.method === 'session/update') {
        entry.updates.push({ at: Date.now(), update: message.params?.update ?? message.params });
        entry.updatesSeen += 1;
        if (entry.updates.length > 200) entry.updates.splice(0, entry.updates.length - 200);
      }
    }));
    child.stderr.on('data', (chunk) => {
      entry.stderr = (entry.stderr + chunk.toString('utf8')).slice(-4000);
    });
    child.on('exit', (code) => {
      entry.exited = true;
      entry.exitCode = code;
      for (const { reject } of entry.pending.values()) {
        reject(new Error(`acp agent exited with code ${code}: ${entry.stderr.slice(-300)}`));
      }
      entry.pending.clear();
    });

    await request(entry, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    }, timeouts.initialize);

    const created = await request(entry, 'session/new', { cwd, mcpServers }, timeouts.newSession);
    entry.sessionId = created?.sessionId ?? null;
    if (!entry.sessionId) {
      teardown(name);
      throw new Error('acp session/new returned no sessionId');
    }
    return entry;
  }

  return Object.freeze({
    name: 'acp',
    capabilities: Object.freeze({
      ...RUNTIME_CAPABILITIES,
      // No interactive prompt and no screen. Both false on purpose; see the
      // header. A caller that ignores these will get honest refusals below.
      keys: false,
      capture: false,
      sessions: true,
    }),

    async isAvailable() {
      return new Promise((resolve) => {
        try {
          const probe = spawnFn(command, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], env });
          probe.on('error', () => resolve(false));
          probe.on('exit', (code) => resolve(code === 0));
        } catch { resolve(false); }
      });
    },

    async sessionExists(name) {
      const entry = sessions.get(String(name || '').trim());
      return Boolean(entry && !entry.exited && entry.sessionId);
    },

    /**
     * Shaped like the tmux listing so the sweep needs no special case, but these
     * are processes rather than panes: tty is null and the "command" is the ACP
     * binary. serverUnavailable stays false — this runtime has no shared server
     * whose absence could be mistaken for an idle host.
     */
    async listPanes() {
      const panes = [];
      for (const [name, entry] of sessions) {
        if (entry.exited) continue;
        panes.push({
          tty: null,
          session: name,
          pid: entry.child.pid ?? null,
          command,
          path: null,
        });
      }
      return { ok: true, panes, error: null, serverUnavailable: false };
    },

    /** No screen exists to capture. Callers must check capabilities.capture. */
    async capturePane() {
      return null;
    },

    /** No prompt exists to type into. Callers must check capabilities.keys. */
    async sendKeys() {
      return false;
    },

    isEmptyServerError() {
      // There is no shared server, so no error can mean "server not running".
      return false;
    },

    // ── ACP-specific surface, beyond the shared contract ──────────────────

    /**
     * Start an agent and open its session. Returns the ACP sessionId.
     *
     * mcpServers is passed through to session/new. That is how an ACP agent gets
     * HAFleet's coordination tools (check_inbox, send_message, ...) — the same set
     * a tmux agent reaches through .mcp.json. Without it the agent can be prompted
     * but cannot read its own inbox or reply, which makes it a spectator.
     */
    async startSession(name, { cwd, mcpServers = [] }) {
      const entry = await start(String(name).trim(), { cwd, mcpServers });
      return entry.sessionId;
    },

    /** Send a turn. Resolves with the ACP stopReason when the turn completes. */
    async prompt(name, text) {
      const entry = sessions.get(String(name).trim());
      if (!entry) throw new Error(`no acp session for ${name}`);
      const result = await request(entry, 'session/prompt', {
        sessionId: entry.sessionId,
        prompt: [{ type: 'text', text: String(text) }],
      }, timeouts.prompt);
      return result?.stopReason ?? null;
    },

    /**
     * Interrupt a turn in flight. This is the ACP answer to tmux's C-c, and
     * unlike C-c it is acknowledged: the turn responds with StopReason::Cancelled.
     */
    async cancel(name) {
      const entry = sessions.get(String(name).trim());
      if (!entry) return false;
      notify(entry, 'session/cancel', { sessionId: entry.sessionId });
      return true;
    },

    /** Recent session/update notifications — the liveness signal, in place of a pane hash. */
    recentUpdates(name, limit = 20) {
      const entry = sessions.get(String(name).trim());
      if (!entry) return [];
      return entry.updates.slice(-limit);
    },

    /**
     * A marker for "everything received so far", to read one turn's updates alone.
     *
     * recentUpdates(name, N) returns the last N notifications regardless of which
     * turn produced them. A caller reconstructing what the agent said from that
     * silently prepends the previous answer: on mini5 a reply was posted into
     * HAFleet reading "TokyoThe command exited with code 7…" — "Tokyo" was the
     * answer to the question before it. Take a cursor before prompting and read
     * from it afterwards.
     *
     * The buffer is bounded and drops oldest-first, so a cursor can end up past
     * what remains; updatesSince accounts for that rather than returning nonsense.
     */
    updateCursor(name) {
      const entry = sessions.get(String(name).trim());
      return entry ? entry.updatesSeen : 0;
    },

    /** Updates received after `cursor`, as returned by updateCursor. */
    updatesSince(name, cursor) {
      const entry = sessions.get(String(name).trim());
      if (!entry) return [];
      const dropped = entry.updatesSeen - entry.updates.length;
      const from = Math.max(0, Number(cursor ?? 0) - dropped);
      return entry.updates.slice(from);
    },

    stop(name) {
      teardown(String(name).trim());
    },

    stopAll() {
      for (const name of [...sessions.keys()]) teardown(name);
    },
  });
}
