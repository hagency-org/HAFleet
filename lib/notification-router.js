// Centralized notification routing with per-family rate control, aggregation,
// circuit breaker, and unified pruning.

const PRUNE_INTERVAL_MS = 60_000;
const HARD_CAP_PER_FAMILY = 5000;
const MIN_MAX_AGE_MS = 300_000; // 5 minutes

export class NotificationRouter {
  /**
   * @param {Object} config  — { [familyName]: FamilyConfig }
   *   FamilyConfig: {
   *     cooldownMs: number,
   *     aggregateWindowMs?: number,
   *     maxBurst?: number,
   *     dedupeKeyFn?: (payload) => string,
   *     aggregateFn?: (buffer: Map<string,any>) => any,
   *     circuitBreaker?: { threshold: number, cooldownMs: number },
   *     persistedCooldown?: { read: (key) => number, write: (key, ts) => void },
   *     sinks?: string[],
   *   }
   * @param {Object} sinks — { [sinkName]: (family, payload, opts) => void|Promise }
   */
  constructor(config, sinks) {
    this._config = config;
    this._sinks = sinks;
    this._families = new Map();
    this._pruneTimer = setInterval(() => this._pruneStale(), PRUNE_INTERVAL_MS);
    if (this._pruneTimer.unref) this._pruneTimer.unref();
  }

  _getState(family) {
    let s = this._families.get(family);
    if (s) return s;
    const cfg = this._config[family];
    const hasAggregation = cfg?.aggregateFn && cfg?.aggregateWindowMs !== undefined && cfg.aggregateWindowMs >= 0;
    s = {
      lastEmitAt: new Map(),
      buffer: hasAggregation ? new Map() : null,
      flushTimer: null,
      burstCount: new Map(),
      cbFails: 0,
      cbOpenUntil: 0,
    };
    this._families.set(family, s);
    return s;
  }

  emit(family, payload, options = {}) {
    const cfg = this._config[family];
    if (!cfg) return { accepted: false, reason: 'unknown_family' };
    const state = this._getState(family);
    const now = Date.now();
    const key = cfg.dedupeKeyFn ? cfg.dedupeKeyFn(payload) : (options.dedupeKey || 'default');

    // Circuit breaker gate
    if (cfg.circuitBreaker && now < state.cbOpenUntil) {
      return { accepted: false, reason: 'circuit_open' };
    }

    if (!options.bypassCooldown) {
      // Persisted cooldown gate (used for agent_blocked per-agent cooldown)
      if (cfg.persistedCooldown && cfg.cooldownMs > 0) {
        const ts = cfg.persistedCooldown.read(key) || 0;
        if ((now - ts) < cfg.cooldownMs) {
          return { accepted: false, reason: 'persisted_cooldown' };
        }
      }

      // In-memory cooldown gate (skip if persistedCooldown handles it)
      if (!cfg.persistedCooldown && cfg.cooldownMs > 0) {
        const lastEmit = state.lastEmitAt.get(key) || 0;
        if ((now - lastEmit) < cfg.cooldownMs) {
          return { accepted: false, reason: 'cooldown' };
        }
      }
    }

    // Update timestamps
    state.lastEmitAt.set(key, now);
    if (cfg.persistedCooldown && !options.bypassCooldown) cfg.persistedCooldown.write(key, now);

    // Aggregation mode — buffer and schedule flush
    if (state.buffer !== null) {
      state.buffer.set(key, payload);
      const burst = (state.burstCount.get(key) || 0) + 1;
      state.burstCount.set(key, burst);
      if (cfg.maxBurst && burst >= cfg.maxBurst) {
        this.flush(family);
        return { accepted: true, reason: 'burst_flush' };
      }
      this._scheduleFlush(family, cfg, state);
      return { accepted: true, reason: 'buffered' };
    }

    // Immediate dispatch
    this._dispatch(family, cfg, payload, options);
    return { accepted: true, reason: 'dispatched' };
  }

  flush(family) {
    const cfg = this._config[family];
    const state = this._families.get(family);
    if (!state || !state.buffer || state.buffer.size === 0) return;
    if (state.flushTimer) { clearTimeout(state.flushTimer); state.flushTimer = null; }
    const entries = new Map(state.buffer);
    state.buffer.clear();
    state.burstCount.clear();
    const aggregated = cfg.aggregateFn
      ? cfg.aggregateFn(entries)
      : { entries: [...entries.values()] };
    if (aggregated) this._dispatch(family, cfg, aggregated, { aggregated: true });
  }

  clearAgent(agentName) {
    const prefix = `${agentName}:`;
    for (const state of this._families.values()) {
      for (const key of [...state.lastEmitAt.keys()]) {
        if (key === agentName || key.startsWith(prefix)) state.lastEmitAt.delete(key);
      }
      for (const key of [...state.burstCount.keys()]) {
        if (key === agentName || key.startsWith(prefix)) state.burstCount.delete(key);
      }
      if (state.buffer) {
        for (const key of [...state.buffer.keys()]) {
          if (key === agentName || key.startsWith(prefix)) state.buffer.delete(key);
        }
      }
    }
  }

  destroy() {
    if (this._pruneTimer) { clearInterval(this._pruneTimer); this._pruneTimer = null; }
    for (const family of this._families.keys()) this.flush(family);
    for (const state of this._families.values()) {
      if (state.flushTimer) { clearTimeout(state.flushTimer); state.flushTimer = null; }
    }
    this._families.clear();
  }

  // --- internal ---

  _scheduleFlush(family, cfg, state) {
    const ms = cfg.aggregateWindowMs || 0;
    if (ms <= 0) {
      // Synchronous flush for aggregateWindowMs=0
      this.flush(family);
      return;
    }
    if (state.flushTimer) return;
    state.flushTimer = setTimeout(() => {
      state.flushTimer = null;
      this.flush(family);
    }, ms);
    if (state.flushTimer.unref) state.flushTimer.unref();
  }

  _dispatch(family, cfg, payload, options = {}) {
    const sinkNames = cfg.sinks || Object.keys(this._sinks);
    for (const name of sinkNames) {
      const fn = this._sinks[name];
      if (!fn) continue;
      try {
        const result = fn(family, payload, options);
        // Track async result for circuit breaker
        if (cfg.circuitBreaker && result && typeof result.then === 'function') {
          const state = this._getState(family);
          result.then(() => {
            state.cbFails = 0;
          }).catch(() => {
            state.cbFails++;
            if (state.cbFails >= cfg.circuitBreaker.threshold) {
              state.cbOpenUntil = Date.now() + cfg.circuitBreaker.cooldownMs;
              state.cbFails = 0;
            }
          });
        }
      } catch (e) {
        console.error(`NotificationRouter sink '${name}' error: ${e.message}`);
      }
    }
  }

  _pruneStale() {
    const now = Date.now();
    for (const [familyName, state] of this._families) {
      const cfg = this._config[familyName] || {};
      const maxAge = Math.max(cfg.cooldownMs || 0, cfg.aggregateWindowMs || 0, MIN_MAX_AGE_MS);
      const cutoff = now - maxAge;

      // Prune expired entries
      for (const [key, ts] of state.lastEmitAt) {
        if (ts < cutoff) state.lastEmitAt.delete(key);
      }

      // Hard cap — evict oldest if over limit
      if (state.lastEmitAt.size > HARD_CAP_PER_FAMILY) {
        const sorted = [...state.lastEmitAt.entries()].sort((a, b) => a[1] - b[1]);
        const excess = sorted.length - HARD_CAP_PER_FAMILY;
        for (let i = 0; i < excess; i++) state.lastEmitAt.delete(sorted[i][0]);
      }
    }
  }
}
