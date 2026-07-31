import { describe, expect, test } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

import {
  applicableFrameworks, frameworkIds, getFramework, guardViolation, listFrameworks,
} from '../lib/frameworks/index.js';
import {
  defaultLaunchArgs, validateLaunchExtraArgs, LAUNCH_PERMISSION_SUMMARY,
} from '../lib/agent-launch-policy.js';

describe('the registry loads and validates its manifests', () => {
  test('ships claude and codex, in a stable order', () => {
    // Order is contractual: it decides nothing today because the two guard sets
    // are disjoint, but a future adapter could overlap.
    expect(frameworkIds()).toEqual(['claude', 'codex']);
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
    expect(getFramework('hermes')).toBeNull();
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
    expect(applicableFrameworks('').map((f) => f.id)).toEqual(['claude', 'codex']);
    expect(applicableFrameworks(null).map((f) => f.id)).toEqual(['claude', 'codex']);
  });

  test('KNOWN GAP: an unrecognised framework name gets no guards at all', () => {
    // Pre-existing behaviour, preserved by the refactor rather than endorsed.
    // `--framework hermes --extra-args --yolo` is accepted today. Fixing it is a
    // behaviour change and belongs in its own commit; this test exists so the
    // hole is visible and so that fix is a deliberate edit here, not a surprise.
    expect(applicableFrameworks('hermes')).toEqual([]);
    expect(validateLaunchExtraArgs('hermes', '--yolo').ok).toBe(true);
    expect(validateLaunchExtraArgs('hermes', '--dangerously-skip-permissions').ok).toBe(true);
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

  test.each(['lib/frameworks/index.js', 'lib/frameworks/claude.json', 'lib/frameworks/codex.json'])(
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
    for (const file of ['lib/frameworks/index.js', 'lib/frameworks/claude.json', 'lib/frameworks/codex.json']) {
      expect(readFileSync(path.join('remote', file), 'utf8'), file).toBe(readFileSync(file, 'utf8'));
    }
  });
});
