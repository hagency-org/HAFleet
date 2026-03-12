import { afterEach, describe, expect, test, vi } from 'vitest';
import { AgentStateMachine, deriveStateFromLegacy, agentExpectsMcp } from '../lib/agent-state.js';

describe('AgentStateMachine', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // --- OFFLINE transitions ---
  test('OFFLINE → tmux_detected → STARTING', () => {
    const m = new AgentStateMachine('offline');
    expect(m.transition('tmux_detected')).toBe('starting');
    m.destroy();
  });

  test('OFFLINE → heartbeat_present → ONLINE', () => {
    const m = new AgentStateMachine('offline');
    expect(m.transition('heartbeat_present')).toBe('online');
    m.destroy();
  });

  test('OFFLINE → manual_down → MANUAL_DOWN', () => {
    const m = new AgentStateMachine('offline');
    expect(m.transition('manual_down')).toBe('manual_down');
    m.destroy();
  });

  // --- STARTING transitions ---
  test('STARTING → mcp_confirmed → ONLINE', () => {
    const m = new AgentStateMachine('starting');
    expect(m.transition('mcp_confirmed')).toBe('online');
    m.destroy();
  });

  test('STARTING → mcp_not_applicable → ONLINE', () => {
    const m = new AgentStateMachine('starting');
    expect(m.transition('mcp_not_applicable')).toBe('online');
    m.destroy();
  });

  test('STARTING → grace_timer_expired → DEGRADED', () => {
    const m = new AgentStateMachine('starting');
    expect(m.transition('grace_timer_expired')).toBe('degraded');
    m.destroy();
  });

  test('STARTING → tmux_missing → OFFLINE', () => {
    const m = new AgentStateMachine('starting');
    expect(m.transition('tmux_missing')).toBe('offline');
    m.destroy();
  });

  test('STARTING → manual_down → MANUAL_DOWN', () => {
    const m = new AgentStateMachine('starting');
    expect(m.transition('manual_down')).toBe('manual_down');
    m.destroy();
  });

  test('STARTING → heartbeat_present → ONLINE', () => {
    const m = new AgentStateMachine('starting');
    expect(m.transition('heartbeat_present')).toBe('online');
    m.destroy();
  });

  // --- ONLINE transitions ---
  test('ONLINE → mcp_missing_debounced → DEGRADED', () => {
    const m = new AgentStateMachine('online');
    expect(m.transition('mcp_missing_debounced')).toBe('degraded');
    m.destroy();
  });

  test('ONLINE → tmux_missing → OFFLINE', () => {
    const m = new AgentStateMachine('online');
    expect(m.transition('tmux_missing')).toBe('offline');
    m.destroy();
  });

  test('ONLINE → manual_down → MANUAL_DOWN', () => {
    const m = new AgentStateMachine('online');
    expect(m.transition('manual_down')).toBe('manual_down');
    m.destroy();
  });

  test('ONLINE → heartbeat_missing → OFFLINE', () => {
    const m = new AgentStateMachine('online');
    expect(m.transition('heartbeat_missing')).toBe('offline');
    m.destroy();
  });

  test('ONLINE → server_offline → OFFLINE', () => {
    const m = new AgentStateMachine('online');
    expect(m.transition('server_offline')).toBe('offline');
    m.destroy();
  });

  test('ONLINE → mcp_confirmed stays ONLINE', () => {
    const m = new AgentStateMachine('online');
    expect(m.transition('mcp_confirmed')).toBe('online');
    m.destroy();
  });

  test('ONLINE → heartbeat_present stays ONLINE', () => {
    const m = new AgentStateMachine('online');
    expect(m.transition('heartbeat_present')).toBe('online');
    m.destroy();
  });

  // --- DEGRADED transitions ---
  test('DEGRADED → mcp_confirmed → ONLINE', () => {
    const m = new AgentStateMachine('degraded');
    expect(m.transition('mcp_confirmed')).toBe('online');
    m.destroy();
  });

  test('DEGRADED → tmux_missing → OFFLINE', () => {
    const m = new AgentStateMachine('degraded');
    expect(m.transition('tmux_missing')).toBe('offline');
    m.destroy();
  });

  test('DEGRADED → manual_down → MANUAL_DOWN', () => {
    const m = new AgentStateMachine('degraded');
    expect(m.transition('manual_down')).toBe('manual_down');
    m.destroy();
  });

  test('DEGRADED → heartbeat_missing → OFFLINE', () => {
    const m = new AgentStateMachine('degraded');
    expect(m.transition('heartbeat_missing')).toBe('offline');
    m.destroy();
  });

  test('DEGRADED → server_offline → OFFLINE', () => {
    const m = new AgentStateMachine('degraded');
    expect(m.transition('server_offline')).toBe('offline');
    m.destroy();
  });

  // --- MANUAL_DOWN transitions ---
  test('MANUAL_DOWN → manual_up → OFFLINE', () => {
    const m = new AgentStateMachine('manual_down');
    expect(m.transition('manual_up')).toBe('offline');
    m.destroy();
  });

  test('MANUAL_DOWN → api_unregister → OFFLINE', () => {
    const m = new AgentStateMachine('manual_down');
    expect(m.transition('api_unregister')).toBe('offline');
    m.destroy();
  });

  test('MANUAL_DOWN → api_register_with_tmux → STARTING', () => {
    const m = new AgentStateMachine('manual_down');
    expect(m.transition('api_register_with_tmux')).toBe('starting');
    m.destroy();
  });

  // --- api_unregister from all states ---
  test('api_unregister → OFFLINE from every state', () => {
    for (const initial of ['offline', 'starting', 'online', 'degraded', 'manual_down']) {
      const m = new AgentStateMachine(initial);
      expect(m.transition('api_unregister')).toBe('offline');
      m.destroy();
    }
  });

  // --- api_register_with_tmux ---
  test('api_register_with_tmux from OFFLINE → STARTING', () => {
    const m = new AgentStateMachine('offline');
    expect(m.transition('api_register_with_tmux')).toBe('starting');
    m.destroy();
  });

  test('api_register_with_tmux from ONLINE stays ONLINE', () => {
    const m = new AgentStateMachine('online');
    expect(m.transition('api_register_with_tmux')).toBe('online');
    m.destroy();
  });

  test('api_register_with_tmux from DEGRADED stays DEGRADED', () => {
    const m = new AgentStateMachine('degraded');
    expect(m.transition('api_register_with_tmux')).toBe('degraded');
    m.destroy();
  });

  // --- Invalid / no-op transitions ---
  test('invalid transitions return current state', () => {
    const m = new AgentStateMachine('offline');
    expect(m.transition('mcp_confirmed')).toBe('offline');
    expect(m.transition('manual_up')).toBe('offline');
    m.destroy();
  });

  test('unknown events are no-ops', () => {
    const m = new AgentStateMachine('online');
    expect(m.transition('nonexistent_event')).toBe('online');
    m.destroy();
  });

  // --- Legacy compat getters ---
  test('legacy compat getters reflect state correctly', () => {
    const m = new AgentStateMachine('offline');
    expect(m.online).toBe(false);
    expect(m.healthy).toBe(false);
    expect(m.manualDown).toBe(false);
    expect(m.isStarting).toBe(false);
    expect(m.isDegraded).toBe(false);

    m.transition('tmux_detected');
    expect(m.online).toBe(true);
    expect(m.healthy).toBe(false);
    expect(m.isStarting).toBe(true);

    m.transition('mcp_confirmed');
    expect(m.online).toBe(true);
    expect(m.healthy).toBe(true);
    expect(m.isStarting).toBe(false);

    m.transition('mcp_missing_debounced');
    expect(m.online).toBe(true);
    expect(m.healthy).toBe(false);
    expect(m.isDegraded).toBe(true);

    m.transition('manual_down');
    expect(m.online).toBe(false);
    expect(m.healthy).toBe(false);
    expect(m.manualDown).toBe(true);
    m.destroy();
  });

  // --- Grace timer ---
  test('grace timer fires after 30s in STARTING state', () => {
    vi.useFakeTimers();
    const m = new AgentStateMachine('offline');
    const callback = vi.fn();
    m.onGraceExpired(callback);

    m.transition('tmux_detected');
    expect(m.state).toBe('starting');

    vi.advanceTimersByTime(29_999);
    expect(m.state).toBe('starting');
    expect(callback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(m.state).toBe('degraded');
    expect(callback).toHaveBeenCalledTimes(1);
    m.destroy();
  });

  test('grace timer is cleared when leaving STARTING', () => {
    vi.useFakeTimers();
    const m = new AgentStateMachine('offline');
    const callback = vi.fn();
    m.onGraceExpired(callback);

    m.transition('tmux_detected');
    m.transition('mcp_confirmed');

    vi.advanceTimersByTime(60_000);
    expect(m.state).toBe('online');
    expect(callback).not.toHaveBeenCalled();
    m.destroy();
  });

  test('destroy clears the grace timer', () => {
    vi.useFakeTimers();
    const m = new AgentStateMachine('offline');
    const callback = vi.fn();
    m.onGraceExpired(callback);

    m.transition('tmux_detected');
    m.destroy();

    vi.advanceTimersByTime(60_000);
    expect(callback).not.toHaveBeenCalled();
  });

  // --- Constructor ---
  test('constructor defaults to offline for invalid state', () => {
    const m = new AgentStateMachine('invalid');
    expect(m.state).toBe('offline');
    m.destroy();
  });
});

describe('deriveStateFromLegacy', () => {
  test('null agent → offline', () => {
    expect(deriveStateFromLegacy(null, null)).toBe('offline');
  });

  test('manualDown → manual_down', () => {
    expect(deriveStateFromLegacy({ manualDown: true }, null)).toBe('manual_down');
  });

  test('no tmux + not online → offline', () => {
    expect(deriveStateFromLegacy({ online: false, tmux: null }, null)).toBe('offline');
  });

  test('online + mcpPresent=false → degraded', () => {
    expect(deriveStateFromLegacy({ online: true, tmux: 'a:0.0' }, { mcpPresent: false })).toBe('degraded');
  });

  test('online + mcpPresent=true → online', () => {
    expect(deriveStateFromLegacy({ online: true, tmux: 'a:0.0' }, { mcpPresent: true })).toBe('online');
  });

  test('online + no runtime → online', () => {
    expect(deriveStateFromLegacy({ online: true, tmux: 'a:0.0' }, null)).toBe('online');
  });

  test('tmux present but not online + mcpPresent=false → degraded', () => {
    expect(deriveStateFromLegacy({ online: false, tmux: 'a:0.0' }, { mcpPresent: false })).toBe('degraded');
  });
});

describe('agentExpectsMcp', () => {
  test('null → true (default safe)', () => {
    expect(agentExpectsMcp(null)).toBe(true);
  });

  test('codex type → false', () => {
    expect(agentExpectsMcp({ type: 'codex' })).toBe(false);
  });

  test('agent without agentModelVersion → false', () => {
    expect(agentExpectsMcp({ type: 'agent', agentModelVersion: null })).toBe(false);
  });

  test('agent with agentModelVersion → true', () => {
    expect(agentExpectsMcp({ type: 'agent', agentModelVersion: '1.0' })).toBe(true);
  });

  test('human type → true', () => {
    expect(agentExpectsMcp({ type: 'human' })).toBe(true);
  });
});
