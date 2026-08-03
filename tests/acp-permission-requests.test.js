import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import { EventEmitter } from 'events';

import { createAcpRuntime } from '../lib/runtime/acp.js';

// codex-acp asks the client for permission before running an MCP tool. The
// runtime handled only session/update notifications, so every agent->client
// REQUEST was silently dropped — and a dropped request is not a refusal, it is a
// hang. Observed live: every turn that touched an MCP tool died at the 600s
// prompt timeout having produced nothing, which reads as a stuck model.
//
// Reproduced with a probe: session/request_permission arrives 12s in and nothing
// follows. The request identifies the call only by toolCallId and carries no tool
// name, so the preceding tool_call update must be remembered to answer it at all.

/** An agent that asks permission for one tool call, then reports the outcome. */
function permissionAskingAgent({ toolCall, options, meta = { is_mcp_tool_approval: true } } = {}) {
  const sent = [];
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 99;
    child.kill = () => child.emit('exit', 0);
    child.stdin = {
      write: (chunk) => {
        for (const line of String(chunk).split('\n').filter(Boolean)) {
          const msg = JSON.parse(line);
          sent.push(msg);
          queueMicrotask(() => {
            if (msg.method === 'initialize') {
              child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } })}\n`);
            } else if (msg.method === 'session/new') {
              child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } })}\n`);
            } else if (msg.method === 'session/prompt') {
              // Announce the tool call, then ask permission for it by id only.
              if (toolCall) {
                child.stdout.emit('data', `${JSON.stringify({
                  jsonrpc: '2.0', method: 'session/update',
                  params: { update: { sessionUpdate: 'tool_call', ...toolCall } },
                })}\n`);
              }
              child.stdout.emit('data', `${JSON.stringify({
                jsonrpc: '2.0', id: 0, method: 'session/request_permission',
                params: { sessionId: 's1', toolCall: { toolCallId: toolCall?.toolCallId ?? 'unknown', kind: 'execute', status: 'pending' }, _meta: meta, options },
              })}\n`);
            }
          });
        }
        return true;
      },
      end: () => {},
    };
    return child;
  };
  return { spawnFn, sent };
}

const OPTIONS = [
  { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'allow_session', name: 'Allow for This Session', kind: 'allow_always' },
  { optionId: 'allow_always', name: "Allow and Don't Ask Again", kind: 'allow_always' },
  { optionId: 'decline', name: 'Decline', kind: 'reject_once' },
];

const HAFLEET_CALL = {
  toolCallId: 'exec-1', kind: 'execute', title: 'mcp.hafleet.whoami',
  rawInput: { server: 'hafleet', tool: 'whoami', arguments: {} },
};

/** Drive a prompt and return the response the runtime sent for request id 0. */
async function answerFor({ toolCall = HAFLEET_CALL, options = OPTIONS, decidePermission, meta } = {}) {
  const { spawnFn, sent } = permissionAskingAgent({ toolCall, options, meta });
  const rt = createAcpRuntime({ command: 'x', args: [], spawnFn, decidePermission });
  await rt.startSession('a', { cwd: '/ws' });
  rt.prompt('a', 'go').catch(() => {});
  await new Promise((r) => setTimeout(r, 30));
  return sent.find((m) => m.id === 0 && !m.method);
}

describe('a permission request is always answered', () => {
  test('an approved call selects allow_once', async () => {
    const answer = await answerFor({ decidePermission: ({ options }) => options.find((o) => o.kind === 'allow_once').optionId });
    expect(answer).toBeTruthy();
    expect(answer.result.outcome).toEqual({ outcome: 'selected', optionId: 'allow_once' });
  });

  test('a declined call selects the reject option rather than going silent', async () => {
    // Silence is what hung the agent. A refusal must be spoken.
    const answer = await answerFor({ decidePermission: () => null });
    expect(answer).toBeTruthy();
    expect(answer.result.outcome).toEqual({ outcome: 'selected', optionId: 'decline' });
  });

  test('with no reject option offered it cancels, still answering', async () => {
    const answer = await answerFor({
      options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow' }],
      decidePermission: () => null,
    });
    expect(answer.result.outcome).toEqual({ outcome: 'cancelled' });
  });

  test('with no decider at all it declines, it does not approve', async () => {
    const answer = await answerFor({ decidePermission: null });
    expect(answer.result.outcome.optionId).toBe('decline');
  });

  test('a decider that throws denies rather than opening the gate', async () => {
    const answer = await answerFor({ decidePermission: () => { throw new Error('boom'); } });
    expect(answer.result.outcome.optionId).toBe('decline');
  });

  test('the decider is told what the tool actually is', async () => {
    // The request carries only a toolCallId, so this is only possible because the
    // preceding tool_call update was remembered.
    let seen = null;
    await answerFor({ decidePermission: (ctx) => { seen = ctx; return null; } });
    expect(seen).toMatchObject({
      server: 'hafleet', tool: 'whoami', title: 'mcp.hafleet.whoami', isMcpToolApproval: true,
    });
  });

  test('an unidentifiable call gives the decider nulls, not a guess', async () => {
    // No tool_call update preceded it, so nothing is known about the call.
    let seen = null;
    await answerFor({ toolCall: null, decidePermission: (ctx) => { seen = ctx; return null; } });
    expect(seen.server).toBeNull();
    expect(seen.tool).toBeNull();
  });
});

describe('every other agent request gets an explicit error', () => {
  test.each(['fs/read_text_file', 'fs/write_text_file', 'terminal/create'])('%s is refused, not ignored', async (method) => {
    const sent = [];
    const spawnFn = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 1; child.kill = () => child.emit('exit', 0);
      child.stdin = {
        write: (chunk) => {
          for (const line of String(chunk).split('\n').filter(Boolean)) {
            const msg = JSON.parse(line);
            sent.push(msg);
            queueMicrotask(() => {
              if (msg.method === 'initialize') {
                child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } })}\n`);
              } else if (msg.method === 'session/new') {
                child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } })}\n`);
                child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 7, method, params: { path: '/etc/passwd' } })}\n`);
              }
            });
          }
          return true;
        },
        end: () => {},
      };
      return child;
    };
    const rt = createAcpRuntime({ command: 'x', args: [], spawnFn });
    await rt.startSession('a', { cwd: '/ws' });
    await new Promise((r) => setTimeout(r, 30));
    const answer = sent.find((m) => m.id === 7);
    expect(answer, `${method} was left unanswered`).toBeTruthy();
    expect(answer.error.code).toBe(-32601);
    expect(answer.error.message).toContain(method);
  });
});

describe('the host reuses the tmux permission rule', () => {
  const host = readFileSync('scripts/hafleet-acp-agent.mjs', 'utf-8');

  test('it imports the existing hook rather than restating the allowlist', () => {
    // Two copies of a security rule is how one of them gets missed — which is
    // exactly how the mcp__agent_chat__ namespace drift happened.
    expect(host).toContain("from '../lib/codex-permission-hook.js'");
    expect(host).toMatch(/codexPermissionRequestNeedsOwnerApproval\(\{ tool_name: qualified, tool_input:/);
  });

  test('it never selects allow_always', () => {
    const fn = host.slice(host.indexOf('function decidePermission'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain('allow_once');
    expect(body).not.toMatch(/return.*allow_always/);
  });

  test('it only approves our own MCP server', () => {
    const fn = host.slice(host.indexOf('function decidePermission'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toMatch(/server !== MCP_SERVER_NAME/);
  });
});

describe('the policy sees the tool arguments, not just its name', () => {
  // The hook allowlists send_message and post only while they carry no
  // attachments, so it inspects tool_input and treats a missing one as "cannot
  // tell — refer for approval". Passing only the name declined every reply: the
  // agent read its inbox, composed the answer, and was refused permission to
  // send it. Observed live as
  //   declining mcp__hafleet__send_message: not a trusted coordination tool
  const host = readFileSync('scripts/hafleet-acp-agent.mjs', 'utf-8');

  test('tool_input is forwarded to the hook', () => {
    expect(host).toMatch(/tool_name: qualified, tool_input: input \?\? \{\}/);
  });

  test('the decider receives the arguments from the tool_call update', async () => {
    let seen = null;
    await answerFor({
      toolCall: {
        toolCallId: 'exec-2', kind: 'execute', title: 'mcp.hafleet.send_message',
        rawInput: { server: 'hafleet', tool: 'send_message', arguments: { to: 'ops', summary: 'PARITY' } },
      },
      decidePermission: (ctx) => { seen = ctx; return null; },
    });
    expect(seen.input).toEqual({ to: 'ops', summary: 'PARITY' });
  });

  test('the real policy allows a plain send_message and refuses one with attachments', async () => {
    // Exercises the shipped rule rather than a stub, so the two cannot diverge.
    const { codexPermissionRequestNeedsOwnerApproval } = await import('../lib/codex-permission-hook.js');
    expect(codexPermissionRequestNeedsOwnerApproval({
      tool_name: 'mcp__hafleet__send_message', tool_input: { to: 'ops', summary: 'PARITY' },
    })).toBe(false);
    expect(codexPermissionRequestNeedsOwnerApproval({
      tool_name: 'mcp__hafleet__send_message', tool_input: { to: 'ops', attachments: ['/etc/passwd'] },
    })).toBe(true);
    // And the bug itself: name with no arguments must still be refused, because
    // the hook genuinely cannot tell. The fix is to pass the arguments, not to
    // weaken this.
    expect(codexPermissionRequestNeedsOwnerApproval({ tool_name: 'mcp__hafleet__send_message' })).toBe(true);
  });
});

describe('the decider function actually runs', () => {
  // It threw "input is not defined" for every call: the parameter list omitted
  // `input` while the body used it. The runtime swallowed the throw and declined,
  // so the agent reported "the MCP call was rejected" and the log said nothing.
  // A shape test cannot catch this; the function has to be executed.
  test('every name the body uses is destructured', async () => {
    const host = readFileSync('scripts/hafleet-acp-agent.mjs', 'utf-8');
    const start = host.indexOf('function decidePermission(');
    const sig = host.slice(start, host.indexOf(')', start) + 1);
    const body = host.slice(host.indexOf('{', start), host.indexOf('\n}', start));
    for (const name of ['server', 'tool', 'options', 'title', 'input']) {
      if (!new RegExp(`\\b${name}\\b`).test(body)) continue;
      expect(sig, `${name} is used but not a parameter`).toContain(name);
    }
  });

  test('a throwing policy is reported, not silently treated as a refusal', async () => {
    // The runtime must deny on a throw — but say why.
    const lines = [];
    const { spawnFn } = permissionAskingAgent({ toolCall: HAFLEET_CALL, options: OPTIONS });
    const rt = createAcpRuntime({
      command: 'x', args: [], spawnFn,
      decidePermission: () => { throw new Error('input is not defined'); },
      onStderr: (_a, line) => lines.push(line),
    });
    await rt.startSession('a', { cwd: '/ws' });
    rt.prompt('a', 'go').catch(() => {});
    await new Promise((r) => setTimeout(r, 30));
    expect(lines.join('\n')).toMatch(/permission policy threw, denying: input is not defined/);
  });
});
