import { describe, expect, test } from 'vitest';

import { createSessionPolicy, parsePatterns, sessionPolicyFromEnv } from '../lib/session-policy.js';

// Context for these tests: on a real fleet host a fresh install adopted five
// pre-existing tmux sessions running unrelated work, which made HAFleet able to
// type into them. This module is the gate that prevents that.

describe('parsePatterns', () => {
  test('absent means no opinion', () => {
    expect(parsePatterns(undefined)).toBeNull();
    expect(parsePatterns(null)).toBeNull();
    expect(parsePatterns('')).toBeNull();
    expect(parsePatterns('   ')).toBeNull();
  });

  test('splits on commas and whitespace', () => {
    expect(parsePatterns('a,b c,  d ')).toEqual(['a', 'b', 'c', 'd']);
    expect(parsePatterns('a,,b')).toEqual(['a', 'b']);
  });

  test('set-but-unusable is distinguishable from absent', () => {
    // Must not collapse to null: that would read a broken restriction as
    // "no restriction wanted" and silently allow everything.
    expect(parsePatterns(',')).not.toBeNull();
    expect(parsePatterns(', ,')).not.toBeNull();
    expect(parsePatterns(',')).not.toEqual([]);
  });
});

describe('default install is unchanged', () => {
  const policy = createSessionPolicy({});

  test('claims every session when neither var is set', () => {
    for (const name of ['ps2', 'anything', 'a-b_c.1']) {
      expect(policy.allows(name)).toBe(true);
    }
    expect(policy.unrestricted).toBe(true);
    expect(policy.evaluate('ps2').reason).toBe('no-policy');
  });

  test('an empty value is the same as unset', () => {
    // `AGENT_CHAT_SESSION_ALLOWLIST=` in a .env must not lock the host out.
    const p = createSessionPolicy({ allowlist: '', denylist: '' });
    expect(p.unrestricted).toBe(true);
    expect(p.allows('ps2')).toBe(true);
  });
});

describe('denylist', () => {
  const policy = createSessionPolicy({ denylist: 'ps2,ps3,psf,test,uq' });

  test('the five octos sessions from mini5 are refused', () => {
    for (const name of ['ps2', 'ps3', 'psf', 'test', 'uq']) {
      expect(policy.evaluate(name)).toEqual({ allowed: false, reason: 'denylisted' });
    }
  });

  test('everything else still passes', () => {
    expect(policy.allows('claude-worker')).toBe(true);
    expect(policy.unrestricted).toBe(false);
  });

  test('matching is exact, not substring', () => {
    // 'test' in the denylist must not take out 'test-harness'.
    expect(policy.allows('test-harness')).toBe(true);
    expect(policy.allows('pretest')).toBe(true);
    expect(policy.allows('ps22')).toBe(true);
  });
});

describe('allowlist', () => {
  const policy = createSessionPolicy({ allowlist: 'claude-a,claude-b' });

  test('only the named sessions are managed', () => {
    expect(policy.evaluate('claude-a')).toEqual({ allowed: true, reason: 'allowlisted' });
    expect(policy.evaluate('ps2')).toEqual({ allowed: false, reason: 'not-allowlisted' });
  });
});

describe('globs', () => {
  test('* matches a run of characters', () => {
    const policy = createSessionPolicy({ allowlist: 'claude-*' });
    expect(policy.allows('claude-a')).toBe(true);
    expect(policy.allows('claude-')).toBe(true);
    expect(policy.allows('claude')).toBe(false);
    expect(policy.allows('xclaude-a')).toBe(false);
  });

  test('* works mid-pattern and as a suffix', () => {
    expect(createSessionPolicy({ allowlist: 'a*z' }).allows('abcz')).toBe(true);
    expect(createSessionPolicy({ allowlist: 'a*z' }).allows('abcy')).toBe(false);
    expect(createSessionPolicy({ allowlist: '*-worker' }).allows('ci-worker')).toBe(true);
  });

  test('a bare * allows everything, explicitly', () => {
    expect(createSessionPolicy({ allowlist: '*' }).allows('whatever')).toBe(true);
  });

  test('regex metacharacters in a pattern are literal', () => {
    // A session named 'a.b' must not be matched by the pattern 'a?b' or 'aXb'.
    const policy = createSessionPolicy({ allowlist: 'a.b' });
    expect(policy.allows('a.b')).toBe(true);
    expect(policy.allows('aXb')).toBe(false);
    // And a pattern full of metacharacters must not throw.
    expect(() => createSessionPolicy({ allowlist: '^($[)+' }).allows('x')).not.toThrow();
    expect(createSessionPolicy({ allowlist: '^($[)+' }).allows('^($[)+')).toBe(true);
  });
});

describe('denial wins', () => {
  test('a session on both lists is refused', () => {
    const policy = createSessionPolicy({ allowlist: 'ps2,ok', denylist: 'ps2' });
    expect(policy.evaluate('ps2')).toEqual({ allowed: false, reason: 'denylisted' });
    expect(policy.allows('ok')).toBe(true);
  });

  test('a glob denial beats a specific allow', () => {
    const policy = createSessionPolicy({ allowlist: 'octos-important', denylist: 'octos-*' });
    expect(policy.allows('octos-important')).toBe(false);
  });
});

describe('fails closed', () => {
  test.each([',', ' , ', ',,,'])('an unreadable allowlist (%p) refuses everything', (raw) => {
    const policy = createSessionPolicy({ allowlist: raw });
    expect(policy.evaluate('anything')).toEqual({ allowed: false, reason: 'policy-unreadable' });
    expect(policy.warnings.join(' ')).toMatch(/ALLOWLIST/);
  });

  test('an unreadable denylist also refuses everything', () => {
    const policy = createSessionPolicy({ denylist: ',' });
    expect(policy.allows('anything')).toBe(false);
    expect(policy.warnings.join(' ')).toMatch(/DENYLIST/);
  });

  test('a non-string value is not silently ignored', () => {
    expect(createSessionPolicy({ allowlist: 42 }).allows('x')).toBe(false);
    expect(createSessionPolicy({ allowlist: ['a'] }).allows('a')).toBe(false);
  });

  test.each([undefined, null, '', '   ', 42, {}])('a bad session name (%p) is refused', (name) => {
    const policy = createSessionPolicy({});
    expect(policy.evaluate(name)).toEqual({ allowed: false, reason: 'invalid-session-name' });
  });

  test('reasons are fixed codes, never interpolated input', () => {
    // These strings get logged; a session name must never reach a log line
    // through this path.
    const policy = createSessionPolicy({ denylist: 'secret-session' });
    expect(policy.evaluate('secret-session').reason).toBe('denylisted');
    expect(policy.evaluate('secret-session').reason).not.toContain('secret');
  });
});

describe('filter', () => {
  test('partitions and preserves order', () => {
    const policy = createSessionPolicy({ denylist: 'ps2,uq' });
    expect(policy.filter(['ps2', 'a', 'uq', 'b'])).toEqual({
      kept: ['a', 'b'],
      rejected: ['ps2', 'uq'],
    });
  });

  test('tolerates a null iterable', () => {
    expect(createSessionPolicy({}).filter(null)).toEqual({ kept: [], rejected: [] });
  });

  test('accepts a Set, which is what the relay holds', () => {
    const policy = createSessionPolicy({ denylist: 'ps2' });
    expect(policy.filter(new Set(['ps2', 'keep'])).kept).toEqual(['keep']);
  });
});

describe('sessionPolicyFromEnv', () => {
  test('reads both vars from an injected env', () => {
    const policy = sessionPolicyFromEnv({
      AGENT_CHAT_SESSION_DENYLIST: 'ps2',
      AGENT_CHAT_SESSION_ALLOWLIST: '',
    });
    expect(policy.allows('ps2')).toBe(false);
    expect(policy.allows('other')).toBe(true);
  });

  test('an env with neither var is unrestricted', () => {
    expect(sessionPolicyFromEnv({}).unrestricted).toBe(true);
  });
});
