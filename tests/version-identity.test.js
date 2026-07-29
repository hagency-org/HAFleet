import { afterEach, describe, expect, test } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

import {
  BUILD_INFO_FILENAME,
  formatBuildIdentity,
  readBuildInfo,
  resolveBuildIdentity,
  resolveReleaseVersion,
  resolveRevision,
} from '../lib/version.js';

const REPO_ROOT = path.resolve('.');
const temps = [];

function tempRoot() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-version-'));
  temps.push(dir);
  return dir;
}

function writeStamp(root, stamp) {
  writeFileSync(path.join(root, BUILD_INFO_FILENAME), JSON.stringify(stamp, null, 2));
}

afterEach(() => {
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});

describe('build identity', () => {
  test('package.json carries a semver release', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
    expect(pkg.version).not.toBe('1.0.0');
  });

  test('a stamp overrides package.json and git', () => {
    const root = tempRoot();
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    writeStamp(root, {
      release: '1.2.0', revision: 'abc1234', builtAt: '2026-07-28T00:00:00Z', channel: 'release',
    });

    expect(resolveReleaseVersion(root)).toBe('1.2.0');
    expect(resolveRevision(root)).toBe('abc1234');
    expect(resolveBuildIdentity(root)).toMatchObject({
      release: '1.2.0', revision: 'abc1234', channel: 'release', stamped: true,
    });
    expect(formatBuildIdentity(root)).toBe('1.2.0 (abc1234)');
  });

  test('falls back to package.json when unstamped', () => {
    const root = tempRoot();
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '3.4.5' }));
    expect(readBuildInfo(root)).toBeNull();
    expect(resolveReleaseVersion(root)).toBe('3.4.5');
    expect(resolveBuildIdentity(root).stamped).toBe(false);
  });

  test('a package with no .git still reports a revision when stamped', () => {
    // This is the case that previously produced null: generated standalone
    // packages have no git metadata, so `git rev-parse` failed silently.
    const root = tempRoot();
    expect(resolveRevision(root)).toBeNull();

    writeStamp(root, { release: '1.2.0', revision: 'deadbee' });
    expect(resolveRevision(root)).toBe('deadbee');
  });

  test('never throws on a corrupt or empty stamp', () => {
    const root = tempRoot();
    writeFileSync(path.join(root, BUILD_INFO_FILENAME), '{ not json');
    expect(readBuildInfo(root)).toBeNull();
    expect(() => resolveBuildIdentity(root)).not.toThrow();
    expect(formatBuildIdentity(root)).toBe('unknown');

    writeFileSync(path.join(root, BUILD_INFO_FILENAME), '{}');
    expect(readBuildInfo(root)).toEqual({
      release: null, revision: null, builtAt: null, channel: null,
    });
  });

  test('the live checkout resolves both identities', () => {
    const identity = resolveBuildIdentity(REPO_ROOT);
    expect(identity.release).toMatch(/^\d+\.\d+\.\d+/);
    expect(identity.revision).toMatch(/^[0-9a-f]{7,}$/);
  });
});

describe('stamp-version.sh', () => {
  test('writes UTC builtAt and honours --release and --channel', () => {
    const root = tempRoot();
    mkdirSync(path.join(root, 'nested'), { recursive: true });
    execFileSync('./scripts/stamp-version.sh', [
      path.join(root, 'nested'), '--channel', 'remote', '--release', 'v4.5.6',
    ], { cwd: REPO_ROOT, encoding: 'utf-8' });

    const stamp = JSON.parse(readFileSync(path.join(root, 'nested', BUILD_INFO_FILENAME), 'utf-8'));
    // A leading v is stripped so tag-driven builds match package.json.
    expect(stamp.release).toBe('4.5.6');
    expect(stamp.channel).toBe('remote');
    expect(stamp.builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(stamp.revision).toMatch(/^[0-9a-f]{7,}$/);
  });

  test('build-info.json is never committed', () => {
    expect(readFileSync('.gitignore', 'utf-8')).toContain('build-info.json');
    const tracked = execFileSync('git', ['ls-files', BUILD_INFO_FILENAME], {
      cwd: REPO_ROOT, encoding: 'utf-8',
    });
    expect(tracked.trim()).toBe('');
  });
});
