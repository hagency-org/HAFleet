export function renderConfigPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Config</title>
<style>
:root{--bg:#0a0e14;--surface:#111922;--border:rgba(154,182,210,0.12);--text:#c8d6e5;--muted:rgba(200,214,229,0.45);--accent:#6dc1ff;--red:#ff6b6b;--yellow:#ffd93d;--green:#6bff9e}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'SF Mono','Fira Code',monospace;font-size:12px;background:var(--bg);color:var(--text);min-height:100vh}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
select{cursor:pointer}
select option{background:#0d1723;color:#e2eaf3}
.page{max-width:900px;margin:0 auto;padding:16px 20px}
.header{display:flex;align-items:center;gap:16px;margin-bottom:20px}
.header h1{font-size:16px;color:var(--accent);font-weight:600;letter-spacing:1px}
.header a{font-size:11px;color:var(--muted)}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:16px}
.panel-label{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:12px}
.hint{font-size:11px;color:var(--muted);margin-bottom:12px}
.preset-table{width:100%;border-collapse:collapse;font-size:11px}
.preset-table th{text-align:left;padding:6px 8px;color:var(--muted);font-size:10px;letter-spacing:1px;text-transform:uppercase;border-bottom:1px solid var(--border)}
.preset-table td{padding:6px 8px;border-bottom:1px solid rgba(154,182,210,0.06)}
.preset-table tr:hover{background:rgba(109,193,255,0.04)}
.empty-state{text-align:center;padding:24px;color:var(--muted);font-size:11px}
.field-label{font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:var(--muted);margin-top:10px;margin-bottom:4px}
.cfg-input{width:100%;margin-top:2px;background:rgba(255,255,255,0.03);border:1px solid rgba(109,193,255,0.24);border-radius:8px;color:var(--text);padding:8px 10px;outline:none;font-size:12px;font-family:inherit}
.cfg-input:focus{border-color:rgba(109,193,255,0.5)}
.btn{background:var(--surface);border:1px solid var(--border);color:var(--text);padding:6px 14px;border-radius:6px;font-size:11px;font-family:inherit;cursor:pointer;letter-spacing:0.5px}
.btn:hover{border-color:var(--accent);color:var(--accent)}
.btn-accent{border-color:rgba(109,193,255,0.4);color:var(--accent)}
.btn-danger{border-color:rgba(255,107,107,0.3);color:var(--red)}
.btn-danger:hover{border-color:var(--red);background:rgba(255,107,107,0.08)}
.actions-row{display:flex;gap:8px;margin-top:12px}
.status-msg{font-size:11px;margin-top:8px;min-height:16px}
.status-ok{color:var(--green)}
.status-error{color:var(--red)}
.add-form{display:none;margin-top:16px;padding-top:16px;border-top:1px solid var(--border)}
.add-form.visible{display:block}
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <h1>GLOBAL CONFIG</h1>
    <a href="/">&larr; Monitor</a>
    <a href="/projects">Projects</a>
    <a href="/alerts">Alerts</a>
    <a href="/project-sides">Project Sides</a>
    <a href="/tasks">Tasks</a>
  </div>

  <div class="panel">
    <div class="panel-label">All Agents</div>
    <div class="hint">All registered agents across all servers. Offline local agents can be started from here.</div>
    <div id="agent-list"></div>
    <div id="agent-status-msg" class="status-msg"></div>
  </div>

  <div class="panel">
    <div class="panel-label">Framework Presets</div>
    <div class="hint">Named bundles of framework / provider / model settings. These presets appear in each agent's Configuration dropdowns.</div>
    <div id="preset-list"></div>
    <div style="margin-top:12px;display:flex;gap:8px">
      <button class="btn btn-accent" onclick="toggleAddForm()">+ Add Preset</button>
    </div>
    <div id="add-form" class="add-form">
      <div class="field-label">Name</div>
      <input id="p-name" class="cfg-input" placeholder="e.g. Claude Opus">
      <div class="field-label">Framework</div>
      <select id="p-framework" class="cfg-input"><option value="">—</option><option value="claude">claude</option><option value="codex">codex</option></select>
      <div class="field-label">Model</div>
      <input id="p-model" class="cfg-input" placeholder="e.g. claude-sonnet-4-20250514">
      <div class="field-label">Reasoning</div>
      <input id="p-reasoning" class="cfg-input" placeholder="e.g. extended">
      <div class="field-label">Extra Args</div>
      <input id="p-extraArgs" class="cfg-input" placeholder="e.g. --verbose">
      <div class="field-label">API Base URL</div>
      <input id="p-apiBaseUrl" class="cfg-input" placeholder="e.g. https://dashscope.aliyuncs.com/apps/anthropic">
      <div class="field-label">API Key</div>
      <input id="p-apiKey" type="password" class="cfg-input" placeholder="API key for custom provider">
      <div class="actions-row">
        <button class="btn btn-accent" onclick="submitPreset()">Create Preset</button>
        <button class="btn" onclick="toggleAddForm()">Cancel</button>
      </div>
    </div>
    <div id="status-msg" class="status-msg"></div>
  </div>
</div>
<script>
(function(){
  const listEl = document.getElementById('preset-list');
  const formEl = document.getElementById('add-form');
  const statusEl = document.getElementById('status-msg');
  let presets = [];

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function normalizePresetPayload(payload) {
    if (!Array.isArray(payload)) return [];
    return payload.map(function(item) {
      if (!item || typeof item !== 'object') return null;
      var id = typeof item.id === 'string' ? item.id.trim() : '';
      var name = typeof item.name === 'string' ? item.name.trim() : '';
      if (!id || !name) return null;
      return Object.assign({}, item, {
        id: id,
        name: name,
        framework: typeof item.framework === 'string' ? item.framework : '',
        model: typeof item.model === 'string' ? item.model : '',
        apiBaseUrl: typeof item.apiBaseUrl === 'string' ? item.apiBaseUrl : '',
      });
    }).filter(Boolean);
  }

  function showStatus(msg, cls) {
    statusEl.textContent = msg;
    statusEl.className = 'status-msg ' + (cls || '');
    if (msg) setTimeout(function() { if (statusEl.textContent === msg) { statusEl.textContent = ''; statusEl.className = 'status-msg'; } }, 3000);
  }

  function render() {
    if (presets.length === 0) {
      listEl.innerHTML = '<div class="empty-state">No presets defined yet.</div>';
      return;
    }
    var h = '<table class="preset-table"><thead><tr><th>Name</th><th>Framework</th><th>Model</th><th>API Base URL</th><th>API Key</th><th></th></tr></thead><tbody>';
    for (var i = 0; i < presets.length; i++) {
      var p = presets[i];
      h += '<tr>'
        + '<td><strong>' + esc(p.name) + '</strong></td>'
        + '<td>' + esc(p.framework || '-') + '</td>'
        + '<td>' + esc(p.model || '-') + '</td>'
        + '<td>' + esc(p.apiBaseUrl || '-') + '</td>'
        + '<td>' + (p.apiKey ? 'Configured' : '-') + '</td>'
        + '<td><button class="btn btn-danger" onclick="deletePreset(\\'' + esc(p.id) + '\\')">Delete</button></td>'
        + '</tr>';
    }
    h += '</tbody></table>';
    listEl.innerHTML = h;
  }

  async function fetchPresets() {
    try {
      var r = await fetch('/api/framework-presets');
      if (r.ok) {
        var next = await r.json();
        presets = normalizePresetPayload(next);
      }
    } catch (e) { console.error('fetch presets:', e); }
    render();
  }

  window.toggleAddForm = function() {
    formEl.classList.toggle('visible');
  };

  window.submitPreset = async function() {
    var name = (document.getElementById('p-name').value || '').trim();
    if (!name) { showStatus('Name is required.', 'status-error'); return; }
    var body = {
      name: name,
      framework: (document.getElementById('p-framework').value || '').trim() || null,
      provider: 'anthropic',
      model: (document.getElementById('p-model').value || '').trim() || null,
      reasoning: (document.getElementById('p-reasoning').value || '').trim() || null,
      extraArgs: (document.getElementById('p-extraArgs').value || '').trim() || null,
      apiBaseUrl: (document.getElementById('p-apiBaseUrl').value || '').trim() || null,
      apiKey: (document.getElementById('p-apiKey').value || '').trim() || null,
    };
    try {
      var r = await fetch('/api/framework-presets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      var data = await r.json().catch(function() { return {}; });
      if (!r.ok) throw new Error(data.error || 'create failed');
      showStatus('Preset created: ' + (data.preset ? data.preset.name : name), 'status-ok');
      document.getElementById('p-name').value = '';
      document.getElementById('p-model').value = '';
      document.getElementById('p-reasoning').value = '';
      document.getElementById('p-extraArgs').value = '';
      document.getElementById('p-apiBaseUrl').value = '';
      document.getElementById('p-apiKey').value = '';
      formEl.classList.remove('visible');
      await fetchPresets();
    } catch (e) { showStatus('Create failed: ' + e.message, 'status-error'); }
  };

  window.deletePreset = async function(id) {
    if (!confirm('Delete this preset?')) return;
    try {
      var r = await fetch('/api/framework-presets/' + encodeURIComponent(id), { method: 'DELETE' });
      var data = await r.json().catch(function() { return {}; });
      if (!r.ok) throw new Error(data.error || 'delete failed');
      showStatus('Preset deleted.', 'status-ok');
      await fetchPresets();
    } catch (e) { showStatus('Delete failed: ' + e.message, 'status-error'); }
  };

  fetchPresets();
})();

(function(){
  var agentListEl = document.getElementById('agent-list');
  var agentStatusEl = document.getElementById('agent-status-msg');
  var allAgents = [];
  let startingAgents = new Set();

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function normalizeAgentPayload(payload) {
    if (!Array.isArray(payload)) return [];
    return payload.map(function(item) {
      if (!item || typeof item !== 'object') return null;
      var name = typeof item.name === 'string' ? item.name.trim() : '';
      if (!name) return null;
      return Object.assign({}, item, {
        name: name,
        type: typeof item.type === 'string' ? item.type : '',
        server: typeof item.server === 'string' ? item.server : '',
        environment: typeof item.environment === 'string' ? item.environment : '',
        online: item.online === true,
        blocked: item.blocked === true,
      });
    }).filter(Boolean);
  }

  function agentStatus(a) {
    if (a.online) return '<span style="color:var(--green)">online</span>';
    if (a.blocked) return '<span style="color:var(--yellow)">blocked</span>';
    return '<span style="color:var(--muted)">offline</span>';
  }

  function renderAgents() {
    if (allAgents.length === 0) {
      agentListEl.innerHTML = '<div class="empty-state">No agents registered.</div>';
      return;
    }
    var h = '<table class="preset-table"><thead><tr>'
      + '<th>Name</th><th>Framework</th><th>Version</th><th>Status</th><th>Server</th><th>Env</th><th></th>'
      + '</tr></thead><tbody>';
    for (var i = 0; i < allAgents.length; i++) {
      var a = allAgents[i];
      var ver = a.layoutVersion ? 'v' + a.layoutVersion : (a.agentModelVersion || '-');
      var srv = a.server || '-';
      var env = a.environment || '-';
      var isLocal = !a.server || a.server === 'local' || /^local/i.test(a.server);
      var validFw = a.type === 'claude' || a.type === 'codex';
      var isStarting = startingAgents.has(a.name);
      var canStart = !a.online && isLocal && validFw && !isStarting;
      var startBtn = isStarting
        ? '<button class="btn btn-accent" disabled>Starting...</button> '
        : (canStart
        ? '<button class="btn btn-accent" onclick="startAgent(\\'' + esc(a.name) + '\\')">Start</button> '
        : (!a.online && isLocal && !validFw ? '<span style="color:var(--muted);font-size:10px">no framework</span> ' : ''));
      var deleteBtn = !a.online
        ? '<button class="btn btn-danger" onclick="deleteAgent(\\'' + esc(a.name) + '\\')">Delete</button>'
        : '';
      h += '<tr>'
        + '<td><strong>' + esc(a.name) + '</strong></td>'
        + '<td>' + esc(a.type || '-') + '</td>'
        + '<td>' + esc(ver) + '</td>'
        + '<td>' + agentStatus(a) + '</td>'
        + '<td>' + esc(srv) + '</td>'
        + '<td>' + esc(env) + '</td>'
        + '<td>' + startBtn + deleteBtn + '</td>'
        + '</tr>';
    }
    h += '</tbody></table>';
    agentListEl.innerHTML = h;
  }

  function showAgentStatus(msg, cls) {
    agentStatusEl.textContent = msg;
    agentStatusEl.className = 'status-msg ' + (cls || '');
    if (msg) setTimeout(function() { if (agentStatusEl.textContent === msg) { agentStatusEl.textContent = ''; agentStatusEl.className = 'status-msg'; } }, 4000);
  }

  async function fetchAgents() {
    try {
      var r = await fetch('/api/agents/all');
      if (r.ok) {
        var next = await r.json();
        allAgents = normalizeAgentPayload(next);
      }
    } catch (e) { console.error('fetch agents:', e); }
    allAgents.sort(function(a, b) {
      if (a.online && !b.online) return -1;
      if (!a.online && b.online) return 1;
      return (a.name || '').localeCompare(b.name || '');
    });
    renderAgents();
  }

  window.startAgent = async function(name) {
    if (startingAgents.has(name)) return;
    startingAgents.add(name);
    renderAgents();
    showAgentStatus('Starting ' + name + '...', '');
    try {
      var r = await fetch('/api/agents/' + encodeURIComponent(name) + '/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
      });
      var data = await r.json().catch(function() { return {}; });
      if (!r.ok) throw new Error(data.error || 'start failed');
      showAgentStatus(name + ' starting (pid ' + (data.pid || '?') + ')', 'status-ok');
      await fetchAgents();
      setTimeout(fetchAgents, 5000);
    } catch (e) { showAgentStatus('Start failed: ' + e.message, 'status-error'); }
    finally {
      startingAgents.delete(name);
      renderAgents();
    }
  };

  window.deleteAgent = async function(name) {
    if (!confirm('Delete agent \\'' + name + '\\'? This cannot be undone.')) return;
    showAgentStatus('Deleting ' + name + '...', '');
    try {
      var r = await fetch('/api/agents/' + encodeURIComponent(name) + '?force=true', { method: 'DELETE' });
      var data = await r.json().catch(function() { return {}; });
      if (!r.ok) throw new Error(data.error || 'delete failed');
      showAgentStatus(name + ' deleted.', 'status-ok');
      await fetchAgents();
    } catch (e) { showAgentStatus('Delete failed: ' + e.message, 'status-error'); }
  };

  fetchAgents();
})();
</script>
</body>
</html>`;
}
