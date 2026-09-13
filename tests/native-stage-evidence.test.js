import { afterEach, describe, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { promisify } from 'node:util';
import { stageFixture } from './fixtures/native-stage-fixture.mjs';
import {
  observeStageObserver,
  validateStagePlan,
  verifyStageEvidence,
} from '../skills/hagency-inner-loop/scripts/native-stage-evidence.mjs';

const ioFault = vi.hoisted(() => ({ target: null, mode: null }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, readFileSync(file, ...args) {
    const raw = actual.readFileSync(file, ...args);
    if (typeof file === 'number' && ioFault.target !== null) {
      const opened = actual.fstatSync(file);
      const target = actual.lstatSync(ioFault.target);
      if (opened.dev === target.dev && opened.ino === target.ino) {
        actual.chmodSync(ioFault.target, ioFault.mode);
        ioFault.target = null;
      }
    }
    return raw;
  } };
});

const execute = promisify(execFile);
const fixtures = [];

afterEach(async () => {
  ioFault.target = null;
  ioFault.mode = null;
  await Promise.all(fixtures.splice(0).map(fixture => fixture.dispose()));
});

describe('native stage evidence fixture', () => {
  test.each(['interrupt03', 'restart04'])('provides a real isolated %s stage plan and observer', async stage => {
    const fixture = stageFixture(stage);
    fixtures.push(fixture);

    expect(fixture.plan.stage).toBe(stage);
    expect(fixture.release).toBe(`${fixture.root}/business project/.autonomy/stage${stage === 'interrupt03' ? '03' : '04'}-release.json`);
    expect(fixture.activation).toBe(`${fixture.plan.attempt_manifest.path.replace(/\/attempt\.json$/, '')}/activation-${stage}`);
    expect(fixture.observerRoot).toBe(`${path.dirname(fixture.plan.attempt_manifest.path)}/fault-observer/${stage}`);
    expect(existsSync(fixture.activation)).toBe(false);

    const state = fixture.readState();
    expect(state.rows).toContainEqual(expect.objectContaining({ pid: fixture.plan.observer.pid }));
    expect(state.observerMetadata).toEqual({
      version: 1,
      pid: fixture.plan.observer.pid,
      cwd: fixture.plan.observer.cwd,
      argv: fixture.plan.observer.argv,
    });
    expect(state.mode).toBe('success');
    expect(fixture.plan.binding.pane_id).toBe('wA:pC');
    expect(lstatSync(fixture.plan.binding.frontend_binary.path).mode & 0o777).toBe(0o755);

    const birth = await execute(fixture.plan.binding.birth_tool.path, [], { encoding: 'utf8' });
    expect(JSON.parse(birth.stdout).processes).toContainEqual(expect.objectContaining({ pid: fixture.plan.observer.pid }));
    const metadata = await execute(fixture.plan.metadata_tool.path, ['--pid', String(fixture.plan.observer.pid)], { encoding: 'utf8' });
    expect(JSON.parse(metadata.stdout)).toEqual(state.observerMetadata);
  });

  test('records real resume receipt only after intent and release exist', async () => {
    const fixture = stageFixture('interrupt03');
    fixtures.push(fixture);
    mkdirSync(fixture.activation, { mode: 0o700 });
    writeFileSync(`${fixture.activation}/intent.json`, '{}\n', { mode: 0o400 });
    writeFileSync(fixture.release, '{}\n', { mode: 0o400 });
    const b = fixture.plan.binding;

    await execute(b.herdr.path, [
      '--session', b.herdr_session, 'agent', 'prompt', b.lower_agent, '/goal resume',
    ], { encoding: 'utf8' });

    expect(fixture.sent()).toEqual(['/goal resume']);
  });
});

const make = stage => {
  const fixture = stageFixture(stage);
  fixtures.push(fixture);
  return fixture;
};

function thrown(fn) {
  try { fn(); } catch (error) { return error; }
  throw new Error('expected failure');
}

function writePinnedJson(file, value) {
  const raw = Buffer.from(`${JSON.stringify(value)}\n`);
  chmodSync(file, 0o600);
  writeFileSync(file, raw);
  chmodSync(file, 0o444);
  return { path: file, sha256: createHash('sha256').update(raw).digest('hex') };
}

function rewriteLineage(fixture, name, mutate) {
  const manifest = JSON.parse(readFileSync(fixture.plan.attempt_manifest.path, 'utf8'));
  const contract = JSON.parse(readFileSync(manifest.recovery_contract.path, 'utf8'));
  const predecessor = JSON.parse(readFileSync(manifest.predecessors[name].path, 'utf8'));
  mutate(predecessor);
  const nextPredecessor = writePinnedJson(manifest.predecessors[name].path, predecessor);
  manifest.predecessors[name] = nextPredecessor;
  contract.predecessors[name] = nextPredecessor;
  manifest.recovery_contract = writePinnedJson(manifest.recovery_contract.path, contract);
  fixture.plan.attempt_manifest = writePinnedJson(fixture.plan.attempt_manifest.path, manifest);
}

function rewriteObserverBinding(fixture, mutate) {
  const value = JSON.parse(readFileSync(fixture.plan.observer_binding.path, 'utf8'));
  mutate(value);
  fixture.plan.observer_binding = writePinnedJson(fixture.plan.observer_binding.path, value);
  writePinnedJson(path.join(fixture.observerRoot, 'binding.json'), value);
}

describe('native stage evidence validation', () => {
  test('accepts an alphanumeric native window and pane identity', () => {
    const fixture = make('interrupt03');
    chmodSync(fixture.plan.binding.frontend_binary.path, 0o555);
    expect(fixture.plan.binding.pane_id).toBe('wA:pC');
    expect(() => validateStagePlan(fixture.plan)).not.toThrow();
  });

  test('accepts a pinned owner-writable frontend executable', () => {
    const fixture = make('interrupt03');
    expect(lstatSync(fixture.plan.binding.frontend_binary.path).mode & 0o777).toBe(0o755);
    expect(() => validateStagePlan(fixture.plan)).not.toThrow();
  });

  test.each(['interrupt03', 'restart04'])('accepts and retains the complete %s evidence graph', stage => {
    const fixture = make(stage);
    const context = validateStagePlan(fixture.plan);
    expect(context.plan).toEqual(fixture.plan);
    expect(context.plan).not.toBe(fixture.plan);
    expect(context).toMatchObject({
      attempt_path: path.dirname(fixture.plan.attempt_manifest.path),
      activation_path: fixture.activation,
      release_path: fixture.release,
      observer_root: fixture.observerRoot,
    });
    expect(context.directory_identities).toBeInstanceOf(Array);
    expect(() => verifyStageEvidence(context)).not.toThrow();
  });

  test.each([
    ['extra plan key', plan => { plan.foreign = true; }],
    ['wrong stage loop shape', plan => { plan.expected_loop = {}; }],
    ['duplicate child id', plan => { plan.child_operations.goal_resume = plan.activation_id; }],
    ['wrong controller path', plan => { plan.controller_tools.controller.path = plan.controller_tools.evidence.path; }],
    ['foreign observer namespace', plan => { plan.observer_claim.path = plan.observer_ready.path; }],
    ['foreign observer argv', plan => { plan.observer.argv[2] = `${plan.observer.argv[2]}.foreign`; }],
    ['changed frozen binding field', plan => {
      plan.binding.frontend.argv[plan.binding.frontend.argv.length - 1] = 'foreign stdio command';
    }],
    ['incomplete protected set', plan => { delete plan.protected[Object.keys(plan.protected)[0]]; }],
  ])('rejects malformed static plans: %s', (_name, mutate) => {
    const fixture = make('interrupt03');
    mutate(fixture.plan);
    const error = thrown(() => validateStagePlan(fixture.plan));
    expect(error.message).not.toContain(fixture.readState().secret);
    expect(error.message).not.toContain(fixture.readState().goal.objective);
  });

  test.each(['same increment', 'cross increment'])(
    'rejects protected capture reuse: %s', mode => {
      const fixture = make('interrupt03');
      const first = JSON.parse(readFileSync(path.join(fixture.plan.binding.project, '.autonomy/red-green/01.json')));
      const secondPath = '.autonomy/red-green/02.json';
      const second = JSON.parse(readFileSync(path.join(fixture.plan.binding.project, secondPath)));
      const removed = [];
      fixture.rewritePin(secondPath, value => {
        if (mode === 'same increment') {
          removed.push(value.green_capture_path);
          value.green_capture_path = value.red_capture_path;
        } else {
          removed.push(value.red_capture_path, value.green_capture_path);
          value.red_capture_path = first.red_capture_path;
          value.green_capture_path = first.green_capture_path;
        }
      });
      expect(second.red_capture_path).not.toBe(second.green_capture_path);
      for (const file of removed) {
        delete fixture.plan.protected[path.relative(fixture.plan.binding.project, file).split(path.sep).join('/')];
      }
      expect(() => validateStagePlan(fixture.plan)).toThrow();
    },
  );

  test.each([
    ['readonly helper', fixture => fixture.plan.frozen_helpers.observer.path, 0o644],
    ['executable tool', fixture => fixture.plan.metadata_tool.path, 0o444],
  ])('rejects post-read permission changes for a %s', (_name, target, mode) => {
    const fixture = make('interrupt03');
    ioFault.target = target(fixture);
    ioFault.mode = mode;
    expect(() => validateStagePlan(fixture.plan)).toThrow();
  });

  test.each(['missing', 'unequal'])('rejects %s predecessor watch deadline linkage', mode => {
    const fixture = make('interrupt03');
    if (mode === 'missing') rewriteLineage(fixture, 'audit', value => { delete value.immutable_deadline_at; });
    else rewriteLineage(fixture, 'audit', value => { value.immutable_deadline_at += 1; });
    expect(() => validateStagePlan(fixture.plan)).toThrow();
  });

  test.each([
    ['uppercase child UUID', fixture => {
      fixture.plan.child_operations.goal_resume = fixture.plan.child_operations.goal_resume.toUpperCase();
    }],
    ['invalid loop ID', fixture => {
      fixture.plan.expected_loop.loop_id = '.invalid';
      rewriteObserverBinding(fixture, value => { value.loop_id = '.invalid'; });
    }, 'restart04'],
    ['control character in binding text', fixture => { fixture.plan.binding.terminal_id = 'bad\nterminal'; }],
    ['duplicate native PID', fixture => {
      fixture.plan.binding.shell_pid = fixture.plan.binding.frontend.pid;
      fixture.plan.binding.frontend.ppid = fixture.plan.binding.frontend.pid;
      rewriteObserverBinding(fixture, value => {
        value.shell_pid = value.frontend.pid;
        value.frontend.ppid = value.frontend.pid;
      });
    }],
  ])('rejects downstream-invalid plans before a stage claim: %s', (_name, mutate, stage = 'interrupt03') => {
    const fixture = make(stage);
    mutate(fixture);
    expect(() => validateStagePlan(fixture.plan)).toThrow();
  });

  test.each(['same', 'inside'])('rejects a complete graph with %s project/control placement', placement => {
    const fixture = stageFixture('interrupt03', { controlPlacement: placement });
    fixtures.push(fixture);
    expect(() => validateStagePlan(fixture.plan)).toThrow();
  });

  test.each(['attempt_manifest', 'prepared', 'observer_binding', 'observer_claim', 'observer_ready']) (
    'rejects a changed pinned lineage input: %s', key => {
      const fixture = make('interrupt03');
      const context = validateStagePlan(fixture.plan);
      fixture.rewritePin(key, value => ({ ...value, fixture_changed: true }));
      expect(() => verifyStageEvidence(context)).toThrow();
    },
  );

  test.each(['frozen_helpers.observer', 'frozen_helpers.adapter', 'protected']) (
    'rejects changed helper or protected bytes: %s', key => {
      const fixture = make('interrupt03');
      const context = validateStagePlan(fixture.plan);
      const pinName = key === 'protected' ? Object.keys(fixture.plan.protected)[0] : key;
      fixture.rewritePin(pinName, value => Buffer.isBuffer(value)
        ? Buffer.concat([value, Buffer.from('\n')]) : { ...value, fixture_changed: true });
      expect(() => verifyStageEvidence(context)).toThrow();
    },
  );

  test('allows complete JSONL append beyond both retained trace prefixes', () => {
    const fixture = make('interrupt03');
    const context = validateStagePlan(fixture.plan);
    writeFileSync(fixture.trace, Buffer.concat([readFileSync(fixture.trace), Buffer.from('{"new":"record"}\n')]));
    expect(() => verifyStageEvidence(context)).not.toThrow();
  });

  test('rejects retained trace changes, root replacement, and preexisting window outputs', () => {
    for (const mode of ['trace', 'root', 'window']) {
      const fixture = make('interrupt03');
      const context = validateStagePlan(fixture.plan);
      if (mode === 'trace') {
        const raw = readFileSync(fixture.trace);
        raw[0] ^= 1;
        writeFileSync(fixture.trace, raw);
      }
      if (mode === 'root') {
        // Replacing a retained root changes its inode while preserving its canonical path.
        const project = fixture.plan.binding.project;
        const moved = `${fixture.root}/moved-project`;
        renameSync(project, moved);
        mkdirSync(project, { mode: 0o700 });
      }
      if (mode === 'window') writeFileSync(path.join(fixture.observerRoot, 'outcome.json'), '{}\n', { mode: 0o400 });
      expect(() => verifyStageEvidence(context)).toThrow();
    }
  });

  test('returns canonical context for a stale observer and rejects it during current evidence verification', () => {
    const fixture = make('interrupt03');
    let armedAt;
    fixture.rewritePin('observer_claim', value => {
      value.armed_at -= 1300;
      armedAt = value.armed_at;
    });
    fixture.rewritePin('observer_ready', value => { value.armed_at = armedAt; });
    const context = validateStagePlan(fixture.plan);
    expect(context.activation_path).toBe(fixture.activation);
    expect(() => verifyStageEvidence(context)).toThrow();
  });

  test('does not consume a plan during validation and handles only the exact release exception', () => {
    const fixture = make('interrupt03');
    writeFileSync(fixture.release, `${JSON.stringify({
      version: 1,
      activation_id: fixture.plan.activation_id,
      attempt_id: path.basename(path.dirname(fixture.plan.attempt_manifest.path)),
      stage: fixture.plan.stage,
      goal_id: fixture.plan.expected_goal.goal_id,
      released_at_ms: Date.now(),
    })}\n`, { mode: 0o444 });
    const context = validateStagePlan(fixture.plan);
    expect(() => verifyStageEvidence(context)).toThrow();
    expect(() => verifyStageEvidence(context, { released: true })).not.toThrow();
  });
});

describe('native observer metadata collection', () => {
  test('performs birth metadata birth and retains only the selected observer', async () => {
    const fixture = make('interrupt03');
    const context = validateStagePlan(fixture.plan);
    const observation = await observeStageObserver(context, performance.now() + 10_000);
    expect(observation.metadata).toEqual(fixture.readState().observerMetadata);
    expect(observation.before.processes).toHaveLength(1);
    expect(observation.after.processes).toHaveLength(1);
    expect(observation.before.processes[0].pid).toBe(fixture.plan.observer.pid);
    expect(observation.started_at_ms).toBeLessThanOrEqual(observation.observed_at_ms);
    expect(JSON.stringify(observation)).not.toContain('49999');
  });

  test.each(['birth_failure', 'metadata_failure', 'observer_birth_change'])(
    'rejects bounded observer query failure: %s', async mode => {
      const fixture = make('interrupt03');
      fixture.update(state => { state.mode = mode; });
      const context = validateStagePlan(fixture.plan);
      await expect(observeStageObserver(context, performance.now() + 10_000)).rejects.toThrow();
    },
  );

  test('validates the whole host birth snapshots before observer-only retention', async () => {
    const fixture = make('interrupt03');
    fixture.update(state => { state.rows.push({ pid: 49_998, ppid: 1, pgid: 49_998,
      started: '1789220001.000031', state: 'foreign' }); });
    const context = validateStagePlan(fixture.plan);
    await expect(observeStageObserver(context, performance.now() + 10_000)).rejects.toThrow();
  });

  test('rejects an exhausted parent deadline before starting queries', async () => {
    const fixture = make('interrupt03');
    const context = validateStagePlan(fixture.plan);
    await expect(observeStageObserver(context, performance.now() - 1)).rejects.toThrow();
    expect(fixture.readState().birthCalls).toBe(0);
  });
});
