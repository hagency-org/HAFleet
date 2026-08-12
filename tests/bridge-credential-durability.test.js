/*
 * Losing an agent's Matrix token is now PERMANENT — so the paths that could lose one must not.
 *
 * Before ADR-014 decision 3, an erased `state.agentTokens` entry cost one login: the bridge derived
 * the password again and re-registered or re-logged-in. Several paths therefore treated "start from
 * empty" as a reasonable degradation. Deleting the derivation removed the recovery, and those same
 * paths became the most destructive code in the file — a human must now create or claim an account
 * and issue a token for every entry lost.
 *
 * Two of them, both found by adversarial review rather than by a failing test:
 *
 *   loadState() caught EVERY error and returned an empty state, and startup then persisted that
 *   empty state over the file. A transient EACCES/EIO, or a torn write, destroyed every credential.
 *
 *   the pruning loops delete every token whose agent is absent from the roster. `/api/agents`
 *   answering 200 with a non-array normalizes to [], so one malformed-but-successful response wiped
 *   the fleet.
 *
 * Both are tested against the real module with a real temp directory, because both are about what
 * ends up ON DISK.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let runtimeDir;
let dataDir;
let statePath;
const savedEnv = {};
let importCounter = 0;

/** A fresh module instance bound to a fresh runtime dir — `state` is module-level, so it must be. */
async function loadBridge() {
  const url = pathToFileURL(path.resolve('bridge-matrix.js')).href;
  importCounter += 1;
  return import(`${url}?durability=${importCounter}`);
}

beforeEach(() => {
  runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'cred-durability-'));
  // DATA_DIR is `<runtime>/data/matrix`, not `<runtime>/data` — the bridge namespaces its own
  // state under the shared runtime root.
  dataDir = path.join(runtimeDir, 'data', 'matrix');
  mkdirSync(dataDir, { recursive: true });
  statePath = path.join(dataDir, 'bridge-state.json');
  for (const k of ['HAFLEET_RUNTIME_DIR', 'MATRIX_HOMESERVER', 'MATRIX_AGENT_PREFIX', 'MATRIX_SERVER_NAME']) {
    savedEnv[k] = process.env[k];
  }
  process.env.HAFLEET_RUNTIME_DIR = runtimeDir;
  process.env.MATRIX_HOMESERVER = 'https://hs.test';
  process.env.MATRIX_AGENT_PREFIX = 'ac_';
  process.env.MATRIX_SERVER_NAME = 'hs.test';
});

afterEach(() => {
  rmSync(runtimeDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('F4 — an unreadable state file is never overwritten with an empty one', () => {
  test('a corrupt file is preserved beside itself, and its bytes survive', async () => {
    /*
     * Truncated JSON is the realistic shape: a write interrupted by a kill or a full disk. The
     * tokens are still IN those bytes, so the requirement is that they remain recoverable — the
     * old behaviour replaced them with `{}` on the next startup, which is when they stopped
     * existing anywhere.
     */
    const corrupt = '{"botToken":"syt_bot","agentTokens":{"alpha":"syt_alpha","beta":"syt_b';
    writeFileSync(statePath, corrupt, { mode: 0o600 });

    const mod = await loadBridge();
    // Startup seeding calls saveState(), so by now the original file has been replaced.
    expect(mod.agentTokenStateForTest()).toEqual({});

    const preserved = readdirSync(dataDir).filter((f) => f.includes('unreadable'));
    expect(preserved.length, 'the unreadable file was not preserved').toBe(1);
    const bytes = readFileSync(path.join(dataDir, preserved[0]), 'utf-8');
    expect(bytes).toBe(corrupt);
    // The tokens are still recoverable by hand, which is the whole point.
    expect(bytes).toContain('syt_alpha');
  });

  test('the preserved copy is 0600 — it holds every credential', async () => {
    writeFileSync(statePath, '{"agentTokens":{"alpha":"syt_alpha"}', { mode: 0o600 });
    await loadBridge();
    const preserved = readdirSync(dataDir).filter((f) => f.includes('unreadable'));
    expect(preserved.length, 'nothing was preserved').toBe(1);
    const mode = statSync(path.join(dataDir, preserved[0])).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('a MISSING file still starts clean — ENOENT is the one safe empty start', async () => {
    /*
     * The distinction that makes this fix safe rather than merely strict. No file means nothing to
     * lose, so first-run must not be treated as corruption; if it were, every fresh install would
     * begin by refusing to write.
     */
    expect(existsSync(statePath)).toBe(false);
    const mod = await loadBridge();
    expect(mod.agentTokenStateForTest()).toEqual({});
    expect(readdirSync(dataDir).filter((f) => f.includes('unreadable'))).toEqual([]);
    // And writing works — nothing is blocked.
    mod.agentTokenStateForTest().alpha = 'syt_alpha';
    expect(() => mod.saveStateForTest()).not.toThrow();
    expect(JSON.parse(readFileSync(statePath, 'utf-8')).agentTokens.alpha).toBe('syt_alpha');
  });

  test('a valid file is read normally and nothing is preserved', async () => {
    writeFileSync(statePath, JSON.stringify({ botToken: 'syt_bot', agentTokens: { alpha: 'syt_alpha' } }), { mode: 0o600 });
    const mod = await loadBridge();
    expect(mod.agentTokenStateForTest().alpha).toBe('syt_alpha');
    expect(readdirSync(dataDir).filter((f) => f.includes('unreadable'))).toEqual([]);
  });
});

describe('F5 — credentials are not pruned against a roster that cannot be trusted', () => {
  /*
   * `_mayPruneAgentTokens` is the gate. Tested directly: driving it through `start()` would need a
   * homeserver, a backend and a bot login, none of which change what the gate decides.
   */
  async function bridgeWithTokens(tokens) {
    const mod = await loadBridge();
    Object.assign(mod.agentTokenStateForTest(), tokens);
    const bridge = new mod.MatrixBridge();
    return { mod, bridge };
  }

  test('a non-array roster refuses pruning', async () => {
    /*
     * HTTP 200 with `{}` — a backend contract break, an error object, an HTML error page from a
     * proxy. `normalizeAgentNameList` maps all of them to [], which is indistinguishable from an
     * empty fleet unless the malformed shape is recorded separately.
     */
    const { bridge } = await bridgeWithTokens({ alpha: 'syt_alpha' });
    bridge.callBackendApi = vi.fn().mockResolvedValue({ oops: true });
    const agents = await bridge.fetchKnownAgentNames();
    expect(agents).toEqual([]);
    expect(bridge._mayPruneAgentTokens(agents)).toBe(false);
  });

  test('an empty roster refuses pruning even when well-formed', async () => {
    /*
     * A genuinely empty fleet then keeps its orphaned entries forever. That is the intended trade:
     * a stale entry belongs to no agent and is never looked up, while a deleted live token needs a
     * human. The costs are not symmetric, so the tie goes to keeping bytes.
     */
    const { bridge } = await bridgeWithTokens({ alpha: 'syt_alpha' });
    bridge.callBackendApi = vi.fn().mockResolvedValue([]);
    const agents = await bridge.fetchKnownAgentNames();
    expect(bridge._mayPruneAgentTokens(agents)).toBe(false);
  });

  test('a well-formed non-empty roster DOES allow pruning', async () => {
    // The gate must not disable pruning outright, only withhold it on untrustworthy evidence.
    const { bridge } = await bridgeWithTokens({ alpha: 'syt_alpha' });
    bridge.callBackendApi = vi.fn().mockResolvedValue(['alpha', 'beta']);
    const agents = await bridge.fetchKnownAgentNames();
    expect(agents).toEqual(['alpha', 'beta']);
    expect(bridge._mayPruneAgentTokens(agents)).toBe(true);
  });

  test('a malformed roster observed once does not poison a later good one', async () => {
    // The malformed flag is per observation, not sticky — otherwise one bad response would disable
    // pruning until restart.
    const { bridge } = await bridgeWithTokens({ alpha: 'syt_alpha' });
    bridge.callBackendApi = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(['alpha']);
    expect(bridge._mayPruneAgentTokens(await bridge.fetchKnownAgentNames())).toBe(false);
    expect(bridge._mayPruneAgentTokens(await bridge.fetchKnownAgentNames())).toBe(true);
  });
});

describe('F7 — provisioning state is live, and reaches a surface', () => {
  test('the set tracks both directions, not just startup', async () => {
    /*
     * A startup snapshot goes stale both ways: an agent provisioned afterwards stays listed, and one
     * revoked at runtime never appears. A confidently wrong record is worse than none.
     */
    const mod = await loadBridge();
    const bridge = new mod.MatrixBridge();
    expect(bridge.unprovisionedAgentNames()).toEqual([]);

    bridge.markAgentUnprovisioned('alpha');
    bridge.markAgentUnprovisioned('beta');
    expect(bridge.unprovisionedAgentNames()).toEqual(['alpha', 'beta']);

    bridge.clearAgentUnprovisioned('alpha');
    expect(bridge.unprovisionedAgentNames()).toEqual(['beta']);
  });

  test('the health record carries the names — and the redaction guard permits the field', async () => {
    /*
     * The guard rejects any KEY matching /token|secret|passw|credential|.../, which is why the field
     * is `unprovisionedAgents` and not the more obvious `agentsMissingCredential`. Asserting it here
     * means a future rename that trips the guard fails in a test instead of silently disabling the
     * only durable record of which agents are inert.
     */
    const { buildBridgeHealthRecord, findSensitiveFields } = await import('../src/health-record.mjs');
    const record = buildBridgeHealthRecord({ unprovisionedAgents: ['beta', 'alpha', 'alpha'] });
    expect(record.unprovisionedAgents).toEqual(['alpha', 'beta']);
    expect(findSensitiveFields(record)).toEqual([]);
  });

  test('the health record never carries a token, only a name', async () => {
    const { buildBridgeHealthRecord } = await import('../src/health-record.mjs');
    const record = buildBridgeHealthRecord({ unprovisionedAgents: ['alpha'] });
    expect(JSON.stringify(record)).not.toContain('syt_');
  });

  test('junk entries are dropped rather than written through', async () => {
    const { buildBridgeHealthRecord } = await import('../src/health-record.mjs');
    const record = buildBridgeHealthRecord({ unprovisionedAgents: ['  alpha  ', '', null, 42, 'alpha'] });
    expect(record.unprovisionedAgents).toEqual(['alpha']);
  });
});

describe('F3 — a missing credential must not become an unhandled rejection', () => {
  /*
   * `ensureAgentAccount` now THROWS for an unprovisioned agent. Two SSE handlers awaited it bare,
   * and the SSE dispatch calls those handlers WITHOUT await inside a synchronous try — so the
   * rejection escaped as an unhandled rejection, which modern Node treats as fatal. An expected
   * standing condition would have taken the whole bridge down.
   *
   * The handlers were written when a throw here was almost impossible, which is why nothing caught
   * it: the derived password could always mint a credential.
   */
  async function bridgeForGroups() {
    const mod = await loadBridge();
    const bridge = new mod.MatrixBridge();
    bridge.resolveKnownAgentName = (n) => n;
    bridge.getAgentToken = () => null;          // no credential anywhere
    bridge.createRoomForGroup = vi.fn().mockResolvedValue('!room:hs.test');
    return { mod, bridge };
  }

  test('onGroupCreated resolves instead of rejecting, and still creates the room', async () => {
    /*
     * Still creates the room: one unprovisioned agent must not deny the whole group its room. The
     * agent simply joins without a Matrix identity, which is the honest outcome — the alternative
     * silently punishes every other member for one missing token.
     */
    const { bridge } = await bridgeForGroups();
    await expect(bridge.onGroupCreated({ name: 'g1', members: ['alpha', 'beta'] })).resolves.toBeUndefined();
    expect(bridge.createRoomForGroup).toHaveBeenCalledWith('g1', ['alpha', 'beta']);
  });

  test('every SSE handler call has a rejection handler attached', async () => {
    /*
     * A source assertion, because the defect is structural: `this.onX(evt)` returns a floating
     * promise, and the enclosing try/catch is synchronous so it cannot see the rejection. The
     * property is "no un-awaited handler call lacks .catch", which no single behavioural test
     * covers — there are six call sites and the next one added would be the regression.
     */
    const src = readFileSync(path.resolve('bridge-matrix.js'), 'utf-8');
    const bare = src.split('\n').filter((line) => /^\s+this\.on[A-Z][A-Za-z]*\([a-z][A-Za-z]*\);\s*$/.test(line));
    expect(bare, `un-awaited SSE handler calls with no .catch:\n${bare.join('\n')}`).toEqual([]);
  });
});
