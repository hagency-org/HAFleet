#!/usr/bin/env node

import { randomBytes } from 'crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

function tomlQuoted(value) {
  return `"${String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')}"`;
}

function splitLines(value) {
  return String(value || '').match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) || [];
}

function tableRanges(lines) {
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*\[[^\n]+\]\s*(?:#.*)?$/.test(lines[index].trimEnd())) starts.push(index);
  }
  return starts.map((start, index) => ({
    start,
    end: starts[index + 1] ?? lines.length,
  }));
}

export function ensureCodexProjectTrustText(rawConfig, cwd) {
  const resolvedCwd = path.resolve(cwd);
  const header = `[projects.${tomlQuoted(resolvedCwd)}]`;
  let lines = splitLines(rawConfig);
  let ranges = tableRanges(lines).filter(range => lines[range.start].trim() === header);
  let deduplicated = false;

  if (ranges.length > 1) {
    const bodies = ranges.map(range => lines.slice(range.start + 1, range.end).join('').trim());
    if (new Set(bodies).size !== 1) {
      throw new Error(`conflicting duplicate Codex project trust sections for ${resolvedCwd}`);
    }
    const skipped = new Set();
    for (const range of ranges.slice(1)) {
      for (let index = range.start; index < range.end; index += 1) skipped.add(index);
    }
    lines = lines.filter((_line, index) => !skipped.has(index));
    ranges = tableRanges(lines).filter(range => lines[range.start].trim() === header);
    deduplicated = true;
  }

  if (ranges.length === 0) {
    if (lines.length > 0 && !lines.at(-1).endsWith('\n')) {
      lines[lines.length - 1] = `${lines.at(-1)}\n`;
    }
    if (lines.length > 0 && lines.at(-1).trim()) lines.push('\n');
    lines.push(`${header}\n`, 'trust_level = "trusted"\n');
    return { content: lines.join(''), status: 'updated' };
  }

  const range = ranges[0];
  const trustRows = [];
  for (let index = range.start + 1; index < range.end; index += 1) {
    if (/^\s*trust_level\s*=/.test(lines[index])) trustRows.push(index);
  }
  if (trustRows.length > 1) {
    throw new Error(`duplicate trust_level keys in Codex project section for ${resolvedCwd}`);
  }
  if (trustRows.length === 1) {
    if (/^\s*trust_level\s*=\s*"trusted"\s*(?:#.*)?$/.test(lines[trustRows[0]].trimEnd())) {
      return { content: lines.join(''), status: deduplicated ? 'deduplicated' : 'already' };
    }
    const newline = lines[trustRows[0]].endsWith('\n') ? '\n' : '';
    lines[trustRows[0]] = `trust_level = "trusted"${newline}`;
  } else {
    lines.splice(range.start + 1, 0, 'trust_level = "trusted"\n');
  }
  return { content: lines.join(''), status: deduplicated ? 'deduplicated' : 'updated' };
}

export function ensureCodexProjectTrustFile(configPath, cwd) {
  const resolved = path.resolve(configPath);
  const current = existsSync(resolved) ? readFileSync(resolved, 'utf8') : '';
  const result = ensureCodexProjectTrustText(current, cwd);
  if (result.status === 'already') return result;

  mkdirSync(path.dirname(resolved), { recursive: true });
  const backupDir = path.join(path.dirname(resolved), 'backups');
  mkdirSync(backupDir, { recursive: true });
  if (existsSync(resolved)) {
    copyFileSync(resolved, path.join(backupDir, `config.toml.backup.${Date.now()}`));
  }
  const temporary = `${resolved}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, result.content, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, resolved);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
  return result;
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!['--config', '--cwd'].includes(name)) throw new Error(`unknown argument ${name}`);
    const value = argv[index + 1];
    if (!value) throw new Error(`${name} requires a value`);
    values[name.slice(2)] = value;
    index += 1;
  }
  if (!values.config || !values.cwd) throw new Error('config and cwd are required');
  return values;
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const result = ensureCodexProjectTrustFile(args.config, args.cwd);
    process.stdout.write(`${result.status}\n`);
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  }
}
