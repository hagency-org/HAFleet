import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';

import { anyReplyable, buildReplyHint, REPLYABLE_TYPES } from '../lib/reply-hint.js';

// Not every message wants an answer. A `task` is work to do; a `human` or
// `request` is someone waiting.
//
// The rule existed only on the tmux path. The ACP host told its agent to reply
// unconditionally, so one `hafleet tell` (which sends type "task") produced
// silence from claude and codex and a message from octos. All three answered "Au";
// only octos posted it. That is octos over-replying, and it is why its message
// count reached 26 against codex's 3.

describe('who gets told to reply', () => {
  test.each(['human', 'request'])('%s wants an answer', (type) => {
    expect(buildReplyHint({ id: 'm1', from: 'alice', type })).toMatch(/send_message/);
  });

  test.each(['task', 'inform', 'notice', 'status', undefined, null])('%s does not', (type) => {
    // `hafleet tell` sends "task". Instructing a reply to those turns the message
    // log into an echo of itself.
    expect(buildReplyHint({ id: 'm1', from: 'alice', type })).toBeNull();
  });

  test('a group message is answered with post, not send_message', () => {
    const hint = buildReplyHint({ id: 'm1', from: 'alice', type: 'request', group: 'dev' });
    expect(hint).toMatch(/post\(group="dev"/);
    expect(hint).not.toMatch(/send_message/);
  });

  test('it threads the reply to the message that asked', () => {
    expect(buildReplyHint({ id: 'm42', from: 'alice', type: 'human' })).toContain('reply_to="m42"');
  });

  test('an explicit target overrides the sender', () => {
    expect(buildReplyHint({ id: 'm1', from: 'alice', type: 'human' }, 'bob')).toContain('to="bob"');
  });

  test('no usable target means no instruction', () => {
    // Better to say nothing than to tell an agent to reply into the void.
    expect(buildReplyHint({ id: 'm1', from: '   ', type: 'human' })).toBeNull();
    expect(buildReplyHint({ id: 'm1', type: 'human' })).toBeNull();
  });

  test('the mcp namespace is not hardcoded', () => {
    expect(buildReplyHint({ id: 'm1', from: 'a', type: 'human' }, null, 'fleet2'))
      .toContain('fleet2 MCP tool');
  });

  test.each([null, undefined, 'a string', 42])('%s is refused', (v) => {
    expect(buildReplyHint(v)).toBeNull();
  });

  test('anyReplyable spots a mixed batch', () => {
    expect(anyReplyable([{ type: 'task' }, { type: 'human' }])).toBe(true);
    expect(anyReplyable([{ type: 'task' }, { type: 'inform' }])).toBe(false);
    expect(anyReplyable([])).toBe(false);
  });

  test('the replyable set stays two kinds', () => {
    // Widening this makes every agent chattier at once; it should be deliberate.
    expect([...REPLYABLE_TYPES]).toEqual(['human', 'request']);
  });
});

describe('both transports use the one rule', () => {
  test('the backend delegates rather than keeping its own copy', () => {
    const backend = readFileSync('backend-v2.js', 'utf-8');
    expect(backend).toContain("from './lib/reply-hint.js'");
    expect(backend).toMatch(/return buildReplyHint\(msg, replyTo\);/);
    expect(backend, 'a second copy of the rule is how the two drifted')
      .not.toMatch(/msg\.type !== 'human' && msg\.type !== 'request'/);
  });

  test('the ACP host applies it instead of instructing unconditionally', () => {
    const host = readFileSync('scripts/hafleet-acp-agent.mjs', 'utf-8');
    expect(host).toContain("from '../lib/reply-hint.js'");
    const fn = host.slice(host.indexOf('function buildNudge'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain('buildReplyHint');
    expect(body, 'the unconditional instruction is what caused the over-reply')
      .not.toMatch(/Reply with \$\{MCP_SERVER_NAME\} send_message/);
  });

  test('the host reads unread-list, which carries the types it needs', () => {
    // /unread returns only counts and a `latest`; the rule needs each message's
    // type, so a batch is judged per message rather than by its last entry.
    const host = readFileSync('scripts/hafleet-acp-agent.mjs', 'utf-8');
    expect(host).toContain('/unread-list');
  });
});
