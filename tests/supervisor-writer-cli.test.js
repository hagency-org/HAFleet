import { describe, expect, test } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve('.');
const writerScript = path.join(repoRoot, 'scripts', 'write-supervisor-state.js');

describe('supervisor writer CLI contract', () => {
  test('help describes start as an assessment update, not registration', async () => {
    const result = await execFileAsync('node', [writerScript, '--help'], {
      cwd: repoRoot,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });

    expect(result.stdout).toContain('Usage: write-supervisor-state <start|assess|heartbeat|done> [options]');
    expect(result.stdout).toContain('start       Post initial idle assessment');
    expect(result.stdout).not.toContain('Register supervisor');
    expect(result.stdout).not.toContain('begin lease');
  });
});
