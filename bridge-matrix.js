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
function parseMentions(content) {
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
  if (!mentions.length && content.body) {
    const atRegex = /@(ac_)?([a-z0-9_-]+)/gi;
    let match;
    while ((match = atRegex.exec(content.body)) !== null) {
      if (match[1]) mentions.push(match[2]); // @ac_agentname
      else mentions.push(match[0].slice(1)); // @agentname
    }
  }

  return [...new Set(mentions)];
}

// ── Main bridge class ─────────────────────────────────────────────────
class MatrixBridge {
  constructor() {
    this.botClient = null;
    this.botUserId = null;
    this.knownAgents = new Set(); // names of registered agents
    this.dmRooms = new Map(); // "agent:human" → roomId
    this.recentBridgedIds = new Set(); // prevent echo loops
    this.recentlyCreatedRooms = new Set(); // rooms we just created (suppress echo)
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

    // 2. Ensure agent accounts for all registered agents
    const agents = await backendApi('GET', '/api/agents');
    for (const agent of agents) {
      await ensureAgentAccount(agent.name);
      this.knownAgents.add(agent.name);
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
      for (const agent of agents) {
        if (!this.knownAgents.has(agent.name)) {
          await ensureAgentAccount(agent.name);
          this.knownAgents.add(agent.name);
          console.log(`Discovered new agent: ${agent.name}`);
        }
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

  // ── Matrix → Agent-chat ───────────────────────────────────────────
  async onRoomMessage(roomId, event) {
    if (!event.content?.body) return;
    const senderId = event.sender;

    // Ignore messages from our agent accounts (prevent loops)
    if (isAgentUser(senderId)) return;
    if (senderId === this.botUserId) return;

    const groupName = groupForRoom(roomId);
    const humanName = humanNameFromUserId(senderId);
    const body = event.content.body;
    const mentions = parseMentions(event.content);

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
      await backendApi('POST', '/api/messages', {
        from: humanName,
        to: targetAgent,
        type: 'human',
        summary: body,
        full: '',
        mentions: [],
        source: 'matrix',
      });
    } else if (groupName) {
      // Group message from human
      console.log(`Matrix group: ${humanName} → ${groupName}: ${body.slice(0, 80)}`);
      await backendApi('POST', '/api/messages', {
        from: humanName,
        group: groupName,
        type: 'human',
        summary: body,
        full: '',
        mentions,
        source: 'matrix',
      });
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

      // Skip DM rooms (name format: "DM: X ↔ Y")
      if (name.startsWith('DM: ') && name.includes('↔')) return;

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
      if (this.knownAgents.has(m) && !state.agentTokens[m]) {
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
      let userId;
      if (state.agentTokens[m]) {
        userId = await getUserId(state.agentTokens[m]);
        if (currentMembers.has(userId)) continue; // already in room
        // Also auto-join with agent token
        await fetch(`${HOMESERVER}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${state.agentTokens[m]}`, 'Content-Type': 'application/json' },
          body: '{}',
        });
      } else {
        userId = `@${m}:matrix.kusuri.ai`;
        if (currentMembers.has(userId)) continue; // already in room
      }
      try {
        await fetch(`${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${state.botToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: userId }),
        });
        console.log(`Invited ${m} (${userId}) to Matrix room for ${update.name}`);
      } catch (e) {
        console.error(`Failed to invite ${m}:`, e.message);
      }
    }

    // Kick removed members
    for (const m of (update.removed || [])) {
      let userId;
      if (state.agentTokens[m]) {
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
      if (!this.knownAgents.has(agentName)) {
        await ensureAgentAccount(agentName);
        this.knownAgents.add(agentName);
      }
    }

    const agentToken = state.agentTokens[agentName];
    if (!agentToken) return;

    // Check if any human is involved (DM to human, or group message mentioning a human)
    const mentionsHuman = msg.mentions?.some(m => this.isHuman(m));
    const dmToHuman = msg.to && this.isHuman(msg.to);
    const showFull = (dmToHuman || mentionsHuman) && msg.full && msg.full.length > 0;

    // Build Matrix message (plain text fallback + HTML formatted)
    const hasLink = msg.full && msg.full.length > 0;
    const typeBadge = msg.type === 'request' ? '📋' : msg.type === 'reply' ? '↩️' : 'ℹ️';
    const mentionText = msg.mentions?.length ? ` · ${msg.mentions.map(m => '@' + m).join(' ')}` : '';
    const escHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    let plain, html;
    if (showFull) {
      // Human-facing: show full content directly
      plain = `${typeBadge} ${msg.summary}${mentionText}\n\n${msg.full}`;
      const htmlMentions = msg.mentions?.length ? ` · ${msg.mentions.map(m => '<b>@' + escHtml(m) + '</b>').join(' ')}` : '';
      const fullHtml = escHtml(msg.full).replace(/\n/g, '<br>');
      html = `${typeBadge} <b>${escHtml(msg.summary)}</b>${htmlMentions}<br><br>${fullHtml}`;
    } else {
      // Agent-facing: summary + compact link
      const plainLink = hasLink ? ` [full](${MSG_BASE_URL}/${msg.id})` : '';
      plain = `${typeBadge} ${msg.summary}${mentionText}${plainLink}`;
      const htmlLink = hasLink ? ` · <a href="${MSG_BASE_URL}/${msg.id}">full</a>` : '';
      const htmlMentions = msg.mentions?.length ? ` · ${msg.mentions.map(m => '<b>@' + escHtml(m) + '</b>').join(' ')}` : '';
      html = `${typeBadge} ${escHtml(msg.summary)}${htmlMentions}${htmlLink}`;
    }

    if (msg.group) {
      // Group message
      const roomId = roomForGroup(msg.group);
      if (!roomId) {
        console.log(`No Matrix room for group "${msg.group}", skipping`);
        return;
      }
      await this.sendAsAgent(agentToken, roomId, plain, html);
      console.log(`→ Matrix [${msg.group}] ${agentName}: ${msg.summary.slice(0, 60)}`);
    } else if (msg.to) {
      // DM - bridge to Matrix (both agent-to-agent and agent-to-human)
      const roomId = await this.ensureDmRoom(agentName, msg.to);
      if (roomId) {
        await this.sendAsAgent(agentToken, roomId, plain, html);
        console.log(`→ Matrix DM ${agentName} → ${msg.to}: ${msg.summary.slice(0, 60)}`);
      }
    }
  }

  async ensureDmRoom(fromName, toName) {
    // Normalize key: sorted so A:B and B:A use the same room
    const key = [fromName, toName].sort().join(':');
    if (this.dmRooms.has(key)) return this.dmRooms.get(key);

    // Load from persisted state (check both key orders for backwards compat)
    const altKey = `${fromName}:${toName}`;
    for (const k of [key, altKey]) {
      if (state.dmRooms?.[k]) {
        this.dmRooms.set(key, state.dmRooms[k]);
        return state.dmRooms[k];
      }
    }

    // Create DM room
    const fromToken = state.agentTokens[fromName];
    if (!fromToken) return null;

    // Target user ID: agent gets ac_ prefix, human uses plain name
    const toUserId = this.knownAgents.has(toName)
      ? `@${AGENT_PREFIX}${toName}:matrix.kusuri.ai`
      : `@${toName}:matrix.kusuri.ai`;

    const invite = [toUserId, this.botUserId];
    // If target is an agent, also auto-join with their token later
    try {
      const res = await fetch(`${HOMESERVER}/_matrix/client/v3/createRoom`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${fromToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          is_direct: true,
          invite,
          preset: 'trusted_private_chat',
          name: `DM: ${fromName} ↔ ${toName}`,
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
        if (state.agentTokens[toName]) {
          await fetch(`${HOMESERVER}/_matrix/client/v3/join/${encodeURIComponent(data.room_id)}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${state.agentTokens[toName]}`, 'Content-Type': 'application/json' },
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

  async sendAsAgent(token, roomId, text, html) {
    try {
      const txnId = `bridge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const content = { msgtype: 'm.text', body: text };
      if (html) {
        content.format = 'org.matrix.custom.html';
        content.formatted_body = html;
      }
      await fetch(`${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(content),
      });
    } catch (e) {
      console.error(`Failed to send as agent:`, e.message);
    }
  }

  // ── Create Matrix room for agent-chat group ───────────────────────
  async createRoomForGroup(groupName, members) {
    const invite = [];
    for (const m of members) {
      if (state.agentTokens[m]) {
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
        const agentToken = state.agentTokens[m];
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
