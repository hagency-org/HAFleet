import { afterEach, describe, expect, test } from 'vitest';
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const projectRoot = process.cwd();
const roots = [];

function temporaryProject() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hafleet-router-contract-'));
  roots.push(root);
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  cpSync(path.join(projectRoot, 'router'), path.join(root, 'router'), { recursive: true });
  cpSync(path.join(projectRoot, 'tsconfig.router.json'), path.join(root, 'tsconfig.router.json'));
  cpSync(path.join(projectRoot, 'scripts', 'check-router-build.sh'), path.join(root, 'scripts', 'check-router-build.sh'));
  cpSync(path.join(projectRoot, 'scripts', 'check-router-boundary.js'), path.join(root, 'scripts', 'check-router-boundary.js'));
  symlinkSync(path.join(projectRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('router build and dependency contract', () => {
  test('test_router_build_check_detects_stale_or_internal_import', () => {
    const root = temporaryProject();
    execFileSync('bash', ['scripts/check-router-build.sh'], { cwd: root, encoding: 'utf8' });
    appendFileSync(path.join(root, 'router', 'dist', 'index.js'), '\n// stale fixture\n');
    const stale = spawnSync('bash', ['scripts/check-router-build.sh'], { cwd: root, encoding: 'utf8' });
    expect(stale.status).not.toBe(0);
    expect(`${stale.stdout}${stale.stderr}`).toContain('router/dist is stale');

    writeFileSync(path.join(root, 'consumer.js'), `import './router/${'dist/store.js'}';\n`);
    const boundary = spawnSync(process.execPath, ['scripts/check-router-boundary.js'], { cwd: root, encoding: 'utf8' });
    expect(boundary.status).not.toBe(0);
    expect(`${boundary.stdout}${boundary.stderr}`).toContain('imports a router internal module');
  });

  test('test_router_typecheck_rejects_any_and_unchecked_brand_construction', () => {
    const root = temporaryProject();
    writeFileSync(path.join(root, 'router', 'src', 'prohibited-fixture.ts'), [
      'export const explicitEscape: any = 1;',
      'export const uncheckedBrand = {} as unknown as { readonly value: string };',
      '',
    ].join('\n'));
    const typecheck = spawnSync(
      path.join(root, 'node_modules', '.bin', 'tsc'),
      ['-p', 'tsconfig.router.json', '--noEmit'],
      { cwd: root, encoding: 'utf8' },
    );
    const boundary = spawnSync(process.execPath, ['scripts/check-router-boundary.js'], { cwd: root, encoding: 'utf8' });
    expect(typecheck.status === 0 || typecheck.status === 2).toBe(true);
    expect(boundary.status).not.toBe(0);
    expect(`${boundary.stdout}${boundary.stderr}`).toContain('contains prohibited any');
    expect(`${boundary.stdout}${boundary.stderr}`).toContain('contains unchecked double assertion');
  });

  test('test_router_dependency_spike_installs_and_recovers_wal', () => {
    expect(Number(process.versions.node.split('.')[0])).toBeGreaterThanOrEqual(22);
    const root = mkdtempSync(path.join(os.tmpdir(), 'hafleet-router-dependency-'));
    roots.push(root);
    cpSync(path.join(projectRoot, 'package.json'), path.join(root, 'package.json'));
    cpSync(path.join(projectRoot, 'package-lock.json'), path.join(root, 'package-lock.json'));
    cpSync(path.join(projectRoot, 'tsconfig.router.json'), path.join(root, 'tsconfig.router.json'));
    cpSync(path.join(projectRoot, 'router', 'src'), path.join(root, 'router', 'src'), { recursive: true });
    execFileSync('npm', ['ci', '--no-audit', '--no-fund'], {
      cwd: root, encoding: 'utf8', stdio: 'pipe', timeout: 120_000,
    });
    execFileSync('npm', ['run', 'build:router'], {
      cwd: root, encoding: 'utf8', stdio: 'pipe', timeout: 60_000,
    });
    const dbPath = path.join(root, 'wal-recovery.db');
    const writeProbe = [
      `import Database from '${'better-sqlite3'}';`,
      `const db = new Database(${JSON.stringify(dbPath)});`,
      "if (db.pragma('journal_mode = WAL', { simple: true }) !== 'wal') process.exit(2);",
      "db.exec(\"CREATE TABLE durable(value TEXT); BEGIN; INSERT INTO durable VALUES ('committed'); COMMIT;\");",
      'db.close();',
    ].join('\n');
    execFileSync(process.execPath, ['--input-type=module', '-e', writeProbe], { cwd: root });
    const readProbe = [
      `import Database from '${'better-sqlite3'}';`,
      `const db = new Database(${JSON.stringify(dbPath)});`,
      "process.stdout.write(db.prepare('SELECT value FROM durable').get().value);",
      'db.close();',
    ].join('\n');
    expect(execFileSync(process.execPath, ['--input-type=module', '-e', readProbe], {
      cwd: root, encoding: 'utf8',
    })).toBe('committed');
    const prohibitedPattern = new RegExp(['node:', 'sqlite|JSON fallback'].join(''));
    const routerSrcDir = path.join(root, 'router', 'src');
    const prohibitedHits = readdirSync(routerSrcDir, { recursive: true })
      .map(String)
      .filter((name) => name.endsWith('.ts'))
      .filter((name) => prohibitedPattern.test(readFileSync(path.join(routerSrcDir, name), 'utf8')));
    expect(prohibitedHits).toEqual([]);
    expect(readFileSync(path.join(root, 'router', 'dist', 'index.js'), 'utf8')).toContain("from './store.js'");
  }, 180_000);
});
