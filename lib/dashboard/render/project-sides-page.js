/*
 * 项目方 — the operator's own view of who they are lending to, and on what budget.
 *
 * ADR-016 decision 1 gave project sides a record and ten endpoints; nothing rendered them, so the only
 * way to see or set an allocation was `curl`. That mattered more than it sounds: decision 6's budget
 * refusal and decision 7's cascade are both driven entirely by fields on this page, so without it the
 * two behaviours the operator asked for could not be observed at all.
 *
 * WHAT IS ON PURPOSE ABSENT: the credential. Entering an `as_token` — a whole namespace on a homeserver
 * HAFleet does not administer — through a browser form means it transits the dashboard tier, which is a
 * new secret path and the open half of ADR-016 decision 8. That decision has not been made, so the form
 * does not exist. The page shows WHETHER a credential is configured and its kind, which is what an
 * operator needs to know without the console ever holding the value.
 *
 * THREE STATES, NOT TWO, on the allocation. `null` is UNALLOCATED and refuses all work; `0` is a real
 * allocation that closes the side to new work while leaving it configured; a number is a budget. The
 * store draws that distinction and a UI that rendered `null` as `0` would erase it — so "not set" is
 * printed as its own word and never as a zero.
 */
export function renderProjectSidesPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Project Sides</title>
<style>
:root{--bg:#0a0e14;--surface:#111922;--border:rgba(154,182,210,0.12);--text:#c8d6e5;--muted:rgba(200,214,229,0.45);--accent:#6dc1ff;--red:#ff6b6b;--yellow:#ffd93d;--green:#6bff9e}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'SF Mono','Fira Code',monospace;font-size:12px;background:var(--bg);color:var(--text);min-height:100vh}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.page{max-width:1000px;margin:0 auto;padding:16px 20px}
.header{display:flex;align-items:center;gap:16px;margin-bottom:20px}
.header h1{font-size:16px;color:var(--accent);font-weight:600;letter-spacing:1px}
.header a{font-size:11px;color:var(--muted)}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:16px}
.panel-label{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:12px}
.hint{font-size:11px;color:var(--muted);margin-bottom:12px;line-height:1.5}
.t{width:100%;border-collapse:collapse;font-size:11px}
.t th{text-align:left;padding:6px 8px;color:var(--muted);font-size:10px;letter-spacing:1px;text-transform:uppercase;border-bottom:1px solid var(--border)}
.t td{padding:8px;border-bottom:1px solid rgba(154,182,210,0.06);vertical-align:middle}
.t tr:hover{background:rgba(109,193,255,0.04)}
.empty-state{text-align:center;padding:24px;color:var(--muted);font-size:11px}
.field-label{font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:var(--muted);margin-top:10px;margin-bottom:4px}
.cfg-input{width:100%;margin-top:2px;background:rgba(255,255,255,0.03);border:1px solid rgba(109,193,255,0.24);border-radius:8px;color:var(--text);padding:8px 10px;outline:none;font-size:12px;font-family:inherit}
.cfg-input:focus{border-color:rgba(109,193,255,0.5)}
.alloc-input{width:120px;background:rgba(255,255,255,0.03);border:1px solid rgba(109,193,255,0.24);border-radius:6px;color:var(--text);padding:4px 6px;font-size:11px;font-family:inherit}
.btn{background:var(--surface);border:1px solid var(--border);color:var(--text);padding:5px 12px;border-radius:6px;font-size:11px;font-family:inherit;cursor:pointer;letter-spacing:0.5px}
.btn:hover{border-color:var(--accent);color:var(--accent)}
.btn-accent{border-color:rgba(109,193,255,0.4);color:var(--accent)}
.btn-danger{border-color:rgba(255,107,107,0.3);color:var(--red)}
.btn-danger:hover{border-color:var(--red);background:rgba(255,107,107,0.08)}
.status-msg{font-size:11px;margin-top:8px;min-height:16px}
.status-ok{color:var(--green)}
.status-error{color:var(--red)}
.status-warn{color:var(--yellow)}
.add-form{display:none;margin-top:16px;padding-top:16px;border-top:1px solid var(--border)}
.add-form.visible{display:block}
.pill{display:inline-block;padding:1px 7px;border-radius:10px;font-size:10px;letter-spacing:0.5px}
.pill-on{background:rgba(107,255,158,0.12);color:var(--green)}
.pill-off{background:rgba(200,214,229,0.1);color:var(--muted)}
.pill-warn{background:rgba(255,217,61,0.12);color:var(--yellow)}
.pill-bad{background:rgba(255,107,107,0.12);color:var(--red)}
.unset{color:var(--yellow)}
.bar{height:4px;background:rgba(154,182,210,0.12);border-radius:2px;margin-top:4px;overflow:hidden}
.bar>span{display:block;height:100%;background:var(--accent)}
.bar.full>span{background:var(--red)}
.num{font-variant-numeric:tabular-nums}
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <h1>PROJECT SIDES</h1>
    <a href="/">&larr; Monitor</a>
    <a href="/config">Config</a>
    <a href="/alerts">Alerts</a>
    <a href="/pool">Pool</a>
  </div>

  <div class="panel">
    <div class="panel-label">项目方 — who we are registered with</div>
    <div class="hint">
      One side per homeserver; the id <em>is</em> the server name. An allocation is what this side may draw
      from you in tokens &mdash; <span class="unset">not set</span> means UNALLOCATED, which refuses all work
      rather than meaning unlimited, and <span class="num">0</span> is a real allocation that closes the side
      while leaving it configured. Credentials are never shown here or sent to this page.
    </div>
    <div id="side-list"></div>
    <div style="margin-top:12px"><button class="btn btn-accent" onclick="toggleAdd()">+ Add Project Side</button></div>
    <div id="add-form" class="add-form">
      <div class="field-label">Server name (this becomes the id)</div>
      <input id="s-server" class="cfg-input" placeholder="e.g. matrix.customer.example">
      <div class="field-label">API base URL</div>
      <input id="s-url" class="cfg-input" placeholder="e.g. https://matrix.customer.example">
      <div class="field-label">Label (optional)</div>
      <input id="s-label" class="cfg-input" placeholder="e.g. BigLittle engagement">
      <div style="margin-top:12px;display:flex;gap:8px">
        <button class="btn btn-accent" onclick="submitSide()">Create</button>
        <button class="btn" onclick="toggleAdd()">Cancel</button>
      </div>
      <div class="hint" style="margin-top:10px;margin-bottom:0">
        A side is created without a credential and without an allocation, so it refuses work until you set both.
        The credential is set out of band &mdash; see the note in <code>project-side-proxy-routes.js</code>.
      </div>
    </div>
    <div id="status" class="status-msg"></div>
  </div>
</div>
<script>
(() => {
  const listEl = document.getElementById('side-list');
  const statusEl = document.getElementById('status');
  let sides = [];
  let budgets = {};

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

  function show(msg, cls) {
    statusEl.textContent = msg;
    statusEl.className = 'status-msg ' + (cls || '');
    if (msg && cls !== 'status-error') {
      setTimeout(() => { if (statusEl.textContent === msg) { statusEl.textContent = ''; statusEl.className = 'status-msg'; } }, 4000);
    }
  }

  // Grouped thousands, and NEVER a fabricated zero: null renders as its own word.
  const n = (v) => (typeof v === 'number' && isFinite(v)) ? v.toLocaleString('en-US') : null;
  const tokens = (v) => { const s = n(v); return s === null ? '<span class="unset">not set</span>' : '<span class="num">' + s + '</span>'; };

  function accessPill(s) {
    const st = s && s.accessState ? String(s.accessState) : '';
    if (st === 'ok') return '<span class="pill pill-on">reachable</span>';
    if (st === 'unauthorized' || st === 'forbidden') return '<span class="pill pill-bad">' + esc(st) + '</span>';
    if (st === 'unreachable') return '<span class="pill pill-warn">unreachable</span>';
    return '<span class="pill pill-off">never checked</span>';
  }

  function budgetCell(id) {
    const b = budgets[id];
    if (!b) return '<span class="pill pill-off">—</span>';
    if (b.allocated === null || b.allocated === undefined) {
      return '<span class="unset">not set</span><div class="hint" style="margin:2px 0 0">refuses all work</div>';
    }
    const used = b.allocated > 0 ? Math.min(100, Math.round((b.committed / b.allocated) * 100)) : 100;
    return '<span class="num">' + n(b.remaining) + '</span> of <span class="num">' + n(b.allocated) + '</span> left'
      + '<div class="bar' + (b.remaining === 0 ? ' full' : '') + '"><span style="width:' + used + '%"></span></div>'
      + '<div class="hint" style="margin:2px 0 0"><span class="num">' + n(b.committed) + '</span> committed</div>';
  }

  function render() {
    if (!sides.length) {
      listEl.innerHTML = '<div class="empty-state">No project sides configured. Nothing can be lent until one exists.</div>';
      return;
    }
    let h = '<table class="t"><thead><tr>'
      + '<th>Server</th><th>Representative</th><th>Credential</th><th>Reachability</th>'
      + '<th>Allocation</th><th>Set allocation</th><th></th></tr></thead><tbody>';
    for (const s of sides) {
      const id = esc(s.id);
      h += '<tr>'
        + '<td><strong>' + id + '</strong>'
          + (s.active === false ? ' <span class="pill pill-off">inactive</span>' : '')
          + (s.label ? '<div class="hint" style="margin:2px 0 0">' + esc(s.label) + '</div>' : '')
        + '</td>'
        // representative is an OBJECT on the record, not a flat mxid: read from it rather than
        // inventing a field name that would silently render "none" for every configured side.
        // (No backticks in here — this comment lives inside a template literal, and one would end it.)
        + '<td>' + (s.representative && s.representative.mxid
            ? esc(s.representative.mxid)
            : '<span class="pill pill-off">none</span>') + '</td>'
        + '<td>' + (s.credentialKind
            ? '<span class="pill pill-on">' + esc(s.credentialKind) + '</span>'
            : '<span class="pill pill-warn">not set</span>') + '</td>'
        + '<td>' + accessPill(s) + '</td>'
        + '<td>' + budgetCell(s.id) + '</td>'
        + '<td><input class="alloc-input num" id="alloc-' + id + '" placeholder="tokens">'
          + ' <button class="btn" onclick="setAlloc(\\'' + id + '\\')">Set</button></td>'
        + '<td>'
          + (s.active === false
              ? '<button class="btn" onclick="sideAction(\\'' + id + '\\',\\'reactivate\\')">Reactivate</button>'
              : '<button class="btn" onclick="sideAction(\\'' + id + '\\',\\'deactivate\\')">Deactivate</button>')
          + ' <button class="btn btn-danger" onclick="removeSide(\\'' + id + '\\')">Remove</button>'
        + '</td>'
        + '</tr>';
    }
    listEl.innerHTML = h + '</tbody></table>';
  }

  async function load() {
    try {
      const r = await fetch('/api/project-sides');
      const d = await r.json().catch(() => ({}));
      sides = Array.isArray(d.sides) ? d.sides : [];
    } catch (e) { show('Could not load project sides: ' + e.message, 'status-error'); return; }
    /*
     * The budget is a SEPARATE read per side, because it reaches across into the engagement store —
     * a side record should not silently depend on another store being consistent. One failing budget
     * therefore leaves its row showing an em dash rather than blanking the table.
     */
    budgets = {};
    await Promise.all(sides.map(async (s) => {
      try {
        const r = await fetch('/api/project-sides/' + encodeURIComponent(s.id) + '/budget');
        if (r.ok) budgets[s.id] = await r.json();
      } catch { /* leave it absent; the row says so */ }
    }));
    render();
  }

  window.toggleAdd = () => document.getElementById('add-form').classList.toggle('visible');

  window.submitSide = async () => {
    const server = (document.getElementById('s-server').value || '').trim();
    if (!server) { show('Server name is required — it becomes the id.', 'status-error'); return; }
    const body = {
      server_name: server,
      api_base_url: (document.getElementById('s-url').value || '').trim() || null,
      label: (document.getElementById('s-label').value || '').trim() || null,
    };
    try {
      const r = await fetch('/api/project-sides', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || ('create failed (HTTP ' + r.status + ')'));
      show('Created ' + server + '. It has no credential and no allocation yet, so it refuses work.', 'status-ok');
      document.getElementById('s-server').value = '';
      document.getElementById('s-url').value = '';
      document.getElementById('s-label').value = '';
      toggleAdd();
      await load();
    } catch (e) { show('Create failed: ' + e.message, 'status-error'); }
  };

  window.setAlloc = async (id) => {
    const el = document.getElementById('alloc-' + id);
    const raw = (el && el.value || '').trim();
    /*
     * An EMPTY box means UNALLOCATED, and it is sent as an explicit null rather than skipped. Treating
     * blank as "no change" would leave an operator unable to withdraw an allocation from this page at
     * all, and '0' already means something different — closed, but configured.
     */
    const value = raw === '' ? null : Number(raw);
    if (value !== null && (!isFinite(value) || value < 0)) { show('Allocation must be a non-negative number, or empty to unset.', 'status-error'); return; }
    try {
      const r = await fetch('/api/project-sides/' + encodeURIComponent(id) + '/allocation', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ allocated_tokens: value }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || ('failed (HTTP ' + r.status + ')'));
      show(value === null
        ? id + ' is now UNALLOCATED and will refuse work.'
        : 'Allocation for ' + id + ' set to ' + value.toLocaleString('en-US') + ' tokens.', 'status-ok');
      if (el) el.value = '';
      await load();
    } catch (e) { show('Could not set the allocation: ' + e.message, 'status-error'); }
  };

  window.sideAction = async (id, action) => {
    try {
      const r = await fetch('/api/project-sides/' + encodeURIComponent(id) + '/' + action, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || ('failed (HTTP ' + r.status + ')'));
      show(id + ' ' + action + 'd.', 'status-ok');
      await load();
    } catch (e) { show(action + ' failed: ' + e.message, 'status-error'); }
  };

  window.removeSide = async (id) => {
    /*
     * NO CONFIRMATION UP FRONT, deliberately. The backend refuses an active side with 409 'side_active'
     * and takes nothing down, so the first attempt is safe by construction — and the confirmation the
     * operator then sees can state what the cascade will actually do, instead of asking them to agree to
     * something described in the abstract.
     */
    try {
      let r = await fetch('/api/project-sides/' + encodeURIComponent(id), { method: 'DELETE' });
      let d = await r.json().catch(() => ({}));
      if (r.status === 409 && d.code === 'side_active') {
        const ok = window.confirm(
          'Removing ' + id + ' will END its active engagements and DEACTIVATE its approval bindings, and RETIRE '
          + 'the agents minted for it.\\n\\nNothing is deleted: records are kept with a reason, and usage stays in '
          + 'the ledger.\\n\\nProceed?');
        if (!ok) { show('Left ' + id + ' in place.', 'status-warn'); return; }
        r = await fetch('/api/project-sides/' + encodeURIComponent(id) + '?force=true', { method: 'DELETE' });
        d = await r.json().catch(() => ({}));
      }
      if (!r.ok) throw new Error(d.error || ('remove failed (HTTP ' + r.status + ')'));
      const parts = [];
      if (Array.isArray(d.retiredAgents) && d.retiredAgents.length) parts.push(d.retiredAgents.length + ' agent(s) retired');
      if (Array.isArray(d.endedEngagements) && d.endedEngagements.length) parts.push(d.endedEngagements.length + ' engagement(s) ended');
      if (Array.isArray(d.deactivatedBindings) && d.deactivatedBindings.length) parts.push(d.deactivatedBindings.length + ' binding(s) deactivated');
      show('Removed ' + id + (parts.length ? ' — ' + parts.join(', ') + '.' : ' — nothing was attached to it.'), 'status-ok');
      await load();
    } catch (e) { show('Remove failed: ' + e.message, 'status-error'); }
  };

  load();
  setInterval(load, 15000);
})();
</script>
</body>
</html>`;
}
