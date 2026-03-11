import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { SupervisorService } from '../supervisor/index.js';

function iso(msOffset) {
  return new Date(Date.now() + msOffset).toISOString();
}

function makeConfig(tempDir, overrides = {}) {
  return {
    enabled: true,
    disabledReason: null,
    intervalMs: 60_000,
    heartbeatTtlMs: 30_000,
    trailingHeartbeatPeriods: 5,
    trailingWindowMs: 150_000,
    matrixInfoGroup: 'info',
    matrixMentions: [],
    agentAllowlist: null,
    maxAgentsPerSweep: 50,
    stateFile: path.join(tempDir, 'supervisor-state.json'),
    logFile: path.join(tempDir, 'supervisor-log.jsonl'),
    warnAfter: 2,
    warnCooldownMs: 0,
    eventHistoryLimit: 50,
    llm: {
      provider: 'openai',
      model: 'gpt-4.1-mini',
      endpoint: 'https://api.openai.com/v1/chat/completions',
      profileSource: 'test',
    },
    ...overrides,
  };
}

function makeService(tempDir, overrides = {}) {
  const sent = [];
  const infos = [];
  const killed = [];
  const started = [];
  const service = new SupervisorService({
    config: makeConfig(tempDir, overrides.config || {}),
    getAgents: overrides.getAgents || (() => []),
    getRuntime: overrides.getRuntime || (() => ({})),
    emitSystemInfo: (summary, full) => infos.push({ summary, full }),
    sendMessage: (payload) => {
      sent.push(payload);
      return { ok: true };
    },
    listTmuxSessions: overrides.listTmuxSessions || (() => []),
    killTmuxSession: (sessionName) => {
      killed.push(sessionName);
      return true;
    },
    tmuxSessionExists: overrides.tmuxSessionExists || (() => false),
    tmuxPanePath: overrides.tmuxPanePath || (() => null),
    startSupervisorTmuxSession: (sessionName, workspaceDir, command) => {
      started.push({ sessionName, workspaceDir, command });
      return true;
    },
  });
  return { service, sent, infos, killed, started };
}

describe('supervisor observation loop', () => {
  let tempDir = null;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  test('stalled wait classification sends a nudge after the threshold', () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'agent-chat-supervisor-loop-test-'));
    const agent = {
      name: 'alpha',
      kind: 'agent',
      server: null,
      task: {
        id: 'task-1',
        owner: 'alpha',
        status: 'waiting',
        updated_at: iso(-5_000),
        heartbeat_at: iso(-5_000),
        waiting_reason: 'waiting on review',
        waiting_until: iso(-1_000),
      },
    };
    const { service, sent, infos } = makeService(tempDir, {
      getAgents: () => [agent],
      getRuntime: () => ({ activeNow: false, idleDurationSec: 5 }),
    });

    service.runSweep();
    service.runSweep();

    expect(service.getAgentDetail('alpha').latest.status).toBe('stalled_wait');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: 'alpha',
      priority: 'high',
      schema: {
        kind: 'escalation',
        payload: { level: 'nudge', agent: 'alpha', count: 2 },
      },
    });
    expect(infos).toHaveLength(1);
    expect(infos[0].summary).toContain('Supervisor warning: alpha stalled_wait');
  });

  test('blocked agents escalate after the third consecutive negative observation', () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'agent-chat-supervisor-loop-test-'));
    const agent = {
      name: 'alpha',
      kind: 'agent',
      server: null,
      task: {
        id: 'task-1',
        owner: 'alpha',
        status: 'blocked',
        updated_at: iso(-3_000),
        heartbeat_at: iso(-3_000),
        waiting_reason: null,
        waiting_until: null,
      },
    };
    const { service, sent } = makeService(tempDir, {
      getAgents: () => [agent],
      getRuntime: () => ({ blocked: true, blockedReason: 'interactive-confirm', activeNow: false }),
    });

    service.runSweep();
    service.runSweep();
    service.runSweep();

    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      to: 'alpha',
      priority: 'high',
      schema: { payload: { level: 'nudge', count: 2 } },
    });
    expect(sent[1]).toMatchObject({
      to: 'ac-topleader',
      priority: 'urgent',
      schema: { payload: { level: 'escalate', count: 3, agent: 'alpha' } },
    });
  });

  test('runSweep excludes remote agents from observation and intervention', () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'agent-chat-supervisor-loop-test-'));
    process.env.AGENT_CHAT_SERVER = 'devbox';
    const localAgent = {
      name: 'alpha',
      kind: 'agent',
      server: 'devbox',
      task: {
        id: 'task-local',
        owner: 'alpha',
        status: 'blocked',
        updated_at: iso(-2_000),
        heartbeat_at: iso(-2_000),
        waiting_reason: null,
        waiting_until: null,
      },
    };
    const remoteAgent = {
      name: 'beta',
      kind: 'agent',
      server: 'remote-host',
      task: {
        id: 'task-remote',
        owner: 'beta',
        status: 'blocked',
        updated_at: iso(-2_000),
        heartbeat_at: iso(-2_000),
        waiting_reason: null,
        waiting_until: null,
      },
    };
    const { service, sent } = makeService(tempDir, {
      getAgents: () => [localAgent, remoteAgent],
      getRuntime: () => ({ blocked: true, activeNow: false }),
    });

    service.runSweep();
    service.runSweep();

    const summaries = service.getAgentSummaries();
    expect(summaries.map((row) => row.agent)).toEqual(['alpha']);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('alpha');
  });

  test('startup cleans orphan supervisor tmux sessions before the first sweep', () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'agent-chat-supervisor-loop-test-'));
    const { service, killed } = makeService(tempDir, {
      getAgents: () => [],
      listTmuxSessions: () => ['supervisor-known', 'supervisor-orphan', 'alpha', 'supervisor-extra'],
    });
    service.stateStore.agents.alpha = {
      runtimeLaunch: {
        sessionName: 'supervisor-known',
      },
    };

    service.start();
    service.stop();

    expect(killed).toEqual(['supervisor-orphan', 'supervisor-extra']);
  });
});
