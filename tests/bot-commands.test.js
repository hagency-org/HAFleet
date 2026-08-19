import { afterEach, describe, expect, test, vi } from 'vitest';

/*
 * Configure an operator BEFORE bot-commands.js is evaluated.
 *
 * The module reads MATRIX_OPERATOR_MXIDS at import time, and imports are hoisted, so
 * a plain assignment above the import would run too late — hence vi.hoisted.
 *
 * These tier-2 tests (`!mkgroup`, `!bindroom`) previously passed with NO acl
 * configured, because authorizeCommand fell open in that case and handed every
 * sender full authority. That fail-open is now a refusal, and the tests say what a
 * real deployment says: @alice is an operator. Left unconfigured they would only
 * have proved that an unconfigured deployment is wide open.
 */
vi.hoisted(() => {
  // Both domains: this file uses matrix.test in some cases and matrix.example.test
  // in others, and an ACL matches the full MXID.
  process.env.MATRIX_OPERATOR_MXIDS = '@alice:matrix.test,@alice:matrix.example.test';
});

import BotCommands, { resetBotCommandsTestHooks, setBotCommandsTestHooks } from '../lib/bot-commands.js';

function makeBot() {
  const sent = [];
  const bot = new BotCommands({
    botClient: {
      sendMessage: vi.fn(async (_roomId, content) => {
        sent.push(content.body);
      }),
    },
    bridge: {
      getBridgeState: () => ({}),
      isKnownAgentName: () => false,
    },
    botUserId: '@agent-bridge:matrix.example.test',
  });
  return { bot, sent };
}

describe('bot commands async tmux probes', () => {
  afterEach(() => {
    resetBotCommandsTestHooks();
    vi.unstubAllGlobals();
  });

  test('cmdSessions renders session processes from async tmux list-panes calls', async () => {
    const { bot, sent } = makeBot();
    setBotCommandsTestHooks({
      execFileAsync: vi.fn(async (file, args) => {
        if (file !== 'tmux') throw new Error(`unexpected file ${file}`);
        if (args[0] === '-V') return { stdout: 'tmux 3.4\n', stderr: '' };
        if (args[0] === 'list-sessions') return { stdout: 'alpha\nbeta\n', stderr: '' };
        if (args[0] === 'list-panes' && args[2] === 'alpha') return { stdout: 'claude\n', stderr: '' };
        if (args[0] === 'list-panes' && args[2] === 'beta') return { stdout: 'codex\n', stderr: '' };
        throw new Error(`unexpected tmux args ${args.join(' ')}`);
      }),
    });

    await bot.cmdSessions('!room:test');

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('alpha: claude');
    expect(sent[0]).toContain('beta: codex');
    expect(sent[0]).toContain('Total: 2');
  });

  test('cmdMcp maps async pgrep and ps output back to tmux sessions', async () => {
    const { bot, sent } = makeBot();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue([{ name: 'alpha' }, { name: 'beta' }]),
    }));
    setBotCommandsTestHooks({
      execFileAsync: vi.fn(async (file, args) => {
        if (file === 'tmux' && args[0] === '-V') return { stdout: 'tmux 3.4\n', stderr: '' };
        if (file === 'tmux' && args[0] === 'list-panes' && args[1] === '-a') {
          return { stdout: '/dev/pts/3 alpha\n/dev/pts/4 beta\n', stderr: '' };
        }
        if (file === 'tmux' && args[0] === 'list-sessions') return { stdout: 'alpha\nbeta\n', stderr: '' };
        if (file === 'pgrep') return { stdout: '111\n', stderr: '' };
        if (file === 'ps' && args[1] === 'pid=,tty=') return { stdout: '111 pts/3\n', stderr: '' };
        if (file === 'ps' && args[1] === 'pid=,ppid=') return { stdout: '111 222\n', stderr: '' };
        if (file === 'ps' && args[1] === 'pid=,comm=') return { stdout: '222 codex\n', stderr: '' };
        throw new Error(`unexpected command ${file} ${args.join(' ')}`);
      }),
    });

    await bot.cmdMcp('!room:test');

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('alpha');
    expect(sent[0]).toContain('codex');
    expect(sent[0]).toContain('YES');
  });

  test('!mkgroup includes the initiating Matrix user when not listed explicitly', async () => {
    const { bot, sent } = makeBot();
    const fetchMock = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({ name: 'demo' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await bot.handle(
      '!room:test',
      '@alice:matrix.example.test',
      '!mkgroup demo alpha',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({
      name: 'demo',
      members: ['alpha', 'alice'],
    });
    expect(sent[0]).toContain('alpha, alice');
  });

  test('!mkgroup does not duplicate an explicitly listed initiating user', async () => {
    const { bot } = makeBot();
    const fetchMock = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({ name: 'demo' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await bot.handle(
      '!room:test',
      '@alice:matrix.example.test',
      '!mkgroup demo alpha ALICE alice',
    );

    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({
      name: 'demo',
      members: ['alpha', 'alice'],
    });
  });
});

describe('!bindroom', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetBotCommandsTestHooks();
  });

  function makeBindBot({ groupExists = true, prevGroup = null } = {}) {
    const sent = [];
    const bindRoom = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (url) => ({
      ok: groupExists,
      json: async () => (groupExists ? { name: 'factory' } : { error: 'not found' }),
    })));
    const bot = new BotCommands({
      botClient: { sendMessage: vi.fn(async (_roomId, content) => { sent.push(content.body); }) },
      bridge: {
        getBridgeState: () => ({}),
        isKnownAgentName: () => false,
        bindRoom,
        groupForRoom: () => prevGroup,
      },
    });
    return { bot, sent, bindRoom };
  }

  test('binds the current room to an existing group', async () => {
    const { bot, sent, bindRoom } = makeBindBot();
    await bot.handle('!room-a:matrix.test', '@alice:matrix.test', '!bindroom factory');
    expect(bindRoom).toHaveBeenCalledWith('!room-a:matrix.test', 'factory');
    expect(sent.join('\n')).toMatch(/bound to group "factory"/);
  });

  test('reports rebind when the room was bound to another group', async () => {
    const { bot, sent, bindRoom } = makeBindBot({ prevGroup: 'oldteam' });
    await bot.handle('!room-a:matrix.test', '@alice:matrix.test', '!bindroom factory');
    expect(bindRoom).toHaveBeenCalledWith('!room-a:matrix.test', 'factory');
    expect(sent.join('\n')).toMatch(/rebound: oldteam → factory/);
  });

  test('unknown group is rejected and nothing is bound', async () => {
    const { bot, sent, bindRoom } = makeBindBot({ groupExists: false });
    await bot.handle('!room-a:matrix.test', '@alice:matrix.test', '!bindroom ghost');
    expect(bindRoom).not.toHaveBeenCalled();
    expect(sent.join('\n')).toMatch(/Group not found: ghost/);
  });

  test('missing argument prints usage', async () => {
    const { bot, sent, bindRoom } = makeBindBot();
    await bot.handle('!room-a:matrix.test', '@alice:matrix.test', '!bindroom');
    expect(bindRoom).not.toHaveBeenCalled();
    expect(sent.join('\n')).toMatch(/Usage: !bindroom <group>/);
  });
});

describe('who speaks when a command comes from a project side room', () => {
  /*
   * FOUND BY TYPING `!offer` AS A CUSTOMER on a clean pair of machines: a fresh HAFleet on one, a fresh
   * homeserver on another, connected by a co-located appservice edge. The command arrived, was dispatched
   * and handled — and its answer died with `M_FORBIDDEN: sender's membership is not 'join'`, because every
   * reply went out as HAFleet's own bot and the bot is not in the customer's room. The REPRESENTATIVE is.
   *
   * So the whole ordering conversation — `!offer`, `!request`, the reply that says who was assigned — was
   * silent on the customer's side. It cannot happen on a single-homeserver deployment, where the bot is in
   * every room, and that is every deployment this had ever run on.
   */
  test('the reply goes through the bridge, which picks the identity in that room', async () => {
    const said = [];
    const bot = new BotCommands({
      botClient: { sendMessage: vi.fn(async () => { throw new Error('the bot must not be used here'); }) },
      bridge: {
        getBridgeState: () => ({}),
        isKnownAgentName: () => false,
        sayInRoom: vi.fn(async (roomId, content) => { said.push({ roomId, body: content.body }); }),
      },
      botUserId: '@agent-bridge:matrix.example.test',
    });

    await bot.reply('!proj:customer.test', 'hello');
    expect(said).toEqual([{ roomId: '!proj:customer.test', body: 'hello' }]);
  });

  test('a bridge without that method still replies, so nothing regresses', async () => {
    // The bot remains correct for every deployment where HAFleet and the room share one homeserver.
    const { bot, sent } = makeBot();
    await bot.reply('!ours:matrix.example.test', 'hello');
    expect(sent).toEqual(['hello']);
  });

  test('formatted replies keep their HTML when routed through the bridge', async () => {
    // The bridge path must carry the whole content, not just the plain body — half the answers are HTML.
    const said = [];
    const bot = new BotCommands({
      botClient: { sendMessage: vi.fn(async () => {}) },
      bridge: {
        getBridgeState: () => ({}),
        isKnownAgentName: () => false,
        sayInRoom: vi.fn(async (_r, content) => { said.push(content); }),
      },
      botUserId: '@agent-bridge:matrix.example.test',
    });
    await bot.reply('!proj:customer.test', 'plain', '<b>rich</b>');
    expect(said[0]).toMatchObject({
      body: 'plain', format: 'org.matrix.custom.html', formatted_body: '<b>rich</b>',
    });
  });
});
