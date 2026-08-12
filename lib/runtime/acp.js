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
  /**
   * Flag this agent takes for a default working directory, or null if it takes
   * none. ACP carries `cwd` in session/new, so this is only a fallback for a
   * client that omits it — octos accepts `--cwd`, hermes-acp rejects it outright
   * ("unrecognized arguments: --cwd") and the process dies before the handshake.
   * Hardcoding it made the runtime octos-shaped.
   */
  cwdFlag = null,
  /**
   * Decide a session/request_permission. Receives what the tool call actually is
   * (server, tool, title, input) plus the options the agent offered, and returns
   * the optionId to select — or null to decline. Policy lives with the caller, not
   * in the transport: the same question is already answered for the tmux path by
   * lib/codex-permission-hook.js, and two copies of a security rule is how one of
   * them gets missed. Default is to decline, because a client that cannot identify
   * a tool must not approve it.
   */
  decidePermission = null,
  spawnFn = spawn,
  timeouts = DEFAULT_TIMEOUT_MS,
  env = process.env,
  /** Called per stderr line, so a host can log the agent's own diagnostics. */
  onStderr = null,
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

  /** Write a JSON-RPC response back to the agent. */
  function respond(entry, id, body) {
    try {
      entry.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...body })}\n`);
    } catch {
      // The child is gone; the pending request dies with it and the caller's
      // timeout will report it. Nothing useful to do here.
    }
  }

  /**
   * Answer a request the agent made of us.
   *
   * The rule for anything unimplemented is an explicit error, never silence.
   * ACP clients are expected to answer; an agent that gets no reply blocks until
   * something times out, and the failure surfaces minutes later somewhere else
   * entirely.
   */
  function handleAgentRequest(entry, message) {
    const { id, method, params } = message;
    if (method === 'session/request_permission') {
      const call = entry.toolCalls.get(params?.toolCall?.toolCallId) ?? {};
      const options = Array.isArray(params?.options) ? params.options : [];
      let chosen = null;
      try {
        chosen = decidePermission
          ? decidePermission({
            agent: entry.name,
            toolCallId: params?.toolCall?.toolCallId ?? null,
            server: call.server ?? null,
            tool: call.tool ?? null,
            title: call.title ?? null,
            input: call.input ?? null,
            isMcpToolApproval: params?._meta?.is_mcp_tool_approval === true,
            options,
          })
          : null;
      } catch (error) {
        // A policy that throws denies — it does not open the gate. But it must say
        // so: swallowing this made a broken decider indistinguishable from a
        // deliberate refusal, and the agent reported "the MCP call was rejected"
        // while the log stayed empty.
        chosen = null;
        if (onStderr) onStderr(entry.name, `permission policy threw, denying: ${error?.message ?? error}`);
      }
      if (chosen) {
        respond(entry, id, { result: { outcome: { outcome: 'selected', optionId: chosen } } });
        return;
      }
      // Decline using whichever reject option the agent offered, falling back to
      // 'cancelled' when it offered none. Never silence.
      const reject = options.find((o) => o.kind === 'reject_once')
        ?? options.find((o) => String(o.kind ?? '').startsWith('reject'));
      respond(entry, id, reject
        ? { result: { outcome: { outcome: 'selected', optionId: reject.optionId } } }
        : { result: { outcome: { outcome: 'cancelled' } } });
      return;
    }
    // Everything else — fs/read_text_file, fs/write_text_file, terminal/*. We do
    // not implement them yet, and say so in the protocol's own terms.
    respond(entry, id, {
      error: { code: -32601, message: `hafleet does not implement ${method}` },
    });
  }

  async function start(name, { cwd, mcpServers = [], resumeSessionId = null }) {
    // Only reuse a session that is actually usable. A previous attempt that died
    // during the handshake leaves an entry with no sessionId, and returning it made
    // the mcpServers fallback hand back a dead session — logged as
    // "acp session open: null" and then immediately "session ended".
    const existing = sessions.get(name);
    if (existing && !existing.exited && existing.sessionId) return existing;
    if (existing) sessions.delete(name);
    const spawnArgs = cwdFlag ? [...args, cwdFlag, cwd] : [...args];
    const child = spawnFn(command, spawnArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    const entry = {
      name,
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
      agentCapabilities: {},
      /** tool_call updates by toolCallId, so a permission request can be identified. */
      toolCalls: new Map(),
      /** True when this session came back from the agent's store. */
      resumed: false,
      /** Why a resume was not attempted or did not work, for the host to log. */
      loadError: null,
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
        const update = message.params?.update ?? message.params;
        entry.updates.push({ at: Date.now(), update });
        entry.updatesSeen += 1;
        if (entry.updates.length > 200) entry.updates.splice(0, entry.updates.length - 200);
        // Remember what each tool call actually is. session/request_permission
        // identifies the call only by toolCallId — it carries no tool name — so
        // without this the client cannot tell a coordination call from a shell
        // command and could only answer blind.
        if (update?.sessionUpdate === 'tool_call' && update.toolCallId) {
          entry.toolCalls.set(update.toolCallId, {
            title: update.title ?? null,
            kind: update.kind ?? null,
            server: update.rawInput?.server ?? null,
            tool: update.rawInput?.tool ?? null,
            input: update.rawInput?.arguments ?? null,
          });
          if (entry.toolCalls.size > 200) {
            entry.toolCalls.delete(entry.toolCalls.keys().next().value);
          }
        }
        return;
      }
      // An agent->client REQUEST: it has both a method and an id, and the agent
      // blocks until it gets a response. Dropping these is what made codex-acp
      // hang for the full 600s prompt timeout on every turn that touched an MCP
      // tool: it asks session/request_permission first, and silence is not an
      // answer. Every request is now answered, including the ones we do not
      // implement, so an agent fails fast instead of waiting on us forever.
      if (message.method && message.id !== undefined) {
        handleAgentRequest(entry, message);
      }
    }));
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      entry.stderr = (entry.stderr + text).slice(-4000);
      // Surface it as it arrives, not only in an exit message. ACP reserves stdout
      // for the protocol, so an agent's diagnostics all go here — octos reports
      // which config file it loaded, and warns "MCP initialization failed" on
      // stderr. Buffering that until exit meant hunting a silent misconfiguration
      // with no output to read.
      if (onStderr) {
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (trimmed) onStderr(name, trimmed);
        }
      }
    });
    child.on('exit', (code) => {
      entry.exited = true;
      entry.exitCode = code;
      for (const { reject } of entry.pending.values()) {
        reject(new Error(`acp agent exited with code ${code}: ${entry.stderr.slice(-300)}`));
      }
      entry.pending.clear();
    });

    const initialized = await request(entry, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    }, timeouts.initialize);
    // Keep what the agent said it can do. Calling session/load on an agent that
    // does not advertise it earns a method_not_found and a lost session; octos
    // reported loadSession:false until it gained a real implementation.
    entry.agentCapabilities = initialized?.agentCapabilities ?? {};

    // Resume when we have an id AND the agent says it can. Anything else falls
    // through to a fresh session rather than failing: an agent that starts blank
    // is worse than one that remembers, and far better than one that will not
    // start at all.
    const canLoad = entry.agentCapabilities.loadSession === true;
    // Guard the wire, not just the caller. A caller that hands us the string
    // "null" would otherwise have it accepted by an agent that logs a warning
    // instead of returning an error, and the session id becomes "null".
    const resumable = typeof resumeSessionId === 'string'
      && !['null', 'undefined', 'NaN', ''].includes(resumeSessionId.trim());
    if (resumable && canLoad) {
      try {
        await request(entry, 'session/load',
          { sessionId: resumeSessionId, cwd, mcpServers }, timeouts.newSession);
        entry.sessionId = resumeSessionId;
        entry.resumed = true;
        return entry;
      } catch (error) {
        // A stored id the agent no longer knows is expected after the store is
        // cleared or the agent is reinstalled. Say so and start fresh.
        entry.loadError = error.message;
      }
    } else if (resumable && !canLoad) {
      entry.loadError = 'agent does not advertise loadSession';
    }

    const created = await request(entry, 'session/new', { cwd, mcpServers }, timeouts.newSession);
    entry.sessionId = created?.sessionId ?? null;
    if (!entry.sessionId) {
      teardown(name);
      throw new Error('acp session/new returned no sessionId');
    }
    return entry;
  }

  /** start(), but never leaving a half-built session behind for the next caller. */
  async function startOrCleanUp(name, options) {
    try {
      return await start(name, options);
    } catch (error) {
      // initialize failing (a binary that rejects our arguments, say) left the
      // entry in the map with no sessionId, and the next attempt returned it.
      teardown(name);
      throw error;
    }
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
    /**
     * Stopping an ACP session means CANCELLING it, not killing a host process: there is no pane and
     * no shell, so `cancel` is the only thing that corresponds. Delegated rather than stubbed to
     * false, because "nothing to stop" would be untrue for a live ACP session.
     */
    async killSession(name) {
      const session = String(name || '').trim();
      if (!session) return false;
      if (!(await this.sessionExists(session))) return false;
      try {
        await this.cancel(session);
        return true;
      } catch {
        return false;
      }
    },

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
    async startSession(name, { cwd, mcpServers = [], resumeSessionId = null }) {
      const entry = await startOrCleanUp(String(name).trim(), { cwd, mcpServers, resumeSessionId });
      return entry.sessionId;
    },

    /** Whether the last startSession resumed, and why not if it did not. */
    sessionOrigin(name) {
      const entry = sessions.get(String(name).trim());
      if (!entry) return { resumed: false, loadError: null, canLoad: false };
      return {
        resumed: entry.resumed === true,
        loadError: entry.loadError ?? null,
        canLoad: entry.agentCapabilities?.loadSession === true,
      };
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
