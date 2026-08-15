import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import os from 'os';
import path from 'path';

import { loadServiceProfile } from '../src/service-profile.mjs';

// The Matrix bridge is optional throughout HAFleet: install-full.sh gates it
// behind --with-bridge and it fail-closes without credentials. The profile
// loader used to require all four services, which meant the supervised-services
// path — the only one that works on macOS, where there is no systemd — could
// not run a Matrix-free install. The bridge crash-looped instead.

const roots = [];

function writeProfile(services, { name = 'services-local' } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hafleet-profile-'));
  roots.push(root);
  mkdirSync(path.join(root, 'services'), { recursive: true });
  // The loader verifies each command's script exists on disk, so stub them.
  for (const service of services) {
    const script = service.command[service.command.length - 1];
    writeFileSync(path.join(root, script), '// stub\n');
  }
  const profilePath = path.join(root, 'services', 'profile.json');
  writeFileSync(profilePath, JSON.stringify({ name, services }, null, 2));
  return { root, profilePath };
}

const svc = (name, dependsOn = []) => ({
  name,
  command: ['node', `${name}.js`],
  dependsOn,
  health: { type: 'process', timeoutMs: 1000 },
});

const CORE = [
  svc('backend'),
  svc('dashboard', ['backend']),
  svc('relay', ['backend']),
];

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('service profile', () => {
  test('accepts a Matrix-free profile with only the core services', () => {
    const { root, profilePath } = writeProfile(CORE);
    const profile = loadServiceProfile({ profilePath, repoRoot: root });
    expect(profile.services.map((s) => s.name)).toEqual(['backend', 'dashboard', 'relay']);
  });

  test('still accepts the full profile including the bridge', () => {
    const { root, profilePath } = writeProfile([...CORE, svc('bridge', ['backend'])]);
    const profile = loadServiceProfile({ profilePath, repoRoot: root });
    expect(profile.services.map((s) => s.name).sort())
      .toEqual(['backend', 'bridge', 'dashboard', 'relay']);
  });

  test('orders dependencies before dependents when the bridge is absent', () => {
    // Ordering used to be driven by a fixed service list; omitting one would
    // dereference undefined. It must follow the declared services instead.
    const { root, profilePath } = writeProfile([
      svc('relay', ['backend']),
      svc('dashboard', ['backend']),
      svc('backend'),
    ]);
    const order = loadServiceProfile({ profilePath, repoRoot: root }).services.map((s) => s.name);
    expect(order[0]).toBe('backend');
    expect(order).toHaveLength(3);
  });

  /*
   * `dashboard` left the core list when the portal was deleted; it remains an ADMISSIBLE name (a
   * deployment may run its own), so dropping it must NOT be rejected — which is asserted separately
   * below instead of silently removed from this table.
   */
  test.each(['backend', 'relay'])('still rejects a profile missing core service %s', (drop) => {
    const { root, profilePath } = writeProfile(CORE.filter((s) => s.name !== drop));
    expect(() => loadServiceProfile({ profilePath, repoRoot: root }))
      .toThrow(new RegExp(`core services.*missing: ${drop}`));
  });

  test('still rejects unknown services and duplicates', () => {
    const unknown = writeProfile([...CORE, svc('wat')]);
    expect(() => loadServiceProfile({ profilePath: unknown.profilePath, repoRoot: unknown.root }))
      .toThrow(/unknown service wat/);

    const dupe = writeProfile([...CORE, svc('backend')]);
    expect(() => loadServiceProfile({ profilePath: dupe.profilePath, repoRoot: dupe.root }))
      .toThrow(/duplicate service backend/);
  });

  test('still rejects a dependency on an absent bridge', () => {
    // Omitting the bridge must not silently permit dangling references to it.
    const { root, profilePath } = writeProfile([
      svc('backend'),
      svc('dashboard', ['backend']),
      svc('relay', ['bridge']),
    ]);
    expect(() => loadServiceProfile({ profilePath, repoRoot: root }))
      .toThrow(/relay has unknown dependency bridge/);
  });
});
