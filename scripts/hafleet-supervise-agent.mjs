#!/usr/bin/env node
/**
 * Register or remove a paneless ACP agent in a service profile, so HAFleet's own
 * supervisor keeps it alive.
 *
 * Why only ACP agents: a tmux agent survives its launcher exiting because tmux
 * owns the pane, and it survives the supervisor entirely. An ACP agent lives and
 * dies with its host process, and its session cannot be resumed — octos's ACP v1
 * reports loadSession:false — so a crash is permanent until something restarts it.
 *
 * Reboot survival comes for free: the supervisor is itself started by launchd or
 * systemd, so anything in its profile comes back with it.
 *
 * The env block matters more than it looks. The launchd runner exports a fixed
 * PATH (/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:...) which does not include
 * ~/.local/bin, where octos is installed on mini5. Without the framework binary's
 * directory the host exits immediately with "octos is not available on PATH", and
 * a supervised entry would then restart forever. Backoff makes that survivable;
 * passing the right PATH makes it unnecessary.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { isAgentServiceName } from '../src/service-profile.mjs';

const args = process.argv.slice(2);
const read = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};
const has = (flag) => args.includes(flag);

const action = args[0];
const name = read('--name');
const profilePath = read('--profile');

if (!['add', 'remove'].includes(action) || !name || !profilePath) {
  process.stderr.write(
    'usage: hafleet-supervise-agent.mjs <add|remove> --name <agent> --profile <file>\n'
    + '                                 [--workspace <dir>] [--framework <id>] [--model <m>] [--path <PATH>]\n',
  );
  process.exit(2);
}

const serviceName = `agent:${name}`;
if (!isAgentServiceName(serviceName)) {
  process.stderr.write(`refusing: '${name}' is not a usable agent name for a supervised service\n`);
  process.exit(2);
}

let profile;
try {
  profile = JSON.parse(readFileSync(profilePath, 'utf8'));
} catch (error) {
  process.stderr.write(`cannot read profile ${profilePath}: ${error.message}\n`);
  process.exit(1);
}
if (!Array.isArray(profile.services)) {
  process.stderr.write(`profile ${profilePath} has no services array\n`);
  process.exit(1);
}

const before = profile.services.length;
profile.services = profile.services.filter((s) => s?.name !== serviceName);

if (action === 'add') {
  const workspace = read('--workspace');
  const framework = read('--framework');
  const model = read('--model');
  if (!workspace || !framework) {
    process.stderr.write('add requires --workspace and --framework\n');
    process.exit(2);
  }

  const command = [
    'node', 'scripts/hafleet-acp-agent.mjs',
    '--name', name,
    '--workspace', path.resolve(workspace),
    '--framework', framework,
  ];
  if (model) command.push('--model', model);

  const env = {};
  const extraPath = read('--path');
  if (extraPath) env.PATH = extraPath;

  profile.services.push({
    name: serviceName,
    command,
    // Prompts are pulled from the backend's inbox, so starting before it is up
    // just means the first poll fails and retries. Declaring the dependency keeps
    // the startup order honest and the health reporting meaningful.
    dependsOn: ['backend'],
    env,
    // 'process' is the only probe that fits: an ACP agent exposes no port, and it
    // writes no health record. It asserts the host process is alive with the right
    // command line, which for this host is a true liveness signal — it exits when
    // its session ends rather than lingering.
    health: { type: 'process', timeoutMs: 1000 },
  });
}

if (!has('--dry-run')) {
  const temporary = `${profilePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  const { renameSync } = await import('node:fs');
  renameSync(temporary, profilePath);
}

const after = profile.services.length;
const verb = action === 'add' ? (after > before ? 'added' : 'updated') : (after < before ? 'removed' : 'not present');
process.stdout.write(`${has('--dry-run') ? '[dry-run] would have ' : ''}${verb} ${serviceName} in ${profilePath}\n`);
