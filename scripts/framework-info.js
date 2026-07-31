#!/usr/bin/env node
/**
 * Registry queries for shell callers, chiefly bin/agent-up.
 *
 * bin/agent-up is bash and cannot read the JSON manifests itself, so it would
 * otherwise keep its own hardcoded list of frameworks — which is the drift this
 * whole registry exists to remove.
 *
 *   framework-info.js ids                   -> every declared id, launchable or not
 *   framework-info.js launchable            -> newline-separated ids agent-up can start
 *   framework-info.js ready-fixed <id>      -> literal for grep -F that means "accepting input"
 *   framework-info.js check <id>            -> exit 0 if launchable; else reason on stderr
 *
 * `check` is the one agent-up calls. Exit codes:
 *   0  launchable
 *   1  known but not launchable, or unknown — reason on stderr
 *   2  usage error
 */

import { frameworkIds, getFramework, launchableFrameworkIds, launchBlockedReason } from '../lib/frameworks/index.js';

const [command, argument] = process.argv.slice(2);

if (command === 'ids') {
  // Every declared id, so the argument parser recognises a framework name as a
  // TYPE token even when it cannot be launched — that way the gate refuses it
  // with a real reason instead of "unrecognized argument".
  process.stdout.write(`${frameworkIds().join('\n')}\n`);
  process.exit(0);
}

if (command === 'launchable') {
  process.stdout.write(`${launchableFrameworkIds().join('\n')}\n`);
  process.exit(0);
}

if (command === 'ready-fixed') {
  // A literal for `grep -F`, so shell callers need no regex dialect assumptions.
  const framework = getFramework(argument);
  const fixed = framework?.signals?.ready?.[0]?.fixed;
  if (!fixed) {
    process.stderr.write(`no ready signal declared for ${argument}\n`);
    process.exit(1);
  }
  process.stdout.write(fixed);
  process.exit(0);
}

if (command === 'check') {
  if (!argument) {
    process.stderr.write('usage: framework-info.js check <id>\n');
    process.exit(2);
  }
  const reason = launchBlockedReason(argument);
  if (!reason) process.exit(0);
  process.stderr.write(`${reason}\n`);
  process.exit(1);
}

process.stderr.write('usage: framework-info.js <ids|launchable|ready-fixed <id>|check <id>>\n');
process.exit(2);
