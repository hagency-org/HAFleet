import { afterEach, describe, expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  applyEnvUpdates,
  parseDotEnv,
  PALPO_MATRIX_MAP,
} from '../services/configure-standalone-env.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve('.');
const cliPath = path.join(repoRoot, 'services', 'configure-standalone-env.mjs');
const tempDirs = [];

function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'configure-standalone-env-'));
  tempDirs.push(dir);
  return dir;
}

function writeEnvFixture(dir, content, mode = 0o644) {
  const envPath = path.join(dir, '.env');
  writeFileSync(envPath, content, { mode });
  return envPath;
}

async function runCli(args) {
  return execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('parseDotEnv / applyEnvUpdates (unit)', () => {
  test('replaces an existing empty value', () => {
    const { content, updatedKeys } = applyEnvUpdates(
      'FOO=bar\nMATRIX_BRIDGE_SECRET=\nBAZ=qux\n',
      new Map([['MATRIX_BRIDGE_SECRET', 'new-secret']]),
    );
    expect(updatedKeys).toEqual(['MATRIX_BRIDGE_SECRET']);
    expect(content).toBe('FOO=bar\nMATRIX_BRIDGE_SECRET=new-secret\nBAZ=qux\n');
  });

  test('replaces an existing non-empty value', () => {
    const { content, updatedKeys } = applyEnvUpdates(
      'MATRIX_BRIDGE_SECRET=old-value\n',
      new Map([['MATRIX_BRIDGE_SECRET', 'new-secret']]),
    );
    expect(updatedKeys).toEqual(['MATRIX_BRIDGE_SECRET']);
    expect(content).toBe('MATRIX_BRIDGE_SECRET=new-secret\n');
  });

  test('appends a key that does not exist yet, without disturbing existing lines', () => {
    const { content, updatedKeys } = applyEnvUpdates(
      'FOO=bar\n',
      new Map([['HAFLEET_AGENT_TOKEN_MODE', 'hard']]),
    );
    expect(updatedKeys).toEqual(['HAFLEET_AGENT_TOKEN_MODE']);
    expect(content).toBe('FOO=bar\nHAFLEET_AGENT_TOKEN_MODE=hard\n');
  });

  test('rejects a target file with duplicate keys and throws before returning any content', () => {
    expect(() => applyEnvUpdates('FOO=1\nFOO=2\n', new Map([['FOO', '3']]))).toThrow(/duplicate/i);
  });

  test('duplicate rejection fires even for keys unrelated to the requested update', () => {
    expect(() => applyEnvUpdates(
      'UNRELATED=1\nUNRELATED=2\nMATRIX_BRIDGE_SECRET=x\n',
      new Map([['MATRIX_BRIDGE_SECRET', 'y']]),
    )).toThrow(/duplicate/i);
  });

  test('preserves unknown keys, comments, and blank lines untouched', () => {
    const original = '# a comment\nUNKNOWN_KEY=untouched\n\nMATRIX_BRIDGE_SECRET=old\n';
    const { content } = applyEnvUpdates(original, new Map([['MATRIX_BRIDGE_SECRET', 'new']]));
    expect(content).toBe('# a comment\nUNKNOWN_KEY=untouched\n\nMATRIX_BRIDGE_SECRET=new\n');
  });

  test('parseDotEnv reports the file duplicate-free when keys are unique', () => {
    const { duplicateKeys } = parseDotEnv('A=1\nB=2\n');
    expect(duplicateKeys.size).toBe(0);
  });

  test('PALPO_MATRIX_MAP exposes exactly the four whitelisted mappings', () => {
    expect(PALPO_MATRIX_MAP).toEqual({
      PALPO_PUBLIC_URL: 'MATRIX_HOMESERVER',
      PALPO_SERVER_NAME: 'MATRIX_SERVER_NAME',
      PALPO_REGISTRATION_TOKEN: 'MATRIX_REG_TOKEN',
      PALPO_BOT_PASSWORD: 'MATRIX_BOT_PASSWORD',
    });
  });
});

describe('configure-standalone-env CLI', () => {
  test('generates a random bridge secret and sets hard token mode, printing only key names', async () => {
    const dir = tempDir();
    const envPath = writeEnvFixture(dir, 'MATRIX_BRIDGE_SECRET=\nHAFLEET_AGENT_TOKEN_MODE=audit\nFOO=bar\n');

    const { stdout } = await runCli(['--env', envPath, '--generate-bridge-secret', '--agent-token-mode', 'hard']);

    expect(stdout).toContain('MATRIX_BRIDGE_SECRET');
    expect(stdout).toContain('HAFLEET_AGENT_TOKEN_MODE');
    expect(stdout).not.toContain('FOO');
    expect(stdout).not.toMatch(/=/);

    const updated = readFileSync(envPath, 'utf8');
    const secretMatch = updated.match(/^MATRIX_BRIDGE_SECRET=(.*)$/m);
    expect(secretMatch[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(stdout).not.toContain(secretMatch[1]);
    expect(updated).toContain('HAFLEET_AGENT_TOKEN_MODE=hard');
    expect(updated).toContain('FOO=bar');
  });

  test('keeps file mode 0600 after an atomic write, even if it started more permissive', async () => {
    const dir = tempDir();
    const envPath = writeEnvFixture(dir, 'MATRIX_BRIDGE_SECRET=\n', 0o644);
    expect(statSync(envPath).mode & 0o777).toBe(0o644);

    await runCli(['--env', envPath, '--generate-bridge-secret']);

    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  test('leaves no leftover temp file after a successful atomic write', async () => {
    const dir = tempDir();
    const envPath = writeEnvFixture(dir, 'MATRIX_BRIDGE_SECRET=\n');
    await runCli(['--env', envPath, '--generate-bridge-secret']);
    const { readdirSync } = await import('node:fs');
    const names = readdirSync(dir);
    expect(names).toEqual(['.env']);
  });

  test('generates a different random secret on each invocation', async () => {
    const dir = tempDir();
    const envPath = writeEnvFixture(dir, 'MATRIX_BRIDGE_SECRET=first\n');
    await runCli(['--env', envPath, '--generate-bridge-secret']);
    const first = readFileSync(envPath, 'utf8').match(/^MATRIX_BRIDGE_SECRET=(.*)$/m)[1];
    await runCli(['--env', envPath, '--generate-bridge-secret']);
    const second = readFileSync(envPath, 'utf8').match(/^MATRIX_BRIDGE_SECRET=(.*)$/m)[1];
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
  });

  test('rejects a target file with duplicate keys via the CLI and leaves it byte-for-byte unmodified', async () => {
    const dir = tempDir();
    const envPath = writeEnvFixture(dir, 'MATRIX_BRIDGE_SECRET=a\nMATRIX_BRIDGE_SECRET=b\n');
    const before = readFileSync(envPath, 'utf8');

    await expect(runCli(['--env', envPath, '--generate-bridge-secret'])).rejects.toMatchObject({ code: 1 });

    expect(readFileSync(envPath, 'utf8')).toBe(before);
  });

  test('errors clearly when no action flag is given', async () => {
    const dir = tempDir();
    const envPath = writeEnvFixture(dir, 'FOO=bar\n');
    await expect(runCli(['--env', envPath])).rejects.toMatchObject({ code: 1 });
  });

  test('errors when --env does not exist instead of creating a new file', async () => {
    const dir = tempDir();
    const missing = path.join(dir, 'does-not-exist.env');
    await expect(runCli(['--env', missing, '--generate-bridge-secret'])).rejects.toMatchObject({ code: 1 });
  });

  test('maps the four whitelisted palpo keys onto their matrix equivalents and reports only target key names', async () => {
    const dir = tempDir();
    const envPath = writeEnvFixture(dir, 'MATRIX_HOMESERVER=https://old.example\n');
    const palpoPath = path.join(dir, 'palpo.env');
    writeFileSync(palpoPath, [
      'PALPO_PUBLIC_URL=https://palpo.example',
      'PALPO_SERVER_NAME=palpo.example',
      'PALPO_REGISTRATION_TOKEN=reg-tok-123',
      'PALPO_BOT_PASSWORD=bot-pw-456',
      'PALPO_UNRELATED_SECRET=should-not-copy',
      '',
    ].join('\n'));

    const { stdout } = await runCli(['--env', envPath, '--palpo-env', palpoPath, '--map-matrix']);

    const updated = readFileSync(envPath, 'utf8');
    expect(updated).toContain('MATRIX_HOMESERVER=https://palpo.example');
    expect(updated).toContain('MATRIX_SERVER_NAME=palpo.example');
    expect(updated).toContain('MATRIX_REG_TOKEN=reg-tok-123');
    expect(updated).toContain('MATRIX_BOT_PASSWORD=bot-pw-456');
    expect(updated).not.toContain('PALPO_UNRELATED_SECRET');

    expect(stdout).toContain('MATRIX_HOMESERVER');
    expect(stdout).toContain('MATRIX_SERVER_NAME');
    expect(stdout).toContain('MATRIX_REG_TOKEN');
    expect(stdout).toContain('MATRIX_BOT_PASSWORD');
    expect(stdout).not.toContain('PALPO_PUBLIC_URL');
    expect(stdout).not.toContain('reg-tok-123');
    expect(stdout).not.toContain('bot-pw-456');
    expect(stdout).not.toMatch(/=/);
  });

  test('skips a whitelist mapping whose source key is absent instead of blanking the target', async () => {
    const dir = tempDir();
    const envPath = writeEnvFixture(dir, 'MATRIX_BOT_PASSWORD=existing-pw\n');
    const palpoPath = path.join(dir, 'palpo.env');
    writeFileSync(palpoPath, 'PALPO_PUBLIC_URL=https://palpo.example\n');

    const { stdout } = await runCli(['--env', envPath, '--palpo-env', palpoPath, '--map-matrix']);

    const updated = readFileSync(envPath, 'utf8');
    expect(updated).toContain('MATRIX_BOT_PASSWORD=existing-pw');
    expect(stdout).not.toContain('MATRIX_BOT_PASSWORD');
  });

  test('--map-matrix without --palpo-env errors clearly', async () => {
    const dir = tempDir();
    const envPath = writeEnvFixture(dir, 'FOO=bar\n');
    await expect(runCli(['--env', envPath, '--map-matrix'])).rejects.toMatchObject({ code: 1 });
  });

  test('--palpo-env without --map-matrix errors clearly', async () => {
    const dir = tempDir();
    const envPath = writeEnvFixture(dir, 'FOO=bar\n');
    const palpoPath = path.join(dir, 'palpo.env');
    writeFileSync(palpoPath, 'PALPO_PUBLIC_URL=https://palpo.example\n');
    await expect(runCli(['--env', envPath, '--palpo-env', palpoPath])).rejects.toMatchObject({ code: 1 });
  });
});
