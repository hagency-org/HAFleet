import { describe, expect, test } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

const SCRIPT = 'bin/hafleet-acp-up';
const source = readFileSync(SCRIPT, 'utf-8');
const HELPER = 'scripts/hafleet-supervise-agent.mjs';

// A tmux agent survives its launcher exiting, because tmux owns the pane. An ACP
// agent dies with its host process and cannot be resumed — octos's ACP v1 reports
// loadSession:false — so without supervision a crash is permanent and a reboot
// loses the agent entirely.

describe('hafleet acp-up --supervised', () => {
  test('is valid bash and documents itself', () => {
    execFileSync('bash', ['-n', SCRIPT], { stdio: ['ignore', 'pipe', 'pipe'] });
    const help = execFileSync('bash', [SCRIPT, '--help'], { encoding: 'utf-8' });
    expect(help).toContain('--supervised');
    expect(help).toContain('--profile');
  });

  test('the supervised path returns instead of also launching detached', () => {
    // Two hosts holding sessions for one agent would both poll the inbox and both
    // answer. The supervised branch must exit before the nohup below it.
    const branch = source.indexOf('if [ "$SUPERVISED" = true ]; then');
    const detached = source.indexOf('nohup node "$BASE_DIR/scripts/hafleet-acp-agent.mjs"');
    expect(branch).toBeGreaterThan(-1);
    expect(branch).toBeLessThan(detached);
    const body = source.slice(branch, detached);
    expect(body).toContain('exit 0');
  });

  test('it stops an existing unsupervised host before handing over', () => {
    const branch = source.slice(source.indexOf('if [ "$SUPERVISED" = true ]; then'));
    expect(branch).toMatch(/kill "\$\(cat "\$PID_FILE"\)"/);
  });

  test('it handles both init systems and never assumes one', () => {
    // install-full.sh is systemd, install-macos.sh is launchd. A launcher that
    // knew only one would silently fail to start the agent on the other.
    expect(source).toContain('launchctl kickstart');
    expect(source).toContain('systemctl');
    expect(source).toMatch(/case "\$\(uname -s\)" in/);
  });

  test('when it cannot reload, it prints the command rather than claiming success', () => {
    const branch = source.slice(source.indexOf('if [ "$SUPERVISED" = true ]; then'));
    expect(branch).toMatch(/Registered\. Reload the supervisor to start it/);
  });

  test('it resolves the framework binary directory into the supervised PATH', () => {
    // The supervisor inherits its unit's PATH, which on mini5 omits ~/.local/bin
    // where octos lives. Without this the host exits instantly and the entry
    // restarts forever — the crash loop, on the first attempt.
    expect(source).toContain('SUPERVISED_PATH=');
    expect(source).toMatch(/command -v "\$FRAMEWORK_CMD"/);
    expect(source).toMatch(/is not on PATH here/);
  });

  test('it refuses rather than guessing when no profile exists', () => {
    expect(source).toMatch(/no service profile found; pass --profile/);
  });
});

describe('the registration helper', () => {
  const makeProfile = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-sup-'));
    const file = path.join(dir, 'profile.json');
    writeFileSync(file, JSON.stringify({
      name: 'test', services: [{ name: 'backend', command: ['node', 'backend-v2.js'], dependsOn: [] }],
    }, null, 2));
    return file;
  };

  const run = (args) => execFileSync('node', [HELPER, ...args], { encoding: 'utf-8' });

  test('adds an agent entry with the arguments it was given', () => {
    const file = makeProfile();
    run(['add', '--name', 'octos-agent', '--profile', file,
      '--workspace', os.tmpdir(), '--framework', 'octos', '--model', 'deepseek-v4-flash']);
    const entry = JSON.parse(readFileSync(file, 'utf-8')).services.find((s) => s.name === 'agent:octos-agent');
    expect(entry).toBeTruthy();
    expect(entry.command).toContain('--name');
    expect(entry.command).toContain('octos-agent');
    expect(entry.command).toContain('deepseek-v4-flash');
    expect(entry.dependsOn).toEqual(['backend']);
    expect(entry.health.type).toBe('process');
  });

  test('adding twice updates rather than duplicating', () => {
    // A duplicate name is rejected by the profile loader, so a second --supervised
    // launch would break the whole profile rather than just itself.
    const file = makeProfile();
    const args = ['add', '--name', 'a1', '--profile', file, '--workspace', os.tmpdir(), '--framework', 'octos'];
    run(args);
    run(args);
    const names = JSON.parse(readFileSync(file, 'utf-8')).services.map((s) => s.name);
    expect(names.filter((n) => n === 'agent:a1')).toHaveLength(1);
  });

  test('remove takes it back out and is safe to repeat', () => {
    const file = makeProfile();
    run(['add', '--name', 'a2', '--profile', file, '--workspace', os.tmpdir(), '--framework', 'octos']);
    run(['remove', '--name', 'a2', '--profile', file]);
    run(['remove', '--name', 'a2', '--profile', file]);
    const names = JSON.parse(readFileSync(file, 'utf-8')).services.map((s) => s.name);
    expect(names).toEqual(['backend']);
  });

  test('--dry-run changes nothing', () => {
    const file = makeProfile();
    const before = readFileSync(file, 'utf-8');
    const out = run(['add', '--name', 'a3', '--profile', file,
      '--workspace', os.tmpdir(), '--framework', 'octos', '--dry-run']);
    expect(out).toContain('[dry-run]');
    expect(readFileSync(file, 'utf-8')).toBe(before);
  });

  test('a name that cannot be a service is refused', () => {
    const file = makeProfile();
    let failed = false;
    try {
      run(['add', '--name', 'has spaces', '--profile', file, '--workspace', os.tmpdir(), '--framework', 'octos']);
    } catch { failed = true; }
    expect(failed).toBe(true);
  });
});

describe('a supervised ACP agent reports its own pid', () => {
  // bin/hafleet-acp-up registers on the operator's behalf, which only covers the
  // detached path. The supervisor spawns the host directly, so acp-up never runs
  // and the backend kept probing whichever pid registered first. Observed live:
  // acpPid=73908 against a live host pid of 5832, offlineReason=acp-process-gone.
  // The supervisor was restarting an agent the dashboard insisted was dead.
  const host = readFileSync('scripts/hafleet-acp-agent.mjs', 'utf-8');

  test('the host registers itself, not just acp-up', () => {
    expect(host).toContain("api('/api/agents'");
    expect(host).toMatch(/acpPid: process\.pid/);
    expect(host).toMatch(/transport: 'acp'/);
  });

  test('it registers after the session opens, so the pid is real', () => {
    // Registering before the session could exist would advertise an agent that
    // then fails to start.
    const sessionOpen = host.indexOf('acp session open:');
    const register = host.indexOf('await registerWithBackend()');
    expect(sessionOpen).toBeGreaterThan(-1);
    expect(register).toBeGreaterThan(sessionOpen);
  });

  test('a failed registration warns instead of killing a working session', () => {
    // Delivery pulls from the inbox and does not depend on registration, so a
    // backend blip must not take down an agent that is otherwise fine.
    const fn = host.slice(host.indexOf('async function registerWithBackend'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain('WARNING');
    expect(body).not.toMatch(/process\.exit/);
  });
});

describe('an ACP agent reports its own activity', () => {
  // A tmux agent's activity comes from hashing its pane. An ACP agent has no pane,
  // so the sweep's ACP branch does liveness only and the activity fields stayed
  // null: idleMs=-1, lastTmuxActivitySec=0, while claude and codex had real values.
  // A hung octos and a healthy idle octos were indistinguishable to the fleet.
  const host = readFileSync('scripts/hafleet-acp-agent.mjs', 'utf-8');

  test('it derives activity from session/update counts, not a pane', () => {
    expect(host).toContain('runtime.updateCursor(name)');
    expect(host).toMatch(/lastTmuxActivitySec/);
    expect(host).toMatch(/\/runtime`/);
  });

  test('it reports even while a turn is in flight', () => {
    // Mid-turn is exactly when the fleet most needs to see the agent is alive, so
    // the report must happen before the turnInFlight early return.
    const fn = host.slice(host.indexOf('async function pollAndDeliver'));
    const report = fn.indexOf('await reportActivity()');
    const earlyReturn = fn.indexOf('if (turnInFlight) return;');
    expect(report).toBeGreaterThan(-1);
    expect(report).toBeLessThan(earlyReturn);
  });

  test('it does not claim the agent is unblocked when it cannot tell', () => {
    // octos surfaces tool calls but does not block on ACP permission requests, so
    // this host has no way to observe blocking. Asserting blocked=false would be
    // a fabricated signal.
    const fn = host.slice(host.indexOf('async function reportActivity'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain('blockedObserved: false');
    expect(body).not.toMatch(/blocked: (true|false)/);
  });

  test('a failed report does not disturb the session', () => {
    const fn = host.slice(host.indexOf('async function reportActivity'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toMatch(/catch/);
    expect(body).not.toMatch(/process\.exit|throw/);
  });
});

describe('a paneless agent is never given a pane target', () => {
  // The heartbeat path backfills `tmux` for any agent lacking one, so a tmux agent
  // that registered without a target still gets swept. It ran *before* the ACP
  // guard further down, so every ACP agent was handed `<name>:0.0` — a pane that
  // cannot exist. The dashboard then routed it as a tmux agent and asked
  // getPaneIdleMs about that pane, reporting idleMs -1 forever while the agent was
  // plainly reporting activity. Seen live: tmux='octos-agent:0.0' on an agent with
  // transport='acp' and no tmux session on the host.
  const backend = readFileSync('backend-v2.js', 'utf-8');

  test('the tmux backfill is gated on transport', () => {
    expect(backend).toMatch(/if \(!agent\.tmux && agentTransport\(agent\) !== 'acp'\)/);
  });

  test('the gate precedes the ACP skip it used to rely on', () => {
    // The bug was ordering, not absence: the guard existed, 21 lines too late.
    const backfill = backend.indexOf("if (!agent.tmux && agentTransport(agent) !== 'acp')");
    const acpSkip = backend.indexOf("if (agentTransport(agent) === 'acp') continue;");
    expect(backfill).toBeGreaterThan(-1);
    expect(acpSkip).toBeGreaterThan(-1);
    expect(backfill).toBeLessThan(acpSkip);
  });

  test('no unguarded backfill remains', () => {
    const unguarded = backend.match(/if \(!agent\.tmux\) \{ agent\.tmux =/g) || [];
    expect(unguarded).toEqual([]);
  });

  test('the heartbeat does not accept a tmux target for an ACP agent', () => {
    // The heartbeat comes from the agent's own mcp-server.js child, which sends a
    // tmux target because historically every agent had one. This only became a
    // problem when octos gained MCP support and started heartbeating at all —
    // fixing MCP is what broke the transport routing. Observed as octos flapping
    // between tmux=null (via acp, idleMs real) and tmux='octos-agent:0.0'
    // (via null, idleMs -1) on every heartbeat cycle.
    expect(backend).toMatch(/&& agentTransport\(agent\) !== 'acp'\) agent\.tmux = tmux;/);
  });

  test('every path that can fabricate a pane target is guarded', () => {
    // Four sites assign a tmux target. Three are reachable for an ACP agent —
    // two backfills in applyRuntimeObservation, one in the heartbeat sweep — plus
    // the heartbeat route. Each must check the transport. The remaining one is the
    // up-v1 launch path, which has just created a real tmux session, so it is
    // correct there.
    const guarded = backend.match(/agentTransport\(agent\) !== 'acp'/g) || [];
    expect(guarded.length, 'expected every ACP-reachable assignment to be guarded')
      .toBeGreaterThanOrEqual(4);
  });
});

describe('an ACP agent is nudged, not spoon-fed', () => {
  // octos used to have the message bodies pasted into its prompt by the host,
  // while claude and codex get a summary plus "call check_inbox for full context"
  // and fetch their own. Two agents, two contracts.
  //
  // Worse, the host's unfiltered inbox read advances the cursor — so by the time
  // the agent ran check_inbox its mail was already consumed and it saw NONE.
  // Verified live before the change.
  const host = readFileSync('scripts/hafleet-acp-agent.mjs', 'utf-8');

  test('the host probes /unread and never consumes the inbox', () => {
    // /unread does not advance the cursor; the unfiltered read does. Reading it
    // here is what made the agent's own check_inbox return nothing.
    expect(host).toContain('/unread');
    expect(host, 'the host must not perform the cursor-advancing read')
      .not.toMatch(/api\(`\/api\/inbox\/\$\{encodeURIComponent\(name\)\}`\)/);
  });

  test('the nudge carries no message bodies', () => {
    const fn = host.slice(host.indexOf('function buildNudge'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toMatch(/unread message\(s\)/);
    expect(body).toContain('check_inbox');
    expect(body, 'a nudge that includes the body defeats the point')
      .not.toMatch(/msg\.full|\.full \|\|/);
  });

  test('the host no longer replies on the agent\'s behalf', () => {
    // Two reply paths produced two messages for one answer. Whether to respond is
    // the agent's judgement, as it is for claude and codex.
    expect(host).not.toContain('async function postReply');
    expect(host).not.toContain('replied to');
  });

  test('a backlog is not re-nudged every poll', () => {
    // The cursor no longer advances on the host's read, so without this an agent
    // that ignores a nudge would be re-prompted every five seconds forever.
    expect(host).toMatch(/lastNudgedCount/);
    expect(host).toMatch(/if \(pending === lastNudgedCount\) return;/);
    expect(host, 'the guard must reset when the inbox drains')
      .toMatch(/if \(!pending\) \{ lastNudgedCount = 0; return; \}/);
  });

  test('the dead rendering helpers are gone, not just unused', () => {
    expect(host).not.toContain('function formatMessage');
  });
});
