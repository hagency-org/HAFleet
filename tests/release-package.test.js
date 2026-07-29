import { afterEach, describe, expect, test } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

// The release used to publish ONLY the remote-relay package, so the remote
// profile was installable from a checksummed artifact while the main install had
// no artifact at all and could only be git-cloned.

const dirs = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-relpkg-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('build-release-package.sh', () => {
  test('produces a stamped full-stack tarball with everything the installer needs', () => {
    const out = tempDir();
    execFileSync('./scripts/build-release-package.sh', ['--out-dir', out], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    });

    const release = JSON.parse(readFileSync('package.json', 'utf-8')).version;
    const tarball = path.join(out, `hafleet-${release}.tar.gz`);
    const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf-8' }).split('\n');
    const prefix = `hafleet-${release}/`;

    for (const entry of [
      'install-full.sh',       // the installer itself
      'upgrade.sh',            // upgrade + rollback
      'package.json',
      'package-lock.json',     // npm install must be reproducible
      'backend-v2.js',
      'server.js',
      'bin/agentchat',
      'lib/version.js',
      'services/agentchat-services.mjs',
      'services/services-local.json',
      'agent-chat-v2.service',
      '.env.example',          // install-full.sh copies this to .env
      'build-info.json',       // stamped: the unpacked tree has no .git
    ]) {
      expect(listing, `missing ${entry}`).toContain(prefix + entry);
    }
  });

  test('stamps identity so an unpacked tree knows its own version', () => {
    const out = tempDir();
    const extract = tempDir();
    execFileSync('./scripts/build-release-package.sh', ['--out-dir', out, '--release', '9.9.9'], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    execFileSync('tar', ['-xzf', path.join(out, 'hafleet-9.9.9.tar.gz'), '-C', extract]);

    const stamp = JSON.parse(readFileSync(path.join(extract, 'hafleet-9.9.9', 'build-info.json'), 'utf-8'));
    expect(stamp.release).toBe('9.9.9');
    expect(stamp.channel).toBe('release');
    expect(stamp.revision).toMatch(/^[0-9a-f]{7,}$/);
  });

  test('excludes CI-only material from a deployed artifact', () => {
    const out = tempDir();
    execFileSync('./scripts/build-release-package.sh', ['--out-dir', out], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const release = JSON.parse(readFileSync('package.json', 'utf-8')).version;
    const listing = execFileSync('tar', ['-tzf', path.join(out, `hafleet-${release}.tar.gz`)], {
      encoding: 'utf-8',
    });
    expect(listing).not.toMatch(new RegExp(`hafleet-${release}/\\.github/`));
    // docs/ stays: AGENTS.md and CLAUDE.md are symlinks into it.
    expect(listing).toMatch(new RegExp(`hafleet-${release}/docs/`));
  });

  test('builds from a git ref, not the working tree', () => {
    // Uncommitted edits must never reach a release artifact.
    const script = readFileSync('scripts/build-release-package.sh', 'utf-8');
    expect(script).toMatch(/git archive --format=tar "\$REF"/);
  });
});

describe('release workflow', () => {
  const workflow = readFileSync('.github/workflows/release.yml', 'utf-8');

  test('publishes both the full-stack and remote artifacts plus checksums', () => {
    expect(workflow).toContain('./scripts/build-release-package.sh');
    expect(workflow).toContain('full_tarball=');
    expect(workflow).toContain('remote_tarball=');
    expect(workflow).toContain('sha256sum ./*.tar.gz > SHA256SUMS');
    // All three must be attached to the release.
    expect(workflow).toContain('steps.package.outputs.full_tarball');
    expect(workflow).toContain('steps.package.outputs.remote_tarball');
    expect(workflow).toContain('dist/SHA256SUMS');
  });
});

describe('bootstrap installer', () => {
  const bootstrap = readFileSync('install/bootstrap.sh', 'utf-8');

  test('prefers a release artifact over cloning', () => {
    expect(bootstrap).toContain('fetch_release_tarball');
    expect(bootstrap).toMatch(/hafleet-\$\{release\}\.tar\.gz/);
  });

  test('verifies the checksum and treats a mismatch as fatal', () => {
    expect(bootstrap).toContain('SHA256SUMS');
    expect(bootstrap).toMatch(/checksum mismatch/);
    // A mismatch must exit, never degrade into a silent clone of other content.
    const mismatch = bootstrap.slice(bootstrap.indexOf('checksum mismatch'));
    expect(mismatch.slice(0, 400)).toMatch(/exit 1/);
  });

  test('refuses an artifact published without checksums', () => {
    expect(bootstrap).toMatch(/without SHA256SUMS; refusing/);
  });

  test('only attempts artifacts for semver tags', () => {
    // Branches and raw SHAs have no published artifact; they must clone.
    expect(bootstrap).toMatch(/v\[0-9\]\*\.\[0-9\]\*\.\[0-9\]\*\)/);
  });

  test('derives the release URL from the repo URL so forks work', () => {
    expect(bootstrap).toContain('releases/download');
    expect(bootstrap).toContain('HAFLEET_RELEASE_BASE');
  });

  test('reports identity from the stamp when installed without git', () => {
    expect(bootstrap).toContain('build-info.json');
  });
});
