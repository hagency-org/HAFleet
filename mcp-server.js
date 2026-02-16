#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { execSync } from 'child_process';
import { z } from 'zod';

// Auto-detect agent name: tmux session name > env var
// Always prefer tmux to avoid stale env vars inherited across sessions
let AGENT_NAME;
try {
  AGENT_NAME = execSync('tmux display-message -p "#{session_name}"', { encoding: 'utf-8', timeout: 3000 }).trim();
} catch {
  AGENT_NAME = process.env.AGENT_NAME;
}
if (!AGENT_NAME) {
  process.stderr.write('Error: Cannot determine agent name. Run inside tmux or set AGENT_NAME.\n');
  process.exit(1);
}

const API = process.env.AGENT_CHAT_API || 'http://127.0.0.1:8090';

// ── HTTP helper ───────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${API}${path}`, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `API error ${res.status}`);
  }
  return res.json();
}

function text(data) {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}

function err(msg) {
  return { content: [{ type: 'text', text: msg }], isError: true };
}

// ── MCP Server ────────────────────────────────────────────────────────
const server = new McpServer({
  name: `agent-chat-${AGENT_NAME}`,
  version: '2.0.0',
});

// 1. whoami
server.tool('whoami', 'Returns your agent identity, role, and groups', {}, async () => {
  try {
    const data = await api('GET', `/api/agents/${AGENT_NAME}`);
    return text(data);
  } catch (e) {
    return err(e.message);
  }
});

// 2. list_agents
server.tool('list_agents', 'List all registered agents and their roles', {}, async () => {
  try {
    const data = await api('GET', '/api/agents');
    return text(data);
  } catch (e) {
    return err(e.message);
  }
});

// 3. list_groups
server.tool('list_groups', 'List groups you belong to with unread counts (unread_mentions = @you, unread_messages = total new)', {}, async () => {
  try {
    const data = await api('GET', `/api/agents/${AGENT_NAME}/groups`);
    return text(data);
  } catch (e) {
    return err(e.message);
  }
});

// 4. send_message
server.tool(
  'send_message',
  'Send a direct message to another agent. type: request (needs response), inform (FYI, no response needed), reply (answering a prior message)',
  {
    to: z.string().describe('Target agent name'),
    summary: z.string().describe('Short summary of the message, less than 50 words'),
    full: z.string().describe('Full message content with all details'),
    type: z.enum(['request', 'inform', 'reply']).default('inform').describe('Message type: request, inform, or reply'),
    reply_to: z.string().optional().describe('Message ID this is replying to'),
  },
  async ({ to, summary, full, type, reply_to }) => {
    try {
      const data = await api('POST', '/api/messages', {
        from: AGENT_NAME, to, type, summary, full, mentions: [], reply_to: reply_to || null,
      });
      return text(data);
    } catch (e) {
      return err(e.message);
    }
  }
);

// 5. post
server.tool(
  'post',
  'Post a message to a group. Use mentions to @notify specific agents (they get push-notified). Agents not mentioned can still see the message when they check the group.',
  {
    group: z.string().describe('Group name'),
    summary: z.string().describe('Short summary of the message, less than 50 words'),
    full: z.string().describe('Full message content with all details'),
    type: z.enum(['request', 'inform', 'reply']).default('inform').describe('Message type: request, inform, or reply'),
    mentions: z.array(z.string()).optional().describe('Agent names to @mention and push-notify'),
    reply_to: z.string().optional().describe('Message ID this is replying to'),
  },
  async ({ group, summary, full, type, mentions, reply_to }) => {
    try {
      const data = await api('POST', '/api/messages', {
        from: AGENT_NAME, group, type, summary, full, mentions: mentions || [], reply_to: reply_to || null,
      });
      return text(data);
    } catch (e) {
      return err(e.message);
    }
  }
);

// 6. check_inbox
server.tool(
  'check_inbox',
  'Check your inbox for unread direct messages and @mentions from groups. Returns two arrays: dm (private messages) and group (@mentions). Reading advances your cursor — messages shown here won\'t appear again next time.',
  {},
  async () => {
    try {
      const data = await api('GET', `/api/inbox/${AGENT_NAME}`);
      return text(data);
    } catch (e) {
      return err(e.message);
    }
  }
);

// 7. check_group
server.tool(
  'check_group',
  'Read messages from a group. Returns all unread messages plus recent read history. Reading advances your group cursor.',
  {
    group: z.string().describe('Group name'),
    limit: z.number().default(10).describe('Number of already-read messages to include for context (default 10)'),
  },
  async ({ group, limit }) => {
    try {
      const params = new URLSearchParams({ agent: AGENT_NAME });
      if (limit !== undefined) params.set('limit', String(limit));
      const data = await api('GET', `/api/groups/${group}/messages?${params}`);
      return text(data);
    } catch (e) {
      return err(e.message);
    }
  }
);

// 8. get_group
server.tool(
  'get_group',
  'Get group details including member list',
  {
    group: z.string().describe('Group name'),
  },
  async ({ group }) => {
    try {
      const data = await api('GET', `/api/groups/${encodeURIComponent(group)}`);
      return text(data);
    } catch (e) {
      return err(e.message);
    }
  }
);

// 9. get_message
server.tool(
  'get_message',
  'Get the full content of a message by its ID. Use this to read the complete text after seeing a summary in check_inbox or check_group.',
  {
    id: z.string().describe('Message ID (e.g. msg_0001)'),
  },
  async ({ id }) => {
    try {
      const data = await api('GET', `/api/messages/${id}`);
      return text(data);
    } catch (e) {
      return err(e.message);
    }
  }
);

// ── Connect ───────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
