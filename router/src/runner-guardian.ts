import { spawn } from 'node:child_process';

const executable = process.env.HAFLEET_GUARDIAN_EXECUTABLE?.trim() ?? '';
if (!executable) throw new Error('runner guardian executable is missing');

let parsedArgs: unknown;
try {
  parsedArgs = JSON.parse(process.env.HAFLEET_GUARDIAN_ARGS_JSON ?? '[]');
} catch {
  throw new Error('runner guardian argv is invalid');
}
if (!Array.isArray(parsedArgs) || parsedArgs.some((value) => typeof value !== 'string')) {
  throw new Error('runner guardian argv must be a string array');
}
const args = parsedArgs as string[];
const childEnv = { ...process.env };
delete childEnv.HAFLEET_GUARDIAN_EXECUTABLE;
delete childEnv.HAFLEET_GUARDIAN_ARGS_JSON;
delete childEnv.NODE_CHANNEL_FD;
delete childEnv.NODE_CHANNEL_SERIALIZATION_MODE;

const runtime = spawn(executable, args, {
  cwd: process.cwd(),
  env: childEnv,
  stdio: ['pipe', 'pipe', 'pipe'],
  detached: process.platform !== 'win32',
});

let terminating = false;
let killTimer: NodeJS.Timeout | null = null;
function signalRuntime(signal: NodeJS.Signals): void {
  if (!runtime.pid || runtime.exitCode !== null || runtime.signalCode !== null) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-runtime.pid, signal);
      return;
    } catch { /* fall through to direct child signaling */ }
  }
  runtime.kill(signal);
}

function terminate(): void {
  if (terminating) return;
  terminating = true;
  signalRuntime('SIGTERM');
  killTimer = setTimeout(() => signalRuntime('SIGKILL'), 2_000);
  killTimer.unref?.();
}

process.stdin.pipe(runtime.stdin);
runtime.stdout.pipe(process.stdout);
runtime.stderr.pipe(process.stderr);
runtime.once('spawn', () => {
  if (typeof process.send === 'function') process.send({ type: 'runtime_ready', pid: runtime.pid });
});
runtime.once('error', (error) => {
  process.stderr.write(`runner guardian failed to launch runtime: ${error.message}\n`);
});
runtime.once('close', (code) => {
  if (killTimer) clearTimeout(killTimer);
  const exitCode = code ?? (terminating ? 143 : 1);
  if (process.connected) process.disconnect?.();
  process.exit(exitCode);
});

process.on('disconnect', terminate);
process.on('SIGTERM', terminate);
process.on('SIGINT', terminate);

// IPC disconnect is authoritative, while the parent-pid check covers runtimes
// launched by a host that closes IPC incorrectly during a hard crash.
const parentPid = process.ppid;
const parentCheck = setInterval(() => {
  if (process.ppid !== parentPid || process.ppid === 1) terminate();
}, 1_000);
parentCheck.unref?.();
