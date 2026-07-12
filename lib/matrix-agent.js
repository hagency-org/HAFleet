// matrix-Agent capability model — agent pooling + capability scheduling + the role matrix that
// "mimics a traditional org" (the OpenFab S8 vision). Pure, side-effect-free helpers: the data
// model and the scheduling decisions. Wiring into the HTTP backend (GET /api/pool, POST
// /api/dispatch) and auto-provisioning are built on top of these.
//
// The execution layer is "driven" by OpenFab: OpenFab asks for "a <role> agent at <capability>",
// and the scheduler picks/queues one. OpenFab signs whatever bytes come back and records the
// agent's identity (name · model family · tier) in the AI-BOM.

// Three capability tiers (rows of the matrix) → runtime/model + cost-latency profile.
export const CAPABILITY_TIERS = ['strong', 'medium', 'lightweight'];

// Six roles (columns) that mimic a traditional software org.
export const ROLES = ['architect', 'coding', 'testing', 'review', 'integration', 'documentation'];

// Default tier each role is staffed at (overridable per task).
export const ROLE_DEFAULT_TIER = {
  architect: 'strong',
  review: 'strong',
  coding: 'medium',
  testing: 'medium',
  integration: 'medium',
  documentation: 'lightweight',
};

// Tier → how to launch it (runtime + model). Cross-model review = staff `review` from two
// different model families at `strong`.
export const TIER_RUNTIME = {
  strong: { runtime: 'claude', model: 'opus' },
  medium: { runtime: 'claude', model: 'sonnet' },
  lightweight: { runtime: 'claude', model: 'haiku' },
};

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
export function agentCapability(agent = {}) {
  if (agent.capability && CAPABILITY_TIERS.includes(agent.capability)) return agent.capability;
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
