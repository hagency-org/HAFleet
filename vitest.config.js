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
    // The Next.js prototype under mockup/ is a separate package with its own
    // toolchain. vitest's default include is **/*.{test,spec}.* with only
    // node_modules and .git excluded, so without this the root suite would sweep
    // anything added there.
    exclude: [
      '**/node_modules/**',
      '**/.git/**',
      'mockup/**',
      /*
       * Parallel subagents work in git worktrees under .claude/worktrees/, INSIDE this repo — so
       * vitest's glob sweeps their copies of every test file into the root run, and a path argument
       * like `vitest run tests/x.test.js` matches their tests/x.test.js too (arguments are filters,
       * not paths). The symptom that found this: one edited test failing three times under three
       * different paths, two of them asserting the behaviour the edit had just reversed.
       */
      '**/.claude/worktrees/**',
    ],
    fileParallelism: false,
    maxWorkers: 1,
  },
});
