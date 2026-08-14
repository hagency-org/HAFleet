import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

import type { RouterStore } from './store.js';
import type {
  ApprovalDecisionEvent,
  ClaimSuccess,
  Refusal,
  SettleSuccess,
  StartedPayload,
} from './types.js';

export interface OwnerApprovalRequest {
  approvalId: string;
  dispatchId: string;
  operationDigest: string;
  framework: 'codex';
  kind: 'command' | 'file_change' | 'permissions';
  reason: string | null;
  command: string | null;
  cwd: string | null;
  upstreamThreadId: string;
  upstreamTurnId: string;
  upstreamItemId: string;
  upstreamRequestId: string;
}

export interface OwnerApprovalVerdict {
  decisionEventId: string;
  decision: 'allow' | 'deny';
}

export type OwnerApprovalHandler = (request: OwnerApprovalRequest) => Promise<OwnerApprovalVerdict>;

export interface RunnerBaseOptions {
  router: RouterStore;
  claim: ClaimSuccess;
  cwd: string;
  env?: Readonly<Record<string, string>>;
  acknowledgementTimeoutMs?: number;
  executionTimeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Whether this dispatch holds the workspace lease. Defaults to `false` so
   * that a caller which forgets to pass it gets the confined runtime rather
   * than an unserialized, untracked writable one.
   */
  mayWrite?: boolean;
}

export interface CodexRunnerOptions extends RunnerBaseOptions {
  executable?: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  approvalTimeoutMs: number;
  maxParkedRunners: number;
  requestOwnerApproval: OwnerApprovalHandler;
  mcpServer?: {
    name: string;
    command: string;
    args: readonly string[];
    envVars: readonly string[];
  };
}

export interface ClaudeRunnerOptions extends RunnerBaseOptions {
  executable?: string;
  args?: readonly string[];
}

export interface RunnerCompletion {
  dispatchId: string;
  state: 'completed' | 'outcome_unknown';
  text: string;
  exitCode: number | null;
}

interface RpcMessage {
  id?: string | number;
  method?: string;
  params?: Readonly<Record<string, unknown>>;
  result?: Readonly<Record<string, unknown>>;
  error?: Readonly<Record<string, unknown>>;
}

interface PendingWrite {
  resolve: () => void;
  reject: (error: Error) => void;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) output[key] = canonical(input[key]);
    return output;
  }
  return value;
}

export function operationDigest(method: string, params: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(JSON.stringify(canonical({ method, params }))).digest('hex');
}

function capabilityInput(claim: ClaimSuccess): {
  dispatchId: string;
  runnerId: string;
  fenceGeneration: number;
  capability: string;
} {
  return {
    dispatchId: claim.dispatchId,
    runnerId: claim.runnerId,
    fenceGeneration: claim.fenceGeneration,
    capability: claim.capability,
  };
}

function refusalError(result: Refusal): Error {
  return new Error(`${result.code}: ${result.message}`);
}

const INHERITED_RUNNER_ENV_KEYS = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
  'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
  'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
] as const;

const FORBIDDEN_RUNNER_ENV_KEYS = new Set([
  'API_TOKEN',
  'MATRIX_BRIDGE_SECRET',
  'HAFLEET_DASHBOARD_TOKEN',
  'HAFLEET_SUBCONSCIOUS_EVENT_TOKEN',
  'MATRIX_BOT_PASSWORD',
  'MATRIX_REG_TOKEN',
  'MATRIX_AGENT_PASSWORD_SECRET',
]);

function runnerEnv(claim: ClaimSuccess, extra: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_RUNNER_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (!FORBIDDEN_RUNNER_ENV_KEYS.has(key)) env[key] = value;
  }
  return {
    ...env,
    HAFLEET_DISPATCH_CAPABILITY: claim.capability,
    HAFLEET_DISPATCH_ID: claim.dispatchId,
    HAFLEET_RUNNER_ID: claim.runnerId,
    HAFLEET_FENCE_GENERATION: String(claim.fenceGeneration),
  };
}

function codexAppServerArgs(options: CodexRunnerOptions): string[] {
  const args = ['app-server', '--stdio'];
  const mcp = options.mcpServer;
  if (!mcp) return args;
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(mcp.name)) throw new Error('Codex MCP server name is invalid');
  const prefix = `mcp_servers.${mcp.name}`;
  args.push(
    '-c', `${prefix}.command=${JSON.stringify(mcp.command)}`,
    '-c', `${prefix}.args=${JSON.stringify([...mcp.args])}`,
    '-c', `${prefix}.env_vars=${JSON.stringify([...mcp.envVars])}`,
  );
  return args;
}

function buildPrompt(payload: StartedPayload): string {
  const requested = typeof payload.payload.prompt === 'string' ? payload.payload.prompt.trim() : '';
  const { prompt: _prompt, ...taskContext } = payload.payload;
  const context = {
    coordinatorDigest: payload.context.coordinatorDigest,
    sessionId: payload.sessionId,
    taskId: payload.taskId,
    contextGeneration: payload.context.contextGeneration,
    rollingSummary: payload.context.rollingSummary,
    messages: payload.context.messages.map((message) => ({
      id: message.messageId, sender: message.senderName,
      body: message.body, receivedAt: message.receivedAt,
    })),
    taskDigest: payload.context.taskDigest,
    currentBatchMessageIds: payload.inbox.map((message) => message.messageId),
    taskContext,
  };
  return [
    'Work only from the session-scoped context below. Do not invent or choose a reply target; HAFleet routes your final response.',
    JSON.stringify(context),
    requested ? `\nCurrent request:\n${requested}` : '',
  ].join('\n');
}

function parseRpcLine(line: string): RpcMessage | null {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return null; }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') return null;
  return parsed as RpcMessage;
}

function writeLine(child: ChildProcessWithoutNullStreams, message: Readonly<Record<string, unknown>>): Promise<void> {
  if (!child.pid || child.killed || child.exitCode !== null || !child.stdin.writable) {
    return Promise.reject(new Error('verified child no longer owns a writable stdin channel'));
  }
  return new Promise<void>((resolve, reject) => {
    const pending: PendingWrite = { resolve, reject };
    child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) pending.reject(error);
      else pending.resolve();
    });
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); },
    );
  });
}

function hasPipedStreams(child: ChildProcess): child is ChildProcessWithoutNullStreams {
  return child.stdin !== null && child.stdout !== null && child.stderr !== null;
}

function spawnVerified(executable: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<ChildProcessWithoutNullStreams> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./runner-guardian.js', import.meta.url))], {
      cwd,
      env: {
        ...env,
        HAFLEET_GUARDIAN_EXECUTABLE: executable,
        HAFLEET_GUARDIAN_ARGS_JSON: JSON.stringify([...args]),
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    const onError = (error: Error): void => reject(error);
    child.once('error', onError);
    child.once('spawn', () => {
      const onExitBeforeReady = (code: number | null, signal: NodeJS.Signals | null): void => {
        reject(new Error(`runner guardian exited before runtime readiness: ${code ?? signal ?? 'unknown'}`));
      };
      child.once('exit', onExitBeforeReady);
      child.once('message', (message: unknown) => {
        if (
          message === null || typeof message !== 'object' || Array.isArray(message)
          || (message as { type?: unknown }).type !== 'runtime_ready'
        ) return;
        child.off('error', onError);
        child.off('exit', onExitBeforeReady);
        if (!hasPipedStreams(child) || !child.pid || !child.stdin.writable) {
          reject(new Error('spawned runner guardian has no verified input channel'));
          return;
        }
        // A failed pipe is reported to each guarded write callback. Keep the
        // stream's parallel error event from escaping as a process-level
        // uncaught exception after the child closes its read side.
        child.stdin.on('error', () => undefined);
        child.on('error', () => undefined);
        resolve(child);
      });
    });
  });
}

const terminationTimers = new WeakMap<ChildProcessWithoutNullStreams, NodeJS.Timeout>();

function terminateChild(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if (terminationTimers.has(child)) return;
  const timer = setTimeout(() => {
    terminationTimers.delete(child);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 2_000);
  timer.unref?.();
  terminationTimers.set(child, timer);
  child.once('exit', () => {
    const pending = terminationTimers.get(child);
    if (pending) clearTimeout(pending);
    terminationTimers.delete(child);
  });
}

function childExit(child: ChildProcessWithoutNullStreams): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function settleUnknown(router: RouterStore, claim: ClaimSuccess, reason: string): Promise<void> {
  const result = router.markOutcomeUnknown(claim.dispatchId, reason);
  if (!result.ok && result.code !== 'invalid_transition') throw refusalError(result);
}

function resultTextFromClaudeEvent(event: Readonly<Record<string, unknown>>): string | null {
  if (event.type !== 'result') return null;
  return typeof event.result === 'string' ? event.result : '';
}

export async function runClaudeDispatch(options: ClaudeRunnerOptions): Promise<RunnerCompletion> {
  const cwd = realpathSync(options.cwd);
  const acknowledgementTimeoutMs = options.acknowledgementTimeoutMs ?? 60_000;
  const executionTimeoutMs = options.executionTimeoutMs ?? 20 * 60_000;
  const child = await spawnVerified(
    options.executable ?? 'claude',
    options.args ?? ['-p', '--output-format', 'stream-json', '--verbose'],
    cwd,
    runnerEnv(options.claim, options.env),
  );
  const exitPromise = childExit(child);
  const abortChild = (): void => { terminateChild(child); };
  if (options.signal?.aborted) abortChild();
  options.signal?.addEventListener('abort', abortChild, { once: true });
  let started: StartedPayload | null = null;
  let finalText: string | null = null;
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-8_000); });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const parsed = parseRpcLine(line);
    if (parsed) {
      const text = resultTextFromClaudeEvent(parsed as Readonly<Record<string, unknown>>);
      if (text !== null) finalText = text;
    }
  });
  try {
    const taken = options.router.takePayload(capabilityInput(options.claim));
    if (!taken.ok) throw refusalError(taken);
    started = taken;
    const prompt = buildPrompt(taken);
    await withTimeout(new Promise<void>((resolve, reject) => {
      if (!child.pid || child.killed || child.exitCode !== null || !child.stdin.writable) {
        reject(new Error('verified Claude child lost stdin ownership before payload write'));
        return;
      }
      child.stdin.end(prompt, (error?: Error | null) => error ? reject(error) : resolve());
    }), acknowledgementTimeoutMs, 'Claude payload acknowledgement');
    const acknowledged = options.router.acknowledgeRunnerEffect(capabilityInput(options.claim));
    if (!acknowledged.ok) throw refusalError(acknowledged);
    const exit = await withTimeout(exitPromise, executionTimeoutMs, 'Claude dispatch');
    if (exit.code !== 0 || finalText === null) {
      await settleUnknown(options.router, options.claim, `claude_runner_exit:${exit.code ?? exit.signal ?? 'unknown'}:${stderr.slice(-500)}`);
      return { dispatchId: options.claim.dispatchId, state: 'outcome_unknown', text: finalText ?? '', exitCode: exit.code };
    }
    const settled = options.router.settleAndRelease({
      ...capabilityInput(options.claim),
      outcome: 'completed',
      output: { text: finalText },
    });
    if (!settled.ok) throw refusalError(settled);
    return { dispatchId: options.claim.dispatchId, state: 'completed', text: finalText, exitCode: exit.code };
  } catch (error) {
    terminateChild(child);
    if (started) await settleUnknown(options.router, options.claim, `claude_runner_error:${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abortChild);
  }
}

export async function runCodexDispatch(options: CodexRunnerOptions): Promise<RunnerCompletion> {
  const cwd = realpathSync(options.cwd);
  const acknowledgementTimeoutMs = options.acknowledgementTimeoutMs ?? 60_000;
  const executionTimeoutMs = options.executionTimeoutMs ?? 20 * 60_000;
  if (!Number.isFinite(options.approvalTimeoutMs) || options.approvalTimeoutMs <= 0) {
    throw new Error('Codex approval timeout must be a positive finite duration');
  }
  const approvalTimeoutMs = options.approvalTimeoutMs;
  const child = await spawnVerified(
    options.executable ?? 'codex',
    codexAppServerArgs(options),
    cwd,
    runnerEnv(options.claim, options.env),
  );
  const abortChild = (): void => { terminateChild(child); };
  if (options.signal?.aborted) abortChild();
  options.signal?.addEventListener('abort', abortChild, { once: true });
  const rpcResponses = new Map<string, {
    resolve: (message: RpcMessage) => void;
    reject: (error: Error) => void;
  }>();
  const rejectRpcResponses = (error: Error): void => {
    for (const pending of rpcResponses.values()) pending.reject(error);
    rpcResponses.clear();
  };
  let nextId = 1;
  let threadId = '';
  let turnId = '';
  let finalText = '';
  let started: StartedPayload | null = null;
  let terminal = false;
  let stderr = '';
  let resolveTurn: ((message: RpcMessage) => void) | null = null;
  let rejectTurn: ((error: Error) => void) | null = null;
  let resolveTurnIdentity: () => void = () => undefined;
  const turnIdentityReady = new Promise<void>((resolve) => { resolveTurnIdentity = resolve; });
  const turnCompletion = new Promise<RpcMessage>((resolve, reject) => {
    resolveTurn = resolve;
    rejectTurn = reject;
  });
  // The app-server can exit before execution reaches the later await. Attach a
  // handler immediately so an early exit cannot become a process-level
  // unhandled rejection; awaiting the original promise still observes it.
  void turnCompletion.catch(() => undefined);

  child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-8_000); });

  const request = async (method: string, params: Readonly<Record<string, unknown>>): Promise<RpcMessage> => {
    const id = String(nextId++);
    const response = new Promise<RpcMessage>((resolve, reject) => rpcResponses.set(id, { resolve, reject }));
    // A child may exit between promise creation and the guarded write. Make an
    // early RPC rejection observed immediately, while preserving rejection for
    // the caller that awaits the original promise.
    void response.catch(() => undefined);
    try {
      await writeLine(child, { id, method, params });
    } catch (error) {
      // No request reached the peer, so there is no response to settle. Removing
      // the orphan is safer than rejecting a promise the caller cannot yet own.
      rpcResponses.delete(id);
      throw error;
    }
    return response;
  };

  const answerApproval = async (message: RpcMessage): Promise<void> => {
    if (message.id === undefined || !message.method || !message.params) return;
    const params = message.params;
    const upstreamThreadId = typeof params.threadId === 'string' ? params.threadId : '';
    const upstreamTurnId = typeof params.turnId === 'string' ? params.turnId : '';
    const upstreamItemId = typeof params.itemId === 'string' ? params.itemId : '';
    const upstreamRequestId = String(message.id);
    if (!turnId && upstreamThreadId === threadId) {
      await withTimeout(turnIdentityReady, acknowledgementTimeoutMs, 'Codex turn identity');
    }
    if (!threadId || !turnId || upstreamThreadId !== threadId || upstreamTurnId !== turnId || !upstreamItemId) {
      await writeLine(child, { id: message.id, result: approvalResponse(message.method, 'deny', params) });
      return;
    }
    const kind = message.method === 'item/commandExecution/requestApproval'
      ? 'command'
      : message.method === 'item/fileChange/requestApproval'
        ? 'file_change'
        : 'permissions';
    const opDigest = operationDigest(message.method, params);
    const approvalId = `tss_${randomUUID()}`;
    const parked = options.router.parkForApproval({
      ...capabilityInput(options.claim),
      approvalId,
      operationDigest: opDigest,
      upstreamThreadId,
      upstreamTurnId,
      upstreamItemId,
      upstreamRequestId,
      maxParkedRunners: options.maxParkedRunners,
    });
    if (!parked.ok) {
      await writeLine(child, { id: message.id, result: approvalResponse(message.method, 'deny', params) });
      return;
    }
    try {
      const ownerRequest: OwnerApprovalRequest = {
        approvalId,
        dispatchId: options.claim.dispatchId,
        operationDigest: opDigest,
        framework: 'codex',
        kind,
        reason: typeof params.reason === 'string' ? params.reason : null,
        command: typeof params.command === 'string' ? params.command : null,
        cwd: typeof params.cwd === 'string' ? params.cwd : null,
        upstreamThreadId,
        upstreamTurnId,
        upstreamItemId,
        upstreamRequestId,
      };
      const verdict = await withTimeout(
        options.requestOwnerApproval(ownerRequest),
        approvalTimeoutMs,
        'owner approval',
      );
      const decisionEvent: ApprovalDecisionEvent = {
        decisionEventId: verdict.decisionEventId,
        approvalId,
        dispatchId: options.claim.dispatchId,
        operationDigest: opDigest,
        decision: verdict.decision,
      };
      const applied = options.router.recordApprovalDecision(decisionEvent);
      if (!applied.ok) throw refusalError(applied);
      const resumed = options.router.resumeAfterApproval({
        ...capabilityInput(options.claim),
        approvalId,
        operationDigest: opDigest,
      });
      if (!resumed.ok) throw refusalError(resumed);
      await writeLine(child, {
        id: message.id,
        result: approvalResponse(message.method, resumed.decision, params),
      });
    } catch (error) {
      await writeLine(child, { id: message.id, result: approvalResponse(message.method, 'deny', params) }).catch(() => undefined);
      terminal = true;
      terminateChild(child);
      await settleUnknown(options.router, options.claim, `approval_transport_failed:${error instanceof Error ? error.message : String(error)}`);
      rejectTurn?.(error instanceof Error ? error : new Error(String(error)));
    }
  };

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const message = parseRpcLine(line);
    if (!message) return;
    if (message.id !== undefined && !message.method) {
      const pending = rpcResponses.get(String(message.id));
      if (pending) {
        rpcResponses.delete(String(message.id));
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message);
      }
      return;
    }
    if (
      message.method === 'item/commandExecution/requestApproval'
      || message.method === 'item/fileChange/requestApproval'
      || message.method === 'item/permissions/requestApproval'
    ) {
      void answerApproval(message);
      return;
    }
    if (message.method === 'item/completed') {
      const item = message.params?.item;
      if (item !== null && !Array.isArray(item) && typeof item === 'object') {
        const record = item as Readonly<Record<string, unknown>>;
        if (record.type === 'agentMessage' && record.phase === 'final_answer' && typeof record.text === 'string') {
          finalText = record.text;
        }
      }
    }
    if (message.method === 'turn/completed') resolveTurn?.(message);
    if (message.method === 'error') rejectTurn?.(new Error(JSON.stringify(message.params ?? {})));
  });

  child.once('exit', (code, signal) => {
    if (!terminal) {
      const error = new Error(`Codex app-server exited ${code ?? signal ?? 'unknown'}`);
      rejectRpcResponses(error);
      rejectTurn?.(error);
    }
  });

  try {
    const initialized = await withTimeout(request('initialize', {
      clientInfo: { name: 'hafleet', title: 'HAFleet runner', version: '1.0.0' },
    }), acknowledgementTimeoutMs, 'Codex initialize');
    if (!initialized.result) throw new Error('Codex initialize returned no result');
    await writeLine(child, { method: 'initialized', params: {} });
    // The thread-level sandbox is the one that actually governs writes; it MUST
    // follow the lease, not just the per-turn policy below. A front-desk
    // dispatch (no lease) is read-only at BOTH levels so a writable turn policy
    // can never be reached over a read-only thread and vice versa.
    //
    // thread/start's `sandbox` is a SandboxMode STRING and uses kebab-case
    // (`read-only` / `workspace-write`), verified against the real codex
    // app-server JSON schema. This differs from turn/start's `sandboxPolicy`,
    // which is an object whose `type` is camelCase (`readOnly` / `workspaceWrite`)
    // — do not unify the two spellings; the CLI rejects the wrong one.
    const thread = await withTimeout(request('thread/start', {
      cwd,
      ephemeral: true,
      approvalPolicy: 'on-request',
      sandbox: options.mayWrite ? 'workspace-write' : 'read-only',
      serviceName: 'hafleet',
      ...(options.model ? { model: options.model } : {}),
    }), acknowledgementTimeoutMs, 'Codex thread start');
    const threadObject = thread.result?.thread;
    if (threadObject === null || Array.isArray(threadObject) || typeof threadObject !== 'object') {
      throw new Error('Codex thread start returned no thread');
    }
    const parsedThread = threadObject as Readonly<Record<string, unknown>>;
    if (typeof parsedThread.id !== 'string') throw new Error('Codex thread id is absent');
    threadId = parsedThread.id;
    const taken = options.router.takePayload(capabilityInput(options.claim));
    if (!taken.ok) throw refusalError(taken);
    started = taken;
    const turnResponsePromise = request('turn/start', {
      threadId,
      input: [{ type: 'text', text: buildPrompt(taken) }],
      cwd,
      approvalPolicy: 'on-request',
      // Only a dispatch that holds the workspace lease gets a writable
      // sandbox. Without the lease its writes would be neither serialized
      // against other runners nor recorded as dirt on an unknown outcome, so
      // a front-desk turn is confined to reading.
      sandboxPolicy: options.mayWrite
        ? { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false }
        : { type: 'readOnly' },
      ...(options.effort ? { effort: options.effort } : {}),
    });
    const turnResponse = await withTimeout(turnResponsePromise, acknowledgementTimeoutMs, 'Codex turn start');
    const turnObject = turnResponse.result?.turn;
    if (turnObject === null || Array.isArray(turnObject) || typeof turnObject !== 'object') {
      throw new Error('Codex turn start returned no turn');
    }
    const parsedTurn = turnObject as Readonly<Record<string, unknown>>;
    if (typeof parsedTurn.id !== 'string') throw new Error('Codex turn id is absent');
    turnId = parsedTurn.id;
    resolveTurnIdentity();
    const acknowledged = options.router.acknowledgeRunnerEffect(capabilityInput(options.claim));
    if (!acknowledged.ok) throw refusalError(acknowledged);
    const completed = await withTimeout(turnCompletion, executionTimeoutMs, 'Codex turn');
    const completedTurn = completed.params?.turn;
    const completedStatus = completedTurn !== null && !Array.isArray(completedTurn) && typeof completedTurn === 'object'
      ? (completedTurn as Readonly<Record<string, unknown>>).status
      : null;
    if (completedStatus !== 'completed') throw new Error(`Codex turn ended with ${String(completedStatus)}`);
    const settled = options.router.settleAndRelease({
      ...capabilityInput(options.claim),
      outcome: 'completed',
      output: { text: finalText },
    });
    if (!settled.ok) throw refusalError(settled);
    terminal = true;
    terminateChild(child);
    return { dispatchId: options.claim.dispatchId, state: 'completed', text: finalText, exitCode: 0 };
  } catch (error) {
    terminal = true;
    terminateChild(child);
    rejectRpcResponses(new Error('Codex runner terminated'));
    if (started) await settleUnknown(options.router, options.claim, `codex_runner_error:${error instanceof Error ? error.message : String(error)}:${stderr.slice(-500)}`);
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abortChild);
  }
}

function approvalResponse(
  method: string,
  decision: 'allow' | 'deny',
  params: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (method === 'item/permissions/requestApproval') {
    const requested = params.permissions;
    const permissions = decision === 'allow' && requested !== null && typeof requested === 'object'
      ? requested
      : {};
    return { permissions, scope: 'turn' };
  }
  return { decision: decision === 'allow' ? 'accept' : 'decline' };
}

export function isCompletedSettlement(result: SettleSuccess | Refusal): result is SettleSuccess {
  return result.ok && result.state === 'completed';
}
