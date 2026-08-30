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
  let side = String(env.HAFLEET_APPSERVICE_SYNC_SIDE ?? '').trim();
  const baseUrl = String(env.HAFLEET_APPSERVICE_SYNC_URL ?? '').trim().replace(/\/+$/, '');
  if (!side && !baseUrl) {
    return { enabled: false, reason: 'HAFLEET_APPSERVICE_SYNC_SIDE is not set, so sync intake is not expected' };
  }
  if (side) {
    /*
     * SIDE NAMES ARE NORMALIZED, not merely trimmed. The project-side store lowercases server
     * names (they end up inside MXIDs and `Palpo.Test` is a typo, not a decision), and the
     * intake mutex is only sound if it compares the SAME spelling the store would: without
     * this, `Side-A` via sync plus `side-a` via edge sails past a per-side mutex and delivers
     * every event twice. URL-shaped and trailing-slash values are refused outright — a side
     * id is an identifier, not an address.
     */
    if (/\/\s*$/.test(side) || /^https?:\/\//i.test(side)) {
      return { enabled: false, reason: `HAFLEET_APPSERVICE_SYNC_SIDE must be a side id, not a URL or slash-suffixed value, got ${side}` };
    }
    side = side.toLowerCase();
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
/*
 * A RETRY LIMIT, not just a backoff. A batch the router keeps refusing (a wedged handler, a
 * credential the router will not take) would otherwise be retried forever — a loop that holds
 * the cursor hostage and fills the log with the same error. FAST-BREAK semantics (5-r3): the
 * retry interval for a refusing batch is a FIXED 1s (no climb), so the break lands in ~8s and
 * the operator's warning rides postWarning while the failure is still fresh. Recovery is by
 * restart (or manual), which is deliberate: a poison batch is an operator problem, not a
 * patience problem, and stretching the window to minutes would only delay the page. The value
 * 8 is contractual — the spec states it and a test pins it, along with the eight-1000ms sleep
 * sequence. The cursor never moves past an undelivered batch, so stopping is safe: nothing is
 * lost, nothing is skipped, and a restart resumes from the held cursor.
 */
const MAX_DELIVERY_ATTEMPTS = 8;
const POISON_RETRY_MS = 1_000;

/**
 * Login as the application service itself: m.login.application_service with the as_token and the
 * sender_localpart as identifier. The homeserver answers an ordinary access token. That token is
 * a PROCESS-LOCAL cache in the collector (see spec: never persisted, matching the in-memory-only
 * acting-credential design); a 401 later means it expired or the registration was re-issued, and
 * the caller decides whether one re-login is worth attempting before backing off.
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
  onCircuitBreak = null,
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
         * them alike. NOTE ON IDEMPOTENCE: invite-section events carry NO event_id, so the
         * router's event-id dedup does not apply to them — a redelivered invite (restart
         * redelivery is routine here, since invites are delivered on every poll until the
         * homeserver advances the room out of the invite section) is made harmless by the
         * Matrix JOIN being idempotent plus the bridge's trust-state reconciliation, not by
         * dedup.
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
            stats.batchAttempts = 0; // a success resets the retry count for the NEXT batch
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
            stats.lastFailedBatch = result.nextBatch ?? null;
            const attempts = (stats.batchAttempts = (stats.batchAttempts ?? 0) + 1);
            if (attempts >= MAX_DELIVERY_ATTEMPTS) {
              /*
               * CIRCUIT-BREAK the side: stop polling, HOLD the cursor (a restart or a manual
               * recovery resumes from exactly here — nothing skipped, nothing lost), and warn
               * the operator EXACTLY ONCE through the existing warning convention. Infinite
               * head-of-line blocking is forbidden; so is silence.
               */
              stats.gaveUp = true;
              if (!stats.circuitBreakWarned) {
                stats.circuitBreakWarned = true;
                logger.error?.(`[appservice-sync] router refused batch for side ${side} ${attempts} times — circuit-breaking this collector; `
                  + `recovery resumes from held cursor ${since ?? '(none)'}; the batch ending at ${result.nextBatch ?? '(none)'} was never committed`);
                try { onCircuitBreak?.(side, { attempts, heldCursor: since ?? null, failedNextBatch: result.nextBatch ?? null, lastError: stats.lastError }); } catch { /* the hook must not break the break */ }
              }
              stopped = true;
              break;
            }
            /*
             * TAGGED, not inferred from history (5-r4): the catch-side backoff split reads THIS
             * error's kind. batchAttempts>0 as the discriminator mis-routed a network blip in a
             * poison batch's recovery window into the fixed-1s lane forever; the tag says what
             * THIS failure is, regardless of what came before it.
             */
            const poison = new Error(stats.lastError);
            poison.code = 'poison_batch';
            throw poison;
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
        /*
         * TWO BACKOFF SHAPES, ROUTED BY THIS ERROR'S TAG (5-r4): an error tagged
         * `poison_batch` (the router refused THIS batch) is a delivery problem the operator
         * must see fast — fixed 1s, circuit-break in ~8s. Everything else (network, login,
         * JSON) is a transient the loop can outwait and keeps the exponential climb, EVEN
         * while a poison batch is mid-retry: a network blip in the recovery window must not
         * be parked in the 1Hz lane, and batchAttempts is only the circuit-break counter,
         * never the backoff discriminator.
         */
        const isPoisonBatch = error?.code === 'poison_batch';
        const waitMs = isPoisonBatch ? POISON_RETRY_MS : backoffMs;
        await sleep(waitMs);
        if (!isPoisonBatch) {
          backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        }
      }
    }
  })();
  return { stop, stats, loop };
}
