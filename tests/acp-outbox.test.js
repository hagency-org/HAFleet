import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';

import { OUTBOX_ACTIONS, OUTBOX_PROTOCOL, validateOutboxRequest } from '../lib/acp-outbox.js';

// A tmux agent calls HAFleet's MCP tools directly. octos 2.0.2 has no route to
// them at all — it accepts mcpServers on session/new and ignores it, its config
// has no MCP section, `octos mcp` is OAuth-only for remote servers, and its shell
// is network-isolated (its own `nc -z 127.0.0.1 8090` returns PORT_CLOSED while
// the backend is listening). Writing files in its workspace is the only capability
// left, so that is the channel.

describe('outbox requests', () => {
  test('a minimal send_message is accepted', () => {
    expect(validateOutboxRequest({ to: 'alpha', summary: 'hi' })).toBeNull();
  });

  test('action defaults to send_message', () => {
    // The agent is told the protocol in a prompt, so the common case should not
    // require it to remember a field.
    expect(validateOutboxRequest({ to: 'alpha', full: 'body' })).toBeNull();
  });

  test('a post needs a group and a send needs a recipient', () => {
    expect(validateOutboxRequest({ action: 'post', group: 'dev', summary: 'x' })).toBeNull();
    expect(validateOutboxRequest({ action: 'post', summary: 'x' })).toMatch(/requires "group"/);
    expect(validateOutboxRequest({ action: 'send_message', summary: 'x' })).toMatch(/requires "to"/);
  });

  test('either summary or full satisfies the body', () => {
    expect(validateOutboxRequest({ to: 'a', summary: 'only summary' })).toBeNull();
    expect(validateOutboxRequest({ to: 'a', full: 'only full' })).toBeNull();
    expect(validateOutboxRequest({ to: 'a' })).toMatch(/requires "summary" or "full"/);
  });

  test('whitespace-only fields do not count as present', () => {
    // Otherwise an agent emits an empty message and nothing explains why it was
    // useless at the other end.
    expect(validateOutboxRequest({ to: '   ', summary: 'x' })).toMatch(/requires "to"/);
    expect(validateOutboxRequest({ to: 'a', summary: '  \n ' })).toMatch(/requires "summary" or "full"/);
  });

  test.each([
    ['accept_task'], ['complete_task'], ['approve'], ['shell'], ['delete_agent'],
  ])('%s is refused — the surface is messaging only', (action) => {
    // Writing to a directory is not authentication: the host trusts the file
    // because it trusts the workspace. Anything that mutates task state or
    // answers an approval must wait until an ACP agent can prove who it is.
    const problem = validateOutboxRequest({ action, to: 'a', summary: 'x' });
    expect(problem).toMatch(/unsupported action/);
    expect(problem).toContain('send_message, post');
  });

  test.each([null, undefined, 'a string', 42, ['an', 'array']])('%s is refused', (value) => {
    expect(validateOutboxRequest(value)).toBe('not a JSON object');
  });

  test('the allowed set stays two verbs', () => {
    // A guard on scope: widening this is a security decision, not a tidy-up.
    expect([...OUTBOX_ACTIONS]).toEqual(['send_message', 'post']);
  });
});

describe('the protocol told to the agent matches what is accepted', () => {
  test('every action named in the instructions is actually allowed', () => {
    for (const action of OUTBOX_ACTIONS) {
      expect(OUTBOX_PROTOCOL, `protocol never mentions ${action}`).toContain(action);
    }
  });

  test('the instructions name the directory the host actually watches', () => {
    const host = readFileSync('scripts/hafleet-acp-agent.mjs', 'utf-8');
    expect(OUTBOX_PROTOCOL).toContain('.hafleet/outbox/');
    expect(host).toMatch(/'\.hafleet', 'outbox'/);
  });

  test('the example JSON in the instructions actually validates', () => {
    // An example the agent copies verbatim must not be rejected. This has to
    // parse the real string rather than a copy of it.
    const examples = OUTBOX_PROTOCOL.split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('{'));
    expect(examples.length).toBeGreaterThanOrEqual(2);
    for (const example of examples) {
      const parsed = JSON.parse(example.replace(/<[^>]+>/g, 'placeholder'));
      expect(validateOutboxRequest(parsed), `example rejected: ${example}`).toBeNull();
    }
  });

  test('the instructions tell the agent where a rejection goes', () => {
    // Otherwise a malformed file disappears and the agent retries the same
    // mistake forever with no feedback.
    expect(OUTBOX_PROTOCOL).toContain('rejected/');
    expect(OUTBOX_PROTOCOL).toContain('.error');
  });
});

describe('the host drains the outbox promptly', () => {
  test('it drains after a turn, not only before the next poll', () => {
    // The agent writes its file mid-turn then immediately checks for it. On mini5
    // it reported the file "still sitting in .hafleet/outbox/" and speculated the
    // watcher might get to it later — an invitation to give up on the mechanism.
    const host = readFileSync('scripts/hafleet-acp-agent.mjs', 'utf-8');
    const drains = host.match(/await drainOutbox\(\)/g) || [];
    expect(drains.length, 'expected a drain before the inbox poll and one after the turn')
      .toBeGreaterThanOrEqual(2);
  });

  test('a rejected file is moved aside rather than retried forever', () => {
    const host = readFileSync('scripts/hafleet-acp-agent.mjs', 'utf-8');
    expect(host).toMatch(/'rejected'/);
    expect(host).toMatch(/\.error/);
  });
});

describe('the outbox is a fallback, not a second advertised channel', () => {
  const host = readFileSync('scripts/hafleet-acp-agent.mjs', 'utf-8');

  test('the nudge does not advertise it alongside send_message', () => {
    // Telling the agent two ways to reply got both used: msg_0063 and msg_0064,
    // same reply_to, both "Pacific" — one via send_message, one via a dropped
    // outbox file. Same duplicate-reply bug as the host relay, one layer up.
    const fn = host.slice(host.indexOf('function buildNudge'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain('send_message');
    expect(body, 'advertising both channels invites duplicate replies')
      .not.toContain('OUTBOX_PROTOCOL');
  });

  test('but it is still drained, so an agent without MCP is not stranded', () => {
    // The mechanism stays: it is the only channel for an agent whose MCP tools
    // failed to load, which is exactly how octos behaved before today.
    expect((host.match(/await drainOutbox\(\)/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(host).toContain('validateOutboxRequest');
  });

  test('the protocol text still exists for whoever needs to document it', () => {
    // Not deleted, just not injected into every prompt.
    expect(OUTBOX_PROTOCOL).toContain('.hafleet/outbox/');
  });
});
