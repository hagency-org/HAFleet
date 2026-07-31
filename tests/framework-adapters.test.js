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

  test('all three are launchable, and an unknown name still is not', () => {
    expect(launchableFrameworkIds()).toEqual(['claude', 'codex', 'hermes']);
    expect(launchBlockedReason('hermes')).toBeNull();
    expect(launchBlockedReason('nope')).toBe('unknown framework: nope');
  });

  test('a framework that types its init prompt must declare how to know the REPL is live', () => {
    // Guards the actual bug this cost: without a readiness signal the keystrokes
    // race process startup and are silently lost.
    const hermes = getFramework('hermes');
    expect(hermes.launch.initPromptDelivery).toBe('keystrokes');
    expect(hermes.signals.ready.length).toBeGreaterThan(0);
  });

  test('each ready pattern agrees with its own grep -F literal', () => {
    // bin/agent-up greps for the literal while the backend uses the regex. If
    // they drift, the shell waits for something the manifest no longer means.
    for (const framework of listFrameworks()) {
      for (const signal of framework.signals.ready) {
        expect(typeof signal.fixed, `${framework.id}/${signal.marker}`).toBe('string');
        expect(signal.regex.test(signal.fixed), `${framework.id}/${signal.marker}`).toBe(true);
      }
    }
  });

  test('hermes carries the approval signal confirmed from upstream cli.py', () => {
    const hermes = getFramework('hermes');
    expect(hermes.signals.blocked.map((s) => s.marker))
      .toEqual(['hermes-dangerous-command', 'hermes-approval-choices']);
    expect(hermes.signals.blocked[0].regex.test('  \u26a0\ufe0f  Dangerous Command')).toBe(true);
    expect(hermes.signals.blocked[1].regex.test('> Allow for this session')).toBe(true);
    // Confirmed at agent/conversation_loop.py:4770 in the upstream checkout:
    // agent._safe_print("  \u27f3 compacting context\u2026")
    expect(hermes.signals.compact.map((s) => s.marker)).toEqual(['hermes-context-compacted']);
    const compact = hermes.signals.compact[0].regex;
    expect(compact.test('  \u27f3 compacting context\u2026')).toBe(true);
    // Must NOT fire on the two lines that look like matches but are not: one
    // sizes a startup banner, the other is prose inside a system prompt.
    expect(compact.test('def _build_compact_banner() -> str:')).toBe(false);
    expect(compact.test(' \u2014 keep entries compact and high-signal.')).toBe(false);
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
    // hermes is registered AND declares its own guards, so it is out of this
    // hole entirely — see the hermes guard test below.
    expect(validateLaunchExtraArgs('hermes', '--yolo').ok).toBe(false);
  });
});

describe('hermes guards its own bypass flags', () => {
  // `hermes --help` documents --yolo as "Bypass all dangerous command approval
  // prompts" and --accept-hooks as auto-approving unseen shell hooks with no TTY
  // prompt. Those prompts are exactly what HAFleet scrapes for to notice a
  // blocked agent, so an agent must not be able to turn them off.
  test.each(['--yolo', '--accept-hooks'])('%s is refused', (flag) => {
    const result = validateLaunchExtraArgs('hermes', flag);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(`Hermes approval policy flag is managed by agent-chat: ${flag}`);
  });

  test.each(['--safe-mode', '--ignore-user-config', '--ignore-rules', '--tui', '-m gpt-5'])(
    '%s is allowed — it narrows behaviour or skips context, it does not widen permissions',
    (args) => { expect(validateLaunchExtraArgs('hermes', args).ok).toBe(true); },
  );

  test('hermes passes no default policy args, because prompting is already the default', () => {
    expect(defaultLaunchArgs('hermes')).toEqual([]);
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

  test('launchable lists the ones agent-up can start', () => {
    expect(run(['launchable']).stdout.trim().split('\n')).toEqual(['claude', 'codex', 'hermes']);
  });

  test.each([
    ['claude', 0, ''],
    ['codex', 0, ''],
    ['hermes', 0, ''],
    ['nope', 1, /unknown framework: nope/],
  ])('check %s exits %i', (id, code, stderrMatch) => {
    const result = run(['check', id]);
    expect(result.code).toBe(code);
    if (stderrMatch) expect(result.stderr).toMatch(stderrMatch);
  });

  test('ready-fixed prints the literal agent-up greps for', () => {
    expect(run(['ready-fixed', 'hermes']).stdout).toBe('\u276f');
    // claude passes its prompt as an argument, so it declares no ready signal.
    expect(run(['ready-fixed', 'claude']).code).toBe(1);
  });

  test('bad usage exits 2, distinct from a refusal', () => {
    // agent-up branches on exit status, so "you called me wrong" must not look
    // like "that framework is not launchable".
    expect(run(['check']).code).toBe(2);
    expect(run(['bogus-command']).code).toBe(2);
  });
});

describe('the extra-args validator defers to the registry', () => {
  const validate = (fw, args) => {
    try {
      return { stdout: execFileSync('node', ['scripts/validate-agent-launch-extra-args.js', fw, args], { encoding: 'utf-8' }), code: 0, stderr: '' };
    } catch (error) {
      return { stdout: error.stdout || '', stderr: error.stderr || '', code: error.status };
    }
  };

  test.each(['claude', 'codex', 'hermes'])('%s is accepted', (fw) => {
    expect(validate(fw, '--verbose').code).toBe(0);
  });

  test.each(['bogus', ''])('an unknown framework (%p) exits 2', (fw) => {
    // Load-bearing: validateLaunchExtraArgs applies NO guards to a non-empty
    // framework it does not recognise, so letting an unknown name through here
    // would let every policy flag through with it.
    const result = validate(fw, '--yolo');
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/unsupported framework for launch policy/);
  });

  test('a known framework still has its own guards applied', () => {
    expect(validate('hermes', '--yolo').stderr).toMatch(/Hermes approval policy flag is managed/);
    expect(validate('codex', '--yolo').stderr).toMatch(/Codex Level 2 policy flag is managed/);
    expect(validate('claude', '--permission-mode').stderr).toMatch(/Claude permission policy flag is managed/);
  });

  test('it no longer keeps its own framework list', () => {
    const source = readFileSync('scripts/validate-agent-launch-extra-args.js', 'utf-8');
    expect(source).not.toMatch(/framework !== 'claude'/);
    expect(source).toContain('getFramework');
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

  test('hermes now passes the gate as a launchable type', () => {
    // It must get past parsing AND the gate. It will fail later for want of an
    // agent token, which is proof it reached the real launch path.
    let stderr = '';
    try {
      execFileSync('bash', ['bin/agent-up', 'adapter-gate-probe', os.tmpdir(), 'hermes'],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { stderr = error.stderr || ''; }
    expect(stderr).not.toMatch(/unrecognized argument/);
    expect(stderr).not.toMatch(/cannot launch type/);
  });

  describe('the hermes branch', () => {
    const branch = source.slice(source.indexOf('elif [ "$TYPE" = "hermes" ]'));
    const body = branch.slice(0, branch.indexOf('capture_resume_id_background'));

    test('waits for the input prompt, not for the pane to hold still', () => {
      // Measured: a stability check reports ready ~1s in on a pane holding only
      // the echoed launch command, and the pane also goes BLANK part way through
      // startup — so "unchanged" is true twice before the REPL exists.
      expect(body).toContain('ready-fixed hermes');
      expect(body).toContain('grep -qF');
      expect(body).toContain('--cli');
      expect(body).toContain('send-keys');
    });

    test('refuses to type rather than typing into an unknown state', () => {
      expect(body).toMatch(/did not appear within/);
      expect(body).toMatch(/exit 1/);
    });

    test('the skin-dependent marker is overridable', () => {
      // branding.prompt_symbol in hermes_cli/skin_engine.py is a skin setting, so
      // a custom skin would otherwise make launch impossible with no way out.
      expect(body).toContain('AGENTCHAT_HERMES_READY_MARKER');
      expect(body).toContain('AGENTCHAT_HERMES_READY_TIMEOUT_SEC');
    });

    test('the failure message tells the operator how to fix it', () => {
      expect(body).toMatch(/custom Hermes skin/);
      expect(body).toMatch(/tmux attach/);
    });

    test('the timeout override is validated before any arithmetic', () => {
      // Under `set -u` — which agent-up runs with — $(( abc * 2 )) aborts the
      // whole script with "abc: unbound variable". Measured, not theorised.
      const guard = body.indexOf('*[!0-9]*');
      const arithmetic = body.indexOf('HERMES_READY_TIMEOUT * 2');
      expect(guard).toBeGreaterThan(-1);
      expect(guard).toBeLessThan(arithmetic);
      expect(body).toMatch(/-ge 1 \] \|\| HERMES_READY_TIMEOUT=60/);
    });

    test('hostile timeout overrides fall back instead of aborting or executing', () => {
      const script = `
        set -euo pipefail
        HERMES_READY_TIMEOUT="\${AGENTCHAT_HERMES_READY_TIMEOUT_SEC:-60}"
        case "$HERMES_READY_TIMEOUT" in
          ""|*[!0-9]*) HERMES_READY_TIMEOUT=60 ;;
        esac
        [ "$HERMES_READY_TIMEOUT" -ge 1 ] || HERMES_READY_TIMEOUT=60
        echo $(( HERMES_READY_TIMEOUT * 2 ))`;
      for (const value of ['abc', '-5', '0', '', '7; echo pwned', '9'.repeat(21)]) {
        const out = execFileSync('bash', ['-c', script], {
          encoding: 'utf-8',
          env: { ...process.env, AGENTCHAT_HERMES_READY_TIMEOUT_SEC: value },
        }).trim();
        expect(out, `override ${JSON.stringify(value)}`).toBe('120');
      }
      // A valid value is still honoured.
      expect(execFileSync('bash', ['-c', script], {
        encoding: 'utf-8',
        env: { ...process.env, AGENTCHAT_HERMES_READY_TIMEOUT_SEC: '5' },
      }).trim()).toBe('10');
    });
  });

  test('KNOWN GAP: bin/agent-up-v1 still keeps its own list', () => {
    // Legacy path, deliberately not migrated. Pinned so it is a visible debt
    // rather than a surprise for whoever adds the next framework.
    expect(readFileSync('bin/agent-up-v1', 'utf-8')).toContain('claude|codex');
  });
});
