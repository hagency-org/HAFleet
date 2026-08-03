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
    expect(frameworkIds()).toEqual(['claude', 'codex-acp', 'codex', 'hermes', 'octos']);
  });

  test('only the tmux frameworks are hafleet-up launchable', () => {
    // "Launchable" here means launchable by hafleet-up, which creates a tmux
    // session. An ACP agent has no pane, so octos and now hermes are blocked from
    // that path and started with `hafleet acp-up` instead. hermes moved when its
    // transport changed; leaving it launchable meant hafleet-up would look for a
    // ready signal the adapter no longer declares and fail with "no ready signal
    // declared for hermes", which reads as a missing field rather than a
    // deliberate change of transport.
    expect(launchableFrameworkIds()).toEqual(['claude', 'codex']);
    expect(launchBlockedReason('nope')).toBe('unknown framework: nope');
  });

  test('every ACP framework is blocked from the tmux launcher, with a reason that names acp-up', () => {
    // Stated as an invariant over the registry rather than a list, so the next
    // adapter to move to ACP cannot be half-migrated.
    for (const framework of listFrameworks()) {
      if (framework.transport !== 'acp') continue;
      const reason = launchBlockedReason(framework.id);
      expect(reason, `${framework.id} is ACP but still hafleet-up launchable`).toBeTruthy();
      expect(reason).toContain('acp-up');
      expect(reason).toContain(framework.id);
    }
  });

  test('a framework that types its init prompt must declare how to know the REPL is live', () => {
    // Guards the actual bug this cost: without a readiness signal the keystrokes
    // race process startup and are silently lost.
    //
    // No framework types its init prompt today — hermes was the last and moved to
    // ACP, where the prompt is a session/prompt request with nothing to time. The
    // rule still has to hold for whichever framework needs it next, so this asserts
    // the invariant across the registry rather than naming one adapter.
    for (const framework of listFrameworks()) {
      if (framework.launch.initPromptDelivery !== 'keystrokes') continue;
      expect(framework.signals.ready.length,
        `${framework.id} types its init prompt but declares no readiness signal`)
        .toBeGreaterThan(0);
    }
  });

  test('each ready pattern agrees with its own grep -F literal', () => {
    // bin/hafleet-up greps for the literal while the backend uses the regex. If
    // they drift, the shell waits for something the manifest no longer means.
    for (const framework of listFrameworks()) {
      for (const signal of framework.signals.ready) {
        expect(typeof signal.fixed, `${framework.id}/${signal.marker}`).toBe('string');
        expect(signal.regex.test(signal.fixed), `${framework.id}/${signal.marker}`).toBe(true);
      }
    }
  });

  test('hermes keeps its hard-won tmux signals on record after moving to ACP', () => {
    // These cost a reading of upstream cli.py and conversation_loop.py to establish.
    // hermes now runs over ACP, where pane signals are meaningless and the registry
    // rejects them — but deleting them would throw away the research if the tmux
    // path is ever needed again, so they are retired rather than removed.
    const hermes = getFramework('hermes');
    expect(hermes.transport).toBe('acp');
    expect(hermes.signals.blocked).toEqual([]);
    const retired = hermes.raw.signals.retiredTmuxSignals;
    // Raw manifest entries carry `re`; the compiler renames it to `regex`. Reading
    // the wrong one yields `new RegExp(undefined)` — an empty pattern that matches
    // everything, so every positive assertion below would pass vacuously. Only the
    // negative assertion at the end catches that, which is why it is here.
    expect(retired.blocked.map((s) => s.marker))
      .toEqual(['hermes-dangerous-command', 'hermes-approval-choices']);
    expect(new RegExp(retired.blocked[0].re).test('  \u26a0\ufe0f  Dangerous Command')).toBe(true);
    expect(new RegExp(retired.blocked[1].re).test('> Allow for this session')).toBe(true);
    // Confirmed at agent/conversation_loop.py:4770 in the upstream checkout:
    // agent._safe_print("  \u27f3 compacting context\u2026")
    expect(retired.compact.map((s) => s.marker)).toEqual(['hermes-context-compacted']);
    const compact = new RegExp(retired.compact[0].re);
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
    expect(applicableFrameworks('').map((f) => f.id)).toEqual(['claude', 'codex-acp', 'codex', 'hermes', 'octos']);
    expect(applicableFrameworks(null).map((f) => f.id)).toEqual(['claude', 'codex-acp', 'codex', 'hermes', 'octos']);
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
    expect(result.reason).toBe(`Hermes approval policy flag is managed by hafleet: ${flag}`);
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
    ['--yolo', 'Codex Level 2 policy flag is managed by hafleet: --yolo'],
    ['--sandbox=danger-full-access', 'Codex Level 2 policy flag is managed by hafleet: --sandbox=danger-full-access'],
    ['-sfoo', 'Codex Level 2 policy flag is managed by hafleet: -sfoo'],
    ['--permission-mode', 'Claude permission policy flag is managed by hafleet: --permission-mode'],
  ])('%s is refused with its own message', (token, reason) => {
    expect(guardViolation(token, '', all)).toEqual({ reason });
  });

  test('an ordinary flag passes', () => {
    expect(guardViolation('--verbose', '', all)).toBeNull();
    expect(guardViolation('--search', '', all)).toBeNull();
  });

  test('config policy is caught in all four spellings', () => {
    expect(guardViolation('-c', 'approval_policy=never', codex).reason)
      .toBe('Codex Level 2 config is managed by hafleet: approval_policy');
    for (const token of ['--config=sandbox_mode=danger', '-c=sandbox_mode=danger', '-capproval_policy=never']) {
      expect(guardViolation(token, '', codex), token)
        .toEqual({ reason: 'Codex Level 2 config is managed by hafleet' });
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
    expect(run(['ids']).stdout.trim().split('\n')).toEqual(['claude', 'codex-acp', 'codex', 'hermes', 'octos']);
  });

  test('launchable lists the ones hafleet-up can start', () => {
    // hermes left this list when it moved to ACP; the ACP pair is started by
    // `hafleet acp-up`, which does not consult this gate.
    expect(run(['launchable']).stdout.trim().split('\n')).toEqual(['claude', 'codex']);
  });

  test.each([
    ['claude', 0, ''],
    ['codex', 0, ''],
    ['hermes', 1, /acp-up <name> <workspace> hermes/],
    ['octos', 1, /acp-up <name> <workspace> octos/],
    ['nope', 1, /unknown framework: nope/],
  ])('check %s exits %i', (id, code, stderrMatch) => {
    const result = run(['check', id]);
    expect(result.code).toBe(code);
    if (stderrMatch) expect(result.stderr).toMatch(stderrMatch);
  });

  test('ready-fixed refuses for frameworks with no readiness signal', () => {
    // hermes was the one framework that printed a literal here; on ACP it has no
    // pane and no marker, so it now refuses like the others. Kept as a test rather
    // than deleted because hafleet-up branches on this exit status — a framework
    // that starts declaring a ready pattern must start printing one.
    expect(run(['ready-fixed', 'hermes']).code).toBe(1);
    // claude passes its prompt as an argument, so it declares no ready signal.
    expect(run(['ready-fixed', 'claude']).code).toBe(1);
    // The command still works for anything that does declare one.
    const withReady = ['claude', 'codex-acp', 'codex', 'hermes', 'octos']
      .map((id) => run(['ready-fixed', id]))
      .filter((r) => r.code === 0);
    for (const r of withReady) expect(r.stdout.length).toBeGreaterThan(0);
  });

  test('bad usage exits 2, distinct from a refusal', () => {
    // hafleet-up branches on exit status, so "you called me wrong" must not look
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

describe('bin/hafleet-up defers to the registry', () => {
  const source = readFileSync('bin/hafleet-up', 'utf-8');

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

  test('a declared framework is recognised by the parser, not called unrecognized', () => {
    // Uses octos deliberately: it is declared but launchable:false, so it proves
    // the parser recognises a registry name AND the gate refuses it by reason —
    // without starting anything. The earlier version of this test used hermes,
    // which became genuinely launchable, so it launched a real agent inside the
    // suite and blocked on its readiness wait until the run timed out.
    let stderr = '';
    try {
      execFileSync('bash', ['bin/hafleet-up', 'registry-gate-probe', os.tmpdir(), 'octos'],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    } catch (error) { stderr = error.stderr || ''; }
    expect(stderr).not.toMatch(/unrecognized argument/);
    expect(stderr).toMatch(/cannot launch type 'octos'/);
    expect(stderr).toMatch(/hafleet acp-up/);
    expect(stderr).toMatch(/Launchable types: claude codex/);
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
      expect(body).toContain('HAFLEET_HERMES_READY_MARKER');
      expect(body).toContain('HAFLEET_HERMES_READY_TIMEOUT_SEC');
    });

    test('the failure message tells the operator how to fix it', () => {
      expect(body).toMatch(/custom Hermes skin/);
      expect(body).toMatch(/tmux attach/);
    });

    test('the timeout override is validated before any arithmetic', () => {
      // Under `set -u` — which hafleet-up runs with — $(( abc * 2 )) aborts the
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
        HERMES_READY_TIMEOUT="\${HAFLEET_HERMES_READY_TIMEOUT_SEC:-60}"
        case "$HERMES_READY_TIMEOUT" in
          ""|*[!0-9]*) HERMES_READY_TIMEOUT=60 ;;
        esac
        [ "$HERMES_READY_TIMEOUT" -ge 1 ] || HERMES_READY_TIMEOUT=60
        echo $(( HERMES_READY_TIMEOUT * 2 ))`;
      for (const value of ['abc', '-5', '0', '', '7; echo pwned', '9'.repeat(21)]) {
        const out = execFileSync('bash', ['-c', script], {
          encoding: 'utf-8',
          env: { ...process.env, HAFLEET_HERMES_READY_TIMEOUT_SEC: value },
        }).trim();
        expect(out, `override ${JSON.stringify(value)}`).toBe('120');
      }
      // A valid value is still honoured.
      expect(execFileSync('bash', ['-c', script], {
        encoding: 'utf-8',
        env: { ...process.env, HAFLEET_HERMES_READY_TIMEOUT_SEC: '5' },
      }).trim()).toBe('10');
    });
  });

  test('KNOWN GAP: bin/hafleet-up-v1 still keeps its own list', () => {
    // Legacy path, deliberately not migrated. Pinned so it is a visible debt
    // rather than a surprise for whoever adds the next framework.
    expect(readFileSync('bin/hafleet-up-v1', 'utf-8')).toContain('claude|codex');
  });
});

describe('the codex-acp adapter', () => {
  const acp = getFramework('codex-acp');
  const codex = getFramework('codex');

  test('is a separate adapter from codex, not a mutation of it', () => {
    // codex-agent is a working production agent on tmux. Folding an untested
    // transport into its manifest would put it behind a code path nobody has run.
    expect(codex.transport ?? 'tmux').toBe('tmux');
    expect(codex.launchable).toBe(true);
    expect(acp.transport).toBe('acp');
    expect(acp.launchable).toBe(false);
  });

  test('it inherits codex\'s guards verbatim rather than restating them', () => {
    // Same underlying CLI, so the same flags must stay blocked. Two hand-written
    // copies of a security guard is how one of them gets missed. Compared on .raw
    // because the compiled object exposes flagGuard/configGuard, not guards.
    expect(acp.raw.guards).toEqual(codex.raw.guards);
  });

  test('the inherited guards are live, not just present in the manifest', () => {
    // Stronger than asserting the strings are there: drive the compiled guard and
    // check it actually refuses. A manifest can carry a flag list that never got
    // wired into flagGuard, and the string assertion would still pass.
    // guardViolation takes the applicable-framework list, not a single manifest.
    const acpScope = applicableFrameworks('codex-acp');
    const codexScope = applicableFrameworks('codex');
    for (const flag of ['--yolo', '--dangerously-bypass-approvals-and-sandbox', '--full-auto']) {
      expect(guardViolation(flag, '', acpScope), `${flag} is not blocked for codex-acp`).toBeTruthy();
      // And blocked for the same reason as on the tmux adapter.
      expect(guardViolation(flag, '', acpScope)).toEqual(guardViolation(flag, '', codexScope));
    }
    expect(guardViolation('--verbose', '', acpScope)).toBeNull();
  });

  test('it declares no cwd flag, because the adapter takes none', () => {
    // Verified against codex-acp 1.1.9: cwd rides session/new. octos is the only
    // adapter that wants --cwd.
    expect(acp.launch.acpCwdFlag ?? null).toBeNull();
    expect(getFramework('octos').launch.acpCwdFlag).toBe('--cwd');
  });

  test('mcpServers support is recorded as observed, not inferred', () => {
    // It advertises mcpCapabilities {acp:false, http:true, sse:false}, which is a
    // different question from "does it honour a stdio server in session/new" —
    // the one octos failed by accepting the field and spawning nothing. Confirmed
    // by seeing mcp-server.js running with codex as its parent, then by the agent
    // calling check_inbox and replying.
    expect(acp.raw.acp.honorsMcpServers).toBe(true);
    expect(acp.raw.acp.mcpServersNote).toMatch(/Verified live/);
    expect(acp.raw.acp.verifiedEndToEnd).toMatch(/check_inbox/);
  });

  test('it records that this adapter asks permission, because octos does not', () => {
    // The distinguishing behaviour, and the one that cost a full debug cycle: a
    // client that does not answer session/request_permission hangs the agent.
    expect(acp.raw.acp.permissionNote).toMatch(/session\/request_permission/);
    expect(acp.raw.acp.permissionNote).toMatch(/octos never asks/);
  });

  test('it is honest that it is an adapter, not the vendor speaking ACP', () => {
    expect(acp.launch.commandNote).toMatch(/adapter, not codex itself/);
    expect(acp.launch.command).toBe('codex-acp');
  });
});
