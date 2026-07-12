import { describe, it, expect } from 'vitest';
import {
  resolveTier,
  canonicalRole,
  agentCapability,
  indexPool,
  selectAgent,
  planDispatch,
  ROLE_DEFAULT_TIER,
} from '../lib/matrix-agent.js';

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
