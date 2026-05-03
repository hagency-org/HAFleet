#!/usr/bin/env node

import { accessSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

if (!process.env.PUSH_RELAY_MODE) {
  process.env.PUSH_RELAY_MODE = 'remote';
}
if (!process.env.PUSH_RELAY_INCLUDE_LEASE_FIELDS) {
  process.env.PUSH_RELAY_INCLUDE_LEASE_FIELDS = '1';
}

const baseDir = path.dirname(fileURLToPath(import.meta.url));
const localCore = path.join(baseDir, 'lib', 'push-relay-core.js');
const repoCore = path.join(baseDir, '..', 'lib', 'push-relay-core.js');
let corePath = null;

try {
  accessSync(localCore);
  corePath = localCore;
} catch {
  try {
    accessSync(repoCore);
    corePath = repoCore;
  } catch {
    console.error(`[push-relay] FATAL: core not found at ${localCore} or ${repoCore}`);
    process.exit(1);
  }
}

const core = await import(pathToFileURL(path.resolve(corePath)).href);
if (process.env.AGENTCHAT_WRAPPER_SMOKE === '1') {
  process.exit(0);
}

if (typeof core.main === 'function') {
  if (typeof core.installPushRelayProcessHandlers === 'function') {
    core.installPushRelayProcessHandlers();
  }
  core.main().catch((e) => {
    console.error(`[push-relay] startup error: ${e?.message || e}`);
    process.exit(1);
  });
}
