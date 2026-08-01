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
 * It deliberately does NOT poll the backend for work. Delivery to ACP agents is
 * the next layer; this exists so an ACP agent can be launched, registered, and
 * seen as alive in the fleet.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const runtime = createAcpRuntime({ command: framework.launch.command, args: acpArgs });
if (!(await runtime.isAvailable())) {
  process.stderr.write(`${framework.launch.command} is not available on PATH\n`);
  process.exit(1);
}

let sessionId;
try {
  sessionId = await runtime.startSession(name, { cwd: path.resolve(workspace) });
} catch (error) {
  process.stderr.write(`failed to open an ACP session: ${error.message}\n${error.data ? `${error.data}\n` : ''}`);
  process.exit(1);
}
log(`acp session open: ${sessionId} (${frameworkId}, cwd=${path.resolve(workspace)})`);

const shutdown = (signal) => {
  log(`received ${signal}, closing the acp session`);
  runtime.stopAll();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Hold the process open and notice if the agent dies underneath us: the backend
// reads this pid, so exiting quietly would leave the fleet reporting a live
// agent that is gone.
const interval = setInterval(async () => {
  if (!(await runtime.sessionExists(name))) {
    log('acp session ended; exiting so the backend stops reporting this agent as live');
    clearInterval(interval);
    process.exit(1);
  }
}, 5000);
