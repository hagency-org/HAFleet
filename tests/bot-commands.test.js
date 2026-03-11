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
});
