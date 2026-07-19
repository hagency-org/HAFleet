#!/usr/bin/env node
//
// Hardens a local dotenv file for the standalone supervisor cutover:
//   - generates a fresh MATRIX_BRIDGE_SECRET
//   - sets AGENTCHAT_AGENT_TOKEN_MODE
//   - optionally maps a whitelisted subset of a Palpo env file onto MATRIX_* keys
//
// Every write is atomic (temp file + rename) and the result is always chmod'd
// 0600. Only modified key NAMES are ever printed; values never reach stdout,
// stderr, or error messages.

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV_LINE_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

export const PALPO_MATRIX_MAP = Object.freeze({
  PALPO_PUBLIC_URL: 'MATRIX_HOMESERVER',
  PALPO_SERVER_NAME: 'MATRIX_SERVER_NAME',
  PALPO_REGISTRATION_TOKEN: 'MATRIX_REG_TOKEN',
  PALPO_BOT_PASSWORD: 'MATRIX_BOT_PASSWORD',
});

export function generateBridgeSecret() {
  return randomBytes(32).toString('hex');
}

// Parses dotenv content into an ordered list of line entries plus the set of
// keys that appear more than once as an active KEY=VALUE assignment. Comments,
// blank lines, and anything not matching KEY=VALUE are kept as opaque 'raw'
// entries so they round-trip untouched.
export function parseDotEnv(content) {
  const rawLines = content.length === 0 ? [] : content.split('\n');
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();

  const entries = [];
  const seenAt = new Map();
  const duplicateKeys = new Set();
  for (const line of rawLines) {
    const match = line.match(ENV_LINE_PATTERN);
    if (!match) {
      entries.push({ type: 'raw', line });
      continue;
    }
    const [, key, value] = match;
    entries.push({ type: 'kv', key, value, line });
    if (seenAt.has(key)) duplicateKeys.add(key);
    else seenAt.set(key, entries.length - 1);
  }
  return { entries, duplicateKeys };
}

export function serializeDotEnv(entries) {
  const body = entries.map((entry) => entry.line).join('\n');
  return body.length > 0 ? `${body}\n` : '';
}

// Applies `updates` (an iterable of [key, value] pairs) to dotenv `content`.
// Existing KEY=VALUE lines are replaced in place, whatever their current
// value; keys absent from the file are appended. Refuses to touch a file
// that has any duplicate key at all, whether or not that key is one of the
// requested updates, since a duplicate makes the file's current value
// ambiguous.
export function applyEnvUpdates(content, updates) {
  const { entries, duplicateKeys } = parseDotEnv(content);
  if (duplicateKeys.size > 0) {
    const names = [...duplicateKeys].sort().join(', ');
    throw new Error(`refusing to modify env file: duplicate key(s) detected: ${names}`);
  }

  const updatedKeys = [];
  for (const [key, value] of updates) {
    if (typeof value !== 'string') throw new Error(`value for ${key} must be a string`);
    const line = `${key}=${value}`;
    const existingIndex = entries.findIndex((entry) => entry.type === 'kv' && entry.key === key);
    if (existingIndex === -1) entries.push({ type: 'kv', key, value, line });
    else entries[existingIndex] = { type: 'kv', key, value, line };
    updatedKeys.push(key);
  }
  return { content: serializeDotEnv(entries), updatedKeys };
}

function readDotEnvValues(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const { entries, duplicateKeys } = parseDotEnv(content);
  if (duplicateKeys.size > 0) {
    const names = [...duplicateKeys].sort().join(', ');
    throw new Error(`refusing to read ${filePath}: duplicate key(s) detected: ${names}`);
  }
  return new Map(entries.filter((entry) => entry.type === 'kv').map((entry) => [entry.key, entry.value]));
}

function writeDotEnvAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(tmpPath, content, { mode: 0o600 });
  try {
    renameSync(tmpPath, filePath);
  } catch (error) {
    try { rmSync(tmpPath, { force: true }); } catch { /* best effort cleanup */ }
    throw error;
  }
  chmodSync(filePath, 0o600);
}

// Computes the MATRIX_* updates implied by --palpo-env/--map-matrix: only the
// four whitelisted source keys are ever read, and a source key that is absent
// from the palpo file is skipped rather than blanking its matrix target.
function resolveMatrixMapUpdates(palpoEnvPath) {
  const palpoValues = readDotEnvValues(palpoEnvPath);
  const updates = [];
  for (const [sourceKey, targetKey] of Object.entries(PALPO_MATRIX_MAP)) {
    if (palpoValues.has(sourceKey)) updates.push([targetKey, palpoValues.get(sourceKey)]);
  }
  return updates;
}

export function configureStandaloneEnv({
  envPath,
  generateBridgeSecretFlag = false,
  agentTokenMode,
  palpoEnvPath,
  mapMatrix = false,
  randomSecretFn = generateBridgeSecret,
}) {
  if (!envPath) throw new Error('envPath is required');
  if (mapMatrix && !palpoEnvPath) throw new Error('--map-matrix requires --palpo-env <file>');
  if (palpoEnvPath && !mapMatrix) throw new Error('--palpo-env requires --map-matrix');

  const resolvedEnvPath = path.resolve(envPath);
  let originalContent;
  try {
    originalContent = readFileSync(resolvedEnvPath, 'utf8');
  } catch {
    throw new Error(`--env file not found: ${resolvedEnvPath} (this tool only edits an existing file)`);
  }

  const updates = new Map();
  if (generateBridgeSecretFlag) updates.set('MATRIX_BRIDGE_SECRET', randomSecretFn());
  if (agentTokenMode !== undefined) updates.set('AGENTCHAT_AGENT_TOKEN_MODE', agentTokenMode);
  if (mapMatrix) {
    for (const [key, value] of resolveMatrixMapUpdates(path.resolve(palpoEnvPath))) updates.set(key, value);
  }

  if (updates.size === 0) {
    throw new Error('no changes requested: pass --generate-bridge-secret, --agent-token-mode <mode>, or --palpo-env <file> with --map-matrix');
  }

  const { content: nextContent, updatedKeys } = applyEnvUpdates(originalContent, updates);
  writeDotEnvAtomic(resolvedEnvPath, nextContent);
  return { envPath: resolvedEnvPath, updatedKeys };
}

function parseCliArgs(argv) {
  const options = {
    envPath: null,
    generateBridgeSecretFlag: false,
    agentTokenMode: undefined,
    palpoEnvPath: null,
    mapMatrix: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--generate-bridge-secret') {
      options.generateBridgeSecretFlag = true;
      continue;
    }
    if (arg === '--map-matrix') {
      options.mapMatrix = true;
      continue;
    }
    if (arg === '--env' || arg === '--agent-token-mode' || arg === '--palpo-env') {
      if (index + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      const value = argv[index + 1];
      index += 1;
      if (arg === '--env') options.envPath = value;
      else if (arg === '--agent-token-mode') options.agentTokenMode = value;
      else options.palpoEnvPath = value;
      continue;
    }
    throw new Error(`unknown argument ${arg}`);
  }
  if (!options.envPath) throw new Error('--env <path> is required');
  return options;
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const result = configureStandaloneEnv(options);
  process.stdout.write('Updated keys:\n');
  for (const key of result.updatedKeys) process.stdout.write(`${key}\n`);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`[configure-standalone-env] ${error.message}\n`);
    process.exitCode = 1;
  });
}
