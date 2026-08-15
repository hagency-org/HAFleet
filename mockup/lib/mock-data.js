/**
 * Mock data for the contribution console.
 *
 * The user here is a RESOURCE PROVIDER — 带资入组的开源贡献者 — who contributes to
 * projects by lending agent capacity rather than by writing code. Every previous
 * version of this fixture modelled the opposite persona (a house dispatching
 * workers), which is why nothing about scheduling survives.
 *
 * Shapes follow the real payloads so the prototype cannot drift into fiction:
 *   agents         -> GET /api/agents/status  (activeNow, idleDurationSec, tmux, transport)
 *   presets        -> GET/POST /api/framework-presets, persisted to framework-presets.json
 *   runtimeProfile -> normalizeRuntimeProfileRole() at backend-v2.js:713 —
 *                     { framework, provider, model, reasoning, extraArgs, apiBaseUrl, apiKey }
 *   alerts         -> GET /api/alerts, statuses from lib/alert-store.js
 *   bindings       -> ApprovalStore.upsertBinding(), lib/approval-store.js:186
 *
 * WHAT DOES NOT EXIST UPSTREAM is drawn as a contract, never as data a backend
 * would return:
 *   - token accounting, at any granularity. Every `usage`/`budget` match in
 *     lib/ and backend-v2.js is a CLI help string. So every ceiling carries
 *     `enforced: false`, and every spend figure is null-with-a-reason, never 0.
 *   - GET /api/frameworks/detect
 *   - inbound engagement requests, standing offers, the whitelist
 */

// The role -> (agent x model) mapping is imported from the REAL config file
// rather than copied, so this fixture cannot drift from what the product ships.
// The import attribute is required, not optional: Node 24 refuses a bare JSON
// import and the assertion scripts load this module in plain Node. Next accepts
// the attribute too, so one spelling serves both the bundler and the checker.
import roleCapacity from '../../lib/role-capacity.json' with { type: 'json' };
// The derivations are shared with the live data source rather than duplicated
// here. See lib/derive.js: two copies of fills() would drift, and this fixture is
// what the assertion suite checks, so a drift would be invisible.
import { makeDerive } from './derive.js';

export { roleCapacity };
export const ROLE_KEYS = Object.keys(roleCapacity.roles);
export const TIERS = roleCapacity.tiers;

// ── agents ───────────────────────────────────────────────────────────────────
// The five real agents with their real transports. Three are ACP with tmux:null,
// which is why Activity cannot assume a pane exists.
export const agents = [
  {
    name: 'claude-agent', framework: 'claude', transport: 'tmux', tmux: 'claude-agent:0.0',
    activeNow: false, activeDurationSec: 0, idleDurationSec: 9869,
    environment: 'live', alive: true, mcp: true, presetId: 'ps_opus',
  },
  {
    name: 'octos-agent', framework: 'octos', transport: 'acp', tmux: null,
    activeNow: true, activeDurationSec: 134, idleDurationSec: 0,
    environment: 'live', alive: true, mcp: true, presetId: 'ps_kimi',
  },
  {
    name: 'codex-agent', framework: 'codex', transport: 'tmux', tmux: 'codex-agent:0.0',
    activeNow: false, activeDurationSec: 0, idleDurationSec: 4732,
    environment: 'live', alive: true, mcp: true, presetId: 'ps_gpt_med',
  },
  {
    name: 'hermes-agent', framework: 'hermes', transport: 'acp', tmux: null,
    activeNow: false, activeDurationSec: 0, idleDurationSec: 7172,
    environment: 'live', alive: true, mcp: true, presetId: 'ps_deepseek',
  },
  {
    // No preset — the honest case on a real host: registered, running, and
    // nobody ever chose what model it contributes. It qualifies for no role and
    // can fill no request. The console says that rather than assuming a default.
    name: 'codex-acp-agent', framework: 'codex-acp', transport: 'acp', tmux: null,
    activeNow: false, activeDurationSec: 0, idleDurationSec: 6662,
    environment: 'live', alive: true, mcp: true, presetId: null,
  },
];

// ── presets: what the wizard writes ──────────────────────────────────────────
/*
 * A preset is a REAL persisted record — framework-presets.json, with
 * GET/POST /api/framework-presets, resolved into a runtimeProfile at
 * registration (backend-v2.js:8146-8151). Its fields are exactly the ones
 * normalizeRuntimeProfileRole() accepts, `reasoning` included — which is where
 * Codex thinking levels live.
 *
 * `ceiling` is the ONE field with no upstream home, and it is the thing the
 * contributor is actually deciding: how much of their own money to lend. Drawn
 * against the contract and flagged `enforced: false` wherever it appears.
 */
export const presets = [
  {
    id: 'ps_opus', name: 'My Opus donation',
    framework: 'claude', provider: 'anthropic', model: 'claude-opus-5', reasoning: null,
    ceiling: { tokens: 5_000_000, period: 'monthly', rateCapPerDay: 250_000, enforced: false },
  },
  {
    id: 'ps_kimi', name: 'Octos on Kimi',
    framework: 'octos', provider: 'moonshot', model: 'kimi-k3', reasoning: null,
    ceiling: { tokens: 3_000_000, period: 'monthly', rateCapPerDay: 150_000, enforced: false },
  },
  {
    id: 'ps_gpt_med', name: 'Codex, medium thinking',
    framework: 'codex', provider: 'openai', model: 'gpt-5.6-sol', reasoning: 'medium',
    ceiling: { tokens: 2_000_000, period: 'monthly', rateCapPerDay: 100_000, enforced: false },
  },
  {
    id: 'ps_deepseek', name: 'Hermes on DeepSeek',
    framework: 'hermes', provider: 'deepseek', model: 'deepseek-v-flash', reasoning: null,
    // No rate cap — a real state, and a different one from "0 per day".
    ceiling: { tokens: 1_000_000, period: 'monthly', rateCapPerDay: null, enforced: false },
  },
];

// ── L3: the standing offer + the whitelist ───────────────────────────────────
/*
 * Neither record exists upstream; both are contracts.
 *
 * The offer is what makes a contributor discoverable rather than waiting to be
 * invited. `published: false` is a real state — capacity configured but not yet
 * advertised, which is what a provider wants while still setting up.
 */
export const offers = [
  { role: 'architect', count: 2, budgetCapPerEngagement: 1_500_000, rateCap: 80_000, published: true },
  { role: 'review', count: 2, budgetCapPerEngagement: 1_000_000, rateCap: 60_000, published: true },
  { role: 'coding', count: 3, budgetCapPerEngagement: 800_000, rateCap: 50_000, published: true },
  { role: 'testing', count: 2, budgetCapPerEngagement: 500_000, rateCap: 40_000, published: false },
  { role: 'integration', count: 1, budgetCapPerEngagement: 400_000, rateCap: 30_000, published: false },
  { role: 'documentation', count: 2, budgetCapPerEngagement: 200_000, rateCap: 20_000, published: true },
];

/*
 * Keyed on projectRoomId, NEVER on a display name.
 *
 * The system already validates room ids strictly (ROOM_ID_RE,
 * approval-store.js:19) and bindingKey(agent, projectRoomId) keys on the room.
 * A name-keyed whitelist would be spoofable by any project that renames itself
 * after a trusted one, so the name here is for reading only.
 *
 * Default-deny, following TRUSTED_HAFLEET_COORDINATION_TOOLS
 * (lib/codex-permission-hook.js:15): anything not named is refused.
 */
export const whitelist = [
  { projectRoomId: '!aXbY7pQ2:hq.example', displayName: 'acme/api-service', addedAt: '9d ago', addedBy: '@me:hq.example' },
  { projectRoomId: '!kL9mN4rS:hq.example', displayName: 'acme/docs-portal', addedAt: '3d ago', addedBy: '@me:hq.example' },
];

export const ENGAGEMENT_STATES = ['pending', 'active', 'ended'];
/** Why a request needs the owner. Null on an auto-joined engagement. */
export const ROUTE_REASONS = ['notWhitelisted', 'overOffer', 'overCeiling'];

/*
 * 项目方 — one homeserver, one credential, one representative, one allocation (ADR-016 decision 1).
 * The id IS the server name, which is what makes a room id enough to attribute spend.
 *
 * EVERY ALLOCATION STATE IS PRESENT, because the three are not interchangeable and a fixture showing
 * only a funded side is how "unallocated" gets built as "unlimited":
 *
 *   hq.example       funded, and partly committed — the ordinary case
 *   biglittle.example a real allocation of ZERO: closed to new work, still configured
 *   newco.example    UNALLOCATED (null): refuses everything, and is not the same as zero
 *
 * `newco.example` also has no credential and has never been reached, which is what a side looks like
 * between "the operator added it" and "the operator finished configuring it".
 */
export const projectSides = [
  {
    id: 'hq.example', label: 'Acme HQ', credentialKind: 'appservice', accessState: 'ok',
    representative: '@hafleet:hq.example', namespace: '@ac_.*',
    awaitingInstall: false, credentialIssuedAt: null, active: true,
    allocatedTokens: 4_000_000,
    budget: { allocated: 4_000_000, committed: 1_550_000, remaining: 2_450_000 },
    projects: [
      {
        id: 'api-service', name: 'acme/api-service', roomId: '!aXbY7pQ2:hq.example', archived: false,
        agents: [
          { name: 'claude-agent', bound: true, online: true, retiredAt: null, role: 'architect' },
          // Bound but DOWN: the project can still reach it, the agent is not running. Two facts.
          { name: 'octos-agent', bound: true, online: false, retiredAt: null, role: 'review' },
        ],
      },
      {
        id: 'docs-portal', name: 'acme/docs-portal', roomId: '!kL9mN4rS:hq.example', archived: false,
        agents: [{ name: 'claude-agent', bound: true, online: true, retiredAt: null, role: 'documentation' }],
      },
      {
        /*
         * ARCHIVED, and it keeps its staff — a retired agent under a closed project. Both are on purpose:
         * decision 7 stands records down instead of deleting them, so a fixture that showed an archived
         * project as empty would teach the page to hide exactly the history that rule exists to keep.
         */
        id: 'legacy-billing', name: 'acme/legacy-billing', roomId: '!oldRoom99:hq.example', archived: true,
        agents: [{ name: 'retired-agent', bound: false, online: false, retiredAt: 1_754_000_000_000, role: 'coding' }],
      },
    ],
  },
  {
    id: 'biglittle.example', label: 'BigLittle', credentialKind: 'registrationToken', accessState: 'ok',
    representative: '@hafleet:biglittle.example', namespace: null,
    awaitingInstall: false, credentialIssuedAt: null, active: true,
    allocatedTokens: 0,
    budget: { allocated: 0, committed: 0, remaining: 0 },
    // A project with no room yet: named before it exists, which is the ordinary order of events.
    projects: [{ id: 'fips-review', name: 'openssl/fips-review', roomId: null, archived: false, agents: [] }],
  },
  {
    /*
     * ISSUED, WAITING ON THEM. The registration exists and the project side has not installed it and
     * restarted — a wait we do not control, and not a failure. It has a representative already, because
     * an appservice's representative is its sender_localpart, which is decided when the file is written.
     */
    id: 'newco.example', label: 'NewCo', credentialKind: 'appservice', accessState: 'unverified',
    representative: '@hafleet:newco.example', namespace: '@ac_.*',
    awaitingInstall: true, credentialIssuedAt: 1_755_200_000_000, active: true,
    allocatedTokens: null,
    // Null, not zero. `remaining` cannot be computed from an allocation that does not exist.
    budget: { allocated: null, committed: 0, remaining: null },
    projects: [],
  },
];

/*
 * Every branch of the routing is exercised, because a fixture that shows only
 * the happy path is how "falls back to approval" gets built as "rejects".
 */
export const engagements = [
  {
    id: 'en_0041', projectRoomId: '!aXbY7pQ2:hq.example', project: 'acme/api-service',
    role: 'architect', requester: '@lin:hq.example',
    requestedTokens: 1_200_000, ratePerDay: 60_000,
    // Whitelisted, and inside the architect offer's 1.5M cap — but it exceeds
    // what is LEFT of claude-agent's ceiling once en_0038 and en_0039 are
    // counted. So it falls back to approval instead of auto-joining, and is not
    // rejected: the project did nothing wrong by asking.
    state: 'pending', route: 'overCeiling', agent: 'claude-agent', since: '2h',
  },
  {
    id: 'en_0040', projectRoomId: '!zZ1qW3eR:hq.example', project: 'openssl/fips-review',
    role: 'review', requester: '@dana:hq.example',
    requestedTokens: 400_000, ratePerDay: 30_000,
    state: 'pending', route: 'notWhitelisted', agent: 'octos-agent', since: '20m',
  },
  {
    id: 'en_0039', projectRoomId: '!kL9mN4rS:hq.example', project: 'acme/docs-portal',
    role: 'documentation', requester: '@mei:hq.example',
    requestedTokens: 150_000, ratePerDay: 15_000,
    state: 'active', route: null, autoJoined: true, agent: 'claude-agent',
    allocatedTokens: 150_000, since: '3d',
  },
  {
    // The engagement that makes the ceiling bite. Without it claude-agent has 4M
    // free, every request fits, and the `overCeiling` branch is unreachable — so
    // the fixture would assert a route it never exercises.
    id: 'en_0035', projectRoomId: '!kL9mN4rS:hq.example', project: 'acme/docs-portal',
    role: 'architect', requester: '@mei:hq.example',
    requestedTokens: 3_000_000, ratePerDay: 80_000,
    state: 'active', route: null, agent: 'claude-agent',
    allocatedTokens: 3_000_000, since: '11d',
  },
  {
    id: 'en_0038', projectRoomId: '!aXbY7pQ2:hq.example', project: 'acme/api-service',
    role: 'coding', requester: '@lin:hq.example',
    requestedTokens: 800_000, ratePerDay: 50_000,
    state: 'active', route: null, autoJoined: true, agent: 'claude-agent',
    allocatedTokens: 800_000, since: '6d',
  },
  {
    id: 'en_0031', projectRoomId: '!pP4oO5iI:hq.example', project: 'acme/worker',
    role: 'testing', requester: '@lin:hq.example',
    requestedTokens: 300_000, ratePerDay: 20_000,
    state: 'ended', route: null, agent: 'hermes-agent',
    allocatedTokens: 300_000, endedReason: 'en.ended.completed', since: '21d',
  },
];

// ── L4: usage ────────────────────────────────────────────────────────────────
/*
 * Task structure is real (lib/task-store.js, five statuses). Token consumption
 * is not — nothing measures it at any granularity — so `tokensUsed` is null on
 * every row, and the page states why once rather than printing a zero per row.
 */
export const usage = [
  { engagementId: 'en_0039', project: 'acme/docs-portal', role: 'documentation', agent: 'claude-agent', tasksDone: 4, tasksOpen: 1, tokensUsed: null },
  { engagementId: 'en_0038', project: 'acme/api-service', role: 'coding', agent: 'claude-agent', tasksDone: 11, tasksOpen: 2, tokensUsed: null },
  { engagementId: 'en_0031', project: 'acme/worker', role: 'testing', agent: 'hermes-agent', tasksDone: 6, tasksOpen: 0, tokensUsed: null },
];

// ── alerts ───────────────────────────────────────────────────────────────────
/*
 * Re-mixed for this persona. The previous fixture's queue-depth and
 * session-recycle alerts were fleet-operations noise. A contributor's actual
 * worries are: is my asset down, was the model I promised silently swapped, and
 * am I near a cap.
 *
 * The preset-drift one is the sharpest — "I advertised Opus and something else
 * ran" is both a trust problem and a billing one.
 */
export const alerts = [
  {
    id: 'al_0044', severity: 'critical', status: 'open',
    summary: 'Framework preset drifted from resolved values', agent: 'octos-agent',
    occurrences: 2, ageSec: 11640, firstSeenSec: 11640,
    detail: 'The applied preset specifies a model the provider no longer lists, so the agent resolved to a fallback. The model being contributed is not the one the standing offer advertises.',
    notes: [],
  },
  {
    id: 'al_0043', severity: 'critical', status: 'open',
    summary: 'Agent heartbeat missing', agent: 'hermes-agent',
    occurrences: 5, ageSec: 7080, firstSeenSec: 7080,
    detail: 'No heartbeat for five consecutive sweeps. The supervisor reports the process alive, so this is a reporting-path failure rather than a crash.',
    notes: [{ at: '1h20m ago', by: 'system', text: 'Escalated after the third missed sweep.' }],
  },
  {
    id: 'al_0042', severity: 'warning', status: 'open',
    summary: 'Agent contributes no model', agent: 'codex-acp-agent',
    occurrences: 1, ageSec: 86400, firstSeenSec: 86400,
    detail: 'Registered and running with no preset, so it qualifies for no role and can fill no request. Configure a model or retire it.',
    notes: [],
  },
  {
    id: 'al_0040', severity: 'info', status: 'acknowledged',
    summary: 'Engagement request waiting on a decision', agent: 'octos-agent',
    occurrences: 1, ageSec: 1200, firstSeenSec: 1200,
    detail: 'openssl/fips-review requested a Reviewer. The project is not whitelisted, so it cannot auto-join.',
    notes: [{ at: '10m ago', by: 'operator', text: 'Checking who they are.' }],
  },
];

// ── derived helpers ──────────────────────────────────────────────────────────

export function fmtSpanSec(sec) {
  const s = Math.max(0, Number(sec) || 0);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`;
}

/** The same string the live monitor's runtimeStatusText() produces. */
export function runtimeStatusText(a) {
  return a.activeNow
    ? `ACTIVE ${fmtSpanSec(a.activeDurationSec)}`
    : `IDLE ${fmtSpanSec(a.idleDurationSec)}`;
}

/**
 * Tokens, readably. 5_000_000 -> "5.0M". Null stays null: a blank is not a zero.
 *
 * Signed, because a magnitude can now legitimately be negative: seat headroom is
 * quota minus what has been promised out of it, and over-subscription is exactly
 * the case where that goes below zero. The first version compared `n >= 1_000_000`
 * and so printed -4000000 raw next to four neatly formatted figures.
 */
export function fmtTokens(n) {
  if (n === null || n === undefined) return null;
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${Math.round(abs / 1_000)}k`;
  return String(n);
}

const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 };
/** Most severe first, then oldest. */
export function bySeverityThenAge(a, b) {
  const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  return s !== 0 ? s : b.ageSec - a.ageSec;
}

/*
 * Everything data-dependent, bound to the fixture above.
 *
 * The same factory is called by components/Data.jsx with the live backend's data,
 * so a page reads identical function names whichever source is behind it and the
 * two cannot diverge in their reasoning about tiers, ceilings or over-commitment.
 */
const D = makeDerive({ roleCapacity, agents, presets, offers, whitelist, engagements, alerts });

export const {
  ALERT_STATUSES, SEVERITIES,
  presetOf, tierOf, familyOf, fills, capability, modelsFor,
  isWhitelisted, committed, remaining, overCommits,
  pendingEngagements, activeEngagements, endedEngagements,
  alertCounts, railCounts,
  MODEL_SELECTABLE, FRAMEWORKS,
} = D;

// ── the agent log Activity renders ───────────────────────────────────────────
// Line kinds are the real ones the ACP host writes. Framework passthrough is
// collapsed because the real log is saturated with ANSI escapes.
export const agentLog = {
  'octos-agent': {
    source: 'log',
    lines: [
      { at: '01:22:19', kind: 'nudging', text: '1 unread' },
      { at: '01:22:20', kind: 'tools', text: 'check_inbox [completed], send_message [completed]' },
      { at: '01:22:21', kind: 'turn', text: 'finished (end_turn)' },
      { at: '01:22:21', kind: 'framework', text: '12 lines of framework output', collapsed: 12 },
    ],
  },
  'hermes-agent': {
    source: 'log',
    lines: [
      { at: '00:38:09', kind: 'tools', text: 'mcp__hafleet__send_message [completed]' },
      { at: '00:38:09', kind: 'turn', text: 'finished (end_turn)' },
    ],
  },
  'codex-acp-agent': { source: 'log', lines: [{ at: '01:22:31', kind: 'turn', text: 'finished (end_turn)' }] },
  'codex-agent': { source: 'pane', lines: [] },
  'claude-agent': { source: 'pane', lines: [] },
};

// The backend API base — README's documented default and the HAFLEET_API default.
export const API_BASE = 'http://127.0.0.1:8090';

/**
 * The command the wizard is equivalent to. Shown, not hidden: a contributor has
 * to be able to reproduce and script what the form did, and seeing the command
 * is also how you notice the form built the wrong one.
 *
 * POST /api/framework-presets is real. The ceiling is not — it has no field
 * upstream — so the printed command carries only what the endpoint accepts, and
 * the page states separately that the ceiling is recorded and not enforced.
 */
export function presetCommand(draft) {
  const body = {
    name: draft.name || '<name>',
    framework: draft.framework || '<framework>',
    ...(draft.provider ? { provider: draft.provider } : {}),
    ...(draft.model ? { model: draft.model } : {}),
    ...(draft.reasoning ? { reasoning: draft.reasoning } : {}),
    /*
     * The ceiling belongs here now.
     *
     * It was omitted deliberately while POST /api/framework-presets dropped the
     * field — printing it would have implied the endpoint stored it. The endpoint
     * stores it, and the form sends it, so a command that leaves it out no longer
     * reproduces what the form did: running the printed curl created the same preset
     * with no budget at all.
     */
    ...(draft.tokens ? {
      ceiling: {
        tokens: draft.tokens,
        period: 'monthly',
        ...(draft.rateCapPerDay ? { rateCapPerDay: draft.rateCapPerDay } : {}),
      },
    } : {}),
  };
  return `curl -X POST ${API_BASE}/api/framework-presets`
    + ` -H 'Content-Type: application/json'`
    + ` -d '${JSON.stringify(body)}'`;
}

// ── framework detection, for /onboard ────────────────────────────────────────
/*
 * Shape mirrors the endpoint the page needs: GET /api/frameworks/detect, which
 * DOES NOT EXIST. Every field here is something a host can actually establish,
 * and every value is taken from the real lib/frameworks/<id>.json.
 *
 * `state` is derived, never stored: ready | needs_auth | needs_setup | absent,
 * checked in that order. Four states, not two, because "installed" and "usable"
 * came apart in practice — hermes with only the [acp] extra starts, reports
 * healthy, and then cannot see check_inbox.
 */
export const detected = [
  {
    id: 'claude', displayName: 'Claude Code', transport: 'tmux', command: 'claude',
    acpArgs: null, onPath: true, version: '2.1.8',
    credentialHome: '~/.claude/', credentialPresent: true, authFix: 'claude login',
    acpModelFlag: null, permissionSummary: 'auto-mode', setup: [], startWith: 'hafleet up',
  },
  {
    id: 'octos', displayName: 'Octos', transport: 'acp', command: 'octos',
    acpArgs: ['acp', '--profile', 'coding-full'], onPath: true, version: '2.0.2',
    credentialHome: '~/.config/octos/config.json', credentialPresent: true,
    authFix: 'edit octos config.json', acpModelFlag: '--model',
    permissionSummary: 'octos sandbox as configured (hafleet never passes --danger-full-access)',
    setup: [{ ok: true, key: 'ob.pre.codingFull' }, { ok: true, key: 'ob.pre.mcpServers' }],
    startWith: 'hafleet acp-up',
  },
  {
    id: 'codex', displayName: 'Codex (tmux)', transport: 'tmux', command: 'codex',
    acpArgs: null, onPath: true, version: '0.146.0',
    credentialHome: '~/.codex/', credentialPresent: true, authFix: 'codex login',
    acpModelFlag: null, permissionSummary: 'level2 (workspace-write + on-request)',
    setup: [], startWith: 'hafleet up',
  },
  {
    id: 'hermes', displayName: 'Hermes', transport: 'acp', command: 'hermes-acp',
    acpArgs: [], onPath: true, version: '0.9.4',
    credentialHome: '~/.hermes/', credentialPresent: true,
    authFix: 'hermes auth add <provider> --type api-key', acpModelFlag: null,
    permissionSummary: 'hermes interactive approval prompts (bypass flags refused)',
    setup: [
      { ok: true, key: 'ob.pre.acpExtra' },
      { ok: false, key: 'ob.pre.mcpExtra', fix: 'uv pip install -e ".[acp,mcp]"' },
    ],
    startWith: 'hafleet acp-up',
  },
  {
    id: 'codex-acp', displayName: 'Codex (ACP)', transport: 'acp', command: 'codex-acp',
    acpArgs: [], onPath: false, version: null,
    credentialHome: '~/.codex/', credentialPresent: true, authFix: 'codex login',
    acpModelFlag: null, permissionSummary: 'level2 (workspace-write + on-request)',
    setup: [], startWith: 'hafleet acp-up',
  },
];

/**
 * The one state that decides what the contributor can do.
 *
 * Order matters: a framework that is not installed cannot be authenticated, and
 * one that is not authenticated fails at first prompt however complete its setup
 * is. Reporting the furthest-along problem first would send someone to fix the
 * wrong thing.
 */
/**
 * The state of one detected framework.
 *
 * The HOST PROBE's own verdict wins when there is one. Recomputing it here from
 * `onPath` / `credentialPresent` / `setup` threw away the state the probe can see
 * and this cannot: `unusable` — on PATH, but `--version` hangs or errors. A binary
 * in that condition was recomputed straight back to `ready` and offered for
 * onboarding, which is the worst of the four answers to be wrong about.
 *
 * The recomputation remains for fixture entries, which carry no `state`.
 */
export function detectState(f) {
  if (f.state) return f.state;
  if (!f.onPath) return 'absent';
  if (!f.credentialPresent) return 'needs_auth';
  if ((f.setup ?? []).some((s) => !s.ok)) return 'needs_setup';
  return 'ready';
}

/** Bringing one up is only offered for a framework in `ready`. */
export function onboardable(list = detected) {
  return list.filter((f) => detectState(f) === 'ready');
}

/** The four steps acp-up actually performs, in order. */
export const onboardSteps = [
  { id: 'refuse', label: 'ob.step.refuse' },
  { id: 'token', label: 'ob.step.token' },
  { id: 'register', label: 'ob.step.register' },
  { id: 'health', label: 'ob.step.health' },
];

/** The exact command the form is equivalent to. */
export function onboardCommand({ name, workspace, framework, supervised, model }) {
  const f = detected.find((x) => x.id === framework);
  const parts = [f?.startWith ?? 'hafleet acp-up', name || '<name>', workspace || '<workspace>', framework];
  if (supervised && f?.transport === 'acp') parts.push('--supervised');
  if (model && f?.acpModelFlag) parts.push(f.acpModelFlag, model);
  return parts.join(' ');
}

/*
 * Where each framework keeps its credential. HAFleet never holds the secret — an
 * agent authenticates itself before it joins — so what the console legitimately
 * knows is whether a provider RESOLVED, because failing to is the most common
 * reason onboarding fails.
 */
export const providerHomes = {
  claude: { home: '~/.claude/', fix: 'claude login' },
  codex: { home: '~/.codex/', fix: 'codex login' },
  'codex-acp': { home: '~/.codex/', fix: 'codex login' },
  hermes: { home: '~/.hermes/', fix: 'hermes auth add <provider>' },
  octos: { home: '~/.config/octos/config.json', fix: 'edit octos config.json' },
};
