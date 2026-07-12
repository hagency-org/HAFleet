#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

function parseArgs(argv) {
  const separator = argv.indexOf('--');
  if (separator < 0 || separator === argv.length - 1) throw new Error('service command is required');
  const options = {};
  for (let index = 0; index < separator; index += 2) options[argv[index]] = argv[index + 1];
  if (!options['--lease'] || !options['--token']) throw new Error('lease path and token are required');
  return { leasePath: options['--lease'], token: options['--token'], command: argv.slice(separator + 1) };
}

function leaseHealthy(leasePath, token) {
  try {
    const lease = JSON.parse(readFileSync(leasePath, 'utf8'));
    return lease.token === token && Date.now() - Number(lease.updatedAtMs || 0) <= 2000;
  } catch {
    return false;
  }
}

const { leasePath, token, command } = parseArgs(process.argv.slice(2));
const child = spawn(command[0], command.slice(1), {
  env: process.env,
  stdio: 'inherit',
  shell: false,
});
let stopping = false;

function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  clearInterval(leaseTimer);
  try { child.kill(signal); } catch {}
  const killTimer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch {}
  }, 1000);
  killTimer.unref();
}

const leaseTimer = setInterval(() => {
  if (!leaseHealthy(leasePath, token)) stop('SIGTERM');
}, 250);
leaseTimer.unref();

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(signal));
child.once('error', (error) => {
  process.stderr.write(`[supervised-service-child] ${error.message}\n`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  clearInterval(leaseTimer);
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
