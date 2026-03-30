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
const repoCore = path.join(baseDir, '..', 'lib', 'push-relay-core.js');

// Use only the repo root copy — fail loudly rather than silently using a stale bundled copy.
try {
  accessSync(repoCore);
} catch {
  console.error(`[push-relay] FATAL: repo-root core not found at ${repoCore}`);
  process.exit(1);
}

const core = await import(pathToFileURL(path.resolve(repoCore)).href);
if (typeof core.main === 'function') {
  core.main().catch((e) => {
    console.error(`[push-relay] startup error: ${e?.message || e}`);
    process.exit(1);
  });
}
