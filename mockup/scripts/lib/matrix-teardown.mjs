/*
 * Remove a test room from EVERY account that joined it, not just the one that made it.
 *
 * WHY THIS EXISTS. The suites created a room per run and invited the bot; teardown
 * had only the creating account leave. The bot stayed. Over a few dozen runs it
 * accumulated 42 abandoned rooms — invisible from the suite's side, because the suite
 * checked its own account and found it clean.
 *
 * The same oversight already bit the operator once from the other direction: rooms
 * left behind in their real Matrix client surfaced as
 * `M_FORBIDDEN: you aren't member of the room` when it tried to backfill them.
 *
 * A test that cleans up only what it can see is not cleaning up. Membership is the
 * thing to enumerate, so this asks the room who is in it and removes every account it
 * has credentials for.
 */

import { existsSync, readFileSync } from 'node:fs';
import { withRateLimitRetry } from './matrix-rate-limit.mjs';

/**
 * Leave and forget `roomId` as every account in `accounts`.
 *
 * Best effort by design: teardown must never fail a run whose assertions passed, and
 * a room that cannot be left is a leak to report rather than an error to throw. The
 * count of failures is returned so a caller can say so instead of assuming success.
 *
 * @param {string} homeserver base url
 * @param {string} roomId
 * @param {Array<{label: string, token: string}>} accounts credentials to clean with
 * @returns {Promise<{left: string[], failed: Array<{label: string, error: string}>}>}
 */
export async function purgeRoom(homeserver, roomId, accounts) {
  const encoded = encodeURIComponent(roomId);
  const left = [];
  const failed = [];

  for (const { label, token } of accounts) {
    if (!token) continue;
    const call = (path) => withRateLimitRetry(async () => {
      const res = await fetch(`${homeserver}/_matrix/client/v3/rooms/${encoded}/${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (res.ok) return true;
      const body = await res.json().catch(() => ({}));
      // Already gone is success: teardown is idempotent, and a room the account was
      // never in does not need leaving.
      if (body.errcode === 'M_NOT_FOUND' || body.errcode === 'M_FORBIDDEN') return true;
      const err = new Error(`${path}: ${body.errcode ?? res.status}`);
      Object.assign(err, body);
      throw err;
    }, `${label} ${path}`);

    try {
      await call('leave');
      await call('forget');
      left.push(label);
    } catch (error) {
      failed.push({ label, error: error.message });
    }
  }
  return { left, failed };
}

/**
 * Every room this account is in OR invited to, from its own /sync.
 *
 * WHY NOT JUST THE ROOM THE SUITE CREATED. The bridge greets each human it discovers
 * by opening a DM with them, and the suites now register a throwaway account per run
 * — so every run produced a greeting DM as well as a project room, and cleaning only
 * the project room left the bot's membership growing by one a run anyway. Two leaks
 * that look identical from outside; fixing the visible one made the other easy to
 * mistake for a fix.
 *
 * Asking this account what it is in finds both, and finds anything the bridge invents
 * later, without enumerating the bot's entire room list on every run.
 */
export async function roomsTouchedBy(homeserver, token) {
  try {
    const res = await fetch(`${homeserver}/_matrix/client/v3/sync?timeout=0`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const body = await res.json();
    // Invited counts: a greeting DM the account never accepted is still a room the
    // bot is sitting in, waiting.
    return [
      ...Object.keys(body?.rooms?.join ?? {}),
      ...Object.keys(body?.rooms?.invite ?? {}),
    ];
  } catch {
    return [];
  }
}

/**
 * A usable bot access token, or null.
 *
 * PREFER THE BRIDGE'S OWN TOKEN over logging in. A fresh `/login` per run is what
 * Palpo's limiter throttles hardest, and it failed every time once the suites started
 * running back to back — six retries, then `botCredentials` returned null, the bot
 * never left, and the room count grew by two a run while the suite reported a clean
 * teardown for the account it *could* see. Logging in to clean up made cleanup depend
 * on the one endpoint most likely to refuse.
 *
 * The running bridge already holds a valid token in its state file. Reading it costs
 * nothing and cannot be rate-limited. Login stays as the fallback for a deployment
 * whose state file is elsewhere.
 *
 * Null rather than throwing: the bot's credentials are the deployment's, not the
 * suite's, and a run without them should clean up what it can and SAY the bot stayed.
 */
export async function botCredentials(homeserver, username, password, stateFile = '') {
  const validate = async (token) => {
    if (!token) return null;
    try {
      const res = await fetch(`${homeserver}/_matrix/client/v3/account/whoami`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return res.ok ? token : null;
    } catch {
      return null;
    }
  };

  if (stateFile && existsSync(stateFile)) {
    try {
      const stored = JSON.parse(readFileSync(stateFile, 'utf8'))?.botToken;
      const valid = await validate(stored);
      if (valid) return valid;
    } catch { /* fall through to login */ }
  }

  if (!username || !password) return null;
  try {
    return await withRateLimitRetry(async () => {
      const res = await fetch(`${homeserver}/_matrix/client/v3/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: username },
          password,
        }),
      });
      const body = await res.json();
      if (res.ok) return body.access_token;
      const err = new Error(`bot login: ${body.errcode}`);
      Object.assign(err, body);
      throw err;
    }, 'bot login');
  } catch {
    return null;
  }
}
