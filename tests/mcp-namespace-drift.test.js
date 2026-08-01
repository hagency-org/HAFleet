import { describe, expect, test } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';

import { codexPermissionRequestNeedsOwnerApproval } from '../lib/codex-permission-hook.js';

// The Codex permission hook allowlists HAFleet's own MCP tools by their
// fully-qualified name, mcp__<server>__<tool>, so they skip owner approval. The
// rename changed the MCP server from agent_chat to hafleet, and the allowlist was
// not updated — the sweep covered AGENT_CHAT_, agent-chat and agentchat, but not
// agent_chat with an underscore, which is exactly the form MCP namespaces use.
//
// Nothing matched, every coordination call fell through to "needs owner
// approval", and with no Matrix bridge to supply an owner binding every one was
// denied. A Codex agent could do sandboxed work but could not read its inbox or
// reply, and it presented as a missing Matrix dependency rather than a typo.
//
// These tests derive the namespace from the same place the launcher does, so the
// two cannot drift apart again without failing here.

/** The default MCP server name, read from the launcher rather than hardcoded. */
function defaultMcpServerName() {
  const source = readFileSync('bin/hafleet-up', 'utf-8');
  const match = source.match(/MCP_SERVER_NAME="\$\{HAFLEET_MCP_SERVER_NAME:-([a-z0-9_-]+)\}"/);
  expect(match, 'could not read the default MCP server name from bin/hafleet-up').toBeTruthy();
  return match[1];
}

/** MCP namespaces replace '-' with '_' in the server segment. */
const namespaceFor = (server) => `mcp__${server.replace(/-/g, '_')}__`;

describe('the permission hook allowlist matches the MCP server it will actually see', () => {
  const server = defaultMcpServerName();
  const prefix = namespaceFor(server);
  const hook = readFileSync('lib/codex-permission-hook.js', 'utf-8');

  test('the launcher and the hook agree on the namespace', () => {
    const allowlisted = [...hook.matchAll(/'(mcp__[a-z0-9_]+__[a-z_]+)'/g)].map((m) => m[1]);
    expect(allowlisted.length).toBeGreaterThan(5);
    const wrongNamespace = allowlisted.filter((t) => !t.startsWith(prefix));
    expect(wrongNamespace, `hook allowlists tools outside ${prefix}`).toEqual([]);
  });

  test('no stale agent_chat namespace survives in code', () => {
    // The underscore form is what the rename missed. Checked across the tree
    // rather than in one file, because it lived in four.
    //
    // Code only, deliberately. knowledge/requirements/req-owner-ui-approval.md
    // records a dated Codex incident that names the tool as it was actually
    // called on 2026-07-24; rewriting that would falsify the record rather than
    // fix anything. An earlier pass of the rename did exactly that to some
    // upstream provenance strings and had to be reverted.
    const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf-8' }).split('\n').filter(Boolean);
    // This file necessarily contains the string it searches for, so it must skip
    // itself. It passed while the file was untracked and git ls-files could not
    // see it; committing made it visible to its own scan and it failed on the
    // first CI run and on mini5.
    const SELF = 'tests/mcp-namespace-drift.test.js';
    const offenders = [];
    for (const file of tracked) {
      if (file === SELF) continue;
      if (!/\.(js|mjs|cjs|json|sh)$/.test(file)) continue;
      let text;
      try { text = readFileSync(file, 'utf-8'); } catch { continue; }
      if (text.includes('mcp__agent_chat__')) offenders.push(file);
    }
    expect(offenders).toEqual([]);
    // Guard the guard: if this file is ever renamed, SELF goes stale and the
    // exclusion silently stops applying to it while still hiding nothing else.
    expect(tracked, `${SELF} is not tracked — update SELF`).toContain(SELF);
  });

  test.each(['check_inbox', 'whoami', 'list_tasks', 'accept_task'])(
    '%s does not require owner approval',
    (tool) => {
      // These are calls into HAFleet itself, not shell access. Requiring an owner
      // binding for them makes an agent unusable wherever no Matrix bridge exists.
      expect(codexPermissionRequestNeedsOwnerApproval({ tool_name: `${prefix}${tool}` })).toBe(false);
    },
  );

  test('a tool outside the allowlist still requires approval', () => {
    expect(codexPermissionRequestNeedsOwnerApproval({ tool_name: 'shell' })).toBe(true);
    expect(codexPermissionRequestNeedsOwnerApproval({ tool_name: `${prefix}not_a_real_tool` })).toBe(true);
  });

  test('attachments still require approval even on an allowlisted tool', () => {
    // send_message can exfiltrate a file, so it is allowlisted only while it
    // carries none.
    expect(codexPermissionRequestNeedsOwnerApproval({
      tool_name: `${prefix}send_message`, tool_input: { to: 'x' },
    })).toBe(false);
    expect(codexPermissionRequestNeedsOwnerApproval({
      tool_name: `${prefix}send_message`, tool_input: { to: 'x', attachments: ['/etc/passwd'] },
    })).toBe(true);
  });

  test('the remote copy of the hook agrees with the local one', () => {
    // remote/lib is shipped to relay hosts; a namespace fixed in one and not the
    // other would break Codex there only, and silently.
    expect(readFileSync('remote/lib/codex-permission-hook.js', 'utf-8')).toBe(hook);
  });
});
