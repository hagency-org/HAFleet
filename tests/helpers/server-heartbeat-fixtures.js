// Shared fixtures for the server-heartbeat suites.
//
// Extracted when api-server-heartbeat.test.js was split. That file created 47
// backend contexts, and each one retains ~12MB permanently (the test helper
// imports backend-v2.js with a unique cache-buster, which the ESM module
// registry never releases). ~564MB in a single file was enough, under shard
// concurrency, to get a worker recycled mid-run and leave a partially
// evaluated module whose express app was missing routes — surfacing as a valid
// route returning 404. Vitest frees each file's module graph, so splitting the
// file halves the peak. See docs/TESTING.md.

import request from 'supertest';
import { existsSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function serversPath(runtimeDir) {
  return path.join(runtimeDir, 'data', 'servers.json');
}

export function agentsPath(runtimeDir) {
  return path.join(runtimeDir, 'data', 'agents.json');
}

export function agentRuntimePath(runtimeDir) {
  return path.join(runtimeDir, 'data', 'agent_runtime.json');
}

export function systemInfoPath(runtimeDir) {
  return path.join(runtimeDir, 'data', 'system-info.jsonl');
}

export function readSystemInfo(runtimeDir) {
  const filePath = systemInfoPath(runtimeDir);
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, 'utf-8').trim();
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

export function makeAgent(name, overrides = {}) {
  return {
    name,
    type: 'agent',
    kind: 'agent',
    online: false,
    server: null,
    manualDown: false,
    offlineReason: null,
    ...overrides,
  };
}

export function baseSeed(overrides = {}) {
  return {
    agents: {
      'remote-agent': makeAgent('remote-agent', { server: 'remote-host-1' }),
      'local-agent': makeAgent('local-agent', { online: true, server: null }),
      ...(overrides.agents || {}),
    },
    groups: overrides.groups || {},
    messages: overrides.messages || [],
    cursors: overrides.cursors || {},
    servers: overrides.servers || {},
    agentRuntime: overrides.agentRuntime || {},
    env: {
      AGENT_HEARTBEAT_TTL_MS: '5000',
      AGENT_SERVER_SWEEP_INTERVAL_MS: '60000',
      AGENT_SERVER_MAINTENANCE_IDS: '',
      ...(overrides.env || {}),
    },
  };
}

export async function postHeartbeat(app, body) {
  return request(app).post('/api/servers/heartbeat').send(body);
}
