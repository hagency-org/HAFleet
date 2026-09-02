import { describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import os from 'os';

const repoRoot = path.resolve('.');
const coreFiles = [
  'lib/mcp-server-core.js',
  'remote/lib/mcp-server-core.js',
];

function makeTempRoot() {
  return mkdtempSync(path.join(os.tmpdir(), 'hafleet-mcp-cache-'));
}

function runCacheSmoke(coreFile, { cwd, env = {}, agent = 'alpha' }) {
  const childEnv = { ...process.env };
  for (const key of [
    'HAFLEET_AGENT_STATE_DIR',
    'HAFLEET_RUNTIME_DIR',
    'HAFLEET_HOMEDIR',
    'HAFLEET_MCP_MEDIA_CACHE_SMOKE',
    'AGENT_NAME',
  ]) {
    delete childEnv[key];
  }
  Object.assign(childEnv, env, {
    AGENT_NAME: agent,
    HAFLEET_MCP_MEDIA_CACHE_SMOKE: '1',
    NO_PROXY: '*',
  });
  const result = spawnSync(process.execPath, [path.join(repoRoot, coreFile)], {
    cwd,
    env: childEnv,
    encoding: 'utf-8',
    timeout: 5000,
  });
  if (result.status !== 0) {
    throw new Error([
      `cache smoke failed for ${coreFile}`,
      `status=${result.status}`,
      `stdout=${result.stdout}`,
      `stderr=${result.stderr}`,
    ].join('\n'));
  }
  return result.stdout.trim();
}

describe('MCP media cache directory', () => {
  test('uses per-agent state dir before runtime or cwd', () => {
    const tempRoot = makeTempRoot();
    try {
      const cwd = path.join(tempRoot, 'project');
      const stateDir = path.join(tempRoot, 'agent-state');
      const runtimeDir = path.join(tempRoot, 'runtime');
      mkdirSync(cwd, { recursive: true });
      mkdirSync(stateDir, { recursive: true });
      mkdirSync(runtimeDir, { recursive: true });
      // 12-r3: the MCP server is fail-closed on a state dir without an agent
      // token; this test exercises cache-dir RESOLUTION, so provide one.
      writeFileSync(path.join(stateDir, 'agent-token'), 'media-cache-token\n');

      for (const coreFile of coreFiles) {
        const actual = runCacheSmoke(coreFile, {
          cwd,
          env: {
            HAFLEET_AGENT_STATE_DIR: stateDir,
            HAFLEET_RUNTIME_DIR: runtimeDir,
            HOME: path.join(tempRoot, 'home'),
          },
        });
        expect(actual).toBe(path.join(stateDir, 'mcp-media-cache'));
        expect(existsSync(actual)).toBe(true);
        expect(existsSync(path.join(cwd, 'data'))).toBe(false);
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('falls back to runtime data dir when no agent state dir is set', () => {
    const tempRoot = makeTempRoot();
    try {
      const cwd = path.join(tempRoot, 'project');
      const runtimeDir = path.join(tempRoot, 'runtime');
      mkdirSync(cwd, { recursive: true });
      mkdirSync(runtimeDir, { recursive: true });

      for (const coreFile of coreFiles) {
        const actual = runCacheSmoke(coreFile, {
          cwd,
          env: {
            HAFLEET_RUNTIME_DIR: runtimeDir,
            HOME: path.join(tempRoot, 'home'),
          },
          agent: 'alpha/beta',
        });
        expect(actual).toBe(path.join(runtimeDir, 'data', 'mcp-media-cache', 'alpha_beta'));
        expect(existsSync(actual)).toBe(true);
        expect(existsSync(path.join(cwd, 'data'))).toBe(false);
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('falls back to hafleet home instead of project cwd', () => {
    const tempRoot = makeTempRoot();
    try {
      const cwd = path.join(tempRoot, 'project');
      const homeDir = path.join(tempRoot, 'hafleet-home');
      mkdirSync(cwd, { recursive: true });
      mkdirSync(homeDir, { recursive: true });

      for (const coreFile of coreFiles) {
        const actual = runCacheSmoke(coreFile, {
          cwd,
          env: {
            HAFLEET_HOMEDIR: homeDir,
            HOME: path.join(tempRoot, 'home'),
          },
        });
        expect(actual).toBe(path.join(homeDir, 'data', 'mcp-media-cache', 'alpha'));
        expect(existsSync(actual)).toBe(true);
        expect(existsSync(path.join(cwd, 'data'))).toBe(false);
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
