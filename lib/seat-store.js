/*
 * Seats: the unit capacity is actually bought in.
 *
 * WHY THIS EXISTS. The console lets a contributor declare a token ceiling per
 * agent, which is the unit they reason about — "my Opus agent, 5M a month". But
 * that is not the unit the capacity is *bought* in, and the gap is not theoretical:
 *
 *   - bin/hafleet-up:1640-1644 unsets ANTHROPIC_API_KEY for a Claude agent unless
 *     its runtime profile supplies one explicitly, so by default the agent runs on
 *     the operator's authenticated subscription;
 *   - `$HOME` is never reassigned anywhere in the launch path, so every Claude
 *     agent on a host reads the same credential home.
 *
 * Two agents each declaring 5M against one subscription therefore do not have 10M.
 * They have one quota and two claims on it. Before this module the product had no
 * way to say so — `seat`, `credentialHome`, `planType` and `quota` had zero
 * occurrences in lib/ and backend-v2.js.
 *
 * WHAT IS DERIVED AND WHAT MUST BE DECLARED. Seat IDENTITY is derived: which
 * agents share a credential home is a fact about how they were launched. Seat
 * QUOTA is not derivable at all — no provider exposes "how many tokens does this
 * subscription include", and nothing here meters consumption. So a quota is an
 * operator declaration, marked as one, and a seat with no declared quota reports
 * `null` rather than a guess.
 *
 * PRIVACY. The seat id is a keyed digest, never a path. A raw credential-home path
 * leaks the host's directory layout, and an unkeyed hash of a small, guessable
 * input set is reversible by anyone who can enumerate it — so the digest is keyed
 * with deployment-local material and carries its key id for rotation. This follows
 * the PRD's R8 requirement rather than inventing a scheme.
 */

import { createHmac, createHash } from 'crypto';

/** Auth modes that consume different pools of money. */
export const AUTH_MODES = ['subscription', 'api-key'];

/**
 * Which pool of money an agent draws on.
 *
 * An explicit API key in the runtime profile is the deliberate exception path
 * (bin/hafleet-up only unsets the env key when the profile has none), and it bills
 * to a credit pool rather than to the interactive subscription. Keeping the two
 * apart is the whole reason this field exists: they are not one quota.
 */
export function authModeOf(agent) {
  const p = agent?.runtimeProfile?.primary;
  // The API redacts a stored key to `true`, so both forms mean "a key is set".
  const hasKey = p?.apiKey === true || (typeof p?.apiKey === 'string' && p.apiKey.length > 0);
  return hasKey ? 'api-key' : 'subscription';
}

/*
 * Which credential home each framework reads.
 *
 * This is the thing that is actually shared, and keying on the FRAMEWORK instead was
 * wrong in both directions: `codex` and `codex-acp` both read `~/.codex` and were
 * given separate seats, so one quota looked like two; meanwhile two Claude agents
 * carrying different API keys were given one seat, so two independent credit pools
 * looked like one. Both errors under-report over-subscription, which is the only
 * thing the seat exists to surface.
 */
const CREDENTIAL_HOME = {
  claude: '~/.claude',
  codex: '~/.codex',
  'codex-acp': '~/.codex',
  octos: '~/.config/octos',
  hermes: '~/.hermes',
};

/**
 * The seat an agent occupies.
 *
 * Keyed on (server, credential home, key identity) — the three things that decide
 * whether two agents draw on the same pool of money:
 *
 *  - **server**, because a credential home on another host is another home.
 *  - **credential home**, not framework: `codex` and `codex-acp` share `~/.codex`,
 *    so they share the login and therefore the quota.
 *  - **key identity** in api-key mode. A digest of the key, never the key: two
 *    different keys are two different credit pools, and the first version merged
 *    them under a single `api-key` bucket. Subscription mode has no key, so all
 *    subscription agents on one credential home share one seat, which is correct.
 *
 * Provider is carried for display but is not part of the key: a provider string is a
 * label on a profile, not evidence about which credential a launch will use.
 */
export function seatIdentity(agent, { keyId = 'dev', secret = '' } = {}) {
  const server = String(agent?.server || 'local').trim().toLowerCase();
  const framework = String(agent?.type || 'agent').trim().toLowerCase();
  const authMode = authModeOf(agent);
  const credentialHome = CREDENTIAL_HOME[framework] ?? `~/.${framework}`;
  /*
   * In api-key mode, a digest of the key distinguishes pools. The API redacts a
   * stored key to `true`, in which case the key is unknowable from here and every
   * such agent falls into one bucket — reported below via `keyScope` so a caller can
   * see that the split is approximate rather than assume it is exact.
   */
  const rawKey = agent?.runtimeProfile?.primary?.apiKey;
  const keyScope = authMode === 'subscription' ? 'subscription'
    : (typeof rawKey === 'string' && rawKey.length > 0
      ? `key:${createHash('sha256').update(rawKey).digest('hex').slice(0, 12)}`
      : 'key:redacted');
  /*
   * JSON-encoded rather than concatenated with a separator.
   *
   * A separator only works if it cannot occur inside any component, and the first
   * draft of this line silently used a NUL byte — which is unambiguous but also
   * makes the source file binary, and tripped the repository's no-NUL-in-source
   * check. Picking a printable separator instead just moves the assumption: a
   * server id containing it would let two different triples hash to one seat.
   * JSON.stringify of the array is canonical for these three strings and cannot
   * collide, so no assumption is needed.
   */
  const material = JSON.stringify([server, credentialHome, keyScope]);
  const digest = secret
    ? createHmac('sha256', secret).update(material).digest('hex')
    // No deployment secret configured: fall back to a plain digest and SAY SO in
    // the id, so a caller can never mistake an unkeyed value for a keyed one.
    : createHash('sha256').update(material).digest('hex');
  return {
    seatId: `seat_${keyId}_${digest.slice(0, 16)}`,
    keyId: secret ? keyId : `${keyId}-unkeyed`,
    keyed: Boolean(secret),
    server,
    framework,
    authMode,
    // What is actually shared, and how precisely the sharing is known.
    credentialHome,
    // 'subscription', or 'key:<digest>' / 'key:redacted'. Surfaced so a caller can
    // tell an exact key split from an approximate one.
    keyScope,
    provider: agent?.runtimeProfile?.primary?.provider ?? null,
  };
}

const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);

/**
 * Group agents into seats and total what has been promised against each.
 *
 * `declaredTokens` is the sum of member agents' ceilings — what the operator has
 * promised out of this seat. `quotaTokens` is what the seat is believed to hold,
 * and it is null until declared. `overSubscribed` is only meaningful when both
 * exist, so it is null otherwise rather than false: "not over-subscribed" and "no
 * way to tell" are different answers and a false would read as the reassuring one.
 */
export function buildSeats({ agents = [], presets = [], declarations = {}, keyId = 'dev', secret = '' } = {}) {
  const presetById = new Map(presets.map((p) => [p.id, p]));
  const seats = new Map();

  for (const agent of agents) {
    const id = seatIdentity(agent, { keyId, secret });
    if (!seats.has(id.seatId)) {
      const declared = declarations[id.seatId] ?? {};
      seats.set(id.seatId, {
        ...id,
        planLabel: declared.planLabel ?? null,
        quotaTokens: num(declared.quotaTokens),
        period: declared.period ?? null,
        declaredBy: declared.declaredBy ?? null,
        declaredAt: declared.declaredAt ?? null,
        members: [],
        declaredTokens: 0,
        // How many members promise nothing, which is why declaredTokens can be
        // lower than the number of agents implies.
        membersWithoutCeiling: 0,
      });
    }
    const seat = seats.get(id.seatId);
    const preset = agent.presetId ? presetById.get(agent.presetId) : null;
    const ceiling = num(preset?.ceiling?.tokens);
    seat.members.push({
      agent: agent.name,
      presetId: agent.presetId ?? null,
      model: agent.runtimeProfile?.primary?.model ?? null,
      ceilingTokens: ceiling,
    });
    if (ceiling === null) seat.membersWithoutCeiling += 1;
    else seat.declaredTokens += ceiling;
  }

  return [...seats.values()].map((s) => ({
    ...s,
    overSubscribed: s.quotaTokens === null ? null : s.declaredTokens > s.quotaTokens,
    // Only computable with a quota. Null, never 0.
    headroomTokens: s.quotaTokens === null ? null : s.quotaTokens - s.declaredTokens,
    /*
     * Nothing enforces any of this. Stated on every seat rather than once in a
     * doc, because a caller that treats declaredTokens as a guard rail will
     * over-promise and only find out from an exhausted plan.
     */
    enforced: false,
  }));
}

/** Normalize an operator's seat declaration. Unknown fields are dropped. */
export function normalizeDeclaration(input = {}) {
  const period = ['daily', 'monthly'].includes(input.period) ? input.period : null;
  const quotaTokens = num(input.quotaTokens);
  const planLabel = typeof input.planLabel === 'string' ? input.planLabel.trim().slice(0, 128) || null : null;
  if (quotaTokens === null && planLabel === null && period === null) return null;
  return { planLabel, quotaTokens, period };
}
