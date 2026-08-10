/*
 * Every derivation the console makes, as a factory over its input data.
 *
 * WHY A FACTORY. The console now has two data sources — the live backend and the
 * fixture — and the derivations are where its actual claims live: which agent
 * fills which role, what is committed against a ceiling, whether approving a
 * request would over-commit. Binding those to one source and reimplementing them
 * for the other would let the two drift, and the fixture is what the assertion
 * suite checks. So there is one implementation, called twice with different data.
 *
 * Pure formatters (fmtTokens, fmtSpanSec) are NOT here: they take a number and
 * return a string, so they have no data to close over and live in mock-data.js
 * where every caller already imports them.
 */

const TIER_RANK = { lightweight: 0, medium: 1, strong: 2 };

export function makeDerive(data) {
  const {
    roleCapacity, agents = [], presets = [], offers = [], whitelist = [],
    engagements = [], alerts = [], frameworks = [],
  } = data;

  const TIERS = roleCapacity.tiers;
  const ROLE_KEYS = Object.keys(roleCapacity.roles);
  const ALERT_STATUSES = ['open', 'acknowledged', 'assigned', 'resolved', 'suppressed'];
  const SEVERITIES = ['critical', 'warning', 'info'];

  const presetOf = (agent) => presets.find((p) => p.id === agent?.presetId) ?? null;

  /**
   * The entry in the real enumeration this preset matches, or null.
   *
   * Matches on (framework, model, reasoning) — reasoning is NOT optional. The same
   * model string can appear at several tiers with only the thinking level telling
   * them apart: `gpt-5.6-sol` is `strong` at high, `medium` at medium and
   * `lightweight` at low. Matching on (framework, model) alone silently promoted a
   * medium-thinking Codex agent to `strong`, which would have advertised an
   * architect the contributor never configured.
   *
   * An entry with no `reasoning` accepts any, so Claude and Octos are unaffected.
   */
  function acceptEntry(preset) {
    for (const tier of TIERS) {
      const hit = (roleCapacity.tierAccepts[tier] ?? []).find((c) => (
        c.framework === preset.framework
        && c.model === preset.model
        && (c.reasoning === undefined || c.reasoning === preset.reasoning)
      ));
      if (hit) return { ...hit, tier };
    }
    return null;
  }

  const tierOf = (preset) => (preset ? (acceptEntry(preset)?.tier ?? null) : null);
  const familyOf = (preset) => (preset ? (acceptEntry(preset)?.family ?? null) : null);

  /**
   * Can this agent fill this role?
   *
   * Tier subsumption is inherited from lib/matrix-agent.js — strong ⊇ medium ⊇
   * lightweight — so an Opus agent fills every role and pays Opus rates to write
   * documentation. That trade belongs to the contributor, so `overTier` reports it
   * rather than the check refusing it.
   */
  function fills(agent, roleKey) {
    const preset = presetOf(agent);
    const role = roleCapacity.roles[roleKey];
    if (!preset) return { ok: false, why: 'cap.why.noModel' };
    const tier = tierOf(preset);
    if (!tier) return { ok: false, why: 'cap.why.notAccepted' };
    if (TIER_RANK[tier] < TIER_RANK[role.defaultTier]) {
      return { ok: false, why: 'cap.why.belowTier', tier, need: role.defaultTier };
    }
    return {
      ok: true, tier, family: familyOf(preset),
      overTier: TIER_RANK[tier] - TIER_RANK[role.defaultTier],
    };
  }

  /** One entry per role: who can fill it, and what the shortfall is when nobody can. */
  function capability() {
    return ROLE_KEYS.map((key) => {
      const role = roleCapacity.roles[key];
      const rows = agents.map((a) => ({ agent: a, match: fills(a, key) }));
      const able = rows.filter((r) => r.match.ok);
      const families = [...new Set(able.map((r) => r.match.family))].sort();
      return {
        key,
        role,
        able,
        unable: rows.filter((r) => !r.match.ok),
        families,
        // lib/matrix-agent.js:26 — review must be staffed from two different model
        // families, so one family cannot cover both sides however many agents it has.
        crossFamilyOk: role.crossFamily ? families.length >= 2 : true,
        overTier: able.filter((r) => r.match.overTier > 0),
        excluded: (roleCapacity.excluded ?? []).filter((e) => e.role === key),
        offer: offers.find((o) => o.role === key) ?? null,
      };
    });
  }

  /** Model choices per framework, from the real config file's enumeration. */
  function modelsFor(framework) {
    const out = [];
    for (const tier of TIERS) {
      for (const c of roleCapacity.tierAccepts[tier] ?? []) {
        if (c.framework !== framework) continue;
        out.push({ ...c, tier });
      }
    }
    return out;
  }

  const isWhitelisted = (roomId) => whitelist.some((w) => w.projectRoomId === roomId);

  /**
   * Tokens already committed against ONE agent's ceiling.
   *
   * This is the per-agent constraint: an engagement draws on one agent's ceiling,
   * so two projects wanting an architect served by the same Opus agent share that
   * 5M. Over-commitment is therefore computed per agent, and the approval form has
   * to name which agent would serve the role BEFORE the decision.
   */
  function committed(agentName) {
    return engagements
      .filter((e) => e.agent === agentName && e.state === 'active')
      .reduce((n, e) => n + (e.allocatedTokens ?? 0), 0);
  }

  function remaining(agentName) {
    const preset = presetOf(agents.find((a) => a.name === agentName));
    // No preset, or a preset with no ceiling: both are "unknown", not "zero". A
    // ceiling is absent until the backend can store one, and a caller that reads
    // 0 here would render a full agent as exhausted.
    if (!preset?.ceiling) return null;
    return Math.max(0, preset.ceiling.tokens - committed(agentName));
  }

  /** Would approving this request over-commit the agent behind it? */
  function overCommits(engagement) {
    const left = remaining(engagement.agent);
    if (left === null) return null;
    return engagement.requestedTokens > left;
  }

  function alertCounts() {
    const byStatus = Object.fromEntries(ALERT_STATUSES.map((s) => [s, 0]));
    for (const a of alerts) if (byStatus[a.status] !== undefined) byStatus[a.status] += 1;
    // Severity counts the OPEN set only: mixing statuses with a severity in one
    // strip encodes two dimensions as if they were one.
    const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
    for (const a of alerts) {
      if (a.status === 'open' && bySeverity[a.severity] !== undefined) bySeverity[a.severity] += 1;
    }
    return { byStatus, bySeverity };
  }

  const pendingEngagements = () => engagements.filter((e) => e.state === 'pending');
  const activeEngagements = () => engagements.filter((e) => e.state === 'active');
  const endedEngagements = () => engagements.filter((e) => e.state === 'ended');

  function railCounts() {
    const { byStatus } = alertCounts();
    const cap = capability();
    return {
      agentsConfigured: agents.filter((a) => a.presetId).length,
      rolesOffered: offers.filter((o) => o.published).length,
      rolesFillable: cap.filter((c) => c.able.length > 0 && c.crossFamilyOk).length,
      pending: pendingEngagements().length,
      active: activeEngagements().length,
      alertsOpen: byStatus.open,
      whitelisted: whitelist.length,
    };
  }

  /*
   * Whether a model can be selected at all, per framework.
   *
   * Derived from the manifests when they are available, hardcoded only as a
   * fallback. The manifests already record this — `codex-acp` accepts --model and
   * silently ignores it, `hermes-acp` dies on it — so reading it from
   * GET /api/frameworks means the wizard cannot drift from the adapter it is
   * describing. Offering a choice the adapter will not honour is worse than
   * saying so.
   */
  const MODEL_SELECTABLE = (() => {
    const fallback = {
      claude: { ok: true },
      codex: { ok: true },
      octos: { ok: true },
      'codex-acp': { ok: false, why: 'wz.model.ignored' },
      hermes: { ok: false, why: 'wz.model.fatal' },
    };
    if (!frameworks.length) return fallback;
    const out = {};
    for (const f of frameworks) {
      const note = f.acpModelFlagNote || '';
      // The manifest states the failure mode in prose; the console needs which of
      // the two it is. "ignores"/"ignored" is the silent case, a FATAL note is the
      // other. Anything else with no note takes the flag normally.
      if (/ignore/i.test(note)) out[f.id] = { ok: false, why: 'wz.model.ignored', note };
      else if (/fatal|unrecognized|error/i.test(note)) out[f.id] = { ok: false, why: 'wz.model.fatal', note };
      else out[f.id] = { ok: true, note: note || null };
    }
    return { ...fallback, ...out };
  })();

  const FRAMEWORKS = frameworks.length
    ? frameworks.map((f) => f.id)
    : [...new Set(TIERS.flatMap((t) => (roleCapacity.tierAccepts[t] ?? []).map((c) => c.framework)))];

  return {
    ROLE_KEYS, TIERS, ALERT_STATUSES, SEVERITIES,
    presetOf, tierOf, familyOf, fills, capability, modelsFor,
    isWhitelisted, committed, remaining, overCommits,
    pendingEngagements, activeEngagements, endedEngagements,
    alertCounts, railCounts,
    MODEL_SELECTABLE, FRAMEWORKS,
  };
}
