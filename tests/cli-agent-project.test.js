import { execFileSync } from 'child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';
import { readV1AgentManifest } from '../lib/agent-home-v1.js';

const REPO_ROOT = path.resolve('.');
const PROVISION_SCRIPT = path.join(REPO_ROOT, 'scripts', 'provision-v1-agent-home.js');
const HAFLEET_BIN = path.join(REPO_ROOT, 'bin', 'hafleet');

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

function runCli(args, env = {}) {
  return execFileSync(HAFLEET_BIN, args, {
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
    const homeRoot = trackTempDir('hafleet-home-');
    const output = runNodeScript(PROVISION_SCRIPT, [
      '--name', 'solo-agent',
      '--type', 'codex',
      '--home', homeRoot,
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

  test('hafleet project add, list, and remove manage dynamic project bindings', () => {
    const homeRoot = trackTempDir('hafleet-home-');
    const sourceRoot = trackTempDir('hafleet-source-');
    const sourceProject = path.join(sourceRoot, 'sample-project');
    mkdirSync(sourceProject, { recursive: true });
    writeFileSync(path.join(sourceProject, 'README.md'), '# sample\n', 'utf-8');

    runNodeScript(PROVISION_SCRIPT, [
      '--name', 'project-agent',
      '--type', 'claude',
      '--home', homeRoot,
    ]);

    const cliEnv = { HAFLEET_HOMEDIR: homeRoot };
    const addOutput = runCli(['project', 'add', 'project-agent', sourceProject, '--mode', 'symlink'], cliEnv);
    expect(addOutput).toContain('Added project sample-project to project-agent');
    expect(addOutput).toContain('materialization\tlinked');

    const manifestPath = path.join(homeRoot, 'agents', 'agent_project-agent', 'agent.json');
    const manifestAfterAdd = readV1AgentManifest(manifestPath);
    expect(manifestAfterAdd?.managedProjects).toHaveLength(1);
    expect(manifestAfterAdd?.managedProjects?.[0]?.name).toBe('sample-project');
    expect(manifestAfterAdd?.managedProjects?.[0]?.originPath).toBe(sourceProject);
    expect(lstatSync(manifestAfterAdd.managedProjects[0].path).isSymbolicLink()).toBe(true);

    const listOutput = runCli(['project', 'list', 'project-agent'], cliEnv);
    expect(listOutput).toContain(`sample-project\tsymlink\t${manifestAfterAdd.managedProjects[0].path}\t${sourceProject}`);

    const removeOutput = runCli(['project', 'remove', 'project-agent', 'sample-project'], cliEnv);
    expect(removeOutput).toContain('Removed project sample-project from project-agent');
    expect(removeOutput).toContain('fileAction\tunlinked');

    const manifestAfterRemove = readV1AgentManifest(manifestPath);
    expect(manifestAfterRemove?.managedProjects).toEqual([]);
    expect(existsSync(path.join(manifestAfterRemove.workdir, 'projects', 'sample-project'))).toBe(false);

    const metaPath = path.join(path.dirname(homeRoot), 'data', 'agents', 'project-agent', 'meta.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    expect(meta.managedProjects).toEqual([]);
  });
});
