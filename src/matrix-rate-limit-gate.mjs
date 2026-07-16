// Shared Matrix rate-limit cooldown gate.
//
// The Matrix bridge has several independent request sources (agent-invite polling,
// bot-invite polling, joined-room scan, managed-room backfill, matrix-bot-sdk client
// calls) that used to back off individually. A 429 M_LIMIT_EXCEEDED seen by ONE of them
// said nothing to the others, so they kept hammering the homeserver — amplifying the
// very rate limit they were each trying to respect. This gate gives every request
// source one shared cooldown clock: any 429, from any path, blocks every other path
// until it clears.
const DEFAULT_BACKOFF_MS = 60_000;
const DEFAULT_MAX_BACKOFF_MS = 120_000;

async function extractRetryAfterMs(response) {
  if (!response) return undefined;
  if (typeof response.retryAfterMs === 'number') return response.retryAfterMs;
  if (typeof response.clone === 'function') {
    try {
      const body = await response.clone().json();
      return Number(body?.retry_after_ms);
    } catch {
      return undefined;
    }
  }
  if (typeof response.json === 'function') {
    try {
      const body = await response.json();
      return Number(body?.retry_after_ms);
    } catch {
      return undefined;
    }
  }
  if (response.body && typeof response.body === 'object') {
    return Number(response.body.retry_after_ms);
  }
  return undefined;
}

function isRateLimitError(error) {
  if (!error) return false;
  const statusCode = Number(error.statusCode);
  if (statusCode === 429) return true;
  const errcode = error.errcode || error?.body?.errcode;
  return errcode === 'M_LIMIT_EXCEEDED';
}

export class MatrixRateLimitGate {
  constructor({ now = Date.now, defaultBackoffMs = DEFAULT_BACKOFF_MS, maxBackoffMs = DEFAULT_MAX_BACKOFF_MS } = {}) {
    this._now = now;
    this._defaultBackoffMs = defaultBackoffMs;
    this._maxBackoffMs = maxBackoffMs;
    this._cooldownUntil = 0;
  }

  /** True while a shared cooldown is in effect. */
  isCoolingDown() {
    return this._now() < this._cooldownUntil;
  }

  /** Milliseconds remaining in the current cooldown (0 when none is active). */
  cooldownRemainingMs() {
    return Math.max(0, this._cooldownUntil - this._now());
  }

  /** Call before issuing any Matrix request. false => do not issue the request this round. */
  beforeRequest() {
    return !this.isCoolingDown();
  }

  /**
   * Feed a fetch()-style Response through the gate. Extends the shared cooldown when the
   * response is a 429, honoring `retry_after_ms` from the body when present.
   * Returns true iff this response was rate-limited.
   */
  async observeResponse(response) {
    if (!response || response.status !== 429) return false;
    const retryAfterMs = await extractRetryAfterMs(response);
    this._applyCooldown(retryAfterMs);
    return true;
  }

  /**
   * Feed a thrown error (e.g. a matrix-bot-sdk MatrixError) through the gate. Extends the
   * shared cooldown when the error represents M_LIMIT_EXCEEDED / HTTP 429.
   * Returns true iff this error was rate-limited.
   */
  observeError(error) {
    if (!isRateLimitError(error)) return false;
    const retryAfterMs = error.retryAfterMs ?? error?.body?.retry_after_ms;
    this._applyCooldown(retryAfterMs);
    return true;
  }

  /** Test/operator escape hatch: drop any active cooldown immediately. */
  reset() {
    this._cooldownUntil = 0;
  }

  _applyCooldown(retryAfterMsRaw) {
    const parsed = Number(retryAfterMsRaw);
    const waitMs = Number.isFinite(parsed) && parsed > 0
      ? Math.min(parsed, this._maxBackoffMs)
      : this._defaultBackoffMs;
    const candidateUntil = this._now() + waitMs;
    // Only ever extend the cooldown. A second, independently-observed 429 with a shorter
    // retry_after_ms must not shrink a longer wait already in effect (behavior 5's spirit:
    // nothing but the clock itself is allowed to clear/shorten an active cooldown).
    if (candidateUntil > this._cooldownUntil) {
      this._cooldownUntil = candidateUntil;
    }
    return waitMs;
  }
}

export function createMatrixRateLimitGate(options) {
  return new MatrixRateLimitGate(options);
}
