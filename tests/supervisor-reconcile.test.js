import { afterEach, describe, expect, test } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { LocalServiceSupervisor } from '../src/local-service-supervisor.mjs';

/** Is this pid still alive? Signal 0 tests existence without delivering anything. */
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Wait for a pid to actually leave the process table. */
async function waitDead(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && alive(pid)) await new Promise((r) => setTimeout(r, 25));
  return !alive(pid);
}

// `hafleet acp-up --supervised` could add an entry to the service profile, but
// nothing could take one out. Removing an agent meant hand-editing the profile
// and restarting the fleet, because the supervisor reads its profile once at
// construction and never looks again.
//
// Doing exactly that — to drop one agent that was crash-looping on a missing
// credential — took the backend down: the restart ran without the environment
// the original supervisor had, so it exited on a missing API_TOKEN and every
// service behind dependsOn:[backend] went with it. reconcile() exists so that
// removing one agent is not a fleet-wide event.

const repoRoot = path.resolve('.');
const fixtureScript = 'tests/fixtures/service-child.mjs';
const supervisors = [];
const runtimes = [];

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function context(names = ['backend', 'agent:one']) {
  const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'hafleet-reconcile-'));
  runtimes.push(runtimeRoot);
  const eventLog = path.join(runtimeRoot, 'events.jsonl');
  const svc = (name, dependsOn = []) => ({
    name,
    command: ['node', fixtureScript],
    dependsOn,
    health: { type: 'process', timeoutMs: 300 },
    env: { SERVICE_CHILD_NAME: name, SERVICE_EVENT_LOG: eventLog },
  });
  const profile = { name: 'services-local', services: names.map((n) => svc(n, n === 'backend' ? [] : ['backend'])) };
  const supervisor = new LocalServiceSupervisor({
    profile, repoRoot, runtimeRoot,
    env: { ...process.env },
    restartDelayMs: 40,
    dependencyTimeoutMs: 3000,
  });
  supervisors.push(supervisor);
  return { supervisor, profile, svc, runtimeRoot };
}

const nameOf = (profile) => profile.services.map((s) => s.name);

afterEach(async () => {
  for (const s of supervisors.splice(0).reverse()) await s.stop().catch(() => {});
  for (const r of runtimes.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('reconcile applies a changed profile without restarting the fleet', () => {
  test('a removed service is stopped and the others keep their pids', async () => {
    const { supervisor, profile, svc } = await context(['backend', 'agent:one']);
    await supervisor.start();
    const backendPid = supervisor.getServicePid('backend');
    const agentPid = supervisor.getServicePid('agent:one');
    expect(backendPid).toBeTruthy();
    expect(agentPid).toBeTruthy();

    const result = await supervisor.reconcile({ ...profile, services: [svc('backend')] });

    expect(result).toEqual({ added: [], removed: ['agent:one'], changed: [] });
    // The process must actually be gone. Asserting only getServicePid() === null
    // is not enough: deleting the record alone makes it return null while the
    // child keeps running, orphaned and invisible to the supervisor that spawned
    // it. Checked against the pid captured before the reconcile.
    expect(await waitDead(agentPid), `agent:one (pid ${agentPid}) survived removal`).toBe(true);
    // The whole point: the survivor was never restarted, or even signalled.
    expect(supervisor.getServicePid('backend')).toBe(backendPid);
    expect(alive(backendPid), 'backend was killed by an unrelated removal').toBe(true);
    expect(supervisor.getServicePid('agent:one')).toBeNull();
    // And the bookkeeping is cleaned up, not just the process.
    expect(supervisor.records.has('agent:one')).toBe(false);
  });

  test('the removed service is not resurrected by the restart loop', async () => {
    // stopService sets desired='stopped' and clears the pending timer. If either
    // were missed the backoff loop would bring the agent back a beat later, which
    // is exactly how the removal looked like it had not worked.
    const { supervisor, profile, svc } = await context(['backend', 'agent:one']);
    await supervisor.start();
    const agentPid = supervisor.getServicePid('agent:one');
    await supervisor.reconcile({ ...profile, services: [svc('backend')] });
    await new Promise((r) => setTimeout(r, 300));
    expect(supervisor.getServicePid('agent:one')).toBeNull();
    expect(alive(agentPid), 'the restart loop brought the removed agent back').toBe(false);
    const status = await supervisor.status();
    expect(status.services.map((s) => s.name)).not.toContain('agent:one');
  });

  test('an added service is started', async () => {
    const { supervisor, profile, svc } = await context(['backend']);
    await supervisor.start();
    const backendPid = supervisor.getServicePid('backend');

    const result = await supervisor.reconcile({
      ...profile, services: [svc('backend'), svc('agent:new', ['backend'])],
    });

    expect(result).toEqual({ added: ['agent:new'], removed: [], changed: [] });
    expect(supervisor.getServicePid('agent:new')).toBeTruthy();
    expect(supervisor.getServicePid('backend')).toBe(backendPid);
  });

  test('a changed definition is reported but not applied', async () => {
    // Swapping a live service's command mid-reload is a different operation with
    // different failure modes. Declining loudly beats doing it silently.
    const { supervisor, profile, svc } = await context(['backend']);
    await supervisor.start();
    const pid = supervisor.getServicePid('backend');
    const altered = { ...svc('backend'), env: { SERVICE_CHILD_NAME: 'backend', EXTRA: '1' } };

    const result = await supervisor.reconcile({ ...profile, services: [altered] });

    expect(result.changed).toEqual(['backend']);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(supervisor.getServicePid('backend')).toBe(pid);
  });

  test('an unchanged profile is a no-op', async () => {
    const { supervisor, profile } = await context(['backend', 'agent:one']);
    await supervisor.start();
    const pids = nameOf(profile).map((n) => supervisor.getServicePid(n));
    const result = await supervisor.reconcile(profile);
    expect(result).toEqual({ added: [], removed: [], changed: [] });
    expect(nameOf(profile).map((n) => supervisor.getServicePid(n))).toEqual(pids);
  });

  test('the persisted state stops advertising a removed service', async () => {
    // `hafleet status` reads this file; a stale entry would report a service that
    // is deliberately gone as unhealthy forever.
    const { supervisor, profile, svc, runtimeRoot } = await context(['backend', 'agent:one']);
    await supervisor.start();
    await supervisor.reconcile({ ...profile, services: [svc('backend')] });
    const statePath = path.join(runtimeRoot, 'data', 'services-local', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    const names = (state.services ?? []).map((s) => s.name ?? s);
    expect(names).not.toContain('agent:one');
    expect(names).toContain('backend');
  });
});

describe('the acp-down command', () => {
  test('is dispatched by the CLI and manifested', () => {
    const cli = readFileSync('bin/hafleet', 'utf-8');
    expect(cli).toContain('acp-down) dispatch "hafleet-acp-down"');
    // Read the structure, not the serialization: a string match on
    // '"command": "acp-down"' fails purely because JSON.stringify omits the space.
    const manifest = JSON.parse(readFileSync('scripts/cli-command-manifest.json', 'utf-8'));
    const commands = [];
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === 'object') {
        if (typeof node.command === 'string') commands.push(node);
        Object.values(node).forEach(walk);
      }
    };
    walk(manifest);
    const entry = commands.find((c) => c.command === 'acp-down');
    expect(entry, 'acp-down is missing from the CLI manifest').toBeTruthy();
    expect(entry.target).toBe('hafleet-acp-down');
  });

  test('--help works without a name, which the contract gate requires', () => {
    const out = execFileSync('bash', ['bin/hafleet-acp-down', '--help'], { encoding: 'utf-8' });
    expect(out).toContain('Usage: hafleet acp-down');
    expect(out).toContain('--keep-running');
  });

  test('it signals the supervisor rather than editing and hoping', () => {
    // Removing the entry alone leaves the supervisor restarting from its
    // in-memory copy. The SIGHUP is the part that makes the removal take effect.
    const source = readFileSync('bin/hafleet-acp-down', 'utf-8');
    expect(source).toContain('kill -HUP');
    expect(source.indexOf('hafleet-supervise-agent.mjs remove'))
      .toBeLessThan(source.indexOf('kill -HUP'));
  });

  test('it says so when there is no supervisor to reload', () => {
    const source = readFileSync('bin/hafleet-acp-down', 'utf-8');
    expect(source).toMatch(/No running supervisor found/);
  });
});

describe('SIGHUP is wired to a reload', () => {
  const source = readFileSync('services/hafleet-services.mjs', 'utf-8');

  test('the handler is repeatable, not once', () => {
    // `process.once('SIGHUP')` would work exactly one time and then silently stop
    // reloading, which is worse than not having it.
    expect(source).toContain("process.on('SIGHUP'");
    expect(source).not.toContain("process.once('SIGHUP'");
  });

  test('a failed reload leaves the running fleet alone', () => {
    const handler = source.slice(source.indexOf("process.on('SIGHUP'"));
    const body = handler.slice(0, handler.indexOf('\n  });'));
    expect(body).toContain('catch');
    expect(body).toMatch(/keeping the running profile/);
  });

  test('the supervisor is given the profile path it needs to re-read', () => {
    expect(source).toMatch(/runSupervisor\(\{ profile, profilePath/);
    expect(source).toMatch(/loadServiceProfile\(\{ profilePath, repoRoot \}\)/);
  });
});
