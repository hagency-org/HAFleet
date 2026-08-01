#!/usr/bin/env node
import { validateLaunchExtraArgs } from '../lib/agent-launch-policy.js';
import { frameworkIds, getFramework } from '../lib/frameworks/index.js';

const framework = String(process.argv[2] || '').trim().toLowerCase();
const extraArgs = process.argv[3] || '';

// Refusing an unrecognised name here is load-bearing: validateLaunchExtraArgs
// applies NO guards to a non-empty framework it does not know, so without this
// an unknown name would let every policy flag through. The list is the registry's,
// not a copy kept here.
if (!getFramework(framework)) {
  console.error(`unsupported framework for launch policy: ${framework || '(empty)'}`);
  console.error(`known frameworks: ${frameworkIds().join(', ')}`);
  process.exit(2);
}

const result = validateLaunchExtraArgs(framework, extraArgs);
if (!result.ok) {
  console.error(result.reason);
  process.exit(1);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

process.stdout.write(result.tokens.map(shellQuote).join(' '));
