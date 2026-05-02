import { afterEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

function makeSeed(overrides = {}) {
  return {
    agents: {
      alpha: { name: 'alpha', type: 'agent', kind: 'agent', online: true },
      ...(overrides.agents || {}),
    },
    groups: {},
    messages: [],
    cursors: {},
    servers: {},
    agentRuntime: {},
    env: {
      AGENTCHAT_AGENT_TOKEN_MODE: 'hard',
      ...(overrides.env || {}),
    },
  };
}

function writeAgentToken(homeRoot, agentName, token) {
  const agentStateDir = path.join(homeRoot, 'agents', `agent_${agentName}`, 'state');
  mkdirSync(agentStateDir, { recursive: true });
  writeFileSync(path.join(agentStateDir, 'agent-token'), `${token}\n`);
}

describe('per-agent token authentication', () => {
  let context = null;
  let homeDir = null;

  afterEach(() => {
    context?.cleanup();
    context = null;
    if (homeDir) rmSync(homeDir, { recursive: true, force: true });
    homeDir = null;
  });

  test('non-agent senders (system) pass through in hard mode without a token', async () => {
    homeDir = mkdtempSync(path.join(os.tmpdir(), 'agent-token-test-'));
    context = await createBackendTestContext('agent-token-test-', makeSeed({
      env: {
        AGENTCHAT_AGENT_TOKEN_MODE: 'hard',
        AGENTCHAT_HOMEDIR: homeDir,
      },
    }));

    const systemMsg = await request(context.app)
      .post('/api/messages')
      .send({ from: 'system', to: 'alpha', type: 'inform', summary: 'sys', full: 'sys msg' });
    expect(systemMsg.status).toBe(200);
  });

  test('health reports missing managed agent tokens without flipping hard-mode compatibility', async () => {
    homeDir = mkdtempSync(path.join(os.tmpdir(), 'agent-token-test-'));
    writeAgentToken(homeDir, 'alpha', 'alpha-secret');

    context = await createBackendTestContext('agent-token-test-', makeSeed({
      agents: {
        alpha: { name: 'alpha', type: 'agent', kind: 'agent', online: true },
        beta: { name: 'beta', type: 'agent', kind: 'agent', online: true },
      },
      env: {
        AGENTCHAT_AGENT_TOKEN_MODE: 'hard',
        AGENTCHAT_HOMEDIR: homeDir,
      },
    }));

    const health = await request(context.app).get('/health').expect(200);
    expect(health.body.ok).toBe(true);
    expect(health.body.auth.agentTokens).toMatchObject({
      mode: 'hard',
      configuredMode: 'hard',
      behavior: 'enforce-loaded-tokens',
      managedAgentCount: 2,
      loadedManagedAgentTokenCount: 1,
      missingManagedAgentTokenCount: 1,
      missingManagedAgentNames: ['beta'],
      missingManagedAgentNamesTruncated: false,
      failClosedReady: false,
    });

    const betaMsg = await request(context.app)
      .post('/api/messages')
      .send({ from: 'beta', to: 'alpha', type: 'inform', summary: 'hi', full: 'hello' });
    expect(betaMsg.status).toBe(200);
  });

  test('soft mode currently enforces loaded agent tokens', async () => {
    homeDir = mkdtempSync(path.join(os.tmpdir(), 'agent-token-test-'));
    writeAgentToken(homeDir, 'alpha', 'test-secret-token');

    context = await createBackendTestContext('agent-token-test-', makeSeed({
      env: {
        AGENTCHAT_AGENT_TOKEN_MODE: 'soft',
        AGENTCHAT_HOMEDIR: homeDir,
      },
    }));

    const response = await request(context.app)
      .post('/api/messages')
      .send({ from: 'alpha', to: 'system', type: 'inform', summary: 'hi', full: 'hello' });
    expect(response.status).toBe(403);

    const health = await request(context.app).get('/health').expect(200);
    expect(health.body.auth.agentTokens).toMatchObject({
      mode: 'soft',
      configuredMode: 'soft',
      behavior: 'enforce-loaded-tokens',
      failClosedReady: true,
    });
  });

  test('off mode currently normalizes to audit compatibility', async () => {
    homeDir = mkdtempSync(path.join(os.tmpdir(), 'agent-token-test-'));
    writeAgentToken(homeDir, 'alpha', 'test-secret-token');

    context = await createBackendTestContext('agent-token-test-', makeSeed({
      env: {
        AGENTCHAT_AGENT_TOKEN_MODE: 'off',
        AGENTCHAT_HOMEDIR: homeDir,
      },
    }));

    const response = await request(context.app)
      .post('/api/messages')
      .send({ from: 'alpha', to: 'system', type: 'inform', summary: 'hi', full: 'hello' });
    expect(response.status).toBe(200);

    const health = await request(context.app).get('/health').expect(200);
    expect(health.body.auth.agentTokens).toMatchObject({
      mode: 'audit',
      configuredMode: 'off',
      behavior: 'log-only',
      failClosedReady: true,
    });
  });

  test('managed agent with correct token passes in hard mode', async () => {
    homeDir = mkdtempSync(path.join(os.tmpdir(), 'agent-token-test-'));
    writeAgentToken(homeDir, 'alpha', 'test-secret-token');

    context = await createBackendTestContext('agent-token-test-', makeSeed({
      env: {
        AGENTCHAT_AGENT_TOKEN_MODE: 'hard',
        AGENTCHAT_HOMEDIR: homeDir,
      },
    }));

    const response = await request(context.app)
      .post('/api/messages')
      .set('X-Agent-Token', 'test-secret-token')
      .send({ from: 'alpha', to: 'system', type: 'inform', summary: 'hi', full: 'hello' });
    expect(response.status).toBe(200);
  });

  test('managed agent without token is rejected in hard mode', async () => {
    homeDir = mkdtempSync(path.join(os.tmpdir(), 'agent-token-test-'));
    writeAgentToken(homeDir, 'alpha', 'test-secret-token');

    context = await createBackendTestContext('agent-token-test-', makeSeed({
      env: {
        AGENTCHAT_AGENT_TOKEN_MODE: 'hard',
        AGENTCHAT_HOMEDIR: homeDir,
      },
    }));

    const response = await request(context.app)
      .post('/api/messages')
      .send({ from: 'alpha', to: 'system', type: 'inform', summary: 'hi', full: 'hello' });
    expect(response.status).toBe(403);
    expect(response.body.error).toContain('token');
  });

  test('managed agent with wrong token is rejected in hard mode', async () => {
    homeDir = mkdtempSync(path.join(os.tmpdir(), 'agent-token-test-'));
    writeAgentToken(homeDir, 'alpha', 'test-secret-token');

    context = await createBackendTestContext('agent-token-test-', makeSeed({
      env: {
        AGENTCHAT_AGENT_TOKEN_MODE: 'hard',
        AGENTCHAT_HOMEDIR: homeDir,
      },
    }));

    const response = await request(context.app)
      .post('/api/messages')
      .set('X-Agent-Token', 'wrong-token')
      .send({ from: 'alpha', to: 'system', type: 'inform', summary: 'hi', full: 'hello' });
    expect(response.status).toBe(403);
    expect(response.body.error).toContain('mismatch');
  });
});
