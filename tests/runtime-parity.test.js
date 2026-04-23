import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

describe('runtime parity regressions', () => {
  test('remote MCP auto-registration defaults server to local', () => {
    const source = readFileSync(path.resolve('remote/lib/mcp-server-core.js'), 'utf-8');
    expect(source).toMatch(/const AGENT_SERVER = \(process\.env\.AGENT_CHAT_SERVER \|\| ''\)\.trim\(\) \|\| 'local';/);
  });

  test('deployment and upstream helpers avoid machine-specific hardcoded home paths', async () => {
    const autodeploySource = readFileSync(path.resolve('scripts/agentchat-stable-autodeploy.sh'), 'utf-8');
    const autostartSource = readFileSync(path.resolve('bin/agentchat-autostart.sh'), 'utf-8');
    const previousRoot = process.env.AGENT_CHAT_ROOT;
    const previousUpstreamRoot = process.env.UPSTREAM_CLAUDE_SUBCONSCIOUS_ROOT;
    try {
      process.env.AGENT_CHAT_ROOT = '/tmp/agent-chat-root';
      delete process.env.UPSTREAM_CLAUDE_SUBCONSCIOUS_ROOT;
      const moduleUrl = pathToFileURL(path.resolve('lib/upstream-claude-subconscious.js')).href;
      const upstreamModule = await import(`${moduleUrl}?test=${Date.now()}`);

      expect(autodeploySource).not.toMatch(/\/home\/[a-z_][a-z0-9_-]*\/.*agent-chat/);
      expect(autostartSource).not.toMatch(/export HOME="\/home\/[a-z_][a-z0-9_-]*"/);
      expect(upstreamModule.UPSTREAM_CLAUDE_SUBCONSCIOUS_ROOT).toBe('/tmp/claude-subconscious');
    } finally {
      if (previousRoot === undefined) delete process.env.AGENT_CHAT_ROOT;
      else process.env.AGENT_CHAT_ROOT = previousRoot;
      if (previousUpstreamRoot === undefined) delete process.env.UPSTREAM_CLAUDE_SUBCONSCIOUS_ROOT;
      else process.env.UPSTREAM_CLAUDE_SUBCONSCIOUS_ROOT = previousUpstreamRoot;
    }
  });

  test('push-relay check_inbox hint exists', () => {
    const localSource = readFileSync(path.resolve('lib/push-relay-core.js'), 'utf-8');
    const hintPattern = /const checkHint = '([^']+)';/;
    const localHint = localSource.match(hintPattern)?.[1] || null;
    expect(localHint).toBe('FIRST ACTION: call check_inbox() now. Use check_inbox() in agent-chat MCP for full context before acting.');
  });

  test('backend and local push-relay import blocked patterns from the shared module', () => {
    const backendSource = readFileSync(path.resolve('backend-v2.js'), 'utf-8');
    const relaySource = readFileSync(path.resolve('lib/push-relay-core.js'), 'utf-8');
    const sharedSource = readFileSync(path.resolve('lib/blocked-patterns.js'), 'utf-8');
    const remoteSharedSource = readFileSync(path.resolve('remote/lib/blocked-patterns.js'), 'utf-8');

    expect(backendSource).toMatch(/from '\.\/lib\/blocked-patterns\.js';/);
    expect(relaySource).toMatch(/from '\.\/blocked-patterns\.js';/);
    expect(sharedSource).toMatch(/reason: 'approval-mode-toggle'/);
    expect(sharedSource).toMatch(/reason: 'interactive-confirm'/);
    expect(sharedSource).toMatch(/reason: 'update-required'/);
    expect(remoteSharedSource).toBe(sharedSource);
  });
});
