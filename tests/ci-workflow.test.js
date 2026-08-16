import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const workflowPath = path.resolve('.github/workflows/ci.yml');

function readWorkflow() {
  return readFileSync(workflowPath, 'utf8');
}

function jobBlock(source, jobName) {
  const pattern = new RegExp(`(?:^|\\n)  ${jobName}:\\n([\\s\\S]*?)(?=\\n  [a-zA-Z0-9_-]+:\\n|$)`);
  const match = source.match(pattern);
  return match ? match[1] : '';
}

describe('GitHub Actions CI workflow', () => {
  test('bounds all CI jobs with a wall-clock timeout', () => {
    const workflow = readWorkflow();
    for (const jobName of ['lint', 'test']) {
      const block = jobBlock(workflow, jobName);
      expect(block).not.toBe('');
      expect(block).toMatch(/^\s+timeout-minutes:\s+\d+/m);
    }
  });

  test('the job that runs the suite is not allowed to run unbounded', () => {
    /*
     * This used to pin the literal `- run: npm test`, which is the anchor and not the property: the
     * point was always that the job running the suite has a wall-clock bound. Adding a JSON reporter
     * for flake forensics changed the command and tripped it, correctly — the guard noticed the CI
     * definition move. Widening it to "either command" alone would have been a loosening, so the
     * companion assertion below closes the hole that widening opens.
     */
    const block = jobBlock(readWorkflow(), 'test');
    expect(block).toMatch(/- run: npm (test|run test:ci)$/m);
    expect(block).toMatch(/^\s+timeout-minutes:\s+\d+/m);
  });

  test('test:ci cannot quietly become a narrower run than npm test', () => {
    /*
     * The risk the widening above introduces. If CI may run `test:ci`, then `test:ci` is what "the
     * tests pass" means — and nothing stopped it from drifting into a subset, a `--bail`, or a
     * different config while still being green. It must be exactly `test` plus reporter flags.
     */
    const scripts = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')).scripts || {};
    if (!scripts['test:ci']) return; // the plain `npm test` job is still allowed
    const extra = scripts['test:ci'].replace(scripts.test, '').trim();
    expect(scripts['test:ci'].startsWith(scripts.test)).toBe(true);
    for (const flag of extra.split(/\s+/).filter(Boolean)) {
      expect(flag).toMatch(/^--(reporter|outputFile)/);
    }
  });
});
