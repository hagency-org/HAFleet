import { describe, it, expect } from 'vitest';
import { detectPaneBusyState } from '../lib/pane-activity.js';

/*
 * Thirty lines that decide whether an agent is working. It had no test file, and it is
 * consumed in three places that each turn the answer into a product decision:
 *
 *   server.js:3097 + 3177    `busy` forces idleMs to 0 and the pane to `active`. The
 *                            message queue is idle-gated, so an agent that reads as
 *                            permanently busy is an agent that never receives its
 *                            messages, and one that reads as idle while working gets
 *                            interrupted mid-task.
 *   lib/push-relay-core.js:293 + 341  `busy` extends the activity burst and sets
 *                            activeNow / activeDurationSec / idleDurationSec.
 *   backend-v2.js:11194      those durations are the `busyTime` signal /api/usage
 *                            declares as MEASURED. A false positive inflates the only
 *                            consumption figure a contributor can actually check.
 *
 * The input is raw `tmux capture-pane -p` output: ANSI-coloured, scrollback-length, and
 * containing whatever the agent chose to print. So the two failure directions are
 * symmetrical and both are covered below — missing a real busy marker because of colour
 * codes, and matching the ordinary English word "Working" in an agent's own prose.
 */

const busy = (text) => detectPaneBusyState(text);
const IDLE = { busy: false, reason: null };

// A realistic frame: a header, some output, and the client's status line.
const frame = (statusLine, filler = 4) => [
  '$ hafleet up alpha',
  ...Array.from({ length: filler }, (_, i) => `  reading src/file${i}.js`),
  statusLine,
].join('\n');

describe('detectPaneBusyState', () => {
  it('reports idle for an empty pane, and says so with a null reason', () => {
    /*
     * A pane with nothing in it is a client that has not printed a status line — idle,
     * not unknown. The reason field must be null rather than absent: server.js:3186
     * stores `busy === true` and the reason travels into the observation record, so an
     * undefined there is indistinguishable from a busy state whose reason was dropped.
     */
    for (const value of ['', '   ', '\n\n\n', null, undefined, 0, false]) {
      expect(busy(value), JSON.stringify(value)).toEqual(IDLE);
    }
  });

  it('answers rather than throwing when handed a non-string', () => {
    /*
     * `String(text || '')`. Both call sites currently pass a string, but they get there
     * by their own coercion of a child-process result — server.js:3094 and
     * lib/push-relay-core.js:290 each write `String(stdout || '')` because `stdout` can
     * be a Buffer when the encoding option is dropped. If either coercion is ever
     * removed, a Buffer or an execFile result object arrives here, and the difference
     * between this function coercing and not is the difference between "idle" and a
     * TypeError thrown out of the pane sweep — which is caught and reported as
     * capture-failed, so every agent on the host silently stops being observed at all.
     *
     * The falsy cases above cannot show this: they short-circuit to '' either way. Only
     * a TRUTHY non-string reaches the coercion.
     */
    for (const value of [42, {}, ['line'], Buffer.from('some pane output'), () => {}]) {
      expect(busy(value), String(value)).toEqual(IDLE);
    }
    // And a Buffer carrying a real status line is still read correctly, so the coercion
    // is a coercion and not a swallow.
    expect(busy(Buffer.from('• Working (2s · esc to interrupt)')).reason).toBe('codex-working');
  });

  it('reports idle for ordinary agent output', () => {
    // The baseline. Most captures are a finished command and a prompt, and every one of
    // them must be idle or an agent never receives another message.
    expect(busy(frame('alpha@host ~/proj $ '))).toEqual(IDLE);
    expect(busy('✓ 42 tests passed\n\n$ ')).toEqual(IDLE);
  });

  it('recognises the codex bullet status line as codex-working', () => {
    // The two reasons are separate so an operator reading a stuck pane knows which
    // client is holding it. The bullet form is what codex prints.
    expect(busy(frame('• Working (12s · esc to interrupt)')))
      .toEqual({ busy: true, reason: 'codex-working' });
    expect(busy(frame('  ● Working on the parser — esc to interrupt')))
      .toEqual({ busy: true, reason: 'codex-working' });
  });

  it('recognises a generic client status line, verb first or verb last', () => {
    /*
     * Two orders because the clients disagree about layout: some print
     * "Thinking… (esc to interrupt)" and some print "(esc to interrupt) Running tool".
     * Supporting only one order means half the fleet reads as idle while it works, and
     * gets interrupted by a queued message on its next poll.
     */
    for (const verb of ['Working', 'Running', 'Thinking', 'Processing']) {
      expect(busy(frame(`${verb}… (esc to interrupt)`)), verb)
        .toEqual({ busy: true, reason: 'interactive-client-working' });
      expect(busy(frame(`(esc to interrupt) ${verb} tool call`)), `${verb} reversed`)
        .toEqual({ busy: true, reason: 'interactive-client-working' });
    }
  });

  it('is case-insensitive, because status lines are not styled consistently', () => {
    expect(busy(frame('WORKING (ESC TO INTERRUPT)')).busy).toBe(true);
    expect(busy(frame('• working … esc to interrupt')).reason).toBe('codex-working');
  });

  it('prefers the codex reason when a line could match either pattern', () => {
    /*
     * The bullet line satisfies the generic pattern too — `\bWorking\b … \besc to
     * interrupt\b` matches it exactly as well. The bullet check is first, and that
     * ordering is the only thing producing the more specific answer. Reorder the two
     * blocks and every codex pane starts reporting as a generic client, which is the
     * attribution an operator uses to decide which process to look at.
     */
    const line = '• Working (5s · esc to interrupt)';
    expect(busy(frame(line)).reason).toBe('codex-working');
    // The same words WITHOUT the bullet fall through to the generic reason, so the
    // distinction really is the bullet and not something incidental to the fixture.
    expect(busy(frame('Working (5s · esc to interrupt)')).reason).toBe('interactive-client-working');
  });

  it('requires the bullet at the START of a line for the codex reason', () => {
    // `(?:^|\n)\s*[•●]`. A bullet in the middle of a sentence is prose, not a status
    // line. It still matches the generic pattern, so this asserts the REASON changes
    // rather than that the pane goes idle — a weaker claim would hide the difference.
    expect(busy(frame('log: item • Working — esc to interrupt')).reason)
      .toBe('interactive-client-working');
  });

  // ── the false-positive guards ───────────────────────────────────────
  it('does NOT call a pane busy for the word Working alone', () => {
    /*
     * THE MOST IMPORTANT CASE HERE. "Working", "Running", "Thinking" and "Processing"
     * are ordinary English that agents print constantly — in plans, in commit messages,
     * in test names, in file paths. The `esc to interrupt` requirement is what separates
     * a live interactive status line from prose.
     *
     * Without it, one line of an agent's own output pins it busy for as long as that
     * line stays in the pane: idleMs is forced to 0, the pane never reports idle, and
     * the message queue never delivers to that agent again. It is a silent
     * communication blackout that looks like a healthy, permanently active agent.
     */
    expect(busy(frame('Working on the parser now'))).toEqual(IDLE);
    expect(busy(frame('• Working through the backlog'))).toEqual(IDLE);
    expect(busy(frame('Thinking about the schema. Running the suite. Processing done.'))).toEqual(IDLE);
    expect(busy(frame('  modified: docs/working-notes.md'))).toEqual(IDLE);
  });

  it('does NOT call a pane busy for the interrupt hint alone', () => {
    // A help footer or a man page excerpt mentioning the key binding is not a running
    // task. Both patterns need a verb as well as the hint.
    expect(busy(frame('Keybindings: esc to interrupt, ctrl-c to quit'))).toEqual(IDLE);
    expect(busy(frame('press esc to interrupt'))).toEqual(IDLE);
  });

  it('will not match a verb inside a longer word', () => {
    // `\b(?:Working|…)\b`. "Reworking" and "Networking" are not status verbs, and a
    // pane discussing them next to a keybinding hint must stay idle.
    expect(busy(frame('Reworking the plan — see esc to interrupt in the docs'))).toEqual(IDLE);
    expect(busy(frame('Networking failed; esc to interrupt is listed above'))).toEqual(IDLE);
  });

  it('requires the verb and the hint on the SAME line', () => {
    /*
     * `[^\n]*` between them, not `[\s\S]*`. An agent that printed "Working on it" and,
     * further down, a footer containing the keybinding would otherwise be read as busy
     * for as long as both lines share the window — which is the common shape of a client
     * that has FINISHED and is showing its idle help text.
     */
    expect(busy('Working on it\nsome output\npress esc to interrupt to cancel')).toEqual(IDLE);
    expect(busy('• Working\nesc to interrupt')).toEqual(IDLE);
    // Same words, one line: busy. So the split is what makes the difference.
    expect(busy('• Working — esc to interrupt').busy).toBe(true);
  });

  // ── ANSI ────────────────────────────────────────────────────────────
  it('strips ANSI so a COLOURED status line is still recognised', () => {
    /*
     * `tmux capture-pane -p` returns the escape sequences, and every interactive client
     * colours its spinner. Two places the codes land and each one defeats a different
     * part of the match:
     *   - before the bullet, where `\s*[•●]` needs the glyph at the line start;
     *   - inside the phrase, where `\besc to interrupt\b` needs the words adjacent.
     * Without the strip, a coloured pane reads as idle — every real agent's pane — and
     * a working agent gets interrupted by a queued message.
     */
    expect(busy(frame('\x1b[32m● \x1b[1mWorking\x1b[0m (8s · esc to interrupt)')).reason)
      .toBe('codex-working');
    expect(busy(frame('● Working (8s · \x1b[2mesc\x1b[0m to \x1b[2minterrupt\x1b[0m)')).reason)
      .toBe('codex-working');
    // A cursor-position sequence, which is what a spinner actually emits between frames.
    expect(busy(frame('\x1b[2K\x1b[1G● Working — esc to interrupt')).reason).toBe('codex-working');
  });

  it('does not let stripped ANSI fuse two lines into one match', () => {
    // The strip must not remove the newlines along with the codes, or the same-line
    // requirement above is defeated by any coloured pane.
    expect(busy('\x1b[32mWorking\x1b[0m\n\x1b[2mpress esc to interrupt\x1b[0m')).toEqual(IDLE);
  });

  // ── the recency window ──────────────────────────────────────────────
  it('ignores a status line that has scrolled out of the last 14 content lines', () => {
    /*
     * `slice(-14)`. The pane holds scrollback, so a status line from a task that
     * finished minutes ago is still in the capture. If the whole buffer were searched,
     * the FIRST busy marker an agent ever printed would keep it busy for the rest of the
     * pane's life — the blackout described above, with no way to clear it short of
     * clearing the pane.
     *
     * The marker is deliberately the FIRST line and is followed by exactly enough
     * content to push it out, so dropping the window changes the verdict rather than
     * merely widening the search.
     */
    const scrolledOff = [
      '• Working (2s · esc to interrupt)',
      ...Array.from({ length: 14 }, (_, i) => `finished step ${i}`),
    ].join('\n');
    expect(busy(scrolledOff)).toEqual(IDLE);

    // One line fewer of trailing output and the marker is still inside the window, so
    // the boundary is at 14 and not somewhere else.
    const stillVisible = [
      '• Working (2s · esc to interrupt)',
      ...Array.from({ length: 13 }, (_, i) => `finished step ${i}`),
    ].join('\n');
    expect(busy(stillVisible).reason).toBe('codex-working');
  });

  it('does not let blank lines consume the recency window', () => {
    /*
     * Blank lines are filtered out BEFORE the slice. Interactive clients pad their
     * output generously — a spinner frame surrounded by blank lines is normal — so if
     * whitespace counted toward the 14, a genuinely current status line would be pushed
     * out by the client's own padding and a working agent would read as idle.
     */
    const padded = [
      '• Working (2s · esc to interrupt)',
      ...Array.from({ length: 60 }, () => ''),
      ...Array.from({ length: 60 }, () => '   '),
    ].join('\n');
    expect(busy(padded).reason).toBe('codex-working');
  });

  it('reads a status line at the very end of the pane', () => {
    // The normal case, and the one every other test's fixture depends on: a live status
    // line is the LAST thing in the capture.
    const long = [
      ...Array.from({ length: 200 }, (_, i) => `line ${i}`),
      '• Working (3s · esc to interrupt)',
    ].join('\n');
    expect(busy(long).reason).toBe('codex-working');
  });

  it('handles CRLF panes', () => {
    // `split(/\r?\n/)`. A pane from a Windows-side tmux or an SSH session with CRLF must
    // not have every line end in a stray \r, which would break `\besc to interrupt\b`
    // when the phrase ends the line.
    expect(busy('$ run\r\n• Working (1s · esc to interrupt)\r\n').reason).toBe('codex-working');
    expect(busy(['Working on it\r', 'press esc to interrupt\r'].join('\n'))).toEqual(IDLE);
  });
});
