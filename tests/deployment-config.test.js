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

  test('benchmark runtime defaults under ~/.hafleet', () => {
    expect(defaultBenchmarkRuntimeRoot({})).toBe(path.resolve(os.homedir(), '.hafleet', 'bench-runtime'));
    expect(defaultBenchmarkRuntimeRoot({ HAFLEET_BENCH_RUNTIME_DIR: '/tmp/custom-bench' })).toBe('/tmp/custom-bench');
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

  test('local push relay entrypoint rejects remote profile drift before core startup', () => {
    const result = spawnSync(process.execPath, ['push-relay.js'], {
      cwd: path.resolve('.'),
      encoding: 'utf-8',
      env: {
        ...process.env,
        API_TOKEN: 'secret',
        PUSH_RELAY_MODE: 'remote',
      },
      timeout: 3000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('local entrypoint requires PUSH_RELAY_MODE=local');
    expect(result.stderr).not.toContain('startup error');
  });

  test('remote push relay entrypoint rejects local profile drift and local server identity', () => {
    const wrongMode = spawnSync(process.execPath, ['remote/push-relay.js'], {
      cwd: path.resolve('.'),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HAFLEET_WRAPPER_SMOKE: '1',
        PUSH_RELAY_MODE: 'local',
        HAFLEET_SERVER: 'remote-a',
      },
      timeout: 3000,
    });

    expect(wrongMode.status).toBe(1);
    expect(wrongMode.stderr).toContain('remote entrypoint requires PUSH_RELAY_MODE=remote');
    expect(wrongMode.stderr).not.toContain('startup error');

    const localServer = spawnSync(process.execPath, ['remote/push-relay.js'], {
      cwd: path.resolve('.'),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HAFLEET_WRAPPER_SMOKE: '1',
        PUSH_RELAY_MODE: 'remote',
        HAFLEET_SERVER: 'local',
      },
      timeout: 3000,
    });

    expect(localServer.status).toBe(1);
    expect(localServer.stderr).toContain('HAFLEET_SERVER to be a non-local server id');
    expect(localServer.stderr).not.toContain('startup error');
  });

  test('.env.example documents deployment-facing optional variables', () => {
    const envExample = readFileSync('.env.example', 'utf-8');
    for (const name of [
      'HAFLEET_API',
      'HAFLEET_SERVER',
      'HAFLEET_RUNTIME_DIR',
      'HAFLEET_BACKEND_PORT',
      'HAFLEET_WEB_PORT',
      'HAFLEET_WEB_URL',
      'HAFLEET_QUEUE_URL',
      'HAFLEET_HOMEDIR',
      'HAFLEET_DASHBOARD_TOKEN',
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
      'MCP_HEARTBEAT_INTERVAL_MS',
      'MCP_FETCH_TIMEOUT_MS',
      'MCP_FETCH_RETRIES',
      'MCP_FETCH_BACKOFF_MS',
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
