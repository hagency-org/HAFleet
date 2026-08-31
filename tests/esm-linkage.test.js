import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/*
 * REAL Node ESM linkage, because Vitest's transform does not check it. A named
 * import of something a module never exported passes the entire suite (esbuild
 * lowers it to a namespace read that is undefined until touched) and then kills
 * the real process at load time with a SyntaxError. That exact shape shipped: a
 * dead `import { secretEquals }` left by a rework round made bridge-matrix.js
 * unimportable in production while 3587 tests stayed green. The first live
 * smoke run caught it, not the suite — this test moves that catch back inside
 * the suite by asking the real loader.
 *
 * IMPORTING THE BRIDGE IS NOT FREE — and a first version of this test claimed
 * it was. Module evaluation runs assertRuntimeDir, creates data/media dirs and
 * may MIGRATE (rewrite) bridge-state.json before the main guard is ever
 * consulted; an empty HAFLEET_RUNTIME_DIR falls back to the REPO ROOT, so that
 * version touched the repository's own untracked runtime state (caught in
 * counter-review, confirmed by the file's mtime). Every subprocess therefore
 * gets its own throwaway runtime dir, and the suite asserts the repo's real
 * bridge state came through byte-identical.
 */
const ENTRYPOINTS = [
  'bridge-matrix.js',
  'lib/appservice-sync.js',
  'lib/appservice-receiver.js',
  'lib/appservice-listener.js',
  'lib/appservice-puller.js',
];

const repoStatePath = path.join(repo, 'data', 'matrix', 'bridge-state.json');
let repoStateBefore = null;

beforeAll(() => {
  repoStateBefore = existsSync(repoStatePath) ? readFileSync(repoStatePath, 'utf8') : null;
});

afterAll(() => {
  const after = existsSync(repoStatePath) ? readFileSync(repoStatePath, 'utf8') : null;
  expect(after).toBe(repoStateBefore);
});

describe('real ESM linkage (the loader vitest does not use)', () => {
  for (const entry of ENTRYPOINTS) {
    test(`${entry} loads under real node`, () => {
      const runtime = mkdtempSync(path.join(tmpdir(), 'hafleet-linkage-'));
      try {
        const out = execFileSync(process.execPath, [
          '--input-type=module',
          '-e',
          `await import(${JSON.stringify(path.join(repo, entry))}); console.log('linked');`,
        ], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, HAFLEET_RUNTIME_DIR: runtime } });
        expect(out).toContain('linked');
      } finally {
        rmSync(runtime, { recursive: true, force: true });
      }
    });
  }
});
