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
    name: 'renamed-agent', framework: 'claude', transport: 'tmux', tmux: 'renamed-agent:0.0',
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
  leaseTtlMinutes: 15,
  autoProvisionCap: 0, // MATRIX_AGENT_MAX_PER_CELL; 0 means pure queue
  leases: [
    { leaseId: 'ls_3391', agent: 'octos-agent', role: 'coder', capability: 'shell', owner: 'openfab', expiresIn: '11m' },
  ],
  queuedTickets: [
    { ticket: 'disp-1785734-14', role: 'researcher', capability: 'git', waiting: '4m' },
  ],
};

export const pool = {
  capabilities: ['shell', 'git', 'web', 'browser'],
  roles: [
    { role: 'coder', cells: { shell: [1, 2], git: [1, 2], web: [0, 1], browser: [0, 1] } },
    { role: 'reviewer', cells: { shell: null, git: [1, 1], web: [0, 1], browser: null } },
    { role: 'researcher', cells: { shell: [0, 1], git: [0, 2], web: [1, 1], browser: [1, 1] } },
    { role: 'operator', cells: { shell: [1, 1], git: null, web: [0, 1], browser: [1, 2] } },
  ],
};

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
  'renamed-agent': { source: 'pane', lines: [] },
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
  };
}
