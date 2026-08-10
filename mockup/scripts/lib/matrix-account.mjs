/*
 * A throwaway Matrix account for a test run.
 *
 * WHY THE SUITES MUST NOT USE THE OPERATOR'S ACCOUNT. The full-loop suite originally
 * logged in as the human's own user, because an earlier version tried to observe the
 * human's GUI client and needed to share its account. That claim was dropped as
 * unverifiable, but the shared login stayed — and it littered a real person's Matrix
 * client with a `loop/…` room per run. Each teardown then left and forgot the room,
 * so the client was left holding rooms its account was no longer in and threw
 * `M_FORBIDDEN: you aren't member of the room` when it tried to backfill them.
 *
 * A test that leaves debris in the operator's own client is not isolated, however
 * green it reports. Each run gets its own account, so there is nothing to clean up
 * in anyone's client and no run can inherit another's rooms.
 */

import { withRateLimitRetry } from './matrix-rate-limit.mjs';

/**
 * Register a fresh account and return the server's response.
 *
 * The username carries a random suffix: fixed names failed the second run with
 * M_USER_IN_USE and, worse, inherited whatever rooms the previous run left behind.
 */
export async function registerThrowaway(hs, regToken, prefix = 'e2e') {
  if (!regToken) {
    throw new Error('registration token required — set MATRIX_TOKEN (it is not stored in this repo)');
  }
  const username = `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  return withRateLimitRetry(async () => {
    const res = await fetch(`${hs}/_matrix/client/v3/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        password: `pw-${username}`,
        auth: { type: 'm.login.registration_token', token: regToken },
      }),
    });
    const body = await res.json();
    if (res.ok) return body;
    // errcode attached so the shared helper retries only the rate-limit case and
    // rethrows everything else untouched.
    const err = new Error(`register ${username}: ${body.errcode} ${body.error}`);
    Object.assign(err, body);
    throw err;
  }, `register ${username}`);
}
