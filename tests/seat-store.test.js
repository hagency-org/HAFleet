import { describe, it, expect } from 'vitest';
import {
  authModeOf, seatIdentity, buildSeats, normalizeDeclaration,
} from '../lib/seat-store.js';

/*
 * The fact these tests defend: capacity is bought per credential home, not per
 * agent, so two agents on one subscription share one quota however much each of
 * them declares. Before lib/seat-store.js the product had no way to express that —
 * `seat`, `credentialHome`, `planType` and `quota` had zero occurrences anywhere.
 */

const agent = (name, over = {}) => ({
  name, server: 'local', type: 'claude', ...over,
});
const withModel = (name, model, over = {}) => agent(name, {
  runtimeProfile: { primary: { framework: 'claude', provider: 'anthropic', model } },
  ...over,
});

describe('auth mode', () => {
  it('is subscription unless the runtime profile carries an explicit key', () => {
    expect(authModeOf(withModel('a', 'claude-opus-5'))).toBe('subscription');
    expect(authModeOf(agent('b'))).toBe('subscription');
  });

  it('is api-key when a key is set, including the redacted `true` the API returns', () => {
    expect(authModeOf({ runtimeProfile: { primary: { apiKey: 'sk-live' } } })).toBe('api-key');
    expect(authModeOf({ runtimeProfile: { primary: { apiKey: true } } })).toBe('api-key');
  });
});

describe('seat identity', () => {
  it('gives two agents on one host, framework and auth mode the SAME seat', () => {
    // The whole point. bin/hafleet-up never reassigns $HOME, so both read the same
    // credential home and consume one subscription.
    const a = seatIdentity(withModel('a', 'claude-opus-5'));
    const b = seatIdentity(withModel('b', 'claude-sonnet-5'));
    expect(a.seatId).toBe(b.seatId);
  });

  it('separates api-key mode from the subscription', () => {
    const sub = seatIdentity(withModel('a', 'claude-opus-5'));
    const key = seatIdentity({
      name: 'b', server: 'local', type: 'claude',
      runtimeProfile: { primary: { framework: 'claude', apiKey: true } },
    });
    // Different pools of money, so they must not share a quota.
    expect(sub.seatId).not.toBe(key.seatId);
    expect(key.authMode).toBe('api-key');
  });

  it('separates credential homes and hosts, not frameworks as such', () => {
    // This test previously asserted that DIFFERENT FRAMEWORKS mean different seats,
    // which is the defect rather than the requirement: `codex` and `codex-acp` read
    // the same `~/.codex`, so they share the login and the quota. Framework only
    // matters insofar as it selects a credential home.
    const claude = seatIdentity(agent('a', { type: 'claude' }));
    const codex = seatIdentity(agent('a', { type: 'codex' }));
    const remote = seatIdentity(agent('a', { type: 'claude', server: 'box2' }));
    expect(new Set([claude.seatId, codex.seatId, remote.seatId]).size).toBe(3);
    expect(claude.credentialHome).toBe('~/.claude');
    expect(codex.credentialHome).toBe('~/.codex');
  });

  it('gives codex and codex-acp ONE seat, because they share ~/.codex', () => {
    const a = seatIdentity(agent('a', { type: 'codex' }));
    const b = seatIdentity(agent('b', { type: 'codex-acp' }));
    expect(a.credentialHome).toBe(b.credentialHome);
    expect(a.seatId).toBe(b.seatId);
  });

  it('gives two DIFFERENT api keys different seats', () => {
    // Two keys are two credit pools. Bucketing both under a single `api-key` mode
    // merged them, which under-reports over-subscription — the one thing a seat is
    // for. The digest distinguishes them without storing the key.
    const withKey = (k) => seatIdentity({
      name: 'x', server: 'local', type: 'claude',
      runtimeProfile: { primary: { framework: 'claude', apiKey: k } },
    });
    const a = withKey('sk-aaa');
    const b = withKey('sk-bbb');
    expect(a.seatId).not.toBe(b.seatId);
    expect(a.keyScope).not.toBe(b.keyScope);
    // And never the key itself.
    for (const s of [a.seatId, a.keyScope]) expect(s).not.toContain('sk-aaa');
  });

  it('says when a key split is approximate rather than exact', () => {
    // The API redacts a stored key to `true`, so the key cannot be digested and every
    // such agent lands in one bucket. Reported, not silently treated as exact.
    const redacted = seatIdentity({
      name: 'x', server: 'local', type: 'claude',
      runtimeProfile: { primary: { apiKey: true } },
    });
    expect(redacted.keyScope).toBe('key:redacted');
    expect(redacted.authMode).toBe('api-key');
  });

  it('never exposes a path, and marks an unkeyed digest as unkeyed', () => {
    const unkeyed = seatIdentity(agent('a'));
    expect(unkeyed.keyed).toBe(false);
    expect(unkeyed.keyId).toMatch(/unkeyed/);
    const keyed = seatIdentity(agent('a'), { keyId: 'k1', secret: 'deployment-secret' });
    expect(keyed.keyed).toBe(true);
    expect(keyed.keyId).toBe('k1');
    // Keying must actually change the value, or the key is decoration.
    expect(keyed.seatId).not.toBe(unkeyed.seatId);
    for (const s of [unkeyed.seatId, keyed.seatId]) {
      expect(s).not.toMatch(/\//);
      expect(s).not.toMatch(/home|Users|\.claude/);
    }
  });

  it('rotating the key changes the id, and the same key reproduces it', () => {
    const a = seatIdentity(agent('x'), { keyId: 'k1', secret: 's1' });
    const b = seatIdentity(agent('x'), { keyId: 'k2', secret: 's2' });
    const again = seatIdentity(agent('x'), { keyId: 'k1', secret: 's1' });
    expect(a.seatId).not.toBe(b.seatId);
    expect(again.seatId).toBe(a.seatId);
  });
});

describe('over-subscription', () => {
  const presets = [
    { id: 'p1', ceiling: { tokens: 5_000_000 } },
    { id: 'p2', ceiling: { tokens: 5_000_000 } },
    { id: 'p3' }, // configured, but no ceiling — the live backend's actual state
  ];

  it('sums what has been promised out of one shared seat', () => {
    const seats = buildSeats({
      agents: [
        withModel('a', 'claude-opus-5', { presetId: 'p1' }),
        withModel('b', 'claude-sonnet-5', { presetId: 'p2' }),
      ],
      presets,
      declarations: {},
    });
    expect(seats).toHaveLength(1);
    // 5M + 5M against ONE subscription. This is the number that did not exist.
    expect(seats[0].declaredTokens).toBe(10_000_000);
    expect(seats[0].members).toHaveLength(2);
  });

  it('reports over-subscription only when a quota has been declared', () => {
    const build = (declarations) => buildSeats({
      agents: [
        withModel('a', 'claude-opus-5', { presetId: 'p1' }),
        withModel('b', 'claude-sonnet-5', { presetId: 'p2' }),
      ],
      presets,
      declarations,
    })[0];

    const undeclared = build({});
    // Null, not false: "not over-subscribed" and "no way to tell" are different
    // answers, and false is the reassuring one.
    expect(undeclared.quotaTokens).toBeNull();
    expect(undeclared.overSubscribed).toBeNull();
    expect(undeclared.headroomTokens).toBeNull();

    const seatId = undeclared.seatId;
    const tight = build({ [seatId]: { quotaTokens: 6_000_000, period: 'monthly' } });
    expect(tight.overSubscribed).toBe(true);
    expect(tight.headroomTokens).toBe(-4_000_000);

    const roomy = build({ [seatId]: { quotaTokens: 20_000_000, period: 'monthly' } });
    expect(roomy.overSubscribed).toBe(false);
    expect(roomy.headroomTokens).toBe(10_000_000);
  });

  it('counts members whose preset carries no ceiling instead of treating them as 0', () => {
    const seat = buildSeats({
      agents: [
        withModel('a', 'claude-opus-5', { presetId: 'p1' }),
        withModel('b', 'claude-sonnet-5', { presetId: 'p3' }),
        withModel('c', 'claude-fable-5'),
      ],
      presets,
      declarations: {},
    })[0];
    expect(seat.declaredTokens).toBe(5_000_000);
    // Two members promise nothing measurable. Without this count, declaredTokens
    // reads as the whole story and a reader concludes the seat is barely used.
    expect(seat.membersWithoutCeiling).toBe(2);
    expect(seat.members.filter((m) => m.ceilingTokens === null)).toHaveLength(2);
  });

  it('says on every seat that nothing is enforced', () => {
    const seats = buildSeats({ agents: [withModel('a', 'claude-opus-5', { presetId: 'p1' })], presets });
    expect(seats[0].enforced).toBe(false);
  });
});

describe('declarations', () => {
  it('keeps only the fields it understands', () => {
    expect(normalizeDeclaration({ quotaTokens: 5_000_000, period: 'monthly', planLabel: 'Max 20x', evil: 1 }))
      .toEqual({ quotaTokens: 5_000_000, period: 'monthly', planLabel: 'Max 20x' });
  });

  it('rejects a nonsense period and a negative quota rather than storing them', () => {
    const d = normalizeDeclaration({ quotaTokens: -5, period: 'fortnightly', planLabel: 'x' });
    expect(d.period).toBeNull();
    expect(d.quotaTokens).toBeNull();
  });

  it('returns null when there is nothing to declare', () => {
    expect(normalizeDeclaration({})).toBeNull();
    expect(normalizeDeclaration({ evil: 1 })).toBeNull();
  });
});

describe('the digest material cannot collide', () => {
  it('distinguishes triples that a naive separator would merge', () => {
    // The reason the material is JSON-encoded rather than joined: with a printable
    // separator, a server id containing it makes two different triples produce one
    // seat id — which silently merges two quotas into one.
    const a = seatIdentity({ server: 'box:claude', type: 'x', runtimeProfile: null });
    const b = seatIdentity({ server: 'box', type: 'claude:x', runtimeProfile: null });
    expect(a.seatId).not.toBe(b.seatId);

    const c = seatIdentity({ server: 'a"b', type: 'c', runtimeProfile: null });
    const d = seatIdentity({ server: 'a', type: 'b"c', runtimeProfile: null });
    expect(c.seatId).not.toBe(d.seatId);
  });

  it('produces an id with no control characters in it', () => {
    const { seatId } = seatIdentity({ server: 'local', type: 'claude', runtimeProfile: null });
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u001f]/.test(seatId)).toBe(false);
  });
});
