#!/usr/bin/env node
// Supervisor parity validation — automated checks that all supervisor APIs work correctly.
// Usage: node scripts/supervisor-parity-check.js [--web-url http://127.0.0.1:8090] [--target ac-topleader] [--token <supervisor-token>] [--bearer <api-token>]

function parseArgs(argv) {
  const args = { webUrl: '', target: 'ac-topleader', token: '', bearer: '' };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--web-url' && argv[i + 1]) { args.webUrl = argv[++i]; continue; }
    if (t === '--target' && argv[i + 1]) { args.target = argv[++i]; continue; }
    if (t === '--token' && argv[i + 1]) { args.token = argv[++i]; continue; }
    if (t === '--bearer' && argv[i + 1]) { args.bearer = argv[++i]; continue; }
    if (t === '-h' || t === '--help') { args.help = true; continue; }
  }
  // Auto-read Bearer token from env if not provided
  if (!args.bearer) args.bearer = (process.env.API_TOKEN || '').trim();
  return args;
}

function defaultApiBaseUrl() {
  const explicit = String(process.env.AGENT_CHAT_API || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const port = parseInt(process.env.AGENT_CHAT_BACKEND_PORT || '8090', 10);
  return `http://127.0.0.1:${port}`;
}

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
const SKIP = '\x1b[33mSKIP\x1b[0m';

export async function runParityChecks(apiBase, target, token, bearer = '') {
  const results = [];

  async function apiFetch(method, urlPath, body) {
    const url = `${apiBase}${urlPath}`;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['X-Agent-Token'] = token;
    if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  }

  function check(name, ok, detail = '') {
    results.push({ name, ok, skipped: false, detail });
    console.log(`  ${ok ? PASS : FAIL} ${name}${detail ? ` — ${detail}` : ''}`);
  }

  function skip(name, detail = '') {
    results.push({ name, ok: true, skipped: true, detail });
    console.log(`  ${SKIP} ${name}${detail ? ` — ${detail}` : ''}`);
  }

  console.log(`\nSupervisor parity checks against ${apiBase}\n`);

  // 1. GET /api/supervisor/status — full shape validation
  try {
    const r = await apiFetch('GET', '/api/supervisor/status');
    const b = r.body || {};
    const ok = r.status === 200
      && typeof b.enabled === 'boolean'
      && (b.disabledReason === null || typeof b.disabledReason === 'string')
      && typeof b.intervalMs === 'number'
      && typeof b.warnAfter === 'number'
      && typeof b.warnCooldownMs === 'number'
      && typeof b.heartbeatTtlMs === 'number'
      && typeof b.trailingHeartbeatPeriods === 'number'
      && typeof b.trailingWindowMs === 'number'
      && (b.matrixInfoGroup === null || typeof b.matrixInfoGroup === 'string')
      && typeof b.matrixMentions === 'boolean'
      && Array.isArray(b.allowedAgents)
      && b.allowlistMode === 'subset'
      && typeof b.llm === 'object' && b.llm !== null
      && typeof b.llm.provider === 'string'
      && typeof b.llm.model === 'string'
      && (b.llm.endpoint === null || typeof b.llm.endpoint === 'string')
      && typeof b.llm.profileSource === 'string'
      && typeof b.runtime === 'object' && b.runtime !== null
      && typeof b.runtime.running === 'boolean'
      && (b.runtime.lastSweepAt === null || typeof b.runtime.lastSweepAt === 'string')
      && typeof b.runtime.lastSweepDurationMs === 'number'
      && (b.runtime.lastSweepError === null || typeof b.runtime.lastSweepError === 'string')
      && typeof b.runtime.lastSweepActive === 'number'
      && typeof b.runtime.lastSweepEvaluated === 'number'
      && typeof b.supervisorState === 'object' && b.supervisorState !== null
      && typeof b.supervisorState.mode === 'string'
      && typeof b.supervisorState.lifecycleState === 'string'
      && typeof b.eventCount === 'number';
    check('GET /api/supervisor/status — full shape', ok, `enabled=${b.enabled}, events=${b.eventCount}, fields=${Object.keys(b).length}`);
  } catch (e) { check('GET /api/supervisor/status', false, e.message); }

  // 2. GET /api/supervisor/agents
  try {
    const r = await apiFetch('GET', '/api/supervisor/agents');
    const ok = r.status === 200
      && Array.isArray(r.body?.agents)
      && r.body?.status && typeof r.body.status === 'object';
    check('GET /api/supervisor/agents — valid shape', ok, `agentCount=${r.body?.agents?.length}`);
  } catch (e) { check('GET /api/supervisor/agents', false, e.message); }

  // 3. GET /api/supervisor/agents/:name
  try {
    const r = await apiFetch('GET', `/api/supervisor/agents/${target}`);
    const ok = r.status === 200
      && r.body?.name === target
      && Array.isArray(r.body?.events);
    check(`GET /api/supervisor/agents/${target} — valid shape`, ok, `events=${r.body?.events?.length}`);
  } catch (e) { check(`GET /api/supervisor/agents/${target}`, false, e.message); }

  // 4. GET /api/supervisor/control
  try {
    const r = await apiFetch('GET', '/api/supervisor/control');
    const ok = r.status === 200
      && typeof r.body?.enabled === 'boolean'
      && Array.isArray(r.body?.allowedAgents)
      && r.body?.allowlistMode === 'subset';
    check('GET /api/supervisor/control — valid shape', ok, `enabled=${r.body?.enabled}, allowed=${r.body?.allowedAgents?.length}`);
  } catch (e) { check('GET /api/supervisor/control', false, e.message); }

  // 5. PATCH /api/supervisor-state/:target — post assessment
  if (token) {
    try {
      const r = await apiFetch('PATCH', `/api/supervisor-state/${target}`, {
        state: 'focused', confidence: 0.85, reason: 'parity-check assessment', suggested_action: 'none', domain: 'core',
      });
      const ok = r.status === 200
        && r.body?.ok === true
        && r.body?.snapshot?.state === 'focused'
        && r.body?.snapshot?.confidence === 0.85
        && r.body?.snapshot?.classification === 'active';
      check('PATCH /api/supervisor-state — assessment accepted', ok, `state=${r.body?.snapshot?.state}`);
    } catch (e) { check('PATCH /api/supervisor-state', false, e.message); }

    // 6. POST /api/supervisor-state/:target/heartbeat
    try {
      const r = await apiFetch('POST', `/api/supervisor-state/${target}/heartbeat`, {});
      const ok = r.status === 200
        && r.body?.ok === true
        && r.body?.leaseRenewed === true;
      check('POST /api/supervisor-state/heartbeat — lease renewed', ok);
    } catch (e) { check('POST /api/supervisor-state/heartbeat', false, e.message); }

    // 7. Round-trip: verify the specific assessment persisted
    try {
      const r = await apiFetch('GET', `/api/supervisor/agents/${target}`);
      const s = r.body?.state;
      const latest = r.body?.latest;
      const ok = r.status === 200
        && s?.lastStatus === 'focused'
        && s?.lastReason === 'parity-check assessment'
        && s?.lastDomain === 'core'
        && s?.lastSuggestion === 'none'
        && latest?.reason === 'parity-check assessment'
        && latest?.domain === 'core';
      check('Round-trip — specific assessment persisted', ok, `reason=${s?.lastReason}, domain=${s?.lastDomain}`);
    } catch (e) { check('Round-trip — assessment persisted', false, e.message); }

    // 8. Task health enrichment end-to-end
    try {
      // Create test task
      const createRes = await apiFetch('POST', '/api/tasks', { title: 'parity-check-task', assignee: target });
      const taskId = createRes.body?.task?.id;
      if (!taskId) {
        check('Task health enrichment — create task', false, 'failed to create task');
      } else {
        // Fetch task — health should be enriched from the assessment posted above
        const taskRes = await apiFetch('GET', `/api/tasks/${taskId}`);
        const h = taskRes.body?.health;
        const ok = taskRes.status === 200
          && h?.state === 'focused'
          && h?.confidence === 0.85
          && h?.assessed_by === `supervisor-${target}`;
        check('Task health enrichment — snapshot read-through', ok, `state=${h?.state}, confidence=${h?.confidence}, assessed_by=${h?.assessed_by}`);

        // Clean up: delete test task
        await apiFetch('DELETE', `/api/tasks/${taskId}`);
      }
    } catch (e) { check('Task health enrichment', false, e.message); }
  } else {
    skip('PATCH /api/supervisor-state — assessment', 'no token provided');
    skip('POST /api/supervisor-state/heartbeat', 'no token provided');
    skip('Round-trip — assessment persisted', 'no token provided');
    skip('Task health enrichment', 'no token provided');
  }

  // Summary
  const passed = results.filter(r => r.ok && !r.skipped).length;
  const failed = results.filter(r => !r.ok).length;
  const skipped = results.filter(r => r.skipped).length;
  console.log(`\n  ${passed} passed, ${failed} failed, ${skipped} skipped out of ${results.length} checks\n`);
  return { results, passed, failed, skipped, total: results.length };
}

// CLI entry point
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('Usage: supervisor-parity-check [--web-url URL] [--target AGENT] [--token TOKEN] [--bearer API_TOKEN]');
  process.exit(0);
}

// Only run CLI if invoked directly (not imported)
if (process.argv[1] && process.argv[1].endsWith('supervisor-parity-check.js')) {
  const apiBase = args.webUrl || defaultApiBaseUrl();
  runParityChecks(apiBase, args.target, args.token, args.bearer).then(({ failed }) => {
    process.exit(failed > 0 ? 1 : 0);
  }).catch(err => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}
