// Build and release identity.
//
// Two distinct concepts, deliberately kept separate:
//
//   revision - the exact commit (git short SHA). This is what
//              `verify-remote --expect-version` compares and what the server
//              registry records, so its meaning must not change.
//   release  - the semver of the release this tree came from.
//
// Generated packages have no .git, which is why `git rev-parse` returned null
// there and standalone builds had no identity at all. `scripts/stamp-version.sh`
// writes build-info.json at package time; this module prefers it and falls back
// to the live checkout for development.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, '..');

export const BUILD_INFO_FILENAME = 'build-info.json';

function readJson(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Build stamp written by scripts/stamp-version.sh, or null in a plain checkout. */
export function readBuildInfo(root = REPO_ROOT) {
  const stampPath = path.join(root, BUILD_INFO_FILENAME);
  if (!existsSync(stampPath)) return null;
  const parsed = readJson(stampPath);
  if (!parsed) return null;
  return {
    release: nonEmptyString(parsed.release),
    revision: nonEmptyString(parsed.revision),
    builtAt: nonEmptyString(parsed.builtAt),
    channel: nonEmptyString(parsed.channel),
  };
}

function packageVersion(root = REPO_ROOT) {
  return nonEmptyString(readJson(path.join(root, 'package.json'))?.version);
}

function gitRevision(root = REPO_ROOT) {
  try {
    return nonEmptyString(execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }));
  } catch {
    return null;
  }
}

/**
 * Semver of this tree. Stamp wins so a built package reports the release it was
 * cut from even after package.json moves on. Never throws; may return null.
 */
export function resolveReleaseVersion(root = REPO_ROOT) {
  return readBuildInfo(root)?.release || packageVersion(root) || null;
}

/**
 * Exact commit. Stamp wins because generated packages have no .git — this is
 * the case that previously produced null.
 */
export function resolveRevision(root = REPO_ROOT) {
  return readBuildInfo(root)?.revision || gitRevision(root) || null;
}

/** Combined identity for /api/system and startup banners. */
export function resolveBuildIdentity(root = REPO_ROOT) {
  const stamp = readBuildInfo(root);
  return {
    release: resolveReleaseVersion(root),
    revision: resolveRevision(root),
    builtAt: stamp?.builtAt || null,
    channel: stamp?.channel || null,
    stamped: Boolean(stamp),
  };
}

/** "1.2.0 (a1b2c3d)" — for logs and human-facing surfaces. */
export function formatBuildIdentity(root = REPO_ROOT) {
  const { release, revision } = resolveBuildIdentity(root);
  if (release && revision) return `${release} (${revision})`;
  return release || revision || 'unknown';
}
