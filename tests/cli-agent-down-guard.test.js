import { execFile } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const REPO_ROOT = path.resolve('.');
const AGENTCHAT_BIN = path.join(REPO_ROOT, 'bin', 'agentchat');
const cleanupDirs = new Set();

function trackTempDir(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.add(dir);
  return dir;
}

function writeExecutable(filePath, content) {
  writeFileSync(filePath, content, 'utf-8');
  chmodSync(filePath, 0o755);
}

function setupFakeTmux() {
  const binDir = trackTempDir('agent-chat-agent-down-bin-');
  const stateDir = trackTempDir('agent-chat-agent-down-state-');
  const logPath = path.join(stateDir, 'tmux.log');
  writeExecutable(path.join(binDir, 'tmux'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$TMUX_FAKE_LOG"
case "$1" in
  has-session)
    if [ -f "$TMUX_FAKE_STATE/killed" ]; then exit 1; fi
    exit 0
    ;;
  list-panes)
    printf 'codex\\n'
    exit 0
    ;;
  capture-pane)
    printf 'archive tail\\n'
    printf 'codex resume 00000000-0000-0000-0000-000000000000\\n'
    exit 0
    ;;
  kill-session)
    touch "$TMUX_FAKE_STATE/killed"
    exit 0
    ;;
  display-message)
    printf 'bash\\n'
    exit 0
    ;;
  send-keys)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);
  return {
    env: {
      PATH: `${binDir}:${process.env.PATH}`,
      TMUX_FAKE_LOG: logPath,
      TMUX_FAKE_STATE: stateDir,
    },
    logPath,
  };
}

function readFakeTmuxLog(logPath) {
  try {
    return readFileSync(logPath, 'utf-8');
  } catch {
    return '';
  }
}

function seedAgent(activeNow, observation) {
  return {
    agents: {
      alpha: {
        name: 'alpha',
        type: 'agent',
        kind: 'agent',
        online: true,
        manualDown: false,
        tmux: 'alpha:0.0',
      },
    },
    agentRuntime: {
      alpha: {
        activeNow,
        activeDurationSec: 0,
        idleDurationSec: activeNow === false ? 60 : 0,
        observation,
      },
    },
    groups: {},
  };
}

function runAgentDown(args, env = {}) {
  return new Promise((resolve) => {
    execFile(AGENTCHAT_BIN, ['down', ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: {
        ...process.env,
        ...env,
      },
      timeout: 8000,
    }, (error, stdout, stderr) => {
      resolve({
        code: error?.code ?? 0,
        stdout,
        stderr,
      });
    });
  });
}

describe('agent-down active-work guard', () => {
  let context = null;
  let listener = null;

  afterEach(async () => {
    if (listener) await listener.close();
    listener = null;
    context?.cleanup();
    context = null;
    for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
    cleanupDirs.clear();
  });

  test('refuses --kill when runtime activity is unknown', async () => {
    context = await createBackendTestContext('agent-chat-agent-down-unknown-test-', seedAgent(null, {
      observerSource: 'runtime-api',
      observerServer: 'local',
      observedAt: Date.now(),
    }));
    listener = await context.listen();
    const tmux = setupFakeTmux();

    const result = await runAgentDown(['alpha', '--kill'], {
      ...tmux.env,
      AGENT_CHAT_API: listener.baseUrl,
      AGENT_CHAT_RUNTIME_DIR: context.runtimeDir,
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('unknown-runtime-status');
    const log = readFakeTmuxLog(tmux.logPath);
    expect(log).toContain('has-session');
    expect(log).not.toContain('capture-pane');
    expect(log).not.toContain('kill-session');
  });

  test('refuses --kill when inactive runtime activity is stale', async () => {
    context = await createBackendTestContext('agent-chat-agent-down-stale-test-', seedAgent(false, {
      observerSource: 'runtime-api',
      observerServer: 'local',
      observedAt: Date.now() - 300000,
    }));
    listener = await context.listen();
    const tmux = setupFakeTmux();

    const result = await runAgentDown(['alpha', '--kill'], {
      ...tmux.env,
      AGENT_CHAT_API: listener.baseUrl,
      AGENT_CHAT_RUNTIME_DIR: context.runtimeDir,
      AGENT_DOWN_ACTIVITY_FRESH_MS: '120000',
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('stale-runtime-status');
    const log = readFakeTmuxLog(tmux.logPath);
    expect(log).toContain('has-session');
    expect(log).not.toContain('capture-pane');
    expect(log).not.toContain('kill-session');
  });

  test('allows --kill when inactive runtime activity is fresh', async () => {
    context = await createBackendTestContext('agent-chat-agent-down-fresh-test-', seedAgent(false, {
      observerSource: 'runtime-api',
      observerServer: 'local',
      observedAt: Date.now(),
    }));
    listener = await context.listen();
    const tmux = setupFakeTmux();

    const result = await runAgentDown(['alpha', '--kill'], {
      ...tmux.env,
      AGENT_CHAT_API: listener.baseUrl,
      AGENT_CHAT_RUNTIME_DIR: context.runtimeDir,
      AGENT_DOWN_ACTIVITY_FRESH_MS: '120000',
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Verified 'alpha' is not active");
    const log = readFakeTmuxLog(tmux.logPath);
    expect(log).toContain('capture-pane');
    expect(log).toContain('kill-session');
  });
});
