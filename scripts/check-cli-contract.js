#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const manifestPath = path.join(__dirname, 'cli-command-manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

let failures = 0;

function fail(message) {
  console.error(`[FAIL] ${message}`);
  failures += 1;
}

function ok(message) {
  console.log(`[OK] ${message}`);
}

function isExecutable(filePath) {
  try {
    const mode = statSync(filePath).mode;
    return (mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasHelpCommand(help, command) {
  const pattern = new RegExp(`(^|\\n)\\s*${escapeRegex(command)}(\\s|$)`);
  return pattern.test(help);
}

function collectDispatchTargets(source) {
  const targets = new Set();
  const pattern = /dispatch\s+"([^"]+)"/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    targets.add(match[1]);
  }
  return targets;
}

function runCli(cliPath, args) {
  return execFileSync(cliPath, args, {
    cwd: rootDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENTCHAT_CLI_CONTRACT_CHECK: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runCliExpectFailure(cliPath, args) {
  try {
    runCli(cliPath, args);
    fail(`${path.relative(rootDir, cliPath)} ${args.join(' ')} unexpectedly succeeded`);
    return '';
  } catch (error) {
    const stderr = error.stderr?.toString() || '';
    const stdout = error.stdout?.toString() || '';
    const output = `${stdout}\n${stderr}`;
    if (!/unknown|unsupported|not available/i.test(output)) {
      fail(`${path.relative(rootDir, cliPath)} ${args.join(' ')} failed without a clear unsupported-command message`);
    }
    if (/No such file|not found/i.test(output)) {
      fail(`${path.relative(rootDir, cliPath)} ${args.join(' ')} leaked a shell missing-file error`);
    }
    return output;
  }
}

for (const [profileName, profile] of Object.entries(manifest.profiles || {})) {
  const cliPath = path.join(rootDir, profile.cli);
  const cliRel = path.relative(rootDir, cliPath);
  const commands = profile.commands || [];
  const expectedTargets = new Set(commands.map((entry) => entry.target));

  if (!isExecutable(cliPath)) {
    fail(`${cliRel} is missing or not executable`);
    continue;
  }

  const source = readFileSync(cliPath, 'utf8');
  if (!source.includes('target_path="$SCRIPT_DIR/$target"') || !source.includes('[ ! -x "$target_path" ]')) {
    fail(`${cliRel} does not guard dispatch targets before exec`);
  } else {
    ok(`${cliRel} guards dispatch targets`);
  }

  let help = '';
  try {
    help = runCli(cliPath, ['--help']);
  } catch (error) {
    fail(`${cliRel} --help failed: ${error.stderr?.toString() || error.message}`);
    continue;
  }

  if (!help.includes('Usage: agentchat <command> [args]')) {
    fail(`${cliRel} help is missing usage header`);
  }

  for (const entry of commands) {
    if (entry.showInHelp === false) continue;
    if (!hasHelpCommand(help, entry.command)) {
      fail(`${cliRel} help is missing command '${entry.command}'`);
    }
  }

  for (const command of profile.unsupportedSmoke || []) {
    if (hasHelpCommand(help, command)) {
      fail(`${cliRel} help advertises unsupported command '${command}'`);
    }
    runCliExpectFailure(cliPath, [command]);
  }

  const actualTargets = collectDispatchTargets(source);
  for (const target of expectedTargets) {
    if (!actualTargets.has(target)) {
      fail(`${cliRel} does not dispatch expected target '${target}'`);
    }
  }
  for (const target of actualTargets) {
    if (!expectedTargets.has(target)) {
      fail(`${cliRel} dispatches unmanifested target '${target}'`);
    }
  }

  for (const target of expectedTargets) {
    const targetPath = path.join(path.dirname(cliPath), target);
    if (!isExecutable(targetPath)) {
      fail(`${profileName} dispatch target is missing or not executable: ${path.relative(rootDir, targetPath)}`);
    }
  }

  ok(`${profileName} CLI contract checked (${commands.length} command(s))`);
}

if (failures > 0) {
  console.error(`CLI contract check failed: ${failures} issue(s).`);
  process.exit(1);
}

console.log('CLI contract check passed.');
