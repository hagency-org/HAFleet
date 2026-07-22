#!/usr/bin/env node
import { validateLaunchExtraArgs } from '../lib/agent-launch-policy.js';

const framework = String(process.argv[2] || '').trim().toLowerCase();
const extraArgs = process.argv[3] || '';

if (framework !== 'claude' && framework !== 'codex') {
  console.error(`unsupported framework for launch policy: ${framework || '(empty)'}`);
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
