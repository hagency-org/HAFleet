import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import {
  BLOCK_PATTERNS,
  BLOCK_TIER_HARD,
  BLOCK_TIER_SOFT,
  BLOCK_TIER_TRANSIENT,
} from '../lib/blocked-patterns.js';
import {
  evaluateCondition,
  getNestedValue,
  normalizeNodes,
} from '../lib/task-graph.js';

function writeJson(filePath, value) {
  writeFileSync(filePath, JSON.stringify(value, null, 2));
}

async function importBackend(seed = {}) {
  const runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'agent-chat-normalization-test-'));
  const dataDir = path.join(runtimeDir, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeJson(path.join(dataDir, 'agents.json'), seed.agents || {});
  writeJson(path.join(dataDir, 'groups.json'), seed.groups || {});
  writeJson(path.join(dataDir, 'messages.json'), seed.messages || []);
  writeJson(path.join(dataDir, 'cursors.json'), seed.cursors || {});
  writeJson(path.join(dataDir, 'servers.json'), seed.servers || {});
  writeJson(path.join(dataDir, 'agent_runtime.json'), seed.agentRuntime || {});
  writeJson(path.join(dataDir, 'supervisor_state.json'), seed.supervisorState || { agents: {}, selectionCursor: 0 });
  writeJson(path.join(dataDir, 'local_activity_sweep.json'), { selectionCursor: 0 });
  writeJson(path.join(dataDir, '.msg_counter'), 0);

  process.env.AGENT_CHAT_RUNTIME_DIR = runtimeDir;
  process.env.SUPERVISOR_ENABLED = 'false';
  process.env.AGENT_SCOPE_MONITOR_ENABLED = 'false';
  process.env.AGENT_JSON_WRITE_BATCH_MS = '0';

  const backendUrl = pathToFileURL(path.resolve('backend-v2.js')).href;
  const cacheBust = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const module = await import(`${backendUrl}?normalization=${cacheBust}`);
  return { runtimeDir, module };
}

describe('normalization helpers', () => {
  let runtimeDir = null;

  afterEach(() => {
    if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true });
    runtimeDir = null;
  });

  test('normalizeAgentName uses canonical stored casing and trims whitespace', async () => {
    const imported = await importBackend({
      agents: {
        Alpha: { name: 'Alpha', kind: 'agent', online: true, server: null },
      },
    });
    runtimeDir = imported.runtimeDir;
    const { normalizeAgentName } = imported.module;

    expect(normalizeAgentName(' alpha ')).toBe('Alpha');
    expect(normalizeAgentName('Unknown-Agent')).toBe('Unknown-Agent');
    expect(normalizeAgentName('')).toBe(null);
    expect(normalizeAgentName(null)).toBe(null);
  });

  test('mergeHumanMeta preserves existing fields and applies explicit owner updates', async () => {
    const imported = await importBackend();
    runtimeDir = imported.runtimeDir;
    const { mergeHumanMeta } = imported.module;

    expect(mergeHumanMeta({ owner: 'alice', notes: 'keep me' }, undefined)).toEqual({ owner: 'alice', notes: 'keep me' });
    expect(mergeHumanMeta({ owner: 'alice', notes: 'keep me' }, { owner: ' bob ' })).toEqual({ owner: 'bob', notes: 'keep me' });
    expect(mergeHumanMeta({ owner: 'alice' }, { owner: null })).toEqual({ owner: null });
  });

  test('normalizeAgentTask rejects invalid waiting declarations', async () => {
    const imported = await importBackend({
      agents: {
        alpha: { name: 'alpha', kind: 'agent', online: true, server: null },
      },
    });
    runtimeDir = imported.runtimeDir;
    const { normalizeAgentTask } = imported.module;

    expect(normalizeAgentTask({
      id: 'task-1',
      owner: 'alpha',
      status: 'waiting',
      updated_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      waiting_reason: 'need review',
    }, 'alpha')).toBe(null);

    expect(normalizeAgentTask({
      id: 'task-1',
      owner: 'alpha',
      status: 'active',
      updated_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
    }, 'alpha')).toMatchObject({ id: 'task-1', owner: 'alpha', status: 'active' });
  });

  test('serializeAgent derives online state from server liveness and normalizes nested fields', async () => {
    const imported = await importBackend({
      agents: {
        alpha: {
          name: 'alpha',
          kind: 'agent',
          online: true,
          server: 'relay-west',
          manualDown: false,
          human: { owner: ' Alice ', notes: 'hidden legacy' },
          managedProjects: [{ name: 'proj', path: '/tmp/proj', source: 'cli' }],
          task: {
            id: 'task-1',
            owner: 'alpha',
            status: 'active',
            updated_at: new Date().toISOString(),
            heartbeat_at: new Date().toISOString(),
          },
        },
      },
      servers: {
        'relay-west': {
          id: 'relay-west',
          online: false,
          lastSeen: 1234,
          heartbeatAt: 0,
        },
      },
      agentRuntime: {
        alpha: {
          blocked: true,
          blockedReason: 'interactive-confirm',
          blockedTier: 1,
          activeNow: true,
          activeDurationSec: 12,
          idleDurationSec: 0,
          workspacePath: '/tmp/work',
          mcpPresent: false,
          mcpMissingSince: 4567,
        },
      },
    });
    runtimeDir = imported.runtimeDir;
    const { serializeAgent } = imported.module;

    const serialized = serializeAgent({
      name: 'alpha',
      kind: 'agent',
      online: true,
      server: 'relay-west',
      manualDown: false,
      human: { owner: ' Alice ', notes: 'legacy' },
      managedProjects: [{ name: 'proj', path: '/tmp/proj', source: 'cli' }],
      task: {
        id: 'task-1',
        owner: 'alpha',
        status: 'active',
        updated_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString(),
      },
    });

    expect(serialized.online).toBe(false);
    expect(serialized.serverOnline).toBe(false);
    expect(serialized.blocked).toBe(true);
    expect(serialized.blockedTier).toBe(1);
    expect(serialized.human).toEqual({ owner: 'Alice' });
    expect(serialized.managedProjects).toEqual([{ name: 'proj', path: '/tmp/proj', source: 'cli', originPath: null }]);
    expect(serialized.task).toMatchObject({ id: 'task-1', owner: 'alpha', status: 'active' });
    expect(serialized.workspacePath).toBe('/tmp/work');
    expect(serialized.mcpPresent).toBe(false);
  });

  test('normalizeNodes rejects missing deps, self deps, and cycles', () => {
    expect(() => normalizeNodes({
      a: { assignee: 'alpha', description: 'A', depends_on: ['missing'] },
    })).toThrow(/depends on missing node/);

    expect(() => normalizeNodes({
      a: { assignee: 'alpha', description: 'A', depends_on: ['a'] },
    })).toThrow(/cannot depend on itself/);

    expect(() => normalizeNodes({
      a: { assignee: 'alpha', description: 'A', depends_on: ['b'] },
      b: { assignee: 'beta', description: 'B', depends_on: ['a'] },
    })).toThrow(/dependency cycle detected/);
  });

  test('getNestedValue traverses plain paths and blocks dangerous prototype segments', () => {
    expect(getNestedValue({ a: { b: 3 } }, 'a.b')).toBe(3);
    expect(getNestedValue({ a: { b: 3 } }, 'a.c')).toBe(undefined);
    expect(getNestedValue({}, '__proto__.toString')).toBe(undefined);
    expect(getNestedValue({}, 'constructor.prototype')).toBe(undefined);
  });

  test('evaluateCondition handles equality, waiting deps, failed deps, and guarded paths', () => {
    const graph = {
      nodes: {
        a: { status: 'complete', result: { value: 7 } },
        b: { status: 'pending', result: null },
        c: { status: 'failed', result: null },
      },
    };

    expect(evaluateCondition(graph, {
      depends_on: ['a'],
      condition: { dep: 'a', path: 'value', eq: 7 },
    })).toBe(true);

    expect(evaluateCondition(graph, {
      depends_on: ['a'],
      condition: { dep: 'a', path: 'value', neq: 7 },
    })).toBe(false);

    expect(evaluateCondition(graph, {
      depends_on: ['b'],
      condition: { dep: 'b', path: 'value', eq: 1 },
    })).toBe(null);

    expect(evaluateCondition(graph, {
      depends_on: ['c'],
      condition: { dep: 'c', path: 'value', eq: 1 },
    })).toBe(false);

    expect(evaluateCondition(graph, {
      depends_on: ['a'],
      condition: { dep: 'a', path: '__proto__.toString' },
    })).toBe(false);
  });

  test('blocked patterns retain intended tiers and match representative prompts', () => {
    const byReason = new Map(BLOCK_PATTERNS.map((pattern) => [pattern.reason, pattern]));

    expect(byReason.get('plan-mode')?.tier).toBe(BLOCK_TIER_TRANSIENT);
    expect(byReason.get('interactive-confirm')?.tier).toBe(BLOCK_TIER_SOFT);
    expect(byReason.get('update-required')?.tier).toBe(BLOCK_TIER_HARD);

    expect(byReason.get('plan-mode')?.re.test('1. Plan mode')).toBe(true);
    expect(byReason.get('approval-mode-toggle')?.re.test('Bypass permissions on (Shift+Tab to cycle)')).toBe(true);
    expect(byReason.get('interactive-confirm')?.re.test('Press enter to continue')).toBe(true);
    expect(byReason.get('update-required')?.re.test('Updates available: run agent-update now')).toBe(true);
  });
});
