/*
 * public_room_ctl_cannot_bypass_approval — the room-context guard on `!ctl` / `!agentctl`.
 *
 * REQ-OWNER-UI-APPROVAL-CONTROL: "Public-room `!ctl key`, `!ctl send`, and equivalent generic
 * controls MUST NOT bypass the approval state machine." The guard exists
 * (`isAgentControlBlockedContext` in lib/bot-commands.js) and the bridge supplies the context —
 * yet TWO audit rounds found its true branch executed by no test: every `handle()` call in the
 * suite passed `{}` , so `groupName`/`approvalRoom` were never set and the guard never fired.
 *
 * Worse, the existing refusal assertions could not have caught its removal even if it had fired:
 * they matched `/Access denied/`, which the tier ACL's message ALSO matches — so a mutant that
 * deleted the guard entirely and fell through to the ACL read as covered. These tests assert the
 * guard's OWN wording, and — because the requirement is about the approval state machine, not
 * about message text — that no keystroke reaches tmux.
 *
 * Why the stakes are real: `!ctl send` types into the agent's pane
 * (`runProcess('tmux', ['send-keys', ...])`). A keystroke typed into a pane can answer a
 * runtime's native prompt, which is exactly "impersonating a runtime permission verdict"
 * (specs/task-owner-ui-approval.spec.md forbids it in those words). The guard is what keeps a
 * global admin's project-room message from being that keystroke.
 *
 * SCOPE, stated because the audit flagged it: the guard covers group rooms and approval rooms —
 * the requirement's own "public-room" scope. In a bot-DM an admin may still run `!ctl`; that is
 * the admin's own control surface for their own agents, gated by tier-3 ACL, and narrowing it
 * further would be a behaviour change this test file deliberately does not smuggle in. The
 * bot-DM case is pinned below as ALLOWED so that if someone later decides to narrow it, that
 * shows up as a decision rather than a drive-by.
 */

import { afterEach, describe, expect, test } from 'vitest';
import path from 'path';
import { pathToFileURL } from 'url';
import { restoreEnv, snapshotEnv } from './helpers/env.js';

const ACL_VARS = ['MATRIX_OPERATOR_MXIDS', 'MATRIX_ADMIN_MXIDS', 'MATRIX_ALLOW_UNCONFIGURED_ACL'];
const ADMIN = '@admin:hq.example';
const GUARD_MESSAGE = /terminal control is unavailable in project and approval rooms/;

/** A fresh module with ADMIN as a configured administrator, same idiom as bot-command-acl. */
async function loadAsAdmin() {
  const snapshot = snapshotEnv(ACL_VARS);
  for (const key of ACL_VARS) delete process.env[key];
  process.env.MATRIX_ADMIN_MXIDS = ADMIN;
  const url = pathToFileURL(path.resolve('lib/bot-commands.js')).href;
  const mod = await import(`${url}?ctl-guard=${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return { mod, snapshot };
}

/**
 * A bot whose replies are recorded and whose process runner records rather than runs.
 *
 * `runProcess` is module-private, but every tmux touch goes through the injectable test hooks
 * the module already exports for exactly this purpose. If no hook seam existed, asserting "no
 * keystroke reached tmux" would require trusting the reply text — the thing this file exists to
 * stop doing.
 */
function harness(mod) {
  const replies = [];
  const processCalls = [];
  const bot = new mod.default({ sendMessage: async () => {} });
  bot.reply = async (_room, plain) => { replies.push(plain); };
  /*
   * The hook's real parameter is `execFileAsync` — the promisified execFile every tmux touch
   * goes through. The first draft passed `runProcess`, which the hook silently ignores, so the
   * recorder never installed and `processCalls === []` held for the wrong reason (and a
   * guard-removed mutant would have run REAL tmux against this machine). Asserted below that
   * the hook actually took: a harness that can silently not install is the vacuity this file
   * exists to end.
   */
  mod.setBotCommandsTestHooks({
    execFileAsync: async (file, args) => {
      processCalls.push({ file, args });
      return { stdout: '', stderr: '' };
    },
  });
  return { bot, replies, processCalls, reset: () => mod.resetBotCommandsTestHooks?.() };
}

describe('public_room_ctl_cannot_bypass_approval', () => {
  let snapshot = null;
  let reset = null;
  afterEach(() => {
    if (reset) { reset(); reset = null; }
    if (snapshot) { restoreEnv(snapshot); snapshot = null; }
  });

  test('an ADMIN in a project room is refused !ctl send, by the guard and not the ACL', async () => {
    /*
     * The case the requirement is about. The sender passes the tier-3 ACL — they are a
     * configured administrator — so if this refusal came from the ACL the test setup would be
     * wrong. The guard's own wording is asserted so the two refusals cannot stand in for each
     * other, which is precisely how the previous assertions failed to cover this.
     */
    let mod;
    ({ mod, snapshot } = await loadAsAdmin());
    const { bot, replies, processCalls, reset: r } = harness(mod);
    reset = r;

    await bot.handle('!project:hq.example', ADMIN, '!ctl alpha send approve', { groupName: 'demo' });

    expect(replies.at(-1)).toMatch(GUARD_MESSAGE);
    // The requirement is about the state machine, not the message: nothing reached tmux.
    expect(processCalls).toEqual([]);
  });

  test('an ADMIN in an approval room is refused the same way', async () => {
    /*
     * The approval room is the second half of the guard, and the sharper one: it is the room
     * where the owner DECIDES, so a keystroke command accepted there would sit beside the very
     * UI it was bypassing.
     */
    let mod;
    ({ mod, snapshot } = await loadAsAdmin());
    const { bot, replies, processCalls, reset: r } = harness(mod);
    reset = r;

    await bot.handle('!approval:hq.example', ADMIN, '!ctl alpha key Enter', { approvalRoom: true });

    expect(replies.at(-1)).toMatch(GUARD_MESSAGE);
    expect(processCalls).toEqual([]);
  });

  test('!agentctl is guarded identically, not only the short form', async () => {
    // Two spellings of one command must not have two policies.
    let mod;
    ({ mod, snapshot } = await loadAsAdmin());
    const { bot, replies, processCalls, reset: r } = harness(mod);
    reset = r;

    await bot.handle('!project:hq.example', ADMIN, '!agentctl alpha send y', { groupName: 'demo' });

    expect(replies.at(-1)).toMatch(GUARD_MESSAGE);
    expect(processCalls).toEqual([]);
  });

  test('the guard outranks the ACL: a NON-admin in a project room gets the guard message', async () => {
    /*
     * Ordering, pinned. If the ACL ran first, a stranger's `!ctl` in a project room would leak
     * "requires admin privileges" — an invitation to go acquire them — where the truthful answer
     * is that NO privilege makes terminal control available in this room.
     */
    let mod;
    ({ mod, snapshot } = await loadAsAdmin());
    const { bot, replies, reset: r } = harness(mod);
    reset = r;

    await bot.handle('!project:hq.example', '@stranger:evil.example', '!ctl alpha send x', { groupName: 'demo' });

    expect(replies.at(-1)).toMatch(GUARD_MESSAGE);
    expect(replies.at(-1)).not.toMatch(/requires (admin|operator)/);
  });

  test('a bot-DM still allows an admin to run !ctl — the guard is a room rule, not a ban', async () => {
    /*
     * The false branch, pinned deliberately. In the admin's own bot-DM, `!ctl` is their control
     * surface for their own agents, behind the tier-3 ACL. This test is what turns a future
     * narrowing into a visible decision instead of a silent drive-by — and it is also what keeps
     * THIS file honest: a guard test that never shows the guard opening could pass with
     * `isAgentControlBlockedContext = () => true`.
     *
     * "Allowed" is observed structurally: the command proceeds past both the guard and the ACL
     * into cmdAgentctl, whose first act for a real agent lookup is an API call that our stubbed
     * fetch fails — so the reply is a lookup error, not either refusal. What matters is which
     * side of the gates it died on.
     */
    let mod;
    ({ mod, snapshot } = await loadAsAdmin());
    const { bot, replies, reset: r } = harness(mod);
    reset = r;
    const realFetch = global.fetch;
    global.fetch = async () => ({ json: async () => ({ error: 'backend not running in this test' }) });
    try {
      await bot.handle('!botdm:hq.example', ADMIN, '!ctl alpha status', {});
    } finally {
      global.fetch = realFetch;
    }

    expect(replies.at(-1)).not.toMatch(GUARD_MESSAGE);
    expect(replies.at(-1)).not.toMatch(/requires (admin|operator)/);
  });

  test('the guard is context-driven: the same command text passes or fails on context alone', async () => {
    /*
     * REQ-OWNER-UI-APPROVAL-CONTROL's mechanism in one case: nothing about the message decides;
     * the bridge-supplied room classification does. A guard keyed on anything a sender controls
     * (the text, the room id string) would be spoofable; `groupName`/`approvalRoom` come from
     * bridge state the sender cannot write.
     */
    let mod;
    ({ mod, snapshot } = await loadAsAdmin());
    const { bot, replies, reset: r } = harness(mod);
    reset = r;
    const realFetch = global.fetch;
    global.fetch = async () => ({ json: async () => ({ error: 'backend not running in this test' }) });
    try {
      await bot.handle('!same:hq.example', ADMIN, '!ctl alpha status', { groupName: 'demo' });
      const inGroup = replies.at(-1);
      await bot.handle('!same:hq.example', ADMIN, '!ctl alpha status', {});
      const inDm = replies.at(-1);
      expect(inGroup).toMatch(GUARD_MESSAGE);
      expect(inDm).not.toMatch(GUARD_MESSAGE);
    } finally {
      global.fetch = realFetch;
    }
  });
});
