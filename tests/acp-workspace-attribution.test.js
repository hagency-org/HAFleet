/*
 * An ACP agent must report the workspace it was launched in.
 *
 * WHY THIS IS LOAD-BEARING RATHER THAN COSMETIC. The coding CLIs meter themselves —
 * Claude Code writes a per-message `usage` object under
 * `~/.claude/projects/<slugified-cwd>/`, Codex writes `total_token_usage` beside a
 * `session_meta.cwd` — and the working directory is the only thing that ties either
 * record back to an agent. Without it, consumption can be read but not attributed, so
 * ADR-013's contract 1 has nothing to hang on.
 *
 * HAFleet launched the agent knowing that directory and discarded it: `workspacePath`
 * was null on every ACP agent. A tmux agent already reports it through the MCP server
 * (lib/mcp-server-core.js:274); an ACP agent has no such path, because octos ignores
 * `mcpServers` on session/new in v1, so the host must report it directly.
 *
 * Found by trying to design metering against a live agent and discovering the key was
 * absent — not by any test, because nothing asserted the field was ever populated.
 */

import { afterEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const WORKSPACE = '/Users/someone/work/payments-api';

describe('ACP agent workspace attribution', () => {
  let ctx;
  afterEach(async () => { await ctx?.cleanup?.(); ctx = null; });

  const seed = {
    agents: {
      'octos-01': {
        name: 'octos-01', type: 'octos', transport: 'acp', server: 'local',
        acpPid: process.pid, tmux: null, online: false, manualDown: false,
      },
    },
  };

  test('a reported workspace is stored and served back', async () => {
    ctx = await createBackendTestContext('acp-ws-', seed);
    const posted = await request(ctx.app)
      .post('/api/agents/octos-01/runtime')
      .send({ transport: 'acp', workspacePath: WORKSPACE });
    expect(posted.status).toBe(200);

    const res = await request(ctx.app).get('/api/agents');
    const agent = res.body.find((a) => a.name === 'octos-01');
    // The defect: this was null for every ACP agent, so nothing could attribute usage.
    expect(agent.workspacePath).toBe(WORKSPACE);
  });

  test('a runtime report without a workspace does not erase a known one', async () => {
    /*
     * The host posts runtime status on a heartbeat cadence. If an unrelated report
     * cleared the field, attribution would work only until the next heartbeat — which
     * is the kind of intermittency that reads as a metering bug rather than a
     * bookkeeping one.
     */
    ctx = await createBackendTestContext('acp-ws-keep-', seed);
    await request(ctx.app).post('/api/agents/octos-01/runtime')
      .send({ transport: 'acp', workspacePath: WORKSPACE });
    await request(ctx.app).post('/api/agents/octos-01/runtime')
      .send({ transport: 'acp', activeNow: false });

    const res = await request(ctx.app).get('/api/agents');
    expect(res.body.find((a) => a.name === 'octos-01').workspacePath).toBe(WORKSPACE);
  });

  test('the workspace is REMEMBERED after the sweep clears it', async () => {
    /*
     * Two fields, two questions, and conflating them made a stopped agent unmeterable.
     *
     * `workspacePath` answers "where is it running now", and the activity sweep clears it
     * when an agent has no pane — correctly, a stopped agent runs nowhere. But transcripts
     * stay on disk, and an agent that worked this month and then stopped still spent
     * against its ceiling. Reading only the live field reported it as having consumed
     * nothing, which is an answer rather than an absence.
     *
     * Verified live before this test existed: two sweep cycles cleared `workspacePath`
     * while `lastWorkspacePath` survived.
     */
    ctx = await createBackendTestContext('acp-ws-remember-', seed);
    await request(ctx.app).post('/api/agents/octos-01/runtime')
      .send({ transport: 'acp', workspacePath: WORKSPACE });

    // What the sweep does to an agent with no pane.
    await request(ctx.app).post('/api/agents/octos-01/runtime')
      .send({ transport: 'acp', workspacePath: null });

    const res = await request(ctx.app).get('/api/agents');
    const agent = res.body.find((a) => a.name === 'octos-01');
    expect(agent.workspacePath ?? null).toBeNull();
    expect(agent.lastWorkspacePath).toBe(WORKSPACE);
  });

  test('an agent that has never reported one has null, not a guess', async () => {
    // Attribution must fail closed. A guessed workspace would attribute one agent's
    // tokens to another, which is worse than reporting the consumption as unattributable.
    ctx = await createBackendTestContext('acp-ws-none-', seed);
    const res = await request(ctx.app).get('/api/agents');
    const agent = res.body.find((a) => a.name === 'octos-01');
    expect(agent.workspacePath ?? null).toBeNull();
    // And nothing is remembered either, so metering cannot fall back to a guess.
    expect(agent.lastWorkspacePath ?? null).toBeNull();
  });
});
