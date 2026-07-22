#!/usr/bin/env node
import os from 'node:os';
import { readFirstAgentManifest, resolveManagedProjectRoots } from '../lib/agent-launch-policy.js';

const args = process.argv.slice(2);
let agentPath = '';
let homeDir = os.homedir();
const manifestPaths = [];
for (let index = 0; index < args.length; index += 1) {
  const token = args[index];
  if (token === '--agent-path' && args[index + 1]) {
    agentPath = args[++index];
  } else if (token === '--home-dir' && args[index + 1]) {
    homeDir = args[++index];
  } else if (token === '--manifest' && args[index + 1]) {
    manifestPaths.push(args[++index]);
  } else {
    console.error(`unknown or incomplete argument: ${token}`);
    process.exit(2);
  }
}

if (!agentPath) {
  console.error('--agent-path is required');
  process.exit(2);
}

try {
  const manifest = readFirstAgentManifest(manifestPaths);
  const result = resolveManagedProjectRoots({ manifest, agentPath, homeDir });
  for (const warning of result.warnings) console.error(`warning: ${warning}`);
  for (const root of result.roots) console.log(root);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
