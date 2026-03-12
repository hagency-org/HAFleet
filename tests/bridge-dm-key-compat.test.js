import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { pathToFileURL } from 'url';

describe('DM key backward compatibility (5.8.4 migration)', () => {
  let runtimeDir;
  let MatrixBridge;
  let statePath;

  beforeAll(async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'bridge-dm-key-compat-test-'));
    const matrixDir = path.join(runtimeDir, 'data', 'matrix');
    mkdirSync(matrixDir, { recursive: true });
    statePath = path.join(matrixDir, 'bridge-state.json');
    // Seed bridge-state with old-format DM key (pre-5.8.4: dm:agentName only)
    writeFileSync(statePath, JSON.stringify({
      botToken: null,
      agentTokens: {},
      roomGroupMap: {},
      groupRoomMap: {},
      dmRooms: {
        'dm:testagent': '!old-correct-room:matrix.test',
      },
    }, null, 2));
    process.env.AGENT_CHAT_RUNTIME_DIR = runtimeDir;
    process.env.MATRIX_TRUST_MODE = 'audit';

    const bridgeUrl = pathToFileURL(path.resolve('bridge-matrix.js')).href;
    const cacheBust = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    ({ MatrixBridge } = await import(`${bridgeUrl}?dm-compat-test=${cacheBust}`));
  });

  afterAll(() => {
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  test('ensureDmRoom finds old dm:agent key and normalizes to dm:agent:human', async () => {
    const bridge = new MatrixBridge();
    // Register testagent as a known agent
    bridge.knownAgents.add('testagent');
    bridge.knownAgentIndex.set('testagent', 'testagent');
    // Stub Matrix API methods that ensureDmRoom calls after finding a room
    bridge._upgradeLegacyDmRoom = async () => {};
    bridge._ensureHumanInviteOrFail = async () => ({ ok: true });

    // Call ensureDmRoom: agent=testagent, human=alice → new key would be dm:testagent:alice
    const roomId = await bridge.ensureDmRoom('testagent', 'alice', { forceAgentName: 'testagent' });

    // Should find the old dm:testagent room, not create a new one
    expect(roomId).toBe('!old-correct-room:matrix.test');

    // Should have normalized: new key saved in persisted state
    const savedState = JSON.parse(readFileSync(statePath, 'utf-8'));
    expect(savedState.dmRooms['dm:testagent:alice']).toBe('!old-correct-room:matrix.test');
    // Old key should still exist (not deleted)
    expect(savedState.dmRooms['dm:testagent']).toBe('!old-correct-room:matrix.test');

    // In-memory cache should have the new key
    expect(bridge.dmRooms.get('dm:testagent:alice')).toBe('!old-correct-room:matrix.test');
  });
});
