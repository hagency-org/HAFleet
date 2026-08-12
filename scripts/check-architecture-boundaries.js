#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(__filename);
const REPO_ROOT = process.env.HAFLEET_ARCH_BOUNDARY_ROOT
  ? path.resolve(process.env.HAFLEET_ARCH_BOUNDARY_ROOT)
  : path.resolve(SCRIPT_DIR, '..');
const MANIFEST_PATH = process.env.HAFLEET_ARCH_BOUNDARY_MANIFEST
  ? path.resolve(process.env.HAFLEET_ARCH_BOUNDARY_MANIFEST)
  : path.join(SCRIPT_DIR, 'architecture-boundaries.json');

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

function findRouteCallEnd(source, startIndex) {
  const openIndex = source.indexOf('(', startIndex);
  if (openIndex < 0) return null;
  let depth = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') {
      lineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      i += 1;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        let end = i + 1;
        while (end < source.length && /[\s;]/.test(source[end])) end += 1;
        return end;
      }
    }
  }
  return null;
}

function extractExpressRoutes(source) {
  const routes = [];
  const pattern = /\bapp\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    routes.push({
      method: match[1].toUpperCase(),
      path: match[3],
      index: match.index,
      line: source.slice(0, match.index).split('\n').length,
    });
  }
  const installRoutePattern = /\b[A-Za-z_$][\w$]*\.installRoute\(\s*app\s*,\s*(['"`])([^'"`]+)\1/g;
  while ((match = installRoutePattern.exec(source)) !== null) {
    routes.push({
      method: 'GET',
      path: match[2],
      index: match.index,
      line: source.slice(0, match.index).split('\n').length,
    });
  }
  routes.sort((a, b) => a.index - b.index);
  for (let i = 0; i < routes.length; i++) {
    const next = routes[i + 1]?.index ?? source.length;
    const end = findRouteCallEnd(source, routes[i].index);
    routes[i].source = source.slice(routes[i].index, end || next);
  }
  return routes;
}

function validateRouteAuth(fileName, source, route, expectedAuth) {
  const routeSource = route?.source || '';
  const has = (needle) => routeSource.includes(needle);
  const forbiddenRouteLocalAuth = [
    'requireBearer',
    'requireAgentToken',
    'requireBridgeSecret',
    'requireApprovalBridgeSecret',
    '_alertTransitionAuth',
    'authorizeMessageDetailAccess(req',
    'authorizeAgentCredential(req',
    'isLocalRequest(req)',
    'requireRequester',
  ];

  switch (expectedAuth) {
    case undefined:
    case null:
      return null;
    case 'global-api-auth-only': {
      const firstApiMutation = extractExpressRoutes(source)
        .filter(item => !['GET', 'HEAD', 'OPTIONS'].includes(item.method) && item.path.startsWith('/api/'))
        .sort((a, b) => a.index - b.index)[0];
      const globalAuthIndex = source.indexOf("app.use('/api', createApiAuthMiddleware");
      if (globalAuthIndex < 0 || globalAuthIndex > route.index || (firstApiMutation && globalAuthIndex > firstApiMutation.index)) {
        return `${fileName}:${route.line} ${routeKey(route)} expected global /api auth before route`;
      }
      const found = forbiddenRouteLocalAuth.find(needle => has(needle));
      if (found) return `${fileName}:${route.line} ${routeKey(route)} expected global-api-auth-only but found ${found}`;
      return null;
    }
    case 'bearer':
      return has('requireBearer') ? null : `${fileName}:${route.line} ${routeKey(route)} expected requireBearer`;
    /*
     * A distinct policy rather than an alias for `bearer`. `requireRequester` admits a SECOND
     * credential — REQUESTER_TOKEN — that no bearer-guarded route accepts, so recording these
     * routes as `bearer` would understate who can reach them, which is the one thing this registry
     * exists to state accurately.
     */
    case 'requester':
      return has('requireRequester') ? null : `${fileName}:${route.line} ${routeKey(route)} expected requireRequester`;
    case 'bearer-and-local':
      if (!has('requireBearer')) return `${fileName}:${route.line} ${routeKey(route)} expected requireBearer`;
      return has('isLocalRequest(req)') ? null : `${fileName}:${route.line} ${routeKey(route)} expected isLocalRequest(req) local-only guard`;
    case 'agent-token':
      return has('requireAgentToken') ? null : `${fileName}:${route.line} ${routeKey(route)} expected requireAgentToken`;
    case 'bridge-secret':
      return has('requireBridgeSecret') ? null : `${fileName}:${route.line} ${routeKey(route)} expected requireBridgeSecret`;
    case 'approval-bridge-secret':
      return has('requireApprovalBridgeSecret') ? null : `${fileName}:${route.line} ${routeKey(route)} expected requireApprovalBridgeSecret`;
    case 'bearer-or-agent-token':
      return has('_alertTransitionAuth') ? null : `${fileName}:${route.line} ${routeKey(route)} expected _alertTransitionAuth`;
    case 'bearer-or-agent-token-inline':
      if (!has('getBearerToken(req)')) return `${fileName}:${route.line} ${routeKey(route)} expected getBearerToken(req) bearer branch`;
      return has('requireAgentToken') ? null : `${fileName}:${route.line} ${routeKey(route)} expected requireAgentToken fallback`;
    case 'local-only':
      return has('isLocalRequest(req)') ? null : `${fileName}:${route.line} ${routeKey(route)} expected isLocalRequest(req) local-only guard`;
    case 'message-detail-access':
      return has('authorizeMessageDetailAccess(req') ? null : `${fileName}:${route.line} ${routeKey(route)} expected authorizeMessageDetailAccess(req)`;
    case 'agent-credential':
      return has('authorizeAgentCredential(req') ? null : `${fileName}:${route.line} ${routeKey(route)} expected authorizeAgentCredential(req)`;
    default:
      return `${fileName}:${route.line} ${routeKey(route)} has unknown auth policy ${expectedAuth}`;
  }
}

function collectExpectedRoutes(fileName, routes, label, failures) {
  const expected = new Map();
  for (const route of routes || []) {
    if (!route.method || !route.path || !route.owner) {
      failures.push(`[route ownership] ${fileName} has an incomplete ${label} route entry: ${JSON.stringify(route)}`);
      continue;
    }
    expected.set(routeKey(route), route.owner);
  }
  return expected;
}

function validateExpectedRoutes(fileName, source, actualRoutesByKey, expectedRoutes, label, failures) {
  for (const route of expectedRoutes || []) {
    if (!route.method || !route.path || !route.owner) continue;
    const key = routeKey(route);
    const actual = actualRoutesByKey.get(key);
    if (!actual) {
      failures.push(`[route ownership] ${fileName} ${label} owner entry no longer matches a route: ${key}`);
      continue;
    }
    const authFailure = validateRouteAuth(fileName, source, actual, route.auth);
    if (authFailure) {
      failures.push(`[route ownership] ${authFailure}`);
    }
  }
}

function statefulGetMarker(route, markers) {
  if (route.method !== 'GET') return null;
  return (markers || []).find(marker => route.source.includes(marker)) || null;
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
    const actualRoutes = extractExpressRoutes(source);
    const actualMutationRoutes = actualRoutes
      .filter(route => !['GET', 'HEAD', 'OPTIONS'].includes(route.method));
    const statefulGetMarkers = config.statefulGetMarkers || [];
    const actualStatefulGetRoutes = actualRoutes
      .map(route => ({ route, marker: statefulGetMarker(route, statefulGetMarkers) }))
      .filter(item => item.marker);
    const actualKeys = new Map(actualMutationRoutes.map(route => [routeKey(route), route]));
    const actualRoutesByKey = new Map(actualRoutes.map(route => [routeKey(route), route]));
    const expectedRoutes = config.mutationRoutes || [];
    const sensitiveRoutes = config.sensitiveRoutes || [];
    const statefulGetRoutes = config.statefulGetRoutes || [];
    const expectedKeys = collectExpectedRoutes(fileName, expectedRoutes, 'mutation', failures);
    const expectedStatefulGetKeys = collectExpectedRoutes(fileName, statefulGetRoutes, 'stateful GET', failures);
    collectExpectedRoutes(fileName, sensitiveRoutes, 'sensitive', failures);

    for (const route of actualMutationRoutes) {
      const key = routeKey(route);
      if (!expectedKeys.has(key)) {
        failures.push(`[route ownership] ${fileName} mutation route lacks owner entry: ${key}`);
      }
    }
    for (const { route, marker } of actualStatefulGetRoutes) {
      const key = routeKey(route);
      if (!expectedStatefulGetKeys.has(key)) {
        failures.push(`[route ownership] ${fileName} stateful GET route lacks owner entry: ${key} (matched ${JSON.stringify(marker)})`);
      }
    }

    validateExpectedRoutes(fileName, source, actualKeys, expectedRoutes, 'mutation', failures);
    validateExpectedRoutes(fileName, source, actualRoutesByKey, sensitiveRoutes, 'sensitive', failures);
    validateExpectedRoutes(fileName, source, actualRoutesByKey, statefulGetRoutes, 'stateful GET', failures);

    console.log(`[OK] route ownership ${fileName}: ${actualMutationRoutes.length} mutation route(s), ${sensitiveRoutes.length} sensitive route(s), ${statefulGetRoutes.length} stateful GET route(s) checked`);
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
