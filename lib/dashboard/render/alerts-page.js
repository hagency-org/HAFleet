import { DASHBOARD_BROWSER_GUARDS_SCRIPT } from './browser-guards.js';

export function renderAlertsPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Alerts</title>
<style>
:root{--bg:#0a0e14;--surface:#111922;--border:rgba(154,182,210,0.12);--text:#c8d6e5;--muted:rgba(200,214,229,0.45);--accent:#6dc1ff;--red:#ff6b6b;--yellow:#ffd93d;--green:#6bff9e}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'SF Mono','Fira Code',monospace;font-size:12px;background:var(--bg);color:var(--text);min-height:100vh}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.page{max-width:1200px;margin:0 auto;padding:16px 20px}
.header{display:flex;align-items:center;gap:16px;margin-bottom:16px}
.header h1{font-size:16px;color:var(--accent);font-weight:600;letter-spacing:1px}
.header a{font-size:11px;color:var(--muted)}
.stats-bar{display:flex;gap:12px;margin-bottom:12px;font-size:11px;color:var(--muted);flex-wrap:wrap}
.stats-bar .stat{padding:4px 10px;background:var(--surface);border:1px solid var(--border);border-radius:6px}
.stats-bar .stat.critical{border-color:rgba(255,107,107,0.4);color:var(--red)}
.stats-bar .stat.warning{border-color:rgba(255,217,61,0.4);color:var(--yellow)}
.filters{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.filters select,.filters input{background:var(--surface);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:11px;font-family:inherit}
.alert-list{display:flex;flex-direction:column;gap:2px}
.alert-row{display:grid;grid-template-columns:24px 80px 1fr 90px 80px 70px;gap:8px;align-items:center;padding:8px 12px;background:var(--surface);border:1px solid var(--border);border-radius:6px;cursor:pointer;transition:border-color 0.15s}
.alert-row:hover{border-color:rgba(109,193,255,0.3)}
.alert-row.selected{border-color:var(--accent);background:rgba(109,193,255,0.05)}
.sev-dot{width:10px;height:10px;border-radius:50%;display:inline-block}
.sev-dot.critical{background:var(--red)}
.sev-dot.warning{background:var(--yellow)}
.sev-dot.info{background:rgba(109,193,255,0.5)}
.alert-type{font-size:10px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.alert-summary{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.alert-agent{font-size:10px;color:var(--accent)}
.alert-status{font-size:10px;text-transform:uppercase;letter-spacing:0.5px}
.alert-status.open{color:var(--red)}
.alert-status.acknowledged{color:var(--yellow)}
.alert-status.assigned{color:var(--accent)}
.alert-status.resolved{color:var(--green)}
.alert-status.suppressed{color:var(--muted)}
.alert-time{font-size:10px;color:var(--muted);text-align:right}
.detail-panel{margin-top:16px;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px;display:none}
.detail-panel.visible{display:block}
.detail-panel h2{font-size:13px;color:var(--accent);margin-bottom:12px}
.detail-grid{display:grid;grid-template-columns:120px 1fr;gap:6px 12px;font-size:11px;margin-bottom:12px}
.detail-grid .label{color:var(--muted)}
.detail-actions{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.detail-actions button{background:var(--surface);border:1px solid var(--border);color:var(--text);padding:4px 12px;border-radius:4px;font-size:11px;font-family:inherit;cursor:pointer}
.detail-actions button:hover{border-color:var(--accent);color:var(--accent)}
.notes-section{margin-top:12px}
.note{padding:6px 0;border-bottom:1px solid var(--border);font-size:11px}
.note .note-meta{color:var(--muted);font-size:10px;margin-bottom:2px}
.note-form{display:flex;gap:8px;margin-top:8px}
.note-form input{flex:1;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:11px;font-family:inherit}
.note-form button{background:var(--surface);border:1px solid var(--border);color:var(--accent);padding:4px 12px;border-radius:4px;font-size:11px;font-family:inherit;cursor:pointer}
.empty{text-align:center;padding:40px;color:var(--muted);font-size:13px}
.occ{background:rgba(255,217,61,0.15);color:var(--yellow);padding:1px 6px;border-radius:8px;font-size:9px;margin-left:4px}
select option{background:#0d1723;color:#e2eaf3}
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <h1>ALERTS</h1>
    <a href="/">&#8592; Dashboard</a>
    <a href="/projects">Projects</a>
    <a href="/tasks">Tasks</a>
  </div>
  <div class="stats-bar" id="stats-bar"></div>
  <div class="filters">
    <select id="filter-status" onchange="window._applyFilters()">
      <option value="">All statuses</option>
      <option value="open" selected>Open</option>
      <option value="acknowledged">Acknowledged</option>
      <option value="assigned">Assigned</option>
      <option value="suppressed">Suppressed</option>
      <option value="resolved">Resolved</option>
    </select>
    <select id="filter-severity" onchange="window._applyFilters()">
      <option value="">All severities</option>
      <option value="critical">Critical</option>
      <option value="warning">Warning</option>
      <option value="info">Info</option>
    </select>
    <input id="filter-agent" type="text" placeholder="Filter by agent..." oninput="window._applyFilters()"/>
  </div>
  <div class="alert-list" id="alert-list"><div class="empty">Loading alerts...</div></div>
  <div class="detail-panel" id="detail-panel"></div>
</div>
<script>
${DASHBOARD_BROWSER_GUARDS_SCRIPT}
(() => {
  function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}
  function timeMs(ts){const n=Number(ts);if(Number.isFinite(n)&&n>0)return n;const p=Date.parse(ts);return Number.isFinite(p)?p:0}
  function isoTime(ts){const n=timeMs(ts);if(!n)return'-';try{return new Date(n).toISOString()}catch{return'-'}}
  function localTime(ts){const n=timeMs(ts);if(!n)return'-';try{return new Date(n).toLocaleString()}catch{return'-'}}
  function relTime(ts){const n=timeMs(ts);if(!n)return'-';const d=Math.max(0,Date.now()-n);if(d<60000)return Math.floor(d/1000)+'s ago';if(d<3600000)return Math.floor(d/60000)+'m ago';if(d<86400000)return Math.floor(d/3600000)+'h ago';return Math.floor(d/86400000)+'d ago'}
  function count(v){const n=Number(v);return Number.isFinite(n)&&n>0?n:0}
  function normalizeAlertStats(payload){const src=payload&&typeof payload==='object'?payload:{};return{total:count(src.total),byStatus:src.byStatus&&typeof src.byStatus==='object'?src.byStatus:{},bySeverity:src.bySeverity&&typeof src.bySeverity==='object'?src.bySeverity:{}}}
  function normalizeAlertsPayload(payload){
    if(!Array.isArray(payload))return[];
    return payload.map((item)=>{
      if(!item||typeof item!=='object')return null;
      const id=typeof item.id==='string'?item.id.trim():'';
      if(!id)return null;
      const severity=String(item.severity||'info').trim().toLowerCase();
      const status=String(item.status||'open').trim().toLowerCase();
      return{
        ...item,
        id,
        alertType:typeof item.alertType==='string'?item.alertType:'',
        summary:typeof item.summary==='string'?item.summary:'',
        source:typeof item.source==='string'?item.source:'',
        sourceAgent:typeof item.sourceAgent==='string'?item.sourceAgent:'',
        severity:['critical','warning','info'].includes(severity)?severity:'info',
        status:['open','acknowledged','assigned','resolved','suppressed'].includes(status)?status:'open',
        assignee:typeof item.assignee==='string'?item.assignee:'',
        linkedTaskId:typeof item.linkedTaskId==='string'?item.linkedTaskId:'',
        occurrences:count(item.occurrences)||1,
        tags:Array.isArray(item.tags)?item.tags.filter(t=>typeof t==='string'):[],
        notes:Array.isArray(item.notes)?item.notes.filter(n=>n&&typeof n==='object'):[],
        /*
         * THE FOUR FIELDS THAT MAKE AN ALERT ACTIONABLE, and the fifth that says whether it is.
         * buildActionability() downgrades a warning to 'info' when any of owner/assignee, runbook,
         * impact or recoveryCondition is missing, and records the shortfall in
         * missingActionableFields — so a raiser can fill all four and an operator would still have
         * seen none of it here, because this normalizer dropped them before the view. That is the
         * worst arrangement of the three: the discipline is enforced, paid for, and invisible.
         */
        owner:typeof item.owner==='string'?item.owner:'',
        runbook:typeof item.runbook==='string'?item.runbook:'',
        impact:typeof item.impact==='string'?item.impact:'',
        recoveryCondition:typeof item.recoveryCondition==='string'?item.recoveryCondition:'',
        actionable:item.actionable===true,
        originalSeverity:typeof item.originalSeverity==='string'?item.originalSeverity:'',
        missingActionableFields:Array.isArray(item.missingActionableFields)
          ?item.missingActionableFields.filter(f=>typeof f==='string'):[],
      };
    }).filter(Boolean);
  }

  let alerts=[];
  let selectedId=null;
  let alertsInFlight=false;
  let alertsRefreshQueued=false;
  let alertsRefreshTimer=null;
  let statsInFlight=false;
  let statsRefreshQueued=false;
  let alertActionInFlight=false;
  const listEl=document.getElementById('alert-list');
  const detailEl=document.getElementById('detail-panel');
  const statsEl=document.getElementById('stats-bar');

  const urlParams=new URLSearchParams(window.location.search);
  const preAgent=urlParams.get('sourceAgent')||'';
  if(preAgent)document.getElementById('filter-agent').value=preAgent;

  function currentAlertFilters(){
    return{
      status:document.getElementById('filter-status').value,
      severity:document.getElementById('filter-severity').value,
      agent:document.getElementById('filter-agent').value.trim(),
    };
  }
  function alertFilterKey(filters){
    return [filters.status||'',filters.severity||'',filters.agent||''].join('\\u001f');
  }

  async function fetchAlerts(){
    if(alertsInFlight){alertsRefreshQueued=true;return}
    alertsInFlight=true;
    const filters=currentAlertFilters();
    const requestFilterKey=alertFilterKey(filters);
    const p=new URLSearchParams();
    if(filters.status)p.set('status',filters.status);
    if(filters.severity)p.set('severity',filters.severity);
    if(filters.agent)p.set('sourceAgent',filters.agent);
    p.set('limit','200');
    try{
      const r=await fetch('/api/alerts?'+p);
      if(r.ok){
        const next=await r.json();
        if(requestFilterKey!==alertFilterKey(currentAlertFilters())){alertsRefreshQueued=true;return}
        alerts=normalizeAlertsPayload(next);
      }
    }catch{}
    finally{
      if(requestFilterKey===alertFilterKey(currentAlertFilters())){
        renderList();
        if(selectedId)renderDetail();
        fetchStats();
      }else{
        alertsRefreshQueued=true;
      }
      alertsInFlight=false;
      if(alertsRefreshQueued){alertsRefreshQueued=false;scheduleFetchAlerts(0)}
    }
  }

  function scheduleFetchAlerts(delay=0){
    if(alertsRefreshTimer)clearTimeout(alertsRefreshTimer);
    alertsRefreshTimer=setTimeout(()=>{alertsRefreshTimer=null;fetchAlerts()},delay);
  }

  async function assertAlertActionOk(r,label){
    const payload=await r.json().catch(()=>null);
    if(!r.ok||(payload&&payload.ok===false)){
      throw new Error((payload&&(payload.error||payload.reason))||label+' failed with HTTP '+r.status);
    }
    return payload;
  }

  function reportAlertActionError(label,e){
    const msg=(e&&e.message)||'request failed';
    console.debug('[alerts] '+label+' failed:',msg);
    alert(label+' failed: '+msg);
  }

  async function fetchStats(){
    if(statsInFlight){statsRefreshQueued=true;return}
    statsInFlight=true;
    try{
      const r=await fetch('/api/alerts/stats');
      if(!r.ok)return;
      const s=normalizeAlertStats(await r.json());
      const open=count(s.byStatus.open)+count(s.byStatus.acknowledged)+count(s.byStatus.assigned);
      const crit=count(s.bySeverity.critical);
      const warn=count(s.bySeverity.warning);
      statsEl.innerHTML=[
        '<span class="stat'+(crit?' critical':'')+'">Open: '+open+(crit?' ('+crit+' crit)':'')+'</span>',
        '<span class="stat">Assigned: '+count(s.byStatus.assigned)+'</span>',
        '<span class="stat">Suppressed: '+count(s.byStatus.suppressed)+'</span>',
        crit?'<span class="stat critical">Critical: '+crit+'</span>':'',
        warn?'<span class="stat warning">Warning: '+warn+'</span>':'',
        '<span class="stat">Info: '+count(s.bySeverity.info)+'</span>',
        '<span class="stat">Total: '+s.total+'</span>',
      ].filter(Boolean).join('');
    }catch{}
    finally{
      statsInFlight=false;
      if(statsRefreshQueued){statsRefreshQueued=false;fetchStats()}
    }
  }

  function renderList(){
    if(!alerts.length){listEl.innerHTML='<div class="empty">No alerts found</div>';return}
    const html=[];
    for(const a of alerts){
      const sel=a.id===selectedId?' selected':'';
      const occ=a.occurrences>1?' <span class="occ">x'+a.occurrences+'</span>':'';
      html.push('<div class="alert-row'+sel+'" onclick="window._sel(this.dataset.id)" data-id="'+esc(a.id)+'">'
        +'<span class="sev-dot '+esc(a.severity)+'"></span>'
        +'<span class="alert-type">'+esc(a.alertType||'')+'</span>'
        +'<span class="alert-summary">'+esc(a.summary||'')+occ+'</span>'
        +'<span class="alert-agent">'+esc(a.sourceAgent||'-')+'</span>'
        +'<span class="alert-status '+esc(a.status)+'">'+esc(a.status)+'</span>'
        +'<span class="alert-time">'+relTime(a.lastSeenAt)+'</span>'
        +'</div>');
    }
    listEl.innerHTML=html.join('');
  }

  window._sel=function(id){selectedId=id;renderList();renderDetail()};

  function renderDetail(){
    const a=alerts.find(x=>x.id===selectedId);
    if(!a){detailEl.classList.remove('visible');return}
    detailEl.classList.add('visible');
    const rows=[
      ['ID',esc(a.id)],['Type',esc(a.alertType||'')],
      ['Severity','<span class="sev-dot '+esc(a.severity)+'" style="vertical-align:middle"></span> '+esc(a.severity)],
      ['Source',esc(a.source||'')],
      ['Agent',a.sourceAgent?'<a href="/agents/'+encodeURIComponent(a.sourceAgent)+'">'+esc(a.sourceAgent)+'</a>':'-'],
      ['Status','<span class="alert-status '+esc(a.status)+'">'+esc(a.status)+'</span>'+(a.assignee?' &rarr; '+esc(a.assignee):'')],
      ['Occurrences',String(a.occurrences||1)],
      ['First Seen',isoTime(a.firstSeenAt)],
      ['Last Seen',isoTime(a.lastSeenAt)],
      ['Linked Task',a.linkedTaskId?esc(a.linkedTaskId):'-'],
      ['Tags',(a.tags||[]).map(t=>'<span style="background:rgba(109,193,255,0.1);padding:1px 6px;border-radius:4px;margin-right:4px;font-size:10px">'+esc(t)+'</span>').join('')||'-'],
      ['Owner',a.owner?esc(a.owner):'-'],
      ['Runbook',a.runbook?esc(a.runbook):'-'],
      ['Impact',a.impact?esc(a.impact):'-'],
      ['Recovers When',a.recoveryCondition?esc(a.recoveryCondition):'-'],
      /*
       * DOWNGRADED IS NOT THE SAME AS INFO, and this is the only place the difference can be seen. An
       * alert raised as a warning without the four fields above is FILED as info with the requested
       * severity kept in originalSeverity — so it looks like a note somebody meant as a note. Naming
       * the missing fields turns "why is nobody paging" into a list of what to add.
       */
      ['Actionable',a.actionable
        ?'<span style="color:var(--green)">yes</span>'
        :'<span style="color:var(--yellow)">no</span>'
          +(a.originalSeverity?' &mdash; raised as '+esc(a.originalSeverity)+', filed as '+esc(a.severity):'')
          +(a.missingActionableFields.length?', missing: '+esc(a.missingActionableFields.join(', ')):'')],
    ];
    const grid=rows.map(([l,v])=>'<div class="label">'+l+'</div><div>'+v+'</div>').join('');
    const acts=[];
    const trans={"open":["acknowledged","assigned","resolved","suppressed"],"acknowledged":["assigned","resolved"],"assigned":["resolved"],"suppressed":["open","assigned"]};
    const labels={"acknowledged":"Acknowledge","assigned":"Assign","resolved":"Resolve","suppressed":"Suppress","open":"Reopen"};
    for(const t of(trans[a.status]||[])){
      acts.push('<button onclick="window._tr(\\x27'+t+'\\x27)">'+labels[t]+'</button>');
    }
    acts.push('<button onclick="window._del()" style="color:var(--red)">Delete</button>');
    const notes=(a.notes||[]).map(n=>'<div class="note"><div class="note-meta">'+esc(n.author||'?')+' &middot; '+localTime(n.ts)+'</div><div>'+esc(n.text)+'</div></div>').join('');
    detailEl.innerHTML='<h2>'+esc(a.summary||a.alertType)+'</h2>'
      +'<div class="detail-grid">'+grid+'</div>'
      +'<div class="detail-actions">'+acts.join('')+'</div>'
      +(a.detail?'<div style="margin-bottom:12px;padding:8px;background:var(--bg);border-radius:4px;font-size:11px;white-space:pre-wrap;max-height:200px;overflow:auto">'+esc(typeof a.detail==='string'?a.detail:JSON.stringify(a.detail,null,2))+'</div>':'')
      +'<div class="notes-section"><strong style="font-size:11px;color:var(--muted)">Notes</strong>'+notes
      +'<div class="note-form"><input id="note-text" placeholder="Add a note..."/><button onclick="window._addNote()">Post</button></div></div>';
  }

  window._tr=async function(status){
    if(!selectedId||alertActionInFlight)return;
    const body={status};
    if(status==='assigned'){const a=prompt('Assign to:');if(!a)return;body.assignee=a}
    alertActionInFlight=true;
    try{
      const r=await fetch('/api/alerts/'+encodeURIComponent(selectedId)+'/transition',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      await assertAlertActionOk(r,'alert transition');
      scheduleFetchAlerts(0);
    }catch(e){reportAlertActionError('alert transition',e)}
    finally{alertActionInFlight=false}
  };
  window._addNote=async function(){
    if(!selectedId||alertActionInFlight)return;
    const t=(document.getElementById('note-text')||{}).value||'';
    if(!t.trim())return;
    alertActionInFlight=true;
    try{
      const r=await fetch('/api/alerts/'+encodeURIComponent(selectedId)+'/notes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:t.trim(),author:'operator'})});
      await assertAlertActionOk(r,'alert note');
      scheduleFetchAlerts(0);
    }catch(e){reportAlertActionError('alert note',e)}
    finally{alertActionInFlight=false}
  };
  window._del=async function(){
    if(!selectedId||alertActionInFlight||!confirm('Delete this alert?'))return;
    alertActionInFlight=true;
    try{
      const r=await fetch('/api/alerts/'+encodeURIComponent(selectedId),{method:'DELETE'});
      await assertAlertActionOk(r,'alert delete');
      selectedId=null;
      scheduleFetchAlerts(0);
    }catch(e){reportAlertActionError('alert delete',e)}
    finally{alertActionInFlight=false}
  };
  window._applyFilters=function(){scheduleFetchAlerts(150)};

  // SSE real-time updates
  connectDashboardStream((es)=>{
    ['alert_created','alert_updated','alert_resolved','alert_deleted'].forEach(e=>{
      es.addEventListener(e,()=>{scheduleFetchAlerts(0)});
    });
  });

  scheduleFetchAlerts(0);
})();
</script>
</body>
</html>`;
}
