// matrix-Agent capability model — agent pooling + capability scheduling + the role matrix that
// "mimics a traditional org" (the OpenFab S8 vision). Pure, side-effect-free helpers: the data
// model and the scheduling decisions. Wiring into the HTTP backend (GET /api/pool, POST
// /api/dispatch) and auto-provisioning are built on top of these.
//
// The execution layer is "driven" by OpenFab: OpenFab asks for "a <role> agent at <capability>",
// and the scheduler picks/queues one. OpenFab signs whatever bytes come back and records the
// agent's identity (name · model family · tier) in the AI-BOM.

// The role vocabulary now has ONE source: role-capacity.json. Until this import
// existed the same six roles were written out as a literal in three places
// (here, lib/dashboard/render/pool-page.js, and the JSON), plus a fourth set of
// four legacy names in scripts/provision-team.mjs — and the copy here was
// exported but read by nothing, so a divergence between any two of them could not
// fail anything. The JSON additionally carries what no copy did: which
// (framework, model, reasoning) combinations qualify at each tier.
import roleCapacity from './role-capacity.json' with { type: 'json' };

// Three capability tiers (rows of the matrix) → runtime/model + cost-latency profile.
export const CAPABILITY_TIERS = roleCapacity.tiers;

// Six roles (columns) that mimic a traditional software org.
export const ROLES = Object.keys(roleCapacity.roles);

// Default tier each role is staffed at (overridable per task).
export const ROLE_DEFAULT_TIER = Object.fromEntries(
  Object.entries(roleCapacity.roles).map(([k, r]) => [k, r.defaultTier]),
);

/*
 * Tier → how to launch it (runtime + model). Cross-model review = staff `review`
 * from two different model families at `strong`.
 *
 * Model ids are the FULL ones (`claude-opus-5`, not `opus`) so this table joins to
 * role-capacity.json and to what `--model` actually takes. The short names could
 * not express the case that matters: `gpt-5.6-sol` appears at all three tiers and
 * is separated only by its reasoning level, which a bare model name cannot carry.
 */
export const TIER_RUNTIME = {
  strong: { runtime: 'claude', model: 'claude-opus-5' },
  medium: { runtime: 'claude', model: 'claude-sonnet-5' },
  lightweight: { runtime: 'claude', model: 'claude-haiku-4-5' },
};

/** Is this a role the vocabulary actually defines? */
export function isCanonicalRole(role) {
  return typeof role === 'string' && ROLES.includes(role);
}

/**
 * The tier an agent's RESOLVED MODEL qualifies for, or null.
 *
 * This is the fact the capability model was missing. Tier was previously derived
 * from the agent's role — and the role, when unset, from substrings in the agent's
 * NAME — so an agent called `wf_coordinator` was offered as a `strong` architect
 * regardless of what model it actually runs, and an agent with no model at all was
 * offered as `medium`.
 *
 * `reasoning` is part of the match and is not optional: the same model string sits
 * at three tiers with only the thinking level telling them apart, so matching on
 * (framework, model) alone silently promotes a medium-thinking Codex agent to
 * strong. An entry with no `reasoning` accepts any.
 */
export function modelTier(runtimeProfile) {
  const p = runtimeProfile?.primary;
  if (!p?.model) return null;
  for (const tier of CAPABILITY_TIERS) {
    const hit = (roleCapacity.tierAccepts[tier] ?? []).find((c) => (
      c.framework === p.framework
      && c.model === p.model
      /*
       * `provider` was not compared at all, so
       * `{framework:'octos', provider:'not-moonshot', model:'kimi-k3'}` qualified as
       * strong on the Moonshot entry.
       *
       * Compared only when BOTH sides state one. An absent provider on the profile is
       * UNKNOWN, not wrong — `normalizeRuntimeProfileRole` permits it, and a real
       * agent whose profile omits it would otherwise qualify for nothing. A STATED
       * provider that contradicts the entry is a genuine mismatch and is rejected.
       */
      && (c.provider === undefined || !p.provider || c.provider === p.provider)
      && (c.reasoning === undefined || c.reasoning === (p.reasoning ?? null))
    ));
    if (hit) return tier;
  }
  return null;
}

/** The model family behind an agent's resolved model, or null. */
export function modelFamily(runtimeProfile) {
  const p = runtimeProfile?.primary;
  if (!p?.model) return null;
  for (const tier of CAPABILITY_TIERS) {
    const hit = (roleCapacity.tierAccepts[tier] ?? []).find((c) => (
      c.framework === p.framework && c.model === p.model
      && (c.provider === undefined || !p.provider || c.provider === p.provider)
      && (c.reasoning === undefined || c.reasoning === (p.reasoning ?? null))
    ));
    if (hit) return hit.family ?? null;
  }
  return null;
}

// A stronger tier can stand in for a weaker one (strong ⊇ medium ⊇ lightweight).
const TIER_RANK = { lightweight: 0, medium: 1, strong: 2 };

/** Resolve the capability tier for a task: explicit request wins, else the role's default. */
export function resolveTier(role, requested) {
  if (requested && CAPABILITY_TIERS.includes(requested)) return requested;
  return ROLE_DEFAULT_TIER[role] || 'medium';
}

/** Map a legacy/free-form agent name to a canonical role (so existing `<team>_<role>` agents
 *  slot into the matrix without re-registration). Returns null if it can't be inferred. */
export function canonicalRole(name = '') {
  const n = String(name).toLowerCase();
  if (n.includes('architect') || n.includes('coordinator')) return 'architect';
  if (n.includes('final_reviewer') || n.includes('final-reviewer')) return 'review';
  if (n.includes('review')) return 'review';
  if (n.includes('test') || n.includes('qa')) return 'testing';
  if (n.includes('integrat')) return 'integration';
  if (n.includes('doc')) return 'documentation';
  if (n.includes('implement') || n.includes('coder') || n.includes('coding')) return 'coding';
  return null;
}

/** The effective (role, capability) of an agent record — explicit fields first, else inferred
 *  from the name; capability defaults to the role's default tier when unset. */
export function agentRole(agent = {}) {
  return agent.role || canonicalRole(agent.name) || null;
}
/*
 * Three sources, in descending order of how much they actually know:
 *
 *   1. an explicit `capability` — an operator's deliberate override;
 *   2. the RESOLVED MODEL, via role-capacity.json — the only source that reflects
 *      what the agent will really run;
 *   3. the role's default tier, where the role may itself have been guessed from
 *      the agent's name.
 *
 * (2) is new, and it is inserted above (3) rather than replacing it. (3) is the
 * documented compatibility path that lets pre-existing `<team>_<role>` agents slot
 * into the matrix without re-registration, and it is what an agent with no runtime
 * profile still falls back to. But once a profile exists, the model decides —
 * otherwise a `wf_coordinator` running Fable is advertised as a strong architect,
 * which is a claim about someone else's money.
 */
export function agentCapability(agent = {}) {
  if (agent.capability && CAPABILITY_TIERS.includes(agent.capability)) return agent.capability;
  const fromModel = modelTier(agent.runtimeProfile);
  if (fromModel) return fromModel;
  const role = agentRole(agent);
  return role ? ROLE_DEFAULT_TIER[role] || 'medium' : 'medium';
}

/** Index a flat agent list into the pool grid: { role: { capability: [agents] } }. */
export function indexPool(agents = []) {
  const grid = {};
  for (const a of agents) {
    const role = agentRole(a);
    if (!role) continue;
    const cap = agentCapability(a);
    ((grid[role] ||= {})[cap] ||= []).push(a);
  }
  return grid;
}

/** Pick an idle agent for (role, tier). Prefers an exact-tier idle agent; otherwise a stronger
 *  idle agent (over-qualified is fine). Returns the agent, or null if the pool can't staff it
 *  (→ the caller queues or auto-provisions). `busy`/`online` are read off the agent record. */
export function selectAgent(agents, role, requestedTier) {
  const tier = resolveTier(role, requestedTier);
  const candidates = agents.filter(
    (a) => agentRole(a) === role && a.online !== false && a.busy !== true,
  );
  const atLeast = (a) => TIER_RANK[agentCapability(a)] >= TIER_RANK[tier];
  const eligible = candidates.filter(atLeast);
  if (!eligible.length) return null;
  // cheapest sufficient tier first (don't waste a strong agent on lightweight work).
  eligible.sort((a, b) => TIER_RANK[agentCapability(a)] - TIER_RANK[agentCapability(b)]);
  return eligible[0];
}

/** A dispatch plan: either route to a chosen agent, or provision one of (role, tier). Pure —
 *  the caller performs the side effect (send task / `up-v1 <name> <runtime>`). */
export function planDispatch(agents, role, requestedTier) {
  const tier = resolveTier(role, requestedTier);
  const agent = selectAgent(agents, role, tier);
  if (agent) return { action: 'route', agent: agent.name, role, tier };
  return { action: 'provision', role, tier, runtime: TIER_RUNTIME[tier] };
}
