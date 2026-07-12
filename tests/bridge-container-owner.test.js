import { afterEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { prepareBridgeContainerOwnership } from '../src/bridge-container-owner.mjs';

const runtimes = [];

function runtime() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agentchat-bridge-container-owner-'));
  runtimes.push(root);
  mkdirSync(path.join(root, 'data', 'matrix'), { recursive: true });
  mkdirSync(path.join(root, 'data', 'services-local'), { recursive: true });
  return root;
}

function writeJson(filename, value) {
  writeFileSync(filename, `${JSON.stringify(value)}\n`);
}

afterEach(() => {
  for (const root of runtimes.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('bridge container owner preparation', () => {
  test('refuses to remove an owner not created by the Compose wrapper', () => {
    const root = runtime();
    const ownerPath = path.join(root, 'data', 'matrix', 'bridge-owner.lock');
    writeJson(ownerPath, { pid: 1, hostname: 'foreign-container' });

    expect(() => prepareBridgeContainerOwnership({
      runtimeRoot: root,
      hostname: 'new-compose-container',
    })).toThrow(/foreign|outside|unmanaged/i);
    expect(JSON.parse(readFileSync(ownerPath, 'utf8')).hostname).toBe('foreign-container');
  });

  test('recovers only an owner matching the previous Compose marker', () => {
    const root = runtime();
    const ownerPath = path.join(root, 'data', 'matrix', 'bridge-owner.lock');
    const markerPath = path.join(root, 'data', 'services-local', 'bridge-container-owner.json');
    writeJson(ownerPath, { pid: 1, hostname: 'old-compose-container' });
    writeJson(markerPath, {
      managedBy: 'agentchat-services-compose',
      hostname: 'old-compose-container',
    });

    const result = prepareBridgeContainerOwnership({
      runtimeRoot: root,
      hostname: 'new-compose-container',
    });

    expect(result.recovered).toBe(true);
    expect(() => readFileSync(ownerPath, 'utf8')).toThrow();
    expect(JSON.parse(readFileSync(markerPath, 'utf8'))).toMatchObject({
      managedBy: 'agentchat-services-compose',
      hostname: 'new-compose-container',
    });
  });

  test('fails closed when an existing owner lock is not valid JSON', () => {
    const root = runtime();
    const ownerPath = path.join(root, 'data', 'matrix', 'bridge-owner.lock');
    writeFileSync(ownerPath, '{partial');

    expect(() => prepareBridgeContainerOwnership({
      runtimeRoot: root,
      hostname: 'new-compose-container',
    })).toThrow(/invalid|parse|unmanaged|owner/i);
    expect(readFileSync(ownerPath, 'utf8')).toBe('{partial');
  });
});
