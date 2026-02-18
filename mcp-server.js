#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { execSync } from 'child_process';
import { z } from 'zod';

function run(cmd) {
  return execSync(cmd, { encoding: 'utf-8', timeout: 3000 }).trim();
}

function detectAgentName() {
  const envAgent = (process.env.AGENT_NAME || '').trim();
  if (envAgent) return envAgent;

  const envPane = (process.env.TMUX_PANE || '').trim();
  if (envPane) {
    try {
      const fromPane = run(`tmux display-message -p -t ${JSON.stringify(envPane)} "#{session_name}"`);
      if (fromPane) return fromPane;
    } catch {}
  }

  // Fallback for clients that don't pass TMUX/TMUX_PANE to MCP subprocesses:
  // map this process TTY back to tmux pane -> session.
  try {
    const tty = run(`ps -o tty= -p ${process.pid}`);
    if (tty) {
      const paneLines = run('tmux list-panes -a -F "#{pane_tty} #{session_name}"');
      const expected = `/dev/${tty}`;
      for (const line of paneLines.split('\n')) {
        const sp = line.indexOf(' ');
        if (sp < 0) continue;
        const paneTty = line.slice(0, sp).trim();
        const session = line.slice(sp + 1).trim();
        if (paneTty === expected && session) return session;
      }
    }
  } catch {}

  try {
    const fromClient = run('tmux display-message -p "#{session_name}"');
    if (fromClient) return fromClient;
  } catch {}

  return null;
}

// Auto-detect agent name reliably.
const AGENT_NAME = detectAgentName();
if (!AGENT_NAME) {
  process.stderr.write('Error: Cannot determine agent name. Run inside tmux or set AGENT_NAME.\n');
  process.exit(1);
}

const API = process.env.AGENT_CHAT_API || 'http://127.0.0.1:8090';
const API_TOKEN = (process.env.API_TOKEN || '').trim();

// ── HTTP helper ───────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (API_TOKEN) {
    opts.headers.Authorization = `Bearer ${API_TOKEN}`;
  }
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
  version: '2.1.0',
});

// 1. whoami — returns identity, groups (with unread counts), and all known agents
server.tool('whoami', 'Returns your agent identity, role, and groups', {}, async () => {
  try {
    const [me, allAgents, myGroups] = await Promise.all([
      api('GET', `/api/agents/${AGENT_NAME}`),
      api('GET', '/api/agents'),
      api('GET', `/api/agents/${AGENT_NAME}/groups`),
    ]);
    return text({ me, groups: myGroups, agents: allAgents });
  } catch (e) {
    return err(e.message);
  }
});

// 2. send_message
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

// 3. post
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

// 4. check_inbox — returns full message content (no need for separate get_message)
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

// 5. check_group
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

// ── Connect ───────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
