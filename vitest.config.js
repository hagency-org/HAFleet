import { defineConfig } from 'vitest/config';

// This suite is mostly integration tests: they spawn real child processes, run
// real git commands, bind real sockets, and drive real HTTP servers. vitest's
// default testTimeout is 5000ms, which several of them sit right on top of —
// stable-autodeploy-rollback's cases measured 2.4s to 4.5s against that 5s limit,
// so any load on the machine turned one of them red. Eleven tests had already been
// given their own longer timeout individually, which is the same problem being
// patched one test at a time.
//
// A generous default is the honest setting here. The cost is that a genuinely
// hung test takes 30s to fail instead of 5s; the benefit is that a passing test
// stops depending on how busy the machine is. A slow machine should make the
// suite slower, not wrong.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Serialised deliberately, matching `npm test`. Running these files in
    // parallel races on process.env: RUNTIME_ROOT is captured at import time, and
    // `await import()` yields, so one file's env assignment lands in another
    // file's module. That produced ~20 spurious failures in a parallel run.
    fileParallelism: false,
    maxWorkers: 1,
  },
});
