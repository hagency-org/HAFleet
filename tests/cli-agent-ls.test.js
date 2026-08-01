import { execFile } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterEach, describe, expect, test } from 'vitest';

const REPO_ROOT = path.resolve('.');
const HAFLEET_BIN = path.join(REPO_ROOT, 'bin', 'hafleet');
const execFileAsync = promisify(execFile);
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

function setupFakePath() {
  const binDir = trackTempDir('hafleet-cli-ls-bin-');
  writeExecutable(path.join(binDir, 'tmux'), `#!/usr/bin/env bash
case "$1" in
  list-sessions) exit 0 ;;
  list-panes) exit 0 ;;
  *) exit 0 ;;
esac
`);
  writeExecutable(path.join(binDir, 'curl'), `#!/usr/bin/env bash
printf '[]\\n'
`);
  writeExecutable(path.join(binDir, 'pgrep'), `#!/usr/bin/env bash
exit 1
`);
  return `${binDir}:${process.env.PATH}`;
}

function writeV1Manifest(homeRoot, name, type = 'codex') {
  const agentId = `agent_${name}`;
  const homeDir = path.join(homeRoot, 'agents', agentId);
  const stateDir = path.join(homeDir, 'state');
  const workdir = path.join(homeDir, 'workdir');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(workdir, { recursive: true });
  writeFileSync(path.join(homeDir, 'agent.json'), JSON.stringify({
    id: agentId,
    name,
    type,
    homeDir,
    stateDir,
    workdir,
    agentModelVersion: '1.0',
  }), 'utf-8');
  return { homeDir, stateDir, workdir };
}

async function runAgentLs(env = {}) {
  const { stdout } = await execFileAsync(HAFLEET_BIN, ['ls', '--all'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...env,
    },
  });
  return stdout;
}

afterEach(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
  cleanupDirs.clear();
});

describe('hafleet ls cli', () => {
  test('lists v1 manifests from runtime-derived homes', async () => {
    const runtimeDir = trackTempDir('hafleet-ls-runtime-');
    const homeDir = path.join(runtimeDir, 'homes');
    const paths = writeV1Manifest(homeDir, 'alpha');
    const output = await runAgentLs({
      PATH: setupFakePath(),
      HOME: trackTempDir('hafleet-ls-home-'),
      HAFLEET_RUNTIME_DIR: runtimeDir,
      HAFLEET_API: 'http://127.0.0.1:1',
      HAFLEET_HOMEDIR: '',
    });

    expect(output).toContain('alpha');
    expect(output).toContain('down');
    expect(output).toContain('codex');
    expect(output).toContain(paths.workdir);
  });

  test('ignores relative HAFLEET_HOMEDIR and still lists runtime homes', async () => {
    const runtimeDir = trackTempDir('hafleet-ls-runtime-');
    const homeDir = path.join(runtimeDir, 'homes');
    writeV1Manifest(homeDir, 'beta', 'claude');
    const output = await runAgentLs({
      PATH: setupFakePath(),
      HOME: trackTempDir('hafleet-ls-home-'),
      HAFLEET_RUNTIME_DIR: runtimeDir,
      HAFLEET_API: 'http://127.0.0.1:1',
      HAFLEET_HOMEDIR: 'relative-home',
    });

    expect(output).toContain('beta');
    expect(output).toContain('claude');
  });

  test('keeps legacy home fallback visible', async () => {
    const fakeHome = trackTempDir('hafleet-ls-home-');
    const legacyHome = path.join(fakeHome, '.hafleet');
    writeV1Manifest(legacyHome, 'legacy');
    const output = await runAgentLs({
      PATH: setupFakePath(),
      HOME: fakeHome,
      HAFLEET_API: 'http://127.0.0.1:1',
      HAFLEET_HOMEDIR: '',
      HAFLEET_RUNTIME_DIR: '',
    });

    expect(output).toContain('legacy');
  }, 10000);
});
