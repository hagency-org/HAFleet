import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  allAgentHomeRoots,
  buildV1AgentPaths,
  defaultAgentchatHomeDir,
  readV1AgentManifest,
} from '../lib/agent-home-v1.js';

const cleanupDirs = new Set();

function trackTempDir(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.add(dir);
  return dir;
}

afterEach(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
  cleanupDirs.clear();
});

describe('agent home v1 resolver', () => {
  test('uses absolute AGENTCHAT_HOMEDIR before runtime-derived homes', () => {
    const homeRoot = trackTempDir('agentchat-home-root-');
    const runtimeRoot = trackTempDir('agentchat-runtime-root-');

    expect(defaultAgentchatHomeDir({
      AGENTCHAT_HOMEDIR: homeRoot,
      AGENT_CHAT_RUNTIME_DIR: runtimeRoot,
    })).toBe(homeRoot);

    expect(buildV1AgentPaths('Alpha Agent', {
      AGENTCHAT_HOMEDIR: homeRoot,
      AGENT_CHAT_RUNTIME_DIR: runtimeRoot,
    })).toMatchObject({
      homeRoot,
      agentId: 'agent_alpha_agent',
      homeDir: path.join(homeRoot, 'agents', 'agent_alpha_agent'),
      stateDir: path.join(homeRoot, 'agents', 'agent_alpha_agent', 'state'),
      workdir: path.join(homeRoot, 'agents', 'agent_alpha_agent', 'workdir'),
    });
  });

  test('ignores relative home env values before falling back to runtime-derived homes', () => {
    const runtimeRoot = trackTempDir('agentchat-runtime-root-');

    expect(defaultAgentchatHomeDir({
      AGENTCHAT_HOMEDIR: 'relative-home',
      AGENT_CHAT_RUNTIME_DIR: runtimeRoot,
    })).toBe(path.join(runtimeRoot, 'homes'));
  });

  test('ignores relative runtime env values before falling back to legacy home', () => {
    expect(defaultAgentchatHomeDir({
      AGENT_CHAT_RUNTIME_DIR: 'relative-runtime',
    })).toBe(path.join(os.homedir(), '.agentchat'));
  });

  test('keeps legacy home as a lookup fallback when primary differs', () => {
    const runtimeRoot = trackTempDir('agentchat-runtime-root-');
    expect(allAgentHomeRoots({ AGENT_CHAT_RUNTIME_DIR: runtimeRoot })).toEqual([
      path.join(runtimeRoot, 'homes'),
      path.join(os.homedir(), '.agentchat'),
    ]);
  });

  test('rejects manifests with relative runtime paths', () => {
    const manifestDir = trackTempDir('agentchat-manifest-');
    const manifestPath = path.join(manifestDir, 'agent.json');
    mkdirSync(path.join(manifestDir, 'state'), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify({
      id: 'agent_alpha',
      name: 'alpha',
      homeDir: 'relative/home',
      stateDir: path.join(manifestDir, 'state'),
      workdir: path.join(manifestDir, 'workdir'),
    }), 'utf-8');

    expect(readV1AgentManifest(manifestPath)).toBeNull();
  });
});
