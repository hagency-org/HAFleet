import { describe, expect, test } from 'vitest';
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

  test('NOTICE credits every upstream author', () => {
    const notice = readFileSync('NOTICE', 'utf-8');
    expect(notice).toContain('shisuiki/agent-chat');
    // Apache 2.0 section 4 requires retaining attribution, and 717 of this
    // tree's commits are upstream's. All five authors must stay named.
    for (const author of ['shisuiki', 'mayor', 'anantheparty', 'csheargm', '确定下推自动机']) {
      expect(notice, `NOTICE must credit ${author}`).toContain(author);
    }
    expect(notice).toContain('docs/LICENSING.md');
  });

  test('NOTICE no longer claims the inherited code is unlicensed', () => {
    // Upstream adopted Apache 2.0 on 2026-07-29. Leaving the old caveat in place
    // would understate the license we actually ship under.
    const notice = readFileSync('NOTICE', 'utf-8');
    expect(notice).not.toMatch(/publishes no LICENSE|not covered by the Apache/i);
    expect(notice).toMatch(/Apache License 2\.0/);
  });

  test('LICENSING.md records the resolution and keeps provenance for attribution', () => {
    const doc = readFileSync('docs/LICENSING.md', 'utf-8');
    expect(doc).toMatch(/Status: resolved/i);
    // The upstream commit is the load-bearing fact; keep it citable.
    expect(doc).toContain('aa8e5e5');
    // Provenance stays because Apache 2.0 section 4 needs attribution.
    expect(doc).toContain('717');
    expect(doc).toMatch(/Obligations when distributing/i);
    expect(doc).not.toMatch(/cannot be distributed publicly/i);
  });

});
