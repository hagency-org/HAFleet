import { afterEach, describe, expect, test, vi } from 'vitest';
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
