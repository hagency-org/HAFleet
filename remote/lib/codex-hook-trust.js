#!/usr/bin/env node

import { createHash, randomBytes } from 'crypto';
import { spawn, spawnSync } from 'child_process';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import path from 'path';
import { createInterface } from 'readline/promises';
import { fileURLToPath } from 'url';
import { approvalHookTimeoutSeconds } from './runtime-approval-client.js';

export const MINIMUM_CODEX_HOOK_VERSION = '0.144.1';

export function parseCodexVersion(value) {
  const match = String(value || '').match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:[-+\s]|$)/);
  if (!match) return null;
  return match.slice(1, 4).map(part => Number.parseInt(part, 10));
}

export function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const difference = Number(left?.[index] || 0) - Number(right?.[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function sha256File(filePath, readFile = readFileSync) {
  return createHash('sha256').update(readFile(filePath)).digest('hex');
}

function shellQuote(value) {
  const string = String(value);
  if (/^[A-Za-z0-9_./:=+-]+$/.test(string)) return string;
  return `'${string.replaceAll("'", "'\"'\"'")}'`;
}

function tomlString(value) {
  return `"${String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')}"`;
}

export function buildCodexApprovalHookCommand({
  nodeExecutable = process.execPath,
  hookPath,
  scriptDigest,
}) {
  if (!path.isAbsolute(hookPath || '')) throw new Error('Codex permission hook path must be absolute');
  if (!/^[0-9a-f]{64}$/.test(scriptDigest || '')) throw new Error('Codex permission hook digest is invalid');
  return [
    shellQuote(nodeExecutable),
    shellQuote(hookPath),
    `--hafleet-hook-sha256=${scriptDigest}`,
  ].join(' ');
}

export function buildCodexApprovalHookToml({
  command,
  timeoutSeconds,
}) {
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1) {
    throw new Error('Codex permission hook timeout must be a positive integer');
  }
  return `[{ matcher = ".*", hooks = [{ type = "command", command = ${tomlString(command)}, timeout = ${timeoutSeconds}, statusMessage = "Waiting for owner approval in Matrix" }] }]`;
}

export function selectExactPermissionHook(response, {
  cwd,
  command,
  timeoutSeconds,
}) {
  const expectedCwd = path.resolve(cwd);
  const entry = response?.data?.find(item => path.resolve(item?.cwd || '') === expectedCwd);
  if (!entry) throw new Error(`Codex hooks/list returned no entry for ${expectedCwd}`);
  if (Array.isArray(entry.errors) && entry.errors.length > 0) {
    const details = entry.errors.map(error => error?.message || String(error)).join('; ');
    throw new Error(`Codex hook configuration error: ${details}`);
  }
  const matches = (entry.hooks || []).filter(hook => (
    hook?.eventName === 'permissionRequest'
    && hook?.handlerType === 'command'
    && hook?.source === 'sessionFlags'
    && hook?.enabled === true
    && hook?.matcher === '.*'
    && hook?.command === command
    && Number(hook?.timeoutSec) === timeoutSeconds
  ));
  if (matches.length !== 1) {
    throw new Error(`Codex hooks/list did not return exactly one matching session PermissionRequest hook (found ${matches.length})`);
  }
  const hook = matches[0];
  if (!hook.key || !/^sha256:[0-9a-f]{64}$/.test(hook.currentHash || '')) {
    throw new Error('Codex hooks/list returned invalid trust metadata');
  }
  return hook;
}

export function isCodexAppServerResponse(message) {
  return Boolean(
    message
    && typeof message === 'object'
    && !message.method
    && Object.prototype.hasOwnProperty.call(message, 'id')
    && (
      Object.prototype.hasOwnProperty.call(message, 'result')
      || Object.prototype.hasOwnProperty.call(message, 'error')
    )
  );
}

class CodexAppServerClient {
  constructor({
    codexCommand,
    cwd,
    hookToml,
    spawnProcess = spawn,
    requestTimeoutMs = 15_000,
  }) {
    this.codexCommand = codexCommand;
    this.cwd = cwd;
    this.hookToml = hookToml;
    this.spawnProcess = spawnProcess;
    this.requestTimeoutMs = requestTimeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.buffer = '';
    this.child = null;
  }

  async start() {
    this.child = this.spawnProcess(this.codexCommand, [
      'app-server',
      '--stdio',
      '-c',
      `hooks.PermissionRequest=${this.hookToml}`,
    ], {
      cwd: this.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.onStdout(chunk));
    this.child.stderr.on('data', chunk => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8192);
    });
    this.child.once('error', error => this.rejectAll(error));
    this.child.once('exit', (code, signal) => {
      const detail = this.stderr.trim();
      this.rejectAll(new Error(
        `Codex App Server exited before completing preflight (${signal || code})${detail ? `: ${detail}` : ''}`,
      ));
    });
    await this.request('initialize', {
      clientInfo: {
        name: 'hafleet',
        title: 'Agent Chat',
        version: '1.0.0',
      },
    });
    this.notify('initialized', {});
    return this;
  }

  onStdout(chunk) {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      // App Server can initiate requests with its own id namespace. Those
      // messages have `method` and must never resolve a client request whose id
      // happens to collide.
      if (!isCodexAppServerResponse(message)) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  send(message) {
    if (!this.child?.stdin?.writable) throw new Error('Codex App Server stdin is unavailable');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server ${method} timed out`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params) {
    this.send({ method, params });
  }

  close() {
    if (!this.child) return;
    this.child.stdin?.end();
    this.child.kill('SIGTERM');
    this.child = null;
  }
}

async function inspectHook({
  codexCommand,
  cwd,
  hookToml,
  command,
  timeoutSeconds,
  clientFactory,
}) {
  const client = clientFactory
    ? await clientFactory({ codexCommand, cwd, hookToml })
    : await new CodexAppServerClient({ codexCommand, cwd, hookToml }).start();
  try {
    const response = await client.request('hooks/list', { cwds: [cwd] });
    return {
      hook: selectExactPermissionHook(response, { cwd, command, timeoutSeconds }),
      client,
    };
  } catch (error) {
    client.close();
    throw error;
  }
}

function trustEdit(hook) {
  // This mirrors Codex TUI's own trust update. App Server's Upsert recursively
  // merges tables, so unrelated hooks.state entries remain intact.
  return {
    edits: [{
      keyPath: 'hooks.state',
      value: {
        [hook.key]: {
          trusted_hash: hook.currentHash,
        },
      },
      mergeStrategy: 'upsert',
    }],
    reloadUserConfig: true,
  };
}

async function confirmHookTrust(hook, {
  input = process.stdin,
  output = process.stdout,
} = {}) {
  if (!input.isTTY || !output.isTTY) return false;
  output.write('\nCodex requires local trust for the Agent Chat permission hook.\n');
  output.write(`  source: ${hook.sourcePath}\n`);
  output.write(`  command: ${hook.command}\n`);
  output.write(`  config hash: ${hook.currentHash}\n`);
  output.write(`  status: ${hook.trustStatus}\n`);
  const prompt = createInterface({ input, output });
  try {
    const answer = await prompt.question('Type TRUST to allow this exact hook configuration: ');
    return answer.trim() === 'TRUST';
  } finally {
    prompt.close();
  }
}

function checkCodexVersion(codexCommand, runVersion = spawnSync) {
  const result = runVersion(codexCommand, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`codex --version failed: ${(result.stderr || '').trim() || `exit ${result.status}`}`);
  }
  const actual = parseCodexVersion(result.stdout);
  const minimum = parseCodexVersion(MINIMUM_CODEX_HOOK_VERSION);
  if (!actual || compareVersions(actual, minimum) < 0) {
    throw new Error(`Codex ${MINIMUM_CODEX_HOOK_VERSION}+ is required for trusted PermissionRequest hooks`);
  }
  return actual.join('.');
}

function writePreparedConfig(outputPath, value) {
  const resolved = path.resolve(outputPath);
  mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, resolved);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

export async function preflightCodexPermissionHook({
  cwd,
  hookPath,
  outputPath,
  env = process.env,
  codexCommand = 'codex',
  nodeExecutable = process.execPath,
  confirm = confirmHookTrust,
  clientFactory,
  runVersion,
}) {
  const resolvedCwd = path.resolve(cwd);
  const resolvedHook = path.resolve(hookPath);
  const codexVersion = checkCodexVersion(codexCommand, runVersion);
  const scriptDigest = sha256File(resolvedHook);
  const timeoutSeconds = approvalHookTimeoutSeconds(env);
  const command = buildCodexApprovalHookCommand({
    nodeExecutable,
    hookPath: resolvedHook,
    scriptDigest,
  });
  const hookToml = buildCodexApprovalHookToml({ command, timeoutSeconds });
  let inspection = await inspectHook({
    codexCommand,
    cwd: resolvedCwd,
    hookToml,
    command,
    timeoutSeconds,
    clientFactory,
  });
  try {
    const status = String(inspection.hook.trustStatus || '').toLowerCase();
    if (status !== 'trusted' && status !== 'managed') {
      if (status !== 'untrusted' && status !== 'modified') {
        throw new Error(`unsupported Codex hook trust status: ${inspection.hook.trustStatus}`);
      }
      const accepted = await confirm(inspection.hook);
      if (!accepted) {
        throw new Error('Codex permission hook trust was not confirmed locally; background launch aborted');
      }
      await inspection.client.request('config/batchWrite', trustEdit(inspection.hook));
      inspection.client.close();
      inspection = await inspectHook({
        codexCommand,
        cwd: resolvedCwd,
        hookToml,
        command,
        timeoutSeconds,
        clientFactory,
      });
      const verifiedStatus = String(inspection.hook.trustStatus || '').toLowerCase();
      if (verifiedStatus !== 'trusted' && verifiedStatus !== 'managed') {
        throw new Error(`Codex did not persist trust for the exact hook configuration (${inspection.hook.trustStatus})`);
      }
    }

    if (sha256File(resolvedHook) !== scriptDigest) {
      throw new Error('Codex permission hook changed during trust preflight');
    }
    const prepared = {
      version: 1,
      codexVersion,
      hookPath: resolvedHook,
      scriptDigest,
      command,
      hookToml,
      timeoutSeconds,
      currentHash: inspection.hook.currentHash,
      trustStatus: inspection.hook.trustStatus,
      preparedAt: new Date().toISOString(),
    };
    writePreparedConfig(outputPath, prepared);
    return prepared;
  } finally {
    inspection.client.close();
  }
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      values.help = true;
      continue;
    }
    if (!['--cwd', '--hook', '--output', '--codex'].includes(argument)) {
      throw new Error(`unknown argument ${argument}`);
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`${argument} requires a value`);
    values[argument.slice(2)] = value;
    index += 1;
  }
  return values;
}

function usage() {
  return [
    'Usage: codex-hook-trust.js --cwd <agent-dir> --hook <hook.js> --output <prepared.json> [--codex <path>]',
    '',
    'Verifies and, after explicit local confirmation, trusts the exact Agent Chat',
    'Codex PermissionRequest hook before a background tmux session is created.',
  ].join('\n');
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  let arguments_;
  try {
    arguments_ = parseArguments(process.argv.slice(2));
    if (arguments_.help) {
      process.stdout.write(`${usage()}\n`);
    } else {
      if (!arguments_.cwd || !arguments_.hook || !arguments_.output) {
        throw new Error('cwd, hook, and output are required');
      }
      const prepared = await preflightCodexPermissionHook({
        cwd: arguments_.cwd,
        hookPath: arguments_.hook,
        outputPath: arguments_.output,
        codexCommand: arguments_.codex || 'codex',
      });
      process.stdout.write(
        `Codex owner-approval hook verified (${prepared.trustStatus}, timeout ${prepared.timeoutSeconds}s).\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n`);
    process.stderr.write('Codex background session was not started.\n');
    process.exitCode = 1;
  }
}
