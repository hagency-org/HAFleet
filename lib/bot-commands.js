import { execFile } from 'child_process';
import { promisify } from 'util';

const DEFAULT_BACKEND_PORT_RAW = Number.parseInt(process.env.AGENT_CHAT_BACKEND_PORT || '8090', 10);
const DEFAULT_BACKEND_PORT = Number.isFinite(DEFAULT_BACKEND_PORT_RAW) && DEFAULT_BACKEND_PORT_RAW > 0
  ? DEFAULT_BACKEND_PORT_RAW
  : 8090;
const BACKEND_URL = process.env.AGENT_CHAT_API || `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`;
const BACKEND_FETCH_TIMEOUT_MS_RAW = Number.parseInt(process.env.AGENT_CHAT_BACKEND_FETCH_TIMEOUT_MS || '12000', 10);
const BACKEND_FETCH_TIMEOUT_MS = Number.isFinite(BACKEND_FETCH_TIMEOUT_MS_RAW) && BACKEND_FETCH_TIMEOUT_MS_RAW > 0
  ? BACKEND_FETCH_TIMEOUT_MS_RAW
  : 12000;
const HOMESERVER = process.env.MATRIX_HOMESERVER || 'https://matrix.example.com';
const AGENT_PREFIX = (process.env.MATRIX_AGENT_PREFIX || 'ac_').trim();
const MATRIX_SERVER_NAME = (process.env.MATRIX_SERVER_NAME || new URL(HOMESERVER).host).trim();
const execFileAsync = promisify(execFile);
let execFileAsyncImpl = execFileAsync;
let tmuxBinaryAvailablePromise = null;

// ── Command ACL (5.8.2) ─────────────────────────────────────────────
const MATRIX_OPERATOR_MXIDS = new Set(
  (process.env.MATRIX_OPERATOR_MXIDS || '').split(',').map(s => s.trim()).filter(Boolean)
);
const MATRIX_ADMIN_MXIDS = new Set(
  (process.env.MATRIX_ADMIN_MXIDS || '').split(',').map(s => s.trim()).filter(Boolean)
);

const COMMAND_TIERS = {
  '!help': 0,
  '!status': 1, '!agents': 1, '!groups': 1, '!group': 1, '!agent': 1,
  '!sessions': 1, '!mcp': 1, '!bridge': 1,
  '!mkgroup': 2, '!bindroom': 2, '!addmember': 2, '!rmember': 2, '!joingroup': 2,
  '!dm': 2, '!identity': 2, '!rmgroup': 2,
  '!spy': 3, '!agentctl': 3, '!ctl': 3,
};

function classifyCommand(command) {
  return COMMAND_TIERS[command] ?? 1; // unknown commands default to operator tier
}

function authorizeCommand(senderMxid, tier) {
  if (tier === 0) return { ok: true, reason: 'public' };
  if (MATRIX_ADMIN_MXIDS.has(senderMxid)) return { ok: true, reason: 'admin' };
  if (tier <= 2 && MATRIX_OPERATOR_MXIDS.has(senderMxid)) return { ok: true, reason: 'operator' };
  // If no ACL configured at all, allow everything (backward compat)
  if (MATRIX_OPERATOR_MXIDS.size === 0 && MATRIX_ADMIN_MXIDS.size === 0) return { ok: true, reason: 'no_acl' };
  return { ok: false, reason: tier >= 3 ? 'admin_required' : 'operator_required' };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const AGENT_PREFIX_RE = escapeRegex(AGENT_PREFIX);

async function api(method, path, body) {
  const opts = { method, headers: {}, signal: AbortSignal.timeout(BACKEND_FETCH_TIMEOUT_MS) };
  const secret = (process.env.MATRIX_BRIDGE_SECRET || '').trim();
  if (secret) opts.headers['X-Bridge-Secret'] = secret;
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${BACKEND_URL}${path}`, opts);
  return res.json();
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function runProcess(file, args, options = {}) {
  return execFileAsyncImpl(file, args, {
    timeout: 5000,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    ...options,
  });
}

async function hasTmuxBinary() {
  if (!tmuxBinaryAvailablePromise) {
    tmuxBinaryAvailablePromise = runProcess('tmux', ['-V'], { timeout: 2000 })
      .then(() => true)
      .catch(() => false);
  }
  return tmuxBinaryAvailablePromise;
}

function isSafeTmuxTarget(value) {
  return /^[A-Za-z0-9_.:-]+$/.test(String(value || ''));
}

function parseTailLines(value, fallback = 5) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, 200);
}

async function getSessionActivitySec(session) {
  try {
    const { stdout } = await runProcess('tmux', ['display-message', '-p', '-t', session, '#{session_activity}'], {
      timeout: 3000,
    });
    const out = stdout.trim();
    const n = Number.parseInt(out, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  } catch {
    return null;
  }
}

async function listTmuxSessions() {
  const { stdout } = await runProcess('tmux', ['list-sessions', '-F', '#{session_name}']);
  return stdout.trim()
    ? stdout.trim().split('\n').filter(Boolean)
    : [];
}

async function listTmuxPaneFields(target, format, timeout = 5000) {
  const { stdout } = await runProcess('tmux', ['list-panes', '-t', target, '-F', format], { timeout });
  return stdout.trim()
    ? stdout.trim().split('\n').filter(Boolean)
    : [];
}

async function listAllTmuxPaneFields(format, timeout = 5000) {
  const { stdout } = await runProcess('tmux', ['list-panes', '-a', '-F', format], { timeout });
  return stdout.trim()
    ? stdout.trim().split('\n').filter(Boolean)
    : [];
}

async function captureTmuxPane(target, lines, timeout = 5000) {
  const { stdout } = await runProcess('tmux', ['capture-pane', '-t', target, '-p', '-S', `-${lines}`], { timeout });
  return stdout;
}

async function tmuxHasSession(session, timeout = 3000) {
  try {
    await runProcess('tmux', ['has-session', '-t', session], { timeout });
    return true;
  } catch {
    return false;
  }
}

async function findMcpSessionsByTty(timeout = 5000) {
  const paneLines = await listAllTmuxPaneFields('#{pane_tty} #{session_name}', timeout);
  const ptsMap = {};
  for (const line of paneLines) {
    const [tty, sess] = line.split(' ');
    if (tty && sess) ptsMap[tty.replace('/dev/', '')] = sess;
  }

  let pids = [];
  try {
    const { stdout } = await runProcess('pgrep', ['-f', 'node.*mcp-server.js'], { timeout });
    pids = stdout.trim().split('\n').filter(Boolean);
  } catch {
    return {};
  }
  if (!pids.length) return {};

  const ttyByPid = new Map();
  try {
    const { stdout } = await runProcess('ps', ['-o', 'pid=,tty=', '-p', pids.join(',')], { timeout });
    for (const line of stdout.trim().split('\n').filter(Boolean)) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!match) continue;
      ttyByPid.set(match[1], match[2].trim());
    }
  } catch {
    return {};
  }

  const parentByPid = new Map();
  try {
    const { stdout } = await runProcess('ps', ['-o', 'pid=,ppid=', '-p', pids.join(',')], { timeout });
    for (const line of stdout.trim().split('\n').filter(Boolean)) {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!match) continue;
      parentByPid.set(match[1], match[2]);
    }
  } catch {
    // Best-effort only.
  }

  const uniqueParents = [...new Set([...parentByPid.values()].filter(Boolean))];
  const parentCommandByPid = new Map();
  if (uniqueParents.length) {
    try {
      const { stdout } = await runProcess('ps', ['-o', 'pid=,comm=', '-p', uniqueParents.join(',')], { timeout });
      for (const line of stdout.trim().split('\n').filter(Boolean)) {
        const match = line.trim().match(/^(\d+)\s+(.+)$/);
        if (!match) continue;
        parentCommandByPid.set(match[1], match[2].trim());
      }
    } catch {
      // Best-effort only.
    }
  }

  const sessions = {};
  for (const pid of pids) {
    const tty = ttyByPid.get(pid);
    const sess = tty ? ptsMap[tty] : null;
    if (!sess) continue;
    const parentPid = parentByPid.get(pid) || '';
    const parentCommand = parentCommandByPid.get(parentPid) || '';
    sessions[sess] = { mcp: true, client: parentCommand === 'codex' ? 'codex' : 'claude' };
  }
  return sessions;
}

export default class BotCommands {
  constructor({ botClient, bridge, botUserId }) {
    this.botClient = botClient;
    this.bridge = bridge;
    this.botUserId = botUserId;
  }

  parse(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith('!')) return null;
    const parts = trimmed.split(/\s+/);
    return { command: parts[0].toLowerCase(), args: parts.slice(1) };
  }

  async handle(roomId, senderId, text, context = {}) {
    const parsed = this.parse(text);
    if (!parsed) {
      await this.reply(roomId, 'Send !help for available commands.');
      return;
    }

    const { command, args } = parsed;
    const humanName = senderId.match(/^@([^:]+):/)?.[1] || senderId;
    // context: { groupName, targetAgent } — set by bridge based on room type

    // Command ACL check (5.8.2)
    const tier = classifyCommand(command);
    const auth = authorizeCommand(senderId, tier);
    if (!auth.ok) {
      console.warn(`[acl] Denied ${command} (tier ${tier}) for ${senderId}: ${auth.reason}`);
      await this.reply(roomId, `Access denied: ${command} requires ${auth.reason === 'admin_required' ? 'admin' : 'operator'} privileges.`);
      return;
    }

    try {
      switch (command) {
        case '!help':     return await this.cmdHelp(roomId);
        case '!status':   return await this.cmdStatus(roomId);
        case '!agents':   return await this.cmdAgents(roomId, args);
        case '!groups':   return await this.cmdGroups(roomId);
        case '!sessions': return await this.cmdSessions(roomId);
        case '!mcp':      return await this.cmdMcp(roomId);
        case '!agent':    return await this.cmdAgent(roomId, args, context);
        case '!group':    return await this.cmdGroup(roomId, args, context);
        case '!mkgroup':  return await this.cmdMkgroup(roomId, args, humanName);
        case '!bindroom': return await this.cmdBindroom(roomId, args);
        case '!addmember': return await this.cmdAddmember(roomId, args, context);
        case '!rmember':  return await this.cmdRmember(roomId, args, context);
        case '!joingroup': return await this.cmdJoingroup(roomId, args, humanName, context);
        case '!dm':       return await this.cmdDm(roomId, args, humanName);
        case '!identity': return await this.cmdIdentity(roomId, args, context);
        case '!spy':      return await this.cmdSpy(roomId, args, humanName);
        case '!rmgroup':  return await this.cmdRmgroup(roomId, args, context);
        case '!bridge':   return await this.cmdBridge(roomId);
        case '!agentctl': return await this.cmdAgentctl(roomId, args, context, false);
        case '!ctl':      return await this.cmdAgentctl(roomId, args, context, true);
        default:
          await this.reply(roomId, `Unknown command: ${command}\nSend !help for available commands.`);
      }
    } catch (e) {
      console.error(`Bot command error (${command}):`, e);
      await this.reply(roomId, `Error: ${e.message}`);
    }
  }

  async reply(roomId, plain, html) {
    const content = { msgtype: 'm.text', body: plain };
    if (html) {
      content.format = 'org.matrix.custom.html';
      content.formatted_body = html;
    }
    await this.botClient.sendMessage(roomId, content);
  }

  // ── Commands ──────────────────────────────────────────────────────

  async cmdHelp(roomId) {
    const plain = [
      '=== Agent Bridge Bot Commands ===',
      '',
      'System:',
      '  !status          — System overview',
      '  !agents          — List online agents (!agents all for full list)',
      '  !groups          — List all groups',
      '  !sessions        — Tmux sessions + current process',
      '  !mcp             — MCP status per session',
      '  !bridge          — Bridge internal state',
      '  !ctl ...         — Agent control in agent DM (status/send/key)',
      '',
      'Detail:',
      '  !agent [name]    — Agent details (auto in DM)',
      '  !group [name]    — Group details (auto in group)',
      '  !agentctl <agent> status [N]|send <text>|key <K> — Control agent pane',
      '',
      'Management:',
      '  !mkgroup <name> <m1> <m2> ...  — Create group',
      '  !bindroom <group>              — Bind THIS room to an existing group',
      '  !addmember [group] <name>      — Add member to group',
      '  !rmember [group] <name>        — Remove member from group',
      '  !rmgroup [group]               — Delete group + Matrix room',
      '  !joingroup [group]             — Join a group yourself',
      '  !dm <agent>                    — Create DM room with agent',
      '  !identity [agent] <text>       — Set agent identity (auto in DM)',
      '  !spy <agent1> <agent2>         — Join an agent DM room to watch',
    ].join('\n');

    const html = [
      '<h3>Agent Bridge Bot Commands</h3>',
      '<b>System:</b><br>',
      '<code>!status</code> — System overview<br>',
      '<code>!agents</code> — List online agents (<code>!agents all</code> for full list)<br>',
      '<code>!groups</code> — List all groups<br>',
      '<code>!sessions</code> — Tmux sessions + current process<br>',
      '<code>!mcp</code> — MCP status per session<br>',
      '<code>!bridge</code> — Bridge internal state<br>',
      '<code>!ctl ...</code> — Agent control in agent DM (status/send/key)<br>',
      '<br><b>Detail:</b><br>',
      '<code>!agent [name]</code> — Agent details (auto in DM)<br>',
      '<code>!group [name]</code> — Group details (auto in group)<br>',
      '<code>!agentctl &lt;agent&gt; status [N]|send &lt;text&gt;|key &lt;K&gt;</code> — Control agent pane<br>',
      '<br><b>Management:</b><br>',
      '<code>!mkgroup &lt;name&gt; &lt;m1&gt; &lt;m2&gt; ...</code> — Create group<br>',
      '<code>!bindroom &lt;group&gt;</code> — Bind THIS room to an existing group<br>',
      '<code>!addmember [group] &lt;name&gt;</code> — Add member to group<br>',
      '<code>!rmember [group] &lt;name&gt;</code> — Remove member from group<br>',
      '<code>!rmgroup [group]</code> — Delete group + Matrix room<br>',
      '<code>!joingroup [group]</code> — Join a group yourself<br>',
      '<code>!dm &lt;agent&gt;</code> — Create DM room with agent<br>',
      '<code>!identity [agent] &lt;text&gt;</code> — Set agent identity (auto in DM)<br>',
      '<code>!spy &lt;agent1&gt; &lt;agent2&gt;</code> — Join an agent DM room to watch<br>',
    ].join('');

    await this.reply(roomId, plain, html);
  }

  async cmdStatus(roomId) {
    const agents = await api('GET', '/api/agents');
    const groups = await api('GET', '/api/groups');

    let sessionCount = null;
    let tmuxNote = null;
    if (!await hasTmuxBinary()) {
      tmuxNote = 'tmux binary not found on bridge host';
    } else {
      try {
        sessionCount = (await listTmuxSessions()).length;
      } catch {
        tmuxNote = 'tmux server not available (status may be stale)';
      }
    }

    const agentCount = agents.length;
    const groupCount = groups.length;

    const plain = [
      '=== System Status ===',
      `Agents: ${agentCount}`,
      `Groups: ${groupCount}`,
      `Tmux sessions: ${sessionCount === null ? 'unavailable' : sessionCount}`,
      `Bridge: running`,
    ].join('\n');
    const plainWithNote = tmuxNote ? `${plain}\nTmux note: ${tmuxNote}` : plain;

    const html = [
      '<b>System Status</b><br>',
      `Agents: <b>${agentCount}</b><br>`,
      `Groups: <b>${groupCount}</b><br>`,
      `Tmux sessions: <b>${sessionCount === null ? 'unavailable' : sessionCount}</b><br>`,
      `Bridge: <b>running</b>`,
    ].join('') + (tmuxNote ? `<br>Tmux note: <i>${escHtml(tmuxNote)}</i>` : '');

    await this.reply(roomId, plainWithNote, html);
  }

  async cmdAgents(roomId, args = []) {
    const agents = await api('GET', '/api/agents');
    if (!agents.length) {
      await this.reply(roomId, 'No known agents yet.');
      return;
    }

    const showAll = args.includes('all');

    // Check which tmux sessions exist
    let sessions = null;
    let tmuxNote = null;
    if (!await hasTmuxBinary()) {
      tmuxNote = 'tmux binary not found on bridge host';
    } else {
      try {
        sessions = new Set(await listTmuxSessions());
      } catch {
        tmuxNote = 'tmux server not available; live status unknown';
      }
    }

    const lines = [showAll ? '=== All Agents ===' : '=== Online Agents ==='];
    const htmlLines = [showAll ? '<b>All Agents</b><br><br>' : '<b>Online Agents</b><br><br>'];
    let filtered = 0;

    for (const a of agents) {
      const alive = sessions ? sessions.has(a.name) : null;
      if (!showAll && alive === false) { filtered++; continue; }
      const icon = alive === null ? '?' : (alive ? '●' : '○');
      const idText = a.identity ? ` — ${a.identity}` : '';
      const line = `${icon} ${a.name}${idText}`;
      lines.push(line);
      const color = alive === null ? '#ffd43b' : (alive ? '#69db7c' : '#888');
      const idHtml = a.identity ? ` — <i>${escHtml(a.identity)}</i>` : '';
      htmlLines.push(`<span style="color:${color}">${icon}</span> <b>${escHtml(a.name)}</b>${idHtml}<br>`);
    }
    if (tmuxNote) {
      lines.push(``);
      lines.push(`Tmux note: ${tmuxNote}`);
      htmlLines.push(`<br>Tmux note: <i>${escHtml(tmuxNote)}</i>`);
    }
    if (!showAll && filtered > 0) {
      lines.push('');
      lines.push(`Use !agents all to see all agents including offline.`);
      htmlLines.push(`<br><i>Use <code>!agents all</code> to see all agents including offline.</i>`);
    }

    await this.reply(roomId, lines.join('\n'), htmlLines.join(''));
  }

  async cmdGroups(roomId) {
    const groups = await api('GET', '/api/groups');
    if (!groups.length) {
      await this.reply(roomId, 'No groups.');
      return;
    }

    const lines = ['=== Groups ==='];
    const htmlLines = ['<b>Groups</b><br><br>'];

    for (const g of groups) {
      lines.push(`${g.name} (${g.members.length} members): ${g.members.join(', ')}`);
      htmlLines.push(`<b>${escHtml(g.name)}</b> (${g.members.length}): ${g.members.map(m => escHtml(m)).join(', ')}<br>`);
    }

    await this.reply(roomId, lines.join('\n'), htmlLines.join(''));
  }

  async cmdSessions(roomId) {
    if (!await hasTmuxBinary()) {
      await this.reply(roomId, 'tmux is not installed on bridge host.');
      return;
    }

    let sessionNames;
    try {
      sessionNames = await listTmuxSessions();
    } catch {
      await this.reply(roomId, 'No tmux sessions found (tmux server not running).');
      return;
    }
    if (!sessionNames.length) {
      await this.reply(roomId, 'No tmux sessions found.');
      return;
    }
    const lines = ['=== Tmux Sessions ==='];
    const htmlLines = ['<b>Tmux Sessions</b><br><br>'];

    for (const sess of sessionNames) {
      let proc = '-';
      try {
        const paneCmd = (await listTmuxPaneFields(sess, '#{pane_current_command}', 5000))[0];
        if (paneCmd) proc = paneCmd;
      } catch { /* skip */ }

      lines.push(`  ${sess}: ${proc}`);
      htmlLines.push(`<code>${escHtml(sess)}</code>: <b>${escHtml(proc)}</b><br>`);
    }

    lines.push(`\nTotal: ${sessionNames.length}`);
    htmlLines.push(`<br>Total: <b>${sessionNames.length}</b>`);

    await this.reply(roomId, lines.join('\n'), htmlLines.join(''));
  }

  async cmdMcp(roomId) {
    if (!await hasTmuxBinary()) {
      await this.reply(roomId, 'tmux is not installed on bridge host; cannot inspect MCP session bindings.');
      return;
    }

    let mcpSessions = {};

    try {
      mcpSessions = await findMcpSessionsByTty(5000);
    } catch { /* no tmux */ }

    // Get known agents
    const agents = await api('GET', '/api/agents');
    const known = new Set(agents.map(a => a.name));

    // List all sessions
    let allSessions;
    try {
      allSessions = (await listTmuxSessions()).sort();
    } catch { allSessions = []; }

    if (!allSessions.length) {
      await this.reply(roomId, 'No tmux sessions found.');
      return;
    }

    const lines = ['=== MCP Status ===', ''];
    const htmlLines = ['<b>MCP Status</b><br><br><table>',
      '<tr><th>Session</th><th>MCP</th><th>Client</th><th>Known</th></tr>'];

    for (const sess of allSessions) {
      const info = mcpSessions[sess];
      const hasMcp = info ? 'YES' : 'no';
      const client = info ? info.client : '-';
      const isKnown = known.has(sess) ? 'YES' : 'no';

      lines.push(`  ${sess.padEnd(25)} ${hasMcp.padEnd(8)} ${client.padEnd(8)} ${isKnown}`);

      const mcpColor = info ? '#69db7c' : '#888';
      const knownColor = known.has(sess) ? '#69db7c' : '#888';
      htmlLines.push(
        `<tr><td><code>${escHtml(sess)}</code></td>` +
        `<td style="color:${mcpColor}">${hasMcp}</td>` +
        `<td>${escHtml(client)}</td>` +
        `<td style="color:${knownColor}">${isKnown}</td></tr>`
      );
    }

    htmlLines.push('</table>');
    await this.reply(roomId, lines.join('\n'), htmlLines.join(''));
  }

  async cmdAgent(roomId, args, context = {}) {
    const name = args[0] || context.targetAgent;
    if (!name) {
      await this.reply(roomId, 'Usage: !agent <name> (or use inside an agent DM room)');
      return;
    }
    const agent = await api('GET', `/api/agents/${encodeURIComponent(name)}`);
    if (agent.error) {
      await this.reply(roomId, `Agent not found: ${name}`);
      return;
    }

    // Check tmux session
    const sessionAlive = await tmuxHasSession(agent.name, 5000);

    // Find DM rooms involving this agent
    const st = this.bridge.getBridgeState?.() || {};
    const canonicalName = String(agent.name || name);
    const canonicalKey = canonicalName.toLowerCase();
    const dms = Object.entries(st.dmRooms || {})
      .filter(([key]) => key.split(':').some(part => String(part).toLowerCase() === canonicalKey))
      .map(([key]) => {
        const parts = key.split(':');
        return String(parts[0]).toLowerCase() === canonicalKey ? parts[1] : parts[0];
      });

    const lines = [
      `=== Agent: ${agent.name} ===`,
      `Type: ${agent.type}`,
      `Identity: ${agent.identity || 'not set'}`,
      `Tmux: ${agent.tmux || 'none'}`,
      `Session: ${sessionAlive ? 'alive' : 'dead'}`,
      `Groups: ${agent.groups?.join(', ') || 'none'}`,
      `DMs: ${dms.length ? dms.join(', ') : 'none'}`,
    ];

    const html = [
      `<b>Agent: ${escHtml(agent.name)}</b><br>`,
      `Type: <b>${escHtml(agent.type)}</b><br>`,
      `Identity: ${agent.identity ? escHtml(agent.identity) : '<i>not set</i>'}<br>`,
      `Tmux: <code>${escHtml(agent.tmux || 'none')}</code><br>`,
      `Session: <b style="color:${sessionAlive ? '#69db7c' : '#ff6b6b'}">${sessionAlive ? 'alive' : 'dead'}</b><br>`,
      `Groups: ${agent.groups?.length ? agent.groups.map(g => '<code>' + escHtml(g) + '</code>').join(', ') : 'none'}<br>`,
      `DMs: ${dms.length ? dms.map(d => '<code>' + escHtml(d) + '</code>').join(', ') : 'none'}<br>`,
    ].join('');

    await this.reply(roomId, lines.join('\n'), html);
  }

  async cmdGroup(roomId, args, context = {}) {
    const name = args[0] || context.groupName;
    if (!name) {
      await this.reply(roomId, 'Usage: !group <name> (or use inside a group room)');
      return;
    }
    const group = await api('GET', `/api/groups/${encodeURIComponent(name)}`);
    if (group.error) {
      await this.reply(roomId, `Group not found: ${name}`);
      return;
    }

    const hasRoom = this.bridge.groupRoomMap?.[name] || null;

    const lines = [
      `=== Group: ${group.name} ===`,
      `Members (${group.members.length}): ${group.members.join(', ')}`,
      `Matrix room: ${hasRoom || 'none'}`,
    ];

    const html = [
      `<b>Group: ${escHtml(group.name)}</b><br>`,
      `Members (${group.members.length}): ${group.members.map(m => '<code>' + escHtml(m) + '</code>').join(', ')}<br>`,
      `Matrix room: <code>${escHtml(hasRoom || 'none')}</code><br>`,
    ].join('');

    await this.reply(roomId, lines.join('\n'), html);
  }

  async cmdMkgroup(roomId, args, humanName) {
    if (args.length < 1) {
      await this.reply(roomId, 'Usage: !mkgroup <name> [member1] [member2] ...');
      return;
    }
    const name = args[0];
    const initiator = String(humanName || '').trim();
    const initiatorKey = initiator.toLowerCase();
    const seenMembers = new Set();
    const members = args.slice(1)
      .map(member => String(member || '').trim())
      .filter((member) => {
        const key = member.toLowerCase();
        if (!key || key === initiatorKey || seenMembers.has(key)) return false;
        seenMembers.add(key);
        return true;
      });
    if (initiator) members.push(initiator);
    const result = await api('POST', '/api/groups', { name, members });
    if (result.error) {
      await this.reply(roomId, `Failed: ${result.error}`);
      return;
    }
    await this.reply(roomId,
      `Group "${name}" created with members: ${members.join(', ') || 'none'}`,
      `Group <b>${escHtml(name)}</b> created with members: ${members.map(m => '<code>' + escHtml(m) + '</code>').join(', ') || 'none'}`
    );
  }

  // Bind THIS existing room to an existing backend group. The multi-instance
  // counterpart of !mkgroup: in a shared room, each member's bridge binds the
  // SAME Matrix room to its OWN group — no room creation, no group creation.
  async cmdBindroom(roomId, args) {
    const name = args[0];
    if (!name) {
      await this.reply(roomId, 'Usage: !bindroom <group> — bind THIS room to an existing group');
      return;
    }
    const group = await api('GET', `/api/groups/${encodeURIComponent(name)}`);
    if (group.error) {
      await this.reply(roomId, `Group not found: ${name}`);
      return;
    }
    const prev = this.bridge.groupForRoom?.(roomId) || null;
    this.bridge.bindRoom(roomId, name);
    const text = prev && prev !== name
      ? `Room rebound: ${prev} → ${name}`
      : `Room bound to group "${name}"`;
    await this.reply(roomId, text,
      prev && prev !== name
        ? `Room rebound: <code>${escHtml(prev)}</code> → <b>${escHtml(name)}</b>`
        : `Room bound to group <b>${escHtml(name)}</b>`);
  }

  async cmdRmgroup(roomId, args, context = {}) {
    // Auto-detect group from room context if no args
    const name = args[0] || context.groupName;
    if (!name) {
      await this.reply(roomId, 'Usage: !rmgroup <group> (or use inside a group room)');
      return;
    }

    // Check group exists
    const group = await api('GET', `/api/groups/${encodeURIComponent(name)}`);
    if (group.error) {
      await this.reply(roomId, `Group not found: ${name}`);
      return;
    }

    // Delete from backend
    const delResult = await api('DELETE', `/api/groups/${encodeURIComponent(name)}`);
    if (delResult.error) {
      await this.reply(roomId, `Failed to delete group: ${delResult.error}`);
      return;
    }

    // Clean up Matrix room: agents leave with own tokens, kick humans, bot leaves last
    const matrixRoomId = this.bridge.groupRoomMap?.[name];
    const cleanupWarnings = [];
    if (matrixRoomId) {
      const botToken = this.bridge.getBotToken();
      const roomEnc = encodeURIComponent(matrixRoomId);
      try {
        const membersRes = await fetch(`${HOMESERVER}/_matrix/client/v3/rooms/${roomEnc}/joined_members`, {
          headers: { Authorization: `Bearer ${botToken}` },
        });
        if (!membersRes.ok) {
          const body = await membersRes.text().catch(() => '');
          throw new Error(`joined_members status ${membersRes.status} ${body}`.trim());
        }
        const membersData = await membersRes.json();
        const memberIds = Object.keys(membersData.joined || {});

        for (const userId of memberIds) {
          if (userId === this.botUserId) continue;
          // Check if this is an agent (<prefix>name) — use their own token to leave
          const agentMatch = userId.match(new RegExp(`^@${AGENT_PREFIX_RE}([^:]+):`));
          if (agentMatch) {
            const agentToken = this.bridge.getAgentToken?.(agentMatch[1]);
            if (agentToken) {
              try {
                const leaveRes = await fetch(`${HOMESERVER}/_matrix/client/v3/rooms/${roomEnc}/leave`, {
                  method: 'POST',
                  headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
                  body: '{}',
                });
                if (!leaveRes.ok) {
                  const body = await leaveRes.text().catch(() => '');
                  throw new Error(`status ${leaveRes.status} ${body}`.trim());
                }
              } catch (e) {
                const msg = `agent leave failed (${userId}): ${e.message}`;
                cleanupWarnings.push(msg);
                console.warn(`[rmgroup:${name}] ${msg}`);
              }
              continue;
            }
          }
          // Human or unknown — try kick; report if failed
          try {
            const kickRes = await fetch(`${HOMESERVER}/_matrix/client/v3/rooms/${roomEnc}/kick`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ user_id: userId, reason: `Group "${name}" deleted` }),
            });
            if (!kickRes.ok) {
              const body = await kickRes.text().catch(() => '');
              throw new Error(`status ${kickRes.status} ${body}`.trim());
            }
          } catch (e) {
            const msg = `kick failed (${userId}): ${e.message}`;
            cleanupWarnings.push(msg);
            console.warn(`[rmgroup:${name}] ${msg}`);
          }
        }
      } catch (e) {
        const msg = `room cleanup precheck failed: ${e.message}`;
        cleanupWarnings.push(msg);
        console.warn(`[rmgroup:${name}] ${msg}`);
      }

      // Bot leaves last
      try {
        const leaveRes = await fetch(`${HOMESERVER}/_matrix/client/v3/rooms/${roomEnc}/leave`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (!leaveRes.ok) {
          const body = await leaveRes.text().catch(() => '');
          throw new Error(`status ${leaveRes.status} ${body}`.trim());
        }
      } catch (e) {
        const msg = `bot leave failed: ${e.message}`;
        cleanupWarnings.push(msg);
        console.warn(`[rmgroup:${name}] ${msg}`);
      }
    }

    if (cleanupWarnings.length === 0) {
      await this.reply(roomId,
        `Group "${name}" removed. Members cleared, Matrix room abandoned.`,
        `Group <b>${escHtml(name)}</b> removed. Members cleared, Matrix room abandoned.`
      );
      return;
    }

    const preview = cleanupWarnings.slice(0, 3).join('; ');
    await this.reply(
      roomId,
      `Group "${name}" removed, but Matrix cleanup had ${cleanupWarnings.length} issue(s): ${preview}`,
      `Group <b>${escHtml(name)}</b> removed, but Matrix cleanup had <b>${cleanupWarnings.length}</b> issue(s): ${escHtml(preview)}`
    );
  }

  async cmdAddmember(roomId, args, context = {}) {
    // In a group room: !addmember <name> (group auto-detected)
    // Elsewhere: !addmember <group> <name>
    let groupName, memberName;
    if (args.length >= 2) {
      [groupName, memberName] = args;
    } else if (args.length === 1 && context.groupName) {
      groupName = context.groupName;
      memberName = args[0];
    } else {
      await this.reply(roomId, 'Usage: !addmember <group> <name> (or !addmember <name> inside a group room)');
      return;
    }
    const result = await api('POST', `/api/groups/${encodeURIComponent(groupName)}/members`, { add: [memberName] });
    if (result.error) {
      await this.reply(roomId, `Failed: ${result.error}`);
      return;
    }
    await this.reply(roomId, `Added ${memberName} to ${groupName}`);
  }

  async cmdRmember(roomId, args, context = {}) {
    let groupName, memberName;
    if (args.length >= 2) {
      [groupName, memberName] = args;
    } else if (args.length === 1 && context.groupName) {
      groupName = context.groupName;
      memberName = args[0];
    } else {
      await this.reply(roomId, 'Usage: !rmember <group> <name> (or !rmember <name> inside a group room)');
      return;
    }
    const result = await api('POST', `/api/groups/${encodeURIComponent(groupName)}/members`, { remove: [memberName] });
    if (result.error) {
      await this.reply(roomId, `Failed: ${result.error}`);
      return;
    }
    await this.reply(roomId, `Removed ${memberName} from ${groupName}`);
  }

  async cmdJoingroup(roomId, args, humanName, context = {}) {
    const groupName = args[0] || context.groupName;
    if (!groupName) {
      await this.reply(roomId, 'Usage: !joingroup <group> (or use inside a group room)');
      return;
    }

    // Add human to backend group
    const result = await api('POST', `/api/groups/${encodeURIComponent(groupName)}/members`, { add: [humanName] });
    if (result.error) {
      await this.reply(roomId, `Failed: ${result.error}`);
      return;
    }

    // The SSE group_members event will handle the Matrix room invite
    await this.reply(roomId,
      `Added you (${humanName}) to group "${groupName}". You should receive a Matrix room invite shortly.`,
      `Added you (<b>${escHtml(humanName)}</b>) to group <b>${escHtml(groupName)}</b>. You should receive a Matrix room invite shortly.`
    );
  }

  async cmdDm(roomId, args, humanName) {
    if (!args.length) {
      await this.reply(roomId, 'Usage: !dm <agent>');
      return;
    }
    const agentName = args[0];

    // Verify agent exists
    const agent = await api('GET', `/api/agents/${encodeURIComponent(agentName)}`);
    if (agent.error) {
      await this.reply(roomId, `Agent not found: ${agentName}`);
      return;
    }

    // Create or join existing DM room via bridge (human-aware flow)
    let dmResult = null;
    if (typeof this.bridge.ensureHumanDmRoom === 'function') {
      dmResult = await this.bridge.ensureHumanDmRoom(agentName, humanName);
    } else {
      const roomId = await this.bridge.ensureDmRoom(agentName, humanName);
      dmResult = roomId ? { ok: true, roomId, humanStatus: 'unknown' } : { ok: false, roomId: null, humanStatus: 'missing_room' };
    }

    const dmRoomId = dmResult?.roomId || null;
    if (dmRoomId) {
      const roomLink = `https://matrix.to/#/${dmRoomId}`;

      if (dmResult.humanStatus === 'joined' || dmResult.humanStatus === 'unknown') {
        // Nudge in the DM room itself
        await this.botClient.sendMessage(dmRoomId, {
          msgtype: 'm.text',
          body: `👋 @${humanName} — your DM with ${agentName} is here!`,
          format: 'org.matrix.custom.html',
          formatted_body: `👋 <a href="https://matrix.to/#/@${humanName}:${MATRIX_SERVER_NAME}">${escHtml(humanName)}</a> — your DM with <b>${escHtml(agentName)}</b> is here!`,
        });
        await this.reply(roomId,
          `You're already in the DM room with ${agentName} — sent a reminder there.`,
          `You're already in the DM room with <b>${escHtml(agentName)}</b> — sent a reminder there.`
        );
        return;
      }

      if (dmResult.humanStatus === 'invited') {
        await this.reply(roomId,
          `DM room ready for ${agentName}. Invite sent — check your Matrix invites. Room: ${roomLink}`,
          `DM room ready for <b>${escHtml(agentName)}</b>. Invite sent — check your Matrix invites. <a href="${roomLink}">Open room</a>`
        );
        return;
      }

      const detail = dmResult?.invite?.error ? ` (${dmResult.invite.error})` : '';
      await this.reply(roomId,
        `DM room exists but invite failed${detail}. Open ${roomLink} or retry !dm ${agentName}.`,
        `DM room exists but invite failed${detail ? `: <code>${escHtml(dmResult.invite.error)}</code>` : ''}. <a href="${roomLink}">Open room</a> or retry <code>!dm ${escHtml(agentName)}</code>.`
      );
    } else {
      await this.reply(roomId, `Failed to create DM room. Agent "${agentName}" may not have a Matrix account yet.`);
    }
  }

  async cmdSpy(roomId, args, humanName) {
    if (args.length < 2) {
      await this.reply(roomId, 'Usage: !spy <agent1> <agent2>');
      return;
    }
    const [a, b] = args;
    const key = [a, b].sort().join(':');

    // Check bridge state for DM room
    const st = this.bridge.getBridgeState?.() || {};
    const dmRoomId = st.dmRooms?.[key] || st.dmRooms?.[`${a}:${b}`] || st.dmRooms?.[`${b}:${a}`];

    if (!dmRoomId) {
      await this.reply(roomId, `No DM room found between ${a} and ${b}.`);
      return;
    }

    // Invite human to the room
    const humanUserId = `@${humanName}:${MATRIX_SERVER_NAME}`;
    try {
      const res = await fetch(`${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(dmRoomId)}/invite`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.bridge.getBotToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: humanUserId }),
      });
      const data = await res.json();
      if (data.errcode) {
        await this.reply(roomId, `Failed to invite: ${data.error || data.errcode}`);
        return;
      }
      await this.reply(roomId,
        `Invited you to DM room: ${a} ↔ ${b}. Check your invites.`,
        `Invited you to DM room: <b>${escHtml(a)}</b> ↔ <b>${escHtml(b)}</b>. Check your invites.`
      );
    } catch (e) {
      await this.reply(roomId, `Error: ${e.message}`);
    }
  }

  async cmdIdentity(roomId, args, context = {}) {
    let agentName, identity;
    if (context.targetAgent && args.length >= 1) {
      // In agent DM: !identity <text> — agent auto-detected
      agentName = args[0] && !this.bridge.isKnownAgentName(args[0])
        ? context.targetAgent  // first arg is not an agent name → treat all as identity text
        : args[0];             // first arg is an agent name → explicit override
      identity = agentName === args[0] ? args.slice(1).join(' ') : args.join(' ');
    } else if (args.length >= 2) {
      agentName = args[0];
      identity = args.slice(1).join(' ');
    } else {
      await this.reply(roomId, 'Usage: !identity <text> (in agent DM) or !identity <agent> <text>');
      return;
    }
    if (!identity) {
      await this.reply(roomId, 'Identity text required.');
      return;
    }
    const result = await api('PATCH', `/api/agents/${encodeURIComponent(agentName)}`, { identity });
    if (result.error) {
      await this.reply(roomId, `Failed: ${result.error}`);
      return;
    }
    await this.reply(roomId,
      `Identity set for ${agentName}: ${identity}`,
      `Identity set for <b>${escHtml(agentName)}</b>: ${escHtml(identity)}`
    );
  }

  async cmdBridge(roomId) {
    const st = this.bridge.getBridgeState?.() || {};

    const roomCount = Object.keys(st.roomGroupMap || {}).length;
    const dmCount = Object.keys(st.dmRooms || {}).length;
    const tokenCount = Object.keys(st.agentTokens || {}).length;
    const knownAgentCount = this.bridge.knownAgents?.size || 0;

    const lines = [
      '=== Bridge State ===',
      `Room↔Group mappings: ${roomCount}`,
      `DM rooms: ${dmCount}`,
      `Agent tokens: ${tokenCount}`,
      `Known agents: ${knownAgentCount}`,
    ];

    // List room mappings
    if (roomCount > 0) {
      lines.push('\nRoom mappings:');
      for (const [rid, gname] of Object.entries(st.roomGroupMap || {})) {
        lines.push(`  ${gname} → ${rid}`);
      }
    }

    // List DM rooms
    if (dmCount > 0) {
      lines.push('\nDM rooms:');
      for (const [key, rid] of Object.entries(st.dmRooms || {})) {
        lines.push(`  ${key} → ${rid}`);
      }
    }

    await this.reply(roomId, lines.join('\n'));
  }

  async sendAgentStatusSnapshot(roomId, agentName, target, tailLines = 5, prefix = '') {
    let tail = '';
    try {
      tail = await captureTmuxPane(target, tailLines, 5000);
    } catch (e) {
      await this.reply(roomId, `Failed to read pane: ${e.message}`);
      return;
    }
    const head = prefix ? `${prefix}\n` : '';
    const plain = `${head}=== ${agentName} (${target}) last ${tailLines} lines ===\n${tail || '(empty)'}`;
    await this.reply(roomId, plain);
  }

  scheduleAutoStatusAfterControl(roomId, agentName, target, session, baseActivitySec) {
    const MIN_ACTIVE_SEC = 5;
    setTimeout(async () => {
      try {
        // Session gone -> no follow-up status needed.
        if (!await tmuxHasSession(session, 3000)) return;
      } catch {
        return;
      }

      // Prefer backend runtime metrics; tmux session_activity deltas are noisy and
      // often over-trigger on active sessions.
      try {
        const info = await api('GET', `/api/agents/${encodeURIComponent(agentName)}`);
        const activeNow = typeof info?.activeNow === 'boolean' ? info.activeNow : null;
        const activeDurationSec = Number.isFinite(Number(info?.activeDurationSec))
          ? Math.max(0, Number(info.activeDurationSec))
          : 0;
        const idleDurationSec = Number.isFinite(Number(info?.idleDurationSec))
          ? Math.max(0, Number(info.idleDurationSec))
          : 0;

        if (activeNow === false) {
          await this.sendAgentStatusSnapshot(
            roomId,
            agentName,
            target,
            5,
            `[auto-status] still idle after 5s (idle=${Math.round(idleDurationSec)}s)`
          );
          return;
        }
        if (activeNow === true && activeDurationSec < MIN_ACTIVE_SEC) {
          await this.sendAgentStatusSnapshot(
            roomId,
            agentName,
            target,
            5,
            `[auto-status] active duration < ${MIN_ACTIVE_SEC}s (active=${Math.round(activeDurationSec)}s, idle=${Math.round(idleDurationSec)}s)`
          );
          return;
        }
        if (activeNow !== null) return;
      } catch {
        // Fall back to tmux-only heuristic below.
      }

      const nowSec = Math.floor(Date.now() / 1000);
      const curActivitySec = await getSessionActivitySec(session);
      if (!curActivitySec) {
        await this.sendAgentStatusSnapshot(
          roomId,
          agentName,
          target,
          5,
          '[auto-status] Could not determine activity; sending status snapshot.'
        );
        return;
      }

      const idleSec = Math.max(0, nowSec - curActivitySec);
      const stillIdle = curActivitySec <= (baseActivitySec || 0);
      if (!stillIdle) return;
      await this.sendAgentStatusSnapshot(
        roomId,
        agentName,
        target,
        5,
        `[auto-status] still idle after 5s (idle=${idleSec}s)`
      );
    }, 5000);
  }

  async cmdAgentctl(roomId, args, context = {}, shortMode = false) {
    if (!await hasTmuxBinary()) {
      await this.reply(roomId, 'tmux is not installed on bridge host.');
      return;
    }

    let agentName = '';
    let action = '';
    let rest = [];

    if (context.targetAgent) {
      if (shortMode) {
        agentName = context.targetAgent;
        action = (args[0] || '').toLowerCase();
        rest = args.slice(1);
      } else if (args.length >= 2) {
        agentName = args[0];
        action = (args[1] || '').toLowerCase();
        rest = args.slice(2);
      } else {
        agentName = context.targetAgent;
        action = (args[0] || '').toLowerCase();
        rest = args.slice(1);
      }
    } else {
      if (args.length < 2) {
        await this.reply(roomId, 'Usage: !agentctl <agent> status [N]|send <text>|key <K>  (or use !ctl ... inside an agent DM)');
        return;
      }
      agentName = args[0];
      action = (args[1] || '').toLowerCase();
      rest = args.slice(2);
    }

    if (!agentName) {
      await this.reply(roomId, 'Agent name required.');
      return;
    }
    if (!['status', 'send', 'key'].includes(action)) {
      await this.reply(roomId, 'Usage: status [N] | send <text> | key <K>. Restart is intentionally disabled.');
      return;
    }

    const agent = await api('GET', `/api/agents/${encodeURIComponent(agentName)}`);
    if (!agent || agent.error) {
      await this.reply(roomId, `Agent not found: ${agentName}`);
      return;
    }

    const target = (typeof agent.tmux === 'string' && agent.tmux.trim()) ? agent.tmux.trim() : `${agentName}:0.0`;
    const session = target.split(':')[0];
    if (!isSafeTmuxTarget(target) || !isSafeTmuxTarget(session)) {
      await this.reply(roomId, `Unsafe tmux target for ${agentName}: ${target}`);
      return;
    }

    if (!await tmuxHasSession(session, 3000)) {
      await this.reply(roomId, `Agent session is not alive: ${session}`);
      return;
    }

    if (action === 'status') {
      const tailLines = parseTailLines(rest[0], 5);
      if (tailLines === null) {
        await this.reply(roomId, 'Usage: !ctl status [N], where N is a positive integer (max 200).');
        return;
      }
      await this.sendAgentStatusSnapshot(roomId, agentName, target, tailLines);
      return;
    }

    if (action === 'send') {
      const payload = rest.join(' ').trim();
      if (!payload) {
        await this.reply(roomId, 'Usage: !ctl send <text>');
        return;
      }
      try {
        await runProcess('tmux', ['send-keys', '-l', '-t', target, payload], { timeout: 5000 });
        await runProcess('tmux', ['send-keys', '-t', target, 'Enter'], { timeout: 5000 });
      } catch (e) {
        await this.reply(roomId, `send failed: ${e.message}`);
        return;
      }
      const baseActivitySec = await getSessionActivitySec(session);
      this.scheduleAutoStatusAfterControl(roomId, agentName, target, session, baseActivitySec);
      await this.reply(roomId, `Sent to ${agentName}: ${payload} (auto-check in 5s for idle/short-active).`);
      return;
    }

    const keyName = (rest[0] || '').trim();
    if (!keyName) {
      await this.reply(roomId, 'Usage: !ctl key <K> (e.g. Enter, C-c, Tab)');
      return;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(keyName)) {
      await this.reply(roomId, `Invalid key token: ${keyName}`);
      return;
    }
    try {
      await runProcess('tmux', ['send-keys', '-t', target, keyName], { timeout: 5000 });
    } catch (e) {
      await this.reply(roomId, `key failed: ${e.message}`);
      return;
    }
    const baseActivitySec = await getSessionActivitySec(session);
    this.scheduleAutoStatusAfterControl(roomId, agentName, target, session, baseActivitySec);
    await this.reply(roomId, `Sent key to ${agentName}: ${keyName} (auto-check in 5s for idle/short-active).`);
  }
}

function setBotCommandsTestHooks({ execFileAsync: overrideExecFileAsync } = {}) {
  execFileAsyncImpl = typeof overrideExecFileAsync === 'function' ? overrideExecFileAsync : execFileAsync;
  tmuxBinaryAvailablePromise = null;
}

function resetBotCommandsTestHooks() {
  execFileAsyncImpl = execFileAsync;
  tmuxBinaryAvailablePromise = null;
}

export { resetBotCommandsTestHooks, setBotCommandsTestHooks, classifyCommand, authorizeCommand, COMMAND_TIERS };
