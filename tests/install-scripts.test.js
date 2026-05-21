import { describe, expect, test } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

const ROOT = path.resolve('.');

function makeTempRoot(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runScript(script, args, options = {}) {
  return execFileSync('bash', [path.join(ROOT, script), ...args], {
    cwd: ROOT,
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: options.home,
      API_TOKEN: options.apiToken || 'test-install-token',
      PATH: options.path || process.env.PATH,
    },
  });
}

describe('local install and uninstall scripts', () => {
  test('install-full bootstraps env, systemd units, CLI links, and skill links without starting services', () => {
    const tmp = makeTempRoot('agent-chat-install-full-');
    try {
      const home = path.join(tmp, 'home');
      const systemdDir = path.join(tmp, 'systemd');
      const binDir = path.join(tmp, 'bin');
      const envFile = path.join(tmp, '.env');
      mkdirSync(home, { recursive: true });
      mkdirSync(systemdDir, { recursive: true });

      runScript('install-full.sh', [
        '--skip-prereq-check',
        '--skip-npm',
        '--skip-mcp',
        '--no-start',
        '--service-user', 'agentchat-user',
        '--systemd-dir', systemdDir,
        '--bin-dir', binDir,
        '--env-file', envFile,
      ], { home, apiToken: 'fresh-token' });

      expect(readFileSync(envFile, 'utf-8')).toContain('API_TOKEN=fresh-token');
      const backendUnit = readFileSync(path.join(systemdDir, 'agent-chat-v2.service'), 'utf-8');
      expect(backendUnit).toContain('User=agentchat-user');
      expect(backendUnit).toContain(`WorkingDirectory=${ROOT}`);
      expect(backendUnit).toContain('ExecStart=/usr/bin/node backend-v2.js');

      const webUnit = readFileSync(path.join(systemdDir, 'agent-chat.service'), 'utf-8');
      expect(webUnit).toContain('ExecStart=/usr/bin/node server.js');

      const relayUnit = readFileSync(path.join(systemdDir, 'agent-chat-push-relay.service'), 'utf-8');
      expect(relayUnit).toContain('After=network-online.target agent-chat-v2.service');
      expect(relayUnit).toContain('Environment=PUSH_RELAY_MODE=local');
      expect(relayUnit).toContain('ExecStart=/usr/bin/node push-relay.js');

      expect(lstatSync(path.join(binDir, 'agentchat')).isSymbolicLink()).toBe(true);
      expect(lstatSync(path.join(binDir, 'agent-send')).isSymbolicLink()).toBe(true);
      expect(lstatSync(path.join(home, '.claude', 'skills', 'agent-chat', 'SKILL.md')).isSymbolicLink()).toBe(true);
      expect(lstatSync(path.join(home, '.codex', 'skills', 'agent-message', 'SKILL.md')).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('install-full configures Claude Code MCP when the claude CLI is available', () => {
    const tmp = makeTempRoot('agent-chat-install-mcp-');
    try {
      const home = path.join(tmp, 'home');
      const systemdDir = path.join(tmp, 'systemd');
      const binDir = path.join(tmp, 'bin');
      const fakeBin = path.join(tmp, 'fake-bin');
      const logPath = path.join(tmp, 'claude.log');
      mkdirSync(home, { recursive: true });
      mkdirSync(systemdDir, { recursive: true });
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(path.join(fakeBin, 'claude'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(logPath)}\n`, { mode: 0o755 });

      runScript('install-full.sh', [
        '--skip-prereq-check',
        '--skip-npm',
        '--no-start',
        '--systemd-dir', systemdDir,
        '--bin-dir', binDir,
        '--env-file', path.join(tmp, '.env'),
      ], {
        home,
        path: `${fakeBin}:${process.env.PATH}`,
      });

      const claudeArgs = readFileSync(logPath, 'utf-8');
      expect(claudeArgs).toContain('mcp add -s user');
      expect(claudeArgs).toContain('AGENT_CHAT_API=http://127.0.0.1:8090');
      expect(claudeArgs).toContain('API_TOKEN=test-install-token');
      expect(claudeArgs).toContain(`agent-chat node ${ROOT}/mcp-server.js`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('uninstall removes installed units, CLI symlinks, owned skills, and sudoers while preserving data by default', () => {
    const tmp = makeTempRoot('agent-chat-uninstall-');
    try {
      const home = path.join(tmp, 'home');
      const systemdDir = path.join(tmp, 'systemd');
      const sudoersDir = path.join(tmp, 'sudoers');
      const binDir = path.join(tmp, 'bin');
      const envFile = path.join(tmp, '.env');
      mkdirSync(home, { recursive: true });
      mkdirSync(systemdDir, { recursive: true });
      mkdirSync(sudoersDir, { recursive: true });
      mkdirSync(path.join(home, '.agentchat'), { recursive: true });
      writeFileSync(path.join(sudoersDir, 'agentchat-autodeploy'), 'agentchat sudoers\n');

      runScript('install-full.sh', [
        '--skip-prereq-check',
        '--skip-npm',
        '--skip-mcp',
        '--no-start',
        '--systemd-dir', systemdDir,
        '--bin-dir', binDir,
        '--env-file', envFile,
      ], { home });

      runScript('uninstall.sh', [
        '--yes',
        '--skip-mcp',
        '--systemd-dir', systemdDir,
        '--sudoers-dir', sudoersDir,
        '--bin-dir', binDir,
      ], { home });

      expect(existsSync(path.join(systemdDir, 'agent-chat.service'))).toBe(false);
      expect(existsSync(path.join(systemdDir, 'agent-chat-v2.service'))).toBe(false);
      expect(existsSync(path.join(systemdDir, 'agent-chat-push-relay.service'))).toBe(false);
      expect(existsSync(path.join(binDir, 'agentchat'))).toBe(false);
      expect(existsSync(path.join(home, '.claude', 'skills', 'agent-message'))).toBe(false);
      expect(existsSync(path.join(home, '.codex', 'skills', 'agent-chat'))).toBe(false);
      expect(existsSync(path.join(sudoersDir, 'agentchat-autodeploy'))).toBe(false);
      expect(existsSync(path.join(home, '.agentchat'))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('legacy install entrypoints clearly delegate to install-full', () => {
    expect(readFileSync('install.sh', 'utf-8')).toContain('install-full.sh');
    expect(readFileSync('install-v2.sh', 'utf-8')).toContain('install-full.sh');
    expect(readFileSync('install.sh', 'utf-8')).toContain('deprecated');
    expect(readFileSync('install-v2.sh', 'utf-8')).toContain('deprecated');
  });

  test('local service units use optional env files and backend-first ordering', () => {
    const backendUnit = readFileSync('agent-chat-v2.service', 'utf-8');
    const webUnit = readFileSync('agent-chat.service', 'utf-8');
    const relayUnit = readFileSync('agent-chat-push-relay.service', 'utf-8');

    expect(backendUnit).toContain('After=network.target');
    expect(backendUnit).not.toContain('After=network.target agent-chat.service');
    expect(backendUnit).toContain('EnvironmentFile=-__INSTALL_DIR__/.env');
    expect(webUnit).toContain('After=network.target agent-chat-v2.service');
    expect(webUnit).toContain('EnvironmentFile=-__INSTALL_DIR__/.env');
    expect(relayUnit).toContain('After=network-online.target agent-chat-v2.service');
    expect(relayUnit).toContain('EnvironmentFile=-__INSTALL_DIR__/.env');
  });
});
