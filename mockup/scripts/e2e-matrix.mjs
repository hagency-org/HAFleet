/*
 * End-to-end: a real Matrix room asks, and an agent ends up attached to it.
 *
 * WHAT THIS PROVES THAT NOTHING ELSE DOES. The other three suites all start inside
 * hafleet. This one starts outside it, in Matrix, and finishes at a binding — the
 * record that actually attaches an agent to a project. Until this existed, two gaps
 * were invisible to every test in the repo:
 *
 *   - nothing outside the console could submit an engagement request at all; and
 *   - approving one never called upsertBinding(), so six active engagements sat
 *     against zero bindings and the console's central action changed nothing.
 *
 * The assertion at the end is deliberately the binding, not the engagement's own
 * `state`. A record can say `active` while the world is untouched, which is exactly
 * what it used to do.
 *
 * WHY THIS IS NOT IN `npm test`. specs/project.spec.md:26 — "Tests must not contact
 * Palpo, Claude, Codex, GitHub, or another live external service." This contacts a
 * real homeserver on purpose, so it is opt-in and lives beside live-ux.mjs, which
 * has the same shape and the same reason.
 *
 * Run:
 *   ssh -f -N -L 8008:127.0.0.1:8008 cloud@<mini1>     # tunnel to the homeserver
 *   HAFLEET_REQUESTER_TOKEN=… node scripts/e2e-matrix.mjs
 *
 * Env:
 *   MATRIX_HS     homeserver base url            (default http://127.0.0.1:8008)
 *   MATRIX_TOKEN  registration token             (REQUIRED — no default, see below)
 *   BACKEND       hafleet backend                (default http://127.0.0.1:8090)
 *   API_TOKEN     operator token                 (default devtoken)
 *   HAFLEET_REQUESTER_TOKEN  requester token, if the backend separates them
 */

import { MatrixClient, SimpleFsStorageProvider } from 'matrix-bot-sdk';
import { withRateLimitRetry } from './lib/matrix-rate-limit.mjs';
import { registerThrowaway } from './lib/matrix-account.mjs';
import { purgeRoom } from './lib/matrix-teardown.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * :8008 because that is what the homeserver advertises in .well-known, and therefore
 * what the GUI client's discovery resolves to. An earlier tunnel also forwarded 8009
 * and both ports answered from the same server, which is confusing rather than
 * redundant: two ports that look like two homeservers invite exactly the mistake of
 * validating against one while the client talks to the other.
 */
const HS = process.env.MATRIX_HS ?? 'http://127.0.0.1:8008';
/*
 * No default, deliberately. This gates registration on a homeserver reachable from
 * the internet, so a literal here would be a credential published to the repo the
 * moment this file is pushed. The suite refuses to run without it rather than
 * carrying one.
 */
const REG_TOKEN = process.env.MATRIX_TOKEN ?? '';
const BACKEND = process.env.BACKEND ?? 'http://127.0.0.1:8090';
const TOKEN = process.env.API_TOKEN ?? 'devtoken';

let failed = 0;
let ran = 0;
const check = (name, ok, detail = '') => {
  ran += 1;
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

async function api(path, opts = {}) {
  const res = await fetch(`${BACKEND}/api/${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// Fresh accounts per run; the reasoning and the rate-limit retry live in the helper,
// which the full-loop suite shares.
const register = (prefix) => registerThrowaway(HS, REG_TOKEN, prefix);

const store = (name) => new SimpleFsStorageProvider(join(mkdtempSync(join(tmpdir(), 'e2e-')), `${name}.json`));

(async () => {
  console.log(`\nE2E — Matrix ${HS} -> hafleet ${BACKEND}\n`);

  if (!REG_TOKEN) {
    check('a registration token is configured', false,
      'set MATRIX_TOKEN — it gates registration on the homeserver and is not stored in this repo');
    process.exit(1);
  }

  // Reachability first, so a missing tunnel reports itself rather than surfacing as
  // a confusing registration failure twenty lines later.
  try {
    const v = await fetch(`${HS}/_matrix/client/versions`);
    check('the homeserver answers', v.ok, `HTTP ${v.status}`);
  } catch (e) {
    check('the homeserver answers', false, `${e.message} — is the ssh tunnel up?`);
    process.exit(1);
  }

  /*
   * The credential is checked HERE, not discovered six steps later.
   *
   * lib/bot-commands.js:85 sends HAFLEET_REQUESTER_TOKEN or API_TOKEN, whichever
   * exists. With neither, the backend correctly refuses and the failure surfaced as
   * "the request never reached hafleet as an engagement" — which reads like a broken
   * bridge and is really an unset variable in the caller's shell. Same reason the
   * homeserver reachability check is the first thing above.
   */
  if (!(process.env.HAFLEET_REQUESTER_TOKEN || '').trim() && !(process.env.API_TOKEN || '').trim()) {
    check('a credential is available to submit the request', false,
      'set HAFLEET_REQUESTER_TOKEN (preferred) or API_TOKEN — the bot sends one of them');
    process.exit(1);
  }

  const { default: BotCommands } = await import('../../lib/bot-commands.js');

  const projectAcct = await register('project');
  const contribAcct = await register('contributor');
  const project = new MatrixClient(HS, projectAcct.access_token, store('project'));
  const contributor = new MatrixClient(HS, contribAcct.access_token, store('contributor'));
  const projectMxid = await project.getUserId();

  const contribMxid = await contributor.getUserId();
  const room = await withRateLimitRetry(() => project.createRoom({
    name: 'e2e/api-service', preset: 'private_chat', invite: [contribMxid],
  }), 'createRoom');
  await contributor.joinRoom(room);
  check('a project room exists on the homeserver', /^![^:\s]+:[^\s]+$/.test(room), room);

  // There must be an agent that can serve the role, or the test proves nothing.
  const agents = (await api('agents')).body ?? [];
  const capability = (await api('capability')).body;
  const architect = capability?.roles?.find((r) => r.role === 'architect');
  if (!architect || architect.fillable === 0) {
    check('an agent qualifies for architect', false,
      `${agents.length} agents, ${architect?.fillable ?? 0} can fill architect — seed one first`);
    process.exit(1);
  }

  /*
   * The message goes through Matrix, and the handler is given ONLY the room and the
   * sender that Matrix reports. Passing the room id in the body would let a caller
   * assert someone else's trusted room, which is precisely what the whitelist keys
   * on — so the test drives it the way the bridge does.
   */
  const text = '!request architect 400000 20000';
  await project.sendText(room, text);
  const replies = [];
  const bot = new BotCommands({ sendMessage: async () => {} });
  bot.reply = async (_r, plain) => { replies.push(plain); };
  bot.client = contributor;
  await bot.handle(room, projectMxid, text);

  /*
   * A REFUSAL IS NOT AN ANSWER.
   *
   * This used to assert only `replies.length > 0`, which passed while the reply was
   * "Request refused: bearer token required" — the bridge had answered, in the sense
   * that bytes came back, and the check could not tell that apart from the bridge
   * doing its job. Same shape as the "every live agent name appears" tautology: an
   * assertion that holds whether or not the behaviour works.
   */
  const answer = replies.at(-1) ?? '';
  check('the bridge answered the request in-room', replies.length > 0 && !/refused|error|unauthor/i.test(answer),
    answer || '(no reply)');
  check('and gave the project a reason it can act on',
    /whitelist|published|left|Joined automatically/i.test(replies.at(-1) ?? ''), replies.at(-1));

  const queued = ((await api('engagements')).body?.engagements ?? [])
    .find((e) => e.projectRoomId === room);
  check('the request reached hafleet as an engagement', Boolean(queued), room);
  if (!queued) process.exit(1);

  check('keyed on the room id Matrix reported, not one the sender chose',
    queued.projectRoomId === room, `${queued.projectRoomId} vs ${room}`);
  check('and attributed to the Matrix sender', queued.requester === projectMxid,
    `${queued.requester} vs ${projectMxid}`);
  check('an agent that qualifies for the role was chosen before any decision',
    Boolean(queued.agent), String(queued.agent));

  const before = ((await api('contributions')).body?.contributions ?? [])
    .filter((b) => b.projectRoomId === room);
  check('no binding exists before the contributor decides', before.length === 0, `${before.length}`);

  const verdict = await api(`engagements/${queued.id}/verdict`, {
    method: 'POST', body: JSON.stringify({ approve: true, allocatedTokens: 400_000 }),
  });
  check('the contributor can approve it', verdict.status === 200,
    `HTTP ${verdict.status} ${JSON.stringify(verdict.body?.error ?? '')}`);

  /*
   * THE ASSERTION THIS SUITE EXISTS FOR.
   *
   * Not `state === 'active'` — that was true before the fix while nothing had
   * happened. A binding is the record that attaches the agent to the project room
   * with an owner, and its absence was the open loop.
   */
  const bindings = ((await api('contributions')).body?.contributions ?? [])
    .filter((b) => b.projectRoomId === room);
  check('approving BINDS the agent to the project room', bindings.length === 1,
    JSON.stringify(bindings));
  if (bindings.length === 1) {
    check('the binding names the agent that was promised', bindings[0].agent === queued.agent,
      `${bindings[0].agent} vs ${queued.agent}`);
    check('and an owner', /^@[^:\s]+:[^\s]+$/.test(bindings[0].ownerMxid ?? ''), bindings[0].ownerMxid);
    check('and it is active', bindings[0].active === true);
  }
  check('the verdict reported the binding outcome to the caller',
    verdict.body?.binding?.bound === true, JSON.stringify(verdict.body?.binding));

  // Revoking detaches. A contribution that ended must not leave a live binding.
  const revoked = await api(`engagements/${queued.id}/revoke`, {
    method: 'POST', body: JSON.stringify({ reason: 'e2e teardown' }),
  });
  check('revoking ends the engagement', revoked.body?.engagement?.state === 'ended');
  const after = ((await api('contributions')).body?.contributions ?? [])
    .filter((b) => b.projectRoomId === room);
  check('and detaches the agent', after.length === 0, JSON.stringify(after));

  /*
   * Both accounts this suite registered joined the room, and neither was leaving it.
   * No bot account is involved here — the command handler runs in-process — so these
   * two are the whole membership.
   */
  const purge = await purgeRoom(HS, room, [
    { label: 'project', token: projectAcct.access_token },
    { label: 'contributor', token: contribAcct.access_token },
  ]);
  check('the run leaves no room behind in any account', purge.failed.length === 0,
    `left by: ${purge.left.join(', ')}${purge.failed.length ? ` | failed: ${JSON.stringify(purge.failed)}` : ''}`);

  console.log(`\n${failed === 0 ? `All ${ran} end-to-end checks pass.` : `${failed} of ${ran} FAILED.`}\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  // Same reason as the full-loop suite: a throw is a failure and has to print one.
  console.log(`  FAIL  the suite ran to completion  — ${err?.message ?? err}`);
  console.log(`\n${failed + 1} of ${ran + 1} FAILED.\n`);
  process.exit(1);
});
