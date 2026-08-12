/*
 * Where session transcripts may be sent, and by default: nowhere.
 *
 * PRD R20 (`docs/PRD-hafleet-pdu.md:345`) requires transcript/memory export to default to
 * off or to an approved local destination, with acceptance A-R20-1..3 and a gate named
 * `SEC-R20-EGRESS`. The gate did not exist and neither did the control.
 *
 * WHAT IT WAS GOVERNING. `lib/upstream-claude-subconscious.js` sends FULL session
 * transcripts to its configured endpoint, and that endpoint defaulted to
 * `https://api.letta.com/v1` in seven places. The repo's own design note already said so:
 * "a product whose README says 'nothing needs to leave the machine' ships a memory
 * subsystem whose default is a third-party SaaS. That is a default to change before a
 * customer asks." (`docs/design/hafleet-as-pdu.md:239`)
 *
 * IT WAS FAIL-CLOSED ONLY BY ACCIDENT. Nothing leaves a clean install today, but for two
 * reasons that are absences rather than decisions: the upstream subconscious needs a
 * sibling checkout no installer fetches, and the send path needs a `LETTA_API_KEY` nobody
 * has set. Drop a key next to that clone and full transcripts flow to a third party with
 * no further decision, no record, and no per-project authorization. Meanwhile the
 * subconscious feature itself defaults to ENABLED in two provisioning paths
 * (`bin/hafleet-up:1577`, `scripts/configure-v1-subconscious.js:19`).
 *
 * So the fix is not a new guard on top of a safe default — it is replacing an unsafe
 * default that happened to be unreachable.
 *
 * SHAPE COPIED FROM `lib/session-policy.js` deliberately, including its rule that a
 * malformed allowlist denies everything rather than nothing. An egress policy that fails
 * open on a typo is worse than none, because it looks like protection.
 */

/** Hosts that count as "an approved local destination" without being listed. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

const isLocalHost = (host) => LOCAL_HOSTS.has(host) || host.endsWith('.local');

/**
 * Parse an endpoint into a comparable host, or null if it is not a usable URL.
 *
 * Compared on HOST, not on the whole string: a policy keyed on exact strings is defeated
 * by a trailing slash or an added path, and an operator who allowed a host meant the host.
 */
function hostOf(endpoint) {
  const raw = String(endpoint ?? '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Build a policy from an allowlist.
 *
 * @param allowed comma-separated hosts or URLs the operator has approved
 * @param allowLocal whether loopback and `.local` are approved without being listed
 */
export function createMemoryExportPolicy({ allowed = '', allowLocal = true } = {}) {
  const entries = String(allowed ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const hosts = new Set();
  let malformed = 0;
  for (const entry of entries) {
    const host = hostOf(entry);
    if (host) hosts.add(host);
    else malformed += 1;
  }

  return {
    /** Nothing is approved. The default state, and the one A-R20-1 asks for. */
    get empty() { return hosts.size === 0; },
    /** Entries that could not be parsed. Reported, because a typo silently narrows a policy. */
    get malformed() { return malformed; },

    /**
     * May transcripts go to this endpoint?
     *
     * Returns a reason on refusal rather than a bare false: "export blocked" without a
     * reason sends an operator to check credentials when the answer is that they never
     * approved a destination.
     */
    allows(endpoint) {
      const host = hostOf(endpoint);
      if (!host) {
        return { ok: false, reason: 'no memory-export destination configured' };
      }
      if (allowLocal && isLocalHost(host)) {
        return { ok: true, reason: null, local: true };
      }
      if (hosts.has(host)) return { ok: true, reason: null, local: false };
      return {
        ok: false,
        reason: `${host} is not an approved memory-export destination; full session `
          + 'transcripts are not sent to an unapproved host. Add it to '
          + 'HAFLEET_MEMORY_EXPORT_ALLOWED_HOSTS to approve it.',
      };
    },
  };
}

/**
 * The policy from the environment.
 *
 * `HAFLEET_MEMORY_EXPORT === '1'` to enable at all — the repo's default-off form
 * (`lib/mcp-server-core.js:122`), not the `!== '0'` default-on form. A subsystem that
 * ships full transcripts off the machine should require the operator to say yes, not to
 * remember to say no.
 */
export function memoryExportPolicyFromEnv(env = process.env) {
  const enabled = String(env.HAFLEET_MEMORY_EXPORT ?? '').trim() === '1';
  const policy = createMemoryExportPolicy({
    allowed: env.HAFLEET_MEMORY_EXPORT_ALLOWED_HOSTS ?? '',
    allowLocal: String(env.HAFLEET_MEMORY_EXPORT_ALLOW_LOCAL ?? '1').trim() !== '0',
  });
  return {
    enabled,
    policy,
    /** One call answering the whole question, so no caller has to combine the two. */
    allows(endpoint) {
      if (!enabled) {
        return {
          ok: false,
          reason: 'memory export is off; set HAFLEET_MEMORY_EXPORT=1 to enable it and '
            + 'HAFLEET_MEMORY_EXPORT_ALLOWED_HOSTS to say where transcripts may go',
        };
      }
      return policy.allows(endpoint);
    },
  };
}
