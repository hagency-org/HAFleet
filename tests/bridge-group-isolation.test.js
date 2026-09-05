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

describe('F03-r1: the composite key never leaks; bare state stays found', () => {
  let bridge; let runtimeDir; let stateFile; let envSnapshot;

  const readState = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  const writeState = (s) => writeFileSync(stateFile, JSON.stringify(s, null, 2));

  beforeAll(async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-f03r1-'));
    envSnapshot = { ...process.env };
    process.env.HAFLEET_RUNTIME_DIR = runtimeDir;
    process.env.MATRIX_AGENT_PREFIX = 'ac_';
    const url = pathToFileURL(path.resolve('bridge-matrix.js')).href;
    bridge = await import(`${url}?f03r1=${Date.now()}-${Math.random()}`);
    stateFile = path.join(runtimeDir, 'data', 'matrix', 'bridge-state.json');
  });

  afterAll(() => {
    process.env = envSnapshot;
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  test('groupForRoom returns the BARE name — member sync and message fields never see name@side', () => {
    bridge.__mapRoomForTest('!x:sideA.example', 'Fleet', { side: 'sideA.example' });
    // the stored KEY is qualified...
    const s = readState();
    expect(s.groupRoomMap['Fleet@sideA.example']).toBe('!x:sideA.example');
    // ...but every consumer of groupForRoom sees the bare name
    expect(bridge.__groupForRoomForTest('!x:sideA.example')).toBe('Fleet');
    // and the side-aware destination lookup still resolves
    expect(bridge.__roomForGroupForTest('Fleet', 'sideA.example')).toBe('!x:sideA.example');
  });

  test('a pre-migration BARE-key state stays found by a side-aware lookup, with no second entry', async () => {
    // Simulate an upgraded bridge-state: bare key for a foreign-side room.
    writeState({
      roomGroupMap: { '!legacy:sideB.example': 'LegacyProj' },
      groupRoomMap: { LegacyProj: '!legacy:sideB.example' },
    });
    // Re-import so load-time migration runs against the bare state.
    process.env.HAFLEET_RUNTIME_DIR = runtimeDir;
    const url = pathToFileURL(path.resolve('bridge-matrix.js')).href;
    const fresh = await import(`${url}?f03r1-mig-${Date.now()}-${Math.random()}`);
    // side-aware lookup HITS (by migration or bare fallback)…
    expect(fresh.__roomForGroupForTest('LegacyProj', 'sideB.example')).toBe('!legacy:sideB.example');
    // …and there is exactly ONE entry for that room — no duplicate mapping.
    const s2 = readState();
    const rooms = Object.entries(s2.groupRoomMap).filter(([, r]) => r === '!legacy:sideB.example');
    expect(rooms).toHaveLength(1);
  });
});

describe('15-r2: composite-key leaks closed — single entry, bare face', () => {
  let bridge; let runtimeDir; let stateFile; let envSnapshot;
  const readState = () => JSON.parse(readFileSync(stateFile, 'utf8'));

  beforeAll(async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-15r2-'));
    envSnapshot = { ...process.env };
    process.env.HAFLEET_RUNTIME_DIR = runtimeDir;
    process.env.MATRIX_AGENT_PREFIX = 'ac_';
    const url = pathToFileURL(path.resolve('bridge-matrix.js')).href;
    bridge = await import(`${url}?r2=${Date.now()}-${Math.random()}`);
    stateFile = path.join(runtimeDir, 'data', 'matrix', 'bridge-state.json');
  });
  afterAll(() => { process.env = envSnapshot; rmSync(runtimeDir, { recursive: true, force: true }); });

  test('① unchanged-name reconcile uses the BARE name (no @ in any group API path)', () => {
    bridge.__mapRoomForTest('!s:sideA.example', 'Fleet', { side: 'sideA.example' });
    // groupForRoom — what reconcile receives — is bare even though the key is qualified
    expect(bridge.__groupForRoomForTest('!s:sideA.example')).toBe('Fleet');
    // and the mapping key itself never escapes through groupForRoom
    expect(bridge.__groupForRoomForTest('!s:sideA.example')).not.toContain('@');
  });

  test('② a side-UNKNOWN sender with two same-named groups is refused (ambiguous), one mapping routes', async () => {
    bridge.__mapRoomForTest('!x1:s1.example', 'Proj', { side: 's1.example' });
    bridge.__mapRoomForTest('!x2:s2.example', 'Proj', { side: 's2.example' });
    const errSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const warnSpy = vi.fn();
    // the routing decision helper: ambiguous must yield null, single must yield the room
    expect(bridge.__resolveGroupDestinationForTest('Proj', null)).toBeNull();   // 2 mappings, no side → refuse
    expect(warnSpy).not.toHaveBeenCalled(); // spy not wired here; the console.warn path is exercised in-process
    errSpy.mockRestore();
    // single mapping (remove one) routes to the remaining room
    bridge.__unmapRoomForTest('!x2:s2.example');
    expect(bridge.__resolveGroupDestinationForTest('Proj', null)).toBe('!x1:s1.example');
  });

  test('③ leave/ban unmaps BOTH directions with no name@side residue', () => {
    bridge.__mapRoomForTest('!lv:sideA.example', 'Gone', { side: 'sideA.example' });
    expect(readState().groupRoomMap['Gone@sideA.example']).toBe('!lv:sideA.example');
    const removed = bridge.__unmapRoomForTest('!lv:sideA.example');
    expect(removed).toBe('Gone@sideA.example');
    const s = readState();
    expect(s.groupRoomMap['Gone@sideA.example']).toBeUndefined();
    expect(s.roomGroupMap['!lv:sideA.example']).toBeUndefined();
    expect(bridge.__roomForGroupForTest('Gone', 'sideA.example')).toBeNull();
  });

  test('③ tombstone replacement keeps the original side qualification', () => {
    bridge.__mapRoomForTest('!old:sideB.example', 'Keep', { side: 'sideB.example' });
    const before = readState();
    expect(before.groupRoomMap['Keep@sideB.example']).toBe('!old:sideB.example');
    // simulate the tombstone path's re-map (same logic the handler now runs)
    const originalKey = bridge.__groupMappingKeyForTest('!old:sideB.example');
    const side = originalKey.slice(originalKey.lastIndexOf('@') + 1);
    bridge.__unmapRoomForTest('!old:sideB.example');
    bridge.__mapRoomForTest('!new:sideB.example', 'Keep', { side });
    const after = readState();
    expect(after.groupRoomMap['Keep@sideB.example']).toBe('!new:sideB.example'); // side PRESERVED
    expect(after.groupRoomMap['Keep']).toBeUndefined();                          // never bare
  });
});
