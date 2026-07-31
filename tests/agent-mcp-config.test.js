import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';

const source = readFileSync('bin/hafleet-up', 'utf-8');

// Observed on mini5: an agent created by plain `hafleet up` launched, went
// online, received its bootstrap prompt and ran — then every API call it made
// was rejected with
//   [auth] agent-token token required but not provided: agent=... mode=hard
// 199 times, and its inbox never drained. Nothing in the agent's own pane said
// why. The cause was .mcp.json omitting HAFLEET_AGENT_STATE_DIR, because the
// generator treated an empty SAVED_STATE_DIR as "leave the key out" while the
// token preflight 400 lines away already knew the default path.

describe('the agent state directory is derived once', () => {
  test('a single helper owns the derivation', () => {
    expect(source).toContain('resolve_agent_state_dir() {');
    const definitions = source.match(/resolve_agent_state_dir\(\) \{/g) || [];
    expect(definitions).toHaveLength(1);
  });

  test('the fallback is the default agent home, not empty', () => {
    const fn = source.slice(source.indexOf('resolve_agent_state_dir() {'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain('SAVED_STATE_DIR:-');
    expect(body).toContain('HAFLEET_HOMEDIR:-$HOME/.hafleet');
    expect(body).toContain('agents/agent_${NAME}/state');
  });

  test('every consumer uses the helper rather than its own copy', () => {
    // Three call sites: the Claude .mcp.json, the Codex -c injection, and the
    // token preflight. If any keeps its own expression they can disagree about
    // where the token is, which is exactly how this broke.
    const calls = source.match(/\$\(resolve_agent_state_dir\)/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    // No lingering bare `${SAVED_STATE_DIR:-}` guard around the state dir env.
    expect(source).not.toMatch(/if \[ -n "\$\{SAVED_STATE_DIR:-\}" \]; then\s*\n\s*codex_mcp_env HAFLEET_AGENT_STATE_DIR/);
  });
});

describe('the generated .mcp.json is complete', () => {
  const generator = (() => {
    const start = source.indexOf('ensure_agent_mcp_config() {');
    return source.slice(start, source.indexOf('\n}', start));
  })();

  test('it always sets HAFLEET_AGENT_STATE_DIR', () => {
    expect(generator).toContain('HAFLEET_AGENT_STATE_DIR');
    expect(generator).toContain('resolve_agent_state_dir');
  });

  test.each([
    'AGENT_NAME',
    'HAFLEET_API',
    'HAFLEET_BACKEND_PORT',
    'HAFLEET_MCP_SERVER_NAME',
    'HAFLEET_AGENT_STATE_DIR',
    'HAFLEET_RUNTIME_DIR',
  ])('%s reaches the MCP server env', (key) => {
    expect(generator).toContain(key);
  });

  test('the state dir is not dropped by the empty-value filter', () => {
    // The generator strips empty values. That is fine now the helper always
    // returns a path, but if the helper ever returns "" the key silently
    // disappears again and the failure is invisible to the agent.
    expect(generator).toContain('if v');
    const fn = source.slice(source.indexOf('resolve_agent_state_dir() {'));
    expect(fn.slice(0, fn.indexOf('\n}'))).toMatch(/printf '%s'/);
  });
});

describe('the Codex path gets the same treatment', () => {
  test('HAFLEET_AGENT_STATE_DIR is injected unconditionally', () => {
    // Codex strips ambient env, so it needs the value passed through -c. It was
    // guarded on SAVED_STATE_DIR being non-empty, so plain `hafleet up` codex
    // agents had the identical silent-auth-failure bug.
    expect(source).toMatch(/codex_mcp_env HAFLEET_AGENT_STATE_DIR "\$\(resolve_agent_state_dir\)"/);
  });
});
