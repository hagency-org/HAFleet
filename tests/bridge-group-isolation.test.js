import { describe, expect, test, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

/*
 * F03 regression suite: same display name on two different sides must never
 * rebind a group, and group routing must resolve by the stable (name, side) key.
 * Drives the REAL module with an isolated HAFLEET_RUNTIME_DIR (F02 discipline:
 * no default runtime writes).
 */

describe('F03: group↔room mapping is keyed by stable identity, not display name', () => {
  let bridge;
  let runtimeDir;
  let stateFile;
  let envSnapshot;
  let errSpy;

  const readState = () => JSON.parse(readFileSync(stateFile, 'utf8'));

  const seed = () => {
    // Seed THROUGH the real mapRoom: the module's in-memory state is what
    // mapRoom/roomForGroup read (writing the file directly would not reach it).
    // Different sides owning the same display name is the legitimate case F03
    // must preserve — each mapRoom call below binds its own side-qualified key.
    bridge.__mapRoomForTest('!a:sideA.example', 'proj', { side: 'sideA.example' });
    bridge.__mapRoomForTest('!b:sideB.example', 'proj', { side: 'sideB.example' });
    const s = readState();
    s.groupMapConflicts = [];
    writeFileSync(stateFile, JSON.stringify(s, null, 2));
  };

  beforeAll(async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-f03-'));
    envSnapshot = { ...process.env };
    process.env.HAFLEET_RUNTIME_DIR = runtimeDir;
    process.env.MATRIX_AGENT_PREFIX = 'ac_';
    const url = pathToFileURL(path.resolve('bridge-matrix.js')).href;
    bridge = await import(`${url}?f03=${Date.now()}-${Math.random()}`);
    stateFile = path.join(runtimeDir, 'data', 'matrix', 'bridge-state.json');
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    errSpy?.mockRestore();
    process.env = envSnapshot;
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  test('two trusted rooms with the same display name on different sides keep their mappings; a rebinding attempt is refused AND reported', () => {
    seed();
    const ok = bridge.__mapRoomForTest('!c:sideB.example', 'proj', { side: 'sideB.example' });
    expect(ok).toBe(false);
    const s = readState();
    expect(s.groupRoomMap['proj@sideA.example']).toBe('!a:sideA.example');
    expect(s.groupRoomMap['proj@sideB.example']).toBe('!b:sideB.example');
    expect(s.groupRoomMap['proj@sideB.example']).not.toBe('!c:sideB.example');
    const msg = errSpy.mock.calls.flat().join(' ');
    expect(msg).toContain('refusing to rebind');
    expect(s.groupMapConflicts).toHaveLength(1);
    expect(s.groupMapConflicts[0]).toMatchObject({ groupName: 'proj', toRoom: '!c:sideB.example' });
  });

  test('a same display name on a DIFFERENT side does not collide (the key carries the side)', () => {
    seed();
    const ok = bridge.__mapRoomForTest('!b:sideB.example', 'other', { side: 'sideB.example' });
    expect(ok).toBe(true);
    const s = readState();
    expect(s.groupRoomMap['proj@sideA.example']).toBe('!a:sideA.example');
    expect(s.groupRoomMap['other@sideB.example']).toBe('!b:sideB.example');
  });

  test('a group message with no reply metadata resolves the destination by SIDE', () => {
    seed();
    expect(bridge.__roomForGroupForTest('proj', 'sideA.example')).toBe('!a:sideA.example');
    expect(bridge.__roomForGroupForTest('proj', 'sideB.example')).toBe('!b:sideB.example');
    expect(['!a:sideA.example', '!b:sideB.example']).toContain(bridge.__roomForGroupForTest('proj'));
  });
});
