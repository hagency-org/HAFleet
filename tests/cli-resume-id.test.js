import { execFileSync } from 'child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

const REPO_ROOT = path.resolve('.');
const HAFLEET_BIN = path.join(REPO_ROOT, 'bin', 'hafleet');

const cleanupDirs = new Set();

function trackTempDir(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.add(dir);
  return dir;
}

function runCli(args, env = {}) {
  return execFileSync(HAFLEET_BIN, args, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

function runCliFail(args, env = {}) {
  try {
    execFileSync(HAFLEET_BIN, args, {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    throw new Error('expected command to fail');
  } catch (e) {
    return { stdout: e.stdout?.toString() || '', stderr: e.stderr?.toString() || '', status: e.status };
  }
}

function setupSandbox() {
  const tmp = trackTempDir('resume-id-');
  const runtimeDir = path.join(tmp, 'runtime');
  const homeRoot = path.join(tmp, 'home');
  mkdirSync(path.join(runtimeDir, 'data', 'agents'), { recursive: true });
  mkdirSync(path.join(homeRoot, 'agents'), { recursive: true });
  return { tmp, runtimeDir, homeRoot };
}

function createLegacyAgent(runtimeDir, name, initialUuid = null) {
  const dir = path.join(runtimeDir, 'data', 'agents', name);
  mkdirSync(dir, { recursive: true });
  if (initialUuid) writeFileSync(path.join(dir, 'resume-id'), initialUuid + '\n');
  return dir;
}

function createV1Agent(runtimeDir, homeRoot, name, initialUuid = null) {
  const dataDir = path.join(runtimeDir, 'data', 'agents', name);
  mkdirSync(dataDir, { recursive: true });
  const v1StateDir = path.join(homeRoot, 'agents', `agent_${name}`, 'state');
  mkdirSync(v1StateDir, { recursive: true });
  const target = path.join(v1StateDir, 'resume-id');
  symlinkSync(target, path.join(dataDir, 'resume-id'));
  if (initialUuid) writeFileSync(target, initialUuid + '\n');
  return { dataDir, v1StateDir, symlinkPath: path.join(dataDir, 'resume-id'), targetPath: target };
}

afterEach(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
  cleanupDirs.clear();
});

describe('hafleet resume-id', () => {
  test('views current resume-id for a legacy agent', () => {
    const { runtimeDir, homeRoot } = setupSandbox();
    createLegacyAgent(runtimeDir, 'legacy1', '11111111-2222-3333-4444-555555555555');
    const out = runCli(['resume-id', 'legacy1'], {
      HAFLEET_RUNTIME_DIR: runtimeDir,
      HAFLEET_HOMEDIR: homeRoot,
    });
    expect(out).toContain('11111111-2222-3333-4444-555555555555');
    expect(out).toContain('data dir only');
  });

  test('views current resume-id through a v1 symlink', () => {
    const { runtimeDir, homeRoot } = setupSandbox();
    createV1Agent(runtimeDir, homeRoot, 'v1one', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    const out = runCli(['resume-id', 'v1one'], {
      HAFLEET_RUNTIME_DIR: runtimeDir,
      HAFLEET_HOMEDIR: homeRoot,
    });
    expect(out).toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(out).toContain('v1 symlink');
  });

  test('reports no resume-id when none set', () => {
    const { runtimeDir, homeRoot } = setupSandbox();
    createLegacyAgent(runtimeDir, 'empty-agent');
    const out = runCli(['resume-id', 'empty-agent'], {
      HAFLEET_RUNTIME_DIR: runtimeDir,
      HAFLEET_HOMEDIR: homeRoot,
    });
    expect(out).toContain("(no resume-id set for 'empty-agent')");
  });

  test('errors when agent does not exist', () => {
    const { runtimeDir, homeRoot } = setupSandbox();
    const result = runCliFail(['resume-id', 'ghost-agent'], {
      HAFLEET_RUNTIME_DIR: runtimeDir,
      HAFLEET_HOMEDIR: homeRoot,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("agent 'ghost-agent' not found");
  });

  test('rejects invalid UUID format on set', () => {
    const { runtimeDir, homeRoot } = setupSandbox();
    createLegacyAgent(runtimeDir, 'legacy2');
    const result = runCliFail(['resume-id', 'legacy2', 'not-a-uuid'], {
      HAFLEET_RUNTIME_DIR: runtimeDir,
      HAFLEET_HOMEDIR: homeRoot,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("invalid UUID format 'not-a-uuid'");
  });

  test('sets resume-id on a legacy agent', () => {
    const { runtimeDir, homeRoot } = setupSandbox();
    const dir = createLegacyAgent(runtimeDir, 'legacy3');
    runCli(['resume-id', 'legacy3', 'deadbeef-1234-4567-8900-abcdefabcdef'], {
      HAFLEET_RUNTIME_DIR: runtimeDir,
      HAFLEET_HOMEDIR: homeRoot,
    });
    const content = readFileSync(path.join(dir, 'resume-id'), 'utf-8').trim();
    expect(content).toBe('deadbeef-1234-4567-8900-abcdefabcdef');
  });

  test('set on v1 agent writes through the symlink to the state file', () => {
    const { runtimeDir, homeRoot } = setupSandbox();
    const v1 = createV1Agent(runtimeDir, homeRoot, 'v1two', '00000000-0000-0000-0000-000000000000');
    runCli(['resume-id', 'v1two', 'cafefeed-dead-beef-1234-567890abcdef'], {
      HAFLEET_RUNTIME_DIR: runtimeDir,
      HAFLEET_HOMEDIR: homeRoot,
    });
    expect(lstatSync(v1.symlinkPath).isSymbolicLink()).toBe(true);
    const targetContent = readFileSync(v1.targetPath, 'utf-8').trim();
    expect(targetContent).toBe('cafefeed-dead-beef-1234-567890abcdef');
  });

  test('clears legacy agent resume-id', () => {
    const { runtimeDir, homeRoot } = setupSandbox();
    const dir = createLegacyAgent(runtimeDir, 'legacy4', '11112222-3333-4444-5555-666677778888');
    runCli(['resume-id', 'legacy4', '--clear'], {
      HAFLEET_RUNTIME_DIR: runtimeDir,
      HAFLEET_HOMEDIR: homeRoot,
    });
    expect(existsSync(path.join(dir, 'resume-id'))).toBe(false);
  });

  test('clear on v1 agent removes target but keeps dangling symlink', () => {
    const { runtimeDir, homeRoot } = setupSandbox();
    const v1 = createV1Agent(runtimeDir, homeRoot, 'v1three', '11111111-2222-3333-4444-555555555555');
    runCli(['resume-id', 'v1three', '--clear'], {
      HAFLEET_RUNTIME_DIR: runtimeDir,
      HAFLEET_HOMEDIR: homeRoot,
    });
    expect(existsSync(v1.targetPath)).toBe(false);
    // Dangling symlink should still be there
    expect(lstatSync(v1.symlinkPath).isSymbolicLink()).toBe(true);
    expect(existsSync(v1.symlinkPath)).toBe(false);
  });

  test('help output describes all three modes', () => {
    const out = runCli(['resume-id', '--help']);
    expect(out).toContain('View current resume-id');
    expect(out).toContain('Set resume-id');
    expect(out).toContain('Clear resume-id');
    expect(out).toContain('RFC 4122');
  });
});
