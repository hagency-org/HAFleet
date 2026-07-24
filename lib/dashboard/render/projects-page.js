import { DASHBOARD_BROWSER_GUARDS_SCRIPT } from './browser-guards.js';

export function renderProjectsPage() {
  return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>AgentChat Project Board</title>
<style>
:root{
  --bg:#0a0e14;--surface:#111922;--surface-2:#0e151e;--surface-3:#17212d;
  --border:rgba(154,182,210,.13);--border-strong:rgba(109,193,255,.28);
  --text:#c8d6e5;--muted:rgba(200,214,229,.48);--faint:rgba(200,214,229,.24);
  --accent:#6dc1ff;--green:#6bff9e;--yellow:#ffd93d;--red:#ff7373;--purple:#b99cff;
}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text)}
body{font-family:'SF Mono','Fira Code','Consolas',monospace;font-size:12px}
button,select{font:inherit}
a{color:var(--muted);text-decoration:none}a:hover{color:var(--accent)}
.page{max-width:1640px;margin:0 auto;padding:18px 22px 44px}
.header{display:flex;align-items:flex-start;gap:22px;margin-bottom:18px}
.title-wrap{min-width:250px}
.eyebrow{font-size:9px;letter-spacing:2.5px;color:var(--faint);text-transform:uppercase}
h1{margin:4px 0 0;font-size:18px;letter-spacing:.8px;color:var(--accent);font-weight:650}
.nav{display:flex;align-items:center;gap:14px;margin-left:auto;padding-top:7px;font-size:10px;letter-spacing:.8px;text-transform:uppercase}
.refresh-btn{border:1px solid var(--border);background:var(--surface);color:var(--muted);border-radius:6px;padding:6px 10px;cursor:pointer}
.refresh-btn:hover{color:var(--accent);border-color:var(--border-strong)}
.refresh-btn:disabled{opacity:.45;cursor:wait}
.toolbar{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--border);background:var(--surface-2);border-radius:9px;margin-bottom:12px}
.toolbar label{font-size:9px;text-transform:uppercase;letter-spacing:1.5px;color:var(--faint)}
.project-select{min-width:260px;max-width:460px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:7px 30px 7px 9px}
.project-select:focus{outline:1px solid var(--accent);border-color:var(--accent)}
.toolbar-spacer{flex:1}
.updated{color:var(--faint);font-size:10px}
.health{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border);border-radius:999px;padding:4px 9px;font-size:9px;letter-spacing:1px;text-transform:uppercase}
.health::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--muted)}
.health.active{color:var(--green);border-color:rgba(107,255,158,.25)}.health.active::before{background:var(--green)}
.health.blocked{color:var(--red);border-color:rgba(255,115,115,.28)}.health.blocked::before{background:var(--red)}
.health.attention,.health.waiting{color:var(--yellow);border-color:rgba(255,217,61,.25)}.health.attention::before,.health.waiting::before{background:var(--yellow)}
.metrics{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));border:1px solid var(--border);border-radius:9px;overflow:hidden;background:var(--surface);margin-bottom:12px}
.metric{min-width:0;padding:13px 14px;border-right:1px solid var(--border)}
.metric:last-child{border-right:0}
.metric-label{font-size:9px;letter-spacing:1.25px;text-transform:uppercase;color:var(--faint)}
.metric-value{font-size:22px;line-height:1.2;margin-top:5px;color:var(--text);font-variant-numeric:tabular-nums}
.metric-detail{font-size:9px;color:var(--muted);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.section{border:1px solid var(--border);background:var(--surface-2);border-radius:9px;margin-top:12px;overflow:hidden}
.section-head{display:flex;align-items:center;gap:10px;min-height:42px;padding:9px 13px;border-bottom:1px solid var(--border)}
.section-title{font-size:10px;letter-spacing:1.6px;text-transform:uppercase;color:var(--accent)}
.section-copy{font-size:9px;color:var(--faint)}
.section-count{margin-left:auto;color:var(--muted);font-variant-numeric:tabular-nums}
.agent-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:8px;padding:10px}
.agent-card{display:block;min-width:0;border:1px solid var(--border);border-radius:7px;background:var(--surface);padding:11px 12px;color:inherit;text-decoration:none}
.agent-card[href]{cursor:pointer}.agent-card[href]:hover{border-color:var(--border-strong);background:var(--surface-3)}
.agent-top{display:flex;align-items:center;gap:8px}
.presence{width:7px;height:7px;border-radius:50%;background:var(--faint);flex:none}
.presence.online{background:var(--green);box-shadow:0 0 8px rgba(107,255,158,.28)}
.presence.offline{background:var(--red)}.presence.unregistered{background:var(--faint)}
.agent-name{font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agent-state{margin-left:auto;font-size:9px;color:var(--muted);text-transform:uppercase}
.agent-meta{display:flex;flex-wrap:wrap;gap:5px;margin-top:9px}
.chip{display:inline-flex;max-width:100%;align-items:center;border:1px solid var(--border);background:var(--surface-2);border-radius:999px;padding:2px 7px;font-size:9px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip.active,.chip.in_progress{color:var(--green);border-color:rgba(107,255,158,.2)}
.chip.waiting,.chip.accepted,.chip.created{color:var(--yellow);border-color:rgba(255,217,61,.2)}
.chip.blocked,.chip.stale{color:var(--red);border-color:rgba(255,115,115,.24)}
.chip.done,.chip.complete{color:var(--purple);border-color:rgba(185,156,255,.22)}
.agent-task{margin-top:9px;padding-top:8px;border-top:1px solid var(--border);min-height:44px}
.agent-task-id{font-size:10px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.agent-task-note{font-size:9px;color:var(--muted);line-height:1.45;margin-top:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.empty-inline{padding:18px;color:var(--faint);text-align:center}
.resource-grid{display:grid;grid-template-columns:minmax(320px,.8fr) minmax(520px,1.2fr);gap:9px;padding:10px}
.resource-card{min-width:0;border:1px solid var(--border);border-radius:7px;background:var(--surface);overflow:hidden}
.resource-title{display:flex;align-items:center;gap:8px;min-height:38px;padding:8px 10px;border-bottom:1px solid var(--border);font-size:10px;color:var(--text)}
.resource-title .chip{margin-left:auto}
.resource-list{display:flex;flex-direction:column}
.resource-row{min-width:0;padding:9px 10px;border-bottom:1px solid var(--border)}
.resource-row:last-child{border-bottom:0}
.resource-line{display:flex;align-items:center;gap:7px;min-width:0}
.resource-name{font-size:10px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.resource-copy{font-size:9px;color:var(--muted);line-height:1.45;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.resource-copy.wrap{white-space:normal}
.resource-link{color:var(--accent)}.resource-link:hover{text-decoration:underline}
.split-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px;padding:10px}
.artifact-list{border:1px solid var(--border);border-radius:7px;background:var(--surface);overflow:hidden}
.artifact-head{display:flex;align-items:center;gap:8px;min-height:38px;padding:8px 10px;border-bottom:1px solid var(--border);color:var(--text);font-size:10px}
.artifact-head span:last-child{margin-left:auto;color:var(--muted)}
.artifact-row{padding:9px 10px;border-bottom:1px solid var(--border)}
.artifact-row:last-child{border-bottom:0}
.artifact-title{display:flex;align-items:center;gap:7px;font-size:10px;color:var(--text);min-width:0}
.artifact-title-main{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.artifact-meta{display:flex;gap:5px;align-items:center;flex-wrap:wrap;margin-top:6px;color:var(--muted);font-size:9px}
.changes{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:8px;padding:10px}
.change-card{border:1px solid var(--border);border-radius:7px;background:var(--surface);padding:10px}
.change-title{color:var(--text);font-size:10px;line-height:1.45;margin-top:7px}
.change-top,.change-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.change-meta{margin-top:7px;color:var(--muted);font-size:9px}
.binding-note{color:var(--muted);font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.board-wrap{overflow-x:auto;padding:10px}
.board{display:grid;grid-template-columns:repeat(5,minmax(240px,1fr));gap:8px;min-width:1240px}
.lane{border:1px solid var(--border);background:var(--surface);border-radius:7px;min-height:180px;overflow:hidden}
.lane-head{display:flex;align-items:center;padding:9px 10px;border-bottom:1px solid var(--border);color:var(--muted);font-size:9px;letter-spacing:1px;text-transform:uppercase}
.lane-head .lane-count{margin-left:auto;border-radius:999px;background:var(--surface-3);padding:1px 6px;color:var(--text)}
.lane-cards{display:flex;flex-direction:column;gap:7px;padding:7px}
.task-card{border:1px solid var(--border);border-radius:6px;background:var(--surface-2);padding:9px}
.task-card:hover{border-color:var(--border-strong)}
.task-id{font-size:9px;color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.task-title{font-size:11px;color:var(--text);line-height:1.45;margin-top:5px}
.task-meta{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-top:8px}
.task-empty{padding:24px 8px;text-align:center;color:var(--faint);font-size:10px}
.graphs{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:9px;padding:10px}
.graph{border:1px solid var(--border);background:var(--surface);border-radius:7px;overflow:hidden}
.graph-top{display:flex;align-items:center;gap:8px;padding:10px 11px;border-bottom:1px solid var(--border)}
.graph-label{font-size:11px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.graph-id{font-size:9px;color:var(--faint)}
.graph-nodes{display:flex;align-items:stretch;gap:18px;overflow-x:auto;padding:10px}
.graph-node{position:relative;min-width:170px;max-width:220px;border:1px solid var(--border);background:var(--surface-2);border-radius:6px;padding:9px}
.graph-node:not(:last-child)::after{content:'›';position:absolute;right:-14px;top:50%;transform:translateY(-50%);color:var(--faint);font-size:18px}
.node-title{font-size:10px;color:var(--text);line-height:1.4}
.node-meta{display:flex;gap:5px;flex-wrap:wrap;margin-top:7px}
.activity-list{display:flex;flex-direction:column}
.activity-row{display:grid;grid-template-columns:135px 150px 1fr auto;gap:12px;align-items:start;padding:10px 13px;border-bottom:1px solid var(--border)}
.activity-row:last-child{border-bottom:0}
.activity-time{color:var(--faint);font-size:9px}.activity-from{color:var(--accent);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.activity-summary{color:var(--text);line-height:1.45}.activity-type{font-size:9px;color:var(--muted);text-transform:uppercase}
.error{border:1px solid rgba(255,115,115,.28);background:rgba(255,115,115,.06);color:var(--red);padding:12px;border-radius:7px;margin-bottom:12px}
.hidden{display:none!important}
.page-empty{padding:70px 20px;text-align:center;border:1px dashed var(--border);border-radius:9px;color:var(--muted)}
.page-empty strong{display:block;color:var(--text);font-size:14px;margin-bottom:8px}
@media(max-width:1200px){.metrics{grid-template-columns:repeat(4,1fr)}.metric:nth-child(4n){border-right:0}.metric:nth-child(-n+4){border-bottom:1px solid var(--border)}.resource-grid{grid-template-columns:1fr}}
@media(max-width:720px){
  .page{padding:12px}.header{flex-wrap:wrap}.nav{order:3;width:100%;margin:0;overflow-x:auto}
  .toolbar{align-items:flex-start;flex-wrap:wrap}.project-select{width:100%;min-width:0}.toolbar-spacer{display:none}
  .metrics{grid-template-columns:repeat(2,1fr)}.metric{border-bottom:1px solid var(--border)}
  .metric:nth-child(2n){border-right:0}.metric:nth-last-child(-n+2){border-bottom:0}
  .resource-grid,.split-grid{grid-template-columns:1fr}.graphs{grid-template-columns:1fr}.activity-row{grid-template-columns:90px 1fr}.activity-summary{grid-column:1/-1}.activity-type{display:none}
}
</style>
</head>
<body>
<main class="page">
  <header class="header">
    <div class="title-wrap">
      <div class="eyebrow">agent-chat operations</div>
      <h1>PROJECT BOARD</h1>
    </div>
    <nav class="nav" aria-label="Dashboard">
      <a href="/">Monitor</a><a href="/projects" aria-current="page">Projects</a><a href="/tasks">Tasks</a><a href="/pool">Pool</a><a href="/alerts">Alerts</a><a href="/config">Config</a>
      <button class="refresh-btn" id="refresh-btn" type="button">Refresh</button>
    </nav>
  </header>
  <div id="error" class="error hidden" role="alert"></div>
  <div id="empty" class="page-empty hidden"><strong>No project groups</strong>Create or bind a project room group, then add its agents.</div>
  <div id="board-root" class="hidden">
    <section class="toolbar">
      <label for="project-select">Project group</label>
      <select id="project-select" class="project-select"></select>
      <span id="project-health" class="health idle">idle</span>
      <span id="project-binding" class="binding-note"></span>
      <span class="toolbar-spacer"></span>
      <span id="updated" class="updated"></span>
    </section>
    <section id="metrics" class="metrics" aria-label="Project metrics"></section>
    <section class="section">
      <div class="section-head"><span class="section-title">Agents</span><span class="section-copy">explicit project-group members</span><span id="agent-count" class="section-count"></span></div>
      <div id="agents" class="agent-grid"></div>
    </section>
    <section class="section">
      <div class="section-head"><span class="section-title">Repositories &amp; worktrees</span><span class="section-copy">typed project resources, inspired by Multica</span><span id="resource-count" class="section-count"></span></div>
      <div id="resources" class="resource-grid"></div>
    </section>
    <section class="section">
      <div class="section-head"><span class="section-title">Specs &amp; issues</span><span class="section-copy">agent-spec plus provider-neutral issue sources</span><span id="artifact-count" class="section-count"></span></div>
      <div id="artifacts" class="split-grid"></div>
    </section>
    <section class="section">
      <div class="section-head"><span class="section-title">Task board</span><span class="section-copy">durable tasks by canonical status</span><span id="task-count" class="section-count"></span></div>
      <div class="board-wrap"><div id="task-board" class="board"></div></div>
    </section>
    <section class="section">
      <div class="section-head"><span class="section-title">Workflow graphs</span><span class="section-copy">dependency and execution stages</span><span id="graph-count" class="section-count"></span></div>
      <div id="graphs" class="graphs"></div>
    </section>
    <section class="section">
      <div class="section-head"><span class="section-title">Change requests</span><span class="section-copy">GitHub pull requests and AtomGit change requests</span><span id="change-count" class="section-count"></span></div>
      <div id="changes" class="changes"></div>
    </section>
    <section class="section">
      <div class="section-head"><span class="section-title">Public activity</span><span class="section-copy">project-group summaries only — no DMs or approvals</span><span id="activity-count" class="section-count"></span></div>
      <div id="activity" class="activity-list"></div>
    </section>
  </div>
</main>
<script>
${DASHBOARD_BROWSER_GUARDS_SCRIPT}
const LANES=[
  {key:'created',label:'Created'},
  {key:'accepted',label:'Accepted'},
  {key:'in_progress',label:'In progress'},
  {key:'blocked',label:'Blocked'},
  {key:'done',label:'Done'}
];
let snapshot={projects:[]};
let selectedProjectId='';
let refreshInFlight=false;
let refreshQueued=false;

function esc(value){
  return String(value==null?'':value).replace(/[&<>"']/g,c=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
function safeClass(value){
  const normalized=String(value||'').toLowerCase();
  return /^[a-z_]+$/.test(normalized)?normalized:'unknown';
}
function safeHref(value){
  try{
    const url=new URL(String(value||''));
    return url.protocol==='https:'||url.protocol==='http:'?url.href:'';
  }catch{return ''}
}
function link(value,label,className){
  const href=safeHref(value);
  const content=esc(label);
  return href?'<a class="'+esc(className||'resource-link')+'" href="'+esc(href)+'" target="_blank" rel="noopener noreferrer">'+content+'</a>':content;
}
function fmtAge(ms){
  const n=Number(ms);
  if(!Number.isFinite(n)||n<0)return 'unknown';
  if(n<60000)return Math.floor(n/1000)+'s';
  if(n<3600000)return Math.floor(n/60000)+'m';
  if(n<86400000)return Math.floor(n/3600000)+'h';
  return Math.floor(n/86400000)+'d';
}
function fmtTime(value){
  const d=new Date(value);
  return Number.isFinite(d.getTime())?d.toLocaleString():'—';
}
function taskTotal(project){
  return LANES.reduce((sum,lane)=>sum+((project.taskLanes&&project.taskLanes[lane.key])||[]).length,0);
}
function currentProject(){
  return snapshot.projects.find(project=>project.id===selectedProjectId)||snapshot.projects[0]||null;
}
function setSelectedProject(id){
  const exists=snapshot.projects.some(project=>project.id===id);
  selectedProjectId=exists?id:(snapshot.projects[0]&&snapshot.projects[0].id)||'';
  const url=new URL(window.location.href);
  if(selectedProjectId)url.searchParams.set('project',selectedProjectId);else url.searchParams.delete('project');
  history.replaceState(null,'',url);
  render();
}
function metric(label,value,detail){
  return '<div class="metric"><div class="metric-label">'+esc(label)+'</div><div class="metric-value">'+esc(value)+'</div><div class="metric-detail">'+esc(detail)+'</div></div>';
}
function renderMetrics(project){
  const s=project.summary||{};
  const tasks=s.tasks||{};
  document.getElementById('metrics').innerHTML=
    metric('Members',s.members||0,(s.registeredAgents||0)+' registered agents')+
    metric('Online',s.onlineAgents||0,(s.offlineAgents||0)+' offline')+
    metric('Working',s.workingAgents||0,(s.waitingAgents||0)+' waiting')+
    metric('Blocked',s.blockedAgents||0,(s.staleAgents||0)+' stale')+
    metric('Open tasks',(tasks.created||0)+(tasks.accepted||0)+(tasks.in_progress||0)+(tasks.blocked||0),(tasks.done||0)+' done')+
    metric('Worktrees',s.worktrees||0,(s.dirtyWorktrees||0)+' dirty · '+(s.repositories||0)+' repos')+
    metric('Specs',s.specs||0,(s.localIssues||0)+' local issues')+
    metric('Changes',s.openChangeRequests||0,(s.remoteIssues||0)+' remote issues');
}
function renderAgent(agent){
  const presence=agent.registered?(agent.online===true?'online':'offline'):'unregistered';
  const task=agent.task;
  const runtime=agent.runtime||{};
  const chips=[];
  if(agent.role)chips.push('<span class="chip">'+esc(agent.role)+'</span>');
  if(agent.capability)chips.push('<span class="chip">'+esc(agent.capability)+'</span>');
  if(runtime.framework)chips.push('<span class="chip">'+esc(runtime.framework)+'</span>');
  if(runtime.model)chips.push('<span class="chip">'+esc(runtime.model)+'</span>');
  if(agent.worktreeCount)chips.push('<span class="chip">'+esc(agent.worktreeCount)+' worktree'+(agent.worktreeCount===1?'':'s')+'</span>');
  if(agent.blocked)chips.push('<span class="chip blocked">runtime blocked</span>');
  if(task)chips.push('<span class="chip '+safeClass(task.status)+'">'+esc(task.status)+'</span>');
  if(task&&task.stale)chips.push('<span class="chip stale">stale '+esc(fmtAge(task.heartbeatAgeMs))+'</span>');
  let taskHtml='<div class="agent-task"><div class="agent-task-note">No active task record</div></div>';
  if(task){
    const note=task.waitingReason||(task.heartbeatAgeMs==null?'heartbeat unknown':'heartbeat '+fmtAge(task.heartbeatAgeMs)+' ago');
    taskHtml='<div class="agent-task"><div class="agent-task-id">'+esc(task.id||'task')+'</div><div class="agent-task-note">'+esc(note)+'</div></div>';
  }else if(!agent.registered){
    taskHtml='<div class="agent-task"><div class="agent-task-note">Group member is not registered on this backend.</div></div>';
  }
  const content='<div class="agent-top"><span class="presence '+presence+'"></span><span class="agent-name">'+esc(agent.name)+'</span><span class="agent-state">'+esc(agent.state||presence)+'</span></div><div class="agent-meta">'+(chips.join('')||'<span class="chip">no runtime metadata</span>')+'</div>'+taskHtml;
  const linkable=agent.registered&&/^[\\w-]+$/.test(String(agent.name||''));
  return linkable
    ? '<a class="agent-card" href="/?agent='+encodeURIComponent(agent.name)+'" aria-label="Monitor '+esc(agent.name)+'">'+content+'</a>'
    : '<article class="agent-card">'+content+'</article>';
}
function renderAgents(project){
  const agents=Array.isArray(project.agents)?project.agents:[];
  document.getElementById('agent-count').textContent=agents.length+' members';
  document.getElementById('agents').innerHTML=agents.length?agents.map(renderAgent).join(''):'<div class="empty-inline">No group members</div>';
}
function renderRepositories(project){
  const repositories=Array.isArray(project.repositories)?project.repositories:[];
  const worktrees=Array.isArray(project.worktrees)?project.worktrees:[];
  document.getElementById('resource-count').textContent=repositories.length+' repos · '+worktrees.length+' worktrees';
  if(!project.binding){
    document.getElementById('resources').innerHTML='<div class="empty-inline" style="grid-column:1/-1">No explicit group → project binding. Local resources stay hidden instead of being inferred.</div>';
    return;
  }
  const repoRows=repositories.length?repositories.map(repo=>{
    const sync=repo.sync||{};
    return '<article class="resource-row"><div class="resource-line"><span class="chip">'+esc(repo.provider||'git')+'</span><span class="resource-name">'+link(repo.webUrl,repo.fullName)+'</span><span class="chip '+safeClass(sync.status)+'" style="margin-left:auto">'+esc(sync.status||'unknown')+'</span></div><div class="resource-copy">'+esc(repo.host||'local repository')+(sync.error?' · '+esc(sync.error):'')+'</div></article>';
  }).join(''):'<div class="empty-inline">No repository metadata</div>';
  const worktreeRows=worktrees.length?worktrees.map(item=>{
    const git=item.git||{};
    const state=git.dirty===true?'dirty':(git.dirty===false?'clean':'unknown');
    return '<article class="resource-row"><div class="resource-line"><span class="resource-name">'+esc(item.locationLabel||item.project)+'</span><span class="chip '+safeClass(state)+'">'+esc(state)+'</span><span class="chip" style="margin-left:auto">'+esc(item.agent)+'</span></div><div class="resource-copy">'+esc(git.branch||'detached')+(git.head?' @ '+esc(git.head):'')+' · '+esc(item.mode||'unknown')+(git.isWorktree===true?' · linked worktree':'')+(git.changeCount?' · '+esc(git.changeCount)+' changes':'')+'</div></article>';
  }).join(''):'<div class="empty-inline">No managed worktrees for '+esc(project.binding.project)+'</div>';
  document.getElementById('resources').innerHTML=
    '<div class="resource-card"><div class="resource-title">Repositories<span class="chip">'+repositories.length+'</span></div><div class="resource-list">'+repoRows+'</div></div>'+
    '<div class="resource-card"><div class="resource-title">Worktrees<span class="chip">'+worktrees.length+'</span></div><div class="resource-list">'+worktreeRows+'</div></div>';
}
function renderSpec(spec){
  const counts=(spec.scenarios||0)+' scenarios · '+(spec.tests||0)+' tests';
  const satisfies=Array.isArray(spec.satisfies)&&spec.satisfies.length?' · satisfies '+spec.satisfies.join(', '):'';
  return '<article class="artifact-row"><div class="artifact-title"><span class="chip">'+esc(spec.kind||'spec')+'</span><span class="artifact-title-main">'+esc(spec.name)+'</span></div><div class="artifact-meta"><span>'+esc(spec.file)+'</span><span>·</span><span>'+esc(counts+satisfies)+'</span><span class="chip" style="margin-left:auto">'+esc(spec.agent||'local')+'</span></div></article>';
}
function renderIssue(issue){
  const label=issue.source==='local'?'LOCAL':String(issue.provider||'REMOTE').toUpperCase();
  const target=issue.publishTarget;
  const number=issue.number!=null?' #'+issue.number:'';
  const title=issue.url?link(issue.url,issue.title):esc(issue.title);
  const publish=target?'publish target: '+target.provider+' · '+target.repository:'not linked to a publish target';
  const detail=issue.source==='local'?(issue.file+' · '+publish):((issue.repository||'repository')+number);
  return '<article class="artifact-row"><div class="artifact-title"><span class="chip '+safeClass(issue.state)+'">'+esc(label)+'</span><span class="artifact-title-main">'+title+'</span></div><div class="artifact-meta"><span>'+esc(detail)+'</span><span class="chip" style="margin-left:auto">'+esc(issue.state||'unknown')+'</span></div></article>';
}
function renderArtifacts(project){
  const specs=Array.isArray(project.specs)?project.specs:[];
  const local=Array.isArray(project.issues&&project.issues.local)?project.issues.local:[];
  const remote=Array.isArray(project.issues&&project.issues.remote)?project.issues.remote:[];
  const issues=local.concat(remote);
  document.getElementById('artifact-count').textContent=specs.length+' specs · '+issues.length+' issues';
  document.getElementById('artifacts').innerHTML=
    '<div class="artifact-list"><div class="artifact-head">Specifications<span>'+specs.length+'</span></div>'+(specs.length?specs.slice(0,40).map(renderSpec).join(''):'<div class="empty-inline">No specs found</div>')+(specs.length>40?'<div class="empty-inline">'+esc(specs.length-40)+' more specs</div>':'')+'</div>'+
    '<div class="artifact-list"><div class="artifact-head">Issues<span>'+issues.length+'</span></div>'+(issues.length?issues.slice(0,50).map(renderIssue).join(''):'<div class="empty-inline">No local or remote issues found</div>')+(issues.length>50?'<div class="empty-inline">'+esc(issues.length-50)+' more issues</div>':'')+'</div>';
}
function renderTask(task){
  const meta=[];
  if(task.assignee)meta.push('<span class="chip">'+esc(task.assignee)+'</span>');
  if(task.priority)meta.push('<span class="chip">'+esc(String(task.priority).toUpperCase())+'</span>');
  if(task.waitingReason)meta.push('<span class="chip blocked">'+esc(task.waitingReason)+'</span>');
  return '<article class="task-card"><div class="task-id">'+esc(task.id)+'</div><div class="task-title">'+esc(task.title)+'</div><div class="task-meta">'+meta.join('')+'</div></article>';
}
function renderTasks(project){
  const lanes=project.taskLanes||{};
  const total=taskTotal(project);
  document.getElementById('task-count').textContent=total+' tasks';
  document.getElementById('task-board').innerHTML=LANES.map(lane=>{
    const tasks=Array.isArray(lanes[lane.key])?lanes[lane.key]:[];
    return '<section class="lane"><div class="lane-head">'+esc(lane.label)+'<span class="lane-count">'+tasks.length+'</span></div><div class="lane-cards">'+(tasks.length?tasks.map(renderTask).join(''):'<div class="task-empty">No tasks</div>')+'</div></section>';
  }).join('');
}
function renderNode(node){
  return '<article class="graph-node"><div class="node-title">'+esc(node.description||node.id)+'</div><div class="node-meta"><span class="chip '+safeClass(node.status)+'">'+esc(node.status)+'</span>'+(node.assignee?'<span class="chip">'+esc(node.assignee)+'</span>':'')+(node.dependsOn&&node.dependsOn.length?'<span class="chip">after '+esc(node.dependsOn.join(', '))+'</span>':'')+'</div></article>';
}
function renderGraphs(project){
  const graphs=Array.isArray(project.graphs)?project.graphs:[];
  document.getElementById('graph-count').textContent=graphs.length+' graphs';
  document.getElementById('graphs').innerHTML=graphs.length?graphs.map(graph=>
    '<article class="graph"><div class="graph-top"><div><div class="graph-label">'+esc(graph.label)+'</div><div class="graph-id">'+esc(graph.id)+'</div></div><span class="chip '+safeClass(graph.status)+'" style="margin-left:auto">'+esc(graph.status)+'</span></div><div class="graph-nodes">'+((graph.nodes||[]).map(renderNode).join('')||'<div class="empty-inline">No nodes</div>')+'</div></article>'
  ).join(''):'<div class="empty-inline">No task graphs associated with this project group.</div>';
}
function renderChanges(project){
  const changes=Array.isArray(project.changeRequests)?project.changeRequests:[];
  document.getElementById('change-count').textContent=changes.length+' change requests';
  document.getElementById('changes').innerHTML=changes.length?changes.map(change=>{
    const checks=change.checks||{};
    const number=change.number!=null?'#'+change.number:'change';
    const title=change.url?link(change.url,change.title):esc(change.title);
    const diff=[];
    if(change.changedFiles!=null)diff.push(change.changedFiles+' files');
    if(change.additions!=null)diff.push('+'+change.additions);
    if(change.deletions!=null)diff.push('-'+change.deletions);
    return '<article class="change-card"><div class="change-top"><span class="chip">'+esc(change.provider||'git')+'</span><span class="resource-name">'+esc(change.repository||'repository')+' '+esc(number)+'</span><span class="chip '+safeClass(change.state)+'" style="margin-left:auto">'+esc(change.state||'unknown')+'</span></div><div class="change-title">'+title+'</div><div class="change-meta"><span>'+esc(change.headBranch||'?')+' → '+esc(change.baseBranch||'?')+'</span><span>· checks '+esc(checks.passed||0)+'✓ '+esc(checks.failed||0)+'✕ '+esc(checks.pending||0)+'…</span>'+(diff.length?'<span>· '+esc(diff.join(' · '))+'</span>':'')+'</div></article>';
  }).join(''):'<div class="empty-inline" style="grid-column:1/-1">No observed change requests. Unsupported providers remain visible at repository level until an adapter is configured.</div>';
}
function renderActivity(project){
  const rows=Array.isArray(project.activity)?project.activity:[];
  document.getElementById('activity-count').textContent=rows.length+' updates';
  document.getElementById('activity').innerHTML=rows.length?rows.map(item=>
    '<article class="activity-row"><span class="activity-time">'+esc(fmtTime(item.ts))+'</span><span class="activity-from">'+esc(item.from)+'</span><span class="activity-summary">'+esc(item.summary)+'</span><span class="activity-type">'+esc(item.type)+'</span></article>'
  ).join(''):'<div class="empty-inline">No public project-group activity.</div>';
}
function render(){
  const projects=Array.isArray(snapshot.projects)?snapshot.projects:[];
  const empty=document.getElementById('empty');
  const root=document.getElementById('board-root');
  if(!projects.length){
    empty.classList.remove('hidden');root.classList.add('hidden');return;
  }
  empty.classList.add('hidden');root.classList.remove('hidden');
  const requested=new URL(window.location.href).searchParams.get('project')||'';
  if(!projects.some(project=>project.id===selectedProjectId)){
    selectedProjectId=projects.some(project=>project.id===requested)?requested:projects[0].id;
  }
  const select=document.getElementById('project-select');
  select.innerHTML=projects.map(project=>'<option value="'+esc(project.id)+'">'+esc(project.name)+' · '+esc(project.health)+'</option>').join('');
  select.value=selectedProjectId;
  const project=currentProject();
  if(!project)return;
  const health=document.getElementById('project-health');
  health.className='health '+safeClass(project.health);
  health.textContent=project.health||'idle';
  document.getElementById('project-binding').textContent=project.binding
    ? 'bound project: '+project.binding.project+(project.binding.workflowId?' · '+project.binding.workflowId+'@'+(project.binding.workflowVersion||'?'):'')
    : 'resources unbound';
  document.getElementById('updated').textContent='updated '+fmtTime(snapshot.generatedAt);
  renderMetrics(project);renderAgents(project);renderRepositories(project);renderArtifacts(project);renderTasks(project);renderGraphs(project);renderChanges(project);renderActivity(project);
}
async function refresh(){
  if(refreshInFlight){refreshQueued=true;return}
  refreshInFlight=true;
  const button=document.getElementById('refresh-btn');
  button.disabled=true;
  try{
    const response=await fetch('/api/project-board?activity_limit=30',{headers:{Accept:'application/json'}});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.error||('backend status '+response.status));
    snapshot=data&&typeof data==='object'?data:{projects:[]};
    document.getElementById('error').classList.add('hidden');
    render();
  }catch(error){
    const box=document.getElementById('error');
    box.textContent='Project board unavailable: '+(error&&error.message?error.message:String(error));
    box.classList.remove('hidden');
  }finally{
    refreshInFlight=false;button.disabled=false;
    if(refreshQueued){refreshQueued=false;refresh()}
  }
}
document.getElementById('project-select').addEventListener('change',event=>setSelectedProject(event.target.value));
document.getElementById('refresh-btn').addEventListener('click',refresh);
connectDashboardStream(stream=>{
  ['agent_update','group_created','group_members','task_created','task_updated','task_deleted','task_graph_created','task_graph_node_completed','task_graph_completed']
    .forEach(name=>stream.addEventListener(name,()=>refresh()));
});
refresh();
setInterval(()=>{if(!document.hidden)refresh()},5000);
</script>
</body>
</html>`;
}
