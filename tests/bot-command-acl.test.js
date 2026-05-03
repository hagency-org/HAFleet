import { afterAll, describe, expect, test, vi } from 'vitest';
import { restoreEnv, snapshotEnv } from './helpers/env.js';

// Set ACL env vars before importing the module
const envSnapshot = snapshotEnv(['MATRIX_OPERATOR_MXIDS', 'MATRIX_ADMIN_MXIDS']);
process.env.MATRIX_OPERATOR_MXIDS = '@ops:matrix.test,@dev:matrix.test';
process.env.MATRIX_ADMIN_MXIDS = '@root:matrix.test';

const { default: BotCommands, classifyCommand, authorizeCommand, COMMAND_TIERS } = await import('../lib/bot-commands.js');

describe('command ACL (5.8.2)', () => {
  afterAll(() => {
    restoreEnv(envSnapshot);
  });

  describe('classifyCommand', () => {
    test('!help is tier 0 (public)', () => {
      expect(classifyCommand('!help')).toBe(0);
    });

    test('read-only commands are tier 1', () => {
      for (const cmd of ['!status', '!agents', '!groups', '!group', '!agent', '!sessions', '!mcp', '!bridge']) {
        expect(classifyCommand(cmd)).toBe(1);
      }
    });

    test('mutating commands are tier 2', () => {
      for (const cmd of ['!mkgroup', '!addmember', '!rmember', '!joingroup', '!dm', '!identity', '!rmgroup']) {
        expect(classifyCommand(cmd)).toBe(2);
      }
    });

    test('admin commands are tier 3', () => {
      for (const cmd of ['!spy', '!agentctl', '!ctl']) {
        expect(classifyCommand(cmd)).toBe(3);
      }
    });

    test('unknown command defaults to tier 1', () => {
      expect(classifyCommand('!unknown')).toBe(1);
    });
  });

  describe('authorizeCommand', () => {
    test('tier 0 (public) allows anyone', () => {
      expect(authorizeCommand('@random:evil.test', 0)).toEqual({ ok: true, reason: 'public' });
    });

    test('operator can access tier 1 and 2', () => {
      expect(authorizeCommand('@ops:matrix.test', 1)).toEqual({ ok: true, reason: 'operator' });
      expect(authorizeCommand('@ops:matrix.test', 2)).toEqual({ ok: true, reason: 'operator' });
    });

    test('operator cannot access tier 3', () => {
      expect(authorizeCommand('@ops:matrix.test', 3)).toEqual({ ok: false, reason: 'admin_required' });
    });

    test('admin can access all tiers', () => {
      expect(authorizeCommand('@root:matrix.test', 1)).toEqual({ ok: true, reason: 'admin' });
      expect(authorizeCommand('@root:matrix.test', 2)).toEqual({ ok: true, reason: 'admin' });
      expect(authorizeCommand('@root:matrix.test', 3)).toEqual({ ok: true, reason: 'admin' });
    });

    test('unknown user denied for tier 1+', () => {
      expect(authorizeCommand('@random:evil.test', 1)).toEqual({ ok: false, reason: 'operator_required' });
      expect(authorizeCommand('@random:evil.test', 2)).toEqual({ ok: false, reason: 'operator_required' });
      expect(authorizeCommand('@random:evil.test', 3)).toEqual({ ok: false, reason: 'admin_required' });
    });
  });

  describe('handle() ACL integration', () => {
    test('unauthorized user gets denial message for operator command', async () => {
      const replies = [];
      const bot = new BotCommands({
        botClient: { sendMessage: vi.fn(async (roomId, content) => replies.push(content)) },
        bridge: {},
        botUserId: '@bot:matrix.test',
      });
      await bot.handle('!room1:test', '@random:evil.test', '!agents', {});
      expect(replies).toHaveLength(1);
      expect(replies[0].body).toContain('Access denied');
      expect(replies[0].body).toContain('operator');
    });

    test('unauthorized user gets denial message for admin command', async () => {
      const replies = [];
      const bot = new BotCommands({
        botClient: { sendMessage: vi.fn(async (roomId, content) => replies.push(content)) },
        bridge: {},
        botUserId: '@bot:matrix.test',
      });
      await bot.handle('!room1:test', '@ops:matrix.test', '!spy someagent', {});
      expect(replies).toHaveLength(1);
      expect(replies[0].body).toContain('Access denied');
      expect(replies[0].body).toContain('admin');
    });

    test('!help is accessible to everyone', async () => {
      const replies = [];
      const bot = new BotCommands({
        botClient: { sendMessage: vi.fn(async (roomId, content) => replies.push(content)) },
        bridge: {},
        botUserId: '@bot:matrix.test',
      });
      await bot.handle('!room1:test', '@random:evil.test', '!help', {});
      expect(replies).toHaveLength(1);
      expect(replies[0].body).not.toContain('Access denied');
    });
  });
});
