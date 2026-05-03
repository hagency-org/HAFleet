// Agent lifecycle state machine
// States: offline, starting, online, degraded, manual_down

export const STATES = Object.freeze({
  OFFLINE: 'offline',
  STARTING: 'starting',
  ONLINE: 'online',
  DEGRADED: 'degraded',
  MANUAL_DOWN: 'manual_down',
});

const VALID_STATES = new Set(Object.values(STATES));

const GRACE_TIMEOUT_MS = 30_000;

// Transition table: state → event → nextState
const TRANSITIONS = {
  offline: {
    tmux_detected: 'starting',
    heartbeat_present: 'online',
    api_register_with_tmux: 'starting',
    manual_down: 'manual_down',
    api_unregister: 'offline',
  },
  starting: {
    mcp_confirmed: 'online',
    mcp_not_applicable: 'online',
    grace_timer_expired: 'degraded',
    tmux_missing: 'offline',
    manual_down: 'manual_down',
    heartbeat_present: 'online',
    api_unregister: 'offline',
    api_register_with_tmux: 'starting',
  },
  online: {
    mcp_missing_debounced: 'degraded',
    tmux_missing: 'offline',
    manual_down: 'manual_down',
    heartbeat_missing: 'offline',
    server_offline: 'offline',
    mcp_confirmed: 'online',
    heartbeat_present: 'online',
    api_unregister: 'offline',
    api_register_with_tmux: 'online',
  },
  degraded: {
    mcp_confirmed: 'online',
    tmux_missing: 'offline',
    manual_down: 'manual_down',
    heartbeat_missing: 'offline',
    server_offline: 'offline',
    api_unregister: 'offline',
    api_register_with_tmux: 'degraded',
  },
  manual_down: {
    manual_up: 'offline',
    api_unregister: 'offline',
    api_register_with_tmux: 'starting',
  },
};

export class AgentStateMachine {
  constructor(initialState = 'offline') {
    this._state = VALID_STATES.has(initialState) ? initialState : 'offline';
    this._graceTimer = null;
    this._graceDeadlineAt = null;
    this._onGraceExpired = null;
  }

  get state() { return this._state; }
  get online() { return this._state !== 'offline' && this._state !== 'manual_down'; }
  get healthy() { return this._state === 'online'; }
  get manualDown() { return this._state === 'manual_down'; }
  get isStarting() { return this._state === 'starting'; }
  get isDegraded() { return this._state === 'degraded'; }

  transition(event) {
    const table = TRANSITIONS[this._state];
    if (!table) return this._state;
    const next = table[event];
    if (next === undefined) return this._state;

    const prev = this._state;
    this._state = next;

    if (next === 'starting' && prev !== 'starting') {
      this._startGraceTimer();
    } else if (next !== 'starting') {
      this._clearGraceTimer();
    }

    return this._state;
  }

  onGraceExpired(callback) {
    this._onGraceExpired = callback;
  }

  snapshot() {
    return {
      state: this._state,
      graceRemainingMs: this._graceDeadlineAt === null
        ? null
        : Math.max(0, this._graceDeadlineAt - Date.now()),
    };
  }

  restore(snapshot = {}) {
    this._state = VALID_STATES.has(snapshot?.state) ? snapshot.state : 'offline';
    this._clearGraceTimer();
    if (this._state === 'starting' && Number.isFinite(snapshot?.graceRemainingMs)) {
      this._startGraceTimer(snapshot.graceRemainingMs);
    }
    return this._state;
  }

  _startGraceTimer(timeoutMs = GRACE_TIMEOUT_MS) {
    this._clearGraceTimer();
    const delayMs = Math.max(0, Number(timeoutMs) || 0);
    this._graceDeadlineAt = Date.now() + delayMs;
    this._graceTimer = setTimeout(() => {
      this._graceTimer = null;
      this._graceDeadlineAt = null;
      if (this._state === 'starting') {
        this._state = 'degraded';
        if (this._onGraceExpired) this._onGraceExpired();
      }
    }, delayMs);
    if (this._graceTimer.unref) this._graceTimer.unref();
  }

  _clearGraceTimer() {
    if (this._graceTimer) {
      clearTimeout(this._graceTimer);
      this._graceTimer = null;
    }
    this._graceDeadlineAt = null;
  }

  destroy() {
    this._clearGraceTimer();
  }
}

export function deriveStateFromLegacy(agent, runtime) {
  if (!agent) return 'offline';
  if (agent.manualDown) return 'manual_down';
  if (!agent.tmux && !agent.online) return 'offline';
  if (runtime?.mcpPresent === false) return 'degraded';
  if (agent.online) return 'online';
  return 'offline';
}

export function agentExpectsMcp(agent) {
  if (!agent) return true;
  if (agent.type === 'codex') return false;
  if (agent.type === 'agent' && !agent.agentModelVersion) return false;
  return true;
}
