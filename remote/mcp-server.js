#!/usr/bin/env node

import { accessSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const baseDir = path.dirname(fileURLToPath(import.meta.url));
const localCore = path.join(baseDir, 'lib', 'mcp-server-core.js');
const repoCore = path.join(baseDir, '..', 'lib', 'mcp-server-core.js');

let corePath = repoCore;
try {
  accessSync(localCore);
  corePath = localCore;
} catch {
  corePath = repoCore;
}

await import(pathToFileURL(path.resolve(corePath)).href);
