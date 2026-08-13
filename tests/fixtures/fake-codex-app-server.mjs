#!/usr/bin/env node
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';

if (process.env.FAKE_CODEX_EXIT_IMMEDIATELY === '1') process.exit(17);

// When set, append every sandbox value the runner requests, one JSON line per
// entry, so an effect test can assert what the runtime was actually launched
// with rather than trusting the launch descriptor.
const sandboxLogPath = process.env.FAKE_CODEX_SANDBOX_LOG || null;
function recordSandbox(level, value) {
  if (!sandboxLogPath) return;
  try {
    appendFileSync(sandboxLogPath, `${JSON.stringify({ level, value })}\n`);
  } catch {
    // Best-effort: a logging failure must not change runner behavior.
  }
}

const wrongThread = process.env.FAKE_CODEX_WRONG_THREAD === '1';
if (process.env.FAKE_CODEX_REQUIRE_MCP_CONFIG === '1') {
  const argv = process.argv.slice(2).join('\n');
  const required = [
    'mcp_servers.hafleet.command=',
    'mcp_servers.hafleet.args=',
    'mcp_servers.hafleet.env_vars=',
  ];
  if (required.some((marker) => !argv.includes(marker))
    || !process.env.HAFLEET_DISPATCH_CAPABILITY
    || process.env.HAFLEET_EPHEMERAL_RUNNER !== '1') {
    process.exit(23);
  }
}
let turnRequestId = null;
let approvalRequestId = 91;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'fake-codex' } });
    return;
  }
  if (message.method === 'thread/start') {
    recordSandbox('thread', message.params?.sandbox);
    send({ id: message.id, result: { thread: { id: 'thread-fake' } } });
    return;
  }
  if (message.method === 'turn/start') {
    recordSandbox('turn', message.params?.sandboxPolicy);
    turnRequestId = message.id;
    send({ id: turnRequestId, result: { turn: { id: 'turn-fake', status: 'inProgress' } } });
    send({
      id: approvalRequestId,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: wrongThread ? 'thread-wrong' : 'thread-fake',
        turnId: 'turn-fake',
        itemId: 'item-command',
        command: '/bin/echo safe',
        cwd: process.cwd(),
        reason: 'test command',
      },
    });
    return;
  }
  if (message.id === approvalRequestId && message.result) {
    const accepted = message.result.decision === 'accept';
    send({ method: 'serverRequest/resolved', params: { threadId: 'thread-fake', requestId: approvalRequestId } });
    send({
      method: 'item/completed',
      params: {
        threadId: 'thread-fake', turnId: 'turn-fake',
        item: { type: 'agentMessage', phase: 'final_answer', text: accepted ? 'approved result' : 'denied result' },
      },
    });
    send({
      method: 'turn/completed',
      params: { threadId: 'thread-fake', turn: { id: 'turn-fake', status: 'completed' } },
    });
  }
});
