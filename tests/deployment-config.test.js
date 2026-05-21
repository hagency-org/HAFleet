import { describe, expect, test } from 'vitest';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import os from 'os';
import path from 'path';

import { defaultBenchmarkRuntimeRoot } from '../lib/benchmark-workflow.js';
import { collectMissingRequiredEnv, enforceStartupConfig } from '../lib/startup-config.js';

describe('deployment configuration', () => {
  test('declares Node 22 runtime for fresh installs', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
    expect(pkg.engines).toEqual({ node: '>=22.0.0' });
    expect(readFileSync('.nvmrc', 'utf-8').trim()).toBe('22');
  });

  test('benchmark runtime defaults under ~/.agentchat', () => {
    expect(defaultBenchmarkRuntimeRoot({})).toBe(path.resolve(os.homedir(), '.agentchat', 'bench-runtime'));
    expect(defaultBenchmarkRuntimeRoot({ AGENT_CHAT_BENCH_RUNTIME_DIR: '/tmp/custom-bench' })).toBe('/tmp/custom-bench');
  });

  test('startup config treats API_TOKEN as required', () => {
    expect(collectMissingRequiredEnv({ API_TOKEN: '  ' }, ['API_TOKEN'])).toEqual([{ name: 'API_TOKEN' }]);

    const errors = [];
    let exitCode = null;
    const ok = enforceStartupConfig({
      env: { API_TOKEN: '' },
      logger: {
        error: (message) => errors.push(message),
        warn: () => {},
      },
      exit: (code) => { exitCode = code; },
      serviceName: 'test service',
    });

    expect(ok).toBe(false);
    expect(exitCode).toBe(1);
    expect(errors.join('\n')).toContain('test service cannot start');
    expect(errors.join('\n')).toContain('API_TOKEN');
  });

  test('push relay entrypoint fails closed without API_TOKEN before core startup', () => {
    const result = spawnSync(process.execPath, ['push-relay.js'], {
      cwd: path.resolve('.'),
      encoding: 'utf-8',
      env: {
        ...process.env,
        API_TOKEN: '',
        PUSH_RELAY_MODE: 'local',
      },
      timeout: 3000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Agent Chat push relay cannot start');
    expect(result.stderr).toContain('API_TOKEN');
    expect(result.stderr).not.toContain('[push-relay]');
  });

  test('.env.example documents deployment-facing optional variables', () => {
    const envExample = readFileSync('.env.example', 'utf-8');
    for (const name of [
      'AGENT_CHAT_API',
      'AGENT_CHAT_RUNTIME_DIR',
      'AGENT_CHAT_BACKEND_PORT',
      'AGENT_CHAT_WEB_PORT',
      'AGENT_CHAT_WEB_URL',
      'AGENT_CHAT_QUEUE_URL',
      'AGENTCHAT_HOMEDIR',
      'AGENT_CHAT_DASHBOARD_TOKEN',
      'PUSH_RELAY_MODE',
      'PUSH_RELAY_INCLUDE_LEASE_FIELDS',
      'PUSH_RELAY_SCAN_INTERVAL_MS',
      'PUSH_RELAY_RECONNECT_MS',
      'PUSH_RELAY_HEARTBEAT_INTERVAL_MS',
      'PUSH_RELAY_INJECT_DELAY_MS',
      'PUSH_RELAY_BLOCK_SCAN_INTERVAL_MS',
      'PUSH_RELAY_BLOCK_TAIL_LINES',
      'PUSH_RELAY_BLOCK_RECENT_LINES',
      'PUSH_RELAY_COMPACT_RECENT_LINES',
      'PUSH_RELAY_SKIP_LOG_THROTTLE_MS',
      'PUSH_RELAY_MCP_SESSION_CACHE_TTL_MS',
      'RELAY_QUEUE_DRAIN_INTERVAL_MS',
      'AGENTCHAT_SUBCONSCIOUS_EVENT_TOKEN',
    ]) {
      expect(envExample).toMatch(new RegExp(`^#?${name}=`, 'm'));
    }
  });

  test('startup config warns for missing optional variables without failing', () => {
    const warnings = [];
    let exitCalled = false;
    const ok = enforceStartupConfig({
      env: { API_TOKEN: 'secret' },
      logger: {
        error: () => {},
        warn: (message) => warnings.push(message),
      },
      exit: () => { exitCalled = true; },
      serviceName: 'test service',
      optional: [{ name: 'OPTIONAL_TOKEN', description: 'Optional integration is disabled.' }],
    });

    expect(ok).toBe(true);
    expect(exitCalled).toBe(false);
    expect(warnings).toEqual([
      '[WARN] test service: optional OPTIONAL_TOKEN is not set. Optional integration is disabled.',
    ]);
  });
});
