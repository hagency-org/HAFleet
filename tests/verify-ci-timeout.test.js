import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterEach, describe, expect, test } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve('.');
const verifyCiScript = path.join(repoRoot, 'scripts', 'verify-ci.sh');
let tempDir = null;

async function makeFakeNpm() {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-chat-verify-ci-timeout-'));
  const npmPath = path.join(tempDir, 'npm');
  await fs.writeFile(npmPath, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-} \${2:-}" == "run test:kernel" ]]; then
  sleep 5
fi
exit 0
`);
  await fs.chmod(npmPath, 0o755);
  return tempDir;
}

describe('verify-ci timeout gate', () => {
  afterEach(async () => {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  test('fails clearly when the CI gate exceeds the wall-clock timeout', async () => {
    const fakeBin = await makeFakeNpm();
    const childEnv = {
      ...process.env,
      AGENTCHAT_VERIFY_CI_TIMEOUT_SEC: '1',
      PATH: `${fakeBin}:${process.env.PATH || ''}`,
    };
    delete childEnv.AGENTCHAT_VERIFY_CI_TIMEOUT_ACTIVE;

    let error = null;
    try {
      await execFileAsync('bash', [verifyCiScript], {
        cwd: repoRoot,
        timeout: 10000,
        env: childEnv,
      });
    } catch (err) {
      error = err;
    }

    expect(error).toBeTruthy();
    expect(error.code).toBe(124);
    expect(error.stderr).toContain('verify:ci exceeded 1s wall-clock timeout; optimization is needed.');
  });
});
