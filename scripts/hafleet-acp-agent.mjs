#!/usr/bin/env node
/**
 * Long-lived host for one paneless ACP agent.
 *
 * A tmux agent stays alive because tmux keeps its pane; an ACP agent stays alive
 * only while something holds its session open. This process is that something:
 * it opens the ACP session, keeps the child alive, and exits when the session
 * does — so the pid recorded at registration is an honest liveness signal for
 * the backend sweep.
 *
 * It also owns delivery, because it owns the session. The backend cannot deliver
 * to an ACP agent the way it does to a tmux one — there is no pane to type into,
 * and the session lives in this process, which the backend cannot reach into. So
 * the direction is inverted: the backend records the message and this host pulls,
 * polling the same inbox endpoint check_inbox uses and prompting the agent over
 * session/prompt.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateOutboxRequest } from '../lib/acp-outbox.js';
import { anyReplyable, buildReplyHint } from '../lib/reply-hint.js';
import { codexPermissionRequestNeedsOwnerApproval } from '../lib/codex-permission-hook.js';
import { buildSummary } from '../lib/message-summary.js';
import { createAcpRuntime } from '../lib/runtime/acp.js';
import { getFramework } from '../lib/frameworks/index.js';

const args = process.argv.slice(2);
const read = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};
const name = read('--name');
const workspace = read('--workspace');
const frameworkId = read('--framework');
const model = read('--model');
const provider = read('--provider');
if (!name || !workspace || !frameworkId) {
  process.stderr.write('usage: hafleet-acp-agent.mjs --name <n> --workspace <dir> --framework <id> '
    + '[--model <m>] [--provider <p>]\n');
  process.exit(2);
}

const framework = getFramework(frameworkId);
if (!framework) { process.stderr.write(`unknown framework: ${frameworkId}\n`); process.exit(2); }
if (framework.transport !== 'acp') {
  process.stderr.write(`${frameworkId} is not an ACP framework (transport=${framework.transport})\n`);
  process.exit(2);
}

const acpArgs = [...(framework.launch.acpArgs ?? ['acp'])];
// launch.modelFlag describes the framework's own CLI, which is a different surface
// from its ACP entry point: octos acp takes --model, hermes-acp dies on it, and
// codex-acp accepts it and ignores it. Using the CLI's flag here made --model
// fatal for one adapter and a silent no-op for another, so the ACP flag is
// declared separately and a model with nowhere to go is an error rather than a
// guess. Refusing beats pretending the model was applied.
if (model) {
  const flag = framework.launch.acpModelFlag ?? null;
  if (!flag) {
    process.stderr.write(`${frameworkId} takes no model flag over ACP; --model ${model} would be `
      + `${frameworkId === 'hermes' ? 'fatal' : 'silently ignored'}. Select the model in the agent itself.\n`);
    process.exit(2);
  }
  acpArgs.push(flag, model);
}

/*
 * THE PROVIDER IS NOT IMPLIED BY THE MODEL, and leaving it out is not a smaller
 * request — it is a different one.
 *
 * octos resolves the provider from its own config when none is given, so launching
 * with `--model kimi-k3` against a config naming `deepseek` built a deepseek client
 * and died on `DEEPSEEK_API_KEY not set`. The preset said `moonshot` the whole time,
 * and every surface the operator could see agreed with the preset. Only the process
 * disagreed, and only on a host whose octos config differed from the developer's.
 *
 * Same refusal as the model above: an adapter with nowhere to put it is an error,
 * not a silent drop.
 */
if (provider) {
  const flag = framework.launch.acpProviderFlag ?? null;
  if (!flag) {
    process.stderr.write(`${frameworkId} takes no provider flag over ACP; --provider ${provider} `
      + 'would be silently ignored. Configure the provider in the agent itself.\n');
    process.exit(2);
  }
  acpArgs.push(flag, provider);
}

const log = (message) => process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);

// ── Backend access ────────────────────────────────────────────────────────────
// Same layout hafleet-acp-up provisions the token into.
const HOME_DIR = process.env.HAFLEET_HOMEDIR || path.join(os.homedir(), '.hafleet');
const STATE_DIR = process.env.HAFLEET_AGENT_STATE_DIR
  || path.join(HOME_DIR, 'agents', `agent_${name}`, 'state');
const BACKEND_PORT = process.env.HAFLEET_BACKEND_PORT || '8090';
const API = (process.env.HAFLEET_API || `http://127.0.0.1:${BACKEND_PORT}`).replace(/\/$/, '');
const MCP_SERVER_NAME = process.env.HAFLEET_MCP_SERVER_NAME || 'hafleet';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let agentToken = '';
try {
  agentToken = readFileSync(path.join(STATE_DIR, 'agent-token'), 'utf8').trim();
} catch {
  // Delivery needs the token; liveness does not. Warn rather than refuse to
  // start, so a session already open is not lost over a missing file.
  log(`WARNING: no agent token at ${STATE_DIR}/agent-token — inbox polling disabled`);
}

async function api(pathname, { method = 'GET', body = null } = {}) {
  const response = await fetch(`${API}${pathname}`, {
    method,
    headers: {
      'X-Agent-Token': agentToken,
      Authorization: `Bearer ${agentToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`${method} ${pathname} -> ${response.status}`);
  return response.json();
}


/**
 * HAFleet's own MCP server, handed to the agent at session/new.
 *
 * Without this the agent can be prompted but cannot read its inbox or reply — it
 * would be a spectator, unlike the tmux agents that reach the same tools through
 * .mcp.json. ACP passes env as {name,value} pairs rather than an object.
 */
const mcpServers = agentToken ? [{
  name: MCP_SERVER_NAME,
  command: process.execPath,
  args: [path.join(REPO_ROOT, 'mcp-server.js')],
  env: [
    { name: 'AGENT_NAME', value: name },
    { name: 'HAFLEET_API', value: API },
    { name: 'HAFLEET_BACKEND_PORT', value: String(BACKEND_PORT) },
    { name: 'HAFLEET_MCP_SERVER_NAME', value: MCP_SERVER_NAME },
    { name: 'HAFLEET_AGENT_STATE_DIR', value: STATE_DIR },
  ],
}] : [];

/**
 * Answer session/request_permission.
 *
 * codex-acp asks the client before running an MCP tool, and a client that does
 * not answer is not merely impolite: the agent blocks until something times out.
 * Every turn that touched an MCP tool died at the 600s prompt timeout with no
 * output, which reads as a hung model rather than an unanswered request.
 *
 * The decision reuses the rule the tmux path already applies via the Codex
 * permission hook, so an agent gets the same answer on either transport. That
 * rule allows HAFleet's own coordination tools — reading an inbox is not shell
 * access — and refers everything else for approval, which here means declining.
 * send_message carrying attachments is refused, because it can exfiltrate a file.
 */
function decidePermission({ server, tool, options, title, input }) {
  // Only ever approve our own MCP server's tools. Anything whose identity we
  // could not establish from the tool_call update is declined, not guessed at.
  if (!server || server !== MCP_SERVER_NAME || !tool) {
    log(`declining a permission request we cannot identify (${title ?? 'unknown tool'})`);
    return null;
  }
  const qualified = `mcp__${MCP_SERVER_NAME.replace(/-/g, '_')}__${tool}`;
  // The arguments must go too. send_message and post are allowlisted only while
  // they carry no attachments, so the hook inspects tool_input — and treats a
  // missing one as "cannot tell, refer for approval". Omitting it declined every
  // reply with "not a trusted coordination tool", which is the opposite of what
  // the allowlist says: the agent read its inbox, composed "PARITY", and was then
  // refused permission to send it.
  if (codexPermissionRequestNeedsOwnerApproval({ tool_name: qualified, tool_input: input ?? {} })) {
    log(`declining ${qualified}: needs owner approval (attachments, or not allowlisted)`);
    return null;
  }
  // allow_once, deliberately: never allow_always. A per-call decision keeps the
  // policy in force for the rest of the session instead of widening it once.
  const once = options.find((o) => o.kind === 'allow_once') ?? options.find((o) => o.optionId === 'allow_once');
  if (!once) {
    log(`no allow_once option offered for ${qualified}; declining rather than allowing always`);
    return null;
  }
  return once.optionId;
}

const runtime = createAcpRuntime({
  command: framework.launch.command,
  args: acpArgs,
  decidePermission,
  // Declared per adapter: octos takes --cwd, hermes-acp rejects it.
  cwdFlag: framework.launch.acpCwdFlag ?? null,
  // The agent's own diagnostics. Noisy lines are worth it: this is the only
  // channel where a paneless agent can tell an operator what went wrong.
  onStderr: (_agent, line) => log(`  [${frameworkId}] ${line.slice(0, 300)}`),
});
if (!(await runtime.isAvailable())) {
  process.stderr.write(`${framework.launch.command} is not available on PATH\n`);
  process.exit(1);
}

// Where the ACP session id is remembered between runs.
//
// Without this the host called session/new on every start, so even an agent that
// can restore a conversation was handed a blank one — the supervisor would bring
// an agent back promptly and it would have forgotten what it was doing. Kept
// beside the agent token in the state dir, which already survives restarts and is
// mode 0700.
const SESSION_ID_FILE = path.join(STATE_DIR, 'acp-session-id');

/**
 * Values that are not session ids but survive `${id}` interpolation. Writing a
 * null id produced the six-character string "null", which reads back as a
 * perfectly truthy id and was then sent to session/load. hermes answered with a
 * warning rather than an error, so the resume looked like it worked and the agent
 * came up with sessionId "null".
 */
const NOT_AN_ID = new Set(['null', 'undefined', 'NaN', '']);

/** True when a value can be used, stored, or sent as a session id. */
export function isUsableSessionId(id) {
  return typeof id === 'string' && !NOT_AN_ID.has(id.trim());
}

function rememberSessionId(id) {
  if (!isUsableSessionId(id)) {
    // Nothing to remember. Leaving the previous id alone is right: a failed start
    // should not erase a good session from an earlier one.
    log(`not storing an unusable session id (${JSON.stringify(id)}); keeping any previous one`);
    return;
  }
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(SESSION_ID_FILE, `${id}\n`, { mode: 0o600 });
  } catch (error) {
    // Not fatal: the session works, it just will not be resumable next time.
    log(`could not remember the session id (${error.message}); the next start will begin fresh`);
  }
}

function recallSessionId() {
  try {
    if (!existsSync(SESSION_ID_FILE)) return null;
    const id = readFileSync(SESSION_ID_FILE, 'utf8').trim();
    if (!isUsableSessionId(id)) {
      // An id poisoned by an older build. Start fresh rather than resuming nothing.
      log(`ignoring a stored session id that is not one (${JSON.stringify(id)})`);
      return null;
    }
    return id;
  } catch {
    return null;
  }
}

/**
 * Report why a session could not be opened, and stop.
 *
 * The JSON-RPC `data` field is where an agent puts the actual reason — a bare
 * `${error.data}` printed "[object Object]" and threw away the only useful part.
 * That is how a hermes start that failed for want of a model provider looked
 * identical to every other Internal error.
 */
function failToOpen(error) {
  const detail = error?.data === undefined || error?.data === null
    ? ''
    : typeof error.data === 'string' ? error.data : JSON.stringify(error.data, null, 2);
  process.stderr.write(`failed to open an ACP session: ${error?.message ?? error}\n${detail ? `${detail}\n` : ''}`);
  process.exit(1);
}

const cwd = path.resolve(workspace);
let sessionId;
let mcpAttached = false;
try {
  sessionId = await runtime.startSession(name, {
    cwd,
    mcpServers,
    resumeSessionId: recallSessionId(),
  });
  mcpAttached = mcpServers.length > 0;
} catch (error) {
  // octos 2.0.2's ACP v1 advertises no session capabilities, and its handling of
  // mcpServers is unverified. Rather than lose a working agent to a rejected
  // field, fall back to a plain session: delivery still works, the agent just
  // cannot reply through MCP. Say so plainly instead of degrading silently.
  if (mcpServers.length > 0) {
    log(`session/new with mcpServers failed (${error.message}); retrying without — the agent will receive prompts but cannot reply via MCP`);
    try {
      sessionId = await runtime.startSession(name, { cwd });
    } catch (retryError) {
      failToOpen(retryError);
    }
  } else {
    failToOpen(error);
  }
}
// "requested", not "attached": session/new accepting the field does not mean the
// agent honoured it. octos 2.0.2 accepts mcpServers and silently ignores it —
// claude and codex each spawn an mcp-server.js child, octos spawns none. Saying
// mcp=hafleet here read as a working tool channel that did not exist.
const origin = runtime.sessionOrigin(name);
rememberSessionId(sessionId);
// Say which happened. A resumed session and a fresh one look identical from the
// outside, and "the agent forgot everything" is exactly the failure this is meant
// to prevent — so it must not be silent when it still occurs.
if (origin.resumed) {
  log(`acp session RESUMED: ${sessionId} (${frameworkId}, cwd=${cwd}, mcp-requested=${mcpAttached ? MCP_SERVER_NAME : 'none'})`);
} else {
  const why = origin.loadError
    ? ` (could not resume: ${origin.loadError})`
    : (origin.canLoad ? ' (no stored session to resume)' : ' (agent cannot resume sessions)');
  log(`acp session open: ${sessionId} (${frameworkId}, cwd=${cwd}, mcp-requested=${mcpAttached ? MCP_SERVER_NAME : 'none'})${why}`);
}

// Register with the backend from here, because this is the process that knows its
// own pid.
//
// bin/hafleet-acp-up registered on the operator's behalf, which is correct only
// for the detached path. Under the supervisor the host is spawned directly, so
// acp-up never runs: the backend kept probing the pid from whichever host started
// the agent first and reported acp-process-gone forever after the first restart.
// Seen on a real host as acpPid=73908 against a live pid of 5832 — the supervisor
// was faithfully restarting an agent the dashboard insisted was dead.
async function registerWithBackend() {
  if (!agentToken) return;
  try {
    await api('/api/agents', {
      method: 'POST',
      body: {
        name,
        type: frameworkId,
        transport: 'acp',
        acpPid: process.pid,
        server: process.env.HAFLEET_SERVER || os.hostname(),
      },
    });
    log(`registered with the backend (acp, pid ${process.pid})`);
  } catch (error) {
    // Not fatal: the session is open and delivery pulls from the inbox anyway.
    // The agent will read as offline until something re-registers it, so say so.
    log(`WARNING: backend registration failed (${error.message}); the fleet will show this agent offline`);
  }
}
await registerWithBackend();

const shutdown = (signal) => {
  log(`received ${signal}, closing the acp session`);
  runtime.stopAll();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ── Activity ──────────────────────────────────────────────────────────────────
//
// A tmux agent's activity is inferred by hashing its pane each sweep: changed
// pixels mean it did something. An ACP agent has no pane, so the sweep's ACP
// branch does liveness only and the activity fields stay null — the dashboard
// showed idleMs=-1 and lastTmuxActivitySec=0 while claude and codex had real
// numbers. A hung octos and a healthy idle octos looked identical to the fleet.
//
// The signal already existed and was simply never wired up: the runtime counts
// every session/update notification it receives. Reporting that is strictly
// better than a pane hash, because a hash also fires on a spinner, a clock or a
// redraw, whereas an update means the agent actually emitted a token, a tool call
// or a status change. A wedged ACP agent stops emitting; a wedged TUI can keep
// animating forever.
//
// lastTmuxActivitySec is a tmux-flavoured name for a transport-neutral idea. It is
// what the dashboard already reads, so it is reused rather than adding a parallel
// field the UI would have to learn.
let lastUpdateCount = 0;
let lastActivityMs = Date.now();

async function reportActivity() {
  if (!agentToken) return;
  const seen = runtime.updateCursor(name);
  if (seen > lastUpdateCount) {
    lastUpdateCount = seen;
    lastActivityMs = Date.now();
  }
  try {
    await api(`/api/agents/${encodeURIComponent(name)}/runtime`, {
      method: 'POST',
      body: {
        // Declared so the backend never conjures a tmux target for this agent if
        // its record has gone missing.
        transport: 'acp',
        /*
         * THE WORKSPACE IS THE ONLY LINK BETWEEN AN AGENT AND ITS TOKEN USAGE.
         *
         * The coding CLIs record their own consumption — Claude Code writes a per-message
         * `usage` object under `~/.claude/projects/<slugified-cwd>/`, Codex writes
         * `total_token_usage` alongside a `session_meta.cwd` — and the working directory
         * is what ties either back to an agent. HAFleet launches the agent knowing that
         * directory and discarded it: `workspacePath` was null on every ACP
         * agent, so nothing downstream could attribute a token to anyone.
         *
         * A tmux agent already reports this via the MCP server (lib/mcp-server-core.js:274).
         * An ACP agent has no such path — octos ignores `mcpServers` on session/new in v1 —
         * so the host reports it directly.
         */
        workspacePath: cwd,
        activeNow: turnInFlight,
        idleDurationSec: Math.max(0, Math.floor((Date.now() - lastActivityMs) / 1000)),
        lastTmuxActivitySec: Math.floor(lastActivityMs / 1000),
        command: framework.launch.command,
        // This host cannot see whether the agent is waiting on anything: octos
        // surfaces tool calls but does not block on ACP permission requests. Say
        // "not observed" rather than asserting it is unblocked.
        blockedObserved: false,
      },
    });
  } catch (error) {
    // Reporting is telemetry. A backend blip must not disturb a working session.
    log(`activity report failed: ${error.message}`);
  }
}

// ── Delivery ──────────────────────────────────────────────────────────────────

// ── Outbox ────────────────────────────────────────────────────────────────────
//
// How an ACP agent initiates anything at all.
//
// A tmux agent calls HAFleet's MCP tools directly. octos 2.0.2 cannot: it accepts
// the mcpServers field on session/new and ignores it, its config has no MCP
// section, and `octos mcp` only does OAuth login for remote servers. Its shell
// cannot substitute either — the sandbox is network-isolated, verified on mini5
// where `nc -z 127.0.0.1 8090` reports PORT_CLOSED while the backend is plainly
// listening there.
//
// What it can do is write files in its workspace. So that is the channel: the
// agent drops a JSON file, the host validates it and performs the action against
// the API. Deliberate, agent-initiated, and using the only capability it has.
//
// This is narrower than the MCP surface on purpose. Two verbs, both messaging.
// Anything that mutates task state or approvals stays out until an ACP agent can
// be authenticated as itself rather than trusted because it wrote to a directory.
const outboxDir = path.join(path.resolve(workspace), '.hafleet', 'outbox');

async function drainOutbox() {
  if (!agentToken) return;
  let entries;
  try {
    entries = readdirSync(outboxDir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return; // the agent has not created it; nothing to do
  }
  if (!entries.length) return;
  mkdirSync(path.join(outboxDir, 'sent'), { recursive: true });
  mkdirSync(path.join(outboxDir, 'rejected'), { recursive: true });

  for (const file of entries) {
    const source = path.join(outboxDir, file);
    let request;
    try {
      request = JSON.parse(readFileSync(source, 'utf8'));
    } catch (error) {
      // Move it aside rather than retrying forever, and leave the reason next to
      // it so the agent can see what it got wrong.
      writeFileSync(`${source}.error`, `unparseable JSON: ${error.message}\n`);
      renameSync(source, path.join(outboxDir, 'rejected', file));
      log(`  outbox ${file}: unparseable JSON`);
      continue;
    }
    const problem = validateOutboxRequest(request);
    if (problem) {
      writeFileSync(`${source}.error`, `${problem}\n`);
      renameSync(source, path.join(outboxDir, 'rejected', file));
      log(`  outbox ${file}: ${problem}`);
      continue;
    }
    const full = String(request.full || request.summary);
    const body = {
      from: name,
      type: request.type === 'request' ? 'request' : 'inform',
      summary: buildSummary(request.summary || full),
      full,
      ...(request.reply_to ? { reply_to: request.reply_to } : {}),
      ...((request.action || 'send_message') === 'post'
        ? { group: request.group }
        : { to: request.to }),
    };
    try {
      await api('/api/messages', { method: 'POST', body });
      renameSync(source, path.join(outboxDir, 'sent', file));
      log(`  outbox ${file}: sent to ${request.to || `group ${request.group}`}`);
    } catch (error) {
      // The backend refused it. Rejecting is right: retrying a message the
      // backend will not take just repeats the failure every five seconds.
      writeFileSync(`${source}.error`, `${error.message}\n`);
      renameSync(source, path.join(outboxDir, 'rejected', file));
      log(`  outbox ${file}: rejected — ${error.message}`);
    }
  }
}


/** Tracks the backlog size already nudged for, so an agent that ignores a nudge is
 * not re-prompted every five seconds. Reset when the inbox drains. */
let lastNudgedCount = 0;

/**
 * What a tmux agent sees typed into its pane: who is waiting, and an instruction
 * to fetch the detail itself. Deliberately carries no message bodies — the point
 * of the change is that the agent reads its own inbox.
 */
function buildNudge(pending, messages) {
  const senders = [...new Set(messages.map((m) => m && m.from).filter(Boolean))];
  const lines = [
    `You have ${pending} unread message(s)${senders.length ? ` from ${senders.join(', ')}` : ''}.`,
    '',
    `FIRST ACTION: call check_inbox() now. Use check_inbox() in ${MCP_SERVER_NAME} MCP for full context before acting.`,
  ];
  // Only ask for a reply when one is actually wanted. A `task` is work to do; a
  // `human` or `request` is someone waiting. This host used to instruct a reply
  // unconditionally, so the same `hafleet tell` produced silence from claude and
  // codex and a message from octos — verified by sending one task to all three:
  // all answered "Au", only octos posted it. The rule now comes from the same
  // module the tmux path uses, so the two cannot drift again.
  const replyable = messages.filter((m) => m && anyReplyable([m]));
  for (const msg of replyable.slice(0, 3)) {
    const hint = buildReplyHint(msg, null, MCP_SERVER_NAME);
    if (hint) lines.push(hint);
  }
  // The workspace outbox is deliberately not advertised: the agent has
  // send_message, and offering two ways to reply got both used.
  return lines.join('\n');
}


// One ACP turn at a time. session/prompt is a turn, not a queue, so overlapping
// prompts would interleave; a long turn simply defers the next poll.
let turnInFlight = false;
let deliveredCount = 0;

/**
 * Replace a session that has stopped answering.
 *
 * Bounded on purpose. Recycling is the automated form of the manual restart that
 * is known to fix this, but a session that will not come back must not be retried
 * forever — after a few attempts the whole host exits so the supervisor restarts
 * it, which is the heavier hammer that definitely works.
 */
let consecutiveRecycles = 0;
const MAX_CONSECUTIVE_RECYCLES = 3;

async function recycleSession() {
  consecutiveRecycles += 1;
  if (consecutiveRecycles > MAX_CONSECUTIVE_RECYCLES) {
    log(`session unusable after ${MAX_CONSECUTIVE_RECYCLES} recycle attempts; exiting so the supervisor restarts this host`);
    process.exit(1);
  }
  log(`recycling the ACP session (attempt ${consecutiveRecycles}/${MAX_CONSECUTIVE_RECYCLES})`);
  try {
    runtime.stop(name);
  } catch (error) {
    log(`  could not stop the old session cleanly (${error.message}); continuing`);
  }
  try {
    // Resume from the stored id so context is not lost just because the transport
    // had to be rebuilt. A fresh session is still better than a dead one.
    const resumed = await runtime.startSession(name, {
      cwd, mcpServers, resumeSessionId: recallSessionId(),
    });
    rememberSessionId(resumed);
    log(`  session replaced: ${resumed}`);
    return true;
  } catch (error) {
    log(`  could not reopen a session (${error.message})`);
    return false;
  }
}

async function pollAndDeliver() {
  if (!agentToken) return;
  // Before the early return: an agent mid-turn is exactly when the fleet most
  // needs to see it is alive.
  await reportActivity();
  if (turnInFlight) return;
  // Before the inbox: the agent may have written something during the last turn,
  // and it should go out even if nobody is messaging it.
  await drainOutbox();

  // unread-list rather than unread: it returns the messages, so the nudge can see
  // their types and ask for a reply only when one is wanted. Neither endpoint
  // advances the inbox cursor — the agent's own check_inbox does.
  let snapshot;
  try {
    snapshot = await api(`/api/inbox/${encodeURIComponent(name)}/unread-list`);
  } catch (error) {
    log(`inbox poll failed: ${error.message}`);
    return;
  }
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  const pending = Number(snapshot?.unread_total ?? messages.length ?? 0);
  if (!pending) { lastNudgedCount = 0; return; }

  // Nudge, do not deliver.
  //
  // This host used to read the inbox itself and paste the message bodies into the
  // prompt. That was right when octos had no way to reach HAFleet, and wrong once
  // it did: the unfiltered read advances the cursor, so by the time the agent ran
  // check_inbox the host had already consumed its mail and it saw NONE — verified
  // live. It also left octos on a different contract from claude and codex, which
  // get a summary plus "call check_inbox for full context" and fetch their own.
  //
  // The /unread probe deliberately does NOT advance the cursor. The agent's own
  // check_inbox does, which is what makes the read an acknowledgement.
  if (pending === lastNudgedCount) return;   // already nudged for this backlog

  turnInFlight = true;
  try {
    lastNudgedCount = pending;
    log(`nudging: ${pending} unread`);
    const cursor = runtime.updateCursor(name);
    const stopReason = await runtime.prompt(name, buildNudge(pending, messages));
    log(`turn finished (${stopReason})`);
    // Only CONSECUTIVE failures should escalate to a host restart. Without this the
    // counter is a lifetime total and three unrelated timeouts days apart would take
    // the agent down.
    consecutiveRecycles = 0;
    if (!stopReason) {
      // The state the session was in immediately before it wedged. Worth naming
      // rather than logging as if it were a normal ending.
      log('  stopReason was null — the turn did not end cleanly');
    }

    // Record what the agent said and which tools it used. Without this a turn that
    // ends in 'end_turn' having done nothing is indistinguishable from one that did
    // the work, and there is no pane to read back.
    //
    // agent_message_chunk is emitted per token, so the chunks must be joined before
    // they mean anything — logging each produced a column of word fragments.
    let said = '';
    const tools = [];
    for (const { update } of runtime.updatesSince(name, cursor)) {
      const kind = update?.sessionUpdate;
      if (kind === 'agent_message_chunk') {
        said += update.content?.text || '';
      } else if (kind === 'tool_call' || kind === 'tool_call_update') {
        const entry = `${update.title || update.kind || 'call'}${update.status ? ` [${update.status}]` : ''}`;
        if (tools.at(-1) !== entry) tools.push(entry);
      }
    }
    if (tools.length) log(`  tools: ${tools.slice(0, 12).join(', ')}`);
    const reply = said.replace(/\s+/g, ' ').trim();
    if (reply) log(`  agent: ${reply.slice(0, 600)}${reply.length > 600 ? '…' : ''}`);

    // No reply is posted from here any more. The agent has send_message and the
    // workspace outbox, and posting the turn text as well produced two messages
    // for one answer. Whether to respond is the agent's judgement, exactly as it
    // is for claude and codex.
    await drainOutbox();
  } catch (error) {
    const detail = error?.data === undefined || error?.data === null
      ? ''
      : typeof error.data === 'string' ? error.data : JSON.stringify(error.data);
    log(`delivery failed: ${error.message}${detail ? ` — ${detail}` : ''}`);
    // A prompt that timed out means the session stopped answering, and nothing here
    // used to do anything about it: the session stayed in place, so every later
    // nudge hung for another 600s and the agent was useless until someone restarted
    // it by hand. That is exactly what happened to codex-acp-agent — one turn ended
    // with stopReason null and an unfinished tool call, and the next delivery ten
    // hours later timed out. A manual restart fixed it instantly, which is the
    // clue: the session was dead, not the agent.
    if (/timed out/.test(error.message || '')) await recycleSession();
  } finally {
    turnInFlight = false;
  }
}

// Hold the process open and notice if the agent dies underneath us: the backend
// reads this pid, so exiting quietly would leave the fleet reporting a live
// agent that is gone.
const interval = setInterval(async () => {
  if (!(await runtime.sessionExists(name))) {
    log('acp session ended; exiting so the backend stops reporting this agent as live');
    clearInterval(interval);
    process.exit(1);
  }
  await pollAndDeliver();
}, 5000);
