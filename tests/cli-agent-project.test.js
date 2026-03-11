import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';
import { readV1AgentManifest } from '../lib/agent-home-v1.js';

const REPO_ROOT = path.resolve('.');
const PROVISION_SCRIPT = path.join(REPO_ROOT, 'scripts', 'provision-v1-agent-home.js');

const cleanupDirs = new Set();

function trackTempDir(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.add(dir);
  return dir;
}

function runNodeScript(scriptPath, args, env = {}) {
  return execFileSync(process.execPath, [scriptPath, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...env,
    },
  });
}

afterEach(() => {
  for (const dir of cleanupDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  cleanupDirs.clear();
});

describe('v1 agent project provisioning', () => {
  test('provision-v1-agent-home creates a v1 home without a bound project', () => {
    const homeRoot = trackTempDir('agent-chat-home-');
    const output = runNodeScript(PROVISION_SCRIPT, [
      '--name', 'solo-agent',
      '--type', 'codex',
      '--home', homeRoot,
      '--subconscious-enabled', 'false',
    ]);
    const payload = JSON.parse(output);
    const manifestPath = payload?.paths?.agentJsonPath;

    expect(typeof manifestPath).toBe('string');
    expect(existsSync(manifestPath)).toBe(true);

    const manifest = readV1AgentManifest(manifestPath);
    expect(manifest?.name).toBe('solo-agent');
    expect(manifest?.type).toBe('codex');
    expect(manifest?.managedProjects).toEqual([]);
    expect(existsSync(path.join(manifest.workdir, 'projects'))).toBe(true);

    const metaPath = path.join(path.dirname(homeRoot), 'data', 'agents', 'solo-agent', 'meta.json');
    expect(existsSync(metaPath)).toBe(true);
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    expect(meta.managedProjects).toEqual([]);
  });
});
