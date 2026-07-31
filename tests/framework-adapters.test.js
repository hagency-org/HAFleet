import { describe, expect, test } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';

import {
  applicableFrameworks, frameworkIds, getFramework, guardViolation,
  launchableFrameworkIds, launchBlockedReason, listFrameworks,
} from '../lib/frameworks/index.js';
import {
  defaultLaunchArgs, validateLaunchExtraArgs, LAUNCH_PERMISSION_SUMMARY,
} from '../lib/agent-launch-policy.js';

describe('the registry loads and validates its manifests', () => {
  test('ships its adapters in a stable order', () => {
    // Order is contractual: it decides nothing today because the guard sets are
    // disjoint, but a future adapter could overlap.
    expect(frameworkIds()).toEqual(['claude', 'codex', 'hermes']);
  });

  test('hermes is declared but not launchable, with a stated reason', () => {
    // Declaring a framework bin/agent-up cannot start must fail loudly at the
    // gate, not fall through the launch branches and do something undefined.
    expect(launchableFrameworkIds()).toEqual(['claude', 'codex']);
    expect(launchBlockedReason('hermes')).toMatch(/no launch branch for hermes/);
    expect(launchBlockedReason('claude')).toBeNull();
    expect(launchBlockedReason('nope')).toBe('unknown framework: nope');
  });

  test('hermes carries the approval signal confirmed from upstream cli.py', () => {
    const hermes = getFramework('hermes');
    expect(hermes.signals.blocked.map((s) => s.marker))
      .toEqual(['hermes-dangerous-command', 'hermes-approval-choices']);
    expect(hermes.signals.blocked[0].regex.test('  \u26a0\ufe0f  Dangerous Command')).toBe(true);
    expect(hermes.signals.blocked[1].regex.test('> Allow for this session')).toBe(true);
    // Deliberately empty: no user-visible compaction string was confirmed, and a
    // guessed regex either never fires or fires on the wrong line.
    expect(hermes.signals.compact).toEqual([]);
  });

  test('every manifest carries what an operator needs to see', () => {
    for (const framework of listFrameworks()) {
      expect(framework.displayName, framework.id).toBeTruthy();
      expect(framework.launch.command, framework.id).toBeTruthy();
      expect(Array.isArray(framework.launch.defaultArgs), framework.id).toBe(true);
      expect(framework.launch.permissionSummary, framework.id).toBeTruthy();
    }
  });

  test('lookup is case-insensitive and whitespace-tolerant', () => {
    expect(getFramework('CLAUDE')?.id).toBe('claude');
    expect(getFramework('  codex ')?.id).toBe('codex');
    expect(getFramework('HERMES')?.id).toBe('hermes');
    expect(getFramework('nope')).toBeNull();
    expect(getFramework('')).toBeNull();
  });

  test('adapters are frozen, so a caller cannot mutate shared policy', () => {
    const codex = getFramework('codex');
    expect(Object.isFrozen(codex)).toBe(true);
    expect(Object.isFrozen(codex.launch.defaultArgs)).toBe(true);
    // defaultLaunchArgs must hand out a copy, not the shared array.
    const args = defaultLaunchArgs('codex');
    args.push('--yolo');
    expect(defaultLaunchArgs('codex')).not.toContain('--yolo');
  });
});

describe('which guards apply', () => {
  test('a named framework gets only its own', () => {
    expect(applicableFrameworks('claude').map((f) => f.id)).toEqual(['claude']);
    expect(applicableFrameworks('codex').map((f) => f.id)).toEqual(['codex']);
  });

  test('an unspecified framework gets all of them', () => {
    // Refusing a flag only one framework cares about is harmless; allowing one is not.
    expect(applicableFrameworks('').map((f) => f.id)).toEqual(['claude', 'codex', 'hermes']);
    expect(applicableFrameworks(null).map((f) => f.id)).toEqual(['claude', 'codex', 'hermes']);
  });

  test('KNOWN GAP: an unrecognised framework name gets no guards at all', () => {
    // Pre-existing behaviour, preserved by the refactor rather than endorsed.
    // `--framework hermes --extra-args --yolo` is accepted today. Fixing it is a
    // behaviour change and belongs in its own commit; this test exists so the
    // hole is visible and so that fix is a deliberate edit here, not a surprise.
    expect(applicableFrameworks('not-a-framework')).toEqual([]);
    expect(validateLaunchExtraArgs('not-a-framework', '--yolo').ok).toBe(true);
    expect(validateLaunchExtraArgs('not-a-framework', '--dangerously-skip-permissions').ok).toBe(true);
    // And note the shape of the fix: hermes IS registered now, so it no longer
    // falls in this hole — but it declares no guards of its own, so codex's
    // --yolo still passes for it. Per-framework guards are the real answer.
    expect(validateLaunchExtraArgs('hermes', '--yolo').ok).toBe(true);
  });
});

describe('guardViolation', () => {
  const all = applicableFrameworks('');
  const codex = applicableFrameworks('codex');

  test.each([
    ['--yolo', 'Codex Level 2 policy flag is managed by agent-chat: --yolo'],
    ['--sandbox=danger-full-access', 'Codex Level 2 policy flag is managed by agent-chat: --sandbox=danger-full-access'],
    ['-sfoo', 'Codex Level 2 policy flag is managed by agent-chat: -sfoo'],
    ['--permission-mode', 'Claude permission policy flag is managed by agent-chat: --permission-mode'],
  ])('%s is refused with its own message', (token, reason) => {
    expect(guardViolation(token, '', all)).toEqual({ reason });
  });

  test('an ordinary flag passes', () => {
    expect(guardViolation('--verbose', '', all)).toBeNull();
    expect(guardViolation('--search', '', all)).toBeNull();
  });

  test('config policy is caught in all four spellings', () => {
    expect(guardViolation('-c', 'approval_policy=never', codex).reason)
      .toBe('Codex Level 2 config is managed by agent-chat: approval_policy');
    for (const token of ['--config=sandbox_mode=danger', '-c=sandbox_mode=danger', '-capproval_policy=never']) {
      expect(guardViolation(token, '', codex), token)
        .toEqual({ reason: 'Codex Level 2 config is managed by agent-chat' });
    }
  });

  test('an unrelated config key is allowed through', () => {
    expect(guardViolation('-c', 'unrelated=1', codex)).toBeNull();
    expect(guardViolation('--config=model=x', '', codex)).toBeNull();
  });

  test('a bare -c with no policy value is not itself a violation', () => {
    expect(guardViolation('-c', '', codex)).toBeNull();
  });
});

describe('the refactor changed no behaviour', () => {
  // Captured from the pre-refactor implementation across 9 framework values and
  // 50 argument strings. If a manifest edit changes any observable result, this
  // fails with the exact case. Regenerate ONLY with a deliberate behaviour change.
  const baseline = JSON.parse(readFileSync('tests/fixtures/launch-policy-baseline.json', 'utf8'));
  const SPECIAL = { null: null, undefined: undefined };
  const resolve = (fw) => (fw in SPECIAL ? SPECIAL[fw] : fw);

  test('the fixture is substantial enough to be worth trusting', () => {
    expect(baseline.length).toBeGreaterThan(400);
    expect(baseline.filter((r) => r.out?.ok === false).length).toBeGreaterThan(200);
  });

  test.each(baseline.map((row, i) => [i, row]))('case %i', (_i, row) => {
    if (row.k === 'defaultLaunchArgs') {
      expect(defaultLaunchArgs(resolve(row.fw))).toEqual(row.out);
    } else if (row.k === 'validate') {
      expect(validateLaunchExtraArgs(resolve(row.fw), row.input)).toEqual(row.out);
    } else {
      expect(LAUNCH_PERMISSION_SUMMARY).toEqual(row.out);
    }
  });
});

describe('the remote package ships everything the adapters need', () => {
  // lib/session-policy.js was nearly shipped broken this way: a new import of a
  // managed file, absent from MANAGED_SPECS, leaves remote hosts crashing on an
  // unresolved import and no existing gate notices, because the sync check only
  // compares files that are already listed.
  const build = readFileSync('scripts/build-remote-package.sh', 'utf8');
  const managed = [...build.matchAll(/^\s*"([^:"]+):([^"]+)"$/gm)].map((m) => m[1]);

  test.each(['lib/frameworks/index.js', 'lib/frameworks/claude.json', 'lib/frameworks/codex.json', 'lib/frameworks/hermes.json'])(
    '%s is in MANAGED_SPECS',
    (file) => { expect(managed).toContain(file); },
  );

  test('every local import of a managed .js file is itself managed', () => {
    const missing = [];
    for (const file of managed.filter((f) => f.endsWith('.js') && existsSync(f))) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/^\s*(?:import|export)[^'"]*from\s+['"](\.[^'"]+)['"]/gm)) {
        const resolved = path.normalize(path.join(path.dirname(file), match[1]));
        if (!managed.includes(resolved)) missing.push(`${file} imports ${resolved}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test('the synced copy matches source byte for byte', () => {
    for (const file of ['lib/frameworks/index.js', 'lib/frameworks/claude.json', 'lib/frameworks/codex.json', 'lib/frameworks/hermes.json']) {
      expect(readFileSync(path.join('remote', file), 'utf8'), file).toBe(readFileSync(file, 'utf8'));
    }
  });
});

describe('shell callers read the registry instead of their own list', () => {
  const run = (args) => {
    try {
      return { stdout: execFileSync('node', ['scripts/framework-info.js', ...args], { encoding: 'utf-8' }), code: 0, stderr: '' };
    } catch (error) {
      return { stdout: error.stdout || '', stderr: error.stderr || '', code: error.status };
    }
  };

  test('ids lists every declared framework, launchable or not', () => {
    expect(run(['ids']).stdout.trim().split('\n')).toEqual(['claude', 'codex', 'hermes']);
  });

  test('launchable lists only the ones agent-up can start', () => {
    expect(run(['launchable']).stdout.trim().split('\n')).toEqual(['claude', 'codex']);
  });

  test.each([
    ['claude', 0, ''],
    ['codex', 0, ''],
    ['hermes', 1, /no launch branch for hermes/],
    ['nope', 1, /unknown framework: nope/],
  ])('check %s exits %i', (id, code, stderrMatch) => {
    const result = run(['check', id]);
    expect(result.code).toBe(code);
    if (stderrMatch) expect(result.stderr).toMatch(stderrMatch);
  });

  test('bad usage exits 2, distinct from a refusal', () => {
    // agent-up branches on exit status, so "you called me wrong" must not look
    // like "that framework is not launchable".
    expect(run(['check']).code).toBe(2);
    expect(run(['bogus-command']).code).toBe(2);
  });
});

describe('bin/agent-up defers to the registry', () => {
  const source = readFileSync('bin/agent-up', 'utf-8');

  test('no hardcoded claude|codex list remains in the parser or the gate', () => {
    expect(source).not.toContain('claude|codex)');
    expect(source).not.toMatch(/type must be 'claude' or 'codex'/);
  });

  test('it asks the registry, and checks the helper exists before using it', () => {
    expect(source).toContain('framework-info.js');
    expect(source).toContain('is_known_framework');
    // The existence guard must precede the first use, or a missing helper
    // produces a confusing node error instead of a clear one.
    expect(source.indexOf('missing framework registry helper'))
      .toBeLessThan(source.indexOf('FRAMEWORK_INFO" check'));
  });

  test('a declared-but-unlaunchable framework is refused by name', () => {
    // Not "unrecognized argument": the parser must recognise hermes as a type so
    // the gate can explain why it cannot start it.
    let stderr = '';
    try {
      execFileSync('bash', ['bin/agent-up', 'adapter-gate-probe', os.tmpdir(), 'hermes'],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { stderr = error.stderr || ''; }
    expect(stderr).toMatch(/cannot launch type 'hermes'/);
    expect(stderr).toMatch(/Launchable types: claude codex/);
    expect(stderr).not.toMatch(/unrecognized argument/);
  });

  test('KNOWN GAP: bin/agent-up-v1 still keeps its own list', () => {
    // Legacy path, deliberately not migrated. Pinned so it is a visible debt
    // rather than a surprise for whoever adds the next framework.
    expect(readFileSync('bin/agent-up-v1', 'utf-8')).toContain('claude|codex');
  });
});
