// tmux implementation of the agent runtime contract (see ./index.js).
//
// Behaviour here is a faithful extraction of what backend-v2.js did inline,
// including timeouts and error classification, so migrating call sites is not
// supposed to change anything observable. Deliberate differences:
//
//   - capturePane returns raw text. The caller hashes it; a runtime has no
//     business knowing why the text is wanted.
//   - listPanes returns raw paths. Normalising them is the caller's policy.
//
// Note: lib/push-relay-core.js has its own older tmux helpers, including binary
// discovery across several candidate paths. They are NOT consolidated here yet
// because that file is mirrored byte-for-byte into remote/lib/ by
// scripts/build-remote-package.sh, so moving it needs the remote manifest
// updated in the same change.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { RUNTIME_CAPABILITIES, emptyPaneListing } from './index.js';

const execFileAsyncDefault = promisify(execFile);

const PANE_FORMAT = [
  '#{pane_tty}',
  '#{session_name}',
  '#{pane_pid}',
  '#{pane_current_command}',
  '#{pane_current_path}',
].join('\t');

/** Timeouts preserved from the original inline call sites. */
const TIMEOUT_MS = Object.freeze({
  listPanes: 3000,
  capturePane: 3000,
  sessionExists: 2000,
  sendKeys: 3000,
  version: 3000,
});

/**
 * "No tmux server is running" is an ordinary idle state, not a failure: it just
 * means no agents are up. Treating it as an error produced spurious alerts.
 * Extracted verbatim from backend-v2.js isTmuxEmptyServerError.
 */
export function isTmuxEmptyServerError(error) {
  if (Number(error?.code) !== 1) return false;
  const detail = `${error?.stderr ?? ''}\n${error instanceof Error ? error.message : String(error)}`;
  return /no server running on\b/i.test(detail)
    || /error connecting to .+\(No such file or directory\)/i.test(detail)
    || /^no sessions(?:\s|$)/im.test(detail);
}

/**
 * @param {object} [options]
 * @param {Function} [options.exec] promisified execFile-compatible runner.
 *   Injectable so tests can drive the runtime without a live tmux server —
 *   this is the seam backend-v2.js already relied on.
 * @param {string} [options.bin] tmux binary. Defaults to 'tmux' on PATH, which
 *   is what the inline calls used.
 */
export function createTmuxRuntime({ exec = execFileAsyncDefault, bin = 'tmux' } = {}) {
  const run = (args, options = {}) => exec(bin, args, options);

  return Object.freeze({
    name: 'tmux',

    capabilities: Object.freeze({
      ...RUNTIME_CAPABILITIES,
      keys: true,      // an interactive prompt exists to type into
      capture: true,   // pane contents are readable
      sessions: true,  // named sessions are enumerable
    }),

    isEmptyServerError: isTmuxEmptyServerError,

    async isAvailable() {
      try {
        await run(['-V'], { timeout: TIMEOUT_MS.version, encoding: 'utf-8' });
        return true;
      } catch {
        return false;
      }
    },

    async sessionExists(sessionName) {
      const session = String(sessionName || '').trim();
      if (!session) return false;
      try {
        await run(['has-session', '-t', session], { timeout: TIMEOUT_MS.sessionExists });
        return true;
      } catch {
        return false;
      }
    },

    /**
     * One tmux call for every pane on the host. Cheaper than per-agent queries
     * and the reason the backend takes a whole-host snapshot per sweep.
     */
    async listPanes() {
      let stdout;
      try {
        ({ stdout } = await run(
          ['list-panes', '-a', '-F', PANE_FORMAT],
          { encoding: 'utf-8', timeout: TIMEOUT_MS.listPanes },
        ));
      } catch (error) {
        // No server running is reported ok-with-no-panes, not failed, so callers
        // do not treat "nothing running" as a fault — but it is flagged, because
        // "could not reach tmux" and "tmux has no panes" must not be confused.
        if (isTmuxEmptyServerError(error)) return emptyPaneListing(null, { serverUnavailable: true });
        return emptyPaneListing(error);
      }

      const raw = String(stdout || '').trim();
      if (!raw) {
        // A reachable tmux that lists nothing is normal on an idle host, but it is
        // also what a caller sees when something upstream swallowed the output —
        // so say which, once, rather than leaving an empty snapshot unexplained.
        if (process.env.AGENT_CHAT_RUNTIME_TRACE === '1') {
          console.warn('[runtime:tmux] list-panes returned empty stdout');
        }
        return emptyPaneListing(null);
      }

      const panes = [];
      for (const line of raw.split('\n')) {
        const parts = line.split('\t');
        if (parts.length < 5) continue;
        const tty = parts[0].trim();
        const session = parts[1].trim();
        if (!tty || !session) continue;
        panes.push({
          // tmux reports /dev/ttys004; callers key on the bare name.
          tty: tty.replace('/dev/', ''),
          session,
          pid: Number.parseInt(parts[2].trim(), 10),
          command: parts[3].trim(),
          // Paths may contain tabs, so re-join the remainder. Raw, unnormalised.
          path: parts.slice(4).join('\t').trim(),
        });
      }
      if (!panes.length && process.env.AGENT_CHAT_RUNTIME_TRACE === '1') {
        console.warn(`[runtime:tmux] list-panes produced ${raw.split('\n').length} line(s) `
          + `but 0 parsed panes; first line: ${JSON.stringify(raw.split('\n')[0].slice(0, 120))}`);
      }
      return { ok: true, panes, error: null, serverUnavailable: false };
    },

    async capturePane(target) {
      const pane = String(target || '').trim();
      if (!pane) return null;
      try {
        const { stdout } = await run(
          ['capture-pane', '-p', '-t', pane],
          { timeout: TIMEOUT_MS.capturePane, encoding: 'utf-8' },
        );
        return stdout;
      } catch {
        return null;
      }
    },

    /**
     * @param {string} target pane target
     * @param {string[]} keys key names (e.g. 'C-c', 'Enter') or, with
     *   `literal: true`, text to type verbatim
     * @param {object} [options]
     * @param {boolean} [options.literal] pass -l so tmux types instead of
     *   interpreting key names
     * @param {number} [options.timeoutMs] override the default; some callers
     *   (the auto-clear sequence) allow longer than a plain keypress
     */
    async sendKeys(target, keys, { literal = false, timeoutMs = TIMEOUT_MS.sendKeys } = {}) {
      const pane = String(target || '').trim();
      const list = (Array.isArray(keys) ? keys : [keys]).filter((k) => k !== undefined && k !== null);
      if (!pane || list.length === 0) return false;
      const args = literal
        ? ['send-keys', '-l', '-t', pane, ...list.map(String)]
        : ['send-keys', '-t', pane, ...list.map(String)];
      // Deliberately propagates: callers that need to distinguish "pane gone"
      // from "delivered" catch it themselves. Returning false on every failure
      // would hide the difference.
      await run(args, { timeout: timeoutMs });
      return true;
    },
  });
}
