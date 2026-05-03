import { afterEach, describe, expect, test } from 'vitest';
import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve('.');
const preflightScript = path.join(repoRoot, 'scripts', 'verify-cd-preflight.sh');
const dirtyMarker = path.join(repoRoot, '.agentchat-preflight-test-dirty');

async function runPreflight(args = [], env = {}) {
  return execFileAsync('bash', [preflightScript, ...args], {
    cwd: repoRoot,
    timeout: 8000,
    env: {
      ...process.env,
      AGENTCHAT_DEPLOY_BRANCH: '',
      AGENT_CHAT_API: '',
      AGENT_CHAT_SERVER: '',
      VERIFY_AGENT: '',
      API_TOKEN: '',
      ...env,
    },
  });
}

async function git(args) {
  const { stdout } = await execFileAsync('git', args, { cwd: repoRoot });
  return stdout.trim();
}

describe('verify-cd-preflight script', () => {
  afterEach(async () => {
    await fs.rm(dirtyMarker, { force: true });
  });

  test('prints deploy target metadata and redacted post-deploy command', async () => {
    const shortCommit = await git(['rev-parse', '--short', 'HEAD']);

    const { stdout } = await runPreflight(['--skip-ci', '--allow-dirty'], {
      AGENT_CHAT_API: 'https://agentchat.example.test/',
      AGENT_CHAT_SERVER: 'remote-a',
      VERIFY_AGENT: 'salt',
      API_TOKEN: 'secret-token',
    });

    expect(stdout).toContain('== cd preflight target ==');
    expect(stdout).toContain(`commit: ${shortCommit}`);
    expect(stdout).toContain('== source/package gate ==');
    expect(stdout).toContain('skipped (--skip-ci)');
    expect(stdout).toContain(
      `agentchat verify-remote --samples 2 --interval 16 --expect-version ${shortCommit} --api https://agentchat.example.test --server remote-a --agent salt`,
    );
    expect(stdout).toContain('API_TOKEN: set (not printed)');
    expect(stdout).not.toContain('secret-token');
  });

  test('shell-quotes post-deploy command arguments with special characters', async () => {
    const shortCommit = await git(['rev-parse', '--short', 'HEAD']);

    const { stdout } = await runPreflight(['--skip-ci', '--allow-dirty'], {
      AGENT_CHAT_API: 'https://agentchat.example.test/path?q=one&two=2',
      AGENT_CHAT_SERVER: 'remote a',
      VERIFY_AGENT: 'salt;rm -rf /',
    });

    expect(stdout).toContain(
      `agentchat verify-remote --samples 2 --interval 16 --expect-version ${shortCommit} --api https://agentchat.example.test/path\\?q=one\\&two=2 --server remote\\ a --agent salt\\;rm\\ -rf\\ /`,
    );
  });

  test('rejects a mismatched required branch before running the gate', async () => {
    await expect(runPreflight([
      '--skip-ci',
      '--allow-dirty',
      '--branch',
      'definitely-not-current-branch',
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("expected branch 'definitely-not-current-branch'"),
    });
  });

  test('rejects dirty worktrees unless explicitly allowed', async () => {
    await fs.writeFile(dirtyMarker, 'dirty marker for verify-cd-preflight test\n');

    await expect(runPreflight(['--skip-ci'])).rejects.toMatchObject({
      stderr: expect.stringContaining('dirty worktree'),
    });
  });

  test('rejects unknown arguments with usage output', async () => {
    await expect(runPreflight(['--not-a-real-flag'])).rejects.toMatchObject({
      stderr: expect.stringContaining('unknown argument: --not-a-real-flag'),
    });
  });
});
