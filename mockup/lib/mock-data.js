/**
 * Mock data for the dashboard relayout prototype.
 *
 * Shapes follow the real payloads so the prototype cannot drift into fiction:
 *   agents      -> GET /api/agents/status   (activeNow, activeDurationSec, idleDurationSec, tmux, transport)
 *   alerts      -> GET /api/alerts + /api/alerts/stats (statuses from lib/alert-store.js)
 *   tasks       -> the TaskDTO in lib/task-store (status, priority, waiting_reason, heartbeat_at, ...)
 *   board       -> GET /api/project-board   (totals, five task lanes, worktrees, specs, changes)
 *   pool        -> GET /api/pool            (role x capability, idle/total per cell)
 *
 * Where the live fleet is empty the prototype is deliberately POPULATED: an empty
 * page cannot demonstrate ordering, density, or a detail panel, which is what the
 * review rounds asked to see. Counts here are illustrative, not measurements.
 */

export const ALERT_STATUSES = ['open', 'acknowledged', 'assigned', 'resolved', 'suppressed'];
export const SEVERITIES = ['critical', 'warning', 'info'];
export const TASK_STATUSES = ['created', 'accepted', 'in_progress', 'blocked', 'done'];

/** Legal transitions, so the UI can render only the actions a task can actually take. */
export const TASK_TRANSITIONS = {
  created: ['accepted'],
  accepted: ['in_progress'],
  in_progress: ['blocked', 'done'],
  blocked: ['in_progress'],
  done: [],
};

// ── agents ────────────────────────────────────────────────────────────────────
// The five real agents, with their real transports. Three are ACP with tmux:null,
// which is why Activity cannot assume a pane exists.
export const agents = [
  {
    name: 'octos-agent', framework: 'octos', transport: 'acp', tmux: null,
    activeNow: true, activeDurationSec: 134, idleDurationSec: 0,
    environment: 'live', remote: false, alive: true, mcp: true,
  },
  {
    name: 'codex-agent', framework: 'codex', transport: 'tmux', tmux: 'codex-agent:0.0',
    activeNow: false, activeDurationSec: 0, idleDurationSec: 4732,
    environment: 'live', remote: false, alive: true, mcp: true,
  },
  {
    name: 'hermes-agent', framework: 'hermes', transport: 'acp', tmux: null,
    activeNow: false, activeDurationSec: 0, idleDurationSec: 7172,
    environment: 'live', remote: false, alive: true, mcp: true,
  },
  {
    name: 'codex-acp-agent', framework: 'codex-acp', transport: 'acp', tmux: null,
    activeNow: false, activeDurationSec: 0, idleDurationSec: 6662,
    environment: 'live', remote: false, alive: true, mcp: true,
  },
  {
    name: 'claude-agent', framework: 'claude', transport: 'tmux', tmux: 'claude-agent:0.0',
    activeNow: false, activeDurationSec: 0, idleDurationSec: 9869,
    environment: 'live', remote: false, alive: true, mcp: true,
  },
];

// ── alerts ────────────────────────────────────────────────────────────────────
export const alerts = [
  {
    id: 'al_0031', severity: 'critical', status: 'open',
    summary: 'Agent heartbeat missing', agent: 'hermes-agent',
    occurrences: 5, ageSec: 7080, firstSeenSec: 7080,
    detail: 'No heartbeat received for 5 consecutive sweeps. The supervisor reports the process alive, so this is a reporting path failure rather than a crash.',
    notes: [{ at: '1h20m ago', by: 'system', text: 'Escalated after the third missed sweep.' }],
  },
  {
    id: 'al_0030', severity: 'warning', status: 'open',
    summary: 'High queue depth on staging route', agent: 'octos-agent',
    occurrences: 3, ageSec: 4320, firstSeenSec: 4320,
    detail: 'Queue depth 23 sustained for over an hour. Delivery is gated on the agent going idle, and the agent has been active throughout.',
    notes: [],
  },
  {
    id: 'al_0029', severity: 'info', status: 'acknowledged',
    summary: 'Task has not reported completion', agent: 'codex-agent',
    occurrences: 1, ageSec: 2820, firstSeenSec: 2820,
    detail: 'Task tk_0044 passed its expected duration without a heartbeat. It may simply be long-running.',
    notes: [{ at: '30m ago', by: 'operator', text: 'Known long build. Watching.' }],
  },
  {
    id: 'al_0028', severity: 'info', status: 'open',
    summary: 'Project has no delivery target configured', agent: 'octos-agent',
    occurrences: 1, ageSec: 1080, firstSeenSec: 1080,
    detail: 'The project group acme-platform has no delivery target, so completed work is not published anywhere.',
    notes: [],
  },
  {
    id: 'al_0027', severity: 'info', status: 'open',
    summary: 'Framework preset drifted from resolved values', agent: 'codex-acp-agent',
    occurrences: 2, ageSec: 11640, firstSeenSec: 11640,
    detail: 'The applied preset specifies a model the provider no longer lists. The agent resolved to a fallback.',
    notes: [],
  },
  {
    id: 'al_0026', severity: 'info', status: 'resolved',
    summary: 'Session recycled after prompt timeout', agent: 'codex-acp-agent',
    occurrences: 1, ageSec: 17400, firstSeenSec: 17400,
    detail: 'A prompt timed out at 600s; the host recycled the session and resumed from the stored id.',
    notes: [{ at: '4h ago', by: 'system', text: 'Auto-resolved once the next turn completed.' }],
  },
];

// ── tasks ─────────────────────────────────────────────────────────────────────
// Populated on purpose: the empty state cannot show blocked-first ordering.
export const tasks = [
  {
    id: 'tk_0051', title: 'Fix failing integration tests on the worker repo',
    status: 'blocked', priority: 'P0', assignee: 'codex-acp-agent',
    waiting_reason: 'Waiting on credentials for the staging database',
    waiting_until: '2026-08-03T18:00:00Z', overdue: true,
    heartbeat_at: null, updated_at: '2026-08-04T02:10:00Z', created_at: '2026-08-02T09:00:00Z',
    parent_id: null, labels: ['ci', 'blocking-release'],
    description: 'Three integration tests fail against staging. The failure is environmental: the test user lost write access after the credential rotation.',
    comments: [
      { at: '1h ago', by: 'codex-acp-agent', text: 'Reproduced locally with staging creds removed. Same three failures.' },
      { at: '20m ago', by: 'operator', text: 'Rotating a fresh test credential now.' },
    ],
  },
  {
    id: 'tk_0049', title: 'Upgrade database schema for the new task fields',
    status: 'blocked', priority: 'P2', assignee: 'hermes-agent',
    waiting_reason: 'Waiting on review of the migration plan',
    waiting_until: '2026-08-05T12:00:00Z', overdue: false,
    heartbeat_at: null, updated_at: '2026-08-03T22:40:00Z', created_at: '2026-08-01T14:20:00Z',
    parent_id: null, labels: ['schema'],
    description: 'Adds waiting_reason and waiting_until columns. Migration is written but unreviewed.',
    comments: [],
  },
  {
    id: 'tk_0044', title: 'Implement user search across the project board',
    status: 'in_progress', priority: 'P1', assignee: 'octos-agent',
    waiting_reason: null, waiting_until: null, overdue: false,
    heartbeat_at: '2026-08-04T05:12:00Z', stale: true,
    updated_at: '2026-08-04T05:12:00Z', created_at: '2026-08-03T11:05:00Z',
    parent_id: null, labels: ['feature'],
    description: 'Search across members, repos and tasks from one field. Backend endpoint exists; the UI is the remaining work.',
    comments: [{ at: '3h ago', by: 'octos-agent', text: 'Endpoint returns results. Wiring the input now.' }],
  },
  {
    id: 'tk_0041', title: 'Refactor auth middleware to share one token path',
    status: 'accepted', priority: 'P1', assignee: 'codex-agent',
    waiting_reason: null, waiting_until: null, overdue: false,
    heartbeat_at: null, updated_at: '2026-08-03T19:30:00Z', created_at: '2026-08-03T09:00:00Z',
    parent_id: null, labels: ['refactor'],
    description: 'Two middlewares resolve tokens differently. Consolidate onto the adapter used by the agent-token path.',
    comments: [],
  },
  {
    id: 'tk_0038', title: 'Add API rate limiting to the public endpoints',
    status: 'created', priority: 'P2', assignee: null,
    waiting_reason: null, waiting_until: null, overdue: false,
    heartbeat_at: null, updated_at: '2026-08-02T16:00:00Z', created_at: '2026-08-02T16:00:00Z',
    parent_id: null, labels: [],
    description: 'No rate limiting on the public read endpoints.',
    comments: [],
  },
  {
    id: 'tk_0035', title: 'Improve logging context on delivery failures',
    status: 'created', priority: 'P3', assignee: null,
    waiting_reason: null, waiting_until: null, overdue: false,
    heartbeat_at: null, updated_at: '2026-08-02T10:15:00Z', created_at: '2026-08-02T10:15:00Z',
    parent_id: null, labels: ['observability'],
    description: 'A failed delivery logs the reason but not the target or attempt count.',
    comments: [],
  },
  {
    id: 'tk_0022', title: 'Set up nightly backups for the state store',
    status: 'done', priority: 'P1', assignee: 'octos-agent',
    waiting_reason: null, waiting_until: null, overdue: false,
    heartbeat_at: null, completed_at: '2026-08-03T04:00:00Z',
    updated_at: '2026-08-03T04:00:00Z', created_at: '2026-07-31T12:00:00Z',
    parent_id: null, labels: ['ops'],
    description: 'Nightly snapshot to object storage with a seven-day retention.',
    comments: [],
  },
];

// ── queue ─────────────────────────────────────────────────────────────────────
// The destination the migration table promises and the static mockups never drew.
export const queue = [
  {
    id: 4471, to: 'octos-agent', from: 'system', type: 'request',
    summary: 'Reply with exactly PARITY2.', waitingSec: 42,
    reason: 'Target is active — held until idle', targetActive: true,
  },
  {
    id: 4470, to: 'hermes-agent', from: 'operator', type: 'human',
    summary: 'Can you confirm the deepseek provider is resolving?', waitingSec: 320,
    reason: 'Target is active — held until idle', targetActive: true,
  },
  {
    id: 4468, to: 'codex-agent', from: 'hafleet-backend', type: 'task',
    summary: 'Nightly audit sweep for the worker repo', waitingSec: 1180,
    reason: 'Delivery cooldown, 40s remaining', targetActive: false,
  },
];

// `in` is the OFFSET, not a rendered string: "in 25m" is not readable Chinese, and a
// pre-formatted English fixture would have leaked straight through the dictionary.
export const reminders = [
  { id: 'rm_09', inMinutes: 25, text: 'Check whether the staging credential rotation cleared tk_0051' },
  { id: 'rm_08', inMinutes: 180, text: 'Re-run the fleet benchmark and replace the estimated column' },
];

/** A reminder's countdown, localised. Both Overview and Queue render these. */
export function fmtIn(mins, t) {
  return mins < 60 ? t('in.m', { n: mins }) : t('in.h', { n: Math.round(mins / 60) });
}

// ── framework detection, for the onboarding page ──────────────────────────────
// Shape mirrors the endpoint the real page needs: GET /api/frameworks/detect,
// which does not exist yet. Every field here is something a host can actually
// establish, and every value is taken from the real lib/frameworks/<id>.json —
// see docs/design/dashboard-relayout.md for the contract and the reasoning.
//
// `state` is derived, never stored: ready | needs_auth | needs_setup | absent.
// Four states, not two, because "installed" and "usable" came apart in practice —
// hermes with only the [acp] extra starts, reports healthy, and then cannot see
// check_inbox.
export const detected = [
  {
    id: 'octos',
    displayName: 'Octos',
    transport: 'acp',
    command: 'octos',
    acpArgs: ['acp', '--profile', 'coding-full'],
    onPath: true,
    version: '2.0.2',
    credentialHome: '~/.config/octos/config.json',
    credentialPresent: true,
    authFix: 'edit octos config.json',
    acpModelFlag: '--model',
    permissionSummary: 'octos sandbox as configured (hafleet never passes --danger-full-access)',
    // Keys, not sentences. These are HAFleet's OWN detection findings, unlike an
    // alert summary that arrives from the API — so they follow the language switch.
    setup: [
      { ok: true, key: 'ob.pre.codingFull' },
      { ok: true, key: 'ob.pre.mcpServers' },
    ],
    startWith: 'hafleet acp-up',
  },
  {
    id: 'hermes',
    displayName: 'Hermes',
    transport: 'acp',
    command: 'hermes-acp',
    acpArgs: [],
    onPath: true,
    version: '0.9.4',
    credentialHome: '~/.hermes/',
    credentialPresent: true,
    authFix: 'hermes auth add <provider> --type api-key',
    acpModelFlag: null,
    permissionSummary: 'hermes interactive approval prompts (bypass flags refused)',
    setup: [
      { ok: true, key: 'ob.pre.acpExtra' },
      { ok: false, key: 'ob.pre.mcpExtra', fix: 'uv pip install -e ".[acp,mcp]"' },
    ],
    startWith: 'hafleet acp-up',
  },
  {
    id: 'codex-acp',
    displayName: 'Codex (ACP)',
    transport: 'acp',
    command: 'codex-acp',
    acpArgs: [],
    onPath: true,
    version: '0.4.1',
    credentialHome: '~/.codex/',
    credentialPresent: true,
    authFix: 'codex login',
    acpModelFlag: null,
    permissionSummary: 'level2 (workspace-write + on-request)',
    setup: [],
    startWith: 'hafleet acp-up',
  },
  {
    id: 'claude',
    displayName: 'Claude Code',
    transport: 'tmux',
    command: 'claude',
    acpArgs: null,
    onPath: true,
    version: '2.1.8',
    credentialHome: '~/.claude/',
    credentialPresent: false,
    authFix: 'claude login',
    acpModelFlag: null,
    permissionSummary: 'auto-mode',
    setup: [],
    startWith: 'hafleet up',
  },
  {
    id: 'codex',
    displayName: 'Codex (tmux)',
    transport: 'tmux',
    command: 'codex',
    acpArgs: null,
    onPath: false,
    version: null,
    credentialHome: '~/.codex/',
    credentialPresent: true,
    authFix: 'codex login',
    acpModelFlag: null,
    permissionSummary: 'level2 (workspace-write + on-request)',
    setup: [],
    startWith: 'hafleet up',
  },
];

/**
 * Derive the one state that decides what the operator can do.
 *
 * Order matters: a framework that is not installed cannot be authenticated, and one
 * that is not authenticated will fail at first prompt however complete its setup is.
 * Reporting the furthest-along problem first would send someone to fix the wrong thing.
 */
export function detectState(f) {
  if (!f.onPath) return 'absent';
  if (!f.credentialPresent) return 'needs_auth';
  if (f.setup.some((s) => !s.ok)) return 'needs_setup';
  return 'ready';
}

/** Onboarding is only offered for a framework in `ready`. */
export function onboardable(list = detected) {
  return list.filter((f) => detectState(f) === 'ready');
}

/**
 * The exact command the form is equivalent to. Shown, not hidden: an operator has
 * to be able to reproduce and script what the page just did, and seeing the command
 * is also how you notice the form built the wrong one.
 */
export function onboardCommand({ name, workspace, framework, supervised, model }) {
  const f = detected.find((x) => x.id === framework);
  const parts = [f?.startWith ?? 'hafleet acp-up', name || '<name>', workspace || '<workspace>', framework];
  if (supervised && f?.transport === 'acp') parts.push('--supervised');
  if (model && f?.acpModelFlag) parts.push(f.acpModelFlag, model);
  return parts.join(' ');
}

// The backend API base, README's documented default and the `HAFLEET_API` default.
// A printed command needs a real host: `...` is not one, and this page's whole argument
// for showing the command is that the operator can run it.
export const API_BASE = 'http://127.0.0.1:8090';

/**
 * How a role is actually set, which acp-up cannot do.
 *
 * There is no `--role` flag on hafleet acp-up or hafleet up — grep says so. The field
 * lives on the registration call the agent makes for itself, so from a dashboard the
 * realistic path is a PATCH once the agent has registered.
 *
 * And the two endpoints are not symmetric: POST /api/agents destructures both `role`
 * and `capability`; PATCH /api/agents/:name destructures `role` only. So an existing
 * agent can be given a role but lands on ROLE_DEFAULT_TIER for it — a non-default tier
 * has to be set at registration, which no CLI path exposes either.
 *
 * The first version of this printed `curl -X PATCH .../api/agents/<name> -d '{...}'`,
 * which fails three ways and was caught by reading the server rather than the page:
 *
 *  - `...` is not a host. Nothing to copy.
 *  - **The Content-Type header is not optional.** backend-v2.js mounts a global
 *    `express.json()`, which parses nothing without it, so `role` arrives `undefined`.
 *    The handler guards every field with `if (role !== undefined)`, so the request is a
 *    200 that changed nothing — the worst possible outcome for a command whose purpose
 *    is to explain why the grid is empty.
 *  - Auth is conditional, so it is a note and not a printed flag: the global `/api`
 *    gate exempts local requests (`isLocalRequest`), and the per-agent `X-Agent-Token`
 *    check only bites when that agent has a token and the mode is not `audit`. Printing
 *    an `Authorization` header that the local case does not need is its own small lie.
 */
export function roleCommand({ name, role, capability }) {
  if (!role) return null;
  const body = { role };
  const patch = `curl -X PATCH ${API_BASE}/api/agents/${name || '<name>'}`
    + ` -H 'Content-Type: application/json'`
    + ` -d '${JSON.stringify(body)}'`;
  const tierNote = capability && capability !== ROLE_DEFAULT_TIER[role];
  return { patch, tierNotPatchable: Boolean(tierNote) };
}

// The four steps acp-up actually performs, in order. Named here so the page and the
// progress display cannot describe different work.
export const onboardSteps = [
  { id: 'refuse', label: 'ob.step.refuse' },
  { id: 'token', label: 'ob.step.token' },
  { id: 'register', label: 'ob.step.register' },
  { id: 'health', label: 'ob.step.health' },
];

// ── project board ─────────────────────────────────────────────────────────────
export const board = {
  group: 'acme-platform',
  groups: ['acme-platform', 'internal-tools'],
  totals: { members: 4, online: 3, working: 1, openTasks: 7, worktrees: 5, dirtyWorktrees: 2, specs: 8, localIssues: 3, remoteIssues: 5 },
  members: [
    { name: 'octos-agent', role: 'lead', online: true },
    { name: 'codex-agent', role: 'engineer', online: true },
    { name: 'hermes-agent', role: 'engineer', online: true },
    { name: 'codex-acp-agent', role: 'engineer', online: false },
  ],
  repos: [
    { repo: 'acme/api-service', branch: 'main', state: 'dirty' },
    { repo: 'acme/web-frontend', branch: 'feature/search', state: 'clean' },
    { repo: 'acme/worker', branch: 'main', state: 'dirty' },
    { repo: 'acme/infra', branch: 'main', state: 'clean' },
    { repo: 'acme/docs', branch: 'main', state: 'clean' },
  ],
  changes: [
    { title: 'Add pagination to /api/items', checksPassed: 2, checksTotal: 3 },
    { title: 'Update dependencies for the worker', checksPassed: 3, checksTotal: 3 },
    { title: 'Remove the deprecated endpoint', checksPassed: 2, checksTotal: 3 },
  ],
  activity: [
    { at: '01:22', who: 'octos-agent', what: 'accepted task tk_0044' },
    { at: '01:14', who: 'codex-agent', what: 'pushed to main on acme/worker' },
    { at: '00:51', who: 'hermes-agent', what: 'opened a change request on acme/api-service' },
  ],
};

// ── capacity ──────────────────────────────────────────────────────────────────
/*
 * Capacity is a LIVE SCHEDULER, not a read-only grid.
 *
 * POST /api/dispatch takes { role, capability } and has three outcomes:
 *   routed    — selectAgent() found a free agent in the cell; a lease is created
 *               (HAFLEET_DISPATCH_LEASE_TTL_MS, default 15 min, floor 1s) and the
 *               agent is marked busy until it expires or is released
 *   provision — no free agent, but MATRIX_AGENT_MAX_PER_CELL > 0 and the cell is
 *               under cap, so a plan comes back (mx_<role>_<tier>_<n>) for the
 *               launcher to run up-v1. Default 0 = off.
 *   queued    — otherwise a ticket joins that cell's dispatch queue
 *
 * GET /api/pool reaps expired leases before answering, and an expired lease raises
 * the `dispatch_lease_expired` alert. So the grid, the leases and Alerts are one
 * mechanism, and Capacity is the human window onto it.
 *
 * Note the collision: this per-cell DISPATCH queue is not /api/queue, which holds
 * messages waiting for an agent to go idle. Two different queues, one word.
 */
export const dispatch = {
  leaseTtlMinutes: 15,          // DEFAULT_TTL_MS in src/dispatch-lease-store.mjs
  autoProvisionCap: 0,          // MATRIX_AGENT_MAX_PER_CELL; 0 means pure queue
};

// ── the dispatch pool ─────────────────────────────────────────────────────────
// Axes copied verbatim from lib/matrix-agent.js. An earlier fixture invented
// `shell/git/web/browser` × `coder/reviewer/researcher/operator`, which is not the
// model at all — and worse, it invented populated data, so a feature that has never
// been connected looked like a working scheduler. check-invariants.mjs now reads the
// real module and fails if these two lists drift from it.
//
// Roles are COLUMNS and tiers are ROWS, matching pool-page.js. The tiers are ordered:
// a stronger idle agent can stand in for a weaker request, but only within the same
// role — selectAgent() filters on `agentRole(a) === role` before it ever looks at the
// tier, so `strong` never covers a different column.
export const ROLES = ['architect', 'coding', 'testing', 'review', 'integration', 'documentation'];
export const CAPABILITY_TIERS = ['strong', 'medium', 'lightweight'];

// What each tier launches as (lib/matrix-agent.js TIER_RUNTIME) — shown so the grid
// says what a cell would cost, not just whether it is staffed.
export const TIER_RUNTIME = {
  strong: 'claude · opus',
  medium: 'claude · sonnet',
  lightweight: 'claude · haiku',
};

// The tier a role is staffed at unless a dispatch asks for another (ROLE_DEFAULT_TIER).
export const ROLE_DEFAULT_TIER = {
  architect: 'strong',
  review: 'strong',
  coding: 'medium',
  testing: 'medium',
  integration: 'medium',
  documentation: 'lightweight',
};

// ══ the role registry ════════════════════════════════════════════════════════
/*
 * A role is NOT a label the scheduler matches on. It is a job description the PDU
 * manager writes, and it composes a minimum tier with required skills.
 *
 * This is a generalisation of what ships, not a rewrite: today's model is exactly
 * the case where every role has skills = []. Two facts from reading the source,
 * both surprising:
 *
 *  - ROLES in lib/matrix-agent.js is NEVER IMPORTED BY THE BACKEND. Its only
 *    consumers are its own unit test and this checker. agentRole() returns
 *    agent.role verbatim, unvalidated — so user-defined role strings already route
 *    end to end, and data/agents.json's three `worker-*` records prove it.
 *  - capability IS validated, against CAPABILITY_TIERS, in agentCapability() and
 *    resolveTier(). Tiers are real; roles are documentation that reads like a
 *    constraint.
 *
 * So the missing piece is a REGISTRY: somewhere the definition lives, so a
 * catalogue can be rendered, a write validated, and `coding` / `codeing` stopped
 * from becoming two roles that silently never match.
 */

// Skills need a controlled vocabulary in the same registry, or node / nodejs /
// Node.js fragment the pool inside a week. Nothing in the backend observes what an
// agent is good at, so every one of these is ASSERTED by a human, never measured.
export const SKILL_VOCABULARY = [
  'requirement-analysis', 'prd-writing', 'acceptance-criteria',
  'system-design', 'api-design', 'integration-design', 'perf-analysis',
  'code-review', 'implementation', 'test-design', 'e2e',
  'ci-cd', 'packaging', 'docs', 'release-notes', 'content',
];

// The PDT lifecycle. Carried on the role so the SOLID line can compute a staffing
// gap — "this project has nobody at the testing stage" — which neither lens can
// answer alone. Ordered, because a gap early is worse than a gap late.
export const LIFECYCLE_STAGES = ['prd', 'spec', 'coding', 'testing', 'release', 'mo'];

/*
 * Seven templates. Add, modify, delete — all of it the manager's.
 *
 * KEY AND NAME ARE SEPARATE FIELDS, and that is what resolves the mismatch between
 * the code's six role strings and the manager's org chart. `key` is the wire value
 * POST /api/dispatch and agentRole() already use; `name` is the manager's word. So
 * renaming Coding to Coder costs nothing, and only a genuinely new role mints a key.
 *
 * `wireNew` marks the two keys the scheduler has never had a word for — the honest
 * signal that Product Manager and System Engineer are new capability, not renames.
 */
export const roles = [
  {
    key: 'product-manager', name: 'Product Manager', minTier: 'strong', stage: 'prd',
    skills: ['requirement-analysis', 'prd-writing', 'acceptance-criteria'],
    fromTemplate: true, wireNew: true,
  },
  {
    key: 'architect', name: 'Architect', minTier: 'strong', stage: 'spec',
    skills: ['system-design', 'api-design'], fromTemplate: true,
  },
  {
    key: 'system-engineer', name: 'System Engineer', minTier: 'strong', stage: 'spec',
    // Code review is the SE's responsibility, so it is a skill here rather than a
    // job of its own. That is why there is no Reviewer role — see retiredRoles.
    skills: ['system-design', 'integration-design', 'perf-analysis', 'code-review'],
    fromTemplate: true, wireNew: true,
  },
  {
    key: 'coding', name: 'Coder', minTier: 'medium', stage: 'coding',
    skills: ['implementation'], fromTemplate: true,
  },
  {
    key: 'testing', name: 'Tester', minTier: 'medium', stage: 'testing',
    skills: ['test-design', 'e2e'], fromTemplate: true,
  },
  {
    key: 'integration', name: 'Release Engineer', minTier: 'medium', stage: 'release',
    skills: ['ci-cd', 'packaging'], fromTemplate: true,
  },
  {
    // Named Marketing while keeping key `documentation` — exactly what the key/name
    // split is for, at zero compatibility cost. But raising the floor from the code's
    // ROLE_DEFAULT_TIER.documentation ('lightweight') to 'medium' is a NARROWING, and
    // it strands claude-agent, which is allocated here at lightweight. That employee
    // is rendered with the failing clause named rather than dropped — the rule and
    // its first live instance, shipping together.
    key: 'documentation', name: 'Marketing / Tech Writer', minTier: 'medium', stage: 'mo',
    skills: ['docs', 'release-notes', 'content'], fromTemplate: true,
    narrowedFrom: 'lightweight',
  },
];

/*
 * Deleting a role is not free, and this is where the registry earns its keep.
 *
 * `review` is a LIVE WIRE VALUE: POST /api/dispatch {role:'review'} routes today, and
 * canonicalRole() mints it from any agent name containing `review` or `final_reviewer`
 * (lib/matrix-agent.js:48-49). Deleting the role outright would send those dispatches
 * to a cell that can never be staffed — queued forever, with no diagnosis, which is
 * precisely the failure the empty pool already taught us to catch.
 *
 * So delete has a companion: a retired key aliases to a live one. Old callers keep
 * routing, to the bench that now owns the work, and the console SHOWS the alias
 * rather than hiding it. Without this, "users can delete roles" means "users can
 * silently break dispatch".
 */
export const retiredRoles = [
  { key: 'review', aliasTo: 'system-engineer', retiredAt: '2026-08-05' },
];

/** Follow at most one alias hop. The only way any page or dispatch read reaches a role. */
export function resolveRoleKey(key) {
  if (!key) return null;
  if (roles.some((r) => r.key === key)) return key;
  const retired = retiredRoles.find((r) => r.key === key);
  return retired?.aliasTo ?? null;
}

export function roleOf(key) {
  const resolved = resolveRoleKey(key);
  return roles.find((r) => r.key === resolved) ?? null;
}

/** Roles present in agent data that nobody defined — the `worker` case, live today. */
export function unregisteredRoleKeys(keys) {
  return [...new Set(keys.filter(Boolean))].filter((k) => resolveRoleKey(k) === null);
}

export const TIER_RANK = { lightweight: 0, medium: 1, strong: 2 };

/*
 * FLOOR for routing, FIX for accounting.
 *
 * Floor: a stronger worker still satisfies a weaker role. That is what selectAgent()
 * already implements (lib/matrix-agent.js:88-93), and it already blunts the cost
 * objection by sorting eligible workers cheapest-sufficient-first. It also keeps the
 * catalogue the size the manager drew it — under FIX, tier is part of identity, so
 * Coder and Senior Coder must be separate roles and the chart grows toward 3x.
 *
 * Fix: floor's one real defect is that substitution is INVISIBLE — the work gets done
 * and the bill is quietly larger. So `tierDelta` comes back on every result and the
 * console renders both tiers wherever it is non-zero. One column, no new data.
 *
 * Returns a RESULT, not a boolean. A bare boolean forces every call site to recompute
 * the reason, which is how lib/project-board.js ended up with two status vocabularies.
 */
export function satisfies(worker, role) {
  if (!role) return { ok: false, failedClause: 'noRole', tierDelta: 0, missingSkills: [] };
  const have = TIER_RANK[worker.capability] ?? -1;
  const need = TIER_RANK[role.minTier] ?? 0;
  const missingSkills = role.skills.filter((s) => !(worker.skills ?? []).includes(s));
  // Tier is reported first because it is the one an operator can fix by re-launching
  // the agent; a missing skill needs a different employee.
  const failedClause = have < need ? 'tier' : missingSkills.length ? 'skills' : null;
  return {
    ok: failedClause === null,
    failedClause,
    tierDelta: Math.max(0, have - need),
    missingSkills,
  };
}

/*
 * Two pool states, because the honest one alone teaches nothing about the layout.
 *
 * `unassigned` is what this fleet actually returns today: every cell empty. Verified,
 * not assumed — canonicalRole() infers a role from substrings in the agent name
 * (architect / review / test / integrat / doc / coder), and octos-agent, codex-agent,
 * hermes-agent, codex-acp-agent and claude-agent match none of them. agentRole()
 * returns null and indexPool() skips the record outright, so grid is {} and total is 0.
 *
 * `assigned` is the same fleet with role and capability set at registration — which
 * POST /api/agents already accepts and no onboarding path sends.
 */
export const pool = {
  unassigned: {
    // `total` is GET /api/pool's own field, and it counts POOL RECORDS, not agents that
    // landed in the grid: `total: records.length`. On this fleet that is 5 while `grid`
    // is `{}`. The first version of this fixture set it to 0 and the page derived its
    // empty state from it — which would mean the empty state never renders against the
    // real endpoint, on exactly the fleet it was written for. Emptiness is a property of
    // the cells, so gridTotal() reads the cells.
    total: 5,
    cells: {},                       // role -> tier -> [{ name, busy }]
    unassignedAgents: ['octos-agent', 'codex-agent', 'hermes-agent', 'codex-acp-agent', 'claude-agent'],
    // No leases are possible here, and that is not a detail. A lease only exists
    // because selectAgent() returned an agent, and it cannot return one when every
    // record has role=null. A page showing an empty grid above a populated lease table
    // would contradict itself, so the two live in the same object.
    leases: [],
    queuedTickets: [
      { ticket: 'disp-1785734-14', role: 'architect', capability: 'strong', waiting: '4m' },
      { ticket: 'disp-1785734-15', role: 'documentation', capability: 'lightweight', waiting: '1m' },
      { ticket: 'disp-1785734-16', role: 'coding', capability: 'medium', waiting: '38s' },
    ],
  },
  assigned: {
    total: 5,
    cells: {
      coding: { medium: [{ name: 'octos-agent', busy: true }, { name: 'codex-agent', busy: false }] },
      review: { strong: [{ name: 'codex-acp-agent', busy: false }] },
      testing: { medium: [{ name: 'hermes-agent', busy: true }] },
      documentation: { lightweight: [{ name: 'claude-agent', busy: false }] },
    },
    unassignedAgents: [],
    // Every leased agent must also read busy in its cell above, or the grid and the
    // table disagree about the same fact.
    leases: [
      { leaseId: 'ls_3391', agent: 'octos-agent', role: 'coding', capability: 'medium', owner: 'openfab', expiresIn: '11m' },
      { leaseId: 'ls_3388', agent: 'hermes-agent', role: 'testing', capability: 'medium', owner: 'openfab', expiresIn: '2m' },
    ],
    queuedTickets: [
      { ticket: 'disp-1785734-17', role: 'architect', capability: 'strong', waiting: '3m' },
    ],
  },
};

/** Agents a state reports as leased, keyed by name — used to cross-check the grid. */
export function leasedAgents(state) {
  return new Set(state.leases.map((l) => l.agent));
}

/** Agents the grid reports as busy. Must equal leasedAgents(); the checker asserts it. */
export function busyAgents(state) {
  return new Set(
    Object.values(state.cells)
      .flatMap((byTier) => Object.values(byTier).flat())
      .filter((a) => a.busy)
      .map((a) => a.name),
  );
}

/** Agents in a cell, or [] — the grid is sparse, so every read goes through this. */
export function cellAgents(state, role, tier) {
  return state.cells[role]?.[tier] ?? [];
}

/**
 * How many agents the GRID holds, which is not `state.total`.
 *
 * `/api/pool` reports `total: records.length` — every pool record, including the ones
 * indexPool() skipped for having no role. So this is the number the empty state turns on.
 */
export function gridTotal(state) {
  return Object.values(state.cells)
    .flatMap((byTier) => Object.values(byTier).flat())
    .length;
}

/**
 * Which tier would actually serve a dispatch for (role, tier) — or null.
 *
 * Mirrors selectAgent(): same role, idle, at a tier no weaker than requested, and
 * cheapest sufficient first, so a `strong` agent is not spent on `lightweight` work.
 * Returning the tier rather than a boolean is what lets a covered-but-empty cell say
 * `↑ strong` instead of a bare arrow whose meaning lives in a tooltip.
 */
export function coveringTier(state, role, tier) {
  const rank = { lightweight: 0, medium: 1, strong: 2 };
  return CAPABILITY_TIERS
    .filter((t) => rank[t] >= rank[tier])
    .sort((a, b) => rank[a] - rank[b])
    .find((t) => cellAgents(state, role, t).some((a) => !a.busy)) ?? null;
}

/**
 * Could a dispatch for (role, tier) actually route right now?
 *
 * The old page implied a cell was the unit of availability, so an empty `lightweight`
 * cell read as "cannot dispatch" even when an idle `strong` agent in the same role
 * covers it. One implementation, so the boolean and the tier cannot disagree.
 */
export function routable(state, role, tier) {
  return coveringTier(state, role, tier) !== null;
}

// ── config ────────────────────────────────────────────────────────────────────
export const presets = [
  { id: 'ps_01', name: 'codex-default', framework: 'codex', model: 'gpt-5-codex' },
  { id: 'ps_02', name: 'octos-coding-full', framework: 'octos', model: 'claude-opus-5' },
  { id: 'ps_03', name: 'hermes-deepseek', framework: 'hermes', model: 'deepseek-v4-flash' },
];

/*
 * No credential store. An agent authenticates itself before joining the fleet —
 * hermes via `hermes auth add`, codex and claude via their own logins, octos via
 * its config file — and HAFleet never holds the secret. An earlier draft of this
 * prototype had a Credentials panel on Config; it was invented. The real
 * config-page.js has no credentials endpoint, only /api/agents and
 * /api/framework-presets.
 *
 * What HAFleet legitimately knows is whether an agent RESOLVED a provider, because
 * failing to is the most common reason onboarding fails — hermes reported healthy
 * and then crash-looped 35 times on a missing provider.
 */
export const providerHomes = {
  hermes: { home: '~/.hermes/', fix: 'hermes auth add <provider>' },
  codex: { home: '~/.codex/', fix: 'codex login' },
  'codex-acp': { home: '~/.codex/', fix: 'codex login' },
  claude: { home: '~/.claude/', fix: 'claude login' },
  octos: { home: '~/.config/octos/config.json', fix: 'edit octos config.json' },
};

// ── the agent log Activity renders ────────────────────────────────────────────
// Line kinds are the real ones the ACP host writes. Framework passthrough is
// collapsed because the real log is saturated with ANSI escapes and detail.
export const agentLog = {
  'octos-agent': {
    source: 'log',
    lines: [
      { at: '01:22:19', kind: 'nudging', text: '1 unread' },
      { at: '01:22:20', kind: 'tools', text: 'check_inbox [completed], send_message [completed]' },
      { at: '01:22:21', kind: 'turn', text: 'finished (end_turn)' },
      { at: '01:22:21', kind: 'framework', text: '12 lines of framework output', collapsed: 12 },
      { at: '01:22:21', kind: 'agent', text: 'PARITY2' },
      { at: '01:14:00', kind: 'turn', text: 'finished (end_turn)' },
      { at: '01:13:59', kind: 'agent', text: 'POST-DEPLOY' },
    ],
  },
  'hermes-agent': {
    source: 'log',
    lines: [
      { at: '00:38:09', kind: 'tools', text: 'mcp__hafleet__send_message [completed]' },
      { at: '00:38:09', kind: 'turn', text: 'finished (end_turn)' },
      { at: '00:38:09', kind: 'agent', text: 'HERMES-LIVE' },
    ],
  },
  'codex-acp-agent': {
    source: 'log',
    lines: [
      { at: '01:22:31', kind: 'turn', text: 'finished (end_turn)' },
      { at: '01:22:30', kind: 'agent', text: 'PARITY2' },
    ],
  },
  'codex-agent': { source: 'pane', lines: [] },
  'claude-agent': { source: 'pane', lines: [] },
};

// ── derived helpers ───────────────────────────────────────────────────────────

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

export const isOpenTask = (t) => t.status !== 'done';

const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 };
const BUCKET_RANK = { blocked: 0, in_progress: 1, accepted: 2, created: 3, done: 4 };
const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** Most severe first, then oldest. The overview's whole job is ranking. */
export function bySeverityThenAge(a, b) {
  const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  return s !== 0 ? s : b.ageSec - a.ageSec;
}

/** Blocked first, then priority, then overdue, then oldest. */
export function byBlockedFirst(a, b) {
  const bucket = BUCKET_RANK[a.status] - BUCKET_RANK[b.status];
  if (bucket !== 0) return bucket;
  const pri = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (pri !== 0) return pri;
  if (a.status === 'blocked' && a.overdue !== b.overdue) return a.overdue ? -1 : 1;
  return a.updated_at < b.updated_at ? -1 : 1;
}

export function alertCounts() {
  const byStatus = Object.fromEntries(ALERT_STATUSES.map((s) => [s, 0]));
  for (const a of alerts) byStatus[a.status] += 1;
  // Severity counts the OPEN set only. Round 2: mixing statuses with a severity
  // in one strip encodes two dimensions as if they were one.
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const a of alerts) if (a.status === 'open') bySeverity[a.severity] += 1;
  return { byStatus, bySeverity };
}

export function railCounts() {
  const { byStatus } = alertCounts();
  return {
    alertsOpen: byStatus.open,
    tasksOpen: tasks.filter(isOpenTask).length,
    projectGroups: board.groups.length,
    queued: queue.length,
    // How many frameworks this host can actually onboard — the count an operator
    // checks before opening the page, which is the whole point of a rail pill.
    frameworksReady: onboardable().length,
    hired: agents.length,
    assignmentsQueued: assignments.filter((a) => a.state === 'queued').length,
    proposalsWaiting: knowledge.proposals.length,
    flagged: perfRows().filter((r) => r.flagged).length,
    // The rail states the LIVE fleet, never the projected one, so the pill cannot
    // disagree with itself depending on which ?view= the reader happens to be on.
    // Zero, and labelled `bridged` so the denominator is not left to be guessed:
    // data/groups.json does not exist, so /api/project-board answers with no
    // projects at all until the customer's room is bridged.
    projectsBridged: 0,
    rolesDefined: roles.length,
  };
}

// ══ the workforce model ══════════════════════════════════════════════════════
/*
 * HAFleet is a resource plane: it connects agents, classifies them, staffs them,
 * watches them on duty, assesses them and develops them. The fixtures below are
 * the console's read model for those six functions.
 *
 * They are derived from `pool.assigned` rather than invented beside it, because
 * the invariant that leased agents equal busy cells has already caught one
 * version of this page contradicting itself. DEPLOYED means "holds a lease";
 * IDLE means "in a cell, no lease"; UNASSIGNED means role=null.
 */

/** Which cell an agent sits in, or null when registration never gave it a role. */
function cellOf(state, name) {
  for (const [role, byTier] of Object.entries(state.cells)) {
    for (const [tier, list] of Object.entries(byTier)) {
      if (list.some((a) => a.name === name)) return { role, tier };
    }
  }
  return null;
}

// Seats are the commercial resource, and they are NOT the agent: two agents on
// one credential home draw on one subscription window. The console counts the
// seat once, which an agent-keyed model cannot do.
export const seats = [
  {
    id: 'claude·max·01', provider: 'claude', plan: 'plan', boundTo: ['claude-agent'],
    window: '5h rolling', resetsIn: '3h12m', headroom: 74,
  },
  {
    id: 'hermes·plan·01', provider: 'hermes', plan: 'plan', boundTo: ['hermes-agent'],
    window: '5h rolling', resetsIn: '47m', headroom: 4,
  },
  {
    id: 'codex·api·01', provider: 'codex', plan: 'api', boundTo: ['octos-agent', 'codex-agent'],
    window: null, resetsIn: null, headroom: null,
  },
];

export function seatOf(name) {
  return seats.find((s) => s.boundTo.includes(name)) ?? null;
}

/*
 * Per-employee utilisation and accrued cost. `null` means not measured — never 0.
 *
 * `capability` and `skills` are what the worker HAS; a role declares what it NEEDS.
 * Every skill here is asserted by a human — nothing in the backend observes them, and
 * the field does not exist upstream at all (zero occurrences of `skills` across
 * backend-v2.js, lib/ and src/). The console labels them as claims for that reason.
 */
const EMPLOYEE_FACTS = {
  'octos-agent': {
    util7d: 68, costToday: 12.4, provenance: 'reported', qualifiedAgo: '2d',
    capability: 'strong', skills: ['system-design', 'api-design', 'implementation'],
  },
  'hermes-agent': {
    util7d: 54, costToday: null, provenance: 'plan', qualifiedAgo: '2d',
    capability: 'medium', skills: ['test-design', 'e2e'],
  },
  'codex-agent': {
    util7d: 31, costToday: 0, provenance: 'reported', qualifiedAgo: '2d',
    capability: 'medium', skills: ['implementation'],
  },
  'claude-agent': {
    util7d: 22, costToday: 1.85, provenance: 'reported', qualifiedAgo: '9d',
    capability: 'lightweight', skills: ['docs', 'release-notes', 'content'],
  },
  'codex-acp-agent': {
    util7d: null, costToday: null, provenance: null, qualifiedAgo: null,
    capability: 'strong', skills: ['system-design', 'integration-design', 'perf-analysis', 'code-review'],
  },
};

/*
 * Allocation: the manager takes a worker out of the pool and gives it a role.
 *
 * Deliberately NOT derived from pool.assigned.cells — that grid is keyed on the raw
 * role string, and one of these allocations uses a retired key on purpose. This is
 * the record the act produces, and the grid is a projection of it.
 *
 * The five rows are chosen to exercise every branch of satisfies():
 *   octos-agent      strong on Coder (min medium) → tierDelta 1, over-qualified
 *   codex-agent      medium on Coder              → exact
 *   hermes-agent     medium on Tester             → exact
 *   codex-acp-agent  allocated to the RETIRED key `review` → resolves to System Engineer
 *   claude-agent     lightweight on Marketing (min medium) → FAILS the tier clause,
 *                    because raising that floor narrowed the role underneath it
 */
export const allocations = [
  { agent: 'octos-agent', roleKey: 'coding', by: '@mei:hq', at: '2d ago' },
  { agent: 'codex-agent', roleKey: 'coding', by: '@mei:hq', at: '2d ago' },
  { agent: 'hermes-agent', roleKey: 'testing', by: '@mei:hq', at: '2d ago' },
  { agent: 'codex-acp-agent', roleKey: 'review', by: '@mei:hq', at: '9d ago' },
  { agent: 'claude-agent', roleKey: 'documentation', by: '@mei:hq', at: '9d ago' },
];

/** The worker record the registry reasons about: what this employee has to offer. */
export function workerOf(name) {
  const facts = EMPLOYEE_FACTS[name] ?? {};
  return { agent: name, capability: facts.capability ?? null, skills: facts.skills ?? [] };
}

/**
 * One row per allocated worker, carrying the match result.
 *
 * `view` follows the same honest/projected split as the rest of the console: nobody
 * is allocated on this fleet, so the default returns nothing and the pages say why.
 */
export function allocationRows(view = 'unassigned') {
  if (view !== 'assigned') return [];
  return allocations.map((a) => {
    const role = roleOf(a.roleKey);
    const worker = workerOf(a.agent);
    return {
      ...a,
      role,
      worker,
      // The alias is shown, never hidden: an allocation written against `review`
      // still reads as `review → system-engineer` wherever it appears.
      aliased: role && role.key !== a.roleKey ? { from: a.roleKey, to: role.key } : null,
      match: satisfies(worker, role),
    };
  });
}

/**
 * The authored org chart: one entry per registered role.
 *
 * `eligible` is the point of the honest view. An empty grid taught nothing; this says
 * "you have five workers and here is which roles they would satisfy, unallocated" —
 * which turns 分类 from an invisible registration field into one click of work.
 */
export function orgGroups(view = 'unassigned') {
  const allocated = allocationRows(view);
  return roles.map((role) => {
    const mine = allocated.filter((a) => a.role?.key === role.key);
    const takenBy = new Set(allocated.map((a) => a.agent));
    /*
     * `qualified` ignores who is already allocated; `eligible` does not. The two must
     * stay separate, because an unfilled role has three different causes needing three
     * different actions, and the first version of this collapsed them into one:
     *
     *   allocatable — somebody free satisfies it. One click.
     *   contended   — somebody satisfies it, but they are all allocated elsewhere.
     *                 A priority call, not a hiring one.
     *   unhireable  — nobody in the fleet satisfies it at all. Go and hire.
     *
     * Treating "already allocated" as "nobody qualifies" reported Architect as a
     * hiring gap while an architect-capable employee sat one row above, allocated
     * to Coder — which would send someone out to buy capacity they already own.
     */
    const qualified = agents
      .map((a) => ({ agent: a.name, match: satisfies(workerOf(a.name), role) }))
      .filter((x) => x.match.ok);
    const eligible = qualified.filter((x) => !takenBy.has(x.agent));
    const staff = workforce(view);
    const deployed = mine.filter((a) => staff.find((s) => s.name === a.agent)?.lease).length;
    return {
      role,
      allocated: mine,
      qualified,
      eligible,
      deployed,
      idle: mine.length - deployed,
      stranded: mine.filter((a) => !a.match.ok),
      overQualified: mine.filter((a) => a.match.tierDelta > 0),
      gap: mine.length > 0 ? null
        : eligible.length ? 'allocatable'
          : qualified.length ? 'contended'
            : 'unhireable',
    };
  });
}

/** Roles carried by live agent data that the registry never defined. */
export function unregisteredGroups(view = 'unassigned') {
  const keys = view === 'assigned' ? allocations.map((a) => a.roleKey) : [];
  return unregisteredRoleKeys(keys);
}

/** Workers with no allocation — the bucket the Allocate action works from. */
export function unallocatedWorkers(view = 'unassigned') {
  const taken = new Set(allocationRows(view).map((a) => a.agent));
  return agents.filter((a) => !taken.has(a.name)).map((a) => {
    const worker = workerOf(a.name);
    return {
      ...worker,
      // Which roles this worker could take right now. A worker eligible for nothing
      // is a different problem from one nobody has got round to allocating.
      eligibleFor: roles.filter((r) => satisfies(worker, r).ok).map((r) => r.key),
    };
  });
}

/**
 * One row per employee, answering the five standing questions at a glance:
 * 在干什么 · 给谁干 · 干到什么地步 · 成本开支 · 健康状态.
 *
 * Every absent value carries a reason key. A zero would claim a measurement that
 * was never taken, which is the failure the empty Capacity grid was built to avoid.
 */
/*
 * `view` is 'unassigned' (the truth on this fleet) or 'assigned' (the same five
 * employees as if registration had classified them).
 *
 * The first build of this page read `pool.assigned` unconditionally, so the home
 * route rendered the hypothetical fleet as though it were live — every employee
 * qualified, two deployed, nothing unstaffable. That is exactly the failure the
 * Capacity page was rebuilt to avoid, reintroduced one route over: an implementer
 * would conclude that a fresh install produces a staffed roster. It does not.
 * The honest view is the default here for the same reason it is there.
 */
export function workforce(view = 'unassigned') {
  const state = pool[view] ?? pool.unassigned;
  return agents.map((a) => {
    const cell = cellOf(state, a.name);
    const lease = state.leases.find((l) => l.agent === a.name) ?? null;
    const asn = cell
      ? assignments.find((x) => x.agent === a.name && x.state !== 'queued') ?? null
      : null;
    const facts = EMPLOYEE_FACTS[a.name] ?? {};
    const seat = seatOf(a.name);
    const live = Boolean(cell);
    return {
      ...a,
      ...facts,
      cell,
      lease,
      assignment: asn,
      seat,
      state: !cell ? 'unassigned' : lease ? 'deployed' : 'idle',
      // An unclassified employee has no measured work, so its figures are absent
      // with a reason rather than carried over from the hypothetical view.
      util7d: live ? facts.util7d : null,
      costToday: live ? facts.costToday : null,
      qualifiedAgo: live ? facts.qualifiedAgo : null,
      blankReason: !cell ? 'wf.reason.noRole' : null,
    };
  });
}

export function workforceCounts(view = 'unassigned') {
  const w = workforce(view);
  return {
    hired: w.length,
    deployed: w.filter((x) => x.state === 'deployed').length,
    idle: w.filter((x) => x.state === 'idle').length,
    unassigned: w.filter((x) => x.state === 'unassigned').length,
    qualified: w.filter((x) => x.cell).length,
  };
}

// ══ assignments ══════════════════════════════════════════════════════════════
/*
 * One request from a Matrix project room becomes one durable assignment. The
 * lifecycle is visible because a queued request that says only "queued" is a
 * backlog; one that names the constraint it failed is a diagnosis.
 *
 * `acceptance_pending` renders as a state and never as a button: accepting
 * delivery is the customer's act, in the room.
 */
export const assignments = [
  {
    id: 'as_0231', project: 'api-service', room: '#api-service · spec 群', requester: '@lin:hq', workItem: 'wi_0044',
    role: 'coding', capability: 'medium', state: 'executing', generation: 1,
    agent: 'octos-agent', since: '11m', leaseLeft: '11m',
    title: 'Add pagination to /api/items',
  },
  {
    id: 'as_0229', project: 'api-service', room: '#api-service · 测试群', requester: '@lin:hq', workItem: 'wi_0039',
    role: 'testing', capability: 'medium', state: 'executing', generation: 1,
    agent: 'hermes-agent', since: '2m', leaseLeft: '2m',
    title: 'System tests for the pagination contract',
  },
  {
    id: 'as_0226', project: 'docs-portal', room: '#docs-portal · PRD 群', requester: '@mei:hq', workItem: 'wi_0051',
    role: 'documentation', capability: 'lightweight', state: 'acceptance_pending', generation: 1,
    agent: 'claude-agent', since: '22m', leaseLeft: null,
    title: 'Rewrite the onboarding page for the new flow',
  },
  {
    id: 'as_0234', project: 'api-service', room: '#api-service · spec 群', requester: '@lin:hq', workItem: 'wi_0055',
    role: 'architect', capability: 'strong', state: 'queued', waiting: '4m',
    blocked: 'as.blocked.noRole', agent: null,
    title: 'Design the assignment ingress contract',
  },
  {
    id: 'as_0233', project: 'docs-portal', room: '#docs-portal · release 群', requester: '@mei:hq', workItem: 'wi_0056',
    role: 'integration', capability: 'medium', state: 'queued', waiting: '1m',
    blocked: 'as.blocked.noRole', agent: null,
    title: 'Wire the release pipeline to the new gate',
  },
  {
    id: 'as_0232', project: 'api-service', room: '#api-service · 测试群', requester: '@lin:hq', workItem: 'wi_0057',
    role: 'testing', capability: 'medium', state: 'queued', waiting: '38s',
    blocked: 'as.blocked.allBusy', agent: null,
    title: 'Regression sweep before the release cut',
  },
];

export const ASSIGNMENT_STATES = ['executing', 'acceptance_pending', 'queued'];

// ══ projects — the SOLID line ════════════════════════════════════════════════
/*
 * A project IS a group. That is not a modelling choice made here, it is what the
 * backend already does: buildProjectBoardSnapshot() maps `groups` (minus the
 * reserved `info`) to projects and hangs worktrees, repositories, specs, local and
 * remote issues, change requests, five task lanes and activity off each one
 * (lib/project-board.js:462-545).
 *
 * So the reviewer's "Project -> backlog / issues / pr" is already ~80% present in
 * the API and was simply never rendered: specs are the backlog, localIssues +
 * remoteIssues are the issues, changeRequests are the PRs. HAFleet READS them out
 * of worktrees. It does not own them, and it must never offer to edit them — the
 * same rule that makes acceptance a state and never a button.
 *
 * THIS FLEET HAS ZERO PROJECTS. `groups = loadJsonSync('groups.json', {})`
 * (backend-v2.js:2906) and data/groups.json does not exist, so /api/project-board
 * answers with none at all. Groups are written by the Matrix bridge — every mutating
 * route is behind requireBridgeSecret — so a project appears when the customer's
 * room is bridged, which is a fact about ownership, not an empty database.
 */
export const projects = [
  {
    key: 'api-service', room: '#api-service', owner: '@lin:hq',
    members: ['octos-agent', 'codex-agent', 'hermes-agent'],
    summary: { worktrees: 3, dirtyWorktrees: 2, specs: 5, localIssues: 2, remoteIssues: 3, changeRequests: 2 },
    repos: [
      { repo: 'acme/api-service', branch: 'main', state: 'dirty' },
      { repo: 'acme/worker', branch: 'main', state: 'dirty' },
    ],
    changeRequests: [
      { title: 'Add pagination to /api/items', checksPassed: 2, checksTotal: 3 },
      { title: 'Update dependencies for the worker', checksPassed: 3, checksTotal: 3 },
    ],
    activity: [
      { at: '01:22', who: 'octos-agent', what: 'accepted task tk_0044' },
      { at: '01:14', who: 'codex-agent', what: 'pushed to main on acme/worker' },
    ],
  },
  {
    key: 'docs-portal', room: '#docs-portal', owner: '@mei:hq',
    members: ['claude-agent'],
    summary: { worktrees: 2, dirtyWorktrees: 0, specs: 3, localIssues: 1, remoteIssues: 2, changeRequests: 1 },
    repos: [{ repo: 'acme/docs', branch: 'main', state: 'clean' }],
    changeRequests: [{ title: 'Remove the deprecated endpoint', checksPassed: 2, checksTotal: 3 }],
    activity: [{ at: '00:51', who: 'claude-agent', what: 'opened a change request on acme/docs' }],
  },
];

export function projectOf(key) {
  return projects.find((p) => p.key === key) ?? null;
}

// ══ the join ═════════════════════════════════════════════════════════════════
/*
 * One implementation per fact, three slices. Two would drift the way routable()
 * drifted from coveringTier() before they were unified.
 *
 * `dim` is 'project' | 'role' | 'agent'. Every page in both lenses reads through
 * these, so the PDT view and the PDU view can never disagree about the same number.
 */
export function engagementsBy(dim, key, view = 'unassigned') {
  const rows = view === 'assigned' ? assignments : [];
  // A null key means "every row, whatever its value on this axis" — which is how
  // costBy() asks for the whole slice. Treating null as a value to match against
  // returned nothing, so every Cost section read "nothing to price" next to a
  // populated People table on the same page.
  if (key === null || key === undefined) return rows;
  if (dim === 'project') return rows.filter((a) => a.project === key);
  if (dim === 'role') return rows.filter((a) => resolveRoleKey(a.role) === key);
  if (dim === 'agent') return rows.filter((a) => a.agent === key);
  return rows;
}

/**
 * Spend, sliced. Every amount carries provenance and a plan seat reports `unknown`
 * with its reason rather than a zero — the distinction the whole cost model turns on.
 *
 * Per-project attribution is NOT derivable from the backend today: a lease carries no
 * project, and a dispatch ticket's `room` is optional and never read back. So these
 * are illustrative, and the pages say so.
 */
export function costBy(dim, view = 'unassigned') {
  const out = new Map();
  for (const row of engagementsBy(dim, null, view)) {
    // No agent means the work has not started. That is a different fact from a plan
    // seat that cannot be priced, and folding the two together reported a project as
    // `unknown` while its only active employee was reporting a real number.
    if (!row.agent) continue;
    const facts = EMPLOYEE_FACTS[row.agent] ?? {};
    const key = dim === 'project' ? row.project
      : dim === 'role' ? resolveRoleKey(row.role)
        : row.agent;
    if (!key) continue;
    const prev = out.get(key) ?? { key, amount: 0, provenance: 'reported', unpriced: 0 };
    if (facts.costToday === null || facts.costToday === undefined) {
      prev.unpriced += 1;
      prev.provenance = 'unknown';
    } else {
      prev.amount += facts.costToday;
    }
    out.set(key, prev);
  }
  return [...out.values()];
}

/** Assessment, sliced the same way, so a role total and a project total share one source. */
export function perfBy(dim, key, view = 'unassigned') {
  const rows = perfRows();
  if (view !== 'assigned') return [];
  if (dim === 'role') return rows.filter((r) => resolveRoleKey(r.role) === key);
  if (dim === 'agent') return rows.filter((r) => r.agent === key);
  if (dim === 'project') {
    const names = new Set(engagementsBy('project', key, view).map((a) => a.agent));
    return rows.filter((r) => names.has(r.agent));
  }
  return rows;
}

/**
 * Memory, sliced.
 *
 * There is NO group-scoped or project-scoped memory anywhere in the system. Memory is
 * per-agent (Letta blocks, agent-knowledge.md) or fleet-wide (knowledge/, 16 accepted
 * artifacts) and nothing sits between. So a scope's "team memory" is the union of its
 * members' individual memories, which is a different and weaker thing — and the pages
 * name that rather than presenting the union as if it were a team memory.
 */
export function memoryBy(dim, key, view = 'unassigned') {
  if (view !== 'assigned') return [];
  const names = dim === 'agent'
    ? [key]
    : dim === 'project'
      ? (projectOf(key)?.members ?? [])
      : allocationRows(view).filter((a) => a.role?.key === key).map((a) => a.agent);
  return knowledge.memory.filter((m) => names.includes(m.agent));
}

/**
 * Which lifecycle stages this project has nobody allocated to.
 *
 * This is the first thing the two lenses produce TOGETHER rather than side by side:
 * it is only computable because the dotted line knows the roles and the solid line
 * knows the project. A project missing a Product Manager or a Tester becomes a visible
 * staffing gap instead of an unexplained silence in the queue.
 */
export function stageGaps(projectKey, view = 'unassigned') {
  const members = new Set(projectOf(projectKey)?.members ?? []);
  const held = new Set(
    allocationRows(view)
      .filter((a) => members.has(a.agent) && a.match.ok)
      .map((a) => a.role?.stage),
  );
  return LIFECYCLE_STAGES.filter((s) => !held.has(s));
}

// ══ cost ═════════════════════════════════════════════════════════════════════
/*
 * Every amount carries provenance. A plan seat is genuinely not a per-task
 * price, so it reports `unknown` with the reason rather than a zero — the
 * distinction the whole cost model turns on.
 */
export const burn = {
  currency: '¥',
  byProject: [
    { project: '#api-service', amount: 12.4, provenance: 'reported' },
    { project: '#docs-portal', amount: 1.85, provenance: 'reported' },
    { project: 'hermes-agent work', amount: null, provenance: 'unknown', why: 'cost.why.planSeat' },
  ],
  coveragePct: 62,
};

export function costToday() {
  return burn.byProject.reduce((sum, r) => sum + (r.amount ?? 0), 0);
}

// ══ performance ══════════════════════════════════════════════════════════════
/*
 * The supervisor already assesses every agent continuously. This is the same
 * evidence aggregated per employee over a period instead of per incident, which
 * is the difference between "does this need intervention now" and "is this
 * employee improving". Comparison stays inside a role: an architect and a
 * documentation employee do different work.
 */
export function perfRows() {
  return [
    {
      agent: 'octos-agent', role: 'coding', n: 9, confidence: 'medium',
      accepted: 8, rework: 1, costPerAccepted: 9.2, timeToAccept: '3h04m',
      externalWait: '41m', trend: [9, 12, 11, 16, 18, 22], flagged: false,
    },
    {
      agent: 'codex-agent', role: 'coding', n: 5, confidence: 'low',
      accepted: 3, rework: 2, costPerAccepted: 14.75, timeToAccept: '6h51m',
      externalWait: '12m', trend: [16, 14, 15, 10, 9, 8], flagged: true,
      // The reason is a TEMPLATE, so its numbers ride with it. They were computed
      // inline in one page against a bare literal 11, which the second renderer of
      // this row could not reproduce — so it printed `{a}` and `{b}` instead.
      flagReason: 'pf.flag.rework',
      flagVars: { a: 40, b: 11 },
    },
    {
      agent: 'hermes-agent', role: 'testing', n: 6, confidence: 'low',
      accepted: 6, rework: 0, costPerAccepted: null, timeToAccept: '1h22m',
      externalWait: '4m', trend: [10, 12, 13, 14, 15, 17], flagged: false,
    },
    {
      agent: 'claude-agent', role: 'documentation', n: 4, confidence: 'low',
      accepted: 4, rework: 0, costPerAccepted: 1.4, timeToAccept: '48m',
      externalWait: '2m', trend: [6, 7, 9, 9, 11, 12], flagged: false,
    },
  ];
}

/** Roles that actually have employees, so the page never renders an empty stratum. */
export function perfByRole() {
  const rows = perfRows();
  return ROLES.filter((r) => rows.some((x) => x.role === r))
    .map((role) => ({ role, rows: rows.filter((x) => x.role === role) }));
}

// ══ knowledge ════════════════════════════════════════════════════════════════
/*
 * 培养 read as self-evolution: better project context, better team memory.
 *
 * The per-agent loop already runs — a subconscious keeps memory blocks and
 * injects guidance. What has no surface is the team half: 13 accepted artifacts
 * that no agent is *served*, and no path from one employee's lesson to a
 * decision that binds everyone. `citations` makes "agents should read the ADRs"
 * a number instead of an instruction.
 */
export const knowledge = {
  accepted: { decisions: 9, requirements: 4, guidance: 1, standards: 1 },
  proposals: [
    {
      id: 'pr_0007', title: 'hermes needs a provider before it reports healthy',
      by: 'octos-agent', from: 'wi_0027 · 3 crash-loops', lint: 'pass', supersedes: null,
    },
    {
      id: 'pr_0008', title: 'Worktrees must be clean before a release assignment',
      by: 'claude-agent', from: 'wi_0051', lint: 'fail', lintWhy: 'kn.lint.noCriteria',
    },
  ],
  memory: [
    { agent: 'octos-agent', citations7d: 11, endpoint: 'local', updated: '4m ago' },
    { agent: 'claude-agent', citations7d: 7, endpoint: 'local', updated: '18m ago' },
    { agent: 'hermes-agent', citations7d: 3, endpoint: 'local', updated: '1h ago' },
    { agent: 'codex-agent', citations7d: 0, endpoint: 'off', updated: null },
  ],
};

export function acceptedTotal() {
  return Object.values(knowledge.accepted).reduce((a, b) => a + b, 0);
}
