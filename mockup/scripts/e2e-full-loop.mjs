/*
 * The whole loop, live, across every real component:
 *
 *   a Matrix account posts in a room on the deployed homeserver
 *     -> the RUNNING bridge receives it through its own sync loop
 *       -> hafleet routes it into an engagement
 *         -> a browser presses Approve in the console
 *           -> an agent is BOUND to the project room
 *             -> the bot's reply lands back in the room
 *               -> the real GUI client observes both
 *
 * WHAT MAKES THIS DIFFERENT FROM e2e-matrix.mjs. That suite calls the command
 * handler in-process and approves over HTTP. This one uses only the paths a human
 * would: a real message delivered by the real bridge, and a real click in a real
 * browser. Nothing in the chain is stubbed.
 *
 * ON THE GUI CLIENT. Robrix is a Makepad app with no automation surface, so it is
 * NOT driven here — it is OBSERVED, through its own sqlite state store.
 *
 * The first version of this check read Robrix's LOG and asserted the room id
 * appeared in it. That was unsound: the client was making 23 sync requests a minute
 * while its log sat frozen at 39,872 bytes, because steady-state sync is silent at
 * the default level. Absent log lines are not absent sync, and a check that cannot
 * tell those apart reports whatever the log level happens to be.
 *
 * FOUR SIGNALS WERE TRIED AND ALL FOUR ARE UNSOUND:
 *
 *   its log            — silent in steady state; 23 sync requests a minute while the
 *                        log sat frozen at 39,872 bytes
 *   room_info count    — the store retains LEFT rooms (7 rows against 4 joined) and
 *                        this suite forgets its room each run, so +1 new and −1
 *                        pruned nets to zero
 *   room_info.room_id  — a 32-byte hashed BLOB; a specific room cannot be looked up
 *   store mtime        — only advances when there is state to persist, so an idle
 *                        client that is syncing perfectly looks stalled
 *
 * So the claim is REMOVED rather than attempted a fifth time. Only the process being
 * alive is asserted, which is sound and cheap. Whether this room and this message
 * RENDERED is skipped with its reason: it is the one part of the loop a machine
 * cannot see from out here, and confirming it is exactly what the human in
 * human-in-the-loop is for. The screen is never captured — a full-screen grab
 * exposes whatever else the operator has open, which is not this suite's business.
 *
 * PRECONDITIONS — all of them real processes, none faked:
 *   - a homeserver reachable at MATRIX_HS (mini1, via ssh tunnel)
 *   - bridge-matrix.js running and joined to the room
 *   - the hafleet backend, and the console dev server
 *   - optionally Robrix; only its liveness is checked, and it no longer shares an
 *     account with this suite — see scripts/lib/matrix-account.mjs
 *
 * Not in `npm test` — specs/project.spec.md:26 forbids tests contacting live Palpo.
 */

import { chromium } from 'playwright-core';
import { MatrixClient, SimpleFsStorageProvider } from 'matrix-bot-sdk';
import { withRateLimitRetry } from './lib/matrix-rate-limit.mjs';
import { registerThrowaway } from './lib/matrix-account.mjs';
import { purgeRoom, botCredentials, roomsTouchedBy } from './lib/matrix-teardown.mjs';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HS = process.env.MATRIX_HS ?? 'http://127.0.0.1:8008';
const BACKEND = process.env.BACKEND ?? 'http://127.0.0.1:8090';
const CONSOLE = process.env.BASE ?? 'http://127.0.0.1:3100';
const TOKEN = process.env.API_TOKEN ?? 'devtoken';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
/*
 * Registration token for this run's throwaway account. No default: it gates
 * registration on a homeserver reachable from the internet, so a literal here would
 * be a credential published with this file.
 */
const REG_TOKEN = process.env.MATRIX_TOKEN ?? '';
const BOT_MXID = process.env.BOT_MXID ?? '@hafleet-bot:palpo.test';
/*
 * The bot's own credentials, used only to remove it from the room this run created.
 * Optional: without them the suite still passes its assertions and reports that the
 * bot was left behind, rather than quietly leaking a room per run.
 */
const BOT_USER = process.env.MATRIX_BOT_USERNAME ?? '';
const BOT_PASSWORD = process.env.MATRIX_BOT_PASSWORD ?? '';
// The running bridge's state file, which already holds a valid bot token. Preferred
// over /login, which Palpo throttles hard enough to fail teardown outright.
const BRIDGE_STATE = process.env.BRIDGE_STATE
  ?? (process.env.HAFLEET_RUNTIME_DIR ? join(process.env.HAFLEET_RUNTIME_DIR, 'data', 'matrix', 'bridge-state.json') : '');
/*
 * The client's state store. Defaults to the newest db_* directory macOS Robrix
 * creates, so the caller usually needs to set nothing.
 */
const ROBRIX_DB = process.env.ROBRIX_DB ?? (() => {
  const base = join(process.env.HOME ?? '', 'Library', 'Application Support', 'rs.robius.robrix');
  if (!existsSync(base)) return '';
  const dirs = readdirSync(base).filter((d) => d.startsWith('db_')).sort();
  return dirs.length ? join(base, dirs[dirs.length - 1], 'matrix-sdk-state.sqlite3') : '';
})();

let failed = 0; let ran = 0; let skipped = 0;
const check = (name, ok, detail = '') => {
  ran += 1; if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const skip = (name, why) => { skipped += 1; console.log(`  SKIP  ${name}  — ${why}`); };

async function api(path, opts = {}) {
  const res = await fetch(`${BACKEND}/api/${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/*
 * How long to wait on the bridge before calling it broken.
 *
 * Derived, not guessed. src/matrix-rate-limit-gate.mjs caps its shared cooldown at
 * 120s, and the bridge DEFERS a join while that cooldown is active ("Bot invite:
 * cooling down … deferring join"), retrying on its next invite poll. A 40s wait
 * therefore reported "the bridge never joined" for a bridge that was behaving
 * correctly and waiting out a 429 — which is a suite defect, not a product one: three
 * of these suites back to back is enough to trip Palpo's limiter.
 */
const BRIDGE_PATIENCE_MS = 150_000;

/** Poll until a condition holds, so a slow bridge is waited for rather than raced. */
async function until(fn, { tries = 20, gapMs = 1000 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => { setTimeout(r, gapMs); });
  }
  return null;
}

/** Is the GUI client running at all? The one thing here that is soundly checkable. */
function clientAlive() {
  try {
    execFileSync('pgrep', ['-f', 'target/release/robrix'], { stdio: 'ignore', timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

(async () => {
  console.log(`\nFull loop — Matrix ${HS} · bridge · hafleet ${BACKEND} · console ${CONSOLE}\n`);

  /*
   * A THROWAWAY ACCOUNT, not the operator's.
   *
   * This used to log in as the human's own user and create a `loop/…` room per run
   * in their real client, then leave and forget it at teardown — leaving the client
   * holding rooms its account was no longer in, which surfaced to them as
   * "failed to load early messages … M_FORBIDDEN: you aren't member of the room".
   * A suite that leaves debris in someone's live client is not isolated, whatever it
   * reports. See scripts/lib/matrix-account.mjs.
   */
  if (!REG_TOKEN) {
    check('a registration token is configured', false,
      'set MATRIX_TOKEN — this suite registers its own throwaway account rather than using yours');
    process.exit(1);
  }
  const acct = await registerThrowaway(HS, REG_TOKEN, 'loopuser');
  const user = new MatrixClient(HS, acct.access_token, new SimpleFsStorageProvider(
    join(mkdtempSync(join(tmpdir(), 'loop-')), 'user.json'),
  ));
  const mxid = await user.getUserId();
  check('the suite runs as its own throwaway account, not the operator\'s', /^@loopuser-/.test(mxid), mxid);

  // A fresh room per run: reusing one inherits the previous run's whitelist state
  // and engagement history, which changes the routing and makes the result depend
  // on what happened last time.
  const roomName = `loop/${Date.now().toString(36)}`;
  // Retried: the homeserver rate-limits room creation, and running this suite twice
  // in a row used to throw M_LIMIT_EXCEEDED with nothing catching it — a run that
  // printed no summary and so read as "nothing happened" rather than as a failure.
  const room = await withRateLimitRetry(
    () => user.createRoom({ name: roomName, preset: 'private_chat', invite: [BOT_MXID] }),
    'createRoom',
  );
  check('a room exists on the deployed homeserver', /^![^:\s]+:[^\s]+$/.test(room), room);

  /*
   * THE REQUEST IS SENT BEFORE THE BOT CAN POSSIBLY HAVE JOINED — on purpose.
   *
   * This used to be the suite's weakest point. It waited for membership, then sent a
   * `!help` and waited for a reply to prove the bridge was READING, and only then
   * asked. That wait was covering for a real defect: sync delivers only events from
   * after the join point, and nothing backfilled a room joined by invite, so anything
   * said in the invite→join window was lost permanently — no engagement, no reply, no
   * error. Confirmed against this deployment: a `!request` at t+0, bot joined at
   * t+2s, still unanswered 80 seconds later.
   *
   * bridge-matrix.js `backfillJoinedRoom()` now delivers that window, so the suite
   * tests the hard case instead of steering around it. Inviting the bot and saying
   * what you want in the same breath is the obvious way to use it, and it has to work.
   */
  /*
   * THE ROLE IS SETTABLE, because a hardcoded one made this suite unrunnable on most fleets.
   *
   * `architect` needs a `strong`-tier agent — for the claude framework that is opus, and a deployment
   * whose agents are sonnet or deepseek-chat can fill nothing at that tier. The product behaves correctly
   * there (the request is still recorded, `serving` is null, and a provisionHint names the preset that
   * WOULD staff it) but this suite asserts an agent was chosen, so the whole loop reported failure on a
   * fleet with nothing wrong with it. Default unchanged; `LOOP_ROLE=documentation` runs it on a fleet
   * whose agents are ordinary. Check GET /api/engagements/preview?role=<r> to see what a fleet can fill.
   */
  const role = process.env.LOOP_ROLE ?? 'architect';
  const text = `!request ${role} 300000 20000`;
  await user.sendText(room, text);
  check('the project asked BEFORE the bot could join — the window that used to lose it', true, text);

  const joined = await until(async () => {
    const members = await user.doRequest('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/joined_members`);
    return Object.keys(members.joined ?? {}).includes(BOT_MXID);
  }, { tries: BRIDGE_PATIENCE_MS / 2000, gapMs: 2000 });
  check('the running bridge joined it by itself', Boolean(joined),
    joined ? '' : `${BOT_MXID} never joined in ${BRIDGE_PATIENCE_MS / 1000}s — check the bridge log for `
      + '"cooling down" (a 429 cooldown, so re-run) versus no invite handling at all');
  if (!joined) process.exit(1);

  /*
   * The client may already have seen the room by now, so this baseline is sampled
   * after creation and the assertion below POLLS for growth rather than comparing
   * against a pre-creation number. Either way it is the client's own store that
   * decides, not the timing of this sample.
   */
  const guiRunning = clientAlive();
  if (!guiRunning) skip('the GUI client is present', 'Robrix is not running — the loop is verified without it');

  // Same patience: the backfill runs at join time, so anything that delays the join
  // delays delivery by exactly as much.
  const queued = await until(async () => ((await api('engagements')).body?.engagements ?? [])
    .find((e) => e.projectRoomId === room), { tries: BRIDGE_PATIENCE_MS / 1500, gapMs: 1500 });
  check('the RUNNING bridge delivered the pre-join request to hafleet', Boolean(queued),
    queued ? '' : 'no engagement appeared — is bridge-matrix.js running, and does it have the join backfill?');
  if (!queued) process.exit(1);

  check('labelled with the room name, not its id', queued.project === roomName,
    `${queued.project} vs ${roomName}`);
  check('keyed on the room id Matrix reported', queued.projectRoomId === room);
  check('attributed to the Matrix sender', queued.requester === mxid, `${queued.requester} vs ${mxid}`);
  check('an agent was chosen before any decision', Boolean(queued.agent), String(queued.agent));
  check('and it is waiting, not auto-joined', queued.state === 'pending', `${queued.state}/${queued.route}`);

  const replied = await until(async () => {
    const m = await user.doRequest('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/messages`, { dir: 'b', limit: 10 });
    return (m.chunk ?? []).find((e) => e.type === 'm.room.message' && e.sender === BOT_MXID);
  }, { tries: 15, gapMs: 1500 });
  check('the bot answered in the room, where a human would see it', Boolean(replied),
    replied?.content?.body?.slice(0, 90) ?? 'no reply');

  // ── the contributor approves, in a real browser ────────────────────────────
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  await page.goto(`${CONSOLE}/engagements`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="provenance"]:not(.loading)', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);

  const body = await page.$eval('main', (el) => el.innerText).catch(() => '');
  check('the console shows the request', body.includes(room), room);
  check('and names the agent whose ceiling would be spent', body.includes(queued.agent), queued.agent);

  const pressed = await page.evaluate((r) => {
    const row = [...document.querySelectorAll('table.tbl tbody tr')].find((x) => x.innerText.includes(r));
    if (!row) return 'row not found';
    const btn = [...row.querySelectorAll('button')].find((b) => /approve|批准/i.test(b.innerText));
    if (!btn) return 'no approve control';
    btn.click();
    return 'clicked';
  }, room);
  check('Approve is clickable in the browser', pressed === 'clicked', pressed);
  await page.waitForTimeout(2000);
  await browser.close();

  // ── and it took effect ─────────────────────────────────────────────────────
  const bound = await until(async () => ((await api('contributions')).body?.contributions ?? [])
    .find((b) => b.projectRoomId === room), { tries: 10, gapMs: 1000 });
  /*
   * The assertion the whole loop exists for. Not `state === 'active'` — that was
   * true before this path was built, while nothing had actually attached.
   */
  check('a browser click BOUND the agent to the project room', Boolean(bound), JSON.stringify(bound ?? {}));
  if (bound) {
    check('the binding names the promised agent', bound.agent === queued.agent, `${bound.agent} vs ${queued.agent}`);
    check('and carries an owner', /^@[^:\s]+:[^\s]+$/.test(bound.ownerMxid ?? ''), bound.ownerMxid);

    /*
     * AND THE HOMESERVER'S OWN ACCOUNT OF WHO IS IN THE ROOM — not HAFleet's record of it.
     *
     * Every check above this reads a HAFleet store. A binding is our claim that an agent is attached; the
     * membership is the customer's homeserver's fact, and `admitAgentToProjectRoom` returns its outcome
     * only on the verdict response, which nothing was reading. So an approval that bound the agent and
     * failed to admit it looked identical to one that worked — and this repository has already shipped
     * that exact shape twice, which is why this asks the room instead.
     *
     * The mxid is composed the way HAFleet mints it (`MATRIX_AGENT_PREFIX` + agent name on the side's
     * server), so a prefix mismatch shows up here rather than as a silent absence.
     */
    const prefix = process.env.MATRIX_AGENT_PREFIX ?? 'ac_';
    const want = `@${prefix}${queued.agent}:`.toLowerCase();
    const seen = await until(async () => {
      const m = await user.doRequest('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/joined_members`);
      return Object.keys(m.joined ?? {}).find((u) => u.toLowerCase().startsWith(want)) ?? null;
    }, { tries: 15, gapMs: 2000 });
    check('the agent is IN the room, by the homeserver\'s own account of its members', Boolean(seen),
      seen ?? `no member starting ${want} — the binding exists but the admission did not happen`);
  }

  // ── did the real GUI client see any of it? ─────────────────────────────────
  if (guiRunning) {
    check('the real GUI client survived the whole loop', clientAlive(),
      clientAlive() ? 'still running' : 'died during the run');
    skip('the GUI client RENDERED this room and message',
      'not machine-verifiable from out here — see the header for the four signals tried and why '
      + 'each is unsound. A human confirms this one by looking, which is what the client is in '
      + 'the loop for.');
  }

  /*
   * THE FORMER DEFECT, now an assertion rather than a SKIP.
   *
   * This whole run depended on it: the request at the top was sent before the bot
   * could join, so an engagement existing at all means the invite→join window was
   * delivered. Restated here as its own named check so the thing that was broken is
   * visible in the output, not merely implied by the run having got this far.
   *
   * `already-synced=0` in the bridge's own `Join backfill …` log line is what
   * distinguishes the backfill delivering it from sync happening to win the race —
   * the first version of this fix passed live only because sync had won, which is why
   * that counter exists.
   */
  check('a request sent before the bot joined is delivered, not silently dropped',
    Boolean(queued), queued ? `engagement ${queued.id}` : 'the invite→join window still loses messages');

  // ── leave it as we found it ────────────────────────────────────────────────
  const live = ((await api('engagements')).body?.engagements ?? []).find((e) => e.projectRoomId === room);
  if (live?.state === 'active') {
    await api(`engagements/${live.id}/revoke`, { method: 'POST', body: JSON.stringify({ reason: 'full-loop teardown' }) });
  }
  const after = ((await api('contributions')).body?.contributions ?? []).filter((b) => b.projectRoomId === room);
  check('revoking detaches the agent again', after.length === 0, JSON.stringify(after));
  /*
   * Remove the room from EVERY account in it, not just this suite's.
   *
   * Teardown used to leave as the creating account only, so the bot stayed — and over
   * a few dozen runs it accumulated 42 abandoned rooms. Invisible from here, because
   * the suite checked its own account and found it clean. The failure is reported
   * rather than swallowed: a leak nobody is told about is how it reached 42.
   */
  const botToken = await botCredentials(HS, BOT_USER, BOT_PASSWORD, BRIDGE_STATE);
  const accounts = [
    { label: 'suite', token: acct.access_token },
    ...(botToken ? [{ label: 'bot', token: botToken }] : []),
  ];
  // Every room this run's identity touched, not just the one it created — the bridge
  // opens a greeting DM with each new human, and that was leaking a room per run on
  // its own after the project room was already being cleaned.
  const touched = new Set([room, ...await roomsTouchedBy(HS, acct.access_token)]);
  const failures = [];
  for (const r of touched) {
    // eslint-disable-next-line no-await-in-loop
    const result = await purgeRoom(HS, r, accounts);
    failures.push(...result.failed.map((f) => ({ room: r, ...f })));
  }
  check('the run leaves no room behind in any account',
    failures.length === 0 && Boolean(botToken),
    botToken
      ? `purged ${touched.size} room(s)${failures.length ? ` | failed: ${JSON.stringify(failures)}` : ''}`
      : 'no bot credentials (MATRIX_BOT_USERNAME/MATRIX_BOT_PASSWORD) — the bot stays in the room');

  const tail = skipped ? ` ${skipped} skipped.` : '';
  console.log(`\n${failed === 0 ? `All ${ran} full-loop checks pass.${tail}` : `${failed} of ${ran} FAILED.${tail}`}\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  /*
   * A throw is a failed run, and it must SAY so. Without this the suite exited on an
   * unhandled rejection printing a bare stack and no summary line, so a caller
   * grepping for the result saw nothing — indistinguishable from a run that never
   * started. Now the summary is always the last line, whatever happened.
   */
  console.log(`  FAIL  the suite ran to completion  — ${err?.message ?? err}`);
  console.log(`\n${failed + 1} of ${ran + 1} FAILED. ${skipped} skipped.\n`);
  process.exit(1);
});
