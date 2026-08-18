/*
 * The live data source, and the mapping from real payloads to what pages render.
 *
 * PER-SLICE PROVENANCE, NOT A GLOBAL FLAG. Ten slices, all of them live now — but
 * the mechanism stays, because it is what kept the console honest while four of
 * them had no endpoint at all, and because "live" is still not the same as
 * "measured": /usage answers, and the token column inside it is a declared gap.
 * A single "live / mock" flag would let a reader assume a live console shows live
 * numbers everywhere, which is exactly the error this design refuses elsewhere.
 * So every slice reports where it came from, and the UI labels what it cannot fill.
 *
 * Everything is fetched through the same-origin proxy at /api/hafleet/*, never
 * from the backend directly. See app/api/hafleet/[...path]/route.js for why the
 * token must not reach the browser.
 */

import * as fixture from './mock-data.js';

const PROXY = '/api/hafleet';

/** Slices with a real endpoint behind them at this baseline. */
export const LIVE_SLICES = [
  'agents', 'presets', 'frameworks', 'alerts', 'capability', 'seats', 'usage',
  'engagements', 'offers', 'whitelist', 'detected', 'contributions', 'invites',
];
/*
 * Empty now. Every slice this console reads has an endpoint behind it — the four
 * that did not (engagements, offers, whitelist, and the ceiling field) were the
 * build, and they landed. The array stays because the distinction it encodes is
 * the load-bearing one: a slice with no endpoint must never be filled from the
 * fixture and shown beside live data.
 */
export const CONTRACT_SLICES = [];

async function get(path) {
  const res = await fetch(`${PROXY}/${path}`, { headers: { Accept: 'application/json' } });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!res.ok) {
    /*
     * Never quote a non-JSON body back to the user.
     *
     * On a static host there is no proxy, so this path 404s and the response is the
     * host's HTML error page. Slicing 120 characters off that put
     * `<!DOCTYPE HTML> <HTML LANG="EN">…` inside the provenance banner — noise where
     * a reason belongs. The status and a short phrase say strictly more.
     */
    const looksHtml = /^\s*<(?:!doctype|html)/i.test(text);
    const detail = body?.error
      || (looksHtml || !text ? `HTTP ${res.status}` : text.slice(0, 120));
    throw new Error(`${path}: ${detail}`);
  }
  return body;
}

const secsSince = (ms) => (Number(ms) > 0 ? Math.max(0, Math.round((Date.now() - Number(ms)) / 1000)) : 0);

/**
 * A write, through the same proxy allowlist as the reads.
 *
 * Returns `{ ok, error }` rather than throwing: every caller is a click handler
 * that has to render the failure next to the control the user pressed, and an
 * exception there becomes an unhandled rejection and a silently dead button.
 */
export async function send(path, { method = 'POST', body } = {}) {
  try {
    const res = await fetch(`${PROXY}/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep the raw text */ }
    if (!res.ok) return { ok: false, error: parsed?.error || text.slice(0, 160) || `HTTP ${res.status}`, status: res.status };
    return { ok: true, body: parsed };
  } catch (e) {
    return { ok: false, error: e?.message ?? 'request failed' };
  }
}

/**
 * GET /api/agents -> the shape pages already read.
 *
 * `type` is the backend's name for the framework, so it is renamed rather than
 * both being carried: a row showing `type` and `framework` as separate columns
 * would imply two facts where there is one.
 *
 * `alive` collapses three real fields the backend keeps apart (`online`,
 * `agentOnline`, `healthy`). The collapse is deliberate for the roster row, and
 * the per-agent page has the room to show all three.
 */
function mapAgent(a) {
  const rp = a.runtimeProfile?.primary ?? null;
  return {
    name: a.name,
    framework: a.type ?? null,
    transport: a.transport ?? null,
    tmux: a.tmux ?? null,
    activeNow: a.activeNow === true,
    activeDurationSec: Number(a.activeDurationSec) || 0,
    idleDurationSec: Number(a.idleDurationSec) || 0,
    environment: a.environment ?? null,
    alive: a.healthy === true || a.online === true,
    online: a.online === true,
    healthy: a.healthy === true,
    state: a.state ?? null,
    // Tri-state upstream (true / false / null when never observed). Kept as-is:
    // null is "not measured", which is not the same as "absent".
    mcp: a.mcpPresent,
    presetId: a.presetId ?? null,
    // The REAL working directory, because /agents/<name> used to invent one from the agent's name
    // (`~/${name.replace('-agent','')}-ws`) — which for `ops-agent` printed `~/ops-ws`, plausible
    // and entirely fictional. Under `up-v1` the agent runs in its own provisioned home, which is
    // nowhere near that guess.
    workdir: a.workdir ?? null,
    // Carried so a page can show the resolved configuration even when the preset
    // it came from has since been edited or deleted.
    runtimeProfile: rp,
    blocked: a.blocked === true,
    blockedReason: a.blockedReason ?? null,
    offlineReason: a.offlineReason ?? null,
  };
}

/**
 * GET /api/framework-presets -> the console's preset.
 *
 * `ceiling` now round-trips. It did not when this layer was written: the POST
 * handler built its record from a closed field list, so a ceiling sent by a client
 * was accepted with 200 and dropped, and every ceiling cell in the console had to
 * read "no ceiling field upstream". It is passed through rather than defaulted,
 * because a preset saved before the field existed still has none — and that is a
 * real state to render, not one to paper over with a number nobody chose.
 */
function mapPreset(p) {
  return {
    id: p.id,
    name: p.name,
    framework: p.framework ?? null,
    provider: p.provider ?? null,
    model: p.model ?? null,
    reasoning: p.reasoning ?? null,
    extraArgs: p.extraArgs ?? null,
    apiBaseUrl: p.apiBaseUrl ?? null,
    // The backend returns `true` rather than the secret when one is stored.
    apiKeySet: p.apiKey === true,
    ceiling: p.ceiling ?? null,
  };
}

/**
 * GET /api/alerts -> the console's alert, with the fields the fixture dropped.
 *
 * `originalSeverity` and `missingActionableFields` are the important addition.
 * lib/alert-store.js:125-128 downgrades a `warning` or `critical` to `info` when
 * the actionable fields are missing, and a console that renders only `severity`
 * shows `info` with no way to know the system meant `warning`. Both live
 * `agent_offline` alerts on a freshly seeded backend are exactly this case.
 */
function mapAlert(a) {
  return {
    id: a.id,
    severity: a.severity,
    status: a.status,
    summary: a.summary,
    agent: a.sourceAgent ?? null,
    occurrences: Number(a.occurrences) || 1,
    ageSec: secsSince(a.firstSeenAt),
    firstSeenSec: secsSince(a.firstSeenAt),
    lastSeenSec: secsSince(a.lastSeenAt),
    detail: a.detail ?? '',
    notes: (a.notes ?? []).map((n) => ({
      at: n.ts ? `${fixture.fmtSpanSec(secsSince(n.ts))} ago` : null,
      by: n.author ?? 'system',
      text: n.text ?? '',
    })),
    // Was this severity downgraded, and what was missing.
    actionable: a.actionable === true,
    originalSeverity: a.originalSeverity ?? null,
    missingActionableFields: a.missingActionableFields ?? [],
    // The fields whose absence caused the downgrade, when present.
    owner: a.owner ?? null,
    assignee: a.assignee ?? null,
    runbook: a.runbook ?? null,
    impact: a.impact ?? null,
    recoveryCondition: a.recoveryCondition ?? null,
    correlation: a.correlation ?? null,
    alertType: a.alertType ?? null,
    source: a.source ?? null,
    linkedTaskId: a.linkedTaskId ?? null,
    tags: a.tags ?? [],
  };
}

/**
 * GET /api/capability -> the shape the catalogue page already renders.
 *
 * The console used to compute this itself from agents × role-capacity.json. It
 * still can (the fixture path does), but when the endpoint answers, the SERVER's
 * judgement wins — because the server is where the vocabulary is authoritative and
 * where a project-side caller would read it. Two implementations producing two
 * answers for "can I fill Reviewer" is the drift this whole layer exists to avoid,
 * so the live rows are mapped into the derived shape rather than rendered by a
 * second code path.
 *
 * `agentsByName` reattaches the agent records: the endpoint returns names, and the
 * page links to each agent's own route.
 */
function mapCapability(payload, agentsByName) {
  const attach = (name) => agentsByName.get(name) ?? { name };
  return (payload?.roles ?? []).map((r) => ({
    key: r.role,
    role: {
      displayName: r.displayName,
      defaultTier: r.defaultTier,
      crossFamily: r.crossFamily,
    },
    able: r.able.map((x) => ({
      agent: attach(x.agent),
      match: { ok: true, tier: x.tier, family: x.family, overTier: x.overTier },
    })),
    unable: r.unable.map((x) => ({
      agent: attach(x.agent),
      // The console's reason keys, from the endpoint's reason codes. Kept as a
      // mapping rather than sharing strings: the API is a contract for any client,
      // and an i18n key is this console's business.
      match: {
        ok: false,
        why: x.reason === 'no-model' ? 'cap.why.noModel'
          : x.reason === 'below-tier' ? 'cap.why.belowTier'
            : 'cap.why.notAccepted',
        tier: x.tier ?? null,
        need: x.need ?? null,
      },
    })),
    families: r.families,
    crossFamilyOk: r.crossFamilyOk,
    overTier: r.able.filter((x) => x.overTier > 0),
    excluded: r.excluded ?? [],
    // No endpoint publishes an offer, so this stays null here and the page shows
    // the offer section as the contract it is.
    offer: null,
  }));
}

/**
 * Fetch every live slice, tolerating per-slice failure.
 *
 * One dead endpoint must not blank the whole console: a backend that has alerts
 * but no /api/frameworks yet should still show its agents. So each slice records
 * its own outcome and the caller renders what arrived.
 */
export async function fetchLive() {
  const provenance = {};
  const errors = {};
  const out = {};

  const slices = [
    ['agents', 'agents', (d) => (Array.isArray(d) ? d.map(mapAgent) : [])],
    ['presets', 'framework-presets', (d) => (Array.isArray(d) ? d.map(mapPreset) : [])],
    ['frameworks', 'frameworks', (d) => (Array.isArray(d) ? d : [])],
    ['alerts', 'alerts?limit=200', (d) => (Array.isArray(d) ? d.map(mapAlert) : [])],
  ];

  await Promise.all(slices.map(async ([key, path, map]) => {
    try {
      out[key] = map(await get(path));
      provenance[key] = 'live';
    } catch (e) {
      out[key] = fixture[key] ?? [];
      provenance[key] = 'fixture';
      errors[key] = e.message;
    }
  }));

  /*
   * Engagements, offers and the whitelist. Fetched together because the routing
   * reads all three: a request's route depends on whether its room is whitelisted
   * and whether it fits the offer, so a page holding one without the others cannot
   * explain what it is showing.
   */
  await Promise.all([
    (async () => {
      try {
        const payload = await get('engagements');
        out.engagements = (payload?.engagements ?? []).map((e) => ({
          ...e,
          // The console's own vocabulary for a route it can label. `autoJoin` is
          // not a reason a request needs the owner, so it maps to null — the
          // page's RouteReason renders nothing for an auto-joined engagement.
          route: e.route === 'autoJoin' ? null : e.route,
          requestedTokens: e.requestedTokens,
          // The page renders a relative age; the store keeps an epoch. Without
          // this the row printed the literal string "undefined" beside the
          // requester.
          since: e.createdAt ? fixture.fmtSpanSec(secsSince(e.createdAt)) : null,
          endedReason: e.endedReason ?? null,
        }));
        provenance.engagements = 'live';
      } catch (e) {
        out.engagements = [];
        provenance.engagements = 'absent';
        errors.engagements = e.message;
      }
    })(),
    (async () => {
      try {
        out.offers = (await get('offers'))?.offers ?? [];
        provenance.offers = 'live';
      } catch (e) {
        out.offers = [];
        provenance.offers = 'absent';
        errors.offers = e.message;
      }
    })(),
    /*
     * The contribution binding — the record that actually lets a project reach an
     * agent, as opposed to the engagement, which is the allocation I approved.
     *
     * Read from GET /api/contributions rather than from the engagement's own
     * `bound` flag, because the two can disagree and only the binding store knows
     * which projects hold standing access right now. The endpoint is a deliberately
     * narrow projection: `ownerDmRoomId` is omitted upstream, so nothing here can
     * expose the owner's private channel.
     *
     * `absent` rather than a fixture on failure. An empty access list rendered
     * beside live engagements would read as "no project can reach this agent" —
     * a claim, where the truth is that the record did not answer.
     */
    /*
     * 项目方 — the side of the market I am registered WITH, and what it may draw.
     *
     * ADR-016 decision 1: one side per homeserver, and the id IS the server name. The list carries the
     * side's own `allocatedTokens`; the BUDGET is a second read per side because it reaches across into
     * the engagement store, and a side record must not silently depend on another store being
     * consistent — the backend keeps them apart for that reason and so does this.
     *
     * NOT DERIVED HERE. Summing active engagements per side would be easy and wrong: `committed` is
     * defined by the backend's `committedForProjectSide`, and a second implementation of a money figure
     * is exactly the drift the capability layer refuses for role eligibility.
     *
     * `absent` rather than a fixture on failure, like `contributions` beside it. An empty side list
     * rendered next to live engagements would read as "I am registered with nobody", which is a claim;
     * the truth would be that the record did not answer. One side's failed budget leaves that side's
     * figure null and the rest intact — a broken read must not blank the section.
     */
    (async () => {
      try {
        const sides = (await get('project-sides'))?.sides ?? [];
        out.projectSides = await Promise.all(sides.map(async (side) => {
          let budget = null;
          try {
            const b = await get(`project-sides/${encodeURIComponent(side.id)}/budget`);
            budget = {
              allocated: b?.allocated ?? null,
              committed: b?.committed ?? null,
              remaining: b?.remaining ?? null,
              /*
               * WHOSE the committed figure is. `已承诺 200k` beside a project with nobody assigned was a
               * number the operator could not interrogate; three of those four commitments belonged to
               * agents deleted hours earlier, and the only way to learn that was cross-referencing two API
               * lists by hand.
               *
               * `orphanedCommitted` is normally 0 — a delete now releases them — so this reads as nothing
               * at all on a healthy fleet, which is the point. It is carried for the fleets that predate
               * that fix and for any future path that manages to leave one behind.
               */
              orphanedCommitted: b?.orphanedCommitted ?? 0,
              commitments: Array.isArray(b?.commitments) ? b.commitments : [],
            };
          } catch { /* leave null; the row says the figure is unavailable rather than showing a zero */ }
          return {
            id: side.id,
            label: side.label ?? null,
            credentialKind: side.credentialKind ?? null,
            /*
             * CARRIED, and its absence is why the operator asked 「设置凭据 还在啊」 three times.
             *
             * The backend answers `hasCredential: true`; this projection read it only to derive
             * `awaitingInstall` and never passed it on. So in the console it was always `undefined`:
             * `CredentialForm` rendered 「设置凭据」 for a side that had one, and the actions added beside it
             * returned null on `if (!side.hasCredential)` — invisible no matter how many times the page was
             * reloaded.
             *
             * A projection that silently omits a field cannot be wrong loudly. Invariant 20 now fails the build
             * when a field the console branches on is missing from the map.
             */
            hasCredential: Boolean(side.hasCredential),
            accessState: side.accessState ?? null,
            /*
             * THE 接单员, from whichever kind of credential this side uses. An appservice's representative
             * IS its `sender_localpart`; a registration-token side has a real registered account whose
             * MXID `ensureRepresentative` recorded. Both are "who we sent", so both land in one field —
             * a page that read only `representative.mxid` showed "none" for every appservice side, which
             * is the majority case under the operator's model.
             */
            representative: side.representative?.mxid
              ?? (side.senderLocalpart ? `@${side.senderLocalpart}:${side.id}` : null),
            namespace: side.namespace ?? null,
            /*
             * ISSUED, BUT NOT YET CONFIRMED WORKING. A Palpo registration loads once at startup, so
             * between us issuing it and the project side installing it and restarting there is a wait we
             * do not control. `hasCredential && accessState === 'unverified'` is exactly that state, and
             * it must not be rendered as a failure: nothing is broken, we are waiting on them.
             */
            /*
             * THE BACKEND NOW ANSWERS THIS, and computing it here as well produced a contradiction the
             * operator saw: a side reading `accessState: accepted` and `awaitingInstall: true` at once.
             *
             * The two meanings had collided under one name. This derivation means "issued and not yet
             * confirmed"; the backend's field means "a REPLACEMENT credential is staged and not yet
             * installed" — a state that exists precisely while the live one is accepted and working. Same
             * word, opposite implications for whether anything is wrong.
             *
             * The backend's value wins when present, because it knows about staging and this cannot. The
             * derivation survives as a fallback for a backend that predates the field.
             */
            awaitingInstall: side.awaitingInstall
              ?? (Boolean(side.hasCredential) && side.accessState === 'unverified'),
            credentialIssuedAt: side.accessIssuedAt ?? null,
            // The address a reissue must reuse. Absent means we never recorded one, and the console must ask
            // rather than guess — a wrong url installs cleanly and receives nothing.
            appserviceUrl: side.appserviceUrl ?? null,
            active: side.active !== false,
            allocatedTokens: side.allocatedTokens ?? null,
            budget,
            /*
             * 项目 → 外派员工. The backend joins bindings onto projects, so the console does not: who
             * staffs a project is the intersection of a binding and a project room, and re-deriving it
             * here would be a second answer to a question the backend already answers.
             */
            projects: (side.projects ?? []).map((pr) => ({
              id: pr.id,
              name: pr.name,
              roomId: pr.roomId ?? null,
              archived: pr.archived === true,
              agents: (pr.agents ?? []).map((a) => ({
                name: a.name,
                bound: a.bound !== false,
                online: a.online,
                retiredAt: a.retiredAt ?? null,
                role: a.role ?? null,
              })),
            })),
          };
        }));
        provenance.projectSides = 'live';
      } catch (e) {
        out.projectSides = [];
        provenance.projectSides = 'absent';
        errors.projectSides = e.message;
      }
    })(),
    (async () => {
      try {
        out.contributions = (await get('contributions'))?.contributions ?? [];
        provenance.contributions = 'live';
      } catch (e) {
        out.contributions = [];
        provenance.contributions = 'absent';
        errors.contributions = e.message;
      }
    })(),
    /*
     * Invitations a project has extended that I have not answered (ADR-014).
     *
     * `absent` rather than a fixture on failure, for the same reason `contributions` is:
     * an empty invitation list is a CLAIM — "no project is waiting on you" — and the truth
     * when this endpoint does not answer is that nobody asked the question. A contributor
     * who reads "nothing pending" and looks away has been misinformed by a fixture.
     */
    (async () => {
      try {
        out.invites = (await get('matrix/pending-invites'))?.invites ?? [];
        provenance.invites = 'live';
      } catch (e) {
        out.invites = [];
        provenance.invites = 'absent';
        errors.invites = e.message;
      }
    })(),
    (async () => {
      try {
        out.whitelist = ((await get('whitelist'))?.whitelist ?? []).map((w) => ({
          ...w,
          // The store keeps an epoch; the page renders a relative age.
          addedAt: w.addedAt ? `${fixture.fmtSpanSec(secsSince(w.addedAt))} ago` : null,
        }));
        provenance.whitelist = 'live';
      } catch (e) {
        out.whitelist = [];
        provenance.whitelist = 'absent';
        errors.whitelist = e.message;
      }
    })(),
  ]);

  /*
   * GET /api/usage carries its own `metering` block declaring which of its three
   * signals is measured. It is kept alongside the rows rather than flattened into
   * them: "this column is not a measurement" is a fact about the column, and
   * repeating it per row is how a systemic gap gets read as many small ones.
   */
  /*
   * The host probe. Separate from `frameworks` on purpose: that slice is the same
   * on every machine, this one is the answer to "what will start HERE", and the
   * onboarding page is unusable without the difference. The fixture claimed octos
   * and hermes were installed with specific versions; on this host neither is on
   * PATH at all.
   */
  try {
    const payload = await get('frameworks/detect');
    out.detected = (payload?.frameworks ?? []).map((f) => ({
      ...f,
      // The console's own state vocabulary, from the probe's codes.
      detectState: f.state,
      setup: [],
    }));
    out.detectedAt = payload?.scannedAt ?? null;
    out.detectCaveat = payload?.caveat ?? null;
    provenance.detected = 'live';
  } catch (e) {
    out.detected = fixture.detected;
    provenance.detected = 'fixture';
    errors.detected = e.message;
  }

  try {
    const payload = await get('usage');
    out.usageLive = payload?.agents ?? [];
    out.metering = payload?.metering ?? null;
    out.usageTotals = payload?.totals ?? null;
    /*
     * The old per-ENGAGEMENT usage rows go empty, because the endpoint reports per
     * AGENT and there is no engagement record to key them to. Leaving the fixture
     * in place would splice rows about `claude-agent` and a project called
     * `acme/worker` onto a live roster that contains neither — the same false join
     * the contract slices are emptied to avoid.
     */
    out.usage = [];
    provenance.usage = 'live';
  } catch (e) {
    out.usageLive = [];
    out.metering = null;
    provenance.usage = 'absent';
    errors.usage = e.message;
  }

  try {
    const payload = await get('seats');
    out.seats = payload?.seats ?? [];
    out.seatKeyed = payload?.keyed === true;
    provenance.seats = 'live';
  } catch (e) {
    out.seats = [];
    provenance.seats = 'absent';
    errors.seats = e.message;
  }

  /*
   * Capability comes last because it needs the agent records to attach, and it
   * degrades to the client-side derivation rather than to a fixture: the roles are
   * a shipped config file either way, so "compute it here" is a real answer where
   * "show yesterday's answer" would not be.
   */
  try {
    const byName = new Map((out.agents ?? []).map((a) => [a.name, a]));
    out.capabilityRows = mapCapability(await get('capability'), byName);
    provenance.capability = 'live';
  } catch (e) {
    provenance.capability = 'derived';
    errors.capability = e.message;
  }

  /*
   * No endpoint exists for these, and against a live backend they must be EMPTY
   * rather than filled from the fixture.
   *
   * The reason is a false join, caught in the browser rather than reasoned about:
   * with live agents on the roster, fixture engagement rows referenced
   * `claude-agent` and `hermes-agent` — agents that do not exist on this backend.
   * A usage table listing work for agents the console does not have is worse than
   * an empty one, because a reader has no way to tell which half is imaginary.
   *
   * So the split is by mode, and both halves are honest: reachable backend →
   * contract slices are empty with a stated reason; no backend (including the
   * static export, which has no proxy at all) → the full fixture, labelled as the
   * fixture. The design is still demonstrable; it is just never spliced onto live
   * data it has no relationship to.
   */
  const anyLive = LIVE_SLICES.some((k) => provenance[k] === 'live');
  // A no-op while CONTRACT_SLICES is empty, and kept for when it is not: the next
  // record this console draws before it exists must land here rather than being
  // spliced onto live data as though it were real.
  for (const key of CONTRACT_SLICES) {
    provenance[key] = 'contract';
    out[key] = anyLive ? [] : fixture[key];
  }
  /*
   * `ceilings` is no longer a slice of its own — the field round-trips on a preset
   * now, so its provenance is the presets slice. Pages that still name it get
   * `contract` when no preset carries one and `live` when any does, which is the
   * honest reading of a field that exists but may be unset.
   */
  /*
   * Ceilings inherit the PRESETS slice's provenance, not merely the presence of the
   * field. Keyed on presence alone, a static export reported `LIVE: CEILINGS`
   * because the fixture's own presets carry ceilings — claiming a live reading for
   * data that never left the bundle, which is the exact error this banner exists to
   * prevent.
   */
  /*
   * Ceilings inherit the presets slice's provenance, and nothing else.
   *
   * Keying on "does any preset happen to carry one" conflated two different
   * questions. A live backend holding presets whose ceilings are simply unset was
   * labelled `contract` — which reads as "the backend has no such field", when the
   * field exists, round-trips, and nobody has filled it in. An empty value is a data
   * state; the banner reports where the data came from.
   */
  provenance.ceilings = provenance.presets;

  return { data: out, provenance, errors };
}
