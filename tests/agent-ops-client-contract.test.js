import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

describe('Agent Operations canonical client contract', () => {
  test('agent_ops_canonical_manifest_matches_artifacts', () => {
    const output = execFileSync(process.execPath, ['scripts/check-agent-ops-contract.js'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(output).toContain('[agent-ops-contract] PASS');
    const manifest = JSON.parse(readFileSync('specs/fixtures/agent-ops-client-v1/manifest.json', 'utf8'));
    expect(manifest).toMatchObject({
      contract: 'com.hafleet.agent_ops.v1',
      release_status: 'development',
      source_commit: null,
    });
  });
});
