import { DASHBOARD_BROWSER_GUARDS_SCRIPT } from './browser-guards.js';

export function renderTasksPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Tasks</title>
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
select option{background:#0d1723;color:#e2eaf3}
.filters{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center}
.filters select,.filters input{background:var(--surface);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:11px;font-family:inherit}
.task-list-table{width:100%;border-collapse:collapse;font-size:12px}
.task-list-table th{text-align:left;padding:6px 8px;border-bottom:1px solid rgba(154,182,210,0.2);color:var(--muted);font-weight:500;font-size:11px;letter-spacing:0.5px}
.task-list-table td{padding:5px 8px;border-bottom:1px solid rgba(154,182,210,0.08);vertical-align:top}
.task-list-table tr:hover{background:rgba(109,193,255,0.04);cursor:pointer}
.task-status-badge{display:inline-block;padding:2px 7px;border-radius:8px;font-size:10px;font-weight:600;letter-spacing:0.4px}
.task-status-created{background:rgba(154,182,210,0.15);color:rgba(154,182,210,0.9)}
.task-status-accepted{background:rgba(109,193,255,0.15);color:rgba(109,193,255,0.9)}
.task-status-in_progress{background:rgba(100,220,160,0.15);color:rgba(100,220,160,0.9)}
.task-status-blocked{background:rgba(255,160,80,0.15);color:rgba(255,160,80,0.9)}
.task-status-done{background:rgba(120,120,140,0.15);color:rgba(120,120,140,0.9)}
.task-priority-badge{font-size:10px;font-weight:600;letter-spacing:0.3px}
.task-priority-p0{color:rgba(255,80,80,0.9)}
.task-priority-p1{color:rgba(255,160,80,0.9)}
.task-priority-p2{color:var(--muted)}
.task-priority-p3{color:rgba(120,120,140,0.7)}
.task-create-form{display:flex;flex-direction:column;gap:8px;margin-bottom:16px;padding:12px;background:var(--surface);border:1px solid var(--border);border-radius:6px}
.task-create-form textarea{min-height:60px;resize:vertical;background:rgba(0,0,0,0.2);border:1px solid var(--border);color:var(--text);padding:6px 8px;border-radius:4px;font-size:11px;font-family:inherit}
.task-create-form input,.task-create-form select{background:rgba(0,0,0,0.2);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:11px;font-family:inherit}
.task-create-row{display:flex;gap:8px;align-items:center}
.task-create-row button{background:var(--accent);color:var(--bg);border:none;padding:4px 12px;border-radius:4px;font-size:11px;font-family:inherit;cursor:pointer;font-weight:600}
.task-detail-back{font-size:11px;color:var(--accent);cursor:pointer;margin-bottom:8px;display:inline-block}
.task-detail-back:hover{text-decoration:underline}
.task-detail-title{font-size:15px;font-weight:600;margin-bottom:6px}
.task-detail-meta{font-size:11px;color:var(--muted);margin-bottom:10px}
.task-detail-desc{font-size:12px;line-height:1.6;margin-bottom:14px;white-space:pre-wrap}
.task-comments{margin-top:10px}
.task-comment{padding:8px 10px;border-left:2px solid rgba(109,193,255,0.3);margin-bottom:8px;background:rgba(0,0,0,0.12);border-radius:0 6px 6px 0}
.task-comment-meta{font-size:10px;color:var(--muted);margin-bottom:3px}
.task-comment-text{font-size:12px;line-height:1.5;white-space:pre-wrap}
.task-comment-form{display:flex;gap:8px;align-items:flex-end;margin-top:8px}
.task-comment-form textarea{flex:1;min-height:40px;resize:vertical;background:rgba(0,0,0,0.2);border:1px solid var(--border);color:var(--text);padding:6px 8px;border-radius:4px;font-size:11px;font-family:inherit}
.task-comment-form button{background:var(--accent);color:var(--bg);border:none;padding:4px 12px;border-radius:4px;font-size:11px;font-family:inherit;cursor:pointer;font-weight:600}
.task-empty-state{text-align:center;color:var(--muted);padding:24px 0;font-size:12px}
.task-status-select{font-size:11px;padding:2px 4px;background:rgba(0,0,0,0.2);border:1px solid rgba(154,182,210,0.15);color:var(--text);border-radius:4px}
.task-delete-btn{font-size:10px;color:var(--red);background:none;border:1px solid rgba(255,107,107,0.25);padding:3px 10px;border-radius:4px;cursor:pointer;font-family:inherit;margin-top:12px}
.hidden{display:none}
.toggle-form{font-size:11px;color:var(--accent);cursor:pointer;background:none;border:1px solid rgba(109,193,255,0.2);padding:3px 10px;border-radius:4px;font-family:inherit}
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <h1>TASKS</h1>
    <a href="/">&#8592; Dashboard</a>
    <a href="/alerts">Alerts</a>
    <a href="/config">Config</a>
  </div>
  <div class="filters">
    <select id="filter-assignee" onchange="applyFilter()"><option value="">All Agents</option></select>
    <select id="filter-status" onchange="applyFilter()"><option value="">All Statuses</option></select>
    <button class="toggle-form" onclick="toggleCreate()">+ New Task</button>
  </div>
  <div id="create-form" class="task-create-form hidden">
    <input id="create-title" placeholder="Title" />
    <textarea id="create-desc" placeholder="Description (optional)"></textarea>
    <div class="task-create-row">
      <input id="create-assignee" placeholder="Assignee" />
      <select id="create-priority"><option value="p0">P0</option><option value="p1">P1</option><option value="p2" selected>P2</option><option value="p3">P3</option></select>
      <button onclick="createTask()">Create</button>
    </div>
  </div>
  <div id="task-list-root"></div>
  <div id="task-detail-panel" class="hidden"><div id="task-detail-root"></div></div>
</div>
<script>
${DASHBOARD_BROWSER_GUARDS_SCRIPT}
(function(){
  function esc(s){if(!s)return'';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
  function fmtTaskTime(iso){if(!iso)return'-';try{const d=new Date(iso);return d.toLocaleDateString(undefined,{month:'short',day:'numeric'})+' '+d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})}catch{return iso}}

  let taskCache=[];
  let detailId=null;
  const TASK_LIST_LIMIT=200;
  let refreshInFlight=false;
  let refreshQueued=false;

  function normalizeTaskPayload(payload){
    if(!Array.isArray(payload))return[];
    return payload.map((item)=>{
      if(!item||typeof item!=='object')return null;
      const id=typeof item.id==='string'?item.id.trim():'';
      if(!id)return null;
      const priority=String(item.priority||'p2').trim().toLowerCase();
      const status=String(item.status||'created').trim().toLowerCase();
      return{
        ...item,
        id,
        title:typeof item.title==='string'?item.title:'',
        description:typeof item.description==='string'?item.description:'',
        assignee:typeof item.assignee==='string'?item.assignee:'',
        priority:['p0','p1','p2','p3'].includes(priority)?priority:'p2',
        status:['created','accepted','in_progress','blocked','done'].includes(status)?status:'created',
        comments:Array.isArray(item.comments)?item.comments.filter(c=>c&&typeof c==='object'):[],
        created_at:item.created_at||item.createdAt||'',
        waiting_reason:typeof item.waiting_reason==='string'?item.waiting_reason:'',
      };
    }).filter(Boolean);
  }
  function taskListUrl(filters){
    const p=new URLSearchParams();
    p.set('limit',String(TASK_LIST_LIMIT));
    if(filters.assignee)p.set('assignee',filters.assignee);
    if(filters.status)p.set('status',filters.status);
    return '/api/tasks?'+p.toString();
  }

  window.toggleCreate=function(){
    document.getElementById('create-form').classList.toggle('hidden');
  };

  window.applyFilter=function(){
    const a=document.getElementById('filter-assignee').value;
    const s=document.getElementById('filter-status').value;
    const url=new URL(window.location);
    if(a){url.searchParams.set('assignee',a)}else{url.searchParams.delete('assignee')}
    if(s){url.searchParams.set('status',s)}else{url.searchParams.delete('status')}
    history.replaceState(null,'',url);
    refresh();
  };

  function getFilters(){
    const a=document.getElementById('filter-assignee');
    const s=document.getElementById('filter-status');
    const params=new URL(window.location).searchParams;
    return{assignee:(a&&a.value)||params.get('assignee')||'',status:(s&&s.value)||params.get('status')||''};
  }

  async function refresh(){
    if(refreshInFlight){refreshQueued=true;return}
    refreshInFlight=true;
    try{
      const r=await fetch(taskListUrl(getFilters()));
      if(!r.ok)return;
      taskCache=normalizeTaskPayload(await r.json());
      // populate assignee dropdown
      const fEl=document.getElementById('filter-assignee');
      if(fEl){
        const cur=fEl.value;
        const names=[...new Set(taskCache.map(t=>t.assignee).filter(Boolean))].sort();
        const opts='<option value="">All Agents</option>'+names.map(n=>'<option value="'+esc(n)+'">'+esc(n)+'</option>').join('');
        fEl.innerHTML=opts;
        // restore from URL param or previous selection
        const urlAssignee=new URL(window.location).searchParams.get('assignee')||'';
        fEl.value=urlAssignee||cur||'';
      }
      // populate status dropdown
      const sEl=document.getElementById('filter-status');
      if(sEl){
        const cur=sEl.value;
        const urlStatus=new URL(window.location).searchParams.get('status')||'';
        sEl.value=urlStatus||cur||'';
      }
      renderList();
      if(detailId){
        const t=taskCache.find(x=>x.id===detailId);
        if(t)renderDetail(t);
      }
    }catch{return}
    finally{
      refreshInFlight=false;
      if(refreshQueued){refreshQueued=false;refresh()}
    }
  }

  function renderList(){
    const root=document.getElementById('task-list-root');
    const dp=document.getElementById('task-detail-panel');
    if(dp)dp.classList.add('hidden');
    if(!root)return;
    const f=getFilters();
    let items=taskCache;
    if(f.assignee)items=items.filter(t=>t.assignee===f.assignee);
    if(f.status)items=items.filter(t=>t.status===f.status);
    if(!items.length){root.innerHTML='<div class="task-empty-state">No tasks found.</div>';return}
    const sorted=[...items].sort((a,b)=>{
      const so={in_progress:0,accepted:1,blocked:2,created:3,done:4};
      const po={p0:0,p1:1,p2:2,p3:3};
      const sd=(so[a.status]??5)-(so[b.status]??5);
      if(sd!==0)return sd;
      const pd=(po[a.priority]??2)-(po[b.priority]??2);
      if(pd!==0)return pd;
      return(b.created_at||'').localeCompare(a.created_at||'');
    });
    let html='<table class="task-list-table"><thead><tr><th>Status</th><th>Pri</th><th>Title</th><th>Assignee</th><th>Comments</th><th>Created</th></tr></thead><tbody>';
    for(const t of sorted){
      const cc=Array.isArray(t.comments)?t.comments.length:0;
      html+='<tr onclick="showDetail(\\''+esc(t.id)+'\\')"><td><span class="task-status-badge task-status-'+esc(t.status)+'">'+esc(t.status)+'</span></td><td><span class="task-priority-badge task-priority-'+esc(t.priority)+'">'+esc((t.priority||'p2').toUpperCase())+'</span></td><td>'+esc(t.title||'-')+'</td><td>'+esc(t.assignee||'-')+'</td><td>'+(cc>0?cc:'-')+'</td><td>'+esc(fmtTaskTime(t.created_at))+'</td></tr>';
    }
    html+='</tbody></table>';
    root.innerHTML=html;
  }

  function renderDetail(task){
    const dp=document.getElementById('task-detail-panel');
    const root=document.getElementById('task-detail-root');
    if(!dp||!root)return;
    dp.classList.remove('hidden');
    detailId=task.id;
    const statusOpts=['created','accepted','in_progress','blocked','done'];
    let html='<span class="task-detail-back" onclick="backToList()">&#8592; Back to list</span>'
      +'<div class="task-detail-title">'+esc(task.title||'Untitled')+'</div>'
      +'<div class="task-detail-meta"><strong>ID:</strong> '+esc(task.id)+' &middot; <strong>Priority:</strong> <span class="task-priority-badge task-priority-'+esc(task.priority)+'">'+esc((task.priority||'p2').toUpperCase())+'</span> &middot; <strong>Assignee:</strong> '+esc(task.assignee||'unassigned')+' &middot; <strong>Created:</strong> '+esc(fmtTaskTime(task.created_at))+'</div>'
      +'<div class="task-detail-meta"><strong>Status:</strong> <select class="task-status-select" id="task-detail-status" onchange="changeStatus(\\''+esc(task.id)+'\\')"><option></option>';
    for(const s of statusOpts){html+='<option value="'+s+'"'+(task.status===s?' selected':'')+'>'+s+'</option>';}
    html+='</select></div>';
    if(task.description){html+='<div class="task-detail-desc">'+esc(task.description)+'</div>';}
    if(task.waiting_reason){html+='<div class="task-detail-meta"><strong>Waiting:</strong> '+esc(task.waiting_reason)+'</div>';}
    // comments
    html+='<div class="task-comments"><strong style="font-size:11px;color:var(--muted)">Comments</strong>';
    if(Array.isArray(task.comments)){
      for(const c of task.comments){
        html+='<div class="task-comment"><div class="task-comment-meta">'+esc(c.author||'?')+' &middot; '+esc(fmtTaskTime(c.ts||c.created_at))+'</div><div class="task-comment-text">'+esc(c.text)+'</div></div>';
      }
    }
    html+='<div class="task-comment-form"><textarea id="task-comment-input" placeholder="Add a comment..."></textarea><button onclick="addComment(\\''+esc(task.id)+'\\')">Post</button></div></div>';
    html+='<button class="task-delete-btn" onclick="deleteTask(\\''+esc(task.id)+'\\')">Delete Task</button>';
    root.innerHTML=html;
  }

  window.showDetail=function(id){
    const t=taskCache.find(x=>x.id===id);
    if(t)renderDetail(t);
  };
  window.backToList=function(){
    detailId=null;
    document.getElementById('task-detail-panel').classList.add('hidden');
  };
  window.createTask=async function(){
    const title=(document.getElementById('create-title')||{}).value||'';
    if(!title.trim()){alert('Title is required');return}
    const desc=(document.getElementById('create-desc')||{}).value||'';
    const assignee=(document.getElementById('create-assignee')||{}).value||'';
    const priority=(document.getElementById('create-priority')||{}).value||'p2';
    try{
      const r=await fetch('/api/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:title.trim(),description:desc.trim(),assignee:assignee.trim()||undefined,priority})});
      if(!r.ok){const d=await r.json().catch(()=>({}));throw new Error(d.error||'create failed')}
      document.getElementById('create-title').value='';
      document.getElementById('create-desc').value='';
      document.getElementById('create-assignee').value='';
      document.getElementById('create-form').classList.add('hidden');
      refresh();
    }catch(e){alert('Create failed: '+e.message)}
  };
  window.changeStatus=async function(id){
    const sel=document.getElementById('task-detail-status');
    if(!sel)return;
    try{
      const r=await fetch('/api/tasks/'+encodeURIComponent(id)+'/transition',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:sel.value})});
      const d=await r.json().catch(()=>({}));
      if(!r.ok)throw new Error(d.error||'transition failed');
      refresh();
    }catch(e){alert('Status change failed: '+e.message)}
  };
  window.addComment=async function(id){
    const input=document.getElementById('task-comment-input');
    if(!input)return;
    const text=input.value.trim();
    if(!text)return;
    try{
      const r=await fetch('/api/tasks/'+encodeURIComponent(id)+'/comments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,author:'operator'})});
      if(!r.ok){const d=await r.json().catch(()=>({}));throw new Error(d.error||'comment failed')}
      refresh();
    }catch(e){alert('Comment failed: '+e.message)}
  };
  window.deleteTask=async function(id){
    if(!confirm('Delete task '+id+'?'))return;
    try{
      const r=await fetch('/api/tasks/'+encodeURIComponent(id),{method:'DELETE'});
      if(!r.ok){const d=await r.json().catch(()=>({}));throw new Error(d.error||'delete failed')}
      detailId=null;
      refresh();
    }catch(e){alert('Delete failed: '+e.message)}
  };

  // SSE real-time updates
  connectDashboardStream((es)=>{
    ['task_created','task_updated','task_deleted'].forEach(e=>{
      es.addEventListener(e,()=>{refresh()});
    });
  });

  refresh();
})();
</script>
</body>
</html>`;
}
