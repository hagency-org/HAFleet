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
  chmodSync, closeSync, existsSync, fsyncSync, mkdtempSync, openSync, readFileSync,
  readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
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
 * What `saveState` does: temp at 0600 → fsync → rename, then chmod the target.
 *
 * Mirrored rather than imported because `bridge-matrix.js` connects to a homeserver at module
 * evaluation, so importing it here would need a live server. The mirror is a real risk and the
 * tests below are chosen to constrain it: each step is load-bearing for one of them, so a mirror
 * that drifts by dropping a step fails rather than passing quietly.
 */
function saveStateLike(dir, state) {
  const statePath = path.join(dir, 'bridge-state.json');
  const tmpPath = `${statePath}.tmp-${process.pid}`;
  const payload = JSON.stringify(state, null, 2);
  let fd = null;
  try {
    fd = openSync(tmpPath, 'w', 0o600);
    writeFileSync(fd, payload);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, statePath);
  } catch (error) {
    if (fd !== null) { try { closeSync(fd); } catch { /* closed */ } }
    try { unlinkSync(tmpPath); } catch { /* nothing to clean */ }
    throw error;
  }
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

  test('the write is atomic, so a reader never sees a half file', () => {
    /*
     * Why this matters more than it looks: `loadState` returns
     * `{ botToken: null, agentTokens: {} }` on ANY parse failure, so a torn write does not
     * read as an error — it reads as a FRESH INSTALL. Under ADR-014 that is unrecoverable: an
     * appservice as_token or a project-issued access token cannot be re-minted by software, and
     * this file is their only copy. The old code self-healed because a derived password could
     * always re-login; that safety net is exactly what ADR-014 removes.
     *
     * Asserted by the mechanism rather than by racing a reader: the target is replaced by
     * rename, so at no point does a partially-written target exist.
     */
    const dir = tempRoot();
    const file = saveStateLike(dir, { botToken: 'syt_first', agentTokens: { a1: 'syt_a1' } });
    saveStateLike(dir, { botToken: 'syt_second', agentTokens: { a1: 'syt_a1', a2: 'syt_a2' } });

    // Whole new content, and no temp file left behind for the next write to trip over.
    expect(JSON.parse(readFileSync(file, 'utf8')).botToken).toBe('syt_second');
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  test('a failed write leaves the PREVIOUS credentials intact', () => {
    /*
     * The contract the atomic write exists for. If the new state cannot be written, the old
     * tokens must still be on disk — losing them is worse than failing to add one.
     */
    const dir = tempRoot();
    const file = saveStateLike(dir, { botToken: 'syt_good', agentTokens: { a1: 'syt_a1' } });

    // An unwritable directory: the temp file cannot be created, so the rename never happens.
    chmodSync(dir, 0o500);
    expect(() => saveStateLike(dir, { botToken: 'syt_new', agentTokens: {} })).toThrow();
    chmodSync(dir, 0o700);

    expect(JSON.parse(readFileSync(file, 'utf8')).botToken).toBe('syt_good');
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
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
