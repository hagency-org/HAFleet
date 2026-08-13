/*
 * A borrower waiting on an agent can tell "working" from "never heard you".
 *
 * THE COMPLAINT, verbatim: a request was sent from a Matrix client, nothing appeared, and the
 * finished work arrived much later with no sign of life in between. For the session that
 * produced this code that was 203 tool calls of silence.
 *
 * It was architectural, not a bug in any handler. Delivery is message-based: the bridge wakes
 * the agent, the agent works, and the agent posts ONCE when it has finished a turn by calling
 * POST /api/messages itself. Nothing observed it in between, and grepping the bridge for
 * `m.typing`, `receipt` and `m.reaction` returned nothing at all — so silence was the only
 * state the room could be in, whether the agent was working, dead, or never reached.
 *
 * TWO SIGNALS, AND WHAT WAS DELIBERATELY NOT BUILT. HAFleet can read the agent's pane
 * (GET /api/agents/:name/pane) and relaying it would be the wrong thing to send: ANSI and tool
 * output, a message per second against rate limits this bridge already backs off from, and the
 * pane is the agent's whole screen — another project's content, a token in argv. Streaming it
 * into a project room is a disclosure decision, not a feature.
 *
 * So the signals carry no work product: an ephemeral typing notification, and one reaction on
 * the human's own message. This file pins the properties that make them honest rather than
 * decorative.
 */

import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';

const SOURCE = readFileSync(new URL('../bridge-matrix.js', import.meta.url), 'utf8');

/** The body of a method, so an assertion is about that method and not the whole file. */
function methodBody(name) {
  const start = SOURCE.indexOf(`\n  ${name}(`) >= 0
    ? SOURCE.indexOf(`\n  ${name}(`)
    : SOURCE.indexOf(`\n  async ${name}(`);
  expect(start, `method ${name} not found`).toBeGreaterThan(-1);
  // Up to the next method at the same indentation.
  const rest = SOURCE.slice(start + 3);
  const end = rest.search(/\n {2}(async )?[a-zA-Z_$][\w$]*\(/);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('the signals exist at all', () => {
  test('typing is sent as m.typing, which is ephemeral', () => {
    /*
     * The choice that keeps this from filling a room: `m.typing` is not a room event, so it
     * adds nothing to history and spends no rate-limit budget against message sends. A
     * progress MESSAGE per turn would have done both.
     */
    const body = methodBody('setAgentTyping');
    expect(body).toMatch(/\/typing\//);
    expect(body).toMatch(/typing: true/);
    expect(body).toMatch(/typing: false/);
  });

  test('the acknowledgement is a single reaction, not a message', () => {
    const body = methodBody('ackAgentReceipt');
    expect(body).toMatch(/m\.reaction/);
    expect(body).toMatch(/m\.annotation/);
    // No message body: an ack that posted text would be a second message in the transcript
    // for every request, which is what a borrower is already complaining about the volume of.
    expect(body).not.toMatch(/msgtype/);
  });

  test('both act as the AGENT, not as the bot', () => {
    /*
     * The borrower is waiting on the agent, so the agent must be the one who appears busy and
     * the one who acknowledges. A bot typing on its behalf is a different claim — and the bot
     * is not the party to the engagement.
     */
    for (const name of ['setAgentTyping', 'ackAgentReceipt']) {
      const body = methodBody(name);
      expect(body, name).toMatch(/ensureAgentAccount/);
      expect(body, name).not.toMatch(/botClient/);
    }
  });
});

describe('what keeps them from lying', () => {
  test('typing carries a timeout, so a crash cannot leave an agent typing forever', () => {
    /*
     * Without one, a killed agent leaves a permanent "typing…" — a claim the room cannot
     * check and the operator cannot clear. With one, the homeserver expires it and the
     * failure mode is silence, which is honest.
     */
    const body = methodBody('setAgentTyping');
    expect(body).toMatch(/timeout: AGENT_TYPING_TIMEOUT_MS/);
  });

  test('the refresh loop STOPS after a cap rather than typing indefinitely', () => {
    /*
     * The substance of the design. `m.typing` expires, so a long turn has to be refreshed —
     * and a refresh loop with no end would reintroduce the permanent lie through the back
     * door. Past the cap the notification is allowed to lapse, because an agent silent that
     * long may be stuck and continuing to claim it is working would be unfounded.
     */
    const body = methodBody('ensureTypingRefresh');
    expect(body).toMatch(/AGENT_TYPING_MAX_MS/);
    expect(body).toMatch(/setAgentTyping\([^)]*false\)/);
    // And the interval clears itself when nothing is outstanding.
    expect(body).toMatch(/clearInterval/);
  });

  test('the cap is SHORT, because the stop hook only fires when the agent replies', () => {
    /*
     * The bug an operator reported: BigLittle showed "typing" continuously in their client. The
     * existing cap test asserted only that a cap EXISTS, which it did — at twenty minutes. An agent
     * that is working for a long time, or stuck, never reaches the stop hook, so the indicator was
     * refreshed for the whole cap and read as permanent.
     *
     * The number is the assertion because the number was the defect. A typing indicator is honest
     * for a short window; past that it conveys nothing and the 👀 reaction is already the durable
     * record that the message was received.
     */
    const cap = Number(/AGENT_TYPING_MAX_MS = ([\d_ *]+)/.exec(SOURCE)[1]
      .replace(/_/g, '').split('*').reduce((a, b) => Number(a) * Number(b)));
    expect(cap).toBeLessThanOrEqual(5 * 60_000);
    // And not so short that a normal turn never shows one at all.
    expect(cap).toBeGreaterThanOrEqual(60_000);
  });

  test('the wait ends at the CHOKE POINT, not only at three call sites', () => {
    /*
     * Every outbound agent message — text, attachments, threaded replies — converges on
     * `sendAsAgentContent`. Hooking its callers instead left any path that did not go through them
     * refreshing the indicator until the cap, which is the other half of the same report.
     */
    const body = methodBody('sendAsAgentContent');
    expect(body).toMatch(/endAgentWorkForToken/);
    // Resolved from the token rather than by clearing the whole room: two agents can share a room,
    // and one replying says nothing about whether the other is still working.
    const resolver = methodBody('endAgentWorkForToken');
    expect(resolver).toMatch(/agentTokens/);
    expect(resolver).toMatch(/return;/);
  });

  test('the refresh interval is shorter than the timeout it refreshes', () => {
    // Otherwise the indicator flickers off between refreshes, which reads as the agent
    // stopping and restarting.
    const timeout = Number(/AGENT_TYPING_TIMEOUT_MS = ([\d_]+)/.exec(SOURCE)[1].replace(/_/g, ''));
    const refresh = Number(/AGENT_TYPING_REFRESH_MS = ([\d_]+)/.exec(SOURCE)[1].replace(/_/g, ''));
    expect(refresh).toBeLessThan(timeout);
  });

  test('the refresh timer is unref\'d, so it cannot hold the process open', () => {
    expect(methodBody('ensureTypingRefresh')).toMatch(/unref/);
  });

  test('a failed signal can never fail a delivered message', () => {
    /*
     * The ordering that matters: the message was already accepted by the backend when these
     * run. If a typing notification could reject into the delivery path, a cosmetic signal
     * would turn a delivered message into a reported failure — strictly worse than no signal.
     */
    const body = methodBody('beginAgentWork');
    expect(body).toMatch(/ackAgentReceipt\([^)]*\)\.catch/);
    expect(body).toMatch(/setAgentTyping\([^)]*\)\.catch/);
    // And a missing credential is swallowed here rather than raised as a second alarm: the
    // unprovisioned state is already reported through the health record (ADR-014 decision 6).
    expect(methodBody('setAgentTyping')).toMatch(/catch\s*{/);
  });

  test('a repeated handoff cannot double-react', () => {
    // The transaction id is derived from the event id, so the retry path in
    // submitHumanMessage cannot produce two 👀 on one message.
    expect(methodBody('ackAgentReceipt')).toMatch(/createHash[\s\S]*eventId/);
  });
});

describe('the signals are tied to acceptance and to the reply', () => {
  test('work begins only AFTER the backend accepted the message', () => {
    /*
     * An acknowledgement on a message that was never delivered is worse than none — an
     * operator hit exactly that failure as an HTTP 503 from the wake queue, and a 👀 on it
     * would have said the opposite of the truth. Both call sites therefore sit after the
     * `result?.id` check.
     */
    // `this.` so the method DEFINITION is not counted as a call site — the first version of
    // this test matched it and failed on the file's own prologue, which is the right kind of
    // failure to get from a test that is checking placement.
    const sites = [...SOURCE.matchAll(/this\.beginAgentWork\(/g)];
    expect(sites.length).toBeGreaterThanOrEqual(2); // the DM route and the group route
    for (const site of sites) {
      const before = SOURCE.slice(Math.max(0, site.index - 700), site.index);
      expect(before).toMatch(/backend Matrix acceptance did not return a message id/);
    }
  });

  test('the agent speaking ends the wait, in every outbound path', () => {
    /*
     * Not left to the refresh cap: the reply IS the end of the wait, and waiting up to the cap
     * to clear it would show an agent as still working after its answer had arrived. All three
     * outbound sends — group, DM into the reply room, DM into the resolved room — clear it.
     */
    const stops = [...SOURCE.matchAll(/this\.endAgentWork\(/g)];
    // Group, DM into the reply room, DM into the resolved room.
    expect(stops.length).toBeGreaterThanOrEqual(3);
  });

  test('ending work is idempotent and silent when nothing was outstanding', () => {
    // Every outbound message calls it, including replies to something that was never a
    // request, so the no-op path has to be free of side effects.
    const body = methodBody('endAgentWork');
    expect(body).toMatch(/if \(!this\.agentWork\?\.has\(key\)\) return;/);
  });
});
