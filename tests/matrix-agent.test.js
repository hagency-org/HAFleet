import { describe, it, expect } from 'vitest';
import {
  resolveTier,
  canonicalRole,
  agentRole,
  agentCapability,
  indexPool,
  selectAgent,
  planDispatch,
  modelTier,
  modelFamily,
  isCanonicalRole,
  ROLE_DEFAULT_TIER,
  ROLES,
  CAPABILITY_TIERS,
  TIER_RUNTIME,
} from '../lib/matrix-agent.js';
import { ROLES as PROVISION_ROLES } from '../scripts/provision-team.mjs';
import roleCapacity from '../lib/role-capacity.json' with { type: 'json' };

describe('matrix-agent capability model', () => {
  it('resolves the tier: explicit request wins, else the role default', () => {
    expect(resolveTier('coding', 'strong')).toBe('strong');
    expect(resolveTier('coding')).toBe(ROLE_DEFAULT_TIER.coding); // medium
    expect(resolveTier('architect')).toBe('strong');
    expect(resolveTier('documentation')).toBe('lightweight');
    expect(resolveTier('coding', 'bogus')).toBe('medium'); // bad request → default
  });

  it('infers a canonical role from legacy <team>_<role> names', () => {
    expect(canonicalRole('wf_coordinator')).toBe('architect');
    expect(canonicalRole('wf_implementer')).toBe('coding');
    expect(canonicalRole('wf_reviewer')).toBe('review');
    expect(canonicalRole('wf_final_reviewer')).toBe('review');
    expect(canonicalRole('alpha_tester')).toBe('testing');
    expect(canonicalRole('mystery')).toBeNull();
  });

  it('defaults capability from the (possibly inferred) role', () => {
    expect(agentCapability({ name: 'wf_coordinator' })).toBe('strong'); // architect
    expect(agentCapability({ name: 'wf_implementer' })).toBe('medium'); // coding
    expect(agentCapability({ name: 'x', role: 'coding', capability: 'strong' })).toBe('strong');
  });

  it('indexes a flat agent list into a role×capability grid', () => {
    const grid = indexPool([
      { name: 'wf_coordinator', online: true },
      { name: 'wf_implementer', online: true },
      { name: 'wf_reviewer', online: true },
    ]);
    expect(Object.keys(grid).sort()).toEqual(['architect', 'coding', 'review']);
    expect(grid.coding.medium).toHaveLength(1);
  });

  it('selects an idle agent at the right tier; over-qualified is allowed, busy/offline excluded', () => {
    const agents = [
      { name: 'wf_implementer', role: 'coding', capability: 'medium', online: true },
      { name: 'wf_implementer2', role: 'coding', capability: 'medium', online: true, busy: true },
    ];
    expect(selectAgent(agents, 'coding', 'medium').name).toBe('wf_implementer'); // idle one
    // a strong agent can stand in for medium work
    const strong = [{ name: 'arch', role: 'architect', capability: 'strong', online: true }];
    expect(selectAgent(strong, 'architect', 'medium')?.name).toBe('arch');
    // none online → null (caller provisions)
    expect(selectAgent([{ name: 'c', role: 'coding', online: false }], 'coding', 'medium')).toBeNull();
  });

  it('plans dispatch: route when staffed, provision when the pool is empty', () => {
    const agents = [{ name: 'wf_implementer', role: 'coding', capability: 'medium', online: true }];
    expect(planDispatch(agents, 'coding', 'medium')).toMatchObject({ action: 'route', agent: 'wf_implementer' });
    const plan = planDispatch([], 'testing', 'medium');
    expect(plan.action).toBe('provision');
    expect(plan.runtime).toBeTruthy();
  });
});

/*
 * The model-derived tier, and the vocabulary's single source.
 *
 * These exist because the capability model previously answered "how strong is this
 * agent" without ever consulting the model the agent runs: tier came from the role,
 * and the role — when unset — from substrings in the agent's NAME. An agent called
 * `wf_coordinator` was therefore offered as a strong architect whatever it was
 * actually configured with, and an agent with no model at all was offered as
 * medium. Both are claims about someone else's money.
 */
describe('tier derived from the resolved model', () => {
  const profile = (framework, model, reasoning = null) => ({ primary: { framework, model, reasoning } });

  it('reads the tier from role-capacity.json rather than from the role or the name', () => {
    expect(modelTier(profile('claude', 'claude-opus-5'))).toBe('strong');
    expect(modelTier(profile('claude', 'claude-sonnet-5'))).toBe('medium');
    expect(modelTier(profile('claude', 'claude-fable-5'))).toBe('lightweight');
    expect(modelTier(profile('octos', 'kimi-k3'))).toBe('strong');
  });

  it('B8: claude-fable-5-1 — the model this machine actually runs — is strong, and staffs coding', () => {
    /*
     * B8: `tierAccepts` matched framework+model exactly, so the locally-deployed
     * `claude-fable-5-1` resolved to tier null and NO agent was eligible for any
     * strong role — the pool answered "unstaffable" while a strong agent sat idle.
     * NB the naming family: `claude-fable-5` (no minor) stays LIGHTWEIGHT — the
     * minor version -5-1 is the strong-capable one this deployment runs; adding
     * the bare fable-5 to strong would have promoted every fable-5 pool.
     */
    expect(modelTier(profile('claude', 'claude-fable-5-1'))).toBe('strong');
    expect(modelTier(profile('claude', 'claude-fable-5'))).toBe('lightweight');
    // and a pool whose ONLY agent runs fable-5-1 can staff a strong coding role:
    const pool = [{ name: 'fable_runner', role: 'coding', runtimeProfile: profile('claude', 'claude-fable-5-1'), online: true }];
    expect(selectAgent(pool, 'coding', 'strong')?.name).toBe('fable_runner');
    expect(agentCapability(pool[0])).toBe('strong');
  });

  it('separates the three reasoning levels of one model string', () => {
    // The case a (framework, model) match cannot express: the same id at three
    // tiers, told apart only by the thinking level.
    expect(modelTier(profile('codex', 'gpt-5.6-sol', 'high'))).toBe('strong');
    expect(modelTier(profile('codex', 'gpt-5.6-sol', 'medium'))).toBe('medium');
    expect(modelTier(profile('codex', 'gpt-5.6-sol', 'low'))).toBe('lightweight');
  });

  it('returns null for a model nothing accepts, and for no model at all', () => {
    expect(modelTier(profile('claude', 'not-a-model'))).toBeNull();
    expect(modelTier(profile('codex', 'gpt-5.6-sol', 'nonsense'))).toBeNull();
    expect(modelTier(null)).toBeNull();
    expect(modelTier({ primary: {} })).toBeNull();
  });

  it('the model outranks a role guessed from the agent name', () => {
    // Named like an architect, configured with a lightweight model. Before the
    // model was consulted this returned 'strong'.
    const agent = { name: 'wf_coordinator', runtimeProfile: profile('claude', 'claude-fable-5') };
    expect(agentRole(agent)).toBe('architect');
    expect(agentCapability(agent)).toBe('lightweight');
  });

  it('an explicit capability still outranks the model', () => {
    const agent = {
      name: 'x', role: 'coding', capability: 'strong',
      runtimeProfile: profile('claude', 'claude-fable-5'),
    };
    expect(agentCapability(agent)).toBe('strong');
  });

  it('an agent with no profile keeps the legacy name-derived default', () => {
    // The documented compatibility path: pre-existing <team>_<role> agents slot in
    // without re-registration, and nothing about that changed.
    expect(agentCapability({ name: 'wf_coordinator' })).toBe('strong');
    expect(agentCapability({ name: 'wf_implementer' })).toBe('medium');
  });

  it('the model family is reported alongside the tier', () => {
    expect(modelFamily(profile('claude', 'claude-opus-5'))).toBeTruthy();
    expect(modelFamily(profile('octos', 'kimi-k3'))).not.toBe(modelFamily(profile('claude', 'claude-opus-5')));
    expect(modelFamily(profile('claude', 'not-a-model'))).toBeNull();
  });
});

describe('the role vocabulary has one source', () => {
  it('ROLES and ROLE_DEFAULT_TIER come from role-capacity.json', () => {
    expect(ROLES).toEqual(Object.keys(roleCapacity.roles));
    for (const [key, def] of Object.entries(roleCapacity.roles)) {
      expect(ROLE_DEFAULT_TIER[key]).toBe(def.defaultTier);
    }
    expect(CAPABILITY_TIERS).toEqual(roleCapacity.tiers);
  });

  it('every tier in tierAccepts is a declared tier, and every excluded role a declared role', () => {
    for (const tier of Object.keys(roleCapacity.tierAccepts)) {
      expect(CAPABILITY_TIERS).toContain(tier);
    }
    for (const e of roleCapacity.excluded ?? []) {
      expect(isCanonicalRole(e.role)).toBe(true);
    }
  });

  it('TIER_RUNTIME model ids are ones role-capacity.json actually accepts', () => {
    // The join that did not exist: TIER_RUNTIME used short names ('opus') while the
    // enumeration used full ids ('claude-opus-5'), so the provisioning table and
    // the qualification table could not be compared at all.
    for (const [tier, rt] of Object.entries(TIER_RUNTIME)) {
      const accepted = (roleCapacity.tierAccepts[tier] ?? [])
        .filter((c) => c.framework === rt.runtime)
        .map((c) => c.model);
      expect(accepted).toContain(rt.model);
    }
  });

  it('provision-team\'s legacy suffixes map to the canonical roles it declares', () => {
    // Binds the two vocabularies: the workflow names that become agent-name
    // suffixes, and the six capability roles canonicalRole() files them under.
    for (const { role, canonical } of PROVISION_ROLES) {
      expect(isCanonicalRole(canonical)).toBe(true);
      expect(canonicalRole(`team_${role}`)).toBe(canonical);
    }
  });
});

describe('provider is part of the match, but only when stated', () => {
  const p = (o) => ({ primary: o });

  it('rejects a provider that contradicts the accepted combination', () => {
    // Not compared at all before, so kimi-k3 under any provider qualified as strong
    // on the Moonshot entry.
    expect(modelTier(p({ framework: 'octos', provider: 'not-moonshot', model: 'kimi-k3' }))).toBeNull();
    expect(modelTier(p({ framework: 'claude', provider: 'openai', model: 'claude-opus-5' }))).toBeNull();
  });

  it('accepts the provider the combination declares', () => {
    expect(modelTier(p({ framework: 'octos', provider: 'moonshot', model: 'kimi-k3' }))).toBe('strong');
    expect(modelTier(p({ framework: 'claude', provider: 'anthropic', model: 'claude-opus-5' }))).toBe('strong');
  });

  it('treats an ABSENT provider as unknown, not as wrong', () => {
    // normalizeRuntimeProfileRole permits a null provider, and a real agent whose
    // profile omits it must not silently qualify for nothing.
    expect(modelTier(p({ framework: 'claude', model: 'claude-opus-5' }))).toBe('strong');
    expect(modelTier(p({ framework: 'codex', model: 'gpt-5.6-sol', reasoning: 'high' }))).toBe('strong');
  });
});
