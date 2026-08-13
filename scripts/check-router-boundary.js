#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A plain filesystem walk rather than rg or git ls-files: ripgrep is not
// installed on the CI runner, and the build-contract test runs this script
// inside a .git-less copy of the repo. The exclusions mirror what those
// tools would have skipped for this check's purposes.
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'data', 'coverage']);
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.ts']);
function collectSourceFiles(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) out.push(...collectSourceFiles(path.join(dir, entry.name), relative));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(relative);
    }
  }
  return out;
}
const files = collectSourceFiles('.');

const violations = [];
for (const relative of files) {
  if (relative.startsWith('router/src/') || relative.startsWith('router/dist/')) continue;
  const source = readFileSync(path.join(root, relative), 'utf8');
  const importPrefix = String.raw`(?:from\s+|import\s*(?:\(\s*)?|require\s*\(\s*)`;
  const internalRouterImport = new RegExp(
    `${importPrefix}['"][^'"]*router\\/(?:src\\/|dist\\/(?!index\\.js(?:['"]|$)))`,
  );
  if (internalRouterImport.test(source)) {
    violations.push(`${relative}: imports a router internal module`);
  }
  if (new RegExp(`${importPrefix}['"]better-sqlite3['"]`).test(source)) {
    violations.push(`${relative}: imports the router database adapter directly`);
  }
}

for (const relative of files.filter((file) => file.startsWith('router/src/'))) {
  const source = readFileSync(path.join(root, relative), 'utf8');
  if (/\bany\b/.test(source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''))) {
    violations.push(`${relative}: contains prohibited any`);
  }
  if (/\bas\s+unknown\s+as\b/.test(source)) {
    violations.push(`${relative}: contains unchecked double assertion`);
  }
}

if (violations.length) {
  for (const violation of violations) console.error(violation);
  process.exit(1);
}
console.log('router boundary check passed');
