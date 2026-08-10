/*
 * Retry a Matrix request that the homeserver rate-limited.
 *
 * WHY THIS IS SHARED. Both E2E suites hit M_LIMIT_EXCEEDED, and each learned it the
 * same painful way: the suite worked once and failed on the second run in a row.
 * e2e-matrix.mjs grew a retry inside register(); e2e-full-loop.mjs had none, so a
 * rate-limited createRoom became an unhandled rejection — a run that printed no
 * summary at all and therefore looked like nothing rather than like a failure. One
 * implementation for both, same reason lib/derive.js is a factory over two sources.
 *
 * The wait comes from the server's own `retry_after_ms`. A fixed sleep guessed from
 * one observation is how a harness ends up passing on the machine it was written on.
 */

/** True if this error is the homeserver asking us to slow down. */
function rateLimited(err) {
  if (err?.errcode === 'M_LIMIT_EXCEEDED') return true;
  // matrix-bot-sdk wraps the response body rather than exposing errcode directly.
  return err?.body?.errcode === 'M_LIMIT_EXCEEDED';
}

/** How long the server asked us to wait, in ms, or null if it did not say. */
function retryAfterMs(err) {
  const ms = err?.retry_after_ms ?? err?.body?.retry_after_ms;
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Run `fn`, retrying only while the server is rate-limiting.
 *
 * Any other error is rethrown immediately and untouched: swallowing those is how a
 * broken homeserver turns into a timeout six steps later, in a place that has
 * nothing to do with the cause.
 */
export async function withRateLimitRetry(fn, label, { attempts = 6, capMs = 20_000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!rateLimited(err) || attempt === attempts) throw err;
      const waitMs = Math.min((retryAfterMs(err) ?? attempt * 2000) + 250, capMs);
      console.log(`  ..    ${label} rate-limited, waiting ${waitMs}ms (attempt ${attempt}/${attempts})`);
      await new Promise((r) => { setTimeout(r, waitMs); });
    }
  }
  throw new Error(`${label}: gave up after rate limiting`);
}
