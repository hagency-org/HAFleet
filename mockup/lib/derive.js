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
    // The three slices the workforce roster joins on top of the four layers
    // above. All default to empty, because a slice whose endpoint did not answer
    // must produce a stated absence rather than a number.
    usageLive = [], seats = [], contributions = [],
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
    /*
     * THE BACKEND'S FIGURE WINS. It is the one the decision uses.
     *
     * `remainingFor` in backend-v2 is `ceiling - max(committed, measuredSpend)`. This
     * function computed `ceiling - committed`, which agreed exactly as long as spend was
     * always null — and diverged the moment metering started working: the page advertised
     * 9.8M of headroom on an agent whose approvals would be refused above 9.0M. A number a
     * contributor acts on has to be the number the approval path acts on.
     *
     * The local computation stays as the FALLBACK, for the fixture case and for a
     * deployment whose /usage call failed: it is the right answer whenever nothing has been
     * measured, which is precisely when the two agree anyway.
     */
    const live = usageLive.find((r) => r.agent === agentName);
    if (live && typeof live.remainingTokens === 'number') return live.remainingTokens;

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

  /*
   * The capability rows this console is entitled to trust, and why the roster has
   * to make the same choice components/Data.jsx makes for `capability()`.
   *
   * When GET /api/capability answered, the SERVER's judgement wins: that is where
   * role-capacity.json is authoritative and where a project-side caller would read
   * it. If the roster recomputed locally instead, /workforce and /capability could
   * disagree about whether an agent fills Reviewer — two answers to one question,
   * which is the drift this factory exists to prevent.
   */
  const capabilityRows = () => data.capabilityRows ?? capability();

  /**
   * ONE ROW PER AGENT, joining all four layers — the workforce roster.
   *
   * It lives here rather than in the page because it is a set of claims, not a
   * layout: which roles an agent can be asked for, who it is currently lent to,
   * whether the access record agrees with the allocation, what it consumed, and
   * which seat that consumption lands on. The fixture and the live backend must
   * make those claims identically, so there is one implementation.
   *
   * What it deliberately does NOT join: pending requests. A request is queue
   * content and belongs to /engagements; folding it into a per-agent roster is how
   * a resource console starts looking like a dispatcher.
   *
   * Every field that can be absent is absent as a distinguishable state rather
   * than a zero — `lent: []` with a live engagement store means "nobody is
   * borrowing it", and that is a different fact from a store that did not answer,
   * which the page reads off `provenance` rather than guessing from an empty list.
   */
  function workforce() {
    const rows = capabilityRows();
    const usageByAgent = new Map(usageLive.map((r) => [r.agent, r]));
    const seatOf = new Map();
    for (const s of seats) for (const m of s.members ?? []) seatOf.set(m.agent, s);

    return agents.map((a) => {
      const preset = presetOf(a);

      /*
       * L2 — what a borrower may ask for. Roles, never the agent behind them: the
       * mapping is the contributor's private business, and this column is the only
       * per-agent view of the catalogue (which is organised per role).
       */
      const roles = rows.flatMap((c) => {
        const hit = c.able.find((x) => x.agent?.name === a.name);
        if (!hit) return [];
        return [{
          key: c.key,
          displayName: c.role.displayName,
          tier: hit.match.tier,
          overTier: hit.match.overTier ?? 0,
        }];
      });

      /*
       * Why it can be asked for nothing — read off the same rows rather than
       * recomputed, so the answer cannot disagree with the catalogue.
       *
       * Three reasons, three different actions: no model was ever chosen
       * (configure one), the model is not in the shipped enumeration at all
       * (nothing to do but change it), or it is real but below every role's floor
       * (acquire capacity). Collapsing them into "not eligible" would leave a
       * contributor with no next step.
       */
      const whys = rows
        .map((c) => c.unable.find((x) => x.agent?.name === a.name)?.match?.why)
        .filter(Boolean);
      const noRoleWhy = roles.length > 0 ? null
        : whys.includes('cap.why.noModel') ? 'cap.why.noModel'
          : whys.includes('cap.why.notAccepted') ? 'cap.why.notAccepted'
            : whys.length > 0 ? 'cap.why.belowTier'
              : 'wf.why.notInCatalogue';

      /*
       * L3 — who is borrowing it, and whether they can actually reach it.
       *
       * Two records answer this and they are kept apart on purpose. An ENGAGEMENT
       * is the allocation I approved; a CONTRIBUTION binding is the
       * (agent, project, room, owner) tuple that lets the project reach the agent
       * at all. They normally agree. When they do not, both directions matter and
       * neither is visible anywhere else in the console:
       *
       *  - an allocation with no binding is capacity a project was promised and
       *    cannot use (backend-v2.js:10736 records exactly this having happened);
       *  - a binding with no active engagement is standing access outliving the
       *    engagement that justified it, which for a resource contributor is the
       *    security-relevant half.
       */
      const lent = engagements.filter((e) => e.agent === a.name && e.state === 'active');
      const bindings = contributions.filter((c) => c.agent === a.name && c.active !== false);
      const boundRooms = new Set(bindings.map((b) => b.projectRoomId));
      const lentRooms = new Set(lent.map((e) => e.projectRoomId));
      const unreachable = lent.filter((e) => !boundRooms.has(e.projectRoomId));
      const standing = bindings.filter((b) => !lentRooms.has(b.projectRoomId));

      /*
       * L4 — consumption, which is measured for some frameworks and not others.
       *
       * Passed through as the endpoint reports it, including `reason`: the reason
       * differs per agent (no workspace recorded / this framework's session files
       * carry no usage / no transcript location verified for this adapter), so it
       * belongs in the cell rather than being generalised into one page-level note.
       */
      const u = usageByAgent.get(a.name) ?? null;
      const tokens = u ? {
        used: u.tokensUsed ?? null,
        /*
         * The ceiling-drawing part, carried alongside the total. The roster led with
         * `tokensUsed` — all four kinds — so an agent that had added 1.3M of fresh tokens
         * displayed 29.6M beside a 10.0M ceiling. The usage page was fixed for exactly this and
         * this row was missed.
         */
        drawn: u.tokensDrawn ?? null,
        byKind: u.tokensByKind ?? null,
        sessions: u.tokensSessions ?? null,
        // A figure that includes sessions whose transcript is gone, and a source
        // that reported less than it had before. Both are caveats on a number that
        // otherwise looks exact.
        fromLedger: u.tokensFromLedger === true,
        regressions: Number(u.tokensSourceRegressions) || 0,
        reason: u.tokensReason ?? null,
      } : null;

      return {
        agent: a,
        preset,
        tier: tierOf(preset),
        family: familyOf(preset),
        roles,
        noRoleWhy,
        overTier: roles.filter((r) => r.overTier > 0).length,
        lent,
        bindings,
        unreachable,
        standing,
        tokens,
        /*
         * NO TASK COUNT, deliberately, though the usage row carries one.
         *
         * Tasks are the closest thing left to R12's withdrawn "work item" column,
         * and a workforce roster is exactly where that would creep back in. What a
         * borrowed agent is busy WITH is the borrower's business; that it is busy is
         * the contributor's. /usage keeps the task measurement, where it reads as
         * activity rather than as an assignment.
         */
        ceiling: preset?.ceiling ?? null,
        // Known: what I promised. Kept strictly apart from `tokens`, which is what
        // was spent — ADR-013 §6.
        promised: committed(a.name),
        left: remaining(a.name),
        // The accounting root under the ceiling. A per-agent ceiling is a
        // sub-allocation of a seat, so a roster showing one without naming the
        // other repeats the error the seats table exists to correct.
        seat: seatOf.get(a.name) ?? null,
      };
    });
  }

  function railCounts() {
    const { byStatus } = alertCounts();
    const cap = capability();
    return {
      agentsConfigured: agents.filter((a) => a.presetId).length,
      rolesOffered: offers.filter((o) => o.published).length,
      rolesFillable: cap.filter((c) => c.able.length > 0 && c.crossFamilyOk).length,
      pending: pendingEngagements().length,
      active: activeEngagements().length,
      // AGENTS lent, not engagements: the rail row beside it already counts
      // engagements, and one agent serving three projects is one agent lent out.
      lent: new Set(activeEngagements().map((e) => e.agent)).size,
      alertsOpen: byStatus.open,
      whitelisted: whitelist.length,
      /*
       * Invitations awaiting my decision (ADR-014). Counted from the slice rather than
       * derived, because there is nothing to derive: an invitation either arrived or it did
       * not, and a slice that failed to answer contributes 0 here while the page itself says
       * "not known" — the rail is a badge, and a badge cannot carry that distinction.
       */
      invitesPending: (data.invites ?? []).filter((i) => i?.state === 'pending' || !i?.state).length,
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
    alertCounts, railCounts, workforce,
    MODEL_SELECTABLE, FRAMEWORKS,
  };
}
