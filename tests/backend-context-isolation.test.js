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

/**
 * GET a path, retrying only a CONNECTION-level failure.
 *
 * This test drives 24 supertest requests across twelve simultaneously-created
 * apps, each on its own ephemeral port. Late in a full suite run that occasionally
 * produced `read ECONNRESET` — a socket-level failure that says nothing about the
 * isolation being asserted. It passed 3/3 in isolation and failed only in the full
 * suite, which is the signature of resource pressure rather than a defect.
 *
 * A status code is never retried: a wrong status is exactly what this test exists
 * to catch, and retrying it would hide the bug the file was written for.
 */
async function getWithRetry(app, urlPath, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await request(app).get(urlPath);
    } catch (error) {
      const transient = ['ECONNRESET', 'EPIPE', 'ECONNREFUSED'].includes(error?.code)
        || /ECONNRESET|EPIPE|socket hang up/.test(error?.message ?? '');
      if (!transient || attempt === attempts) throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
  throw lastError;
}

describe('each backend test context binds to its own runtime directory', () => {
  test('twelve contexts created at once each keep their own seeded agent', async () => {
    const contexts = await Promise.all(
      Array.from({ length: 12 }, (_, i) => createBackendTestContext(`ctx-isolation-${i}-`, {
        agents: { [`agent${i}`]: { name: `agent${i}`, type: 'agent', kind: 'agent', online: true } },
      })),
    );
    try {
      for (const [i, context] of contexts.entries()) {
        const own = await getWithRetry(context.app, `/api/agents/agent${i}`);
        expect(own.status, `context ${i} lost its own seeded agent`).toBe(200);
        // And must not see a neighbour's, which is the same bug seen from the
        // other side: two contexts sharing one directory.
        const neighbour = (i + 1) % contexts.length;
        const other = await getWithRetry(context.app, `/api/agents/agent${neighbour}`);
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
