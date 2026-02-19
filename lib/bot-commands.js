import { execSync } from 'child_process';

const BACKEND_URL = process.env.AGENT_CHAT_API || 'http://127.0.0.1:8090';
const HOMESERVER = process.env.MATRIX_HOMESERVER || 'https://matrix.ananthe.party';
const AGENT_PREFIX = (process.env.MATRIX_AGENT_PREFIX || 'ac_').trim();

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const AGENT_PREFIX_RE = escapeRegex(AGENT_PREFIX);

async function api(method, path, body) {
  const opts = { method, headers: {} };
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

function hasTmuxBinary() {
  try {
    execSync('command -v tmux >/dev/null 2>&1', { timeout: 2000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isSafeTmuxTarget(value) {
  return /^[A-Za-z0-9_.:-]+$/.test(String(value || ''));
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

    try {
      switch (command) {
        case '!help':     return await this.cmdHelp(roomId);
        case '!status':   return await this.cmdStatus(roomId);
        case '!agents':   return await this.cmdAgents(roomId);
        case '!groups':   return await this.cmdGroups(roomId);
        case '!sessions': return await this.cmdSessions(roomId);
        case '!mcp':      return await this.cmdMcp(roomId);
        case '!agent':    return await this.cmdAgent(roomId, args, context);
        case '!group':    return await this.cmdGroup(roomId, args, context);
        case '!mkgroup':  return await this.cmdMkgroup(roomId, args);
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
      '  !agents          — List known agents',
      '  !groups          — List all groups',
      '  !sessions        — Tmux sessions + current process',
      '  !mcp             — MCP status per session',
      '  !bridge          — Bridge internal state',
      '  !ctl ...         — Agent control in agent DM (status/send/key)',
      '',
      'Detail:',
      '  !agent [name]    — Agent details (auto in DM)',
      '  !group [name]    — Group details (auto in group)',
      '  !agentctl <agent> status|send <text>|key <K> — Control agent pane',
      '',
      'Management:',
      '  !mkgroup <name> <m1> <m2> ...  — Create group',
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
      '<code>!agents</code> — List known agents<br>',
      '<code>!groups</code> — List all groups<br>',
      '<code>!sessions</code> — Tmux sessions + current process<br>',
      '<code>!mcp</code> — MCP status per session<br>',
      '<code>!bridge</code> — Bridge internal state<br>',
      '<code>!ctl ...</code> — Agent control in agent DM (status/send/key)<br>',
      '<br><b>Detail:</b><br>',
      '<code>!agent [name]</code> — Agent details (auto in DM)<br>',
      '<code>!group [name]</code> — Group details (auto in group)<br>',
      '<code>!agentctl &lt;agent&gt; status|send &lt;text&gt;|key &lt;K&gt;</code> — Control agent pane<br>',
      '<br><b>Management:</b><br>',
      '<code>!mkgroup &lt;name&gt; &lt;m1&gt; &lt;m2&gt; ...</code> — Create group<br>',
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
    if (!hasTmuxBinary()) {
      tmuxNote = 'tmux binary not found on bridge host';
    } else {
      try {
        const out = execSync('tmux list-sessions 2>/dev/null | wc -l', { timeout: 5000 }).toString().trim();
        sessionCount = parseInt(out) || 0;
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

  async cmdAgents(roomId) {
    const agents = await api('GET', '/api/agents');
    if (!agents.length) {
      await this.reply(roomId, 'No known agents yet.');
      return;
    }

    // Check which tmux sessions exist
    let sessions = null;
    let tmuxNote = null;
    if (!hasTmuxBinary()) {
      tmuxNote = 'tmux binary not found on bridge host';
    } else {
      try {
        const out = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', { timeout: 5000 }).toString().trim();
        sessions = new Set(out ? out.split('\n') : []);
      } catch {
        tmuxNote = 'tmux server not available; live status unknown';
      }
    }

    const lines = ['=== Known Agents ==='];
    const htmlLines = ['<b>Known Agents</b><br><br>'];

    for (const a of agents) {
      const alive = sessions ? sessions.has(a.name) : null;
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
    if (!hasTmuxBinary()) {
      await this.reply(roomId, 'tmux is not installed on bridge host.');
      return;
    }

    let out;
    try {
      out = execSync(
        'tmux list-sessions -F "#{session_name}" 2>/dev/null',
        { timeout: 5000 }
      ).toString().trim();
    } catch {
      await this.reply(roomId, 'No tmux sessions found (tmux server not running).');
      return;
    }
    if (!out) {
      await this.reply(roomId, 'No tmux sessions found.');
      return;
    }

    const sessionNames = out.split('\n');
    const lines = ['=== Tmux Sessions ==='];
    const htmlLines = ['<b>Tmux Sessions</b><br><br>'];

    for (const sess of sessionNames) {
      let proc = '-';
      try {
        // Get the active pane's current command
        const paneCmd = execSync(
          `tmux list-panes -t ${JSON.stringify(sess)} -F "#{pane_current_command}" 2>/dev/null`,
          { timeout: 5000 }
        ).toString().trim().split('\n')[0];
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
    if (!hasTmuxBinary()) {
      await this.reply(roomId, 'tmux is not installed on bridge host; cannot inspect MCP session bindings.');
      return;
    }

    // Reuse check-mcp logic: find mcp-server.js processes, map to tmux sessions
    let ptsMap = {};   // pts → session
    let mcpSessions = {};  // session → { mcp: true, client: 'claude'|'codex' }

    try {
      // Build pts → session map
      const paneOut = execSync(
        'tmux list-panes -a -F "#{pane_tty} #{session_name}" 2>/dev/null',
        { timeout: 5000 }
      ).toString().trim();
      for (const line of paneOut.split('\n')) {
        const [tty, sess] = line.split(' ');
        if (tty && sess) ptsMap[tty.replace('/dev/', '')] = sess;
      }

      // Find mcp-server.js processes
      let pids;
      try {
        pids = execSync('pgrep -f "node.*mcp-server.js" 2>/dev/null', { timeout: 5000 })
          .toString().trim().split('\n').filter(Boolean);
      } catch { pids = []; }

      for (const pid of pids) {
        try {
          const pts = execSync(`ps -o tty= -p ${pid} 2>/dev/null`, { timeout: 5000 }).toString().trim();
          const sess = ptsMap[pts];
          if (!sess) continue;

          // Check parent to determine client
          const ppid = execSync(`ps -o ppid= -p ${pid} 2>/dev/null`, { timeout: 5000 }).toString().trim();
          const pcomm = execSync(`ps -o comm= -p ${ppid} 2>/dev/null`, { timeout: 5000 }).toString().trim();
          mcpSessions[sess] = { mcp: true, client: pcomm === 'codex' ? 'codex' : 'claude' };
        } catch { /* skip */ }
      }
    } catch { /* no tmux */ }

    // Get known agents
    const agents = await api('GET', '/api/agents');
    const known = new Set(agents.map(a => a.name));

    // List all sessions
    let allSessions;
    try {
      allSessions = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', { timeout: 5000 })
        .toString().trim().split('\n').filter(Boolean).sort();
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
    let sessionAlive = false;
    try {
      execSync(`tmux has-session -t ${JSON.stringify(name)} 2>/dev/null`, { timeout: 5000 });
      sessionAlive = true;
    } catch { /* not found */ }

    // Find DM rooms involving this agent
    const st = this.bridge.getBridgeState?.() || {};
    const dms = Object.entries(st.dmRooms || {})
      .filter(([key]) => key.split(':').includes(name))
      .map(([key]) => {
        const parts = key.split(':');
        return parts[0] === name ? parts[1] : parts[0];
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

  async cmdMkgroup(roomId, args) {
    if (args.length < 1) {
      await this.reply(roomId, 'Usage: !mkgroup <name> [member1] [member2] ...');
      return;
    }
    const name = args[0];
    const members = args.slice(1);
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
          formatted_body: `👋 <a href="https://matrix.to/#/@${humanName}:matrix.kusuri.ai">${escHtml(humanName)}</a> — your DM with <b>${escHtml(agentName)}</b> is here!`,
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
    const humanUserId = `@${humanName}:matrix.kusuri.ai`;
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
      agentName = args[0] && !this.bridge.knownAgents.has(args[0])
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

  async cmdAgentctl(roomId, args, context = {}, shortMode = false) {
    if (!hasTmuxBinary()) {
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
        await this.reply(roomId, 'Usage: !agentctl <agent> status|send <text>|key <K>  (or use !ctl ... inside an agent DM)');
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
      await this.reply(roomId, 'Usage: status | send <text> | key <K>. Restart is intentionally disabled.');
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

    try {
      execSync(`tmux has-session -t ${JSON.stringify(session)} 2>/dev/null`, { timeout: 3000, stdio: 'ignore' });
    } catch {
      await this.reply(roomId, `Agent session is not alive: ${session}`);
      return;
    }

    if (action === 'status') {
      let tail = '';
      try {
        tail = execSync(`tmux capture-pane -t ${JSON.stringify(target)} -p -S -15`, { timeout: 5000 }).toString();
      } catch (e) {
        await this.reply(roomId, `Failed to read pane: ${e.message}`);
        return;
      }
      const plain = `=== ${agentName} (${target}) last 15 lines ===\n${tail || '(empty)'}`;
      await this.reply(roomId, plain);
      return;
    }

    if (action === 'send') {
      const payload = rest.join(' ').trim();
      if (!payload) {
        await this.reply(roomId, 'Usage: !ctl send <text>');
        return;
      }
      try {
        execSync(`tmux send-keys -l -t ${JSON.stringify(target)} ${JSON.stringify(payload)}`, { timeout: 5000 });
        execSync(`tmux send-keys -t ${JSON.stringify(target)} Enter`, { timeout: 5000 });
      } catch (e) {
        await this.reply(roomId, `send failed: ${e.message}`);
        return;
      }
      await this.reply(roomId, `Sent to ${agentName}: ${payload}`);
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
      execSync(`tmux send-keys -t ${JSON.stringify(target)} ${keyName}`, { timeout: 5000 });
    } catch (e) {
      await this.reply(roomId, `key failed: ${e.message}`);
      return;
    }
    await this.reply(roomId, `Sent key to ${agentName}: ${keyName}`);
  }
}
