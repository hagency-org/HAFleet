import { afterEach, describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openRouter, runClaudeDispatch, runCodexDispatch } from '../router/dist/index.js';

const roots = [];
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function setup(framework, payload = { prompt: 'do the work' }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hafleet-runner-'));
  roots.push(root);
  const router = openRouter({ dbPath: path.join(root, 'router.db') });
  router.ingestMessage({
    messageId: 'root', roomId: '!room:test', matrixEventId: '$root',
    senderName: 'alex', recipientAgentId: 'agent-id', recipientAgentName: 'agent',
    normalizedBody: 'private thread constraint',
  });
  const intent = router.createTaskIntent({
    requestScope: 'test', requestKey: 'runner', roomId: '!room:test',
    threadRootEventId: '$root', rootMessageId: 'root', inputMessageIds: ['root'],
    task: { title: 'Runner task', assigneeAgentId: 'agent-id', assigneeName: 'agent' },
  });
  const command = router.claimMatrixCommand();
  const active = router.recordMatrixDelivery({ commandId: command.commandId, claimToken: command.claimToken, eventId: '$anchor' });
  router.registerWorkspace({ resourceId: 'workspace', safeLabel: 'workspace', backendPath: root });
  const queued = router.enqueueDispatch({
    sessionId: active.sessionId, taskId: intent.taskId, framework, localServerId: 'local',
    mayWrite: true, workspaceResourceId: 'workspace', payload,
  });
  const claim = router.claimDispatch({ runnerId: 'runner', leaseMs: 60_000, capabilityTtlMs: 60_000, maxLiveRunners: 8 });
  return { root, router, queued, claim };
}

// A front-desk dispatch: no task, no lease, mayWrite:false. Used to prove the
// runtime is actually launched read-only, not merely flagged so.
function setupFrontDesk(framework, payload = { prompt: 'just asking' }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hafleet-runner-fd-'));
  roots.push(root);
  const router = openRouter({ dbPath: path.join(root, 'router.db') });
  const ingested = router.ingestMessage({
    messageId: 'fd-root', roomId: '!room:test', matrixEventId: '$fd-root',
    senderName: 'alex', recipientAgentId: 'agent-id', recipientAgentName: 'agent',
    normalizedBody: 'front desk question',
  });
  router.registerWorkspace({ resourceId: 'fd-workspace', safeLabel: 'workspace', backendPath: root });
  const queued = router.enqueueDispatch({
    sessionId: ingested.session.sessionId, framework, localServerId: 'local',
    mayWrite: false, workspaceResourceId: 'fd-workspace', payload,
  });
  const claim = router.claimDispatch({ runnerId: 'fd-runner', leaseMs: 60_000, capabilityTtlMs: 60_000, maxLiveRunners: 8 });
  return { root, router, queued, claim };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('structured one-shot runners', () => {
  test('runner guardian terminates its runtime when backend ownership disappears', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'hafleet-runner-guardian-'));
    roots.push(root);
    const pidFile = path.join(root, 'runtime.pid');
    const guardian = spawn(process.execPath, [path.join(process.cwd(), 'router', 'dist', 'runner-guardian.js')], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        FAKE_CLAUDE_HANG: '1',
        FAKE_CLAUDE_PID_FILE: pidFile,
        HAFLEET_GUARDIAN_EXECUTABLE: path.join(fixtures, 'fake-claude-runner.mjs'),
        HAFLEET_GUARDIAN_ARGS_JSON: '[]',
      },
      stdio: ['pipe', 'ignore', 'pipe', 'ipc'],
    });
    try {
      await new Promise((resolve, reject) => {
        guardian.once('error', reject);
        guardian.once('message', resolve);
      });
      for (let attempt = 0; attempt < 100 && !existsSync(pidFile); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const runtimePid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
      expect(runtimePid).toBeGreaterThan(0);
      guardian.disconnect();
      await new Promise((resolve) => guardian.once('exit', resolve));
      expect(() => process.kill(runtimePid, 0)).toThrow();
    } finally {
      if (guardian.exitCode === null && guardian.signalCode === null) guardian.kill('SIGKILL');
    }
  });

  test('Codex native approval is durably applied before the exact request resumes', async () => {
    const { root, router, queued, claim } = setup('codex');
    const ownerRequests = [];
    const completion = await runCodexDispatch({
      router,
      claim,
      cwd: root,
      executable: path.join(fixtures, 'fake-codex-app-server.mjs'),
      env: { FAKE_CODEX_REQUIRE_MCP_CONFIG: '1', HAFLEET_EPHEMERAL_RUNNER: '1' },
      approvalTimeoutMs: 60_000,
      mcpServer: {
        name: 'hafleet', command: process.execPath,
        args: ['/opt/hafleet/mcp-server.js'],
        envVars: ['AGENT_NAME', 'HAFLEET_DISPATCH_CAPABILITY', 'HAFLEET_EPHEMERAL_RUNNER'],
      },
      maxParkedRunners: 4,
      requestOwnerApproval: async (request) => {
        ownerRequests.push(request);
        expect(router.db.prepare('SELECT state FROM dispatches WHERE dispatch_id=?').get(queued.dispatchId).state).toBe('parked');
        expect(router.db.prepare('SELECT COUNT(*) count FROM approval_inbox').get().count).toBe(0);
        return { decisionEventId: 'owner-decision-1', decision: 'allow' };
      },
    });
    expect(completion).toMatchObject({ state: 'completed', text: 'approved result' });
    expect(ownerRequests).toHaveLength(1);
    expect(ownerRequests[0]).toMatchObject({
      upstreamThreadId: 'thread-fake', upstreamTurnId: 'turn-fake',
      upstreamItemId: 'item-command', upstreamRequestId: '91',
    });
    expect(router.db.prepare('SELECT COUNT(*) count FROM approval_inbox').get().count).toBe(1);
    const reply = router.claimReplyCommand();
    expect(reply).toMatchObject({ dispatchId: queued.dispatchId, roomId: '!room:test', threadRootEventId: '$root', body: 'approved result' });
    router.close();
  });

  test('Codex approval with a mismatched upstream thread fails closed without owner forwarding', async () => {
    const { root, router, claim } = setup('codex');
    let ownerCalls = 0;
    const completion = await runCodexDispatch({
      router,
      claim,
      cwd: root,
      executable: path.join(fixtures, 'fake-codex-app-server.mjs'),
      env: { FAKE_CODEX_WRONG_THREAD: '1' },
      approvalTimeoutMs: 60_000,
      maxParkedRunners: 4,
      requestOwnerApproval: async () => {
        ownerCalls += 1;
        return { decisionEventId: 'must-not-run', decision: 'allow' };
      },
    });
    expect(ownerCalls).toBe(0);
    expect(completion).toMatchObject({ state: 'completed', text: 'denied result' });
    expect(router.db.prepare('SELECT COUNT(*) count FROM approval_inbox').get().count).toBe(0);
    router.close();
  });

  test('Codex app-server immediate exit rejects without an unhandled rejection', async () => {
    const { root, router, queued, claim } = setup('codex');
    await expect(runCodexDispatch({
      router,
      claim,
      cwd: root,
      executable: path.join(fixtures, 'fake-codex-app-server.mjs'),
      env: { FAKE_CODEX_EXIT_IMMEDIATELY: '1' },
      approvalTimeoutMs: 60_000,
      maxParkedRunners: 4,
      requestOwnerApproval: async () => ({ decisionEventId: 'must-not-run', decision: 'deny' }),
    })).rejects.toThrow();
    // Let Node's unhandled-rejection checkpoint run before closing the store.
    await new Promise((resolve) => setImmediate(resolve));
    expect(router.db.prepare('SELECT state, effect_ack_at FROM dispatches WHERE dispatch_id = ?')
      .get(queued.dispatchId)).toMatchObject({ state: 'leased', effect_ack_at: null });
    router.close();
  });

  test('test_reply_lands_in_origin_thread_without_runner_target_field', async () => {
    const { root, router, claim } = setup('claude');
    const completion = await runClaudeDispatch({
      router,
      claim,
      cwd: root,
      executable: path.join(fixtures, 'fake-claude-runner.mjs'),
    });
    expect(completion).toMatchObject({ state: 'completed', text: 'received:true' });
    const reply = router.claimReplyCommand();
    expect(reply).toMatchObject({ roomId: '!room:test', threadRootEventId: '$root' });
    expect(reply).not.toHaveProperty('replyTarget');
    router.close();
  });

  test('one-shot runner environment excludes backend operator and bridge credentials', async () => {
    const { root, router, claim } = setup('claude');
    const prior = {
      API_TOKEN: process.env.API_TOKEN,
      MATRIX_BRIDGE_SECRET: process.env.MATRIX_BRIDGE_SECRET,
      HAFLEET_DASHBOARD_TOKEN: process.env.HAFLEET_DASHBOARD_TOKEN,
    };
    process.env.API_TOKEN = 'must-not-reach-runner';
    process.env.MATRIX_BRIDGE_SECRET = 'must-not-reach-runner';
    process.env.HAFLEET_DASHBOARD_TOKEN = 'must-not-reach-runner';
    try {
      const completion = await runClaudeDispatch({
        router,
        claim,
        cwd: root,
        executable: path.join(fixtures, 'fake-claude-runner.mjs'),
        env: {
          FAKE_CLAUDE_REPORT_ENV: '1',
          API_TOKEN: 'must-also-be-filtered-from-explicit-env',
          MATRIX_BRIDGE_SECRET: 'must-also-be-filtered-from-explicit-env',
        },
      });
      expect(completion).toMatchObject({ state: 'completed', text: 'env:clean' });
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      router.close();
    }
  });

  test('test_killed_runner_settles_outcome_unknown_without_auto_retry', async () => {
    const { root, router, queued, claim } = setup('claude');
    await expect(runClaudeDispatch({
      router,
      claim,
      cwd: root,
      executable: path.join(fixtures, 'fake-claude-runner.mjs'),
      env: { FAKE_CLAUDE_FAIL: '1' },
    })).resolves.toMatchObject({ state: 'outcome_unknown', exitCode: 17 });
    expect(router.db.prepare('SELECT state FROM dispatches WHERE dispatch_id=?').get(queued.dispatchId).state).toBe('outcome_unknown');
    expect(router.claimDispatch({ runnerId: 'retry', leaseMs: 1000, capabilityTtlMs: 1000, maxLiveRunners: 8 })).toBeNull();
    expect(router.claimReplyCommand()).toMatchObject({
      dispatchId: queued.dispatchId,
      threadRootEventId: '$root',
      body: expect.stringMatching(/inspect the workspace/i),
    });
    router.close();
  });

  test('test_delivery_effect_requires_verified_child_stdin_ack', async () => {
    const { root, router, queued, claim } = setup('claude', { prompt: 'x'.repeat(2_000_000) });
    await expect(runClaudeDispatch({
      router,
      claim,
      cwd: root,
      executable: path.join(fixtures, 'fake-claude-runner.mjs'),
      env: { FAKE_CLAUDE_CLOSE_STDIN: '1' },
      acknowledgementTimeoutMs: 2_000,
    })).rejects.toThrow();
    expect(router.db.prepare('SELECT state, effect_ack_at FROM dispatches WHERE dispatch_id = ?')
      .get(queued.dispatchId)).toMatchObject({ state: 'outcome_unknown', effect_ack_at: null });
    expect(router.claimDispatch({
      runnerId: 'must-not-retry', leaseMs: 1_000, capabilityTtlMs: 1_000, maxLiveRunners: 8,
    })).toBeNull();
    router.close();
  });

  // Effect test, not bookkeeping: the rejected prototype's failure mode was
  // "flag correct, runtime unaffected." Here the fake app-server records the
  // sandbox it was actually asked for, at BOTH the thread and turn level, and
  // we assert a front-desk (no-lease) dispatch is confined to read-only at both.
  test('a front-desk Codex dispatch is launched read-only at thread and turn level', async () => {
    const { root, router, claim } = setupFrontDesk('codex');
    expect(claim).not.toBeNull();
    const sandboxLog = path.join(root, 'sandbox.log');
    await runCodexDispatch({
      router,
      claim,
      cwd: root,
      executable: path.join(fixtures, 'fake-codex-app-server.mjs'),
      env: { FAKE_CODEX_SANDBOX_LOG: sandboxLog, HAFLEET_EPHEMERAL_RUNNER: '1' },
      approvalTimeoutMs: 60_000,
      mcpServer: {
        name: 'hafleet', command: process.execPath,
        args: ['/opt/hafleet/mcp-server.js'],
        envVars: ['AGENT_NAME', 'HAFLEET_DISPATCH_CAPABILITY', 'HAFLEET_EPHEMERAL_RUNNER'],
      },
      maxParkedRunners: 4,
      requestOwnerApproval: async () => ({ decisionEventId: 'd', decision: 'deny' }),
    }).catch(() => {});

    const entries = readFileSync(sandboxLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const thread = entries.find((e) => e.level === 'thread');
    const turn = entries.find((e) => e.level === 'turn');
    // Spellings are asymmetric on purpose and match the real codex app-server
    // schema: thread/start's `sandbox` is the kebab-case SandboxMode string,
    // turn/start's `sandboxPolicy` is the camelCase-typed object.
    expect(thread?.value).toBe('read-only');
    expect(turn?.value).toMatchObject({ type: 'readOnly' });
    // A dispatch without a lease must never request writes, in either spelling.
    expect(JSON.stringify(entries)).not.toContain('workspace-write');
    expect(JSON.stringify(entries)).not.toContain('workspaceWrite');
    router.close();
  });
});
