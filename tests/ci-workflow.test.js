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

  test('raw npm test job is not allowed to run unbounded', () => {
    const block = jobBlock(readWorkflow(), 'test');
    expect(block).toContain('- run: npm test');
    expect(block).toMatch(/^\s+timeout-minutes:\s+\d+/m);
  });
});
