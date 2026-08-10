/*
 * `--version` is not evidence an ACP framework can start.
 *
 * GET /api/frameworks/detect probed only `--version`, so a binary that answered it
 * was reported `state: ready`. On a fresh machine with octos 0.1.1 that is exactly
 * what happened — and `hafleet acp-up` then died with
 * `unrecognized subcommand 'acp'`. The console had told the operator a framework was
 * ready for a launch path the installed version does not have.
 *
 * The manifest's own note says it was verified against octos 2.0.2. Nothing checked
 * that, and the machine this was developed on had a new enough build for it never to
 * show. Found by standing the whole thing up on a clean host.
 *
 * These tests use fake binaries on PATH rather than whatever the developer happens to
 * have installed, so the result does not depend on the machine running them.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

/**
 * A stand-in `octos` on PATH.
 *
 * @param dir     directory to place it in (prepended to PATH by the caller)
 * @param acpOk   whether `octos acp --help` succeeds — the whole question here
 */
function fakeOctos(dir, { acpOk }) {
  const bin = path.join(dir, 'octos');
  // Built line-by-line rather than as one template literal: the failing branch has to
  // emit a bash-quoted `'acp'`, and nesting that inside `${}` inside a template is a
  // quoting puzzle with no upside.
  const acpBranch = acpOk
    ? '  echo "usage: octos acp"; exit 0'
    : '  echo "error: unrecognized subcommand acp" >&2; exit 2';
  const script = [
    '#!/bin/bash',
    'if [ "$1" = "--version" ]; then echo "octos 9.9.9 (fake)"; exit 0; fi',
    'if [ "$1" = "acp" ]; then',
    acpBranch,
    'fi',
    'echo "usage: octos <COMMAND>" >&2; exit 2',
    '',
  ].join('\n');
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
}

const octosFrom = (body) => body.frameworks.find((f) => f.id === 'octos');

describe('framework detect: an ACP framework must have its subcommand', () => {
  let binDir;
  let originalPath;
  let ctx;

  beforeEach(() => {
    binDir = mkdtempSync(path.join(os.tmpdir(), 'fake-bin-'));
    originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    rmSync(binDir, { recursive: true, force: true });
    await ctx?.cleanup?.();
    ctx = null;
  });

  test('a binary that answers --version but has no acp subcommand is NOT ready', async () => {
    // The octos 0.1.1 case, exactly.
    fakeOctos(binDir, { acpOk: false });
    ctx = await createBackendTestContext('acp-probe-bad-');
    const res = await request(ctx.app).get('/api/frameworks/detect');
    expect(res.status).toBe(200);
    const octos = octosFrom(res.body);
    expect(octos.onPath).toBe(true);
    expect(octos.version).toContain('9.9.9');
    // Before the fix this was 'ready', which is the defect.
    expect(octos.state).toBe('unusable');
    // The message has to name the missing subcommand: "unusable" alone sends an
    // operator looking at credentials or the install, not at the version.
    expect(octos.probeError).toMatch(/acp/);
  });

  test('a binary with the subcommand is ready, so the probe is not just refusing more', async () => {
    fakeOctos(binDir, { acpOk: true });
    ctx = await createBackendTestContext('acp-probe-good-');
    const res = await request(ctx.app).get('/api/frameworks/detect');
    const octos = octosFrom(res.body);
    expect(octos.probeError).toBeNull();
    // 'needs_auth' is also a pass here: this machine may have no ~/.config/octos,
    // and that is a different question from whether the subcommand exists.
    expect(['ready', 'needs_auth']).toContain(octos.state);
  });

  test('a tmux framework is not asked for an acp subcommand it never uses', async () => {
    // The probe must key on the manifest's transport, not on the framework's name.
    fakeOctos(binDir, { acpOk: false });
    const claudeBin = path.join(binDir, 'claude');
    writeFileSync(claudeBin, '#!/bin/bash\nif [ "$1" = "--version" ]; then echo "claude 1.0.0"; exit 0; fi\nexit 2\n');
    chmodSync(claudeBin, 0o755);
    ctx = await createBackendTestContext('acp-probe-tmux-');
    const res = await request(ctx.app).get('/api/frameworks/detect');
    const claude = res.body.frameworks.find((f) => f.id === 'claude');
    expect(claude.onPath).toBe(true);
    expect(claude.probeError).toBeNull();
  });
});
