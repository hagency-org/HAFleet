/*
 * An unconfigured ACL must fail CLOSED.
 *
 * `authorizeCommand` used to end with "if no ACL configured at all, allow everything
 * (backward compat)", and both `MATRIX_OPERATOR_MXIDS` and `MATRIX_ADMIN_MXIDS`
 * default to empty. So a stock deployment granted EVERY sender whose message the
 * bridge processed full tier-3 authority — `!agentctl`, `!spy`, `!ctl` — meaning any
 * Matrix user who got into a room with the bot could drive the agents.
 *
 * The permissive branch only fired when nothing was configured, which is precisely
 * the configuration nobody runs tests against. Found by an adversarial review of the
 * contribution-console branch; the defect itself predates it.
 */

import { afterEach, describe, expect, test } from 'vitest';
import path from 'path';
import { pathToFileURL } from 'url';
import { restoreEnv, snapshotEnv } from './helpers/env.js';

const ACL_VARS = [
  'MATRIX_OPERATOR_MXIDS',
  'MATRIX_ADMIN_MXIDS',
  'MATRIX_ALLOW_UNCONFIGURED_ACL',
];

/**
 * Load bot-commands.js with a given ACL environment.
 *
 * The module reads these at import time, so each case needs its own module
 * instance — hence the cache-busting query, the same idiom room-trust.test.js uses.
 */
async function loadWith(env) {
  const snapshot = snapshotEnv(ACL_VARS);
  for (const key of ACL_VARS) delete process.env[key];
  Object.assign(process.env, env);
  const url = pathToFileURL(path.resolve('lib/bot-commands.js')).href;
  const mod = await import(`${url}?acl-test=${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return { mod, snapshot };
}

describe('bot command ACL', () => {
  let snapshot = null;
  afterEach(() => { if (snapshot) restoreEnv(snapshot); snapshot = null; });

  const STRANGER = '@stranger:evil.example';

  test('an unconfigured ACL refuses privileged commands instead of granting them', async () => {
    ({ snapshot } = await loadWith({}));
    const { default: BotCommands } = await import(
      `${pathToFileURL(path.resolve('lib/bot-commands.js')).href}?acl-test=${Date.now()}`
    );
    const replies = [];
    const bot = new BotCommands({ sendMessage: async () => {} });
    bot.reply = async (_r, plain) => { replies.push(plain); };

    // Tier 3 — the worst case. This used to be granted to anyone.
    await bot.handle('!room:test', STRANGER, '!agentctl agent send hi', {});
    expect(replies.at(-1)).toMatch(/Access denied/);
    // And the refusal is actionable: "requires operator privileges" is useless advice
    // when the operator list is empty and nobody can ever satisfy it.
    expect(replies.at(-1)).toMatch(/MATRIX_OPERATOR_MXIDS/);
  });

  test('tier 0 still works unconfigured, because the asker is never an operator here', async () => {
    ({ snapshot } = await loadWith({}));
    const { default: BotCommands } = await import(
      `${pathToFileURL(path.resolve('lib/bot-commands.js')).href}?acl-test=${Date.now()}-b`
    );
    const replies = [];
    const bot = new BotCommands({ sendMessage: async () => {} });
    bot.reply = async (_r, plain) => { replies.push(plain); };

    /*
     * `!request` is the whole point of the console's inbound path: a project asking a
     * contributor for capacity. Locking it behind an operator ACL would mean only the
     * contributor could ask themselves. Failing closed must not take this with it.
     */
    await bot.handle('!room:test', STRANGER, '!help', {});
    expect(replies.at(-1) ?? '').not.toMatch(/Access denied/);
  });

  test('an explicit opt-in restores the old permissive behaviour', async () => {
    // Kept so a deployment that genuinely relied on it has a way back — but it has to
    // be asked for. "I never set the variable" must not be how a deployment opens up.
    ({ snapshot } = await loadWith({ MATRIX_ALLOW_UNCONFIGURED_ACL: 'true' }));
    const { default: BotCommands } = await import(
      `${pathToFileURL(path.resolve('lib/bot-commands.js')).href}?acl-test=${Date.now()}-c`
    );
    const replies = [];
    const bot = new BotCommands({ sendMessage: async () => {} });
    bot.reply = async (_r, plain) => { replies.push(plain); };

    await bot.handle('!room:test', STRANGER, '!agents', {});
    expect(replies.at(-1) ?? '').not.toMatch(/Access denied/);
  });

  test('a configured ACL still admits the operator and refuses everyone else', async () => {
    ({ snapshot } = await loadWith({ MATRIX_OPERATOR_MXIDS: '@op:hq.example' }));
    const { default: BotCommands } = await import(
      `${pathToFileURL(path.resolve('lib/bot-commands.js')).href}?acl-test=${Date.now()}-d`
    );
    const replies = [];
    const bot = new BotCommands({ sendMessage: async () => {} });
    bot.reply = async (_r, plain) => { replies.push(plain); };

    await bot.handle('!room:test', STRANGER, '!agents', {});
    expect(replies.at(-1)).toMatch(/Access denied/);
    // An operator is admitted, so this bounds the change rather than only refusing more.
    replies.length = 0;
    await bot.handle('!room:test', '@op:hq.example', '!agents', {});
    expect(replies.at(-1) ?? '').not.toMatch(/Access denied/);
    // ...but tier 3 is still above an operator.
    replies.length = 0;
    await bot.handle('!room:test', '@op:hq.example', '!agentctl agent send hi', {});
    expect(replies.at(-1)).toMatch(/Access denied/);
  });
});
