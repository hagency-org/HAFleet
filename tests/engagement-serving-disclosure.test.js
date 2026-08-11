/*
 * What serves a role is disclosed; which agent serves it is not the borrower's to pick.
 *
 * REQ-CONTRIBUTION-CONSOLE-ROLES, as rewritten by the operator ruling of 2026-08-11. The
 * statement previously required the opposite — that the `role → (agent × model)` mapping stay
 * private — and the amendment at the head of ADR-013 records why that was a design error:
 * hiding model quality produces a lemon market, in which a borrower who cannot tell Opus from
 * a cheap model discounts every offer to the worst case, so a contributor lending a strong
 * subscription is indistinguishable from one lending nothing much. On a CONTRIBUTION console
 * that is fatal, because legibility of the contribution is the whole point.
 *
 * THE PART THE REVERSAL DID NOT TOUCH, and the reason this file tests two things rather than
 * one: the request direction. A borrower still asks for a ROLE and cannot select an agent. A
 * named agent is a HINT, honoured only if it independently qualifies for the role and refused
 * otherwise. That is what preserves the provider's freedom to allocate, substitute and
 * reconfigure — so "choosing stays the provider's, knowing becomes the borrower's" needs both
 * halves asserted or it collapses into one of the two policies it is not.
 */

import { afterEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const ROOM = '!disclose:hq.example';

const agent = (name, model, extra = {}) => ({
  name, type: 'claude', server: 'local', tmux: null, online: true, manualDown: false,
  runtimeProfile: { primary: { framework: 'claude', model, ...extra } },
});

/** A fleet with one strong agent and one that cannot reach the coding tier. */
const seed = {
  agents: {
    'claude-agent': agent('claude-agent', 'claude-opus-5', { reasoning: 'high' }),
    'weak-agent': agent('weak-agent', 'claude-haiku-4-5'),
  },
};

const ask = (ctx, body) => request(ctx.app).post('/api/engagements').send({
  project: 'acme/api', projectRoomId: ROOM, role: 'coding',
  requester: '@lin:hq.example', requestedTokens: 400_000, ratePerDay: 20_000, ...body,
});

describe('the serving configuration is disclosed', () => {
  let ctx;
  afterEach(async () => { await ctx?.cleanup?.(); ctx = null; });

  test('a request answers with the framework, model and tier that will serve it', async () => {
    ctx = await createBackendTestContext('serve-disclose-', seed);
    const res = await ask(ctx, { requestId: '$d1' });
    expect(res.status).toBe(200);
    expect(res.body.serving).toMatchObject({
      agent: expect.any(String),
      framework: 'claude',
      model: expect.any(String),
      tier: expect.any(String),
    });
  });

  test('it rides with the engagement rather than needing a second request', async () => {
    /*
     * Deliberate: a caller that has to ask twice can display a role without its fulfilment,
     * and the version that forgets the second call is the one that ships. This is also what
     * the Matrix reply depends on — it has one response to compose its message from.
     */
    ctx = await createBackendTestContext('serve-together-', seed);
    const res = await ask(ctx, { requestId: '$d2' });
    expect(res.body.engagement).toBeTruthy();
    expect(res.body.serving.agent).toBe(res.body.engagement.agent);
  });

  test('the reasoning level travels with the model, because the tier depends on it', async () => {
    /*
     * The same model at a different reasoning level qualifies at a different tier —
     * lib/role-capacity.json lists gpt-5.6-sol at both high and medium — so a model name
     * alone does not tell a borrower what they are getting.
     */
    ctx = await createBackendTestContext('serve-reasoning-', seed);
    const res = await ask(ctx, { requestId: '$d3', agent: 'claude-agent' });
    expect(res.body.serving.agent).toBe('claude-agent');
    expect(res.body.serving.reasoning).toBe('high');
  });

  test('the provider DEPLOYMENT is not disclosed with it', async () => {
    /*
     * The half of the ruling that is a boundary rather than a disclosure. The agent record
     * carries a workspace path, a server, a tmux session and possibly an API key; none of
     * that tells a borrower anything about the work, and all of it is a probe target.
     * Asserted over the serialized response, because a nested field would pass a key check.
     */
    ctx = await createBackendTestContext('serve-private-', {
      agents: {
        'claude-agent': {
          ...agent('claude-agent', 'claude-opus-5', { reasoning: 'high', apiKey: 'sk-secret-model-key' }),
          workspacePath: '/Users/someone/private/workspace',
          tmux: 'hafleet-claude-agent',
          apiKey: 'sk-secret-agent-token',
        },
      },
    });
    const res = await ask(ctx, { requestId: '$d4' });
    const serving = JSON.stringify(res.body.serving);
    expect(serving).not.toContain('sk-secret');
    expect(serving).not.toContain('private/workspace');
    expect(serving).not.toContain('hafleet-claude-agent');
    // And the keys are exactly the capability facts, so a later addition is a decision.
    expect(Object.keys(res.body.serving).sort())
      .toEqual(['agent', 'framework', 'model', 'reasoning', 'tier']);
  });

  test('an agent that has disappeared discloses nothing rather than a guess', async () => {
    // `serving: null` when the record cannot be found. Naming a model nobody looked up
    // would be a claim about what is serving the work.
    ctx = await createBackendTestContext('serve-none-', { agents: {} });
    const res = await ask(ctx, { requestId: '$d5' });
    expect(res.body.serving).toBeNull();
  });
});

describe('the borrower asks for a role and cannot pick the agent', () => {
  let ctx;
  afterEach(async () => { await ctx?.cleanup?.(); ctx = null; });

  test('a named agent that does not qualify is REFUSED, not quietly replaced', async () => {
    /*
     * Refused rather than reassigned, because a caller that named an agent made a claim, and
     * silently serving a different one hides that the claim was wrong. This is the clause
     * that keeps disclosure from turning into selection: if a borrower could name any agent
     * and be served whatever qualified, they would learn to name the one they wanted.
     */
    ctx = await createBackendTestContext('serve-hint-bad-', seed);
    const res = await ask(ctx, { requestId: '$h1', agent: 'weak-agent' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not qualify/);
  });

  test('a named agent that DOES qualify is honoured, so the hint is a hint', async () => {
    // Bounds the rule rather than merely refusing more: the provider's own tooling passes an
    // agent, and a blanket refusal would break it.
    ctx = await createBackendTestContext('serve-hint-ok-', seed);
    const res = await ask(ctx, { requestId: '$h2', agent: 'claude-agent' });
    expect(res.status).toBe(200);
    expect(res.body.engagement.agent).toBe('claude-agent');
  });

  test('an unknown agent name is refused rather than ignored', async () => {
    /*
     * Ignoring it would serve a request whose stated premise was false. The distinction from
     * the previous case matters for the message: "unknown" and "does not qualify" send an
     * operator to different places.
     */
    ctx = await createBackendTestContext('serve-hint-unknown-', seed);
    const res = await ask(ctx, { requestId: '$h3', agent: 'no-such-agent' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown agent/);
  });

  test('with no agent named, the capability model chooses and says which', async () => {
    ctx = await createBackendTestContext('serve-auto-', seed);
    const res = await ask(ctx, { requestId: '$h4' });
    // The weak agent cannot serve coding, so the choice is forced and checkable.
    expect(res.body.engagement.agent).toBe('claude-agent');
    expect(res.body.serving.agent).toBe('claude-agent');
  });
});
