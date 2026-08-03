import { describe, expect, test } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';

// Eight test files failed nondeterministically — alert-store, api-server-heartbeat,
// api-server-heartbeat-sweep, api-dispatch, api-agent-token, cli-agent-down-guard,
// mcp-heartbeat, stable-autodeploy-rollback. Two distinct causes, neither of them
// "flaky tests" in the hand-wavy sense:
//
//   1. vitest's default testTimeout is 5000ms and these are integration tests that
//      spawn processes, run git, and bind sockets. stable-autodeploy-rollback's
//      cases measured 2.4s-4.5s against that 5s ceiling, so machine load decided
//      the result. Eleven tests had already been given individual longer timeouts,
//      which was the same problem being patched one test at a time.
//
//   2. MCP_FETCH_TIMEOUT_MS was 100ms against a local fake server. A loopback
//      response takes ~2ms, but under full-suite load it exceeded 100ms and the
//      client logged "timeout (attempt 1/2)" where the test asserted on an HTTP
//      status. No test exercised timeout behaviour, so the short value bought
//      nothing.
//
// After fixing both: nine consecutive clean runs, two of them the full suite.

const MIN_DEFAULT_TIMEOUT_MS = 20_000;

describe('the suite does not depend on how fast the machine is', () => {
  const config = readFileSync('vitest.config.js', 'utf-8');

  test('a generous default testTimeout is configured', () => {
    const match = config.match(/testTimeout:\s*([0-9_]+)/);
    expect(match, 'vitest.config.js declares no testTimeout').toBeTruthy();
    expect(Number(match[1].replace(/_/g, ''))).toBeGreaterThanOrEqual(MIN_DEFAULT_TIMEOUT_MS);
  });

  test('hooks get the same budget as tests', () => {
    // A beforeEach that spawns a backend is as slow as the test that uses it.
    const match = config.match(/hookTimeout:\s*([0-9_]+)/);
    expect(match, 'vitest.config.js declares no hookTimeout').toBeTruthy();
    expect(Number(match[1].replace(/_/g, ''))).toBeGreaterThanOrEqual(MIN_DEFAULT_TIMEOUT_MS);
  });

  test('serialised execution is configured, not just passed on the command line', () => {
    // The process.env import race is real: RUNTIME_ROOT is captured at import time
    // and `await import()` yields, so a parallel run lets one file's env assignment
    // land in another file's module. A bare `npx vitest run` produced ~20 spurious
    // failures for exactly this reason. Encoding it in the config means the wrong
    // invocation is no longer a trap.
    expect(config).toMatch(/fileParallelism:\s*false/);
  });

  test('no test file caps the timeout below the configured default', () => {
    // These overrides were written to RAISE the limit above 5000ms. Once the
    // default became 30s they were lowering it, and mcp-heartbeat's pid-file test
    // kept dying at exactly its own 10s ceiling. A per-test timeout is only
    // legitimate now if it asks for MORE time.
    const files = execFileSync('git', ['ls-files', 'tests'], { encoding: 'utf-8' })
      .split('\n').filter((f) => f.endsWith('.test.js'));
    const offenders = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf-8');
      // `}, 1000);` is ambiguous: it closes a test() call OR a setTimeout(). The
      // first version of this check flagged a setTimeout inside a cleanup helper.
      // A block closing at indent N was opened at indent N, so look back for the
      // nearest line at exactly that indent and see what it actually opened.
      const lines = text.split('\n');
      lines.forEach((line, index) => {
        const closing = line.match(/^(\s*)\}, (\d{3,})\);\s*$/);
        if (!closing) return;
        const [, indent, digits] = closing;
        const ms = Number(digits);
        if (ms >= MIN_DEFAULT_TIMEOUT_MS) return;
        let opener = null;
        for (let i = index - 1; i >= 0; i -= 1) {
          const candidate = lines[i];
          if (!candidate.trim()) continue;
          const candidateIndent = candidate.match(/^\s*/)[0];
          if (candidateIndent.length < indent.length) break;
          if (candidateIndent === indent) { opener = candidate; break; }
        }
        if (opener && /\b(test|it)(\.\w+)*\s*\(/.test(opener)) {
          offenders.push(`${file}:${index + 1}: }, ${ms})`);
        }
      });
    }
    expect(offenders, 'per-test timeouts below the default cap it instead of raising it').toEqual([]);
  });

  test('the MCP test fetch timeout leaves room for a loaded machine', () => {
    // 100ms was not a slow-machine problem, it was a wrong number: it raced the
    // fake server it was pointed at.
    const heartbeat = readFileSync('tests/mcp-heartbeat.test.js', 'utf-8');
    const match = heartbeat.match(/MCP_FETCH_TIMEOUT_MS:\s*'(\d+)'/);
    expect(match).toBeTruthy();
    expect(Number(match[1])).toBeGreaterThanOrEqual(1000);
  });
});
