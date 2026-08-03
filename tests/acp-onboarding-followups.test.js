import { describe, expect, test } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';

import { frameworkIds, getFramework } from '../lib/frameworks/index.js';

// The three remaining items from the onboarding review: readiness was a stopwatch,
// `hafleet ls` could not distinguish transports, and onboarding was undocumented.

describe('readiness is a signal, not a stopwatch', () => {
  const source = readFileSync('bin/hafleet-acp-up', 'utf-8');

  test('the fixed sleep is gone', () => {
    // `sleep 6` then a liveness check: an agent needing longer looked broken, and
    // one that died at t=7s looked healthy. hermes spends ~10s loading plugins.
    expect(source).not.toMatch(/^sleep 6$/m);
  });

  test('it waits for the marker the host actually prints', () => {
    const marker = source.match(/READY_MARKER="([^"]+)"/);
    expect(marker, 'no readiness marker declared').toBeTruthy();
    // Derived from the host rather than hardcoded here, so the two cannot drift.
    const host = readFileSync('scripts/hafleet-acp-agent.mjs', 'utf-8');
    expect(host, `the host never logs "${marker[1]}"`).toContain(marker[1]);
  });

  test('an agent that dies before readiness is reported differently from one that hangs', () => {
    expect(source).toMatch(/exited before it was ready/);
    expect(source).toMatch(/never registered with the backend within 45s/);
  });

  test('a hung start is killed rather than left running', () => {
    // Leaving it would give the agent a host that acp-up already disowned.
    const block = source.slice(source.indexOf('if [ "$READY" != true ]'));
    expect(block.slice(0, block.indexOf('exit 1'))).toMatch(/kill "\$AGENT_PID"/);
  });

  test('the log is shown on either failure', () => {
    const block = source.slice(source.indexOf('if [ "$READY" != true ]'));
    expect(block.slice(0, block.indexOf('exit 1'))).toMatch(/tail -8/);
  });
});

describe('hafleet ls distinguishes the transports', () => {
  const source = readFileSync('bin/hafleet-ls', 'utf-8');

  test('a TRANS column is rendered', () => {
    expect(source).toMatch(/"TRANS"/);
    expect(source).toMatch(/\$transport/);
  });

  test('the value comes from the backend, not guessed from the name', () => {
    expect(source).toMatch(/item\.get\("transport"\)/);
  });

  test('every colour variant of the row prints it', () => {
    // Three coloured printf branches plus a plain one; missing one would drop the
    // column for exactly the agents in that state.
    const rows = [...source.matchAll(/printf "(\\033\[[0-9;]*m)?%-20s [^"]*"/g)];
    const withTransport = rows.filter((m) => m[0].includes('%-5s'));
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(withTransport.length).toBe(rows.length);
  });

  test('an agent the backend does not know shows "-" rather than blank', () => {
    expect(source).toMatch(/transport="-"/);
  });

  test('an online ACP agent is not reported as down', () => {
    // The tmux scan cannot see a paneless agent, so every ACP agent fell through to
    // "down". Verified live: octos-agent and codex-acp-agent both read "down" while
    // healthy and answering messages. For a paneless agent the backend's liveness is
    // the only source, so it is carried through the map file alongside transport.
    expect(source).toMatch(/item\.get\("online"\)/);
    expect(source).toMatch(/\[ "\$_reg_transport" = "acp" \] && \[ "\$_reg_online" = "1" \]/);
  });

  test('an offline ACP agent is still reported as down', () => {
    // The fix must not make every registered ACP agent look alive. hermes-agent is
    // registered and not running, and must keep reading "down".
    const branch = source.slice(source.indexOf('_reg_transport='));
    expect(branch.slice(0, branch.indexOf('\n      fi'))).toMatch(/echo "\$reg_name down"/);
  });

  test('MCP is detected for a paneless agent, and only when the pid is alive', () => {
    // Same root cause: MCP detection maps a process to a tmux session by tty, so it
    // said "no" for agents whose MCP had just served a check_inbox call. The state
    // dir pid file is the signal — checked for liveness, because a stale file from a
    // crash would otherwise report MCP that is not running.
    expect(source).toMatch(/mcp-server\.pid/);
    const block = source.slice(source.indexOf('if [ "$transport" = "acp" ]; then'));
    expect(block.slice(0, block.indexOf('\n  fi'))).toMatch(/kill -0 "\$_mcp_pid"/);
  });
});

describe('onboarding is documented', () => {
  const doc = readFileSync('docs/agent-onboarding.md', 'utf-8');

  test('it names both launchers and the removal command', () => {
    for (const command of ['hafleet up', 'hafleet acp-up', 'hafleet acp-down']) {
      expect(doc, `${command} is not documented`).toContain(command);
    }
  });

  test('every declared framework appears with its transport', () => {
    // A new adapter that nobody documents is how the next operator gets stuck.
    for (const id of frameworkIds()) {
      expect(doc, `${id} is missing from the onboarding doc`).toContain(`\`${id}\``);
    }
  });

  test('the transport it claims for each framework is the one the registry declares', () => {
    // Parse the transport CELL, not the row. Asserting row.toContain('acp') passed
    // even with the cell changed to tmux, because the same row says
    // "hafleet acp-up" — a vacuous check that a mutation test exposed.
    for (const id of frameworkIds()) {
      const expected = getFramework(id).transport;
      const row = doc.split('\n').find((line) => line.trim().startsWith(`| \`${id}\``));
      expect(row, `${id} has no table row`).toBeTruthy();
      const cells = row.split('|').map((c) => c.trim()).filter(Boolean);
      // | framework | transport | start it with |
      expect(cells[1], `${id} is documented as "${cells[1]}" but the registry says "${expected}"`)
        .toBe(expected);
    }
  });

  test('it documents the model-flag trap', () => {
    expect(doc).toContain('acpModelFlag');
    expect(doc).toMatch(/silently ignores it|silently ignore/);
  });

  test('it is discoverable, not merely present', () => {
    // A doc nothing links to is a doc nobody reads — onboarding went undocumented
    // for as long as it did partly because there was nowhere it would have been
    // found. Tracked AND linked from the README.
    const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf-8' }).split('\n');
    expect(tracked, 'the doc is untracked').toContain('docs/agent-onboarding.md');
    expect(readFileSync('README.md', 'utf-8'), 'the README does not link it')
      .toContain('docs/agent-onboarding.md');
  });
});
