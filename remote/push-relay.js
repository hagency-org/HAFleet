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

// Prefer repo root core first so latest local fixes are used after `agent-update`.
// Fall back to bundled remote/lib only for standalone remote package usage.
let corePath = localCore;
try {
  accessSync(repoCore);
  corePath = repoCore;
} catch {
  corePath = localCore;
}

await import(pathToFileURL(path.resolve(corePath)).href);
