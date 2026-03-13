#!/usr/bin/env node
// Supervisor parity validation — automated checks that all supervisor APIs work correctly.
// Usage: node scripts/supervisor-parity-check.js [--web-url http://127.0.0.1:8090] [--target ac-topleader] [--token <supervisor-token>]

import { readFileSync } from 'fs';
import path from 'path';

function parseArgs(argv) {
  const args = { webUrl: '', target: 'ac-topleader', token: '' };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--web-url' && argv[i + 1]) { args.webUrl = argv[++i]; continue; }
    if (t === '--target' && argv[i + 1]) { args.target = argv[++i]; continue; }
    if (t === '--token' && argv[i + 1]) { args.token = argv[++i]; continue; }
    if (t === '-h' || t === '--help') { args.help = true; continue; }
  }
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

export async function runParityChecks(apiBase, target, token) {
  const results = [];

  async function apiFetch(method, urlPath, body) {
    const url = `${apiBase}${urlPath}`;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['X-Agent-Token'] = token;
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  }

  function check(name, ok, detail = '') {
    results.push({ name, ok, detail });
    console.log(`  ${ok ? PASS : FAIL} ${name}${detail ? ` — ${detail}` : ''}`);
  }

  console.log(`\nSupervisor parity checks against ${apiBase}\n`);

  // 1. GET /api/supervisor/status
  try {
    const r = await apiFetch('GET', '/api/supervisor/status');
    const ok = r.status === 200
      && typeof r.body?.enabled === 'boolean'
      && r.body?.runtime && typeof r.body.runtime === 'object'
      && r.body?.llm && typeof r.body.llm === 'object'
      && Array.isArray(r.body?.allowedAgents)
      && r.body?.allowlistMode === 'subset'
      && typeof r.body?.intervalMs === 'number'
      && typeof r.body?.eventCount === 'number';
    check('GET /api/supervisor/status — valid shape', ok, `enabled=${r.body?.enabled}, eventCount=${r.body?.eventCount}`);
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
  } else {
    check('PATCH /api/supervisor-state — assessment', false, 'skipped: no token provided');
    check('POST /api/supervisor-state/heartbeat', false, 'skipped: no token provided');
  }

  // 7. GET /api/supervisor/agents/:name — verify assessment persisted
  try {
    const r = await apiFetch('GET', `/api/supervisor/agents/${target}`);
    const hasState = r.body?.state && r.body.state.lastStatus === 'focused';
    check('GET /api/supervisor/agents/:name — assessment persisted', hasState || !token, token ? `lastStatus=${r.body?.state?.lastStatus}` : 'skipped: no token');
  } catch (e) { check('GET /api/supervisor/agents/:name — persisted', false, e.message); }

  // 8. Task health enrichment
  try {
    const r = await apiFetch('GET', '/api/tasks');
    const ok = r.status === 200 && Array.isArray(r.body);
    check('GET /api/tasks — returns array', ok, `count=${r.body?.length}`);
  } catch (e) { check('GET /api/tasks', false, e.message); }

  // Summary
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n  ${passed} passed, ${failed} failed out of ${results.length} checks\n`);
  return { results, passed, failed, total: results.length };
}

// CLI entry point
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('Usage: supervisor-parity-check [--web-url URL] [--target AGENT] [--token TOKEN]');
  process.exit(0);
}

// Only run CLI if invoked directly (not imported)
if (process.argv[1] && process.argv[1].endsWith('supervisor-parity-check.js')) {
  const apiBase = args.webUrl || defaultApiBaseUrl();
  runParityChecks(apiBase, args.target, args.token).then(({ failed }) => {
    process.exit(failed > 0 ? 1 : 0);
  }).catch(err => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}
