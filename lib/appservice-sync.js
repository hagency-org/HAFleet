import { secretEquals } from './appservice-receiver.js';

/**
 * The third way in: a plain outbound /sync loop, with no socket and no edge process.
 *
 * WHY THIS EXISTS. The listener needs HAFleet to be reachable FROM the homeserver; the edge link
 * needs a second process running beside the homeserver. A fleet on a laptop behind NAT has neither.
 * But an application service can log in with its master token (`m.login.application_service`,
 * token = as_token, identifier = sender_localpart) and get an ordinary access token, then poll
 * /sync like any client — same direction as the customer's own phone. Palpo 0.4.0 supports the
 * flow; the login form was measured, not assumed.
 *
 * HALF-CONFIGURED IS REFUSED, not treated as off — same rule as the edge link. A side with no
 * homeserver URL is a secret with nowhere to go; a URL with no side is a poll for tokens we do
 * not hold. Default OFF: nothing is set, nothing runs, nothing is logged.
 */
export function resolveAppserviceSyncConfig(env = process.env) {
  const side = String(env.HAFLEET_APPSERVICE_SYNC_SIDE ?? '').trim();
  const baseUrl = String(env.HAFLEET_APPSERVICE_SYNC_URL ?? '').trim().replace(/\/+$/, '');
  if (!side && !baseUrl) {
    return { enabled: false, reason: 'HAFLEET_APPSERVICE_SYNC_SIDE is not set, so sync intake is not expected' };
  }
  if (!side) return { enabled: false, reason: 'HAFLEET_APPSERVICE_SYNC_URL is set but HAFLEET_APPSERVICE_SYNC_SIDE names no project side' };
  if (!baseUrl) return { enabled: false, reason: 'HAFLEET_APPSERVICE_SYNC_SIDE is set but HAFLEET_APPSERVICE_SYNC_URL names no homeserver' };
  if (!/^https?:\/\//i.test(baseUrl)) {
    return { enabled: false, reason: `HAFLEET_APPSERVICE_SYNC_URL must be an absolute http(s) URL, got ${baseUrl}` };
  }
  return { enabled: true, side, baseUrl };
}

const LOGIN_TIMEOUT_MS = 15_000;
const SYNC_TIMEOUT_MS = 60_000;
const MAX_BACKOFF_MS = 60_000;

/**
 * Login as the application service itself: m.login.application_service with the as_token and the
 * sender_localpart as identifier. The homeserver answers an ordinary access token; it is cached in
 * the side credential structure by the caller. A 401 later means the token expired or the
 * registration was re-issued — the caller logs in once more before giving up and backing off.
 */
export async function appserviceLogin({ baseUrl, asToken, senderLocalpart, fetchImpl = fetch }) {
  const res = await fetchImpl(`${baseUrl}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'm.login.application_service',
      identifier: { type: 'm.id.user', user: senderLocalpart },
      token: asToken,
    }),
    signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`appservice login answered HTTP ${res.status}${body?.errcode ? ` ${body.errcode}` : ''}`);
    err.status = res.status;
    throw err;
  }
  return { accessToken: body?.access_token ?? null, userId: body?.user_id ?? null };
}

/**
 * One /sync poll. `since` is the persisted next_batch cursor; the FIRST poll passes null and
 * reads next_batch WITHOUT delivering its join timeline (an initial sync replays history, and
 * replaying history is the duplicate storm the cursor exists to prevent) — but INVITES are
 * delivered even on the first poll: an invite sitting in the strainer while the fleet was down
 * must not wait for a second poll to be seen, or every restart silently delays the knock
 * handshake by up to one long-poll.
 *
 * The request carries an explicit filter: timeline limited to room events, presence offline,
 * no account_data and no to-device traffic. Membership/invite sections are NOT filtered — they
 * are the payload this intake exists to collect.
 */
export async function appserviceSyncOnce({ baseUrl, accessToken, since, timeoutMs = SYNC_TIMEOUT_MS, fetchImpl = fetch }) {
  const url = new URL(`${baseUrl}/_matrix/client/v3/sync`);
  url.searchParams.set('timeout', '30000');
  url.searchParams.set('set_presence', 'offline');
  /*
   * An explicit ALLOWLIST filter: room.timeline limited to m.room.* (the namespace every event
   * the router handles lives in — message, member, encryption, topic...), account_data and
   * to_device cut entirely. Membership arrives via rooms.invite/rooms.join state sections,
   * which a room filter does not restrict, so invites and joins both survive.
   */
  const filter = { room: { timeline: { types: ['m.room.*'] } }, account_data: { types: [] }, to_device: { types: [] } };
  url.searchParams.set('filter', JSON.stringify(filter));
  if (since) url.searchParams.set('since', since);
  const res = await fetchImpl(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 401) {
    const err = new Error('sync answered 401');
    err.status = 401;
    throw err;
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`sync answered HTTP ${res.status}`);
  const timelineEvents = [];
  const inviteEvents = [];
  const joins = body?.rooms?.join ?? {};
  for (const [roomId, room] of Object.entries(joins)) {
    const timeline = Array.isArray(room?.timeline?.events) ? room.timeline.events : [];
    for (const ev of timeline) timelineEvents.push({ ...ev, room_id: roomId });
  }
  const invites = body?.rooms?.invite ?? {};
  for (const [roomId, room] of Object.entries(invites)) {
    const state = Array.isArray(room?.invite_state?.events) ? room.invite_state.events : [];
    for (const ev of state) inviteEvents.push({ ...ev, room_id: roomId });
  }
  return { nextBatch: body?.next_batch ?? null, timelineEvents, inviteEvents, initial: !since };
}

/**
 * The sync collect loop. Feeds the SAME router as listener/edge, shaped as a homeserver
 * transaction (txn key = the sync cursor, so a redelivery of the same cursor dedups), with the
 * side's hs_token as the router credential — no privileged short-cut past authentication.
 *
 * `readCursor`/`writeCursor` persist next_batch (state store); `credentialFor` yields
 * { asToken, hsToken, senderLocalpart } for the side. Backoff is exponential and resets on any
 * successful poll. A 401 triggers exactly ONE re-login attempt before backing off, so a rotated
 * registration is not hammered.
 */
export function startAppserviceSyncCollector({
  baseUrl,
  side,
  router,
  credentialFor,
  readCursor = () => null,
  writeCursor = async () => {},
  onLogin = () => {},
  fetchImpl = fetch,
  logger = console,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  shouldContinue = () => true,
}) {
  const stats = { polls: 0, events: 0, processed: 0, failed: 0, logins: 0, lastError: null, lastErrorAt: null };
  let stopped = false;
  let accessToken = null;
  let backoffMs = 1_000;
  /*
   * 401 LOOP BREAKER. A fresh token that is rejected by /sync means the problem is NOT the token
   * (a rotated registration would fail at login) — it is the homeserver or our account state.
   * Continuing to clear-and-relogin on that would hammer the login endpoint of a server that
   * just said no, so a 401 against a token WE minted this loop-session goes straight to backoff.
   */
  let loginGeneration = 0;

  const stop = () => { stopped = true; };
  const loop = (async () => {
    while (!stopped && shouldContinue()) {
      try {
        const credential = credentialFor();
        if (!credential?.asToken) throw new Error(`no appservice credential loaded for side ${side}`);
        if (!accessToken) {
          const login = await appserviceLogin({ baseUrl, asToken: credential.asToken, senderLocalpart: credential.senderLocalpart, fetchImpl });
          accessToken = login.accessToken;
          loginGeneration += 1;
          stats.logins += 1;
          onLogin(login);
        }
        const since = readCursor();
        const result = await appserviceSyncOnce({ baseUrl, accessToken, since, fetchImpl });
        stats.polls += 1;
        backoffMs = 1_000;
        /*
         * INVITES FIRST, on EVERY poll including the first. An invite left pending while the
         * bridge was down is waiting to be seen; join-timeline skipping protects against replay,
         * and there is nothing to replay in an invite — the state section exists only in the
         * present. Shaped identically to a join event (room_id injected) so the router treats
         * them alike.
         */
        const deliverable = [...result.inviteEvents];
        let skipTimeline = result.initial;
        if (!result.initial) deliverable.push(...result.timelineEvents);
        if (deliverable.length) {
          /*
           * Txn id derived from the CURSOR, not a counter: a restart re-reads the same cursor and
           * the router's dedup window absorbs the redelivery, which is the property that makes
           * at-least-once delivery safe here. Dedup inside the receiver is by event_id.
           *
           * THE CURSOR MOVES ONLY AFTER A 200. Write it before handle() and a crash between the
           * two drops the batch entirely (cursor says consumed, events never processed); write
           * it after and a crash in the window replays the batch on restart, which the event-id
           * dedup absorbs. At-least-once, never at-most-once — the same side the rest of the
           * intake lands on.
           */
          const txnId = `sync-${result.nextBatch ?? `pre-${since ?? 'start'}`}`;
          const handled = await router.handle({
            method: 'PUT',
            path: `/_matrix/app/v1/transactions/${encodeURIComponent(txnId)}`,
            query: {},
            headers: { authorization: `Bearer ${credential.hsToken ?? ''}` },
            body: { events: deliverable },
          });
          stats.events += deliverable.length;
          if (handled?.status === 200) {
            stats.processed += 1;
            if (result.nextBatch) await writeCursor(result.nextBatch);
          } else {
            /*
             * NOT 200 → the cursor does NOT advance and this batch is retried after backoff.
             * Advancing on failure would be silent data loss: the homeserver considers the
             * batch delivered (we consumed the sync response) and will never resend it.
             */
            stats.failed += 1;
            stats.lastError = `router answered ${handled?.status}`;
            stats.lastErrorAt = Date.now();
            throw new Error(stats.lastError);
          }
        } else if (result.nextBatch && !skipTimeline) {
          // Nothing deliverable: safe to advance the cursor — there is nothing to replay.
          await writeCursor(result.nextBatch);
        } else if (result.nextBatch && skipTimeline) {
          /*
           * FIRST POLL: the initial join timeline is deliberately swallowed but the cursor must
           * still move past it, or every restart replays the whole history window. Invites (if
           * any) were delivered above; only after that delivery succeeded is the cursor safe.
           */
          await writeCursor(result.nextBatch);
        }
      } catch (error) {
        stats.lastError = String(error?.message || error);
        stats.lastErrorAt = Date.now();
        if (error?.status === 401) {
          /*
           * ONE re-login per 401 ON A TOKEN FROM A PREVIOUS GENERATION. A 401 on the token we
           * just minted (same generation) skips straight to backoff — the loop-breaker above.
           */
          if (accessToken && loginGeneration <= 1) {
            accessToken = null;
            loginGeneration = 0;
            logger.warn?.(`[appservice-sync] token rejected for side ${side}; logging in once more`);
            continue;
          }
          if (accessToken) {
            logger.error?.(`[appservice-sync] a fresh login token was rejected by sync for side ${side} — backing off, not re-logging in`);
          } else {
            logger.error?.(`[appservice-sync] re-login rejected for side ${side} — check the registration's as_token`);
          }
        } else {
          logger.warn?.(`[appservice-sync] poll failed for side ${side}: ${stats.lastError}`);
        }
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
    }
  })();
  return { stop, stats, loop };
}
