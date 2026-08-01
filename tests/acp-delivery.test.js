import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import request from 'supertest';

import { createBackendTestContext } from './helpers/backend-test-runtime.js';

// An ACP agent has no tmux pane, and its session is held by a separate host
// process the backend cannot reach into. So delivery is inverted: the backend
// records the message, and scripts/hafleet-acp-agent.mjs pulls it by polling the
// same inbox endpoint check_inbox uses, then prompts the agent.
//
// Before this, pushNotify treated a paneless agent as a broken tmux agent and
// returned 'missing-tmux-target'. Two things were wrong with that. The reason was
// misleading, and pushNotifyStatus turned it into ok:false while POST /api/messages
// still answered {"ok":true,"warnings":[]}. Verified live on mini5: a message to
// octos-agent was accepted with ok:true, sat in messages.json with
// delivered=None forever, and the only trace was one line in backend.log reading
// "skip octos-agent: missing-tmux-target". The interface lied.

const API_TOKEN = 'acp-delivery-api-token';
const OCTOS_TOKEN = 'octos-agent-token';
const CLAUDE_TOKEN = 'claude-agent-token';

const readDeliveryEvents = (runtimeDir) => {
  const filePath = path.join(runtimeDir, 'data', 'message-delivery-events.jsonl');
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

describe('delivery to a paneless ACP agent', () => {
  let context;

  beforeAll(async () => {
    context = await createBackendTestContext('hafleet-acp-delivery-test-', {
      agents: {
        // octos is declared transport:'acp' in its adapter, so this agent is
        // paneless by type rather than by a missing field.
        'octos-agent': { name: 'octos-agent', type: 'octos', kind: 'agent', online: true },
        // A tmux agent that genuinely has no pane, to prove the old reason survives
        // for the case it actually describes.
        'broken-claude': { name: 'broken-claude', type: 'claude', kind: 'agent', online: true },
      },
      agentTokens: { 'octos-agent': OCTOS_TOKEN, 'broken-claude': CLAUDE_TOKEN },
      env: { API_TOKEN },
    });
  });

  afterAll(() => context?.cleanup?.());

  test('a message to an ACP agent is recorded as pending pull, not as a tmux failure', async () => {
    const response = await request(context.app)
      .post('/api/messages')
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .send({ from: 'system', to: 'octos-agent', type: 'task', summary: 'do the thing', full: 'do the thing' });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);

    const events = readDeliveryEvents(context.runtimeDir)
      .filter((e) => e.agent === 'octos-agent');
    expect(events.length).toBeGreaterThan(0);
    const reasons = events.map((e) => e.reason);
    expect(reasons).toContain('acp-pull-pending');
    expect(reasons, 'an ACP agent must not be reported as a broken tmux agent').not.toContain('missing-tmux-target');
  });

  test('a tmux agent with no pane still reports missing-tmux-target', async () => {
    // The old reason is correct for the case it names, and must keep working — an
    // agent whose pane died is a real fault, not a transport difference.
    await request(context.app)
      .post('/api/messages')
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .send({ from: 'system', to: 'broken-claude', type: 'task', summary: 'x', full: 'x' });

    const reasons = readDeliveryEvents(context.runtimeDir)
      .filter((e) => e.agent === 'broken-claude')
      .map((e) => e.reason);
    expect(reasons).toContain('missing-tmux-target');
  });

  test('the message is readable through the inbox the ACP host polls', async () => {
    // This is the actual delivery mechanism: the host cannot be pushed to, so it
    // pulls from here. If this endpoint does not return the message, delivery is
    // impossible no matter what the runtime does.
    const unread = await request(context.app)
      .get('/api/inbox/octos-agent/unread')
      .set('X-Agent-Token', OCTOS_TOKEN);
    expect(unread.status).toBe(200);

    const inbox = await request(context.app)
      .get('/api/inbox/octos-agent')
      .set('X-Agent-Token', OCTOS_TOKEN);
    expect(inbox.status).toBe(200);
    const ids = [...(inbox.body.dm || []), ...(inbox.body.group || [])].map((m) => m.id);
    expect(ids.length).toBeGreaterThan(0);
  });

  test('the unfiltered read advances the cursor, so a message is delivered once', async () => {
    // The host prompts after this read. If the cursor did not advance, a failed
    // prompt would re-deliver the same message on every poll, forever.
    const second = await request(context.app)
      .get('/api/inbox/octos-agent')
      .set('X-Agent-Token', OCTOS_TOKEN);
    expect(second.status).toBe(200);
    const ids = [...(second.body.dm || []), ...(second.body.group || [])].map((m) => m.id);
    expect(ids).toEqual([]);
  });
});
