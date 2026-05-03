import { afterEach, describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import request from 'supertest';

const SERVER_ENV_KEYS = [
  'AGENT_CHAT_RUNTIME_DIR',
  'AGENT_CHAT_WEB_PORT',
  'AGENT_CHAT_BACKEND_PORT',
  'AGENT_CHAT_DASHBOARD_TOKEN',
  'AGENT_IDLE_THRESHOLD_MS',
];

function snapshotEnv(keys) {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  if (!snapshot) return;
  for (const [key, value] of snapshot.entries()) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function waitFor(promise, timeoutMs = 1000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function importServer(runtimeDir, extraEnv = {}) {
  process.env.AGENT_CHAT_RUNTIME_DIR = runtimeDir;
  process.env.AGENT_CHAT_WEB_PORT = '18084';
  process.env.AGENT_CHAT_BACKEND_PORT = '18090';
  process.env.AGENT_CHAT_DASHBOARD_TOKEN = extraEnv.AGENT_CHAT_DASHBOARD_TOKEN || '';
  if (extraEnv.AGENT_IDLE_THRESHOLD_MS !== undefined) {
    process.env.AGENT_IDLE_THRESHOLD_MS = extraEnv.AGENT_IDLE_THRESHOLD_MS;
  } else {
    delete process.env.AGENT_IDLE_THRESHOLD_MS;
  }
  const serverUrl = pathToFileURL(path.resolve('server.js')).href;
  const cacheBust = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return import(`${serverUrl}?dashboard-boundary-test=${cacheBust}`);
}

describe('server dashboard mutation boundary', () => {
  let runtimeDir = null;
  let serverModule = null;
  let envSnapshot = null;

  async function setup(extraEnv = {}) {
    envSnapshot = snapshotEnv(SERVER_ENV_KEYS);
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'agent-chat-dashboard-boundary-test-'));
    mkdirSync(path.join(runtimeDir, 'logs'), { recursive: true });
    mkdirSync(path.join(runtimeDir, 'data', 'agents'), { recursive: true });
    if (typeof extraEnv.beforeImport === 'function') extraEnv.beforeImport(runtimeDir);
    serverModule = await importServer(runtimeDir, extraEnv);
    return serverModule;
  }

  afterEach(() => {
    if (serverModule?.resetServerTestHooks) serverModule.resetServerTestHooks();
    if (serverModule?.stopServer) serverModule.stopServer();
    serverModule = null;
    if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true });
    runtimeDir = null;
    restoreEnv(envSnapshot);
    envSnapshot = null;
  });

  test('keeps local queue mutation compatible', async () => {
    const mod = await setup();

    const create = await request(mod.app)
      .post('/api/queue')
      .send({ from: 'operator', to: 'alpha:0.0', payload: 'hello' });
    expect(create.status).toBe(200);
    expect(create.body).toMatchObject({ ok: true, position: 1 });

    const list = await request(mod.app).get('/api/queue');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ from: 'operator', to: 'alpha:0.0', payload: 'hello' });
  });

  test('backs up unreadable queue files on startup', async () => {
    const mod = await setup({
      beforeImport(dir) {
        writeFileSync(path.join(dir, 'logs', 'queue.json'), '{not-json', 'utf-8');
      },
    });

    const queuePath = path.join(runtimeDir, 'logs', 'queue.json');
    const backups = readdirSync(path.dirname(queuePath)).filter(name => name.startsWith('queue.json.corrupt-'));
    expect(existsSync(queuePath)).toBe(false);
    expect(backups).toHaveLength(1);

    const list = await request(mod.app).get('/api/queue');
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);
  });

  test('blocks non-local queue mutation', async () => {
    const mod = await setup();
    mod.setServerTestHooks({ dashboardRequestLocal: () => false });

    const create = await request(mod.app)
      .post('/api/queue')
      .send({ from: 'operator', to: 'alpha:0.0', payload: 'remote write' });
    expect(create.status).toBe(403);
    expect(create.body.error).toMatch(/dashboard mutation/i);

    const list = await request(mod.app).get('/api/queue');
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);
  });

  test('allows non-local mutation with the dashboard bearer token only', async () => {
    const mod = await setup({ AGENT_CHAT_DASHBOARD_TOKEN: 'dash-secret' });
    mod.setServerTestHooks({ dashboardRequestLocal: () => false });

    const wrongToken = await request(mod.app)
      .post('/api/queue')
      .set('Authorization', 'Bearer wrong-secret')
      .send({ from: 'operator', to: 'alpha:0.0', payload: 'bad token' });
    expect(wrongToken.status).toBe(403);

    const rightToken = await request(mod.app)
      .post('/api/queue')
      .set('Authorization', 'Bearer dash-secret')
      .send({ from: 'operator', to: 'alpha:0.0', payload: 'good token' });
    expect(rightToken.status).toBe(200);
    expect(rightToken.body).toMatchObject({ ok: true, position: 1 });
  });

  test('blocks non-local backend proxy mutation before upstream fetch', async () => {
    const mod = await setup();
    const seen = [];
    mod.setServerTestHooks({
      dashboardRequestLocal: () => false,
      backendFetch: async (url, init = {}) => {
        seen.push({ url: String(url), method: init.method || 'GET' });
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
    });

    const create = await request(mod.app)
      .post('/api/task-graphs')
      .send({ owner: 'operator' });
    expect(create.status).toBe(403);
    expect(seen).toEqual([]);
  });

  test('agent down command runs asynchronously without blocking other dashboard requests', async () => {
    const mod = await setup();
    let releaseAgentDown;
    let startedAgentDown;
    const agentDownStarted = new Promise((resolve) => {
      startedAgentDown = resolve;
    });

    mod.setServerTestHooks({
      execFileAsync: async (cmd, args) => {
        if (String(cmd).endsWith('/bin/agent-down')) {
          startedAgentDown();
          return new Promise((resolve) => {
            releaseAgentDown = () => resolve({ stdout: 'agent stopped\n' });
          });
        }
        throw new Error(`unexpected exec ${cmd} ${args.join(' ')}`);
      },
    });

    const downRequest = request(mod.app).post('/api/agents/alpha/down').send({}).then((res) => res);
    await waitFor(agentDownStarted);

    const queueResponse = await request(mod.app).get('/api/queue');
    expect(queueResponse.status).toBe(200);
    expect(queueResponse.body).toEqual([]);

    releaseAgentDown();
    const downResponse = await downRequest;
    expect(downResponse.status).toBe(200);
    expect(downResponse.body).toMatchObject({
      ok: true,
      action: 'agent-down-kill',
      outputTail: 'agent stopped',
    });
  });

  test('agent down fallback uses asynchronous tmux cleanup before marking offline', async () => {
    const mod = await setup();
    const execCalls = [];
    const backendCalls = [];

    mod.setServerTestHooks({
      execFileAsync: async (cmd, args) => {
        execCalls.push([cmd, ...args]);
        if (String(cmd).endsWith('/bin/agent-down')) {
          const error = new Error('agent-down failed');
          error.stdout = 'partial stdout\n';
          error.stderr = 'partial stderr\n';
          throw error;
        }
        if (cmd === 'tmux') return { stdout: '' };
        throw new Error(`unexpected exec ${cmd}`);
      },
      backendFetch: async (url, init = {}) => {
        backendCalls.push({ url: String(url), method: init.method || 'GET', body: init.body || null });
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
    });

    const response = await request(mod.app).post('/api/agents/alpha/down').send({});

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      action: 'agent-down-kill-fallback',
    });
    expect(response.body.outputTail).toContain('partial stdout');
    expect(response.body.outputTail).toContain('partial stderr');
    expect(execCalls).toContainEqual(['tmux', 'kill-session', '-t', 'alpha']);
    expect(backendCalls).toHaveLength(1);
    expect(backendCalls[0]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(backendCalls[0].body)).toMatchObject({
      reason: 'manual-down:web-kill',
      clearTmux: true,
      manualDown: true,
    });
  });

  test('dashboard server avoids synchronous child process execution', () => {
    const source = readFileSync(path.resolve('server.js'), 'utf-8');
    expect(source).not.toContain('execFileSync');
  });

  test.each([
    ['/', ['<title>Agent Monitor</title>', 'AGENT MONITOR']],
    ['/agents/alpha', ['<title>Agent Detail · alpha</title>', 'Agent Detail', 'id="supervisor-audit-history"']],
    ['/alerts', ['<title>Alerts</title>', '<h1>ALERTS</h1>']],
    ['/tasks', ['<title>Tasks</title>', '<h1>TASKS</h1>']],
    ['/config', ['<title>Config</title>', '<h1>GLOBAL CONFIG</h1>']],
  ])('serves %s as non-cacheable html', async (route, markers) => {
    const mod = await setup();

    const response = await request(mod.app).get(route);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/html\b/);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.text).toContain('<!DOCTYPE html>');
    for (const marker of markers) expect(response.text).toContain(marker);
  });

  test('passes the idle threshold into the monitor page renderer', async () => {
    const mod = await setup({ AGENT_IDLE_THRESHOLD_MS: '45000' });

    const response = await request(mod.app).get('/');

    expect(response.status).toBe(200);
    expect(response.text).toContain('const IDLE_THRESHOLD_MS = 45000;');
    expect(response.text).toContain('const IDLE_THRESHOLD_SEC = 45;');
  });

  test('agent detail tasks tab uses the detail agent without overwriting explicit URL state', async () => {
    const mod = await setup();

    const response = await request(mod.app).get('/agents/alpha');

    expect(response.status).toBe(200);
    expect(response.text).toContain("const savedAssignee = storageGet(taskFilterStorage, 'task_filter_assignee');");
    expect(response.text).toContain("!u.searchParams.has('assignee')");
    expect(response.text).toContain('!savedAssignee');
    expect(response.text).toContain("storageSet(taskFilterStorage, 'task_filter_assignee', agent);");
    expect(response.text).not.toContain('monitoredAgent.name');
  });

  test('agent detail page guards browser storage access', async () => {
    const mod = await setup();

    const response = await request(mod.app).get('/agents/alpha');

    expect(response.status).toBe(200);
    expect(response.text).toContain('function safeStorage(name)');
    expect(response.text).toContain('function storageGet(store, key');
    expect(response.text).toContain('function storageSet(store, key, value)');
    expect(response.text).toContain("const dmStorage = safeStorage('localStorage');");
    expect(response.text).toContain("const taskFilterStorage = safeStorage('sessionStorage');");
    expect(response.text).not.toMatch(/\b(?:localStorage|sessionStorage)\.(?:getItem|setItem|removeItem|clear)\b/);
  });

  test('agent detail refresh is self-scheduled and overlap guarded', async () => {
    const mod = await setup();

    const response = await request(mod.app).get('/agents/alpha');

    expect(response.status).toBe(200);
    expect(response.text).toContain('let refreshInFlight = false;');
    expect(response.text).toContain('async function fetchOptionalJson(url, fallback)');
    expect(response.text).toContain("fetchOptionalJson('/api/agents/status', [])");
    expect(response.text).toContain("fetchOptionalJson('/api/queue', [])");
    expect(response.text).not.toContain("fetch('/api/queue'),");
    expect(response.text).toContain('function scheduleAgentDetailRefresh(delayMs)');
    expect(response.text).toContain('setTimeout(runAgentDetailRefreshLoop, nextDelay)');
    expect(response.text).toContain('document.hidden ? AGENT_DETAIL_REFRESH_HIDDEN_MS : AGENT_DETAIL_REFRESH_VISIBLE_MS');
    expect(response.text).toContain("window.addEventListener('visibilitychange'");
    expect(response.text).not.toContain('setInterval(refresh, 5000)');
  });

  test('alerts page guards timestamps and coalesces refreshes', async () => {
    const mod = await setup();

    const response = await request(mod.app).get('/alerts');

    expect(response.status).toBe(200);
    expect(response.text).toContain('function isoTime(ts)');
    expect(response.text).toContain('function scheduleFetchAlerts(delay=0)');
    expect(response.text).toContain('function alertFilterKey(filters)');
    expect(response.text).toContain('if(alertsInFlight){alertsRefreshQueued=true;return}');
    expect(response.text).toContain('window._applyFilters=function(){scheduleFetchAlerts(150)}');
    expect(response.text).toContain('if(requestFilterKey!==alertFilterKey(currentAlertFilters())){alertsRefreshQueued=true;return}');
    expect(response.text).toContain('alerts=normalizeAlertsPayload(next);');
    expect(response.text).not.toContain('new Date(a.firstSeenAt).toISOString()');
    expect(response.text).not.toContain('new Date(a.lastSeenAt).toISOString()');
  });

  test('alerts page checks action responses before refreshing or clearing selection', async () => {
    const mod = await setup();

    const response = await request(mod.app).get('/alerts');

    expect(response.status).toBe(200);
    expect(response.text).toContain('let alertActionInFlight=false;');
    expect(response.text).toContain('async function assertAlertActionOk(r,label)');
    expect(response.text).toContain('if(!r.ok||(payload&&payload.ok===false))');
    expect(response.text).toContain('if(!selectedId||alertActionInFlight)return;');
    expect(response.text).toContain("await assertAlertActionOk(r,'alert transition');");
    expect(response.text).toContain("await assertAlertActionOk(r,'alert note');");
    expect(response.text).toContain("await assertAlertActionOk(r,'alert delete');");
    expect(response.text).toContain("reportAlertActionError('alert transition',e)");
    expect(response.text).toContain("reportAlertActionError('alert note',e)");
    expect(response.text).toContain("reportAlertActionError('alert delete',e)");
    expect(response.text).toContain('selectedId=null;');
  });

  test('monitor normalizes queue and reminder payload arrays', async () => {
    const mod = await setup();

    const response = await request(mod.app).get('/');

    expect(response.status).toBe(200);
    expect(response.text).toContain('function normalizeArrayPayload(payload)');
    expect(response.text).toContain('function normalizeQueuePayload(payload)');
    expect(response.text).toContain('function normalizeReminderPayload(payload)');
    expect(response.text).toContain('function applyQueuePayload(payload, force = false)');
    expect(response.text).toContain('function applyReminderPayload(payload, force = false)');
    expect(response.text).toContain('applyQueuePayload(JSON.parse(e.data), false);');
    expect(response.text).toContain('applyReminderPayload(JSON.parse(e.data), false);');
    expect(response.text).toContain('applyQueuePayload(await r.json(), true);');
    expect(response.text).toContain('applyReminderPayload(await r.json(), true);');
  });

  test('monitor normalizes message rows before rendering logs', async () => {
    const mod = await setup();

    const response = await request(mod.app).get('/');

    expect(response.status).toBe(200);
    expect(response.text).toContain('function normalizeMessageLogRow(row)');
    expect(response.text).toContain('function normalizeMessageLogPayload(payload)');
    expect(response.text).toContain("if (!row || typeof row !== 'object' || Array.isArray(row)) return null;");
    expect(response.text).toContain("payload: typeof payload === 'string' ? payload : (payload == null ? '' : String(payload))");
    expect(response.text).toContain('addLogEntry(normalizeMessageLogRow(JSON.parse(e.data)));');
    expect(response.text).toContain('const msgs = normalizeMessageLogPayload(await res.json());');
  });

  test('monitor queue and reminder actions guard in-flight rows', async () => {
    const mod = await setup();

    const response = await request(mod.app).get('/');

    expect(response.status).toBe(200);
    expect(response.text).toContain('const pendingQueueActionIds = new Set();');
    expect(response.text).toContain('if (pendingQueueActionIds.has(pendingId)) return;');
    expect(response.text).toContain('pendingQueueActionIds.add(pendingId);');
    expect(response.text).toContain('pendingQueueActionIds.delete(pendingId);');
    expect(response.text).toContain('normalizeQueuePayload(payload).filter(item => !pendingQueueActionIds.has(String(item.id)))');
    expect(response.text).toContain('const pendingReminderCancelIds = new Set();');
    expect(response.text).toContain('if (pendingReminderCancelIds.has(pendingId)) return;');
    expect(response.text).toContain('pendingReminderCancelIds.add(pendingId);');
    expect(response.text).toContain("if (!res.ok) throw new Error('HTTP ' + res.status);");
    expect(response.text).toContain('pendingReminderCancelIds.delete(pendingId);');
    expect(response.text).toContain('normalizeReminderPayload(payload).filter(item => !pendingReminderCancelIds.has(String(item.id)))');
    expect(response.text).not.toContain('queueActionPending = false;');
    expect(response.text).not.toContain('reminderActionPending = false;');
  });

  test('monitor timer-only updates avoid rebuilding queue and reminder rows', async () => {
    const mod = await setup();

    const response = await request(mod.app).get('/');

    expect(response.status).toBe(200);
    expect(response.text).toContain('function updateQueueTimersInPlace()');
    expect(response.text).toContain("waitEl.textContent = 'waiting ' + computeQueueWaitStr(item.queuedAt);");
    expect(response.text).toContain("idleEl.className = 'qi-idle ' + info.className;");
    expect(response.text).toContain("'<div class=\"qi-wait\"></div>'");
    expect(response.text).toContain("'<div class=\"qi-idle ' + idleInfo.className + '\"></div>'");
    expect(response.text).toContain('updateQueueTimersInPlace();');
    expect(response.text).toContain('function updateReminderTimersInPlace()');
    expect(response.text).toContain("countdownEl.textContent = '\\u23f0 ' + fmtCountdown(item.remainingMs || 0);");
    expect(response.text).toContain("'<div class=\"ri-countdown\"></div>'");
    expect(response.text).toContain('updateReminderTimersInPlace();');
  });

  test('monitor agent status polling is single-flight and array-normalized', async () => {
    const mod = await setup();

    const response = await request(mod.app).get('/');

    expect(response.status).toBe(200);
    expect(response.text).toContain('let agentStatusInFlight = false;');
    expect(response.text).toContain('let agentStatusRefreshQueued = false;');
    expect(response.text).toContain('if (agentStatusInFlight) { agentStatusRefreshQueued = true; return; }');
    expect(response.text).toContain('function normalizeAgentStatusPayload(payload)');
    expect(response.text).toContain('const normalized = normalizeAgentStatusPayload(payload);');
    expect(response.text).toContain('agentStatusInFlight = false;');
    expect(response.text).not.toContain('const rows = await res.json();');
  });

  test('agent status endpoint normalizes malformed backend agent payloads', async () => {
    const mod = await setup();
    mod.setServerTestHooks({
      backendFetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ agents: null }),
      }),
    });

    const response = await request(mod.app).get('/api/agents/status');

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });

  test('alert stats payloads are normalized on alerts and monitor pages', async () => {
    const mod = await setup();

    const alerts = await request(mod.app).get('/alerts');
    const monitor = await request(mod.app).get('/');

    expect(alerts.status).toBe(200);
    expect(monitor.status).toBe(200);
    expect(alerts.text).toContain('function normalizeAlertStats(payload)');
    expect(monitor.text).toContain('function normalizeAlertStats(payload)');
    expect(alerts.text).toContain('const s=normalizeAlertStats(await r.json());');
    expect(monitor.text).toContain('const s=normalizeAlertStats(await r.json());');
  });

  test('config page normalizes presets and agents payloads', async () => {
    const mod = await setup();

    const response = await request(mod.app).get('/config');

    expect(response.status).toBe(200);
    expect(response.text).toContain('function normalizePresetPayload(payload)');
    expect(response.text).toContain('function normalizeAgentPayload(payload)');
    expect(response.text).toContain('presets = normalizePresetPayload(next);');
    expect(response.text).toContain('allAgents = normalizeAgentPayload(next);');
    expect(response.text).not.toContain('presets = await r.json();');
    expect(response.text).not.toContain('allAgents = await r.json();');
  });

  test('dashboard render paths filter malformed array elements before rendering', async () => {
    const mod = await setup();

    const [monitor, tasks, alerts, detail] = await Promise.all([
      request(mod.app).get('/'),
      request(mod.app).get('/tasks'),
      request(mod.app).get('/alerts'),
      request(mod.app).get('/agents/alpha'),
    ]);

    expect(monitor.status).toBe(200);
    expect(tasks.status).toBe(200);
    expect(alerts.status).toBe(200);
    expect(detail.status).toBe(200);
    expect(monitor.text).toContain("payload.filter(function(item) { return item && typeof item === 'object'; })");
    expect(monitor.text).toContain('function normalizeNewAgentPresetPayload(payload)');
    expect(tasks.text).toContain("if(!item||typeof item!=='object')return null;");
    expect(alerts.text).toContain('function normalizeAlertsPayload(payload)');
    expect(detail.text).toContain('function normalizeObjectArray(payload)');
    expect(detail.text).toContain('function normalizeDmMessagesPayload(payload)');
  });

  test('monitor alert badge and detail DM history coalesce overlapping refreshes', async () => {
    const mod = await setup();

    const [monitor, detail] = await Promise.all([
      request(mod.app).get('/'),
      request(mod.app).get('/agents/alpha'),
    ]);

    expect(monitor.status).toBe(200);
    expect(detail.status).toBe(200);
    expect(monitor.text).toContain('let alertBadgeInFlight=false;');
    expect(monitor.text).toContain('let alertBadgeQueued=false;');
    expect(monitor.text).toContain('if(alertBadgeInFlight){alertBadgeQueued=true;return}');
    expect(detail.text).toContain('let dmHistoryInFlight = false;');
    expect(detail.text).toContain('let dmHistoryQueued = false;');
    expect(detail.text).toContain('if (dmHistoryInFlight) { dmHistoryQueued = true; return false; }');
    expect(detail.text).toContain('dmMessages = normalizeDmMessagesPayload(data);');
  });

  test('task dashboards bound and coalesce task list refreshes', async () => {
    const mod = await setup();

    const tasks = await request(mod.app).get('/tasks');
    const detail = await request(mod.app).get('/agents/alpha');

    expect(tasks.status).toBe(200);
    expect(detail.status).toBe(200);
    expect(tasks.text).toContain('const TASK_LIST_LIMIT=200;');
    expect(tasks.text).toContain('function taskListUrl(filters)');
    expect(tasks.text).toContain('function taskFilterKey(filters)');
    expect(tasks.text).toContain("p.set('limit',String(TASK_LIST_LIMIT));");
    expect(tasks.text).toContain('if(refreshInFlight){refreshQueued=true;return}');
    expect(tasks.text).toContain('if(requestFilterKey!==taskFilterKey(getFilters())){refreshQueued=true;return}');
    expect(tasks.text).toContain('const nextTasks=normalizeTaskPayload(await r.json());');
    expect(tasks.text).toContain('taskCache=nextTasks;');
    expect(detail.text).toContain('const TASK_LIST_LIMIT = 200;');
    expect(detail.text).toContain('function taskListUrl(filterVal)');
    expect(detail.text).toContain('function currentTaskListFilterValue()');
    expect(detail.text).toContain('if (requestFilterKey !== taskListFilterKey(currentTaskListFilterValue()))');
    expect(detail.text).toContain("p.set('limit', String(TASK_LIST_LIMIT));");
    expect(detail.text).toContain('if (taskListInFlight) { taskListRefreshQueued = true; return; }');
    expect(detail.text).toContain('const nextTasks = normalizeTaskPayload(await r.json());');
    expect(detail.text).toContain('taskListCache = nextTasks;');
    expect(detail.text).not.toContain("filterVal ? '/api/tasks?assignee=' + encodeURIComponent(filterVal) : '/api/tasks'");
  });

  test.each([
    '/',
    '/agents/alpha',
    '/alerts',
    '/tasks',
  ])('guards dashboard EventSource setup for %s', async (route) => {
    const mod = await setup();

    const response = await request(mod.app).get(route);

    expect(response.status).toBe(200);
    expect(response.text).toContain('function connectDashboardStream(register)');
    expect(response.text).toContain("typeof EventSource !== 'function'");
    expect(response.text).toContain('connectDashboardStream(');
  });

  test('render modules use shared browser API guards instead of direct browser APIs', () => {
    const renderFiles = [
      'lib/dashboard/render/agent-detail-page.js',
      'lib/dashboard/render/monitor-page.js',
      'lib/dashboard/render/alerts-page.js',
      'lib/dashboard/render/tasks-page.js',
    ];

    for (const file of renderFiles) {
      const source = readFileSync(path.resolve(file), 'utf-8');
      expect(source, file).not.toMatch(/\b(?:localStorage|sessionStorage)\.(?:getItem|setItem|removeItem|clear)\b/);
      expect(source, file).not.toContain("new EventSource('/api/stream')");
      expect(source, file).toContain('DASHBOARD_BROWSER_GUARDS_SCRIPT');
    }

    const helper = readFileSync(path.resolve('lib/dashboard/render/browser-guards.js'), 'utf-8');
    expect(helper).toContain('function safeStorage(name)');
    expect(helper).toContain("typeof EventSource !== 'function'");
    expect(helper).toContain("new EventSource('/api/stream')");
  });

  test('monitor task SSE handlers do not require task-page globals', async () => {
    const mod = await setup();

    const response = await request(mod.app).get('/');

    expect(response.status).toBe(200);
    expect(response.text).toContain("typeof activeTab !== 'undefined'");
    expect(response.text).toContain("typeof taskListRefresh === 'function'");
    expect(response.text).not.toContain("if (activeTab === 'tasks') taskListRefresh();");
  });

  test('monitor initial message load requests a bounded page', async () => {
    const mod = await setup();

    const response = await request(mod.app).get('/');

    expect(response.status).toBe(200);
    expect(response.text).toContain("fetch('/api/messages?limit=50')");
    expect(response.text).not.toContain("fetch('/api/messages')");
    expect(response.text).not.toContain('msgs.slice(-50)');
  });

  test('monitor periodic detail refresh skips while a detail request is in flight', async () => {
    const mod = await setup();

    const response = await request(mod.app).get('/');

    expect(response.status).toBe(200);
    expect(response.text).toContain('function refreshAgentDetailIfIdle()');
    expect(response.text).toContain('if (!monitoredAgent || agentDetailAbortController) return false;');
    expect(response.text).toContain('refreshAgentDetailIfIdle();');
    expect(response.text).not.toContain("if (monitoredAgent) fetchAgentDetail(monitoredAgent.name, { preserveVisible: true });");
  });

  test('monitor terminal capture ignores stale agent responses while allowing new selection fetches', async () => {
    const mod = await setup();

    const response = await request(mod.app).get('/');

    expect(response.status).toBe(200);
    expect(response.text).toContain('let terminalFetchSeq = 0;');
    expect(response.text).toContain('const terminalFetchInFlight = new Set();');
    expect(response.text).toContain('const targetAgent = monitoredAgent;');
    expect(response.text).toContain('if (terminalFetchInFlight.has(targetName)) return;');
    expect(response.text).toContain('const requestSeq = ++terminalFetchSeq;');
    expect(response.text).toContain('const isCurrentRequest = () => monitoredAgent && monitoredAgent.name === targetName && requestSeq === terminalFetchSeq;');
    expect(response.text).toContain('if (!isCurrentRequest()) return;');
    expect(response.text).toContain('terminalFetchInFlight.delete(targetName);');
    expect(response.text).not.toContain('terminalFetching');
  });

  test('monitor detail fetch failures render an explicit sidebar error', async () => {
    const mod = await setup();

    const response = await request(mod.app).get('/');

    expect(response.status).toBe(200);
    expect(response.text).toContain("showAgentDetailError(targetName, 'Summary unavailable: ' + (detailRespRaw.reason?.message || 'request failed'));");
    expect(response.text).toContain("showAgentDetailError(targetName, 'Summary unavailable (HTTP ' + res.status + ').');");
    expect(response.text).toContain("showAgentDetailError(targetName, 'Summary unavailable: invalid response.');");
    expect(response.text).not.toContain('const res = detailRespRaw.value;\n      if (!res.ok) return;');
  });

  test('redirects agent audit page to the detail audit hash', async () => {
    const mod = await setup();

    const response = await request(mod.app).get('/agents/alpha/audit');

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/agents/alpha#audit');
  });

  test.each([
    '/agents/bad.name',
    '/agents/bad.name/audit',
  ])('rejects invalid agent name for %s', async (route) => {
    const mod = await setup();

    const response = await request(mod.app).get(route);

    expect(response.status).toBe(400);
    expect(response.headers['content-type']).toMatch(/^text\/plain\b/);
    expect(response.text).toBe('invalid agent name');
  });
});
