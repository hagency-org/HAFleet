import { describe, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import {
  approvalHookTimeoutSeconds,
  awaitRuntimeApproval,
  claudeChannelServerOptions,
  consumeRuntimeApproval,
  failClosedRuntimeApproval,
  resolveAndConsumeRuntimeApproval,
} from '../lib/runtime-approval-client.js';
import {
  buildCodexApprovalRequest,
  buildCodexHookDecision,
  codexPermissionRequestNeedsOwnerApproval,
  runCodexPermissionHook,
} from '../lib/codex-permission-hook.js';
import {
  buildCodexApprovalHookCommand,
  buildCodexApprovalHookToml,
  compareVersions,
  isCodexAppServerResponse,
  parseCodexVersion,
  preflightCodexPermissionHook,
  sha256File,
} from '../lib/codex-hook-trust.js';

describe('supported runtime approval adapters', () => {
  test('Claude MCP channel declares both channel and permission capabilities', () => {
    expect(claudeChannelServerOptions(true)).toMatchObject({
      capabilities: {
        experimental: {
          'claude/channel': {},
          'claude/channel/permission': {},
        },
      },
    });
    expect(claudeChannelServerOptions(false)).toBeUndefined();
  });

  test('Claude adapter waits for one server-authorized decision', async () => {
    const pending = {
      id: 'approval_0123456789abcdef0123456789abcdef',
      status: 'pending',
      expires_at: 10_000,
      input_digest: 'a'.repeat(64),
    };
    const api = vi.fn().mockResolvedValue({
      approval: { ...pending, status: 'approved', decision: 'allow' },
    });

    const outcome = await awaitRuntimeApproval({
      api,
      approval: pending,
      agent: 'wf_coordinator',
      pollIntervalMs: 1,
      sleep: vi.fn().mockResolvedValue(undefined),
      now: () => 100,
    });

    expect(outcome).toMatchObject({ behavior: 'allow', approval: { status: 'approved' } });
    expect(api).toHaveBeenCalledWith('GET', `/api/approvals/${pending.id}`);
  });

  test('missing owner denial is relayed as deny without polling', async () => {
    const api = vi.fn();
    const approval = {
      id: 'approval_0123456789abcdef0123456789abcdef',
      status: 'denied',
      decision: 'deny',
      denial_reason: 'owner_binding_missing',
      expires_at: 10_000,
    };

    const outcome = await awaitRuntimeApproval({ api, approval, agent: 'unbound', now: () => 100 });

    expect(outcome).toMatchObject({ behavior: 'deny' });
    expect(api).not.toHaveBeenCalled();
  });

  test('consumption binds agent and digest', async () => {
    const api = vi.fn().mockResolvedValue({ ok: true });
    const approval = {
      id: 'approval_0123456789abcdef0123456789abcdef',
      input_digest: 'b'.repeat(64),
    };

    await consumeRuntimeApproval(api, approval, 'wf_coordinator');

    expect(api).toHaveBeenCalledWith('POST', `/api/approvals/${approval.id}/consume`, {
      agent: 'wf_coordinator',
      input_digest: approval.input_digest,
    });
  });

  test('runtime_approval_failure_is_delivered_as_explicit_deny', async () => {
    /*
     * REQ-OWNER-UI-APPROVAL-BACKGROUND, the Claude side of "request-time transport failures MUST
     * produce an explicit runtime denial". The backend throws and the outcome is a deny with a
     * named reason rather than a thrown error, because an error propagating out of the channel
     * handler is what leaves Claude sitting on its own native prompt inside tmux where nobody
     * is watching. The three source assertions at the end pin the caller: mcp-server-core
     * forwards `outcome.behavior` and no longer contains the string that used to accompany the
     * old fall-back-to-native path.
     */
    const onError = vi.fn();
    const outcome = await failClosedRuntimeApproval(
      async () => {
        throw new Error('backend unavailable');
      },
      { onError },
    );

    expect(outcome).toEqual({
      behavior: 'deny',
      approval: null,
      denial_reason: 'approval_channel_failed',
    });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'backend unavailable' }));

    const mcpSource = readFileSync('lib/mcp-server-core.js', 'utf8');
    expect(mcpSource).toContain('behavior: outcome.behavior');
    expect(mcpSource).toContain('denying unattended request');
    expect(mcpSource).not.toContain('native approval remains active');
  });

  test('authorized runtime result is consumed before delivery', async () => {
    /*
     * REQ-OWNER-UI-APPROVAL-CONSUME, Claude side. The approval is already `approved` when the
     * adapter sees it, and the assertion that matters is `calls` — the consume POST is the only
     * request made, and it happens before the allow is returned. Delivering the allow first and
     * consuming afterwards would leave a window where the same approved verdict could be
     * consumed twice, which is the atomicity this statement is about.
     */
    const calls = [];
    const approval = {
      id: 'approval_0123456789abcdef0123456789abcdef',
      status: 'approved',
      decision: 'allow',
      input_digest: 'c'.repeat(64),
      expires_at: 10_000,
    };
    const api = vi.fn(async (method, apiPath) => {
      calls.push(`${method} ${apiPath}`);
      return { ok: true };
    });

    const outcome = await resolveAndConsumeRuntimeApproval({
      api,
      approval,
      agent: 'wf_coordinator',
      now: () => 100,
    });

    expect(outcome.behavior).toBe('allow');
    expect(calls).toEqual([`POST /api/approvals/${approval.id}/consume`]);
  });

  test('Codex PermissionRequest maps to documented hook output', () => {
    const request = buildCodexApprovalRequest({
      turn_id: 'turn-123',
      tool_name: 'Bash',
      tool_input: { command: 'gh issue create', description: 'Create issue' },
    }, 'wf_coordinator', 'robrix2');

    expect(request).toMatchObject({
      agent: 'wf_coordinator',
      runtime: 'codex',
      project: 'robrix2',
      tool_name: 'Bash',
      description: 'Create issue',
    });
    expect(request.upstream_request_id).toMatch(/^turn-123:Bash:[0-9a-f]{24}$/);
    expect(buildCodexHookDecision('allow')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    });
    expect(buildCodexHookDecision('deny', 'owner denied')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'owner denied' },
      },
    });
  });

  test('codex_internal_coordination_tools_are_allowed_without_recursive_approval', async () => {
    /*
     * REQ-OWNER-UI-APPROVAL-CODEX-COORDINATION, all three of its clauses, and the exemption is
     * bounded in both directions below. Allowed: the exact named hafleet coordination tools, and
     * send_message/post while `attachments` is absent or empty. Still owner-gated: the same
     * send_message once it carries a file path, Bash, an unrelated MCP filesystem read, and
     * `mcp__hafleet__unknown` — the last one is what makes this a whitelist rather than a
     * namespace exemption a future tool would silently inherit. The live hook run at the end
     * closes the loop: check_inbox returns allow with `api` never called, so no approval request
     * was created for the call that was blocking the agent from reading its own inbox.
     */
    const safeToolNames = [
      'whoami',
      'check_inbox',
      'check_group',
      'list_tasks',
      'get_task',
      'accept_task',
      'transition_task',
      'comment_task',
      'update_task_execution',
    ];
    for (const toolName of safeToolNames) {
      expect(codexPermissionRequestNeedsOwnerApproval({
        tool_name: `mcp__hafleet__${toolName}`,
        tool_input: {},
      })).toBe(false);
    }
    for (const toolName of ['send_message', 'post']) {
      expect(codexPermissionRequestNeedsOwnerApproval({
        tool_name: `mcp__hafleet__${toolName}`,
        tool_input: { summary: 'text only' },
      })).toBe(false);
      expect(codexPermissionRequestNeedsOwnerApproval({
        tool_name: `mcp__hafleet__${toolName}`,
        tool_input: { summary: 'text only', attachments: [] },
      })).toBe(false);
      expect(codexPermissionRequestNeedsOwnerApproval({
        tool_name: `mcp__hafleet__${toolName}`,
        tool_input: { attachments: [{ path: '/private/file.txt' }] },
      })).toBe(true);
    }
    expect(codexPermissionRequestNeedsOwnerApproval({
      tool_name: 'Bash',
      tool_input: { command: 'gh issue create' },
    })).toBe(true);
    expect(codexPermissionRequestNeedsOwnerApproval({
      tool_name: 'mcp__filesystem__read_file',
      tool_input: { path: '/private/file.txt' },
    })).toBe(true);
    expect(codexPermissionRequestNeedsOwnerApproval({
      tool_name: 'mcp__hafleet__unknown',
      tool_input: {},
    })).toBe(true);

    const temporary = mkdtempSync(path.join(os.tmpdir(), 'hafleet-codex-internal-hook-'));
    try {
      const hookPath = path.join(temporary, 'hook.js');
      writeFileSync(hookPath, 'trusted hook contents\n');
      const api = vi.fn();
      const stdout = { value: '', write(chunk) { this.value += chunk; } };
      const decision = await runCodexPermissionHook({
        stdin: Readable.from([JSON.stringify({
          hook_event_name: 'PermissionRequest',
          turn_id: 'turn-inbox',
          tool_name: 'mcp__hafleet__check_inbox',
          tool_input: {},
        })]),
        stdout,
        stderr: { write() {} },
        env: {
          AGENT_NAME: 'test_agent',
          HAFLEET_AGENT_TOKEN: 'agent-token',
        },
        argv: ['node', hookPath, `--hafleet-hook-sha256=${sha256File(hookPath)}`],
        scriptPath: hookPath,
        api,
      });

      expect(decision).toEqual(buildCodexHookDecision('allow'));
      expect(api).not.toHaveBeenCalled();
      expect(JSON.parse(stdout.value)).toEqual(decision);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  test('codex_hook_failure_emits_explicit_deny', async () => {
    /*
     * REQ-OWNER-UI-APPROVAL-BACKGROUND, the Codex side. `env: {}` denies the hook the identity it
     * needs to reach the backend at all, and it still writes a well-formed documented deny to
     * stdout instead of exiting non-zero or staying silent. That distinction is the requirement:
     * Codex treats a hook that fails to answer as no decision and falls back to its own
     * unattended prompt, which in a detached tmux session nobody ever sees.
     */
    const temporary = mkdtempSync(path.join(os.tmpdir(), 'hafleet-codex-hook-'));
    try {
      const hookPath = path.join(temporary, 'hook.js');
      writeFileSync(hookPath, 'test hook contents\n');
      const stdout = { value: '', write(chunk) { this.value += chunk; } };
      const stderr = { value: '', write(chunk) { this.value += chunk; } };

      const decision = await runCodexPermissionHook({
        stdin: Readable.from([JSON.stringify({
          hook_event_name: 'PermissionRequest',
          turn_id: 'turn-1',
          tool_name: 'Bash',
          tool_input: { command: 'gh issue create' },
        })]),
        stdout,
        stderr,
        env: {},
        argv: ['node', hookPath, `--hafleet-hook-sha256=${sha256File(hookPath)}`],
        scriptPath: hookPath,
        api: vi.fn(),
      });

      expect(decision).toEqual(buildCodexHookDecision(
        'deny',
        'Agent Chat approval channel failed; request denied.',
      ));
      expect(JSON.parse(stdout.value)).toEqual(decision);
      expect(stderr.value).toContain('missing agent identity/token');
      expect(stderr.value).toContain('denying unattended permission request');
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  test('codex hook consumes allow before emitting it', async () => {
    /*
     * REQ-OWNER-UI-APPROVAL-CONSUME, Codex side. `calls` records the exact order — create, then
     * consume — and only then is the allow written to stdout, so the verdict Codex acts on has
     * already been spent server-side and cannot be spent again by a retried turn.
     */
    const temporary = mkdtempSync(path.join(os.tmpdir(), 'hafleet-codex-hook-'));
    try {
      const hookPath = path.join(temporary, 'hook.js');
      writeFileSync(hookPath, 'trusted hook contents\n');
      const approval = {
        id: 'approval_0123456789abcdef0123456789abcdef',
        status: 'approved',
        decision: 'allow',
        input_digest: 'd'.repeat(64),
        expires_at: Date.now() + 60_000,
      };
      const calls = [];
      const api = vi.fn(async (method, apiPath) => {
        calls.push(`${method} ${apiPath}`);
        if (method === 'POST' && apiPath === '/api/approvals') return { approval };
        if (method === 'POST' && apiPath.endsWith('/consume')) return { ok: true };
        throw new Error(`unexpected ${method} ${apiPath}`);
      });
      const stdout = { value: '', write(chunk) { this.value += chunk; } };

      const decision = await runCodexPermissionHook({
        stdin: Readable.from([JSON.stringify({
          hook_event_name: 'PermissionRequest',
          turn_id: 'turn-2',
          tool_name: 'Bash',
          tool_input: { command: 'gh issue create' },
        })]),
        stdout,
        stderr: { write() {} },
        env: {
          AGENT_NAME: 'wf_coordinator',
          HAFLEET_AGENT_TOKEN: 'agent-token',
        },
        argv: ['node', hookPath, `--hafleet-hook-sha256=${sha256File(hookPath)}`],
        scriptPath: hookPath,
        api,
      });

      expect(decision).toEqual(buildCodexHookDecision('allow'));
      expect(calls).toEqual([
        'POST /api/approvals',
        `POST /api/approvals/${approval.id}/consume`,
      ]);
      expect(JSON.parse(stdout.value)).toEqual(decision);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  test('codex_hook_command_binds_script_digest_and_dynamic_timeout', () => {
    /*
     * REQ-OWNER-UI-APPROVAL-TIMEOUT, arithmetically: a 900_000 ms server TTL yields 960 seconds,
     * a bounded 60-second delivery margin ON TOP of the approval lifetime, and that same number
     * reaches Codex through the generated TOML. The direction is what the requirement cares
     * about — a timeout under the TTL would kill the hook while the owner still had a live
     * request in front of them, and the owner would be answering something already dead.
     *
     * Also REQ-OWNER-UI-APPROVAL-TRUST's content-binding clause: the hook command embeds the
     * script's sha256, so trust granted to this configuration is trust in these exact contents.
     */
    const digest = 'e'.repeat(64);
    const command = buildCodexApprovalHookCommand({
      nodeExecutable: '/usr/local/bin/node',
      hookPath: '/opt/hafleet/lib/codex-permission-hook.js',
      scriptDigest: digest,
    });
    const timeoutSeconds = approvalHookTimeoutSeconds({ HAFLEET_APPROVAL_TTL_MS: '900000' });
    const toml = buildCodexApprovalHookToml({ command, timeoutSeconds });

    expect(command).toContain(`--hafleet-hook-sha256=${digest}`);
    expect(timeoutSeconds).toBe(960);
    expect(toml).toContain('timeout = 960');
    expect(toml).toContain(command);
    expect(compareVersions(parseCodexVersion('codex-cli 0.144.1'), parseCodexVersion('0.144.1'))).toBe(0);
    expect(compareVersions(parseCodexVersion('codex-cli 0.145.0'), parseCodexVersion('0.144.1'))).toBeGreaterThan(0);
  });

  test('Codex App Server requests cannot resolve colliding client request ids', () => {
    expect(isCodexAppServerResponse({
      id: 1,
      method: 'account/login/start',
      params: {},
    })).toBe(false);
    expect(isCodexAppServerResponse({
      method: 'thread/started',
      params: {},
    })).toBe(false);
    expect(isCodexAppServerResponse({ id: 1 })).toBe(false);
    expect(isCodexAppServerResponse({ id: 1, result: null })).toBe(true);
    expect(isCodexAppServerResponse({
      id: 1,
      error: { code: -32603, message: 'failed' },
    })).toBe(true);
  });

  test('codex_hook_preflight_precedes_tmux_and_requires_exact_trust', async () => {
    /*
     * REQ-OWNER-UI-APPROVAL-TRUST. Four of its clauses are asserted below.
     *
     * Supported interface: the request sequence is hooks/list -> config/batchWrite -> hooks/list,
     * i.e. trust is read and written through Codex App Server, and the re-inspection confirms
     * Codex itself now reports the hook trusted rather than the launcher assuming it did.
     *
     * Exact and content-bound: the batchWrite upserts `trusted_hash` for the one hook key
     * Codex reported, set to Codex's own `currentHash` — so trust attaches to that exact
     * configuration, and the hooks/list stage refuses to proceed unless exactly one session
     * PermissionRequest hook matches.
     *
     * Explicit confirmation: `confirm` is called exactly once, on the inspection that came back
     * `untrusted`. No bypass: `not.toContain('dangerously-bypass-hook-trust')` over both
     * launchers.
     *
     * Also REQ-OWNER-UI-APPROVAL-BACKGROUND's ordering clause — the index comparison proves
     * preflight_runtime_approval_adapter is invoked before create_tmux_session in both
     * launchers, so no detached terminal exists to hide a native prompt in until the adapter has
     * been verified.
     *
     * NOT asserted here (see report): that a declined or non-interactive confirmation aborts.
     * `confirm` is stubbed true, so only the accept path runs.
     */
    const temporary = mkdtempSync(path.join(os.tmpdir(), 'hafleet-codex-preflight-'));
    try {
      const hookPath = path.join(temporary, 'codex-permission-hook.js');
      const outputPath = path.join(temporary, 'prepared.json');
      writeFileSync(hookPath, 'permission hook\n');
      const digest = sha256File(hookPath);
      const command = buildCodexApprovalHookCommand({
        nodeExecutable: process.execPath,
        hookPath,
        scriptDigest: digest,
      });
      const timeoutSeconds = approvalHookTimeoutSeconds({});
      const requests = [];
      let inspection = 0;
      const clientFactory = vi.fn(async () => {
        const trustStatus = inspection === 0 ? 'untrusted' : 'trusted';
        inspection += 1;
        return {
          request: vi.fn(async (method, params) => {
            requests.push({ method, params });
            if (method === 'config/batchWrite') return { status: 'ok' };
            return {
              data: [{
                cwd: temporary,
                warnings: [],
                errors: [],
                hooks: [{
                  key: '/session/config.toml:permission_request:0:0',
                  eventName: 'permissionRequest',
                  handlerType: 'command',
                  matcher: '.*',
                  command,
                  timeoutSec: timeoutSeconds,
                  sourcePath: '/session/config.toml',
                  source: 'sessionFlags',
                  enabled: true,
                  currentHash: `sha256:${'f'.repeat(64)}`,
                  trustStatus,
                }],
              }],
            };
          }),
          close: vi.fn(),
        };
      });
      const confirm = vi.fn().mockResolvedValue(true);

      const prepared = await preflightCodexPermissionHook({
        cwd: temporary,
        hookPath,
        outputPath,
        env: {},
        confirm,
        clientFactory,
        runVersion: vi.fn().mockReturnValue({
          status: 0,
          stdout: 'codex-cli 0.144.1\n',
          stderr: '',
        }),
      });

      expect(confirm).toHaveBeenCalledOnce();
      expect(requests.map(request => request.method)).toEqual([
        'hooks/list',
        'config/batchWrite',
        'hooks/list',
      ]);
      expect(requests[1].params).toMatchObject({
        edits: [{
          keyPath: 'hooks.state',
          value: {
            '/session/config.toml:permission_request:0:0': {
              trusted_hash: `sha256:${'f'.repeat(64)}`,
            },
          },
          mergeStrategy: 'upsert',
        }],
      });
      expect(prepared.scriptDigest).toBe(digest);
      expect(JSON.parse(readFileSync(outputPath, 'utf8')).hookToml).toBe(prepared.hookToml);

      for (const file of ['bin/hafleet-up', 'remote/bin/hafleet-up']) {
        const source = readFileSync(file, 'utf8');
        const preflightCall = source.indexOf('\npreflight_runtime_approval_adapter\n');
        const createCall = source.indexOf('\ncreate_tmux_session\n', preflightCall);
        expect(preflightCall).toBeGreaterThan(-1);
        expect(createCall).toBeGreaterThan(preflightCall);
        expect(source).toContain('managed-runtime.pid');
        // One per framework per resume/fresh path. bin/hafleet-up carries three
        // frameworks (claude, codex, hermes) so six; remote/bin/hafleet-up is a
        // separately maintained file — MANAGED_SPECS sources it directly rather
        // than copying from bin/hafleet-up — and still has only claude and codex.
        // KNOWN GAP, pinned here so the divergence stays visible and adding a
        // framework still forces the new launch sites to be reviewed.
        const launchSites = source.match(/tmux send-keys[^\\n]+\"exec /g);
        expect(launchSites, file).toHaveLength(file.startsWith('remote/') ? 4 : 6);
        expect(source).not.toContain('dangerously-bypass-hook-trust');
        expect(source).not.toContain('timeout = 330');
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  test('launchers keep sandbox defaults and wire only supported adapters', () => {
    for (const file of ['bin/hafleet-up', 'remote/bin/hafleet-up']) {
      const source = readFileSync(file, 'utf8');
      expect(source).toContain('CLAUDE_FLAGS="--permission-mode auto"');
      expect(source).toContain('--dangerously-load-development-channels');
      expect(source).toContain('ensure_claude_owner_approval_ask_rules');
      expect(source).toContain('"Bash(gh *)"');
      expect(source).toContain('"Bash(git push *)"');
      expect(source).toContain('CODEX_FLAGS="--sandbox workspace-write --ask-for-approval on-request');
      expect(source).toContain('hooks.PermissionRequest');
      expect(source).toContain('lib/codex-permission-hook.js');
      expect(source).toContain('lib/codex-hook-trust.js');
    }
  });

  test('launchers_clear_ambient_anthropic_key_without_explicit_profile', () => {
    /*
     * REQ-OWNER-UI-APPROVAL-CLAUDE-AUTH, both halves, and the guard condition is the whole
     * statement: the unset is emitted only when SAVED_RUNTIME_PROFILE_PRIMARY_API_KEY is empty,
     * and the export is emitted when it is set. An unconditional unset would break the explicit
     * per-agent key; an unconditional inherit lets whatever is in the operator's shell decide
     * which account the managed agent bills and authenticates as.
     */
    for (const file of ['bin/hafleet-up', 'remote/bin/hafleet-up']) {
      const source = readFileSync(file, 'utf8');
      expect(source).toContain(
        'if [ "$TYPE" = "claude" ] && [ -z "${SAVED_RUNTIME_PROFILE_PRIMARY_API_KEY:-}" ]; then',
      );
      expect(source).toContain("printf 'unset ANTHROPIC_API_KEY");
      expect(source).toContain(
        'write_launch_env "ANTHROPIC_API_KEY" "$SAVED_RUNTIME_PROFILE_PRIMARY_API_KEY"',
      );
    }
  });
});
