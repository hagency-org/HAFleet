#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(__filename);
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const MANIFEST_PATH = path.join(SCRIPT_DIR, 'architecture-boundaries.json');

function repoPath(filePath) {
  return path.relative(REPO_ROOT, filePath).split(path.sep).join('/');
}

function toAbsolute(repoRelativePath) {
  return path.join(REPO_ROOT, repoRelativePath);
}

function listJsFiles(startPath) {
  const abs = toAbsolute(startPath);
  if (!existsSync(abs)) return [];
  const st = statSync(abs);
  if (st.isFile()) return abs.endsWith('.js') ? [abs] : [];
  if (!st.isDirectory()) return [];

  const files = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const child = path.join(abs, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsFiles(repoPath(child)));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(child);
    }
  }
  return files;
}

function collectFiles(rule) {
  const files = [];
  const missing = [];
  for (const item of rule.include || []) {
    const abs = toAbsolute(item);
    if (!existsSync(abs)) {
      if (!rule.allowMissing) missing.push(item);
      continue;
    }
    if (statSync(abs).isDirectory()) {
      files.push(...listJsFiles(item));
    } else {
      files.push(abs);
    }
  }
  return {
    files: [...new Set(files.map(file => path.resolve(file)))].sort(),
    missing,
  };
}

function extractImports(source) {
  const imports = [];
  const patterns = [
    /\bimport\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      imports.push(match[1]);
    }
  }
  return imports;
}

function resolveImport(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const resolved = path.normalize(path.join(path.dirname(fromFile), specifier));
  return repoPath(resolved);
}

function prefixMatch(value, prefix) {
  return value === prefix || value.startsWith(prefix);
}

function checkImportBoundaries(manifest) {
  const failures = [];

  for (const rule of manifest.importBoundaries || []) {
    const { files, missing } = collectFiles(rule);
    for (const item of missing) {
      failures.push(`[${rule.name}] missing configured path: ${item}`);
    }

    let checkedImports = 0;
    for (const file of files) {
      const source = readFileSync(file, 'utf-8');
      for (const specifier of extractImports(source)) {
        checkedImports += 1;
        const specifierFailures = (rule.forbiddenSpecifierPatterns || [])
          .filter(pattern => new RegExp(pattern).test(specifier));
        for (const pattern of specifierFailures) {
          failures.push(`[${rule.name}] ${repoPath(file)} imports "${specifier}" matching forbidden specifier pattern ${pattern}`);
        }

        const resolved = resolveImport(file, specifier);
        if (!resolved) continue;
        const resolvedFailures = (rule.forbiddenResolvedPrefixes || [])
          .filter(prefix => prefixMatch(resolved, prefix));
        for (const prefix of resolvedFailures) {
          failures.push(`[${rule.name}] ${repoPath(file)} imports ${resolved} under forbidden owner ${prefix}`);
        }
      }
    }

    console.log(`[OK] ${rule.name}: ${files.length} file(s), ${checkedImports} import(s) checked`);
  }

  return failures;
}

function routeKey(route) {
  return `${route.method.toUpperCase()} ${route.path}`;
}

function extractExpressRoutes(source) {
  const routes = [];
  const pattern = /\bapp\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    routes.push({
      method: match[1].toUpperCase(),
      path: match[3],
    });
  }
  return routes;
}

function checkRouteOwnership(manifest) {
  const failures = [];
  for (const [fileName, config] of Object.entries(manifest.routeOwnership || {})) {
    const abs = toAbsolute(fileName);
    if (!existsSync(abs)) {
      failures.push(`[route ownership] missing route file: ${fileName}`);
      continue;
    }

    const source = readFileSync(abs, 'utf-8');
    const actualMutationRoutes = extractExpressRoutes(source)
      .filter(route => !['GET', 'HEAD', 'OPTIONS'].includes(route.method));
    const actualKeys = new Set(actualMutationRoutes.map(routeKey));
    const expectedRoutes = config.mutationRoutes || [];
    const expectedKeys = new Map();

    for (const route of expectedRoutes) {
      if (!route.method || !route.path || !route.owner) {
        failures.push(`[route ownership] ${fileName} has an incomplete mutation route entry: ${JSON.stringify(route)}`);
        continue;
      }
      expectedKeys.set(routeKey(route), route.owner);
    }

    for (const route of actualMutationRoutes) {
      const key = routeKey(route);
      if (!expectedKeys.has(key)) {
        failures.push(`[route ownership] ${fileName} mutation route lacks owner entry: ${key}`);
      }
    }

    for (const key of expectedKeys.keys()) {
      if (!actualKeys.has(key)) {
        failures.push(`[route ownership] ${fileName} owner entry no longer matches a route: ${key}`);
      }
    }

    console.log(`[OK] route ownership ${fileName}: ${actualMutationRoutes.length} mutation route(s) checked`);
  }

  return failures;
}

function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
  console.log('Checking architecture boundaries...');

  const failures = [
    ...checkImportBoundaries(manifest),
    ...checkRouteOwnership(manifest),
  ];

  if (failures.length > 0) {
    for (const failure of failures) console.error(`[FAIL] ${failure}`);
    console.error(`Architecture boundary check failed: ${failures.length} issue(s).`);
    process.exit(1);
  }

  console.log('Architecture boundary check passed.');
}

main();
