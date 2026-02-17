import {
  MatrixClient,
  SimpleFsStorageProvider,
  AutojoinRoomsMixin,
} from 'matrix-bot-sdk';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import EventSource from './lib/eventsource-mini.js';
import BotCommands from './lib/bot-commands.js';

// ── Configuration ─────────────────────────────────────────────────────
const HOMESERVER = process.env.MATRIX_HOMESERVER || 'https://matrix.ananthe.party';
const REGISTRATION_TOKEN = process.env.MATRIX_REG_TOKEN || 'REDACTED_REG_TOKEN';
const BACKEND_URL = process.env.AGENT_CHAT_API || 'http://127.0.0.1:8090';
const MSG_BASE_URL = process.env.MSG_BASE_URL || 'https://agent.ananthe.party/msg';
const BOT_USERNAME = 'agent-bridge';
const BOT_PASSWORD = 'REDACTED_BOT_PASSWORD';
const AGENT_PREFIX = 'ac_'; // Matrix usernames: ac_agentname
const DATA_DIR = path.resolve('data/matrix');

mkdirSync(DATA_DIR, { recursive: true });

// ── State persistence ─────────────────────────────────────────────────
function loadState() {
  try {
    return JSON.parse(readFileSync(path.join(DATA_DIR, 'bridge-state.json'), 'utf-8'));
  } catch {
    return { botToken: null, agentTokens: {}, roomGroupMap: {}, groupRoomMap: {} };
  }
}
function saveState() {
  writeFileSync(path.join(DATA_DIR, 'bridge-state.json'), JSON.stringify(state, null, 2));
}
const state = loadState();

// ── Matrix account management ─────────────────────────────────────────
async function matrixRegister(username, password) {
  // Step 1: get session
  const probe = await fetch(`${HOMESERVER}/_matrix/client/v3/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const probeData = await probe.json();
  const session = probeData.session;
  if (!session) throw new Error(`No session in registration probe: ${JSON.stringify(probeData)}`);

  // Step 2: register with token
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password,
      auth: { type: 'm.login.registration_token', token: REGISTRATION_TOKEN, session },
    }),
  });
  const data = await res.json();
  if (data.access_token) return data;
  throw new Error(`Registration failed for ${username}: ${JSON.stringify(data)}`);
}

async function matrixLogin(username, password) {
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: username },
      password,
    }),
  });
  const data = await res.json();
  if (data.access_token) return data;
  throw new Error(`Login failed for ${username}: ${JSON.stringify(data)}`);
}

async function ensureBotAccount() {
  if (state.botToken) {
    try {
      const client = new MatrixClient(HOMESERVER, state.botToken, new SimpleFsStorageProvider(path.join(DATA_DIR, 'bot-store.json')));
      await client.getUserId();
      return state.botToken;
    } catch { /* token expired, re-login */ }
  }
  try {
    const data = await matrixLogin(BOT_USERNAME, BOT_PASSWORD);
    state.botToken = data.access_token;
    saveState();
    console.log(`Bot logged in as ${data.user_id}`);
    return data.access_token;
  } catch {
    const data = await matrixRegister(BOT_USERNAME, BOT_PASSWORD);
    state.botToken = data.access_token;
    saveState();
    console.log(`Bot registered as ${data.user_id}`);
    return data.access_token;
  }
}

async function ensureAgentAccount(agentName) {
  const matrixUsername = `${AGENT_PREFIX}${agentName}`;
  const password = `agent-${agentName}-2026`;

  if (state.agentTokens[agentName]) {
    try {
      const res = await fetch(`${HOMESERVER}/_matrix/client/v3/account/whoami`, {
        headers: { Authorization: `Bearer ${state.agentTokens[agentName]}` },
      });
      if (res.ok) return state.agentTokens[agentName];
    } catch { /* re-login */ }
  }

  try {
    const data = await matrixLogin(matrixUsername, password);
    state.agentTokens[agentName] = data.access_token;
    saveState();
    return data.access_token;
  } catch {
    const data = await matrixRegister(matrixUsername, password);
    state.agentTokens[agentName] = data.access_token;
    saveState();
    console.log(`Registered Matrix account for agent: ${agentName} → @${matrixUsername}:matrix.kusuri.ai`);
    // Set display name
    await setDisplayName(data.access_token, agentName);
    return data.access_token;
  }
}

async function setDisplayName(token, agentName) {
  const userId = await getUserId(token);
  await fetch(`${HOMESERVER}/_matrix/client/v3/profile/${encodeURIComponent(userId)}/displayname`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayname: `🤖 ${agentName}` }),
  });
}

async function getUserId(token) {
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3/account/whoami`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.user_id;
}

// ── Backend API helpers ───────────────────────────────────────────────
async function backendApi(method, path, body) {
  const opts = { method, headers: {} };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${BACKEND_URL}${path}`, opts);
  return res.json();
}

// ── Room ↔ Group mapping ─────────────────────────────────────────────
function mapRoom(roomId, groupName) {
  state.roomGroupMap[roomId] = groupName;
  state.groupRoomMap[groupName] = roomId;
  saveState();
}

function groupForRoom(roomId) { return state.roomGroupMap[roomId] || null; }
function roomForGroup(groupName) { return state.groupRoomMap[groupName] || null; }

// ── Extract agent name from Matrix user ID ───────────────────────────
function agentNameFromUserId(userId) {
  // @ac_agentname:matrix.kusuri.ai → agentname
  const match = userId.match(new RegExp(`^@${AGENT_PREFIX}([^:]+):`));
  return match ? match[1] : null;
}

function humanNameFromUserId(userId) {
  // @overseer:matrix.kusuri.ai → overseer
  const match = userId.match(/^@([^:]+):/);
  return match ? match[1] : userId;
}

function isAgentUser(userId) {
  return userId.includes(`:`) && userId.startsWith(`@${AGENT_PREFIX}`);
}

// ── Parse mentions from Matrix message ───────────────────────────────
function parseMentions(content, plainBody = null) {
  const mentions = [];

  // 1. Parse m.mentions.user_ids (modern Matrix spec)
  if (content['m.mentions']?.user_ids) {
    for (const userId of content['m.mentions'].user_ids) {
      // @ac_agentname:matrix.kusuri.ai → agentname
      const agentMatch = userId.match(new RegExp(`^@${AGENT_PREFIX}([^:]+):`));
      if (agentMatch) {
        mentions.push(agentMatch[1]);
      } else {
        // @username:matrix.kusuri.ai → username (human or other)
        const userMatch = userId.match(/^@([^:]+):/);
        if (userMatch) mentions.push(userMatch[1]);
      }
    }
  }

  // 2. Fallback: parse HTML pills from formatted_body
  if (!mentions.length && content.formatted_body) {
    const hrefRegex = /matrix\.to\/#\/@(ac_)?([a-z0-9_-]+):/gi;
    let match;
    while ((match = hrefRegex.exec(content.formatted_body)) !== null) {
      mentions.push(match[2]);
    }
  }

  // 3. Fallback: plain text @mentions in body
  const body = typeof plainBody === 'string' ? plainBody : content.body;
  if (!mentions.length && body) {
    const atRegex = /@(ac_)?([a-z0-9_-]+)/gi;
    let match;
    while ((match = atRegex.exec(body)) !== null) {
      if (match[1]) mentions.push(match[2]); // @ac_agentname
      else mentions.push(match[0].slice(1)); // @agentname
    }
  }

  return [...new Set(mentions)];
}

function stripMatrixReplyFallback(body) {
  if (typeof body !== 'string') return '';
  const lines = body.split('\n');
  let idx = 0;
  while (idx < lines.length && lines[idx].startsWith('> ')) idx++;
  if (idx > 0 && idx < lines.length && lines[idx].trim() === '') {
    return lines.slice(idx + 1).join('\n').trim();
  }
  return body.trim();
}

function parseInboundTextMessage(content) {
  if (!content || typeof content !== 'object') {
    return { skip: true, body: '', replyEventId: null };
  }
  if (content.msgtype && !['m.text', 'm.notice'].includes(content.msgtype)) {
    return { skip: true, body: '', replyEventId: null };
  }
  const relates = content['m.relates_to'] || {};
  if (relates.rel_type === 'm.replace') {
    // Ignore edit events: they should not create a new agent-chat message.
    return { skip: true, body: '', replyEventId: null };
  }
  const replyEventId = relates?.['m.in_reply_to']?.event_id || null;
  const rawBody = typeof content.body === 'string' ? content.body : '';
  const body = replyEventId ? stripMatrixReplyFallback(rawBody) : rawBody.trim();
  return { skip: !body, body, replyEventId };
}

// ── Main bridge class ─────────────────────────────────────────────────
class MatrixBridge {
  constructor() {
    this.botClient = null;
    this.botUserId = null;
    this.knownAgents = new Set(); // names of known agents
    this.dmRooms = new Map(); // "agent:human" → roomId
    this.recentBridgedIds = new Set(); // prevent echo loops
    this.recentlyCreatedRooms = new Set(); // rooms we just created (suppress echo)
    this.recentMatrixEvents = new Map(); // event_id -> { ts, msgId }
    this.startupTs = Date.now();
    this.commands = null;
  }

  // Not a registered agent → human
  isHuman(name) {
    return !this.knownAgents.has(name);
  }

  // Expose state for bot commands
  getBridgeState() {
    return {
      roomGroupMap: state.roomGroupMap,
      groupRoomMap: state.groupRoomMap,
      dmRooms: state.dmRooms || {},
      agentTokens: Object.fromEntries(Object.keys(state.agentTokens).map(k => [k, '***'])),
    };
  }

  // Expose groupRoomMap for /group command
  get groupRoomMap() { return state.groupRoomMap; }

  getBotToken() { return state.botToken; }
  getAgentToken(name) { return state.agentTokens[name] || null; }
  isKnownAgentName(name) { return this.knownAgents.has(name); }

  rememberMatrixEvent(eventId, msgId = null) {
    if (!eventId) return;
    const prev = this.recentMatrixEvents.get(eventId);
    const next = { ts: Date.now(), msgId: msgId || prev?.msgId || null };
    this.recentMatrixEvents.set(eventId, next);

    if (this.recentMatrixEvents.size > 5000) {
      const cutoff = Date.now() - (6 * 60 * 60 * 1000); // 6h
      for (const [eid, meta] of this.recentMatrixEvents.entries()) {
        if (!meta || meta.ts < cutoff) this.recentMatrixEvents.delete(eid);
      }
      if (this.recentMatrixEvents.size > 4500) {
        // Hard cap fallback: drop oldest keys.
        const keep = [...this.recentMatrixEvents.entries()]
          .sort((a, b) => (b[1]?.ts || 0) - (a[1]?.ts || 0))
          .slice(0, 3500);
        this.recentMatrixEvents = new Map(keep);
      }
    }
  }

  isDuplicateMatrixEvent(eventId) {
    if (!eventId) return false;
    return this.recentMatrixEvents.has(eventId);
  }

  resolveReplyToMessageId(replyEventId) {
    if (!replyEventId) return null;
    return this.recentMatrixEvents.get(replyEventId)?.msgId || null;
  }

  postWarning(message) {
    backendApi('POST', '/api/messages', {
      from: 'system',
      group: 'info',
      type: 'inform',
      summary: `⚠️ Bridge warning: ${message}`,
      full: '',
      mentions: [],
    }).catch(e => console.error('Failed to post warning:', e.message));
  }

  async start() {
    console.log('=== Agent Chat Matrix Bridge ===');
    console.log(`Homeserver: ${HOMESERVER}`);
    console.log(`Backend: ${BACKEND_URL}`);

    // 1. Ensure bot account
    const botToken = await ensureBotAccount();
    this.botClient = new MatrixClient(HOMESERVER, botToken, new SimpleFsStorageProvider(path.join(DATA_DIR, 'bot-store.json')));
    AutojoinRoomsMixin.setupOnClient(this.botClient);
    this.botUserId = await this.botClient.getUserId();
    console.log(`Bot: ${this.botUserId}`);

    // 2. Ensure agent accounts for all known agents
    const agents = await backendApi('GET', '/api/agents');
    const validAgentNames = new Set();
    for (const agent of agents) {
      validAgentNames.add(agent.name);
      await ensureAgentAccount(agent.name);
      this.knownAgents.add(agent.name);
    }
    // Drop stale tokens that were created for non-agent users.
    let cleanedTokenCount = 0;
    for (const name of Object.keys(state.agentTokens || {})) {
      if (!validAgentNames.has(name)) {
        delete state.agentTokens[name];
        cleanedTokenCount++;
      }
    }
    if (cleanedTokenCount > 0) {
      saveState();
      console.log(`Pruned ${cleanedTokenCount} stale Matrix tokens for non-agent users`);
    }
    console.log(`Agent accounts: ${this.knownAgents.size}`);

    // 3. Set up bot commands
    this.commands = new BotCommands({
      botClient: this.botClient,
      bridge: this,
      botUserId: this.botUserId,
    });

    // 4. Set up Matrix event listeners
    this.botClient.on('room.message', this.onRoomMessage.bind(this));
    this.botClient.on('room.event', this.onRoomEvent.bind(this));

    // 5. Start bot sync
    await this.botClient.start();
    console.log('Bot syncing...');

    // 6. Listen to backend SSE for agent-chat → Matrix
    this.connectSSE();

    // 7. Scan all joined rooms for unmapped groups
    await this.scanJoinedRooms();

    // 8. Periodically check agent accounts for pending invites
    this.pollAgentInvites();
    setInterval(() => this.pollAgentInvites(), 30_000);

    // 8. Poll for new agents and humans
    await this.pollRegistrations();
    setInterval(() => this.pollRegistrations(), 30_000);

    console.log('Bridge running.');
  }

  async pollRegistrations() {
    // Poll new agents from backend
    try {
      const agents = await backendApi('GET', '/api/agents');
      const validAgentNames = new Set(agents.map(a => a.name));
      for (const agent of agents) {
        if (!this.knownAgents.has(agent.name)) {
          await ensureAgentAccount(agent.name);
          this.knownAgents.add(agent.name);
          console.log(`Discovered new agent: ${agent.name}`);
        }
      }
      let pruned = 0;
      for (const name of Object.keys(state.agentTokens || {})) {
        if (!validAgentNames.has(name)) {
          delete state.agentTokens[name];
          pruned++;
        }
      }
      if (pruned > 0) {
        saveState();
        console.log(`Pruned ${pruned} stale Matrix tokens during registration poll`);
      }
    } catch (e) {
      console.error('Failed to poll agents:', e.message);
    }

    // Discover humans from Matrix user directory and greet them
    await this.discoverAndGreetHumans();
  }

  async discoverAndGreetHumans() {
    if (!state.greetedHumans) state.greetedHumans = [];
    const SKIP_USERS = new Set([BOT_USERNAME, 'conduit']);

    try {
      const res = await fetch(`${HOMESERVER}/_matrix/client/v3/user_directory/search`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${state.botToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ search_term: '', limit: 100 }),
      });
      const data = await res.json();
      if (!data.results) return;

      for (const user of data.results) {
        const match = user.user_id.match(/^@([^:]+):/);
        if (!match) continue;
        const name = match[1];

        // Skip agents, bot, system accounts, underscore-prefixed
        if (name.startsWith(AGENT_PREFIX)) continue;
        if (name.startsWith('_')) continue;
        if (SKIP_USERS.has(name)) continue;
        if (state.greetedHumans.includes(name)) continue;

        // This is an ungreeted human — create DM and greet
        await this.greetHuman(name, user.user_id);
      }
    } catch (e) {
      console.error('Failed to discover humans:', e.message);
    }
  }

  async ensureBotDmRoom(humanName, matrixUserId) {
    if (!state.botDmRooms) state.botDmRooms = {};
    if (state.botDmRooms[humanName]) return state.botDmRooms[humanName];

    try {
      const res = await fetch(`${HOMESERVER}/_matrix/client/v3/createRoom`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${state.botToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          is_direct: true,
          invite: [matrixUserId],
          preset: 'trusted_private_chat',
        }),
      });
      const data = await res.json();
      if (data.room_id) {
        state.botDmRooms[humanName] = data.room_id;
        saveState();
        return data.room_id;
      }
      console.error(`Failed to create bot DM room for ${humanName}:`, data);
    } catch (e) {
      console.error(`Error creating bot DM room for ${humanName}:`, e.message);
    }
    return null;
  }

  async greetHuman(humanName, matrixUserId) {
    const roomId = await this.ensureBotDmRoom(humanName, matrixUserId);
    if (!roomId) return;

    try {
      await this.botClient.sendMessage(roomId, {
        msgtype: 'm.text',
        body: `Hey ${humanName}! I'm the Agent Bridge bot.\n\nSend !help to see what I can do — manage agents, groups, sessions, and more.`,
        format: 'org.matrix.custom.html',
        formatted_body: `Hey <b>${humanName}</b>! I'm the Agent Bridge bot.<br><br>Send <code>!help</code> to see what I can do — manage agents, groups, sessions, and more.`,
      });

      if (!state.greetedHumans) state.greetedHumans = [];
      state.greetedHumans.push(humanName);
      saveState();
      console.log(`Greeted human: ${humanName}`);
    } catch (e) {
      console.error(`Failed to greet ${humanName}:`, e.message);
    }
  }

  async sendDeliveryNotice(roomId, text) {
    if (!text) return;
    try {
      await this.botClient.sendMessage(roomId, { msgtype: 'm.text', body: text });
    } catch (e) {
      console.error('Failed to send delivery notice:', e.message);
    }
  }

  async handleMessageDeliveryFeedback(roomId, result) {
    if (!result || typeof result !== 'object') return;
    const lines = [];

    if (result.error) {
      lines.push(`⚠️ Message not delivered: ${result.error}`);
    }

    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    for (const warning of warnings) {
      if (warning.code === 'target_offline' && warning.target) {
        const reason = warning.reason ? ` (${warning.reason})` : '';
        lines.push(`⚠️ @${warning.target} is offline${reason}. Message archived only and was not delivered.`);
        continue;
      }
      if (warning.code === 'mentions_offline' && Array.isArray(warning.targets) && warning.targets.length > 0) {
        const targets = warning.targets
          .filter(t => t?.target)
          .map(t => `@${t.target}${t.reason ? ` (${t.reason})` : ''}`)
          .join(', ');
        if (targets) {
          lines.push(`⚠️ Offline mentions were archived only: ${targets}.`);
        }
      }
    }

    if (lines.length > 0) {
      await this.sendDeliveryNotice(roomId, lines.join('\n'));
    }
  }

  async submitHumanMessage(roomId, payload) {
    try {
      const result = await backendApi('POST', '/api/messages', payload);
      await this.handleMessageDeliveryFeedback(roomId, result);
      return result;
    } catch (e) {
      await this.sendDeliveryNotice(roomId, `⚠️ Message not delivered: backend unreachable (${e.message}).`);
      return { error: e.message };
    }
  }

  // ── Matrix → Agent-chat ───────────────────────────────────────────
  async onRoomMessage(roomId, event) {
    const eventId = event?.event_id || null;
    if (eventId && this.isDuplicateMatrixEvent(eventId)) return;

    const parsed = parseInboundTextMessage(event.content);
    if (parsed.skip) return;
    if (eventId) this.rememberMatrixEvent(eventId);

    const senderId = event.sender;

    // Ignore messages from our agent accounts (prevent loops)
    if (isAgentUser(senderId)) return;
    if (senderId === this.botUserId) return;

    const groupName = groupForRoom(roomId);
    const humanName = humanNameFromUserId(senderId);
    const body = parsed.body;
    const mentions = parseMentions(event.content, body);
    const replyTo = this.resolveReplyToMessageId(parsed.replyEventId);

    // Check if this is a DM room (bot-DM or agent-DM)
    let targetAgent = null;
    let isBotDm = false;
    try {
      const members = await this.botClient.getJoinedRoomMembers(roomId);
      const nonBot = members.filter(m => m !== this.botUserId);
      const agentMembers = nonBot.filter(m => isAgentUser(m));
      const humanMembers = nonBot.filter(m => !isAgentUser(m));

      if (agentMembers.length === 1 && humanMembers.length >= 1 && !isAgentUser(senderId)) {
        // 1 agent + 1-2 humans + bot → agent DM
        targetAgent = agentNameFromUserId(agentMembers[0]);
      } else if (agentMembers.length === 0 && humanMembers.length >= 1) {
        // Only humans + bot in room → bot command DM
        isBotDm = true;
      }
    } catch { /* ignore */ }

    // ! commands work in any room (bot-DM, group, agent-DM)
    if (body.trim().startsWith('!')) {
      const context = { groupName, targetAgent };
      console.log(`Bot command from ${humanName} in ${groupName || targetAgent || 'bot-DM'}: ${body.slice(0, 80)}`);
      await this.commands.handle(roomId, senderId, body, context);
      return;
    }

    if (isBotDm) {
      // Non-command text in bot DM
      await this.commands.handle(roomId, senderId, body, {});
    } else if (targetAgent) {
      // DM to agent
      console.log(`Matrix DM: ${humanName} → ${targetAgent}: ${body.slice(0, 80)}`);
      const result = await this.submitHumanMessage(roomId, {
        from: humanName,
        to: targetAgent,
        type: 'human',
        summary: body,
        full: '',
        mentions: [],
        reply_to: replyTo,
        source: 'matrix',
        target_type: 'agent',
      });
      if (eventId && result?.id) this.rememberMatrixEvent(eventId, result.id);
    } else if (groupName) {
      // Group message from human
      console.log(`Matrix group: ${humanName} → ${groupName}: ${body.slice(0, 80)}`);
      // Ensure @ prefix on mentioned names in body (Matrix pills strip @ in plain text)
      let summary = body;
      for (const name of mentions) {
        const re = new RegExp(`(?<!@)\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
        summary = summary.replace(re, '@' + name);
      }
      const result = await this.submitHumanMessage(roomId, {
        from: humanName,
        group: groupName,
        type: 'human',
        summary,
        full: '',
        mentions,
        reply_to: replyTo,
        source: 'matrix',
      });
      if (eventId && result?.id) this.rememberMatrixEvent(eventId, result.id);
    }
    // else: unknown room, ignore
  }

  async onRoomEvent(roomId, event) {
    // Ignore historical events from before bridge startup
    // But always process m.room.name (needed for mapping rooms bot joins after creation)
    if (event.type !== 'm.room.name' && event.origin_server_ts && event.origin_server_ts < this.startupTs) return;

    // Handle room creation, membership changes
    if (event.type === 'm.room.name' && event.content?.name) {
      const name = event.content.name;
      if (!groupForRoom(roomId)) {
        // New room name set → map to group
        const existing = await backendApi('GET', `/api/groups/${encodeURIComponent(name)}`);
        if (existing.error) {
          // Create group in backend
          const members = await this.getRoomAgentMembers(roomId);
          const humanMembers = await this.getRoomHumanMembers(roomId);
          await backendApi('POST', '/api/groups', {
            name,
            members: [...members, ...humanMembers],
          });
          console.log(`Created group "${name}" from Matrix room`);
        }
        mapRoom(roomId, name);
      }
    }

    if (event.type === 'm.room.member') {
      const targetUserId = event.state_key;
      const membership = event.content?.membership;

      // Bot joined a room → check if it needs mapping
      if (targetUserId === this.botUserId && membership === 'join') {
        await this.tryMapRoom(roomId);
        return;
      }

      // Bot kicked/left from a group room → remove group mapping
      if (targetUserId === this.botUserId && (membership === 'leave' || membership === 'ban')) {
        const groupName = groupForRoom(roomId);
        if (groupName) {
          delete state.roomGroupMap[roomId];
          delete state.groupRoomMap[groupName];
          saveState();
          console.log(`Bot removed from room ${roomId}, unmapped group "${groupName}"`);
        }
        return;
      }

      const groupName = groupForRoom(roomId);
      if (!groupName) return;
      // Skip membership events for rooms we just created (prevents echo loop)
      if (this.recentlyCreatedRooms.has(roomId)) return;

      let memberName;
      if (isAgentUser(targetUserId)) {
        memberName = agentNameFromUserId(targetUserId);
      } else if (targetUserId !== this.botUserId) {
        memberName = humanNameFromUserId(targetUserId);
      }

      if (!memberName) return;

      if (membership === 'join') {
        await backendApi('POST', `/api/groups/${encodeURIComponent(groupName)}/members`, { add: [memberName] });
        console.log(`Added ${memberName} to group ${groupName}`);
      } else if (membership === 'leave' || membership === 'ban') {
        await backendApi('POST', `/api/groups/${encodeURIComponent(groupName)}/members`, { remove: [memberName] });
        console.log(`Removed ${memberName} from group ${groupName}`);
      }
    }

    // Room tombstone → clean up mapping
    if (event.type === 'm.room.tombstone') {
      const groupName = groupForRoom(roomId);
      if (groupName) {
        delete state.roomGroupMap[roomId];
        delete state.groupRoomMap[groupName];
        saveState();
        console.log(`Room ${roomId} tombstoned, unmapped group "${groupName}"`);
      }
    }
  }

  async scanJoinedRooms() {
    try {
      const rooms = await this.botClient.getJoinedRooms();
      for (const roomId of rooms) {
        if (groupForRoom(roomId)) continue; // already mapped
        await this.tryMapRoom(roomId);
      }
    } catch (e) {
      console.error('Failed to scan joined rooms:', e.message);
    }
  }

  async tryMapRoom(roomId) {
    if (groupForRoom(roomId)) return; // already mapped
    // Check if this is a DM room or bot-DM (skip those)
    try {
      const members = await this.botClient.getJoinedRoomMembers(roomId);
      const nonBot = members.filter(m => m !== this.botUserId);
      if (nonBot.length <= 2) return; // DM or bot-DM, not a group
    } catch { return; }

    // Get room name via state event
    try {
      const nameEvent = await this.botClient.getRoomStateEvent(roomId, 'm.room.name', '');
      const name = nameEvent?.name;
      if (!name) return;

      // Skip DM rooms (name format: "DM: X" or "SPY: X ↔ Y")
      if (name.startsWith('DM: ') || name.startsWith('SPY: ')) return;

      // Check if group exists in backend, create if not
      const existing = await backendApi('GET', `/api/groups/${encodeURIComponent(name)}`);
      if (existing.error) {
        const agentMembers = await this.getRoomAgentMembers(roomId);
        const humanMembers = await this.getRoomHumanMembers(roomId);
        await backendApi('POST', '/api/groups', {
          name,
          members: [...agentMembers, ...humanMembers],
        });
        console.log(`Created group "${name}" from room bot joined`);
      }
      mapRoom(roomId, name);
      console.log(`Mapped room ${roomId} → group "${name}"`);
    } catch (e) {
      // Room might not have a name — that's fine, not a group room
    }
  }

  async getRoomAgentMembers(roomId) {
    try {
      const members = await this.botClient.getJoinedRoomMembers(roomId);
      return members.filter(m => isAgentUser(m)).map(m => agentNameFromUserId(m)).filter(Boolean);
    } catch { return []; }
  }

  async getRoomHumanMembers(roomId) {
    try {
      const members = await this.botClient.getJoinedRoomMembers(roomId);
      return members
        .filter(m => !isAgentUser(m) && m !== this.botUserId)
        .map(m => humanNameFromUserId(m));
    } catch { return []; }
  }

  // ── Poll agent accounts for pending invites ─────────────────────
  async pollAgentInvites() {
    for (const agentName of this.knownAgents) {
      const token = state.agentTokens[agentName];
      if (!token) continue;
      try {
        // Sync to get invited rooms
        const res = await fetch(`${HOMESERVER}/_matrix/client/v3/sync?filter={"room":{"timeline":{"limit":0}}}&timeout=0`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        const invited = data?.rooms?.invite || {};
        for (const roomId of Object.keys(invited)) {
          // Auto-join
          const joinRes = await fetch(`${HOMESERVER}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: '{}',
          });
          if ((await joinRes.json()).room_id) {
            console.log(`Agent ${agentName} joined room ${roomId}`);
            // Invite bot so it can monitor messages
            await fetch(`${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ user_id: this.botUserId }),
            });
            console.log(`Invited bot into room ${roomId}`);
          }
        }
      } catch (e) {
        // Silently skip — token might be expired
      }
    }
    // Re-scan for any newly joined rooms that need mapping
    await this.scanJoinedRooms();
  }

  // ── Agent-chat → Matrix ───────────────────────────────────────────
  connectSSE() {
    const url = `${BACKEND_URL}/api/stream`;
    console.log(`Connecting SSE: ${url}`);

    const connect = () => {
      const es = new EventSource(url);
      es.on('message', (data) => {
        try {
          const msg = JSON.parse(data);
          if (msg.source === 'matrix') return; // prevent loops
          this.onAgentMessage(msg);
        } catch { /* ignore */ }
      });
      es.on('group_created', (data) => {
        try {
          const group = JSON.parse(data);
          console.log(`SSE: group created "${group.name}" with members: ${group.members.join(', ')}`);
          this.onGroupCreated(group);
        } catch { /* ignore */ }
      });
      es.on('group_members', (data) => {
        try {
          const update = JSON.parse(data);
          console.log(`SSE: group "${update.name}" members updated — added: [${update.added}], removed: [${update.removed}]`);
          this.onGroupMembersChanged(update);
        } catch { /* ignore */ }
      });
      es.on('error', () => {
        console.error('SSE disconnected, reconnecting in 5s...');
        setTimeout(connect, 5000);
      });
    };
    connect();
  }

  async onGroupCreated(group) {
    // Skip if room already exists for this group (e.g. created from Matrix)
    if (roomForGroup(group.name)) return;

    // Ensure agent accounts exist for agent members
    for (const m of group.members) {
      if (this.isKnownAgentName(m) && !state.agentTokens[m]) {
        await ensureAgentAccount(m);
      }
    }
    await this.createRoomForGroup(group.name, group.members);
  }

  async onGroupMembersChanged(update) {
    const roomId = roomForGroup(update.name);
    if (!roomId) return;

    // Get current room members to avoid re-inviting
    let currentMembers = new Set();
    try {
      const members = await this.botClient.getJoinedRoomMembers(roomId);
      currentMembers = new Set(members);
    } catch { /* ignore */ }

    // Invite newly added members
    for (const m of (update.added || [])) {
      // Check backend API to determine if member is an agent (avoids stale knownAgents race)
      let isAgent = this.isKnownAgentName(m);
      if (!isAgent) {
        try {
          const info = await backendApi('GET', `/api/agents/${encodeURIComponent(m)}`);
          if (info && !info.error && info.type === 'agent') {
            isAgent = true;
            this.knownAgents.add(m);
          }
        } catch { /* not an agent */ }
      }

      // Ensure agent has a Matrix account
      if (isAgent && !state.agentTokens[m]) {
        await ensureAgentAccount(m);
      }

      let userId;
      if (isAgent && state.agentTokens[m]) {
        userId = await getUserId(state.agentTokens[m]);
        if (currentMembers.has(userId)) continue; // already in room
        // Also auto-join with agent token
        await fetch(`${HOMESERVER}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${state.agentTokens[m]}`, 'Content-Type': 'application/json' },
          body: '{}',
        });
      } else if (isAgent) {
        // Agent without token (ensureAgentAccount may have failed) — use ac_ prefix
        userId = `@${AGENT_PREFIX}${m}:matrix.kusuri.ai`;
        if (currentMembers.has(userId)) continue;
      } else {
        // Human — use plain name
        userId = `@${m}:matrix.kusuri.ai`;
        if (currentMembers.has(userId)) continue;
      }
      try {
        await fetch(`${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${state.botToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: userId }),
        });
        console.log(`Invited ${m} (${userId}) to Matrix room for ${update.name}`);
      } catch (e) {
        console.error(`Failed to invite ${m} to ${update.name}:`, e.message);
        // Report to info group
        this.postWarning(`Failed to invite ${m} to Matrix room for group "${update.name}": ${e.message}`);
      }
    }

    // Kick removed members
    for (const m of (update.removed || [])) {
      let userId;
      if (this.isKnownAgentName(m) && state.agentTokens[m]) {
        userId = await getUserId(state.agentTokens[m]);
      } else {
        userId = `@${m}:matrix.kusuri.ai`;
      }
      try {
        await fetch(`${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/kick`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${state.botToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: userId, reason: 'Removed from agent-chat group' }),
        });
        console.log(`Kicked ${m} (${userId}) from Matrix room for ${update.name}`);
      } catch (e) {
        console.error(`Failed to kick ${m}:`, e.message);
      }
    }
  }

  async onAgentMessage(msg) {
    if (this.recentBridgedIds.has(msg.id)) return;
    this.recentBridgedIds.add(msg.id);
    // Cleanup old IDs
    if (this.recentBridgedIds.size > 500) {
      const arr = [...this.recentBridgedIds];
      this.recentBridgedIds = new Set(arr.slice(-250));
    }

    const agentName = msg.from;

    // Don't bridge human messages (they come from Matrix)
    if (msg.type === 'human') return;

    const token = state.agentTokens[agentName];
    if (!token) {
      // Unknown agent, ensure account exists
      if (!this.isKnownAgentName(agentName)) {
        await ensureAgentAccount(agentName);
        this.knownAgents.add(agentName);
      }
    }

    const agentToken = state.agentTokens[agentName];
    if (!agentToken) {
      console.warn(`No Matrix token for agent "${agentName}", cannot bridge message ${msg.id}`);
      this.postWarning(`No Matrix token for agent "${agentName}" — message ${msg.id} not bridged to Matrix`);
      return;
    }

    // Build Matrix message — always show full content when available
    const hasFull = msg.full && msg.full.length > 0;
    const typeBadge = msg.type === 'request' ? '📋' : msg.type === 'reply' ? '↩️' : 'ℹ️';
    const mentionText = msg.mentions?.length ? ` · ${msg.mentions.map(m => '@' + m).join(' ')}` : '';
    const escHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const htmlMentions = msg.mentions?.length ? ` · ${msg.mentions.map(m => '<b>@' + escHtml(m) + '</b>').join(' ')}` : '';

    let plain, html;
    if (hasFull) {
      const msgUrl = `${MSG_BASE_URL}/${msg.id}`;
      plain = `${typeBadge} ${msg.summary}${mentionText}\n\n${msg.full}\n\n🔗 ${msgUrl}`;
      const fullHtml = escHtml(msg.full).replace(/\n/g, '<br>');
      html = `${typeBadge} <b>${escHtml(msg.summary)}</b>${htmlMentions}<br><br>${fullHtml}<br><br><a href="${msgUrl}">🔗 View formatted</a>`;
    } else {
      plain = `${typeBadge} ${msg.summary}${mentionText}`;
      html = `${typeBadge} ${escHtml(msg.summary)}${htmlMentions}`;
    }

    if (msg.group) {
      // Group message
      const roomId = roomForGroup(msg.group);
      if (!roomId) {
        console.log(`No Matrix room for group "${msg.group}", skipping`);
        this.postWarning(`No Matrix room for group "${msg.group}" — message ${msg.id} from ${agentName} not bridged`);
        return;
      }
      await this.sendAsAgent(agentToken, roomId, plain, html, msg.id);
      console.log(`→ Matrix [${msg.group}] ${agentName}: ${msg.summary.slice(0, 60)}`);
    } else if (msg.to) {
      // DM - bridge to Matrix (both agent-to-agent and agent-to-human)
      const roomId = await this.ensureDmRoom(agentName, msg.to);
      if (roomId) {
        await this.sendAsAgent(agentToken, roomId, plain, html, msg.id);
        console.log(`→ Matrix DM ${agentName} → ${msg.to}: ${msg.summary.slice(0, 60)}`);
      }
    }
  }

  async ensureHumanDmRoom(agentName, humanName) {
    const roomId = await this.ensureDmRoom(agentName, humanName, { forceAgentName: agentName });
    if (!roomId) {
      return {
        ok: false,
        roomId: null,
        humanStatus: 'missing_room',
        invite: { ok: false, error: 'dm_room_unavailable' },
      };
    }
    const invite = await this._inviteHumanToDm(roomId, humanName, { agentName });
    if (invite.ok && invite.alreadyJoined) {
      return { ok: true, roomId, humanStatus: 'joined', invite };
    }
    if (invite.ok && invite.invited) {
      return { ok: true, roomId, humanStatus: 'invited', invite };
    }
    return { ok: false, roomId, humanStatus: 'invite_failed', invite };
  }

  async ensureDmRoom(fromName, toName, options = {}) {
    // Determine which is the agent (for human↔agent DMs, use agent-only key so
    // multiple humans share the same DM room with an agent)
    let fromIsAgent = this.isKnownAgentName(fromName);
    let toIsAgent = this.isKnownAgentName(toName);
    const forceAgentName = options.forceAgentName || null;
    if (forceAgentName && forceAgentName === fromName) {
      fromIsAgent = true;
      toIsAgent = false;
    } else if (forceAgentName && forceAgentName === toName) {
      fromIsAgent = false;
      toIsAgent = true;
    }

    let key;
    if (fromIsAgent && !toIsAgent) {
      key = `dm:${fromName}`; // human→agent: keyed by agent
    } else if (!fromIsAgent && toIsAgent) {
      key = `dm:${toName}`; // agent→human: keyed by agent
    } else {
      key = [fromName, toName].sort().join(':'); // agent↔agent: pair key
    }

    // Check in-memory cache
    if (this.dmRooms.has(key)) {
      const existingRoom = this.dmRooms.get(key);
      // If human↔agent, invite the human into existing room (idempotent)
      if (key.startsWith('dm:')) {
        const humanName = fromIsAgent ? toName : fromName;
        const agentName = key.slice(3);
        await this._inviteHumanToDm(existingRoom, humanName, { agentName });
      }
      return existingRoom;
    }

    // Load from persisted state (check multiple key formats for backwards compat)
    const legacyKey = [fromName, toName].sort().join(':');
    const altKey = `${fromName}:${toName}`;
    for (const k of [key, legacyKey, altKey]) {
      if (state.dmRooms?.[k]) {
        this.dmRooms.set(key, state.dmRooms[k]);
        // Normalize: save under new key format too
        if (k !== key) {
          if (!state.dmRooms) state.dmRooms = {};
          state.dmRooms[key] = state.dmRooms[k];
          saveState();
        }
        if (key.startsWith('dm:')) {
          const humanName = fromIsAgent ? toName : fromName;
          const agentName = key.slice(3);
          await this._inviteHumanToDm(state.dmRooms[k], humanName, { agentName });
        }
        return state.dmRooms[k];
      }
    }

    // Create DM room
    const agentName = fromIsAgent ? fromName : toName;
    const fromToken = state.agentTokens[agentName];
    if (!fromToken) return null;

    // Target user ID: agent gets ac_ prefix, human uses plain name
    const otherName = agentName === fromName ? toName : fromName;
    const otherIsAgent = agentName === fromName ? toIsAgent : fromIsAgent;
    const toUserId = otherIsAgent
      ? `@${AGENT_PREFIX}${otherName}:matrix.kusuri.ai`
      : `@${otherName}:matrix.kusuri.ai`;

    const invite = [toUserId, this.botUserId];
    try {
      const roomName = key.startsWith('dm:')
        ? `DM: ${agentName}`
        : `SPY: ${fromName} ↔ ${toName}`;
      const res = await fetch(`${HOMESERVER}/_matrix/client/v3/createRoom`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${fromToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          is_direct: true,
          invite,
          preset: 'trusted_private_chat',
          name: roomName,
        }),
      });
      const data = await res.json();
      if (data.room_id) {
        this.dmRooms.set(key, data.room_id);
        if (!state.dmRooms) state.dmRooms = {};
        state.dmRooms[key] = data.room_id;
        saveState();
        console.log(`Created DM room ${data.room_id} for ${key}`);

        // If target is agent, auto-join
        if (otherIsAgent && state.agentTokens[otherName]) {
          await fetch(`${HOMESERVER}/_matrix/client/v3/join/${encodeURIComponent(data.room_id)}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${state.agentTokens[otherName]}`, 'Content-Type': 'application/json' },
            body: '{}',
          });
        }

        return data.room_id;
      }
      console.error(`Failed to create DM room for ${key}:`, data);
    } catch (e) {
      console.error(`Error creating DM room for ${key}:`, e.message);
    }
    return null;
  }

  async _inviteHumanToDm(roomId, humanName, options = {}) {
    const humanUserId = `@${humanName}:matrix.kusuri.ai`;
    const parseJsonSafe = async (res) => {
      try {
        return await res.json();
      } catch {
        return {};
      }
    };
    try {
      // Check if already joined (avoid spam invite)
      const members = await this.botClient.getJoinedRoomMembers(roomId);
      if (members.includes(humanUserId)) {
        return { ok: true, alreadyJoined: true, invited: false, via: 'joined' };
      }
    } catch (e) {
      // Keep going: bot might not be joined, but agent inviter may still succeed.
      console.warn(`Unable to inspect joined members in ${roomId}: ${e.message}`);
    }

    const inviteAttempts = [];
    const botToken = this.getBotToken();
    if (botToken) inviteAttempts.push({ via: 'bot', token: botToken });
    const agentName = options.agentName;
    if (agentName && state.agentTokens[agentName]) {
      inviteAttempts.push({ via: `agent:${agentName}`, token: state.agentTokens[agentName] });
    }

    let lastErr = null;
    for (const attempt of inviteAttempts) {
      try {
        const res = await fetch(`${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${attempt.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: humanUserId }),
        });
        const data = await parseJsonSafe(res);
        if (res.ok) {
          console.log(`Invited ${humanName} to DM room ${roomId} via ${attempt.via}`);
          return { ok: true, alreadyJoined: false, invited: true, via: attempt.via };
        }
        // Matrix may reject duplicate invites/joined users with 4xx; treat as success-ish.
        if (data.errcode === 'M_USER_IN_ROOM' || data.errcode === 'M_ALREADY_JOINED') {
          return { ok: true, alreadyJoined: true, invited: false, via: attempt.via };
        }
        lastErr = `${data.errcode || res.status}: ${data.error || 'invite failed'}`;
      } catch (e) {
        lastErr = e.message;
      }
    }

    const err = lastErr || 'invite_failed';
    console.error(`Failed to invite ${humanName} to ${roomId}: ${err}`);
    return { ok: false, alreadyJoined: false, invited: false, error: err };
  }

  async sendAsAgent(token, roomId, text, html, sourceMsgId = null) {
    try {
      const txnId = `bridge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const content = { msgtype: 'm.text', body: text };
      if (html) {
        content.format = 'org.matrix.custom.html';
        content.formatted_body = html;
      }
      const res = await fetch(`${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(content),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      if (data?.event_id) {
        this.rememberMatrixEvent(data.event_id, sourceMsgId);
      }
      return data?.event_id || null;
    } catch (e) {
      console.error(`Failed to send as agent in ${roomId}:`, e.message);
      this.postWarning(`sendAsAgent failed in room ${roomId}: ${e.message}`);
      return null;
    }
  }

  // ── Create Matrix room for agent-chat group ───────────────────────
  async createRoomForGroup(groupName, members) {
    const invite = [];
    for (const m of members) {
      if (this.isKnownAgentName(m) && state.agentTokens[m]) {
        const userId = await getUserId(state.agentTokens[m]);
        invite.push(userId);
      } else {
        invite.push(`@${m}:matrix.kusuri.ai`);
      }
    }

    const res = await fetch(`${HOMESERVER}/_matrix/client/v3/createRoom`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: groupName,
        topic: `Agent Chat group: ${groupName}`,
        invite,
        preset: 'private_chat',
      }),
    });
    const data = await res.json();
    if (data.room_id) {
      mapRoom(data.room_id, groupName);
      this.recentlyCreatedRooms.add(data.room_id);
      setTimeout(() => this.recentlyCreatedRooms.delete(data.room_id), 30_000);
      console.log(`Created Matrix room ${data.room_id} for group "${groupName}"`);

      // Agent accounts need to join
      for (const m of members) {
        const agentToken = this.isKnownAgentName(m) ? state.agentTokens[m] : null;
        if (agentToken) {
          await fetch(`${HOMESERVER}/_matrix/client/v3/join/${encodeURIComponent(data.room_id)}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
            body: '{}',
          });
        }
      }
      return data.room_id;
    }
    console.error(`Failed to create room for ${groupName}:`, data);
    return null;
  }
}

// ── Minimal SSE client (no external dep) ─────────────────────────────
// We need to create this as a separate mini module

// ── Start ─────────────────────────────────────────────────────────────
const bridge = new MatrixBridge();
bridge.start().catch(e => {
  console.error('Bridge failed to start:', e);
  process.exit(1);
});
