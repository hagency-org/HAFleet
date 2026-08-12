/*
 * Setup file for scripts/heap-probe-config.js — logs heap at each test file's start and end.
 *
 * The start figure is the load-bearing one: it shows whether retention crosses file boundaries.
 * It does not — vitest forks a worker per file (visible as a changing pid), so every file starts
 * near 12 MB no matter what ran before it. The end figure against `limit` is what retired the
 * memory-pressure theory: the heaviest file reaches ~15% of the limit.
 */
import { afterAll, beforeAll } from 'vitest';
import { getHeapStatistics } from 'node:v8';

const mb = (n) => Math.round(n / 1048576);
const where = () => String(globalThis.__vitest_worker__?.filepath ?? 'unknown').split('/').pop();
const LIMIT_MB = mb(getHeapStatistics().heap_size_limit);

beforeAll(() => {
  const { heapUsed, rss } = process.memoryUsage();
  console.log(`HEAPPROBE start pid=${process.pid} heap=${mb(heapUsed)}MB rss=${mb(rss)}MB ${where()}`);
});

afterAll(() => {
  const { heapUsed, rss } = process.memoryUsage();
  console.log(
    `HEAPPROBE end   pid=${process.pid} heap=${mb(heapUsed)}MB rss=${mb(rss)}MB `
    + `limit=${LIMIT_MB}MB (${Math.round((heapUsed / 1048576 / LIMIT_MB) * 100)}% of limit) ${where()}`,
  );
});
