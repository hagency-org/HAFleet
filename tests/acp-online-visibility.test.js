/*
 * A running ACP agent must report online through the API, not only on disk.
 *
 * `syncAcpAgentLiveness` set `agent.online` on the persisted record, and
 * `serializeAgent` does not read that field — it reads `getAgentMachine(name)`, which
 * the tmux sweep keeps current through `syncAgentMachine`. The ACP path never called
 * it. So a launched, registered, bound octos agent had `online: true` in
 * agents.json and `online: false` over the API, indefinitely.
 *
 * Found by launching one on a clean host: the process was alive, the ACP session was
 * open, the log said "registered with the backend", and the console showed it
 * offline. Two sources of truth, one of them the only one anybody looks at.
 *
 * The tests use the CURRENT process id as the "running agent", because that is a pid
 * guaranteed to be alive while the test runs — inventing one risks colliding with a
 * real process and passing for the wrong reason.
 */

import { afterEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

/** An ACP agent record whose recorded pid is alive (or not). */
function acpAgent({ pid, name = 'octos-01' }) {
  return {
    agents: {
      [name]: {
        name,
        type: 'octos',
        transport: 'acp',
        server: 'local',
        acpPid: pid,
        tmux: null,
        online: false,
        manualDown: false,
        lastSeen: Date.now(),
      },
    },
  };
}

/** A pid that is certainly not running: allocate high and verify it is free. */
function deadPid() {
  for (let candidate = 999_001; candidate < 999_400; candidate += 1) {
    try { process.kill(candidate, 0); } catch (e) {
      if (e.code === 'ESRCH') return candidate;
    }
  }
  throw new Error('no free pid found for the dead-agent case');
}

describe('ACP agent liveness is visible through the API', () => {
  let ctx;
  afterEach(async () => { await ctx?.cleanup?.(); ctx = null; });

  test('a live process makes the agent online over the API', async () => {
    ctx = await createBackendTestContext('acp-online-', acpAgent({ pid: process.pid }));
    // The sweep reconciles liveness; run it directly rather than waiting on a timer.
    await ctx.internals.sweepLocalActivityDurationsForTest();

    const res = await request(ctx.app).get('/api/agents');
    expect(res.status).toBe(200);
    const agent = res.body.find((a) => a.name === 'octos-01');
    // The defect: this was false while agents.json said true.
    expect(agent.online).toBe(true);
    expect(agent.offlineReason ?? null).toBeNull();
  });

  test('a dead process makes it offline, with a reason that names the cause', async () => {
    ctx = await createBackendTestContext('acp-offline-', acpAgent({ pid: deadPid() }));
    await ctx.internals.sweepLocalActivityDurationsForTest();

    const res = await request(ctx.app).get('/api/agents');
    const agent = res.body.find((a) => a.name === 'octos-01');
    expect(agent.online).toBe(false);
    // Not merely "offline": an ACP agent has no pane, so a tmux reason would send
    // the operator looking for a session that never existed.
    expect(agent.offlineReason).toBe('acp-process-gone');
  });

  test('the API and the persisted record agree, which is the invariant', async () => {
    /*
     * The specific bug was these two disagreeing. Asserting the agreement rather than
     * only the value means a future change that fixes one and not the other fails
     * here, whichever side it breaks.
     */
    ctx = await createBackendTestContext('acp-agree-', acpAgent({ pid: process.pid }));
    await ctx.internals.sweepLocalActivityDurationsForTest();

    const res = await request(ctx.app).get('/api/agents');
    const fromApi = res.body.find((a) => a.name === 'octos-01').online;
    const fromStore = JSON.parse(
      readFileSync(join(ctx.runtimeDir, 'data', 'agents.json'), 'utf8'),
    )['octos-01'].online;
    expect(fromApi).toBe(fromStore);
  });
});
