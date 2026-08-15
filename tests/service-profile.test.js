import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

import { loadServiceProfile } from '../src/service-profile.mjs';

const tempDirs = [];

function fixtureProfile(mutator = (value) => value) {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'hafleet-service-profile-'));
  tempDirs.push(repoRoot);
  for (const script of ['backend.mjs', 'dashboard.mjs', 'bridge.mjs', 'relay.mjs']) {
    writeFileSync(path.join(repoRoot, script), 'setInterval(() => {}, 1000);\n');
  }
  const value = {
    name: 'services-local',
    services: [
      {
        name: 'backend',
        command: ['node', 'backend.mjs'],
        dependsOn: [],
        health: { type: 'http', host: '127.0.0.1', defaultPort: 18090, path: '/health', timeoutMs: 500 },
      },
      {
        name: 'dashboard',
        command: ['node', 'dashboard.mjs'],
        dependsOn: ['backend'],
        health: { type: 'tcp', host: '127.0.0.1', defaultPort: 18084, timeoutMs: 500 },
      },
      {
        name: 'bridge',
        command: ['node', 'bridge.mjs'],
        dependsOn: ['backend'],
        health: { type: 'process', timeoutMs: 500 },
      },
      {
        name: 'relay',
        command: ['node', 'relay.mjs'],
        dependsOn: ['backend'],
        health: { type: 'process', timeoutMs: 500 },
      },
    ],
  };
  const profile = structuredClone(value);
  mutator(profile, repoRoot);
  const profilePath = path.join(repoRoot, 'services-local.json');
  writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
  return { repoRoot, profilePath };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('loadServiceProfile', () => {
  test('loads the production profile with the exact dependency-ordered service set', () => {
    const profile = loadServiceProfile({
      profilePath: path.resolve('services/services-local.json'),
      repoRoot: path.resolve('.'),
    });

    expect(profile.name).toBe('services-local');
    /*
     * THREE services. The dashboard (server.js) is deleted — the portal retired, its delivery queue
     * moved into the backend — so the production profile stops listing it, or the supervisor would flap
     * a service whose entry file does not exist.
     */
    expect(profile.services.map((service) => service.name)).toEqual([
      'backend', 'bridge', 'relay',
    ]);
    expect(profile.services.map((service) => service.command)).toEqual([
      ['node', 'backend-v2.js'],
      ['node', 'bridge-matrix.js'],
      ['node', 'push-relay.js'],
    ]);
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.services[0])).toBe(true);
  });

  test.each([
    ['missing service', (profile) => { profile.services.pop(); }],
    ['duplicate service', (profile) => { profile.services[3].name = 'bridge'; }],
    ['unknown service', (profile) => { profile.services[3].name = 'worker'; }],
    ['string command', (profile) => { profile.services[0].command = 'node backend.mjs'; }],
    ['empty command argument', (profile) => { profile.services[0].command = ['node', '']; }],
    ['unknown dependency', (profile) => { profile.services[1].dependsOn = ['database']; }],
    ['dependency cycle', (profile) => { profile.services[0].dependsOn = ['relay']; }],
    ['unsupported health', (profile) => { profile.services[0].health.type = 'shell'; }],
    ['short timeout', (profile) => { profile.services[0].health.timeoutMs = 50; }],
    ['long timeout', (profile) => { profile.services[0].health.timeoutMs = 5000; }],
    ['invalid port', (profile) => { profile.services[0].health.defaultPort = 70000; }],
  ])('rejects %s', (_label, mutate) => {
    const { repoRoot, profilePath } = fixtureProfile(mutate);
    expect(() => loadServiceProfile({ profilePath, repoRoot })).toThrow();
  });

  test('rejects script paths outside the repository', () => {
    const { repoRoot, profilePath } = fixtureProfile((profile) => {
      profile.services[0].command = ['node', '../outside.mjs'];
    });
    expect(() => loadServiceProfile({ profilePath, repoRoot })).toThrow(/outside repository/i);
  });

  test('rejects a profile path outside the repository', () => {
    const { repoRoot, profilePath } = fixtureProfile();
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-profile-outside-'));
    tempDirs.push(outsideDir);
    const outsidePath = path.join(outsideDir, 'profile.json');
    writeFileSync(outsidePath, '{}\n');

    expect(() => loadServiceProfile({ profilePath: outsidePath, repoRoot })).toThrow(/outside repository/i);
    expect(profilePath).toContain(repoRoot);
  });

  test('rejects non-file service scripts', () => {
    const { repoRoot, profilePath } = fixtureProfile((profile, root) => {
      mkdirSync(path.join(root, 'not-a-script'), { recursive: true });
      profile.services[0].command = ['node', 'not-a-script'];
    });
    expect(() => loadServiceProfile({ profilePath, repoRoot })).toThrow(/script/i);
  });
});
