/*
 * `bridge-state.json` is a credential store, and it was world-readable.
 *
 * The file holds `botToken` and every entry of `agentTokens` — visible in `loadState`'s own
 * fallback shape (`bridge-matrix.js`). A Matrix access token IS the identity: whoever reads one
 * can post as that agent and read every room it is in, and the bot token additionally belongs to
 * the E2EE sender and the authorization service.
 *
 * It was written with `writeFileSync(path, data)` and no mode, which is 0644, so every other
 * account on the host could read it. Confirmed on the live deployment:
 * `-rw-r--r-- data/matrix/bridge-state.json`.
 *
 * AN OMISSION RATHER THAN A DECISION, and the neighbouring code is the evidence: the crypto
 * store directory beside it is explicitly `chmod 0700`, `.env` is `0600`, and the backend's JSON
 * writer opens its temp file `0600`. This was the one credential-bearing path left on the
 * platform default.
 *
 * Tested against the real fs rather than through the bridge, which cannot be imported without a
 * homeserver: the behaviour being pinned is a property of the two-step write, and the second
 * step is the one that is easy to drop.
 */

import { afterEach, describe, expect, test } from 'vitest';
import {
  chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const roots = [];
const tempRoot = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'bridge-state-'));
  roots.push(d);
  return d;
};
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

const mode = (file) => statSync(file).mode & 0o777;

/**
 * The exact two steps `saveState` performs.
 *
 * Mirrored rather than imported because `bridge-matrix.js` connects to a homeserver at module
 * evaluation. Kept to two lines so the mirror cannot drift far, and the second test below is
 * what makes the second line non-optional.
 */
function saveStateLike(dir, state) {
  const statePath = path.join(dir, 'bridge-state.json');
  writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  try { chmodSync(statePath, 0o600); } catch { /* reported by the caller in production */ }
  return statePath;
}

describe('the bridge state file is owner-only', () => {
  test('a newly created state file is 0600, not 0644', () => {
    const dir = tempRoot();
    const file = saveStateLike(dir, { botToken: 'syt_secret', agentTokens: { a1: 'syt_a1' } });
    expect(mode(file)).toBe(0o600);
    // Group and other have nothing at all, not merely no write.
    expect(mode(file) & 0o077).toBe(0);
  });

  test('an EXISTING 0644 file is tightened, which the mode option alone cannot do', () => {
    /*
     * The reason `saveState` chmods as well as passing `mode`. `mode` applies only when the file
     * is CREATED, so every deployment that already has a 0644 state file — which is every
     * deployment that has ever run the previous code — would keep it forever without the chmod.
     * Measured: with the mode option alone the file stays 0644.
     */
    const dir = tempRoot();
    const file = path.join(dir, 'bridge-state.json');
    writeFileSync(file, '{}');
    chmodSync(file, 0o644);
    expect(mode(file)).toBe(0o644);

    saveStateLike(dir, { botToken: 'syt_secret', agentTokens: {} });
    expect(mode(file)).toBe(0o600);
  });

  test('tightening the mode does not disturb the contents', () => {
    // A permission fix that corrupted the tokens would be worse than the permissions.
    const dir = tempRoot();
    const state = { botToken: 'syt_bot', agentTokens: { a1: 'syt_a1', a2: 'syt_a2' } };
    const file = saveStateLike(dir, state);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(state);
  });

  test('the file the bridge actually writes on this host is not world-readable', () => {
    /*
     * The deployment check, skipped rather than failed when there is no live state file — a CI
     * box has none, and asserting an environment would make this red for the wrong reason.
     * On a host that HAS one, this is the assertion that would have caught the original defect.
     */
    const live = path.join(process.env.HOME ?? '', 'home/hagency/data/matrix/bridge-state.json');
    if (!existsSync(live)) return;
    expect(mode(live) & 0o077, `${live} is readable beyond its owner`).toBe(0);
  });
});
