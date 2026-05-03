import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

const repoRoot = path.resolve('.');
const verifyCiScript = path.join(repoRoot, 'scripts', 'verify-ci.sh');
const kernelScript = path.join(repoRoot, 'scripts', 'run-kernel-tests.sh');
const cleanupDirs = new Set();
const cleanupPids = new Set();

async function makeTempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupDirs.add(dir);
  return dir;
}

async function writeExecutable(filePath, content) {
  await fs.writeFile(filePath, content);
  await fs.chmod(filePath, 0o755);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

async function waitFor(condition, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await condition();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (lastError) throw lastError;
  throw new Error(`timed out after ${timeoutMs}ms`);
}

async function waitForPidFile(pidFile, minCount = 1) {
  return waitFor(async () => {
    const text = await fs.readFile(pidFile, 'utf-8');
    const pids = text.split(/\s+/).filter(Boolean).map((pid) => Number(pid));
    return pids.length >= minCount && pids.every(Number.isFinite) ? pids : null;
  });
}

async function waitForDead(pids) {
  await waitFor(() => pids.every((pid) => !isProcessAlive(pid)), 5000);
}

function waitForExit(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out waiting for pid ${child.pid} to exit`));
    }, timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function assertNoCiTempLogs(tempDir) {
  const entries = await fs.readdir(tempDir);
  expect(entries.filter((entry) => entry.startsWith('agent-chat-verify-ci.'))).toEqual([]);
  expect(entries.filter((entry) => entry.startsWith('agent-chat-kernel-tests.'))).toEqual([]);
}

const signalCases = [
  { signal: 'SIGHUP', exitCode: 129 },
  { signal: 'SIGINT', exitCode: 130 },
  { signal: 'SIGTERM', exitCode: 143 },
];

const blockingDescendantScript = `bash -c 'sleep 60 & echo "$!" >>"$AGENTCHAT_TEST_CHILD_PID_FILE"; wait "$!"' &
child="$!"
echo "$child" >>"$AGENTCHAT_TEST_CHILD_PID_FILE"
wait "$child"
`;

const leakingDescendantScript = `bash -c 'sleep 60 & echo "$!" >>"$AGENTCHAT_TEST_CHILD_PID_FILE"; exit 0' &
child="$!"
echo "$child" >>"$AGENTCHAT_TEST_CHILD_PID_FILE"
wait "$child"
`;

describe('CI script signal cleanup', () => {
  afterEach(async () => {
    for (const pid of cleanupPids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // process already gone
      }
    }
    cleanupPids.clear();
    for (const dir of cleanupDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    cleanupDirs.clear();
  });

  for (const { signal, exitCode } of signalCases) {
    test(`verify-ci ${signal} cleanup kills descendants from the tracked environment step`, async () => {
      const tempDir = await makeTempDir('agent-chat-ci-cleanup-');
      const fakeBin = path.join(tempDir, 'bin');
      await fs.mkdir(fakeBin);
      const childPidFile = path.join(tempDir, 'child-pids');
      await writeExecutable(path.join(fakeBin, 'npm'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-} \${2:-}" == "run report:ci-env" ]]; then
${blockingDescendantScript}
fi
exit 0
`);

      const child = spawn('bash', [verifyCiScript], {
        cwd: repoRoot,
        env: {
          ...process.env,
          AGENTCHAT_VERIFY_CI_TIMEOUT_ACTIVE: '1',
          AGENTCHAT_TEST_CHILD_PID_FILE: childPidFile,
          PATH: `${fakeBin}:${process.env.PATH || ''}`,
          TMPDIR: tempDir,
        },
        stdio: 'ignore',
      });
      cleanupPids.add(child.pid);
      const exitPromise = waitForExit(child);
      const pids = await waitForPidFile(childPidFile, 2);
      pids.forEach((pid) => cleanupPids.add(pid));

      child.kill(signal);
      const result = await exitPromise;
      expect(result.code).toBe(exitCode);
      const allPids = await waitForPidFile(childPidFile, pids.length);
      allPids.forEach((pid) => cleanupPids.add(pid));
      await waitForDead(allPids);
      await assertNoCiTempLogs(tempDir);
    });
  }

  test('verify-ci normal exit cleanup kills descendants left by successful steps', async () => {
    const tempDir = await makeTempDir('agent-chat-ci-cleanup-');
    const fakeBin = path.join(tempDir, 'bin');
    await fs.mkdir(fakeBin);
    const childPidFile = path.join(tempDir, 'child-pids');
    await writeExecutable(path.join(fakeBin, 'npm'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-} \${2:-}" == "run report:ci-env" ]]; then
${leakingDescendantScript}
fi
exit 0
`);

    const child = spawn('bash', [verifyCiScript], {
      cwd: repoRoot,
      env: {
        ...process.env,
        AGENTCHAT_VERIFY_CI_TIMEOUT_ACTIVE: '1',
        AGENTCHAT_TEST_CHILD_PID_FILE: childPidFile,
        PATH: `${fakeBin}:${process.env.PATH || ''}`,
        TMPDIR: tempDir,
      },
      stdio: 'ignore',
    });
    cleanupPids.add(child.pid);
    const exitPromise = waitForExit(child);
    const pids = await waitForPidFile(childPidFile, 2);
    pids.forEach((pid) => cleanupPids.add(pid));

    const result = await exitPromise;
    expect(result.code).toBe(0);
    const allPids = await waitForPidFile(childPidFile, pids.length);
    allPids.forEach((pid) => cleanupPids.add(pid));
    await waitForDead(allPids);
    await assertNoCiTempLogs(tempDir);
  });

  for (const { signal, exitCode } of signalCases) {
    test(`run-kernel-tests ${signal} cleanup kills shard descendants`, async () => {
      const tempDir = await makeTempDir('agent-chat-kernel-cleanup-');
      const childPidFile = path.join(tempDir, 'child-pids');
      const fakeVitest = path.join(tempDir, 'vitest');
      await writeExecutable(fakeVitest, `#!/usr/bin/env bash
set -euo pipefail
${blockingDescendantScript}
`);

      const child = spawn('bash', [kernelScript], {
        cwd: repoRoot,
        env: {
          ...process.env,
          AGENTCHAT_VITEST_BIN: fakeVitest,
          AGENTCHAT_TEST_CHILD_PID_FILE: childPidFile,
          TMPDIR: tempDir,
        },
        stdio: 'ignore',
      });
      cleanupPids.add(child.pid);
      const exitPromise = waitForExit(child);
      const pids = await waitForPidFile(childPidFile, 2);
      pids.forEach((pid) => cleanupPids.add(pid));

      child.kill(signal);
      const result = await exitPromise;
      expect(result.code).toBe(exitCode);
      const allPids = await waitForPidFile(childPidFile, pids.length);
      allPids.forEach((pid) => cleanupPids.add(pid));
      await waitForDead(allPids);
      await assertNoCiTempLogs(tempDir);
    });
  }

  test('run-kernel-tests normal exit cleanup kills descendants left by successful shards', async () => {
    const tempDir = await makeTempDir('agent-chat-kernel-cleanup-');
    const childPidFile = path.join(tempDir, 'child-pids');
    const fakeVitest = path.join(tempDir, 'vitest');
    await writeExecutable(fakeVitest, `#!/usr/bin/env bash
set -euo pipefail
${leakingDescendantScript}
`);

    const child = spawn('bash', [kernelScript], {
      cwd: repoRoot,
      env: {
        ...process.env,
        AGENTCHAT_VITEST_BIN: fakeVitest,
        AGENTCHAT_TEST_CHILD_PID_FILE: childPidFile,
        TMPDIR: tempDir,
      },
      stdio: 'ignore',
    });
    cleanupPids.add(child.pid);
    const exitPromise = waitForExit(child);
    const pids = await waitForPidFile(childPidFile, 2);
    pids.forEach((pid) => cleanupPids.add(pid));

    const result = await exitPromise;
    expect(result.code).toBe(0);
    const allPids = await waitForPidFile(childPidFile, pids.length);
    allPids.forEach((pid) => cleanupPids.add(pid));
    await waitForDead(allPids);
    await assertNoCiTempLogs(tempDir);
  });
});
