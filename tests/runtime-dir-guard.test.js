import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';

import { assertRuntimeDir, isLocalAgentServer } from '../lib/runtime-dir-guard.js';
import { resolveLocalServerId, serversEquivalent } from '../lib/server-identity.js';

describe('assertRuntimeDir', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'rtguard-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('no-op when path does not exist', () => {
    expect(() => assertRuntimeDir('/nonexistent/path/abc123')).not.toThrow();
  });

  test('no-op when path is falsy', () => {
    expect(() => assertRuntimeDir(null)).not.toThrow();
    expect(() => assertRuntimeDir('')).not.toThrow();
    expect(() => assertRuntimeDir(undefined)).not.toThrow();
  });

  test('no-op for clean runtime dir', () => {
    mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
    expect(() => assertRuntimeDir(tmpDir)).not.toThrow();
  });

  test('throws when runtime root basename contains stale-backup', () => {
    const staleDir = path.join(tmpDir, 'data-stale-backup');
    mkdirSync(staleDir, { recursive: true });
    expect(() => assertRuntimeDir(staleDir)).toThrow(/stale backup directory/);
  });

  test('throws when data dir has stale sibling', () => {
    mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
    mkdirSync(path.join(tmpDir, 'data-stale-old'), { recursive: true });
    expect(() => assertRuntimeDir(tmpDir)).toThrow(/stale data marker/);
  });

  test('throws when data dir has data_stale sibling (underscore)', () => {
    mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
    mkdirSync(path.join(tmpDir, 'data_stale_bak'), { recursive: true });
    expect(() => assertRuntimeDir(tmpDir)).toThrow(/stale data marker/);
  });

  test('no-op when data dir does not exist and no stale markers', () => {
    // tmpDir exists but has no data/ subdirectory and no stale markers
    expect(() => assertRuntimeDir(tmpDir)).not.toThrow();
  });

  test('throws on fresh dir with stale marker but no data/ (bug 3 regression)', () => {
    // data/ does NOT exist, but a stale marker sibling does
    mkdirSync(path.join(tmpDir, 'data.stale-backup-20260310'), { recursive: true });
    expect(() => assertRuntimeDir(tmpDir)).toThrow(/stale data marker/);
  });
});

describe('isLocalAgentServer', () => {
  test('empty string is local', () => {
    expect(isLocalAgentServer('')).toBe(true);
  });

  test('null/undefined is local', () => {
    expect(isLocalAgentServer(null)).toBe(true);
    expect(isLocalAgentServer(undefined)).toBe(true);
  });

  test('"local" is local', () => {
    expect(isLocalAgentServer('local')).toBe(true);
  });

  test('custom local server id matches', () => {
    expect(isLocalAgentServer('my-server', 'my-server')).toBe(true);
  });

  test('hostname alias is local when legacy local env is still configured', () => {
    expect(isLocalAgentServer('shisuiki', 'local', { hostname: 'shisuiki' })).toBe(true);
  });

  test('legacy local can be disabled for remote relay routing', () => {
    expect(serversEquivalent('local', 'rhodes1', {
      localServerId: 'rhodes1',
      hostname: 'rhodes1',
      includeLegacyLocal: false,
    })).toBe(false);
  });

  test('local and hostname are equivalent on the central local relay', () => {
    expect(serversEquivalent('local', 'shisuiki', {
      localServerId: 'shisuiki',
      hostname: 'shisuiki',
    })).toBe(true);
  });

  test('local server id defaults to hostname instead of legacy literal local', () => {
    expect(resolveLocalServerId({}, 'shisuiki')).toBe('shisuiki');
  });

  test('whitespace-only is local', () => {
    expect(isLocalAgentServer('  ')).toBe(true);
  });

  test('remote server id is not local', () => {
    expect(isLocalAgentServer('remote-abc')).toBe(false);
  });

  test('remote server id with custom local id', () => {
    expect(isLocalAgentServer('remote-abc', 'my-server')).toBe(false);
  });
});
