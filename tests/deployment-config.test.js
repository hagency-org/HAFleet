import { describe, expect, test } from 'vitest';
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
