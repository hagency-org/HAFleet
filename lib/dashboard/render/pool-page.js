import { DASHBOARD_BROWSER_GUARDS_SCRIPT } from './browser-guards.js';

// matrix-Agent pool view (Phase 7): the live role × capability grid — who's idle/busy per cell.
// Reads GET /api/pool; "按能力调度" at a glance.
export function renderPoolPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>matrix-Agent pool</title>
<style>
:root{--bg:#0a0e14;--surface:#111922;--border:rgba(154,182,210,0.12);--text:#c8d6e5;--muted:rgba(200,214,229,0.45);--accent:#6dc1ff;--green:#6bff9e;--yellow:#ffd93d}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'SF Mono','Fira Code',monospace;font-size:12px;background:var(--bg);color:var(--text);min-height:100vh}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.page{max-width:1100px;margin:0 auto;padding:16px 20px}
.header{display:flex;align-items:center;gap:16px;margin-bottom:16px}
.header h1{font-size:16px;color:var(--accent);font-weight:600;letter-spacing:1px}
.header a{font-size:11px;color:var(--muted)}
table{border-collapse:collapse;width:100%;margin-top:8px}
th,td{border:1px solid var(--border);padding:8px 10px;text-align:left;vertical-align:top}
th{color:var(--accent);font-weight:600;background:var(--surface)}
td.role{color:var(--muted)}
.cell{display:flex;flex-direction:column;gap:3px}
.agent{padding:2px 6px;border-radius:4px;background:var(--surface);border:1px solid var(--border);font-size:11px}
.agent.busy{border-color:var(--yellow);color:var(--yellow)}
.agent.idle{border-color:rgba(107,255,158,0.4);color:var(--green)}
.empty{color:var(--muted);font-size:10px}
.bar{display:flex;gap:12px;margin:10px 0;color:var(--muted);font-size:11px;flex-wrap:wrap}
.bar .s{padding:4px 10px;background:var(--surface);border:1px solid var(--border);border-radius:6px}
</style>
</head>
<body>
<div class="page">
  <div class="header"><h1>matrix-Agent pool</h1><a href="/">&larr; monitor</a><a href="/projects">projects</a><a href="#" onclick="load();return false">refresh</a></div>
  <div class="bar" id="bar"></div>
  <table id="grid"><thead></thead><tbody></tbody></table>
</div>
<script>
${DASHBOARD_BROWSER_GUARDS_SCRIPT}
const TIERS=['strong','medium','lightweight'];
const ROLES=['architect','coding','testing','review','integration','documentation'];
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
async function load(){
  let d; try{ d=await (await fetch('/api/pool')).json(); }catch(e){ document.getElementById('bar').textContent='pool unavailable: '+e.message; return; }
  const grid=d.grid||{};
  document.getElementById('bar').innerHTML='<span class="s">total '+(d.total||0)+'</span>'+
    ROLES.filter(r=>grid[r]).map(r=>'<span class="s">'+esc(r)+': '+Object.values(grid[r]).reduce((a,l)=>a+l.length,0)+'</span>').join('');
  const head=document.querySelector('#grid thead');
  head.innerHTML='<tr><th>capability \\\\ role</th>'+ROLES.map(r=>'<th>'+esc(r)+'</th>').join('')+'</tr>';
  const body=document.querySelector('#grid tbody');
  body.innerHTML=TIERS.map(t=>'<tr><td class="role">'+t+'</td>'+ROLES.map(r=>{
    const list=((grid[r]||{})[t])||[];
    if(!list.length) return '<td><span class="empty">—</span></td>';
    return '<td><div class="cell">'+list.map(a=>'<span class="agent '+(a.busy?'busy':'idle')+'">'+esc(a.name)+(a.busy?' ⏳':'')+'</span>').join('')+'</div></td>';
  }).join('')+'</tr>').join('');
}
load(); setInterval(load, 4000);
</script>
</body>
</html>`;
}
