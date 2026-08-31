import { describe, test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
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
 * bridge-matrix.js is safe to import: its start is behind a process.argv main
 * guard. backend-v2.js is NOT listed because importing it has side effects.
 */
const ENTRYPOINTS = [
  'bridge-matrix.js',
  'lib/appservice-sync.js',
  'lib/appservice-receiver.js',
  'lib/appservice-listener.js',
  'lib/appservice-puller.js',
];

describe('real ESM linkage (the loader vitest does not use)', () => {
  for (const entry of ENTRYPOINTS) {
    test(`${entry} loads under real node`, () => {
      const out = execFileSync(process.execPath, [
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(path.join(repo, entry))}); console.log('linked');`,
      ], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, HAFLEET_RUNTIME_DIR: '' } });
      expect(out).toContain('linked');
    });
  }
});
