/*
 * Per-file heap measurement for the test suite.
 *
 *   npx vitest run --config scripts/heap-probe-config.js tests/api-groups.test.js
 *
 * Prints a HEAPPROBE line at the start and end of each file. Written because the
 * intermittent-failure investigation had a memory-pressure theory nobody had measured, and the
 * measurement (see docs/TESTING.md, "The memory theory, measured and dropped") retired it: the
 * worst file peaks at ~15% of Node's heap limit.
 *
 * Kept rather than deleted so the next person with a memory theory can check it in one command
 * instead of reasoning about it.
 */
import { defineConfig, mergeConfig } from 'vitest/config';
import base from '../vitest.config.js';

export default mergeConfig(base, defineConfig({
  test: { setupFiles: ['./scripts/heap-probe-setup.mjs'] },
}));
