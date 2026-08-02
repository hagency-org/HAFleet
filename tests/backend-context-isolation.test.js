import { describe, expect, test } from 'vitest';
import request from 'supertest';

import { createBackendTestContext } from './helpers/backend-test-runtime.js';

// The root cause of a flake that survived three wrong diagnoses.
//
// backend-v2.js reads HAFLEET_RUNTIME_DIR at module-evaluation time and loads
// agents.json from it immediately. The helper sets that variable and then awaits
// import(). process.env is process-global and the await yields, so any other
// context doing the same in that window rebinds this module to a different
// directory — 18 assignment sites across 12 test files can do it.
//
// A module bound to the wrong directory finds no seeded agents and answers 404 to
// everything. That is how these appeared, for agents that were plainly seeded:
//
//   GET    /api/agents/doomed      -> 404   (api-tombstone)
//   DELETE /api/agents/deletetest  -> 404   (agent-state-integration)
//
// Rare, a different file each time, always passing in isolation — because in
// isolation there is nothing to race against.
//
// Removing the lock in the helper makes this test fail with
// "backend bound to the wrong runtime dir: expected …/race-2-… got …/race-11-…".

describe('each backend test context binds to its own runtime directory', () => {
  test('twelve contexts created at once each keep their own seeded agent', async () => {
    const contexts = await Promise.all(
      Array.from({ length: 12 }, (_, i) => createBackendTestContext(`ctx-isolation-${i}-`, {
        agents: { [`agent${i}`]: { name: `agent${i}`, type: 'agent', kind: 'agent', online: true } },
      })),
    );
    try {
      for (const [i, context] of contexts.entries()) {
        const own = await request(context.app).get(`/api/agents/agent${i}`);
        expect(own.status, `context ${i} lost its own seeded agent`).toBe(200);
        // And must not see a neighbour's, which is the same bug seen from the
        // other side: two contexts sharing one directory.
        const neighbour = (i + 1) % contexts.length;
        const other = await request(context.app).get(`/api/agents/agent${neighbour}`);
        expect(other.status, `context ${i} can see context ${neighbour}'s agent`).toBe(404);
      }
    } finally {
      for (const context of contexts) context.cleanup();
    }
  }, 120000);

  test('the helper verifies the binding rather than trusting it', async () => {
    // The lock only covers contexts created through this helper, and twelve files
    // set HAFLEET_RUNTIME_DIR themselves. If one lands mid-import anyway, the
    // helper must say so at the point of failure instead of leaving a 404 to be
    // discovered several assertions later.
    const context = await createBackendTestContext('ctx-isolation-check-', {
      agents: { solo: { name: 'solo', type: 'agent', kind: 'agent', online: true } },
    });
    try {
      expect(context.internals.runtimeRootForTest).toBe(context.runtimeDir);
    } finally {
      context.cleanup();
    }
  });
});
