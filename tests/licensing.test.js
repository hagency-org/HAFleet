import { describe, expect, test } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';

describe('licensing', () => {
  test('LICENSE is the canonical Apache 2.0 text', () => {
    const license = readFileSync('LICENSE', 'utf-8');
    expect(license).toContain('Apache License');
    expect(license).toContain('Version 2.0, January 2004');
    expect(license).toContain('http://www.apache.org/licenses/');
    expect(license).toContain('END OF TERMS AND CONDITIONS');
  });

  test('package.json declares Apache-2.0', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
    expect(pkg.license).toBe('Apache-2.0');
    // Still not an npm package; this is a deployed service.
    expect(pkg.private).toBe(true);
  });

  test('NOTICE attributes upstream and records the unresolved consent', () => {
    const notice = readFileSync('NOTICE', 'utf-8');
    expect(notice).toContain('shisuiki/agent-chat');
    // The fork is 93% upstream code and upstream has no license. If this
    // caveat is ever dropped, the NOTICE starts implying a grant we do not have.
    expect(notice).toMatch(/no LICENSE file|not covered by the Apache/i);
    expect(notice).toContain('docs/LICENSING.md');
  });

  test('LICENSING.md states the blocker and how to undo the license commit', () => {
    const doc = readFileSync('docs/LICENSING.md', 'utf-8');
    expect(doc).toMatch(/cannot be distributed publicly/i);
    expect(doc).toContain('chore(license)');
    expect(doc).toMatch(/git revert/);
  });

  test('the license assertion is one revertable commit', () => {
    // docs/LICENSING.md promises this is cleanly undoable. Verify the commit
    // exists and touches only the license-bearing files.
    const sha = execFileSync('git', ['log', '--format=%H', '--grep=^chore(license)', '-1'], {
      encoding: 'utf-8',
    }).trim();
    expect(sha, 'no chore(license) commit found').toBeTruthy();

    const files = execFileSync('git', ['show', '--name-only', '--format=', sha], {
      encoding: 'utf-8',
    }).trim().split('\n').filter(Boolean).sort();
    expect(files).toEqual(['LICENSE', 'NOTICE', 'package.json']);
  });
});
