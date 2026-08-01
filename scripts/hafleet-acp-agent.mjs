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
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { OUTBOX_PROTOCOL, validateOutboxRequest } from '../lib/acp-outbox.js';
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
if (!name || !workspace || !frameworkId) {
  process.stderr.write('usage: hafleet-acp-agent.mjs --name <n> --workspace <dir> --framework <id> [--model <m>]\n');
  process.exit(2);
}

const framework = getFramework(frameworkId);
if (!framework) { process.stderr.write(`unknown framework: ${frameworkId}\n`); process.exit(2); }
if (framework.transport !== 'acp') {
  process.stderr.write(`${frameworkId} is not an ACP framework (transport=${framework.transport})\n`);
  process.exit(2);
}

const acpArgs = [...(framework.launch.acpArgs ?? ['acp'])];
if (model && framework.launch.modelFlag) acpArgs.push(framework.launch.modelFlag, model);

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
 * Post the agent's answer back into HAFleet, as the agent.
 *
 * A tmux agent replies itself, by calling the hafleet MCP tool send_message. An
 * ACP agent cannot: octos 2.0.2 accepts the mcpServers field on session/new and
 * silently ignores it — verified on mini5, where claude and codex each spawned an
 * mcp-server.js child and octos spawned none. Its `octos mcp` subcommand only does
 * OAuth login for remote servers, and its config.json has no MCP section at all.
 * There is no way to hand it the tools.
 *
 * So the host speaks for it. That is a real difference in kind and worth naming:
 * a tmux agent decides when it has something to say, whereas this posts the result
 * of every turn that produced text. It is a relay, not agency.
 */
async function postReply({ to, replyTo, text }) {
  const body = text.trim();
  if (!body) return;
  // Same rule as `hafleet tell`, shared rather than reimplemented: the summary is
  // what a reader sees, so cutting it mid-word turns a reply into a wrong reply.
  const summary = buildSummary(body);
  await api('/api/messages', {
    method: 'POST',
    body: { from: name, to, type: 'inform', summary, full: body, reply_to: replyTo },
  });
  log(`  replied to ${to} (reply_to=${replyTo})`);
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

const runtime = createAcpRuntime({ command: framework.launch.command, args: acpArgs });
if (!(await runtime.isAvailable())) {
  process.stderr.write(`${framework.launch.command} is not available on PATH\n`);
  process.exit(1);
}

const cwd = path.resolve(workspace);
let sessionId;
let mcpAttached = false;
try {
  sessionId = await runtime.startSession(name, { cwd, mcpServers });
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
      process.stderr.write(`failed to open an ACP session: ${retryError.message}\n${retryError.data ? `${retryError.data}\n` : ''}`);
      process.exit(1);
    }
  } else {
    process.stderr.write(`failed to open an ACP session: ${error.message}\n${error.data ? `${error.data}\n` : ''}`);
    process.exit(1);
  }
}
// "requested", not "attached": session/new accepting the field does not mean the
// agent honoured it. octos 2.0.2 accepts mcpServers and silently ignores it —
// claude and codex each spawn an mcp-server.js child, octos spawns none. Saying
// mcp=hafleet here read as a working tool channel that did not exist.
log(`acp session open: ${sessionId} (${frameworkId}, cwd=${cwd}, mcp-requested=${mcpAttached ? MCP_SERVER_NAME : 'none'})`);

const shutdown = (signal) => {
  log(`received ${signal}, closing the acp session`);
  runtime.stopAll();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

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


/** Render an inbox message the way the pane nudge would read to a tmux agent. */
function formatMessage(msg) {
  const from = msg.from || 'unknown';
  const where = msg.group ? ` in group ${msg.group}` : '';
  const body = msg.full || msg.summary || '';
  const lines = [`Message ${msg.id} from ${from}${where}:`, '', body];
  if (msg.type === 'human' || msg.type === 'request') {
    lines.push('', `Reply when the work is done: ${MCP_SERVER_NAME} send_message(to="${from}", summary="...", full="...", reply_to="${msg.id}")`);
  }
  return lines.join('\n');
}

// One ACP turn at a time. session/prompt is a turn, not a queue, so overlapping
// prompts would interleave; a long turn simply defers the next poll.
let turnInFlight = false;
let deliveredCount = 0;

async function pollAndDeliver() {
  if (!agentToken || turnInFlight) return;
  // Before the inbox: the agent may have written something during the last turn,
  // and it should go out even if nobody is messaging it.
  await drainOutbox();
  let snapshot;
  try {
    snapshot = await api(`/api/inbox/${encodeURIComponent(name)}/unread`);
  } catch (error) {
    log(`inbox poll failed: ${error.message}`);
    return;
  }
  const pending = Number(snapshot?.unread_total ?? snapshot?.total ?? 0);
  if (!pending) return;

  turnInFlight = true;
  try {
    // The unfiltered read is what advances the inbox cursor, so a message is
    // marked seen exactly once even if the prompt below fails. Failing to
    // re-deliver is better than re-prompting an agent forever on a poison message.
    const inbox = await api(`/api/inbox/${encodeURIComponent(name)}`);
    const messages = [...(inbox.dm || []), ...(inbox.group || [])];
    if (!messages.length) return;
    const text = `${messages.map(formatMessage).join('\n\n---\n\n')}\n\n---\n\n${OUTBOX_PROTOCOL}`;
    log(`delivering ${messages.length} message(s): ${messages.map((m) => m.id).join(', ')}`);
    // Mark the update stream before prompting so this turn's output is read
    // alone. Without it the previous answer is prepended — verified on mini5,
    // where a reply went out as "TokyoThe command exited with code 7…".
    const cursor = runtime.updateCursor(name);
    const stopReason = await runtime.prompt(name, text);
    deliveredCount += messages.length;
    log(`turn finished (${stopReason}); delivered ${deliveredCount} message(s) so far`);

    // Record what the agent said and which tools it used. Without this, a turn
    // that ends in 'end_turn' having done nothing looks identical to one that did
    // the work — the first live delivery reported success and had accomplished
    // nothing visible. There is no pane to read back, so this log is the only
    // place an operator can see it.
    //
    // agent_message_chunk is emitted per token, not per message: logging each one
    // produced a column of word fragments ("cloud", "/", "oct", "os"). They have
    // to be joined before they mean anything.
    let said = '';
    const tools = [];
    for (const { update } of runtime.updatesSince(name, cursor)) {
      const kind = update?.sessionUpdate;
      if (kind === 'agent_message_chunk') {
        said += update.content?.text || '';
      } else if (kind === 'tool_call' || kind === 'tool_call_update') {
        const label = update.title || update.kind || 'call';
        const status = update.status ? ` [${update.status}]` : '';
        const entry = `${label}${status}`;
        if (tools.at(-1) !== entry) tools.push(entry);
      }
    }
    if (tools.length) log(`  tools: ${tools.slice(0, 12).join(', ')}`);
    const reply = said.replace(/\s+/g, ' ').trim();
    if (reply) log(`  agent: ${reply.slice(0, 600)}${reply.length > 600 ? '…' : ''}`);

    // Send the answer back to whoever asked. Reply to the last message in the
    // batch: they were delivered as one prompt, so the turn answers all of them,
    // and threading it under the most recent is the closest honest attribution.
    // Drain immediately, not on the next poll. The agent writes its outbox file
    // during the turn and then looks for it: on mini5 it reported "the file is
    // still sitting in .hafleet/outbox/ ... the runtime watcher may pick it up on
    // its next sweep". Waiting up to a poll interval invites it to conclude the
    // mechanism is broken and try something else.
    await drainOutbox();

    const trigger = messages.at(-1);
    if (reply && trigger?.from && trigger.from !== name) {
      try {
        await postReply({ to: trigger.from, replyTo: trigger.id, text: said });
      } catch (error) {
        // A failed reply must not look like a failed turn: the work was done.
        log(`  reply failed: ${error.message}`);
      }
    }
  } catch (error) {
    log(`delivery failed: ${error.message}${error.data ? ` — ${error.data}` : ''}`);
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
