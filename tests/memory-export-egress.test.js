/*
 * SEC-R20-EGRESS: transcripts do not leave the machine unless someone said they may.
 *
 * PRD R20 (`docs/PRD-hafleet-pdu.md:345`) requires transcript/memory export to default to
 * off or to an approved local destination, and its traceability row names this gate. The
 * gate did not exist — zero occurrences outside the PRD — and neither did the control.
 *
 * WHAT WAS ACTUALLY SHIPPING. `lib/upstream-claude-subconscious.js` sends FULL session
 * transcripts to its configured endpoint, and that endpoint defaulted to
 * `https://api.letta.com/v1` in seven places in `backend-v2.js` and several more in the
 * module. The repo's own design note had already flagged it: "a product whose README says
 * 'nothing needs to leave the machine' ships a memory subsystem whose default is a
 * third-party SaaS. That is a default to change before a customer asks."
 *
 * IT WAS FAIL-CLOSED BY ACCIDENT, WHICH IS WHY A TEST MATTERS. Nothing left a clean install,
 * but only because the upstream subconscious needs a sibling checkout no installer fetches
 * and the send path needs a `LETTA_API_KEY` nobody sets. Two absences, not a policy — and
 * an absence can be filled in by anyone dropping a key in `.env`. Meanwhile the
 * subconscious feature itself defaults to ENABLED in two provisioning paths
 * (`bin/hafleet-up:1577`, `scripts/configure-v1-subconscious.js:19`), so the thing being
 * governed is on by default while the governor did not exist.
 */

import { describe, expect, test } from 'vitest';
import { createMemoryExportPolicy, memoryExportPolicyFromEnv } from '../lib/memory-export-policy.js';

describe('the default is nowhere', () => {
  test('a clean environment approves no destination at all', () => {
    /*
     * A-R20-1, as a guarantee rather than an accident. This is the assertion that would
     * fail if someone restored a fallback endpoint.
     */
    const p = memoryExportPolicyFromEnv({});
    expect(p.enabled).toBe(false);
    expect(p.allows('https://api.letta.com/v1').ok).toBe(false);
  });

  test('the refusal names what to do, not merely that it refused', () => {
    // "Export blocked" alone sends an operator to check credentials, when the answer is
    // that they never approved a destination.
    const r = memoryExportPolicyFromEnv({}).allows('https://api.letta.com/v1');
    expect(r.reason).toMatch(/HAFLEET_MEMORY_EXPORT/);
  });

  test('enabling export without naming a destination still sends nothing', () => {
    /*
     * The two settings are independent on purpose. Turning the subsystem on is not the same
     * as saying where transcripts may go, and treating it as such is how a feature flag
     * becomes an egress decision.
     */
    const p = memoryExportPolicyFromEnv({ HAFLEET_MEMORY_EXPORT: '1' });
    expect(p.enabled).toBe(true);
    expect(p.allows('https://api.letta.com/v1').ok).toBe(false);
    expect(p.policy.empty).toBe(true);
  });

  test('the enable flag uses the default-OFF form, not the default-on one', () => {
    /*
     * This repo has both conventions: `=== '1'` (default off, lib/mcp-server-core.js:122)
     * and `!== '0'` (default on, lib/project-inspector.js:382). A subsystem that ships full
     * transcripts off the machine must require a yes, not require remembering to say no.
     */
    for (const value of [undefined, '', '0', 'true', 'yes', 'on']) {
      expect(memoryExportPolicyFromEnv({ HAFLEET_MEMORY_EXPORT: value }).enabled, String(value))
        .toBe(false);
    }
    expect(memoryExportPolicyFromEnv({ HAFLEET_MEMORY_EXPORT: '1' }).enabled).toBe(true);
  });
});

describe('an approved local destination is approved', () => {
  test('loopback and .local pass without being listed', () => {
    // PRD R20 allows "off OR an approved local destination". A self-hosted Letta on
    // loopback is the case the requirement exists to permit.
    const p = memoryExportPolicyFromEnv({ HAFLEET_MEMORY_EXPORT: '1' });
    for (const host of ['http://localhost:8283', 'http://127.0.0.1:8283', 'http://mini1.local:8283']) {
      const r = p.allows(host);
      expect(r.ok, host).toBe(true);
      expect(r.local).toBe(true);
    }
  });

  test('local can be switched off for a deployment that wants an explicit list only', () => {
    const p = memoryExportPolicyFromEnv({
      HAFLEET_MEMORY_EXPORT: '1', HAFLEET_MEMORY_EXPORT_ALLOW_LOCAL: '0',
    });
    expect(p.allows('http://127.0.0.1:8283').ok).toBe(false);
  });
});

describe('an explicit allowlist', () => {
  test('an approved host passes and an unapproved one does not', () => {
    const p = memoryExportPolicyFromEnv({
      HAFLEET_MEMORY_EXPORT: '1',
      HAFLEET_MEMORY_EXPORT_ALLOWED_HOSTS: 'memory.internal.example',
    });
    expect(p.allows('https://memory.internal.example/v1').ok).toBe(true);
    expect(p.allows('https://api.letta.com/v1').ok).toBe(false);
  });

  test('matching is on host, so a path or trailing slash cannot defeat it', () => {
    /*
     * A policy keyed on exact strings is beaten by a trailing slash. An operator who
     * approved a host meant the host.
     */
    const p = createMemoryExportPolicy({ allowed: 'memory.internal.example' });
    for (const v of [
      'https://memory.internal.example',
      'https://memory.internal.example/',
      'https://memory.internal.example/v1/agents',
      'memory.internal.example',
    ]) {
      expect(p.allows(v).ok, v).toBe(true);
    }
  });

  test('a host that merely CONTAINS an approved one is refused', () => {
    // `memory.internal.example.evil.com` must not pass because it contains the approved
    // host as a substring — the failure mode of matching with `includes`.
    const p = createMemoryExportPolicy({ allowed: 'memory.internal.example' });
    expect(p.allows('https://memory.internal.example.evil.com/v1').ok).toBe(false);
    expect(p.allows('https://evil-memory.internal.example.co/v1').ok).toBe(false);
  });

  test('a malformed allowlist denies everything rather than nothing, and says how many', () => {
    /*
     * lib/session-policy.js:78 sets this rule for the same reason: an egress policy that
     * fails open on a typo is worse than none, because it looks like protection.
     */
    const p = createMemoryExportPolicy({ allowed: ',,   ,' });
    expect(p.empty).toBe(true);
    expect(p.allows('https://anything.example').ok).toBe(false);

    const partial = createMemoryExportPolicy({ allowed: 'good.example, not a url at all' });
    expect(partial.malformed).toBe(1);
    expect(partial.allows('https://good.example').ok).toBe(true);
    expect(partial.allows('https://not-a-url-at-all.example').ok).toBe(false);
  });

  test('an unparseable endpoint is refused rather than passed through', () => {
    const p = createMemoryExportPolicy({ allowed: 'good.example' });
    for (const bad of ['', '   ', null, undefined, 'http://']) {
      expect(p.allows(bad).ok, String(bad)).toBe(false);
    }
  });
});
