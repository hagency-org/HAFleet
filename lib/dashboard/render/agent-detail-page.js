export function renderAgentDetailPage(agentName) {
  const safeName = String(agentName).replace(/[&<>"]/g, (ch) => (
    ch === '&' ? '&amp;' : (ch === '<' ? '&lt;' : (ch === '>' ? '&gt;' : '&quot;'))
  ));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Agent Detail · ${safeName}</title>
<style>
*{box-sizing:border-box}
:root{
  --bg:#08101a;
  --bg-soft:#0d1723;
  --panel:#0f1b29;
  --panel-2:#111f30;
  --border:rgba(154,182,210,0.18);
  --border-strong:rgba(154,182,210,0.28);
  --text:#e7eef7;
  --muted:rgba(215,227,241,0.62);
  --muted-2:rgba(215,227,241,0.42);
  --ok:#46c77a;
  --warn:#f0b34a;
  --danger:#f36b7d;
  --accent:#6dc1ff;
}
html,body{margin:0;min-height:100%;background:
  radial-gradient(circle at top left,rgba(38,72,112,0.32),transparent 34%),
  linear-gradient(180deg,#07111a 0%,#08101a 100%);
  color:var(--text);
  font-family:'SF Mono','Fira Code','Consolas',monospace;
}
:root{--detail-tabs-top:156px}
button,input,textarea{font:inherit}
a{color:var(--accent)}
.page{max-width:1240px;margin:0 auto;padding:20px 20px 40px}
.hero{
  position:sticky;top:0;z-index:20;
  background:linear-gradient(180deg,rgba(8,16,26,1) 0%,rgba(8,16,26,1) 100%);
  backdrop-filter:blur(16px);
  border:1px solid var(--border);
  border-radius:18px;
  padding:18px 18px 16px;
  box-shadow:0 18px 40px rgba(0,0,0,0.24);
}
.hero-top{
  display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap;
}
.back-link{
  display:inline-flex;align-items:center;gap:6px;
  color:var(--muted);text-decoration:none;font-size:11px;letter-spacing:1px;
}
.back-link:hover{color:var(--text)}
.hero-actions{display:flex;gap:8px;flex-wrap:wrap}
.hero-btn{
  border:1px solid var(--border-strong);
  background:rgba(255,255,255,0.03);
  color:var(--text);
  border-radius:999px;
  padding:7px 12px;
  cursor:pointer;
  font-size:10px;
  letter-spacing:1px;
}
.hero-btn:hover{border-color:rgba(154,182,210,0.45)}
.hero-btn.warn{color:var(--warn);border-color:rgba(240,179,74,0.32)}
.hero-btn.warn:hover{border-color:rgba(240,179,74,0.62)}
.hero-btn.danger{color:var(--danger);border-color:rgba(243,107,125,0.32)}
.hero-btn.danger:hover{border-color:rgba(243,107,125,0.62)}
.hero-kicker{margin-top:10px;color:var(--muted-2);font-size:11px;letter-spacing:1.8px;text-transform:uppercase}
.hero-title-row{
  margin-top:8px;
  display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap;
}
.hero-title{margin:0;font-size:30px;line-height:1.1;letter-spacing:-0.02em}
.hero-runtime{font-size:11px;color:var(--muted)}
.chip-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.chip{
  display:inline-flex;align-items:center;gap:6px;
  padding:5px 10px;border-radius:999px;border:1px solid var(--border);
  background:rgba(255,255,255,0.03);font-size:10px;letter-spacing:0.8px;color:var(--text);
}
.chip.ok{border-color:rgba(70,199,122,0.35);color:var(--ok);background:rgba(70,199,122,0.10)}
.chip.warn{border-color:rgba(240,179,74,0.35);color:var(--warn);background:rgba(240,179,74,0.10)}
.chip.danger{border-color:rgba(243,107,125,0.35);color:var(--danger);background:rgba(243,107,125,0.10)}
.chip.neutral{color:var(--accent);border-color:rgba(109,193,255,0.28);background:rgba(109,193,255,0.08)}
.health-summary{margin-top:12px;font-size:14px;line-height:1.5;color:var(--text)}
.health-summary.health-error{color:rgba(248,113,113,0.9);padding:8px 12px;border-radius:6px;background:rgba(248,113,113,0.06);border:1px solid rgba(248,113,113,0.25)}
.exception-banner{
  margin-top:14px;
  border:1px solid rgba(243,107,125,0.3);
  background:rgba(243,107,125,0.12);
  color:#ffdce2;
  border-radius:14px;
  padding:12px 14px;
}
.exception-banner.warn{
  border-color:rgba(240,179,74,0.32);
  background:rgba(240,179,74,0.12);
  color:#ffe8c0;
}
.hidden{display:none !important}
.detail-status{
  min-height:20px;
  margin:14px 4px 0;
  font-size:11px;
}
.detail-status-ok{color:var(--ok)}
.detail-status-warn{color:var(--warn)}
.detail-status-error{color:var(--danger)}
.top-grid{
  display:grid;
  grid-template-columns:repeat(2,minmax(0,1fr));
  gap:14px;
  margin-top:14px;
}
.split-grid{
  display:grid;
  grid-template-columns:repeat(2,minmax(0,1fr));
  gap:14px;
  margin-top:14px;
}
.stack{display:flex;flex-direction:column;gap:14px}
.panel{
  background:linear-gradient(180deg,rgba(15,27,41,0.94) 0%,rgba(11,21,32,0.98) 100%);
  border:1px solid var(--border);
  border-radius:16px;
  padding:16px;
  box-shadow:0 12px 24px rgba(0,0,0,0.18);
}
.panel-head{
  display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;
}
.panel-label{font-size:11px;letter-spacing:1.6px;text-transform:uppercase;color:var(--muted-2)}
.primary-text{margin-top:10px;font-size:20px;line-height:1.35;color:var(--text)}
.secondary-text{margin-top:8px;font-size:12px;line-height:1.55;color:var(--text)}
.muted{color:var(--muted)}
.meta-list{
  display:flex;flex-wrap:wrap;gap:10px;margin-top:12px;
}
.meta-item{
  padding:6px 9px;border-radius:10px;background:rgba(255,255,255,0.03);
  border:1px solid rgba(154,182,210,0.12);font-size:10px;color:var(--muted);
}
.event-list{display:flex;flex-direction:column;gap:10px;margin-top:12px}
.event-item{
  border:1px solid rgba(154,182,210,0.12);
  background:rgba(255,255,255,0.025);
  border-radius:12px;
  padding:10px 12px;
}
.event-row{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}
.event-time{font-size:10px;color:var(--muted-2);white-space:nowrap}
.event-main{font-size:12px;line-height:1.45;color:var(--text)}
.event-meta{margin-top:4px;font-size:10px;color:var(--muted)}

/* Subconscious Event Redesign */
.hook-badge{
  display:inline-block;font-size:9px;font-weight:600;text-transform:uppercase;
  letter-spacing:0.4px;padding:2px 7px;border-radius:6px;line-height:1.4;
  white-space:nowrap;vertical-align:middle;
}
.hook-badge.hook-session{background:rgba(99,179,237,0.15);color:#63b3ed}
.hook-badge.hook-prompt{background:rgba(154,230,180,0.15);color:#9ae6b4}
.hook-badge.hook-tool{background:rgba(246,173,85,0.15);color:#f6ad55}
.hook-badge.hook-stop{background:rgba(203,166,247,0.15);color:#cba6f7}
.hook-badge.hook-unknown{background:rgba(154,182,210,0.08);color:var(--muted)}

.event-item.ev-injected{
  border-color:rgba(154,230,180,0.22);
  background:rgba(154,230,180,0.03);
}
.event-item.ev-runtime{
  border-color:rgba(99,179,237,0.18);
}

.event-chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}
.ev-chip{
  font-size:9px;padding:1px 6px;border-radius:5px;
  background:rgba(154,182,210,0.08);color:var(--muted);
}
.ev-chip.chip-injected{background:rgba(154,230,180,0.12);color:#9ae6b4}
.ev-chip.chip-runtime{background:rgba(99,179,237,0.12);color:#63b3ed}
.ev-chip.chip-error{background:rgba(252,129,129,0.12);color:#fc8181}

.event-summary{
  margin-top:5px;font-size:11px;line-height:1.45;
  color:var(--muted);
  border-left:2px solid rgba(154,182,210,0.1);
  padding-left:8px;
}

.guidance-preview{
  margin-top:8px;padding:8px 10px;
  border-radius:8px;font-size:11px;line-height:1.45;
  border:1px solid rgba(154,182,210,0.1);
}
.guidance-preview.gp-manual{
  background:rgba(246,173,85,0.04);border-color:rgba(246,173,85,0.12);
}
.guidance-preview.gp-runtime{
  background:rgba(99,179,237,0.04);border-color:rgba(99,179,237,0.12);
}
.guidance-label{
  font-size:9px;font-weight:600;text-transform:uppercase;
  letter-spacing:0.4px;color:var(--muted);margin-bottom:4px;
}
.guidance-text{font-size:11px;color:var(--text);line-height:1.5}

.hook-breakdown{
  display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;
}
.hook-count{
  font-size:10px;color:var(--muted);
  display:flex;align-items:center;gap:4px;
}
.hook-count .hook-badge{font-size:8px;padding:1px 5px}

.debug-sub-section{margin-bottom:14px}
.debug-sub-label{
  font-size:10px;font-weight:600;text-transform:uppercase;
  letter-spacing:0.5px;color:var(--muted);
  margin-bottom:6px;padding-bottom:4px;
  border-bottom:1px solid rgba(154,182,210,0.08);
}

.sub-section{margin-top:16px}
.sub-section-label{
  font-size:11px;font-weight:600;color:var(--text);
  margin-bottom:8px;display:flex;align-items:center;gap:6px;
}
.sub-section-label .section-count{
  font-size:9px;font-weight:500;color:var(--muted);
  background:rgba(154,182,210,0.08);padding:1px 6px;border-radius:5px;
}
.sub-divider{
  height:1px;background:rgba(154,182,210,0.08);margin:14px 0;
}
.sub-detail{
  margin-top:10px;
}
.sub-detail>summary{
  font-size:10px;font-weight:600;text-transform:uppercase;
  letter-spacing:0.4px;color:var(--muted);cursor:pointer;
  padding:6px 0;user-select:none;
}
.sub-detail>summary:hover{color:var(--text)}
.sub-detail>.sub-detail-body{
  margin-top:8px;
}

.subconscious-mode-indicator{
  display:inline-flex;align-items:center;gap:5px;
  font-size:11px;padding:4px 10px;border-radius:8px;
  background:rgba(154,182,210,0.06);
  border:1px solid rgba(154,182,210,0.1);
  color:var(--muted);margin-top:6px;
}
.mode-dot{
  width:6px;height:6px;border-radius:50%;
  background:var(--muted);
}
.mode-dot.dot-active{background:#9ae6b4}
.mode-dot.dot-runtime{background:#63b3ed}
.mode-dot.dot-off{background:rgba(154,182,210,0.3)}

.inline-link{
  background:none;border:none;padding:0;color:var(--accent);cursor:pointer;font-size:11px;
}
.inline-link:hover{text-decoration:underline}
.tab-shell{margin-top:18px}
.tabs{
  display:flex;gap:8px;flex-wrap:wrap;
  position:sticky;top:var(--detail-tabs-top);z-index:21;
  margin-bottom:14px;padding:8px;
  background:rgba(8,16,26,1);
  backdrop-filter:blur(14px);
  border:1px solid var(--border);
  border-radius:14px;
}
.tab-btn{
  border:1px solid transparent;
  background:transparent;
  color:var(--muted);
  border-radius:999px;
  padding:8px 12px;
  cursor:pointer;
  font-size:11px;
  letter-spacing:0.9px;
}
.tab-btn:hover{color:var(--text);border-color:rgba(154,182,210,0.18)}
.tab-btn.active{
  background:rgba(109,193,255,0.12);
  color:var(--accent);
  border-color:rgba(109,193,255,0.28);
}
.tab-panel{display:block}
.summary-grid{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(130px,1fr));
  gap:10px;
  margin-top:12px;
}
.summary-stat{
  border:1px solid rgba(154,182,210,0.12);
  border-radius:12px;
  background:rgba(255,255,255,0.03);
  padding:10px 12px;
}
.summary-k{font-size:10px;color:var(--muted-2);letter-spacing:1px}
.summary-v{margin-top:4px;font-size:18px;color:var(--text)}
.summary-note{
  margin-top:12px;
  padding:12px;
  border-radius:12px;
  border:1px solid rgba(154,182,210,0.12);
  background:rgba(255,255,255,0.02);
  font-size:12px;
  color:var(--muted);
  line-height:1.55;
}
.list{
  margin:10px 0 0 0;
  padding-left:18px;
  color:var(--text);
  font-size:12px;
  line-height:1.55;
}
.list.tight{margin-top:6px}
.read-block{
  margin-top:10px;
  padding:11px 12px;
  border-radius:12px;
  background:rgba(255,255,255,0.025);
  border:1px solid rgba(154,182,210,0.12);
  font-size:12px;
  line-height:1.55;
  color:var(--text);
}
.field-label{
  margin-top:12px;
  font-size:10px;
  letter-spacing:1.2px;
  text-transform:uppercase;
  color:var(--muted-2);
}
.detail-input,
.detail-textarea{
  width:100%;
  margin-top:6px;
  background:rgba(255,255,255,0.03);
  border:1px solid rgba(109,193,255,0.24);
  border-radius:12px;
  color:var(--text);
  padding:10px 12px;
  outline:none;
  font-size:12px;
}
select{cursor:pointer}
select option{
  background:#0d1723;
  color:#e2eaf3;
}
.detail-input:focus,
.detail-textarea:focus{border-color:rgba(109,193,255,0.62)}
.detail-textarea{resize:vertical;min-height:110px;line-height:1.5}
.detail-toggle{
  display:flex;align-items:center;gap:8px;
  margin-top:14px;font-size:12px;color:var(--text);
}
.detail-actions{
  margin-top:12px;
  display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;
}
.detail-save{
  background:rgba(109,193,255,0.12);
  border:1px solid rgba(109,193,255,0.32);
  color:var(--accent);
  border-radius:999px;
  padding:8px 14px;
  cursor:pointer;
  font-size:11px;
  letter-spacing:1px;
}
.detail-save:hover{border-color:rgba(109,193,255,0.62)}
.detail-save:disabled{opacity:0.45;cursor:default}
.detail-hint{font-size:11px;color:var(--muted);line-height:1.55}
.task-advanced{margin-top:10px}
.task-advanced-toggle{font-size:11px;color:var(--muted);cursor:pointer;letter-spacing:0.5px}
.task-advanced-toggle:hover{color:var(--text)}
.task-advanced[open] .task-advanced-toggle{color:var(--text)}
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
.task-create-form{display:flex;flex-direction:column;gap:8px}
.task-create-form textarea{min-height:60px;resize:vertical}
.task-create-row{display:flex;gap:8px;align-items:center}
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
.task-comment-form textarea{flex:1;min-height:40px;resize:vertical}
.task-empty-state{text-align:center;color:var(--muted);padding:24px 0;font-size:12px}
.task-status-select{font-size:11px;padding:2px 4px;background:rgba(0,0,0,0.2);border:1px solid rgba(154,182,210,0.15);color:var(--text);border-radius:4px}
.doc-frame{
  margin-top:10px;
  padding:12px;
  min-height:140px;
  max-height:420px;
  overflow:auto;
  border-radius:12px;
  border:1px solid rgba(154,182,210,0.12);
  background:rgba(0,0,0,0.18);
  font-family:'SF Mono','Fira Code','Consolas',monospace;
  font-size:11px;
  line-height:1.55;
  color:var(--text);
  white-space:pre-wrap;
  word-break:break-word;
}
.empty-state{font-size:12px;line-height:1.55;color:var(--muted);padding:6px 0}
.error-state{font-size:12px;line-height:1.55;padding:8px 12px;border-radius:6px;background:rgba(248,113,113,0.06);border:1px solid rgba(248,113,113,0.25);color:rgba(248,113,113,0.85)}
.mono{font-family:'SF Mono','Fira Code','Consolas',monospace}
.debug-detail{
  border:1px solid rgba(154,182,210,0.12);
  border-radius:14px;
  background:rgba(255,255,255,0.02);
  overflow:hidden;
}
.debug-detail summary{
  list-style:none;cursor:pointer;padding:14px 16px;font-size:11px;letter-spacing:1.2px;
  text-transform:uppercase;color:var(--muted);background:rgba(255,255,255,0.02);
}
.debug-detail summary::-webkit-details-marker{display:none}
.debug-body{padding:0 16px 16px}
.debug-grid{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(220px,1fr));
  gap:12px;
}
.debug-kv{
  padding:10px 12px;
  border-radius:12px;
  border:1px solid rgba(154,182,210,0.1);
  background:rgba(255,255,255,0.02);
  font-size:11px;
  line-height:1.55;
  color:var(--muted);
}
.debug-kv b{display:block;color:var(--text);margin-bottom:4px}
.audit-wrap{
  margin-top:14px;
  overflow:auto;
  border:1px solid rgba(154,182,210,0.14);
  border-radius:14px;
  background:rgba(255,255,255,0.02);
}
table{
  width:100%;
  min-width:920px;
  border-collapse:collapse;
}
th,td{
  text-align:left;
  padding:10px 12px;
  border-bottom:1px solid rgba(154,182,210,0.09);
  font-size:11px;
  vertical-align:top;
}
th{
  position:sticky;top:0;
  background:#111c2a;
  color:var(--muted);
  letter-spacing:1px;
  text-transform:uppercase;
}
.status{
  display:inline-block;
  padding:4px 8px;
  border-radius:999px;
  border:1px solid var(--border);
  font-size:10px;
  letter-spacing:0.8px;
}
.status-focused{color:var(--ok);border-color:rgba(70,199,122,0.32);background:rgba(70,199,122,0.10)}
.status-negative{color:var(--danger);border-color:rgba(243,107,125,0.32);background:rgba(243,107,125,0.10)}
.status-unknown{color:var(--warn);border-color:rgba(240,179,74,0.32);background:rgba(240,179,74,0.10)}
.modal{
  position:fixed;inset:0;z-index:40;
  display:flex;align-items:center;justify-content:center;
  background:rgba(3,7,11,0.68);padding:18px;
}
.modal-card{
  width:min(460px,100%);
  border-radius:16px;
  border:1px solid rgba(243,107,125,0.24);
  background:#0d1723;
  box-shadow:0 24px 54px rgba(0,0,0,0.35);
  padding:18px;
}
.modal-title{font-size:18px;color:var(--text)}
.modal-copy{margin-top:10px;font-size:13px;line-height:1.6;color:var(--muted)}
.modal-actions{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;margin-top:18px}
.dm-container{display:flex;flex-direction:column;height:min(600px,70vh)}
.dm-messages{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:6px}
.dm-empty{color:var(--muted);text-align:center;padding:40px 0;font-size:13px}
.dm-msg{max-width:80%;width:fit-content;padding:8px 12px;border-radius:10px;font-size:13px;line-height:1.5;word-break:break-word;white-space:pre-wrap}
.dm-msg.outgoing{align-self:flex-end;background:rgba(109,193,255,0.15);border:1px solid rgba(109,193,255,0.25);color:var(--text)}
.dm-msg.incoming{align-self:flex-start;background:rgba(154,182,210,0.08);border:1px solid rgba(154,182,210,0.15);color:var(--text)}
.dm-msg-meta{font-size:10px;color:var(--muted);margin-top:3px}
.dm-msg-from{font-weight:600;font-size:11px;margin-bottom:2px;color:var(--accent)}
.dm-msg.outgoing .dm-msg-from{color:rgba(109,193,255,0.7)}
.dm-input-row{display:flex;gap:8px;padding:10px 12px;border-top:1px solid rgba(154,182,210,0.12)}
.dm-input{flex:1;background:rgba(154,182,210,0.06);border:1px solid rgba(154,182,210,0.18);border-radius:8px;color:var(--text);padding:8px 12px;font:inherit;font-size:13px;resize:none;min-height:38px;max-height:120px}
.dm-input:focus{outline:none;border-color:var(--accent)}
.dm-name-bar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid rgba(154,182,210,0.12)}
.dm-name-label{font-size:11px;color:var(--muted);white-space:nowrap}
.dm-name-input{width:120px;background:rgba(154,182,210,0.06);border:1px solid rgba(154,182,210,0.18);border-radius:6px;color:var(--text);padding:5px 8px;font:inherit;font-size:12px}
.dm-name-input:focus{outline:none;border-color:var(--accent)}
.dm-send-btn{background:rgba(109,193,255,0.15);border:1px solid rgba(109,193,255,0.30);color:var(--accent);border-radius:8px;padding:8px 16px;cursor:pointer;font:inherit;font-size:13px;white-space:nowrap}
.dm-send-btn:hover{background:rgba(109,193,255,0.25)}
.dm-send-btn:disabled{opacity:0.4;cursor:not-allowed}
@media (max-width:920px){
  .page{padding:14px 14px 32px}
  .hero{position:static}
  .tabs{position:static}
  .top-grid,.split-grid{grid-template-columns:1fr}
  .hero-title{font-size:26px}
}
</style>
</head>
<body>
  <div class="page">
    <header class="hero">
      <div class="hero-top">
        <a class="back-link" href="/">← Back to Monitor</a>
        <div class="hero-actions">
          <button class="hero-btn" onclick="openSupervisorAudit()">View Supervisor Audit</button>
          <button class="hero-btn warn" onclick="requestDangerAction('down')">Stop Agent</button>
          <button class="hero-btn danger" onclick="requestDangerAction('delete')">Remove Agent</button>
        </div>
      </div>
      <div class="hero-kicker">Agent Detail</div>
      <div class="hero-title-row">
        <h1 class="hero-title" id="hero-title">${safeName}</h1>
        <div class="hero-runtime muted" id="hero-runtime">Runtime details pending first refresh.</div>
      </div>
      <div class="chip-row" id="header-chips"></div>
      <div class="health-summary muted" id="health-summary">Runtime, delivery, and subconscious path facts appear after the first refresh.</div>
    </header>

    <div id="exception-banner" class="exception-banner hidden"></div>
    <div id="detail-status" class="detail-status muted"></div>

    <section class="top-grid">
      <article class="panel">
        <div class="panel-label">Message Delivery</div>
        <div id="overview-delivery"></div>
      </article>
      <article class="panel">
        <div class="panel-label">Agent Metadata</div>
        <div id="overview-projects"></div>
      </article>
    </section>

    <div class="tab-shell">
      <div class="tabs">
        <button class="tab-btn active" data-tab="settings" onclick="setActiveTab('settings')">Settings</button>
        <button class="tab-btn" data-tab="tasks" onclick="setActiveTab('tasks')">Tasks</button>
        <button class="tab-btn" data-tab="dm" onclick="setActiveTab('dm')">DM</button>
        <button class="tab-btn" data-tab="supervisor" onclick="setActiveTab('supervisor')">Supervisor</button>
        <button class="tab-btn" data-tab="subconscious" onclick="setActiveTab('subconscious')">Subconscious</button>
        <button class="tab-btn" data-tab="internals" onclick="setActiveTab('internals')">Internals</button>
      </div>

      <section id="tab-settings" class="tab-panel">
        <div class="stack">
          <article class="panel">
            <div class="panel-label">Identity</div>
            <div id="settings-identity"></div>
          </article>
          <article class="panel">
            <div class="panel-label">Guidance</div>
            <div id="settings-guidance"></div>
          </article>
          <article class="panel">
            <div class="panel-label">Configuration</div>
            <div id="settings-configuration"></div>
          </article>
          <article class="panel">
            <div class="panel-label">Framework Presets</div>
            <div id="settings-presets"></div>
          </article>
          <article class="panel">
            <div class="panel-label">System Controls</div>
            <div id="settings-systems" class="split-grid"></div>
          </article>
          <article class="panel">
            <div class="panel-label">Ownership</div>
            <div id="settings-owner"></div>
          </article>
        </div>
      </section>

      <section id="tab-tasks" class="tab-panel hidden">
        <article class="panel">
          <div class="panel-label">Create Task</div>
          <div class="task-create-form">
            <textarea id="task-create-title" class="detail-textarea" placeholder="Task title / description" style="min-height:50px"></textarea>
            <div class="task-create-row">
              <select id="task-create-priority" class="detail-input" style="width:80px">
                <option value="p0">P0</option>
                <option value="p1">P1</option>
                <option value="p2" selected>P2</option>
                <option value="p3">P3</option>
              </select>
              <input id="task-create-assignee" class="detail-input" placeholder="Assignee (optional)" style="flex:1" value="${safeName}">
              <button class="detail-save" onclick="taskCreateSubmit()">Create</button>
            </div>
            <div id="task-create-status" class="detail-status muted" style="font-size:11px"></div>
          </div>
        </article>
        <article class="panel">
          <div class="panel-label" style="display:flex;align-items:center;justify-content:space-between">Tasks<select id="task-filter-assignee" class="detail-input" style="width:auto;min-width:140px;font-size:11px;padding:2px 6px;margin-left:12px" onchange="taskListRefresh()"><option value="">All Agents</option></select></div>
          <div id="task-list-root"></div>
        </article>
        <article class="panel hidden" id="task-detail-panel">
          <div class="panel-label">Task Detail</div>
          <div id="task-detail-root"></div>
        </article>
      </section>

      <section id="tab-dm" class="tab-panel hidden">
        <article class="panel">
          <div class="panel-label">Direct Messages</div>
          <div class="dm-container">
            <div class="dm-name-bar"><label class="dm-name-label">Your name:</label><input class="dm-name-input" id="dm-operator-name" type="text" placeholder="operator" spellcheck="false" /></div>
            <div class="dm-messages" id="dm-messages"><div class="dm-empty">No messages yet. Send one below.</div></div>
            <div class="dm-input-row">
              <textarea class="dm-input" id="dm-input" placeholder="Type a message…" rows="1"></textarea>
              <button class="dm-send-btn" id="dm-send-btn" onclick="sendDm()">Send</button>
            </div>
          </div>
        </article>
      </section>

      <section id="tab-supervisor" class="tab-panel hidden">
        <div class="split-grid">
          <article class="panel">
            <div class="panel-label">Supervisor Docs Snapshot <span class="muted" style="font-size:9px;letter-spacing:0">(latest supervisor docs only)</span></div>
            <div id="current-work-main" class="primary-text">No supervisor task snapshot loaded yet.</div>
            <div id="current-work-reason" class="secondary-text muted"></div>
            <div id="current-work-meta" class="meta-list"></div>
          </article>
          <article class="panel">
            <div class="panel-label">Supervisor Signal</div>
            <div id="intervention-main" class="primary-text">No supervisor signal loaded yet.</div>
            <div id="intervention-body" class="secondary-text muted"></div>
            <div id="intervention-meta" class="meta-list"></div>
          </article>
        </div>
        <article class="panel">
          <div class="panel-label">Supervisor Audit</div>
          <div id="activity-supervisor"></div>
        </article>
        <div class="panel" id="supervisor-audit-history">
          <div class="panel-label">Audit History</div>
          <div class="audit-wrap">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Status</th>
                  <th>Domain</th>
                  <th>Pattern</th>
                  <th>Reason</th>
                  <th>Consecutive</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody id="audit-rows">
                <tr><td colspan="7" class="muted">Loading…</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section id="tab-subconscious" class="tab-panel hidden">
        <article class="panel" id="subconscious-unified">
          <div class="panel-head">
            <div class="panel-label">Subconscious</div>
            <div id="subconscious-mode-chip"></div>
          </div>
          <div id="subconscious-unified-content"></div>
        </article>
      </section>

      <section id="tab-internals" class="tab-panel hidden">
        <div class="stack">
          <details class="debug-detail">
            <summary>Supervisor Runtime Config</summary>
            <div class="debug-body">
              <div id="debug-runtime" class="debug-grid"></div>
            </div>
          </details>
          <details class="debug-detail">
            <summary>Paths & Sources</summary>
            <div class="debug-body">
              <div id="debug-paths" class="debug-grid"></div>
            </div>
          </details>
          <details class="debug-detail">
            <summary>AGENTS.md (Raw)</summary>
            <div class="debug-body">
              <div id="debug-doc-agents-meta" class="meta-list"></div>
              <pre id="debug-doc-agents" class="doc-frame">Loading…</pre>
            </div>
          </details>
          <details class="debug-detail">
            <summary>plan.md (Raw)</summary>
            <div class="debug-body">
              <div id="debug-doc-plan-meta" class="meta-list"></div>
              <pre id="debug-doc-plan" class="doc-frame">Loading…</pre>
            </div>
          </details>
          <details class="debug-detail">
            <summary>progress.md Tail (Raw)</summary>
            <div class="debug-body">
              <div id="debug-doc-progress-meta" class="meta-list"></div>
              <pre id="debug-doc-progress" class="doc-frame">Loading…</pre>
            </div>
          </details>
          <details class="debug-detail">
            <summary>Agent Runtime Fields</summary>
            <div class="debug-body">
              <div id="debug-raw" class="debug-grid"></div>
            </div>
          </details>
        </div>
      </section>
    </div>
  </div>

  <div id="confirm-modal" class="modal hidden" role="dialog" aria-modal="true">
    <div class="modal-card">
      <div class="modal-title" id="confirm-title">Confirm action</div>
      <div class="modal-copy" id="confirm-copy"></div>
      <div class="modal-actions">
        <button class="hero-btn" onclick="closeDangerModal()">Cancel</button>
        <button class="hero-btn danger" id="confirm-cta" onclick="confirmDangerAction()">Confirm</button>
      </div>
    </div>
  </div>
<script>
(() => {
  const agent = ${JSON.stringify(agentName)};
  const NEGATIVE_STATUSES = new Set(['DRIFTING', 'LOST', 'STUCK']);
  const TABS = new Set(['settings', 'tasks', 'dm', 'supervisor', 'subconscious', 'internals']);
  const fmtTs = (v) => {
    const n = Number(v) || 0;
    if (!n) return '-';
    return new Date(n).toLocaleString();
  };
  const esc = (v) => String(v || '').replace(/[&<>\\"]/g, (ch) => (
    ch === '&' ? '&amp;' : (ch === '<' ? '&lt;' : (ch === '>' ? '&gt;' : '&quot;'))
  ));
  const statusClass = (s) => {
    if (s === 'FOCUSED') return 'status-focused';
    if (s === 'DRIFTING' || s === 'LOST' || s === 'STUCK') return 'status-negative';
    return 'status-unknown';
  };
  const eventStatusText = (ev) => {
    if (ev?.status) return String(ev.status);
    if (ev?.domain === 'task-state') {
      const lifecycle = String(ev?.supervisor?.lifecycleState || ev?.state?.lifecycleState || '').trim().toLowerCase();
      if (lifecycle === 'idle') return 'IDLE';
      return 'NO-TASK';
    }
    return 'UNKNOWN';
  };
  const eventStatusClass = (ev) => {
    if (ev?.status) return statusClass(ev.status);
    if (ev?.domain === 'task-state') return 'status-focused';
    return 'status-unknown';
  };
  const toInt = (v, fallback = 0) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
  };
  const fmtSpanSec = (secRaw) => {
    const sec = Math.max(0, toInt(secRaw, 0));
    if (sec < 60) return sec + 's';
    if (sec < 3600) return Math.floor(sec / 60) + 'm' + (sec % 60) + 's';
    if (sec < 86400) return Math.floor(sec / 3600) + 'h' + Math.floor((sec % 3600) / 60) + 'm';
    return Math.floor(sec / 86400) + 'd' + Math.floor((sec % 86400) / 3600) + 'h';
  };
  const boolChip = (value, textTrue, textFalse) => (
    value
      ? '<span class="chip ok">' + esc(textTrue) + '</span>'
      : '<span class="chip danger">' + esc(textFalse) + '</span>'
  );
  let latestAgentDetail = null;
  let latestSupervisorDetail = null;
  let latestSupervisorControl = null;
  let latestSupervisorStatus = null;
  let latestSubconsciousPayload = null;
  let latestSubconsciousDetail = null;
  let latestUnreadPayload = null;
  let latestQueueItems = [];
  let detailStatusTimer = null;
  let detailSaveInFlight = false;
  let activeTab = 'overview';
  let dangerMode = null;
  let _presetCache = [];

  function setDetailStatus(message, kind = 'muted') {
    const el = document.getElementById('detail-status');
    if (!el) return;
    if (detailStatusTimer) {
      clearTimeout(detailStatusTimer);
      detailStatusTimer = null;
    }
    el.className = 'detail-status ' + (kind === 'ok'
      ? 'detail-status-ok'
      : (kind === 'warn' ? 'detail-status-warn' : (kind === 'error' ? 'detail-status-error' : 'muted')));
    el.textContent = message || '';
  }

  function getElVal(id) {
    const el = document.getElementById(id);
    return el ? String(el.value || '').trim() : null;
  }

  function getCurrentDetailDraft() {
    const identityEl = document.getElementById('detail-identity-input');
    const ownerEl = document.getElementById('detail-owner');
    const projectImportSourceEl = document.getElementById('detail-project-import-source');
    const projectImportNameEl = document.getElementById('detail-project-import-name');
    const projectImportModeEl = document.getElementById('detail-project-import-mode');
    const supervisorEl = document.getElementById('detail-supervisor-enabled');
    const subconsciousEl = document.getElementById('detail-subconscious-enabled');
    const guidanceEl = document.getElementById('detail-guidance');
    const runtimeEnabledEl = document.getElementById('detail-subconscious-runtime-enabled');
    const runtimeProviderEl = document.getElementById('detail-subconscious-provider');
    const runtimeModelEl = document.getElementById('detail-subconscious-model');
    const runtimeEndpointEl = document.getElementById('detail-subconscious-endpoint');
    const runtimeKeyEnvEl = document.getElementById('detail-subconscious-key-env');
    return {
      identity: identityEl ? String(identityEl.value || '').trim() : null,
      owner: ownerEl ? String(ownerEl.value || '').trim() : null,
      projectImportSource: projectImportSourceEl ? String(projectImportSourceEl.value || '').trim() : null,
      projectImportName: projectImportNameEl ? String(projectImportNameEl.value || '').trim() : null,
      projectImportMode: projectImportModeEl ? String(projectImportModeEl.value || '').trim().toLowerCase() : null,
      supervisorEnabled: supervisorEl ? supervisorEl.checked === true : null,
      subconsciousEnabled: subconsciousEl ? subconsciousEl.checked === true : null,
      guidance: guidanceEl ? String(guidanceEl.value || '').trim() : null,
      subconsciousRuntimeEnabled: runtimeEnabledEl ? runtimeEnabledEl.checked === true : null,
      subconsciousRuntimeProvider: runtimeProviderEl ? String(runtimeProviderEl.value || '').trim() : null,
      subconsciousRuntimeModel: runtimeModelEl ? String(runtimeModelEl.value || '').trim() : null,
      subconsciousRuntimeEndpoint: runtimeEndpointEl ? String(runtimeEndpointEl.value || '').trim() : null,
      subconsciousRuntimeKeyEnv: runtimeKeyEnvEl ? String(runtimeKeyEnvEl.value || '').trim() : null,
      cfgPrimaryFramework: getElVal('cfg-primary-framework'),
      cfgPrimaryProvider: getElVal('cfg-primary-provider'),
      cfgPrimaryModel: getElVal('cfg-primary-model'),
      cfgPrimaryReasoning: getElVal('cfg-primary-reasoning'),
      cfgPrimaryExtraArgs: getElVal('cfg-primary-extraArgs'),
      cfgSupervisorFramework: getElVal('cfg-supervisor-framework'),
      cfgSupervisorProvider: getElVal('cfg-supervisor-provider'),
      cfgSupervisorModel: getElVal('cfg-supervisor-model'),
      cfgSupervisorReasoning: getElVal('cfg-supervisor-reasoning'),
      cfgSupervisorExtraArgs: getElVal('cfg-supervisor-extraArgs'),
      cfgRole: getElVal('cfg-role'),
    };
  }

  function hasUnsavedDetailChanges(detail, supervisorControl, subconsciousDetail) {
    if (!detail || detail.error) return false;
    const identityEl = document.getElementById('detail-identity-input');
    if (!identityEl) return false;
    const draft = getCurrentDetailDraft();
    if ((draft.identity || '') !== String(detail.identity || '').trim()) return true;
    if (draft.supervisorEnabled !== null && draft.supervisorEnabled !== (supervisorControl?.enabled === true)) return true;
    if (draft.guidance !== null && draft.guidance !== String(subconsciousDetail?.guidance?.text || subconsciousDetail?.manualGuidance?.text || '').trim()) return true;
    if (draft.subconsciousRuntimeEnabled !== null && draft.subconsciousRuntimeEnabled !== (subconsciousDetail?.runtime?.desiredEnabled === true)) return true;
    if (draft.subconsciousRuntimeProvider !== null && draft.subconsciousRuntimeProvider !== String(subconsciousDetail?.runtime?.provider || '').trim()) return true;
    if (draft.subconsciousRuntimeModel !== null && draft.subconsciousRuntimeModel !== String(subconsciousDetail?.runtime?.model || '').trim()) return true;
    if (draft.subconsciousRuntimeEndpoint !== null && draft.subconsciousRuntimeEndpoint !== String(subconsciousDetail?.runtime?.endpoint || '').trim()) return true;
    if (draft.subconsciousRuntimeKeyEnv !== null && draft.subconsciousRuntimeKeyEnv !== String(subconsciousDetail?.runtime?.keyEnv || '').trim()) return true;
    const rp = detail.runtimeProfile || {};
    const pri = rp.primary || {};
    const sup = rp.supervisor || {};
    if (draft.cfgPrimaryFramework !== null && draft.cfgPrimaryFramework !== String(pri.framework || '').trim()) return true;
    if (draft.cfgPrimaryProvider !== null && draft.cfgPrimaryProvider !== String(pri.provider || '').trim()) return true;
    if (draft.cfgPrimaryModel !== null && draft.cfgPrimaryModel !== String(pri.model || '').trim()) return true;
    if (draft.cfgPrimaryReasoning !== null && draft.cfgPrimaryReasoning !== String(pri.reasoning || '').trim()) return true;
    if (draft.cfgPrimaryExtraArgs !== null && draft.cfgPrimaryExtraArgs !== String(pri.extraArgs || '').trim()) return true;
    if (draft.cfgSupervisorFramework !== null && draft.cfgSupervisorFramework !== String(sup.framework || '').trim()) return true;
    if (draft.cfgSupervisorProvider !== null && draft.cfgSupervisorProvider !== String(sup.provider || '').trim()) return true;
    if (draft.cfgSupervisorModel !== null && draft.cfgSupervisorModel !== String(sup.model || '').trim()) return true;
    if (draft.cfgSupervisorReasoning !== null && draft.cfgSupervisorReasoning !== String(sup.reasoning || '').trim()) return true;
    if (draft.cfgSupervisorExtraArgs !== null && draft.cfgSupervisorExtraArgs !== String(sup.extraArgs || '').trim()) return true;
    if (draft.cfgRole !== null && draft.cfgRole !== String(detail.role || '').trim()) return true;
    if (!detail.v1) return false;
    if ((draft.owner || '') !== String(detail.owner || '').trim()) return true;
    if ((draft.projectImportSource || '') !== '') return true;
    if ((draft.projectImportName || '') !== '') return true;
    if (draft.projectImportMode !== null && draft.projectImportMode !== 'copy') return true;
    if (draft.subconsciousEnabled !== null && draft.subconsciousEnabled !== (detail.subconsciousEnabled === true)) return true;
    return false;
  }

  function syncDetailDirtyStatus() {
    if (detailSaveInFlight) return;
    if (hasUnsavedDetailChanges(latestAgentDetail, latestSupervisorControl, latestSubconsciousDetail)) {
      setDetailStatus('Unsaved changes in Agent Detail.', 'warn');
    } else if (document.getElementById('detail-status')?.textContent === 'Unsaved changes in Agent Detail.') {
      setDetailStatus('', 'muted');
    }
  }

  function bindDetailEditors() {
    const ids = [
      'detail-identity-input',
      'detail-owner',
      'detail-project-import-source',
      'detail-project-import-name',
      'detail-project-import-mode',
      'detail-supervisor-enabled',
      'detail-subconscious-enabled',
      'detail-guidance',
      'detail-subconscious-runtime-enabled',
      'detail-subconscious-provider',
      'detail-subconscious-model',
      'detail-subconscious-endpoint',
      'detail-subconscious-key-env',
      'cfg-primary-framework',
      'cfg-primary-provider',
      'cfg-primary-model',
      'cfg-primary-reasoning',
      'cfg-primary-extraArgs',
      'cfg-supervisor-framework',
      'cfg-supervisor-provider',
      'cfg-supervisor-model',
      'cfg-supervisor-reasoning',
      'cfg-supervisor-extraArgs',
      'cfg-role',
    ];
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      const evt = el.tagName === 'INPUT' && el.getAttribute('type') === 'checkbox' ? 'change' : 'input';
      el.addEventListener(evt, syncDetailDirtyStatus);
    });
  }

  function bindProjectLifecycleButtons() {
    document.querySelectorAll('.project-action-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        removeManagedProject(
          btn.dataset.projectName || '',
          btn.dataset.projectPath || '',
          btn.dataset.deleteFiles === '1'
        );
      });
    });
  }

  function hashToTab(hashValue) {
    const raw = String(hashValue || '').replace(/^#/, '').trim().toLowerCase();
    if (raw === 'activity') return 'supervisor';
    if (raw === 'audit') return 'supervisor';
    if (raw === 'debug') return 'internals';
    if (raw === 'overview') return 'settings';
    if (TABS.has(raw)) return raw;
    return 'settings';
  }

  function setActiveTab(nextTab, options = {}) {
    const next = TABS.has(nextTab) ? nextTab : 'settings';
    activeTab = next;
    document.querySelectorAll('.tab-btn[data-tab]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === next);
    });
    document.querySelectorAll('.tab-panel[id^="tab-"]').forEach((panel) => {
      panel.classList.toggle('hidden', panel.id !== ('tab-' + next));
    });
    if (options.updateHash !== false) {
      const nextHash = options.focusAudit ? '#audit' : ('#' + next);
      history.replaceState(null, '', window.location.pathname + nextHash);
    }
    if (options.focusAudit) {
      requestAnimationFrame(() => {
        document.getElementById('supervisor-audit-history')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
    if (next === 'dm' && !dmLoaded) loadDmHistory();
    if (next === 'tasks') {
      // Auto-set assignee filter to monitored agent if one is selected
      const filterEl = document.getElementById('task-filter-assignee');
      if (filterEl && monitoredAgent && !filterEl._userOverride) {
        filterEl.value = monitoredAgent.name;
        sessionStorage.setItem('task_filter_assignee', monitoredAgent.name);
        const u = new URL(window.location);
        u.searchParams.set('assignee', monitoredAgent.name);
        history.replaceState(null, '', u);
      }
      taskListRefresh();
    }
  }

  // ── DM tab logic ──────────────────────────────
  const DM_LS_KEY = 'dm_operator_name';
  function sanitizeOperatorName(raw) {
    return (raw || '').trim().replace(/[^a-zA-Z0-9_-]/g, '') || 'operator';
  }
  function getDmOperatorName() {
    return sanitizeOperatorName(localStorage.getItem(DM_LS_KEY));
  }
  {
    const nameInput = document.getElementById('dm-operator-name');
    if (nameInput) {
      nameInput.value = getDmOperatorName();
      nameInput.addEventListener('input', () => {
        const v = nameInput.value.replace(/[^a-zA-Z0-9_-]/g, '').trim();
        nameInput.value = v;
        localStorage.setItem(DM_LS_KEY, v);
      });
    }
  }
  let dmLoaded = false;
  let dmMessages = [];
  let dmSending = false;
  let dmScrollSnap = true; // true on first load and after sending

  function renderDmMessages() {
    const container = document.getElementById('dm-messages');
    if (!container) return;
    if (dmMessages.length === 0) {
      container.innerHTML = '<div class="dm-empty">No messages yet. Send one below.</div>';
      return;
    }
    // Check if user is at bottom before re-render (threshold 40px)
    const wasAtBottom = dmScrollSnap || (container.scrollTop + container.clientHeight >= container.scrollHeight - 40);
    container.innerHTML = dmMessages.map((m) => {
      const isOutgoing = m.from === getDmOperatorName() || (m.source === 'web' && m.type === 'human');
      const cls = isOutgoing ? 'outgoing' : 'incoming';
      const text = esc(m.full || m.summary || '');
      const fromLabel = esc(m.from || 'unknown');
      const time = m.at ? new Date(m.at).toLocaleString() : '';
      return '<div class="dm-msg ' + cls + '">'
        + '<div class="dm-msg-from">' + fromLabel + '</div>'
        + text
        + '<div class="dm-msg-meta">' + esc(time) + '</div>'
        + '</div>';
    }).join('');
    if (wasAtBottom) container.scrollTop = container.scrollHeight;
    dmScrollSnap = false;
  }

  async function loadDmHistory() {
    try {
      const r = await fetch('/api/agents/' + encodeURIComponent(agent) + '/dm-history?limit=200');
      if (!r.ok) { console.warn('[dm] load failed:', r.status); return; }
      const data = await r.json();
      dmMessages = Array.isArray(data.messages) ? data.messages : [];
      dmLoaded = true;
      renderDmMessages();
    } catch (e) {
      console.warn('[dm] load error:', e);
    }
  }

  async function sendDm() {
    if (dmSending) return;
    const input = document.getElementById('dm-input');
    const text = (input?.value || '').trim();
    if (!text) return;
    const btn = document.getElementById('dm-send-btn');
    dmSending = true;
    if (btn) btn.disabled = true;
    try {
      const r = await fetch('/api/agents/' + encodeURIComponent(agent) + '/dm-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, from: getDmOperatorName() }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        console.warn('[dm] send failed:', err);
        return;
      }
      input.value = '';
      input.style.height = '';
      dmScrollSnap = true;
      await loadDmHistory();
    } catch (e) {
      console.warn('[dm] send error:', e);
    } finally {
      dmSending = false;
      if (btn) btn.disabled = false;
    }
  }

  // Auto-resize textarea and send on Enter (Shift+Enter for newline)
  {
    const input = document.getElementById('dm-input');
    if (input) {
      input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendDm();
        }
      });
    }
  }

  function openSupervisorAudit() {
    setActiveTab('supervisor', { focusAudit: true });
  }

  function openSubconsciousDebug() {
    setActiveTab('subconscious');
  }

  function syncStickyOffsets() {
    const hero = document.querySelector('.hero');
    if (!hero) return;
    const heroRect = hero.getBoundingClientRect();
    const heroHeight = Math.max(0, Math.ceil(heroRect.height));
    const gap = 14;
    document.documentElement.style.setProperty('--detail-tabs-top', (heroHeight + gap) + 'px');
  }

  window.setActiveTab = setActiveTab;
  window.openSupervisorAudit = openSupervisorAudit;
  window.openSubconsciousDebug = openSubconsciousDebug;

  function queueItemsForAgent(queueItems) {
    return (Array.isArray(queueItems) ? queueItems : []).filter((item) => {
      const target = String(item?.to || '').split(':', 1)[0];
      return target === agent;
    });
  }

  function fmtWaitAge(ts) {
    const diff = Math.max(0, Math.floor((Date.now() - Number(ts || 0)) / 1000));
    if (diff < 60) return diff + 's';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ' + (diff % 60) + 's';
    return Math.floor(diff / 3600) + 'h ' + Math.floor((diff % 3600) / 60) + 'm';
  }

  function statusTone(status) {
    if (status === 'FOCUSED') return 'ok';
    if (NEGATIVE_STATUSES.has(status)) return 'danger';
    return 'warn';
  }

  function hasCurrentSupervisorIssue(state) {
    const classification = String(state?.classification || '').trim().toLowerCase();
    if (classification === 'stalled_wait' || classification === 'suspected_eos') return true;
    const lifecycleState = String(state?.lifecycleState || '').trim().toLowerCase();
    return lifecycleState === 'active' && classification.length > 0;
  }

  function kvGrid(entries) {
    const rows = entries.filter((entry) => entry && entry[1] !== undefined && entry[1] !== null && entry[1] !== '');
    if (rows.length === 0) return '<div class="empty-state">No data available.</div>';
    return rows.map((entry) => (
      '<div class="debug-kv"><b>' + esc(entry[0]) + '</b>' + esc(String(entry[1])) + '</div>'
    )).join('');
  }

  function buildPageModel(detail, statusRow, supervisorDetail, supervisorStatus, supervisorControl, subconsciousPayload, subconsciousDetail, unreadPayload, queueItems, allStatusRows) {
    const latest = supervisorDetail?.latest || null;
    const state = supervisorDetail?.state || {};
    const events = Array.isArray(supervisorDetail?.events) ? supervisorDetail.events : [];
    const subconsciousEvents = Array.isArray(subconsciousPayload?.events) ? subconsciousPayload.events : [];
    const unreadRows = Array.isArray(unreadPayload?.messages) ? unreadPayload.messages : [];
    const queueRows = queueItemsForAgent(queueItems);
    const activeNow = statusRow && typeof statusRow.activeNow === 'boolean'
      ? statusRow.activeNow
      : !!detail?.active;
    const activeDurationSec = toInt(statusRow?.activeDurationSec, 0);
    const idleDurationSec = toInt(statusRow?.idleDurationSec, Math.floor((Number(detail?.idleMs) || 0) / 1000));
    const runtimeText = activeNow ? ('ACTIVE ' + fmtSpanSec(activeDurationSec)) : ('IDLE ' + fmtSpanSec(idleDurationSec));
    const latestLifecycle = String(latest?.supervisor?.lifecycleState || state?.lifecycleState || '').trim().toLowerCase();
    const latestStatus = String(
      latest?.status
      || ((latest?.domain === 'task-state' && latestLifecycle === 'idle') ? 'IDLE' : '')
      || ((!latest && latestLifecycle === 'idle') ? 'IDLE' : 'UNKNOWN')
    ).trim() || 'UNKNOWN';
    const latestReason = String(latest?.reason || '').trim();
    const supervisorTaskSnapshot = String(latest?.docs?.currentTask || '').trim();
    const unreadTotal = Math.max(0, toInt(unreadPayload?.unread_total, unreadRows.length));
    const queueCount = queueRows.length;
    const consecutiveNegative = toInt(state?.consecutiveNegative, 0);
    const supervisorEnabled = supervisorControl?.enabled === true;
    const supervisorRuntimeRunning = supervisorStatus?.runtime?.running === true;
    // Per-agent supervisor: check if supervisor-<agentName> is registered and alive
    const supervisorAgentName = 'supervisor-' + agent;
    const supervisorAgentRow = Array.isArray(allStatusRows) ? allStatusRows.find(r => r && r.name === supervisorAgentName) : null;
    const supervisorAgentExists = !!supervisorAgentRow;
    const supervisorAgentAlive = supervisorAgentRow?.alive === true;
    const supervisorClassification = String(state?.classification || '').trim().toUpperCase();
    const supervisorLifecycleState = String(state?.lifecycleState || '').trim().toLowerCase();
    const supervisorCurrentStatePresent = supervisorClassification.length > 0 || supervisorLifecycleState.length > 0;
    const supervisorCurrentIssue = hasCurrentSupervisorIssue(state);
    const subconsciousEnabled = detail?.subconsciousEnabled === true;
    const subconsciousWritable = detail?.v1 === true;
    const subconsciousStage = String(subconsciousDetail?.stage || 'unknown').trim() || 'unknown';
    const authority = (subconsciousDetail?.authority && typeof subconsciousDetail.authority === 'object')
      ? subconsciousDetail.authority
      : buildSubconsciousAuthoritySummaryMeta(subconsciousEnabled, subconsciousDetail?.upstream || {}, subconsciousDetail?.provider?.lettaAgentId || null);
    const fallback = (subconsciousDetail?.fallback && typeof subconsciousDetail.fallback === 'object')
      ? subconsciousDetail.fallback
      : buildSubconsciousFallbackSummaryMeta(String(subconsciousDetail?.guidance?.text || subconsciousDetail?.manualGuidance?.text || ''));
    const runtimeContract = (subconsciousDetail?.runtime && typeof subconsciousDetail.runtime === 'object')
      ? subconsciousDetail.runtime
      : {};
    const transitional = (subconsciousDetail?.transitional && typeof subconsciousDetail.transitional === 'object')
      ? subconsciousDetail.transitional
      : buildSubconsciousTransitionalSummaryMeta(runtimeContract, subconsciousDetail?.memory, subconsciousDetail?.conversation);
    const upstreamDetail = (subconsciousDetail?.upstream && typeof subconsciousDetail.upstream === 'object')
      ? subconsciousDetail.upstream
      : {};
    const upstreamBootstrap = (upstreamDetail.bootstrap && typeof upstreamDetail.bootstrap === 'object')
      ? upstreamDetail.bootstrap
      : {};
    const upstreamSession = (upstreamDetail.session && typeof upstreamDetail.session === 'object')
      ? upstreamDetail.session
      : {};
    const upstreamUserPrompt = (upstreamDetail.userPrompt && typeof upstreamDetail.userPrompt === 'object')
      ? upstreamDetail.userPrompt
      : {};
    const upstreamPreTool = (upstreamDetail.preTool && typeof upstreamDetail.preTool === 'object')
      ? upstreamDetail.preTool
      : {};
    const blockedLikely = supervisorCurrentIssue && (latestStatus === 'STUCK' || /block|approval|intervention|waiting/i.test(latestReason));
    const needsAttention = supervisorCurrentIssue && NEGATIVE_STATUSES.has(latestStatus);
    let localRuntimeState = 'off';
    let localRuntimeLabel = 'Off';
    if (runtimeContract.desiredEnabled === true && runtimeContract.invocationConfigured === true) {
      localRuntimeState = 'ready';
      localRuntimeLabel = 'Ready';
    } else if (runtimeContract.desiredEnabled === true) {
      localRuntimeState = 'degraded';
      localRuntimeLabel = 'Degraded';
    }
    let activeSubconsciousPath = 'Off';
    if (authority.status === 'active') activeSubconsciousPath = 'Authoritative upstream active';
    else if (authority.status === 'degraded') activeSubconsciousPath = 'Authoritative upstream degraded';
    else if (authority.status === 'unconfigured') activeSubconsciousPath = 'Authoritative upstream unconfigured';
    else if (subconsciousEnabled) activeSubconsciousPath = 'Enabled without authoritative path';
    const healthParts = [
      'Runtime ' + (activeNow ? ('active ' + fmtSpanSec(activeDurationSec)) : ('idle ' + fmtSpanSec(idleDurationSec))),
      'Delivery ' + unreadTotal + ' unread / ' + queueCount + ' queued',
      'Subconscious ' + activeSubconsciousPath,
    ];
    if (needsAttention) healthParts.push('Supervisor warning present');
    const healthSummary = healthParts.join(' · ');
    let interventionTitle = 'No active supervisor warning';
    let interventionBody = 'Supervisor currently shows no active warning.';
    if (!supervisorEnabled && !supervisorCurrentIssue) {
      interventionTitle = 'No active supervisor warning';
      interventionBody = 'Supervisor is disabled. Historical findings remain in the Supervisor tab and audit history.';
    } else if (blockedLikely) {
      interventionTitle = latestStatus + ' (supervisor)';
      interventionBody = latestReason || 'Supervisor evaluated agent as blocked or stuck.';
    } else if (needsAttention) {
      interventionTitle = latestStatus + ' (supervisor)';
      interventionBody = latestReason || 'Supervisor flagged drift or loss of focus.';
    } else if (!supervisorRuntimeRunning && !supervisorCurrentStatePresent) {
      interventionTitle = 'No active supervisor warning';
      interventionBody = 'Supervisor is not actively running. Historical findings remain in the Supervisor tab and audit history.';
    }
    const banner = needsAttention
      ? {
          kind: blockedLikely ? 'danger' : 'warn',
          text: blockedLikely
            ? ('Blocked or stuck: ' + (latestReason || 'recent supervisor evaluation requires human attention'))
            : ('Supervisor warning: ' + (latestReason || 'recent evaluation is negative')),
        }
      : null;
    const guidanceEvents = subconsciousEvents.filter((ev) => ev?.guidancePresent === true);
    const guidanceInjectedEvents = subconsciousEvents.filter((ev) => ev?.guidanceInjected === true);
    const latestSubEvent = subconsciousEvents.length ? subconsciousEvents[subconsciousEvents.length - 1] : null;
    const hookCounts = new Map();
    for (const ev of subconsciousEvents) {
      const key = String(ev?.hook || ev?.hookEventName || 'Unknown');
      hookCounts.set(key, (hookCounts.get(key) || 0) + 1);
    }
    const topHooks = [...hookCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4);
    return {
      latest,
      state,
      events,
      supervisorEnabled,
      supervisorDisabledReason: supervisorControl?.disabledReason || null,
      supervisorControl,
      subconsciousEnabled,
      subconsciousWritable,
      subconsciousStage,
      subconsciousDetail,
      authority,
      fallback,
      transitional,
      activeSubconsciousPath,
      localRuntimeState,
      localRuntimeLabel,
      upstreamBootstrap,
      upstreamSession,
      upstreamUserPrompt,
      upstreamPreTool,
      runtimeInvocationConfigured: runtimeContract.invocationConfigured === true,
      runtimeDesiredEnabled: runtimeContract.desiredEnabled === true,
      runtimeDisabledReason: String(runtimeContract.disabledReason || '').trim(),
      runtimeProvider: String(runtimeContract.provider || '').trim(),
      runtimeModel: String(runtimeContract.model || '').trim(),
      runtimeEndpoint: String(runtimeContract.endpoint || '').trim(),
      runtimeKeyEnv: String(runtimeContract.keyEnv || '').trim(),
      runtimeConfigFamily: String(runtimeContract.configFamily || '').trim(),
      runtimeConfigSources: (runtimeContract.configSources && typeof runtimeContract.configSources === 'object')
        ? runtimeContract.configSources
        : {},
      runtimeKeyAvailable: runtimeContract.keyAvailable === true,
      upstreamDetail,
      subconsciousMemory: (subconsciousDetail?.memory && typeof subconsciousDetail.memory === 'object')
        ? subconsciousDetail.memory
        : {},
      subconsciousConversation: (subconsciousDetail?.conversation && typeof subconsciousDetail.conversation === 'object')
        ? subconsciousDetail.conversation
        : {},
      currentConversation: (subconsciousDetail?.conversation?.current && typeof subconsciousDetail.conversation.current === 'object')
        ? subconsciousDetail.conversation.current
        : null,
      lastRuntimeInvocation: subconsciousDetail?.lastInvocation || null,
      lastRuntimeGuidance: subconsciousDetail?.lastRuntimeGuidance || null,
      subconsciousBlockers: Array.isArray(subconsciousDetail?.missingBackendPieces) ? subconsciousDetail.missingBackendPieces : [],
      subconsciousEvents,
      latestSubEvent,
      guidanceEvents,
      guidanceConfigured: fallback.configured === true,
      guidanceInjectedEvents,
      guidancePreview: String(detail?.subconsciousGuidancePreview || subconsciousDetail?.guidance?.preview || subconsciousDetail?.manualGuidance?.preview || '').trim(),
      guidanceText: String(detail?.subconsciousGuidanceText || subconsciousDetail?.guidance?.text || subconsciousDetail?.manualGuidance?.text || '').trim(),
      topHooks,
      unreadRows,
      unreadTotal,
      queueRows,
      queueCount,
      activeNow,
      runtimeText,
      latestStatus,
      latestReason,
      supervisorTaskSnapshot,
      supervisorRuntimeRunning,
      supervisorAgentExists,
      supervisorAgentAlive,
      supervisorCurrentStatePresent,
      supervisorClassification,
      supervisorLifecycleState,
      healthSummary,
      interventionTitle,
      interventionBody,
      blockedLikely,
      needsAttention,
      consecutiveNegative,
      banner,
      agentRegistered: !!statusRow,
    };
  }

  function renderHeader(detail, model) {
    document.getElementById('hero-title').textContent = detail?.name || agent;
    const runtimeBits = [];
    if (detail?.agentType) runtimeBits.push(String(detail.agentType).toUpperCase());
    if (detail?.server) runtimeBits.push(String(detail.server));
    if (detail?.model) runtimeBits.push(String(detail.model));
    document.getElementById('hero-runtime').textContent = runtimeBits.length ? runtimeBits.join(' · ') : 'Runtime details unavailable';
    const chips = [];
    chips.push('<span class="chip ' + (model.activeNow ? 'ok' : 'neutral') + '">' + esc(model.runtimeText) + '</span>');
    if (!model.supervisorAgentExists) {
      chips.push('<span class="chip neutral">NO SUPERVISOR</span>');
    } else if (!model.supervisorAgentAlive) {
      chips.push('<span class="chip warn">SUPERVISOR NOT RUNNING</span>');
    } else {
      chips.push('<span class="chip ok">SUPERVISOR ON</span>');
    }
    chips.push('<span class="chip ' + (model.subconsciousEnabled ? 'ok' : 'neutral') + '">SUBCONSCIOUS ' + esc(model.subconsciousEnabled ? 'ON' : 'OFF') + '</span>');
    chips.push('<span class="chip neutral">UNREAD ' + esc(String(model.unreadTotal)) + '</span>');
    chips.push('<span class="chip neutral">QUEUE ' + esc(String(model.queueCount)) + '</span>');
    if (model.needsAttention) {
      chips.push('<span class="chip ' + statusTone(model.latestStatus) + '">SUPERVISOR SIGNAL ' + esc(model.latestStatus) + '</span>');
    }
    document.getElementById('header-chips').innerHTML = chips.join('');
    const healthSumEl = document.getElementById('health-summary');
    healthSumEl.textContent = model.healthSummary;
    healthSumEl.classList.remove('health-error');
    const bannerEl = document.getElementById('exception-banner');
    if (model.banner) {
      bannerEl.classList.remove('hidden');
      bannerEl.classList.toggle('warn', model.banner.kind === 'warn');
      bannerEl.textContent = model.banner.text;
    } else {
      bannerEl.classList.add('hidden');
      bannerEl.classList.remove('warn');
      bannerEl.textContent = '';
    }
  }

  function renderCurrentWork(model) {
    const mainEl = document.getElementById('current-work-main');
    if (!model.supervisorEnabled) {
      mainEl.textContent = 'Supervisor disabled.';
    } else {
      mainEl.textContent = model.supervisorTaskSnapshot || 'No task text was recorded in the latest supervisor docs snapshot.';
    }
    mainEl.style.color = '';
    const reasonEl = document.getElementById('current-work-reason');
    if (!model.supervisorEnabled) {
      reasonEl.textContent = 'Supervisor doc snapshots are unavailable while supervisor is off.';
    } else {
      reasonEl.textContent = model.supervisorTaskSnapshot
        ? 'Raw text from the latest supervisor docs snapshot, not the canonical task object.'
        : 'The latest supervisor docs snapshot did not expose task text.';
    }
    const meta = [];
    if (model.supervisorEnabled) {
      meta.push('<span class="meta-item">judged ' + esc(fmtTs(model.state?.lastJudgedAt)) + '</span>');
      meta.push('<span class="meta-item">warning ' + esc(fmtTs(model.state?.lastWarningAt)) + '</span>');
      if (model.latest?.pattern) meta.push('<span class="meta-item">pattern ' + esc(model.latest.pattern) + '</span>');
      if (model.latest?.domain) meta.push('<span class="meta-item">domain ' + esc(model.latest.domain) + '</span>');
    }
    document.getElementById('current-work-meta').innerHTML = meta.join('');
  }

  function renderIntervention(model) {
    const mainEl = document.getElementById('intervention-main');
    mainEl.textContent = model.interventionTitle;
    mainEl.style.color = '';
    document.getElementById('intervention-body').textContent = model.interventionBody;
    const meta = [];
    meta.push('<span class="meta-item">neg streak ' + esc(String(model.consecutiveNegative)) + '</span>');
    if (model.blockedLikely) meta.push('<span class="meta-item">source: supervisor eval</span>');
    document.getElementById('intervention-meta').innerHTML = meta.join('');
  }

  function renderEventList(targetId, events, limit, emptyMessage) {
    const el = document.getElementById(targetId);
    if (!el) return;
    const rows = Array.isArray(events) ? events.slice().reverse().slice(0, limit) : [];
    if (rows.length === 0) {
      el.innerHTML = '<div class="empty-state">' + esc(emptyMessage) + '</div>';
      return;
    }
    el.innerHTML = rows.map((ev) => {
      const action = ev?.action?.summary ? ev.action.summary : (ev?.action?.type || '');
      const metaParts = [];
      if (ev?.domain) metaParts.push(ev.domain);
      if (ev?.pattern) metaParts.push(ev.pattern);
      if (action) metaParts.push(action);
      return '<div class="event-item">'
        + '<div class="event-row"><div class="event-main">' + esc(ev?.reason || ev?.status || 'Event') + '</div><div class="event-time">' + esc(fmtTs(ev?.ts)) + '</div></div>'
        + '<div class="event-meta"><span class="status ' + eventStatusClass(ev) + '">' + esc(eventStatusText(ev)) + '</span>'
        + (metaParts.length ? (' · ' + esc(metaParts.join(' · '))) : '')
        + '</div></div>';
    }).join('');
  }

  function hookBadgeClass(hook) {
    const h = String(hook || '').toLowerCase();
    if (h === 'sessionstart') return 'hook-session';
    if (h === 'userpromptsubmit') return 'hook-prompt';
    if (h === 'pretooluse') return 'hook-tool';
    if (h === 'stop') return 'hook-stop';
    return 'hook-unknown';
  }
  function hookDisplayName(hook) {
    const h = String(hook || '');
    if (h === 'SessionStart') return 'Session';
    if (h === 'UserPromptSubmit') return 'Prompt';
    if (h === 'PreToolUse') return 'Tool';
    if (h === 'Stop') return 'Stop';
    return h || 'Unknown';
  }
  function cleanEventSummary(raw, hook, toolName) {
    let s = String(raw || '').trim();
    // Strip the full boilerplate prefix "Subconscious hook <hookType>[: <toolName>]"
    const boilerplate = /^Subconscious hook\s*(pre-tool:\s*\S+|user prompt|session start|stop)\s*$/i;
    if (boilerplate.test(s)) return '';
    // Strip just the "Subconscious hook" prefix if followed by other content
    s = s.replace(/^Subconscious hook\s*/i, '').trim();
    if (toolName && s === toolName) return '';
    return s;
  }
  function renderHookBreakdown(targetId, events) {
    const el = document.getElementById(targetId);
    if (!el) return;
    const counts = new Map();
    for (const ev of (events || [])) {
      const key = String(ev?.hook || ev?.hookEventName || 'Unknown');
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    if (counts.size === 0) { el.innerHTML = ''; return; }
    const injectedCount = (events || []).filter(e => e?.guidanceInjected === true).length;
    const runtimeCount = (events || []).filter(e => e?.runtimeInvoked === true).length;
    let html = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([hook, count]) =>
      '<span class="hook-count"><span class="hook-badge ' + hookBadgeClass(hook) + '">' + esc(hookDisplayName(hook)) + '</span>' + esc(String(count)) + '</span>'
    ).join('');
    if (injectedCount > 0) html += '<span class="hook-count"><span class="ev-chip chip-injected">Injected</span>' + esc(String(injectedCount)) + '</span>';
    if (runtimeCount > 0) html += '<span class="hook-count"><span class="ev-chip chip-runtime">Runtime</span>' + esc(String(runtimeCount)) + '</span>';
    el.innerHTML = html;
  }
  function renderSubconsciousEventList(targetId, events, limit, emptyMessage) {
    const el = document.getElementById(targetId);
    if (!el) return;
    const rows = Array.isArray(events) ? events.slice().reverse().slice(0, limit) : [];
    if (rows.length === 0) {
      el.innerHTML = '<div class="empty-state">' + esc(emptyMessage) + '</div>';
      return;
    }
    el.innerHTML = rows.map((ev) => {
      const hook = ev?.hook || ev?.hookEventName || 'Unknown';
      const injected = ev?.guidanceInjected === true;
      const runtimeInvoked = ev?.runtimeInvoked === true;
      const isEligible = hook === 'UserPromptSubmit' || hook === 'PreToolUse';
      const itemClass = 'event-item' + (injected ? ' ev-injected' : '') + (runtimeInvoked ? ' ev-runtime' : '');

      // Header: hook badge + tool name (if any) + timestamp
      let headerContent = '<span class="hook-badge ' + hookBadgeClass(hook) + '">' + esc(hookDisplayName(hook)) + '</span>';
      if (ev?.toolName) headerContent += ' <span class="event-main" style="font-size:11px">' + esc(ev.toolName) + '</span>';

      // Status chips
      const chips = [];
      if (injected) chips.push('<span class="ev-chip chip-injected">Injected</span>');
      else if (isEligible && ev?.guidanceConfigured === true) chips.push('<span class="ev-chip">Configured, not injected</span>');
      if (runtimeInvoked) {
        let rtLabel = 'Runtime';
        if (ev?.runtimeProvider || ev?.runtimeModel) rtLabel += ' (' + esc([ev.runtimeProvider, ev.runtimeModel].filter(Boolean).join('/')) + ')';
        if (ev?.runtimeLatencyMs) rtLabel += ' ' + esc(String(ev.runtimeLatencyMs)) + 'ms';
        chips.push('<span class="ev-chip chip-runtime">' + rtLabel + '</span>');
      }
      if (ev?.upstreamUserPromptMessageSent === true) {
        chips.push('<span class="ev-chip">Upstream prompt sent</span>');
      } else if (ev?.upstreamUserPromptStatus === 'blocked') {
        chips.push('<span class="ev-chip chip-error">Upstream prompt blocked</span>');
      }
      if (ev?.upstreamPreToolInjected === true) {
        chips.push('<span class="ev-chip">Upstream pre-tool injected</span>');
      } else if (ev?.upstreamPreToolStatus === 'blocked') {
        chips.push('<span class="ev-chip chip-error">Upstream pre-tool blocked</span>');
      }
      if (ev?.upstreamStopMessageSent === true) {
        chips.push('<span class="ev-chip">Upstream stop sent</span>');
      } else if (ev?.upstreamStopStatus === 'blocked') {
        chips.push('<span class="ev-chip chip-error">Upstream stop blocked</span>');
      }
      if (ev?.runtimeError) chips.push('<span class="ev-chip chip-error">Error</span>');
      if (ev?.resolutionSource && ev.resolutionSource !== 'none') chips.push('<span class="ev-chip">' + esc(ev.resolutionSource) + '</span>');

      // Summary content — strip boilerplate "Subconscious hook ..." prefix
      const rawSummary = String(ev?.summary || ev?.promptPreview || '').replace(/\\s+/g, ' ').trim();
      const cleanedSummary = cleanEventSummary(rawSummary, hook, ev?.toolName);
      const summary = cleanedSummary.length > 200 ? (cleanedSummary.slice(0, 200) + '...') : cleanedSummary;

      let html = '<div class="' + itemClass + '">';
      html += '<div class="event-row"><div class="event-main">' + headerContent + '</div><div class="event-time">' + esc(fmtTs(ev?.ts)) + '</div></div>';
      if (chips.length > 0) html += '<div class="event-chips">' + chips.join('') + '</div>';
      if (summary) html += '<div class="event-summary">' + esc(summary) + '</div>';
      html += '</div>';
      return html;
    }).join('');
  }

  function renderOverview(detail, model) {
    const deliveryBits = [];
    deliveryBits.push('<div class="summary-grid">'
      + '<div class="summary-stat"><div class="summary-k">Unread</div><div class="summary-v">' + esc(String(model.unreadTotal)) + '</div></div>'
      + '<div class="summary-stat"><div class="summary-k">Queue</div><div class="summary-v">' + esc(String(model.queueCount)) + '</div></div>'
      + '</div>');
    if (model.unreadRows.length > 0) {
      const topUnread = model.unreadRows[0];
      const previewRaw = String(topUnread?.summary || topUnread?.full || '').replace(/\\s+/g, ' ').trim();
      const preview = previewRaw.length > 140 ? (previewRaw.slice(0, 140) + '...') : previewRaw;
      deliveryBits.push('<div class="summary-note"><strong>Next unread:</strong> ' + esc(preview || '(no summary)') + '</div>');
    } else if (model.queueRows.length > 0) {
      deliveryBits.push('<div class="summary-note"><strong>Queue oldest:</strong> waiting ' + esc(fmtWaitAge(model.queueRows[0]?.queuedAt)) + '</div>');
    } else {
      deliveryBits.push('<div class="summary-note">No unread messages or queued items.</div>');
    }
    document.getElementById('overview-delivery').innerHTML = deliveryBits.join('');

    const projects = Array.isArray(detail?.managedProjects) ? detail.managedProjects : [];
    const projectBits = [];
    projectBits.push('<div class="summary-grid">'
      + '<div class="summary-stat"><div class="summary-k">Owner</div><div class="summary-v">' + esc(detail?.owner || '-') + '</div></div>'
      + '<div class="summary-stat"><div class="summary-k">Projects</div><div class="summary-v">' + esc(String(projects.length)) + '</div></div>'
      + '<div class="summary-stat"><div class="summary-k">Home</div><div class="summary-v">' + esc(detail?.v1 ? 'V1' : 'Legacy') + '</div></div>'
      + '</div>');
    if (projects.length > 0) {
      projectBits.push('<ul class="list tight">' + projects.slice(0, 4).map((p) => '<li>' + esc(p?.name || '?') + ' <span class="muted">(' + esc(p?.source || 'unknown') + ')</span></li>').join('') + '</ul>');
    } else {
      projectBits.push('<div class="summary-note">No managed projects recorded.</div>');
    }
    document.getElementById('overview-projects').innerHTML = projectBits.join('');
  }

  function renderSettings(detail, model) {
    const identityRoot = document.getElementById('settings-identity');
    const guidanceRoot = document.getElementById('settings-guidance');
    const systemsRoot = document.getElementById('settings-systems');
    const ownerRoot = document.getElementById('settings-owner');
    if (!detail || detail.error) {
      identityRoot.innerHTML = '<div class="error-state">Agent detail unavailable.</div>';
      guidanceRoot.innerHTML = '<div class="error-state">Guidance unavailable.</div>';
      const cfgRoot = document.getElementById('settings-configuration');
      if (cfgRoot) cfgRoot.innerHTML = '<div class="error-state">Configuration unavailable.</div>';
      systemsRoot.innerHTML = '<div class="error-state">System control state unavailable.</div>';
      ownerRoot.innerHTML = '<div class="error-state">Ownership unavailable.</div>';
      return;
    }
    identityRoot.innerHTML =
      '<div class="detail-hint">Short one-line external-facing description used in listings and summaries.</div>'
      + '<div class="field-label">Identity</div>'
      + '<input id="detail-identity-input" class="detail-input" value="' + esc(detail.identity || '').replace(/"/g, '&quot;') + '" placeholder="One-line external description">'
      + '<div class="detail-actions"><button class="detail-save" onclick="saveDetailIdentity()">Save Identity</button></div>';

    const subconsciousWritable = detail.v1 === true;
    const guidanceText = String(model?.guidanceText || '');
    guidanceRoot.innerHTML = subconsciousWritable
      ? (
        '<div class="detail-hint">Human-authored intent surface. Current storage and writer boundary remain the existing v1 guidance state path.</div>'
        + '<textarea id="detail-guidance" class="detail-textarea" placeholder="Guidance text">' + esc(guidanceText) + '</textarea>'
        + '<div class="detail-actions"><button class="detail-save" onclick="saveDetailGuidance()">Save Guidance</button></div>'
      )
      : (
        '<div class="empty-state">Guidance is writable only for V1 home agents in the current implementation.</div>'
      );

    const configRoot = document.getElementById('settings-configuration');
    const rp = detail.runtimeProfile || {};
    const pri = rp.primary || {};
    const sup = rp.supervisor || {};
    function matchPreset(role) {
      if (!role || !role.framework) return '';
      for (const p of _presetCache) {
        if (p.framework === role.framework && p.provider === (role.provider || null) && p.model === (role.model || null)
            && p.reasoning === (role.reasoning || null) && (p.extraArgs || null) === (role.extraArgs || null)) return p.id;
      }
      return '';
    }
    const priPreset = matchPreset(pri);
    const supPreset = matchPreset(sup);
    function presetOpts(selectedId) {
      let h = '<option value="">(none)</option>';
      for (const p of _presetCache) {
        h += '<option value="' + esc(p.id) + '"' + (p.id === selectedId ? ' selected' : '') + '>' + esc(p.name) + '</option>';
      }
      h += '<option value="__custom__">Custom...</option>';
      return h;
    }
    const fwOpts = function(sel) {
      return '<option value="">(not set)</option>'
        + '<option value="claude"' + (sel === 'claude' ? ' selected' : '') + '>claude</option>'
        + '<option value="codex"' + (sel === 'codex' ? ' selected' : '') + '>codex</option>';
    };
    const rpCustomFields = function(prefix, role, presetId) {
      const hidden = presetId !== '__custom__' ? ' style="display:none"' : '';
      return '<div id="cfg-' + prefix + '-custom"' + hidden + '>'
        + '<div class="field-label">Framework</div>'
        + '<select id="cfg-' + prefix + '-framework" class="detail-input">' + fwOpts(role.framework || '') + '</select>'
        + '<input id="cfg-' + prefix + '-provider" type="hidden" value="anthropic">'
        + '<div class="field-label">Model</div>'
        + '<input id="cfg-' + prefix + '-model" class="detail-input" value="' + esc(role.model || '').replace(/"/g, '&quot;') + '" placeholder="e.g. claude-sonnet-4-20250514">'
        + '<div class="field-label">Reasoning</div>'
        + '<input id="cfg-' + prefix + '-reasoning" class="detail-input" value="' + esc(role.reasoning || '').replace(/"/g, '&quot;') + '" placeholder="e.g. extended">'
        + '<div class="field-label">Extra Args</div>'
        + '<input id="cfg-' + prefix + '-extraArgs" class="detail-input" value="' + esc(role.extraArgs || '').replace(/"/g, '&quot;') + '" placeholder="e.g. --verbose --max-tokens 4096">'
        + '<div class="detail-hint" style="margin-top:2px;font-size:10px">Only CLI flags allowed. Shell operators are rejected.</div>'
        + '</div>';
    };
    function currentPresetLabel(presetId, role) {
      if (presetId) {
        const p = _presetCache.find(pp => pp.id === presetId);
        return p ? esc(p.name) : '(unknown preset)';
      }
      if (role && role.framework) return 'Custom (' + esc(role.framework) + (role.model ? ' / ' + esc(role.model) : '') + ')';
      return '(none)';
    }
    const priCurrentLabel = currentPresetLabel(priPreset, pri);
    const supCurrentLabel = currentPresetLabel(supPreset, sup);
    configRoot.innerHTML =
      '<div class="detail-hint">Per-agent runtime profile and role. Select a preset or choose Custom for raw fields. Changes take effect after restart.</div>'
      + '<div id="cfg-restart-banner" class="error-state" style="display:none;margin-bottom:8px;background:rgba(234,179,8,0.12);color:rgba(234,179,8,0.95);border-left:3px solid rgba(234,179,8,0.5);padding:6px 10px">Runtime profile changes take effect after agent restart. The running agent continues using its current configuration until restarted.</div>'
      + '<div class="panel"><div class="panel-label">Primary Role</div>'
      + '<div class="field-label">Preset</div>'
      + '<select id="cfg-primary-preset" class="detail-input" onchange="onPresetChange(\\'primary\\')">' + presetOpts(priPreset || (pri.framework ? '__custom__' : '')) + '</select>'
      + '<div class="detail-hint" style="margin-top:2px;font-size:10px;color:rgba(136,192,208,0.7)">Currently running: <strong>' + priCurrentLabel + '</strong></div>'
      + rpCustomFields('primary', pri, priPreset) + '</div>'
      + '<div class="panel"><div class="panel-label">Supervisor Role</div>'
      + '<div class="field-label">Preset</div>'
      + '<select id="cfg-supervisor-preset" class="detail-input" onchange="onPresetChange(\\'supervisor\\')">' + presetOpts(supPreset || (sup.framework ? '__custom__' : '')) + '</select>'
      + '<div class="detail-hint" style="margin-top:2px;font-size:10px;color:rgba(136,192,208,0.7)">Currently running: <strong>' + supCurrentLabel + '</strong></div>'
      + rpCustomFields('supervisor', sup, supPreset) + '</div>'
      + '<div class="field-label">Agent Description</div>'
      + '<div class="detail-hint" style="margin-top:0;margin-bottom:4px;font-size:10px">Free-text purpose or role description for this agent. Shown in summaries and used by supervisors.</div>'
      + '<input id="cfg-role" class="detail-input" value="' + esc(detail.role || '').replace(/"/g, '&quot;') + '" placeholder="e.g. Handles CI/CD pipeline tasks">'
      + '<div class="detail-actions"><button class="detail-save" onclick="saveDetailConfiguration()">Save Configuration</button></div>';

    const ownerHtml = detail.v1
      ? (
        '<div class="detail-hint">First-class ownership field for this agent home.</div>'
        + '<div class="field-label">Owner</div>'
        + '<input id="detail-owner" class="detail-input" value="' + esc(detail.owner || '').replace(/"/g, '&quot;') + '" placeholder="Human owner">'
        + '<div class="detail-actions"><button class="detail-save" onclick="saveDetailOwner()">Save Owner</button></div>'
      )
      : '<div class="empty-state">This agent does not expose a writable V1 owner field.</div>';
    ownerRoot.innerHTML = ownerHtml;
    const supervisorControlHtml = model?.agentRegistered
      ? (
        '<div class="panel">'
        + '<div class="panel-label">Supervisor Audit</div>'
        + '<label class="detail-toggle"><input id="detail-supervisor-enabled" type="checkbox" ' + (model?.supervisorEnabled ? 'checked' : '') + '>Enabled</label>'
        + '<div class="detail-actions"><button class="detail-save" onclick="saveSupervisorAuditControl()">Save</button></div>'
        + '</div>'
      )
      : '<div class="panel"><div class="panel-label">Supervisor Audit</div><div class="empty-state">Agent must be registered to enable supervisor.</div></div>';
    const subconsciousControlHtml = subconsciousWritable
      ? (
        '<div class="panel">'
        + '<div class="panel-label">Subconscious Control</div>'
        + '<label class="detail-toggle"><input id="detail-subconscious-enabled" type="checkbox" ' + (detail.subconsciousEnabled ? 'checked' : '') + '>Enabled</label>'
        + '<div class="detail-actions"><button class="detail-save" onclick="saveSubconsciousControl()">Save</button></div>'
        + '</div>'
      )
      : '';
    const runtimeContractHtml = subconsciousWritable
      ? (
        '<div class="panel">'
        + '<div class="panel-label">Subconscious LLM</div>'
        + (model?.runtimeDisabledReason ? '<div class="error-state" style="margin-bottom:8px">' + esc(model.runtimeDisabledReason) + '</div>' : '')
        + '<label class="detail-toggle"><input id="detail-subconscious-runtime-enabled" type="checkbox" ' + (model?.runtimeDesiredEnabled ? 'checked' : '') + '>Enabled</label>'
        + '<div class="field-label">Provider</div>'
        + '<input id="detail-subconscious-provider" class="detail-input" value="' + esc(model?.runtimeProvider || '').replace(/"/g, '&quot;') + '" placeholder="env/default">'
        + '<div class="field-label">Model</div>'
        + '<input id="detail-subconscious-model" class="detail-input" value="' + esc(model?.runtimeModel || '').replace(/"/g, '&quot;') + '" placeholder="env/default">'
        + '<div class="field-label">Endpoint</div>'
        + '<input id="detail-subconscious-endpoint" class="detail-input" value="' + esc(model?.runtimeEndpoint || '').replace(/"/g, '&quot;') + '" placeholder="env/default">'
        + '<div class="field-label">Key Env</div>'
        + '<input id="detail-subconscious-key-env" class="detail-input" value="' + esc(model?.runtimeKeyEnv || '').replace(/"/g, '&quot;') + '" placeholder="SUBCONSCIOUS_LLM_KEY">'
        + '<div class="detail-actions"><button class="detail-save" onclick="saveSubconsciousRuntime()">Save</button></div>'
        + '</div>'
      )
      : '';
    systemsRoot.innerHTML = supervisorControlHtml + subconsciousControlHtml + runtimeContractHtml;

    const presetsRoot = document.getElementById('settings-presets');
    if (presetsRoot) {
      let ph = '<div class="detail-hint">Named bundles of framework/provider/model settings. Used in Configuration above.</div>';
      if (_presetCache.length === 0) {
        ph += '<div class="task-empty-state">No presets defined yet.</div>';
      } else {
        ph += '<table class="task-list-table"><thead><tr><th>Name</th><th>Framework</th><th>Model</th><th></th></tr></thead><tbody>';
        for (const p of _presetCache) {
          ph += '<tr>'
            + '<td><strong>' + esc(p.name) + '</strong></td>'
            + '<td>' + esc(p.framework || '-') + '</td>'
            + '<td>' + esc(p.model || '-') + '</td>'
            + '<td><button class="detail-save" style="font-size:10px;padding:2px 8px" onclick="deletePreset(\\'' + esc(p.id) + '\\')">Del</button></td>'
            + '</tr>';
        }
        ph += '</tbody></table>';
      }
      ph += '<details class="task-advanced" style="margin-top:10px"><summary class="task-advanced-toggle">Add Preset</summary>'
        + '<div class="field-label">Name</div><input id="preset-name" class="detail-input" placeholder="e.g. Claude Opus">'
        + '<div class="field-label">Framework</div><select id="preset-framework" class="detail-input"><option value="">—</option><option value="claude">claude</option><option value="codex">codex</option></select>'
        + '<div class="field-label">Model</div><input id="preset-model" class="detail-input" placeholder="e.g. claude-sonnet-4-20250514">'
        + '<div class="field-label">Reasoning</div><input id="preset-reasoning" class="detail-input" placeholder="e.g. extended">'
        + '<div class="field-label">Extra Args</div><input id="preset-extraArgs" class="detail-input" placeholder="e.g. --verbose">'
        + '<div class="detail-actions"><button class="detail-save" onclick="createPreset()">Create Preset</button></div>'
        + '</details>';
      presetsRoot.innerHTML = ph;
    }

    const managedProjects = Array.isArray(detail?.managedProjects) ? detail.managedProjects : [];
    const projectRows = managedProjects.length
      ? (
        '<div class="panel">'
        + '<div class="panel-label">Managed Projects</div>'
        + '<div class="list">'
        + managedProjects.map((project) => (
          '<div class="summary-note"><strong>' + esc(project?.name || '?') + '</strong> · ' + esc(project?.source || 'unknown')
          + '<br><span class="mono">' + esc(project?.path || '-') + '</span>'
          + '<br>Origin: <span class="mono">' + esc(project?.originPath || '-') + '</span>'
          + '<div class="detail-actions">'
          + '<button class="detail-save project-action-btn" data-project-name="' + esc(project?.name || '').replace(/"/g, '&quot;') + '" data-project-path="' + esc(project?.path || '').replace(/"/g, '&quot;') + '" data-delete-files="0">Untrack</button>'
          + '<button class="detail-save project-action-btn" data-project-name="' + esc(project?.name || '').replace(/"/g, '&quot;') + '" data-project-path="' + esc(project?.path || '').replace(/"/g, '&quot;') + '" data-delete-files="1">Remove From Home</button>'
          + '</div></div>'
        )).join('')
        + '</div>'
        + '</div>'
      )
      : (
        '<div class="panel">'
        + '<div class="panel-label">Managed Projects</div>'
        + '<div class="empty-state">No managed projects.</div>'
        + '</div>'
      );
    const projectImportHtml =
      '<div class="panel">'
      + '<div class="panel-label">Import Project</div>'
      + '<div class="field-label">Source Path</div>'
      + '<input id="detail-project-import-source" class="detail-input" placeholder="/absolute/path/to/project">'
      + '<div class="field-label">Project Name</div>'
      + '<input id="detail-project-import-name" class="detail-input" placeholder="Optional; defaults to directory name">'
      + '<div class="field-label">Mode</div>'
      + '<select id="detail-project-import-mode" class="detail-input"><option value="copy">copy</option><option value="symlink">symlink</option></select>'
      + '<div class="detail-actions"><button class="detail-save" onclick="importManagedProject()">Import</button></div>'
      + '</div>';
    const workspaceMigrationHtml =
      '<div class="panel">'
      + '<div class="panel-label">Workspace Migration</div>'
      + '<div class="detail-actions"><button class="detail-save" onclick="migrateWorkspaceEntryFiles()">Migrate Entry Files</button></div>'
      + '</div>';

    if (detail.v1) {
      ownerRoot.innerHTML += projectRows + projectImportHtml + workspaceMigrationHtml;
    }
    bindDetailEditors();
    if (detail.v1) bindProjectLifecycleButtons();
  }

  function renderUnreadPanel(unreadRows, queueRows, unreadTotal) {
    const blocks = [];
    blocks.push('<div class="summary-grid">'
      + '<div class="summary-stat"><div class="summary-k">Unread</div><div class="summary-v">' + esc(String(unreadTotal)) + '</div></div>'
      + '<div class="summary-stat"><div class="summary-k">Queue</div><div class="summary-v">' + esc(String(queueRows.length)) + '</div></div>'
      + '</div>');
    if (unreadRows.length > 0) {
      blocks.push('<ul class="list">' + unreadRows.slice(0, 12).map((msg) => {
        const route = msg?.group ? ('Group #' + String(msg.group) + ' @' + String(msg.from || 'unknown')) : ('DM @' + String(msg?.from || 'unknown'));
        const previewRaw = String(msg?.summary || msg?.full || '(no summary)').replace(/\\s+/g, ' ').trim();
        const preview = previewRaw.length > 140 ? (previewRaw.slice(0, 140) + '...') : previewRaw;
        return '<li><span class="mono">' + esc(route) + '</span><br>' + esc(preview) + '</li>';
      }).join('') + '</ul>');
    } else {
      blocks.push('<div class="empty-state">No unread messages.</div>');
    }
    if (queueRows.length > 0) {
      blocks.push('<div class="summary-note"><strong>Queued targets:</strong><ul class="list tight">' + queueRows.slice(0, 8).map((item) => (
        '<li>waiting ' + esc(fmtWaitAge(item?.queuedAt)) + ' · ' + esc(String(item?.payload || '').slice(0, 90)) + '</li>'
      )).join('') + '</ul></div>');
    }
    return blocks.join('');
  }

  function renderSubconsciousUnified(model) {
    const upstream = (model.upstreamDetail && typeof model.upstreamDetail === 'object') ? model.upstreamDetail : {};
    const upstreamBootstrap = (model.upstreamBootstrap && typeof model.upstreamBootstrap === 'object') ? model.upstreamBootstrap : {};
    const upstreamSession = (model.upstreamSession && typeof model.upstreamSession === 'object') ? model.upstreamSession : {};
    const upstreamUserPrompt = (model.upstreamUserPrompt && typeof model.upstreamUserPrompt === 'object') ? model.upstreamUserPrompt : {};
    const upstreamPreTool = (model.upstreamPreTool && typeof model.upstreamPreTool === 'object') ? model.upstreamPreTool : {};
    const upstreamNotify = (upstreamSession.notify && typeof upstreamSession.notify === 'object') ? upstreamSession.notify : {};
    const directReuse = Array.isArray(upstream.directReuse) ? upstream.directReuse : [];


    const authority = (model.authority && typeof model.authority === 'object') ? model.authority : {};
    const fallback = (model.fallback && typeof model.fallback === 'object') ? model.fallback : {};
    const transitional = (model.transitional && typeof model.transitional === 'object') ? model.transitional : {};
    let modeDotClass = 'dot-off';
    let modeLabel = 'Subconscious Off';
    if (authority.status === 'active') {
      modeDotClass = 'dot-runtime';
      modeLabel = 'Authoritative Path Active';
    } else if (authority.status === 'degraded') {
      modeDotClass = 'dot-active';
      modeLabel = 'Authoritative Path Degraded';
    } else if (authority.status === 'unconfigured') {
      modeDotClass = 'dot-active';
      modeLabel = 'Authoritative Path Unconfigured';
    } else if (model.subconsciousEnabled) {
      modeDotClass = 'dot-active';
      modeLabel = 'Enabled Without Authority';
    }
    document.getElementById('subconscious-mode-chip').innerHTML = '<div class="subconscious-mode-indicator"><span class="mode-dot ' + modeDotClass + '"></span>' + esc(modeLabel) + '</div>';

    const bits = [];
    const conversation = (model.currentConversation && typeof model.currentConversation === 'object') ? model.currentConversation : null;
    const conversationStore = (model.subconsciousConversation && typeof model.subconsciousConversation === 'object') ? model.subconsciousConversation : {};

    // ═══════════════════════════════════════════════
    // TIER 1: Status at a glance
    // ═══════════════════════════════════════════════
    const authoritativeStatus = authority.status || 'off';
    const authoritativeSession = upstreamSession.established === true ? 'Established' : (upstreamSession.status || 'not-run');
    const fallbackStatus = fallback.configured === true ? 'Guidance configured' : 'No guidance';
    const localRuntimeStatus = transitional.runtimeStatus || model.localRuntimeLabel || 'off';
    bits.push('<div class="sub-section">');
    bits.push('<div class="summary-grid">'
      + '<div class="summary-stat"><div class="summary-k">Authority</div><div class="summary-v">' + esc(authoritativeStatus) + '</div></div>'
      + '<div class="summary-stat"><div class="summary-k">Session</div><div class="summary-v">' + esc(authoritativeSession) + '</div></div>'
      + '<div class="summary-stat"><div class="summary-k">Fallback</div><div class="summary-v">' + esc(fallbackStatus) + '</div></div>'
      + '<div class="summary-stat"><div class="summary-k">Events</div><div class="summary-v">' + esc(String(model.subconsciousEvents.length)) + '</div></div>'
      + '</div>');
    if (authority.reason) {
      bits.push('<div class="summary-note"><strong>Authority reason:</strong> ' + esc(authority.reason) + '</div>');
    }
    if (model.subconsciousBlockers.length > 0) {
      bits.push('<div style="margin-top:6px"><span style="color:#fc8181;font-size:11px">' + esc(model.subconsciousBlockers.length + ' blocker' + (model.subconsciousBlockers.length > 1 ? 's' : '')) + '</span></div>');
    }
    bits.push('</div>');

    // ═══════════════════════════════════════════════
    // TIER 2: Operational detail (always visible)
    // ═══════════════════════════════════════════════

    // --- Authoritative Path ---
    bits.push('<div class="sub-section">');
    bits.push('<div class="sub-section-label">Authoritative Path</div>');
    bits.push('<div class="summary-note"><strong>Path:</strong> upstream Letta durable state</div>');
    bits.push('<div class="summary-note"><strong>Bootstrap:</strong> ' + esc(upstreamBootstrap.status || 'not-run')
      + (upstreamBootstrap.blockedReason ? (' · ' + esc(upstreamBootstrap.blockedReason)) : '') + '</div>');
    bits.push('<div class="summary-note"><strong>Agent:</strong> ' + esc(upstreamBootstrap.agentId || model.subconsciousDetail?.provider?.lettaAgentId || '-') + '</div>');
    bits.push('<div class="summary-note"><strong>Session:</strong> ' + esc(upstreamSession.established === true ? 'Established' : (upstreamSession.status || 'not-run'))
      + (upstreamSession.sessionId ? (' · ' + esc(upstreamSession.sessionId)) : '')
      + (upstreamSession.blockedReason ? (' · ' + esc(upstreamSession.blockedReason)) : '') + '</div>');
    if (upstreamSession.conversationId) {
      bits.push('<div class="summary-note"><strong>Conversation:</strong> ' + esc(upstreamSession.conversationId) + (upstreamSession.conversationStatus ? (' · ' + esc(upstreamSession.conversationStatus)) : '') + '</div>');
    }
    bits.push('<div class="summary-note"><strong>User Prompt:</strong> ' + esc(upstreamUserPrompt.status || 'not-run')
      + (upstreamUserPrompt.sessionId ? (' · ' + esc(upstreamUserPrompt.sessionId)) : '')
      + (upstreamUserPrompt.blockedReason ? (' · ' + esc(upstreamUserPrompt.blockedReason)) : '') + '</div>');
    bits.push('<div class="summary-note"><strong>Pre-Tool:</strong> ' + esc(upstreamPreTool.status || 'not-run')
      + (upstreamPreTool.sessionId ? (' · ' + esc(upstreamPreTool.sessionId)) : '')
      + (upstreamPreTool.blockedReason ? (' · ' + esc(upstreamPreTool.blockedReason)) : '') + '</div>');
    bits.push('<div class="summary-note"><strong>Notify:</strong> ' + esc(upstreamNotify.status || 'not-attempted')
      + (upstreamNotify.blockedReason ? (' · ' + esc(upstreamNotify.blockedReason)) : '') + '</div>');
    bits.push('</div>');

    // --- Fallback & Transitional ---
    bits.push('<div class="sub-section">');
    bits.push('<div class="sub-section-label">Fallback & Transitional</div>');
    bits.push('<div class="summary-note"><strong>Guidance:</strong> ' + esc(fallback.status || 'none')
      + (fallback.note ? (' · ' + esc(fallback.note)) : '') + '</div>');
    bits.push('<div class="summary-note"><strong>Local runtime:</strong> ' + esc(localRuntimeStatus)
      + ' · transitional only'
      + (model.runtimeDisabledReason ? (' · ' + esc(model.runtimeDisabledReason)) : '') + '</div>');
    if (model.guidancePreview) {
      bits.push('<div class="guidance-preview gp-manual"><div class="guidance-label">Guidance</div><div class="guidance-text">' + esc(model.guidancePreview) + '</div></div>');
    }
    if (model.subconsciousMemory?.entryCount > 0) {
      bits.push('<div class="summary-note"><strong>Local memory journal:</strong> ' + esc(model.subconsciousMemory.kind || 'episodic') + ' · ' + esc(String(model.subconsciousMemory.entryCount)) + ' episodes · transitional only</div>');
    }
    if (!model.guidancePreview && !(model.subconsciousMemory?.entryCount > 0)) {
      bits.push('<div class="summary-note">' + esc(transitional.note || 'No fallback or transitional detail recorded.') + '</div>');
    }
    bits.push('</div>');

    // --- Latest Activity ---
    bits.push('<div class="sub-section">');
    bits.push('<div class="sub-section-label">Latest Event</div>');
    if (model.latestSubEvent) {
      const lev = model.latestSubEvent;
      const latestHook = lev.hook || lev.hookEventName || 'Unknown';
      bits.push('<div class="summary-note">'
        + '<span class="hook-badge ' + hookBadgeClass(latestHook) + '">' + esc(hookDisplayName(latestHook)) + '</span> '
        + esc(fmtTs(lev.ts))
        + (lev.toolName ? (' · ' + esc(lev.toolName)) : '')
        + (lev.guidanceInjected === true ? ' · <span style="color:#9ae6b4">injected</span>' : '')
        + (lev.runtimeInvoked === true ? ' · <span style="color:#63b3ed">runtime</span>' : '')
        + '</div>');
      if (lev.summary) {
        const preview = cleanEventSummary(String(lev.summary).replace(/\\s+/g, ' ').trim(), latestHook, lev.toolName);
        if (preview) bits.push('<div class="event-summary">' + esc(preview.length > 160 ? preview.slice(0, 160) + '...' : preview) + '</div>');
      }
    } else {
      bits.push('<div class="empty-state">No hook events recorded yet.</div>');
    }
    bits.push('</div>');

    // --- Blockers (always visible if present) ---
    if (model.subconsciousBlockers.length > 0) {
      bits.push('<div class="sub-section">');
      bits.push('<div class="sub-section-label" style="color:#fc8181">Blockers</div>');
      bits.push('<ul class="list tight">' + model.subconsciousBlockers.map((item) => '<li>' + esc(item) + '</li>').join('') + '</ul>');
      bits.push('</div>');
    }

    // ═══════════════════════════════════════════════
    // TIER 3: Collapsed details
    // ═══════════════════════════════════════════════
    bits.push('<div class="sub-divider"></div>');

    // --- Conversation State (collapsed) ---
    bits.push('<details class="sub-detail">');
    bits.push('<summary>Local Conversation Journal</summary>');
    bits.push('<div class="sub-detail-body">');
    if (conversation || conversationStore.currentSessionId) {
      bits.push('<div class="summary-note"><strong>Role:</strong> transitional compatibility journal only</div>');
      bits.push('<div class="summary-note"><strong>Session:</strong> ' + esc(conversation?.sessionId || conversationStore.currentSessionId || '-') + '</div>');
      bits.push('<div class="summary-note"><strong>Turns:</strong> user ' + esc(String(conversation?.userTurnCount ?? 0)) + ' · assistant ' + esc(String(conversation?.assistantTurnCount ?? 0)) + '</div>');
      bits.push('<div class="summary-note"><strong>Last activity:</strong> ' + esc(conversation?.lastEventAt || conversationStore.lastSyncedAt || '-') + '</div>');
    } else {
      bits.push('<div class="empty-state">No local transitional conversation journal recorded.</div>');
    }
    bits.push('</div></details>');

    // --- Hook Event Stream (collapsed) ---
    bits.push('<details class="sub-detail" id="subconscious-event-stream">');
    bits.push('<summary>Event Stream <span class="section-count">' + esc(String(model.subconsciousEvents.length)) + '</span></summary>');
    bits.push('<div class="sub-detail-body">');
    bits.push('<div id="unified-hook-breakdown" class="hook-breakdown" style="margin-bottom:10px"></div>');
    bits.push('<div id="unified-event-list" class="event-list"></div>');
    bits.push('</div></details>');

    // --- Section 6: Debug internals (collapsed by default) ---
    bits.push('<details class="sub-detail">');
    bits.push('<summary>Debug Internals</summary>');
    bits.push('<div class="sub-detail-body">');

    // Config Status
    bits.push('<div class="debug-sub-section"><div class="debug-sub-label">Config Status</div>' + kvGrid([
      ['Stage', model.subconsciousStage],
      ['Enabled', model.subconsciousEnabled ? 'yes' : 'no'],
      ['Writable', model.subconsciousWritable ? 'yes' : 'no'],
      ['Guidance', model.guidanceConfigured ? 'configured' : 'none'],
      ['Event count', model.subconsciousEvents.length],
      ['Injected count', model.guidanceInjectedEvents.length],
    ]) + '</div>');

    // Hook Installation
    bits.push('<div class="debug-sub-section"><div class="debug-sub-label">Hook Installation</div>' + kvGrid([
      ['Runtime installed', model.subconsciousDetail?.runtime?.hookRuntimeInstalled === true ? 'yes' : 'no'],
      ['Bindings installed', model.subconsciousDetail?.runtime?.hookBindingsInstalled === true ? 'yes' : 'no'],
      ['Hooks', Array.isArray(model.subconsciousDetail?.runtime?.installedHooks) && model.subconsciousDetail.runtime.installedHooks.length ? model.subconsciousDetail.runtime.installedHooks.join(', ') : '-'],
      ['Event sink', model.subconsciousDetail?.runtime?.eventSinkConfigured === true ? 'yes' : 'no'],
      ['Event URL', model.subconsciousDetail?.runtime?.eventUrl || '-'],
      ['Invoke URL', model.subconsciousDetail?.runtime?.invokeUrl || '-'],
    ]) + '</div>');

    // Runtime LLM
    bits.push('<div class="debug-sub-section"><div class="debug-sub-label">Runtime LLM</div>' + kvGrid([
      ['Desired enabled', model.runtimeDesiredEnabled ? 'yes' : 'no'],
      ['Invocation configured', model.runtimeInvocationConfigured ? 'yes' : 'no'],
      ['Disabled reason', model.runtimeDisabledReason || '-'],
      ['Provider', model.runtimeProvider || '-'],
      ['Model', model.runtimeModel || '-'],
      ['Endpoint', model.runtimeEndpoint || '-'],
      ['Key env', model.runtimeKeyEnv || '-'],
      ['Key available', model.runtimeKeyAvailable ? 'yes' : 'no'],
    ]) + '</div>');

    // Config Sources
    bits.push('<div class="debug-sub-section"><div class="debug-sub-label">Config Resolution</div>' + kvGrid([
      ['Provider', model.runtimeConfigSources?.provider || '-'],
      ['Model', model.runtimeConfigSources?.model || '-'],
      ['Endpoint', model.runtimeConfigSources?.endpoint || '-'],
      ['Key env', model.runtimeConfigSources?.keyEnv || '-'],
    ]) + '</div>');

    // Episodic Memory
    bits.push('<div class="debug-sub-section"><div class="debug-sub-label">Episodic Memory</div>' + kvGrid([
      ['Store configured', model.subconsciousDetail?.provider?.memoryStoreConfigured === true ? 'yes' : 'no'],
      ['Kind', model.subconsciousMemory?.kind || '-'],
      ['Entries', model.subconsciousMemory?.entryCount ?? '-'],
      ['Strategy', model.subconsciousMemory?.retrievalStrategy || '-'],
      ['Path', model.subconsciousMemory?.path || '-'],
      ['Last retrieval', model.subconsciousMemory?.lastRetrievedAt || '-'],
      ['Last query', model.subconsciousMemory?.lastRetrievedQuery || '-'],
    ]) + '</div>');

    bits.push('<div class="debug-sub-section"><div class="debug-sub-label">Conversation Journal</div>' + kvGrid([
      ['Store kind', model.subconsciousConversation?.kind || '-'],
      ['Store path', model.subconsciousConversation?.path || '-'],
      ['Sessions', model.subconsciousConversation?.sessionCount ?? '-'],
      ['Session limit', model.subconsciousConversation?.sessionLimit ?? '-'],
      ['Current session', model.currentConversation?.sessionId || model.subconsciousConversation?.currentSessionId || '-'],
      ['Transcript path', model.currentConversation?.transcriptPath || model.subconsciousConversation?.currentTranscriptPath || '-'],
      ['Transcript exists', model.currentConversation?.transcriptExists === true ? 'yes' : 'no'],
      ['User turns', model.currentConversation?.userTurnCount ?? '-'],
      ['Assistant turns', model.currentConversation?.assistantTurnCount ?? '-'],
      ['Latest guidance preview', model.currentConversation?.latestGuidancePreview || '-'],
      ['Last sync', model.subconsciousConversation?.lastSyncedAt || '-'],
    ]) + '</div>');

    bits.push('<div class="debug-sub-section"><div class="debug-sub-label">Upstream Session Lifecycle</div>' + kvGrid([
      ['Status', upstreamSession.status || '-'],
      ['Blocked reason', upstreamSession.blockedReason || '-'],
      ['Established', upstreamSession.established === true ? 'yes' : 'no'],
      ['Session id', upstreamSession.sessionId || '-'],
      ['Conversation id', upstreamSession.conversationId || '-'],
      ['Conversation status', upstreamSession.conversationStatus || '-'],
      ['Session state file', upstreamSession.sessionStateFile || '-'],
      ['Session started', upstreamSession.sessionStartedAt || '-'],
      ['Notify status', upstreamNotify.status || '-'],
      ['Notify blocker', upstreamNotify.blockedReason || '-'],
      ['Notify attempted', upstreamNotify.attempted ? 'yes' : 'no'],
      ['Message sent', upstreamNotify.messageSent ? 'yes' : 'no'],
      ['Notify attempted at', upstreamNotify.attemptedAt || '-'],
      ['Message sent at', upstreamNotify.messageSentAt || upstreamSession.messageSentAt || '-'],
      ['Required decision', upstreamNotify.requiredDecision || '-'],
      ['Checked at', upstreamSession.checkedAt || '-'],
      ['CWD', upstreamSession.cwd || '-'],
    ]) + '</div>');

    bits.push('<div class="debug-sub-section"><div class="debug-sub-label">Upstream User Prompt</div>' + kvGrid([
      ['Status', upstreamUserPrompt.status || '-'],
      ['Blocked reason', upstreamUserPrompt.blockedReason || '-'],
      ['Attempted', upstreamUserPrompt.attempted ? 'yes' : 'no'],
      ['Message sent', upstreamUserPrompt.messageSent ? 'yes' : 'no'],
      ['Session id', upstreamUserPrompt.sessionId || '-'],
      ['Conversation id', upstreamUserPrompt.conversationId || '-'],
      ['Transcript path', upstreamUserPrompt.transcriptPath || '-'],
      ['Transcript exists', upstreamUserPrompt.transcriptExists === true ? 'yes' : 'no'],
      ['Transcript lines', upstreamUserPrompt.transcriptLineCount ?? '-'],
      ['Sync state file', upstreamUserPrompt.syncStateFile || '-'],
      ['Last processed before', upstreamUserPrompt.lastProcessedIndexBefore ?? '-'],
      ['Last processed after', upstreamUserPrompt.lastProcessedIndexAfter ?? '-'],
      ['Script path', upstreamUserPrompt.scriptPath || '-'],
      ['Attempted at', upstreamUserPrompt.attemptedAt || '-'],
      ['Message sent at', upstreamUserPrompt.messageSentAt || '-'],
      ['Checked at', upstreamUserPrompt.checkedAt || '-'],
    ]) + '</div>');

    bits.push('<div class="debug-sub-section"><div class="debug-sub-label">Upstream Pre-Tool</div>' + kvGrid([
      ['Status', upstreamPreTool.status || '-'],
      ['Blocked reason', upstreamPreTool.blockedReason || '-'],
      ['Attempted', upstreamPreTool.attempted ? 'yes' : 'no'],
      ['Injected', upstreamPreTool.injected ? 'yes' : 'no'],
      ['Session id', upstreamPreTool.sessionId || '-'],
      ['Conversation id', upstreamPreTool.conversationId || '-'],
      ['Sync state file', upstreamPreTool.syncStateFile || '-'],
      ['New messages', upstreamPreTool.newMessageCount ?? '-'],
      ['Changed blocks', upstreamPreTool.changedBlockCount ?? '-'],
      ['Last seen before', upstreamPreTool.lastSeenMessageIdBefore || '-'],
      ['Last seen after', upstreamPreTool.lastSeenMessageIdAfter || '-'],
      ['Block labels', upstreamPreTool.blockLabelCount ?? '-'],
      ['Script path', upstreamPreTool.scriptPath || '-'],
      ['Attempted at', upstreamPreTool.attemptedAt || '-'],
      ['Injected at', upstreamPreTool.injectedAt || '-'],
      ['Checked at', upstreamPreTool.checkedAt || '-'],
    ]) + '</div>');

    // State & Invocation
    bits.push('<div class="debug-sub-section"><div class="debug-sub-label">State & Invocation</div>' + kvGrid([
      ['Letta agent id', model.subconsciousDetail?.provider?.lettaAgentId || model.latestSubEvent?.lettaAgentId || '-'],
      ['State file', model.latestSubEvent?.lettaStateFile || '-'],
      ['Backend runtime', model.subconsciousDetail?.provider?.backendRuntimeConfigured === true ? 'yes' : 'no'],
      ['Model config', model.subconsciousDetail?.provider?.modelConfigConfigured === true ? 'yes' : 'no'],
      ['Invocation boundary', model.subconsciousDetail?.provider?.invocationConfigured === true ? 'yes' : 'no'],
      ['Last invocation', model.lastRuntimeInvocation?.summary || '-'],
      ['Last retrieval matches', model.lastRuntimeInvocation?.memoryRetrieval?.matchCount ?? '-'],
      ['Last retrieval ids', Array.isArray(model.lastRuntimeInvocation?.memoryRetrieval?.matchIds) && model.lastRuntimeInvocation.memoryRetrieval.matchIds.length ? model.lastRuntimeInvocation.memoryRetrieval.matchIds.join(', ') : '-'],
      ['Last runtime guidance', model.lastRuntimeGuidance?.preview || '-'],
    ]) + '</div>');

    // Latest Event
    bits.push('<div class="debug-sub-section"><div class="debug-sub-label">Latest Event Detail</div>' + kvGrid([
      ['Hook', model.latestSubEvent?.hook || model.latestSubEvent?.hookEventName || '-'],
      ['Source', model.latestSubEvent?.source || '-'],
      ['Tool', model.latestSubEvent?.toolName || '-'],
      ['Summary', model.latestSubEvent?.summary || '-'],
      ['Prompt preview', model.latestSubEvent?.promptPreview || '-'],
      ['Resolution', model.latestSubEvent?.resolutionSource || '-'],
    ]) + '</div>');

    bits.push('</div></details>');

    document.getElementById('subconscious-unified-content').innerHTML = bits.join('');

    // Render dynamic elements after innerHTML is set
    renderHookBreakdown('unified-hook-breakdown', model.subconsciousEvents);
    renderSubconsciousEventList('unified-event-list', model.subconsciousEvents, 30, 'No hook events recorded yet.');
  }

  function renderActivity(model) {
    const latest = model.latest || null;
    const supervisorBits = [];
    supervisorBits.push('<div class="summary-grid">'
      + '<div class="summary-stat"><div class="summary-k">Enabled</div><div class="summary-v">' + esc(model.supervisorEnabled ? 'On' : 'Off') + '</div></div>'
      + '<div class="summary-stat"><div class="summary-k">Latest Status</div><div class="summary-v">' + esc(model.latestStatus) + '</div></div>'
      + '<div class="summary-stat"><div class="summary-k">Last Judged</div><div class="summary-v">' + esc(fmtTs(model.state?.lastJudgedAt)) + '</div></div>'
      + '<div class="summary-stat"><div class="summary-k">Warnings</div><div class="summary-v">' + esc(String(model.consecutiveNegative)) + '</div></div>'
      + '</div>');
    if (!latest) {
      supervisorBits.push('<div class="empty-state">No supervisor evaluations yet.</div>');
    } else {
      supervisorBits.push('<div class="primary-text">' + esc(latest.reason || latest.status || 'No supervisor reason recorded.') + '</div>');
      const evaluated = [];
      if (latest.domain) evaluated.push('domain ' + latest.domain);
      if (latest.pattern) evaluated.push('pattern ' + latest.pattern);
      if (latest.action?.summary) evaluated.push(latest.action.summary);
      if (evaluated.length) supervisorBits.push('<div class="secondary-text muted">' + esc(evaluated.join(' · ')) + '</div>');
      const recentEval = model.events.slice(-4).reverse();
      if (recentEval.length > 0) {
        supervisorBits.push('<ul class="list tight">' + recentEval.map((ev) => (
          '<li><span class="mono">' + esc(fmtTs(ev?.ts)) + '</span> · '
          + esc(eventStatusText(ev)) + ' · '
          + esc(ev?.reason || 'No reason recorded.')
          + '</li>'
        )).join('') + '</ul>');
      }
    }
    document.getElementById('activity-supervisor').innerHTML = supervisorBits.join('');

    renderSubconsciousUnified(model);
  }

  function renderDocMeta(targetId, doc, filePath, suffix = '') {
    const el = document.getElementById(targetId);
    if (!el) return;
    const bits = [];
    bits.push('<span class="meta-item mono">' + esc(filePath || '-') + '</span>');
    if (doc?.readError) bits.push('<span class="meta-item">read error: ' + esc(doc.readError) + '</span>');
    else bits.push('<span class="meta-item">' + esc(doc?.exists ? 'present' : 'missing') + '</span>');
    if (suffix) bits.push('<span class="meta-item">' + esc(suffix) + '</span>');
    el.innerHTML = bits.join('');
  }

  function renderDocFrame(targetId, doc, missingMessage) {
    const el = document.getElementById(targetId);
    if (!el) return;
    if (doc?.readError) {
      el.textContent = 'Read failed: ' + doc.readError;
      return;
    }
    if (!doc?.exists) {
      el.textContent = missingMessage;
      return;
    }
    el.textContent = String(doc?.text || '');
  }

  function renderInternals(detail, supervisorStatus, model) {
    const docs = (detail?.docs && typeof detail.docs === 'object') ? detail.docs : {};
    document.getElementById('debug-runtime').innerHTML = kvGrid([
      ['Enabled', supervisorStatus?.enabled],
      ['Interval (ms)', supervisorStatus?.intervalMs],
      ['Model', ((supervisorStatus?.llm?.provider || '-') + ' / ' + (supervisorStatus?.llm?.model || '-'))],
      ['Last sweep', fmtTs(supervisorStatus?.runtime?.lastSweepAt)],
      ['Evaluated(active)', String(toInt(supervisorStatus?.runtime?.lastSweepEvaluated, 0)) + ' / ' + String(toInt(supervisorStatus?.runtime?.lastSweepActive, 0))],
      ['Sweep error', supervisorStatus?.runtime?.lastSweepError || '-'],
    ]);
    document.getElementById('debug-paths').innerHTML = kvGrid([
      ['docsRoot', docs.docsRoot || '-'],
      ['agents.md', docs.agentsPath || '-'],
      ['plan.md', docs.planPath || '-'],
      ['progress.md', docs.progressPath || '-'],
      ['homeDir', detail?.homeDir || '-'],
      ['workdir', detail?.workdir || '-'],
      ['stateDir', detail?.stateDir || '-'],
      ['manifest', detail?.agentJsonPath || '-'],
    ]);
    renderDocMeta('debug-doc-agents-meta', docs.agents, docs.agentsPath);
    renderDocMeta('debug-doc-plan-meta', docs.plan, docs.planPath);
    renderDocMeta('debug-doc-progress-meta', docs.progress, docs.progressPath, (docs.progress?.tailLines ? ('tail ' + docs.progress.tailLines + ' lines') : ''));
    renderDocFrame('debug-doc-agents', docs.agents, 'AGENTS.md not found.');
    renderDocFrame('debug-doc-plan', docs.plan, 'plan.md not found.');
    renderDocFrame('debug-doc-progress', docs.progress, 'progress.md not found.');
    document.getElementById('debug-raw').innerHTML = kvGrid([
      ['path', detail?.path || '-'],
      ['resumeId', detail?.resumeId || '-'],
      ['server', detail?.server || '-'],
      ['model', detail?.model || '-'],
      ['extraArgs', detail?.extraArgs || '-'],
      ['groups', Array.isArray(detail?.groups) && detail.groups.length ? detail.groups.join(', ') : '-'],
      ['agentId', detail?.agentId || '-'],
      ['layoutVersion', detail?.layoutVersion || '-'],
    ]);
  }

  function renderAuditHistory(model) {
    const body = document.getElementById('audit-rows');
    if (!body) return;
    const rows = model.events.slice().reverse();
    if (rows.length === 0) {
      body.innerHTML = '<tr><td colspan="7" class="muted">No events yet.</td></tr>';
      return;
    }
    body.innerHTML = rows.map((ev) => {
      const action = ev?.action ? (ev.action.type + (ev.action.summary ? (' · ' + ev.action.summary) : '')) : '-';
      return '<tr>'
        + '<td>' + esc(fmtTs(ev?.ts)) + '</td>'
        + '<td><span class="status ' + eventStatusClass(ev) + '">' + esc(eventStatusText(ev)) + '</span></td>'
        + '<td>' + esc(ev?.domain || '-') + '</td>'
        + '<td>' + esc(ev?.pattern || '-') + '</td>'
        + '<td>' + esc(ev?.reason || '-') + '</td>'
        + '<td>' + esc(String(ev?.state?.consecutiveNegative ?? '-')) + '</td>'
        + '<td>' + esc(action) + '</td>'
      + '</tr>';
    }).join('');
  }

  async function saveDetailIdentity() {
    if (detailSaveInFlight) return;
    const input = document.getElementById('detail-identity-input');
    if (!input) return;
    detailSaveInFlight = true;
    setDetailStatus('Saving identity...', 'warn');
    try {
      const res = await fetch('/api/agents/' + encodeURIComponent(agent), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity: String(input.value || '').trim() || null }),
      });
      if (!res.ok) throw new Error('identity save failed');
      setDetailStatus('Identity saved.', 'ok');
      detailStatusTimer = setTimeout(() => setDetailStatus('', 'muted'), 2000);
      await refresh(true);
    } catch (e) {
      setDetailStatus('Identity save failed: ' + e.message, 'error');
    } finally {
      detailSaveInFlight = false;
    }
  }

  async function saveDetailOwner() {
    if (detailSaveInFlight) return;
    const ownerEl = document.getElementById('detail-owner');
    if (!ownerEl) return;
    detailSaveInFlight = true;
    setDetailStatus('Saving owner...', 'warn');
    try {
      const res = await fetch('/api/agents/' + encodeURIComponent(agent) + '/home-metadata', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          owner: String(ownerEl.value || '').trim() || null,
        }),
      });
      if (!res.ok) throw new Error('owner save failed');
      setDetailStatus('Owner saved.', 'ok');
      detailStatusTimer = setTimeout(() => setDetailStatus('', 'muted'), 2000);
      await refresh(true);
    } catch (e) {
      setDetailStatus('Owner save failed: ' + e.message, 'error');
    } finally {
      detailSaveInFlight = false;
    }
  }

  async function saveSubconsciousControl() {
    if (detailSaveInFlight) return;
    const subconsciousEl = document.getElementById('detail-subconscious-enabled');
    if (!subconsciousEl) return;
    if (!latestAgentDetail?.v1) {
      setDetailStatus('Subconscious control is read-only here: writable only for V1 home agents.', 'error');
      return;
    }
    detailSaveInFlight = true;
    setDetailStatus('Saving subconscious control...', 'warn');
    try {
      const res = await fetch('/api/agents/' + encodeURIComponent(agent) + '/home-metadata', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subconsciousEnabled: subconsciousEl.checked === true,
        }),
      });
      if (!res.ok) throw new Error('subconscious control save failed');
      setDetailStatus('Subconscious control saved.', 'ok');
      detailStatusTimer = setTimeout(() => setDetailStatus('', 'muted'), 2000);
      await refresh(true);
    } catch (e) {
      setDetailStatus('Subconscious control save failed: ' + e.message, 'error');
    } finally {
      detailSaveInFlight = false;
    }
  }

  async function saveDetailGuidance() {
    if (detailSaveInFlight) return;
    const guidanceEl = document.getElementById('detail-guidance');
    if (!guidanceEl) return;
    if (!latestAgentDetail?.v1) {
      setDetailStatus('Guidance is read-only here: writable only for V1 subconscious state.', 'error');
      return;
    }
    detailSaveInFlight = true;
    setDetailStatus('Saving guidance...', 'warn');
    try {
      const res = await fetch('/api/agents/' + encodeURIComponent(agent) + '/subconscious-guidance', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          guidance: String(guidanceEl.value || '').trim(),
        }),
      });
      if (!res.ok) throw new Error('guidance save failed');
      setDetailStatus('Guidance saved.', 'ok');
      detailStatusTimer = setTimeout(() => setDetailStatus('', 'muted'), 2000);
      await refresh(true);
    } catch (e) {
      setDetailStatus('Guidance save failed: ' + e.message, 'error');
    } finally {
      detailSaveInFlight = false;
    }
  }

  async function saveSubconsciousRuntime() {
    if (detailSaveInFlight) return;
    if (!latestAgentDetail?.v1) {
      setDetailStatus('Subconscious runtime config is read-only here: writable only for V1 subconscious state.', 'error');
      return;
    }
    const enabledEl = document.getElementById('detail-subconscious-runtime-enabled');
    const providerEl = document.getElementById('detail-subconscious-provider');
    const modelEl = document.getElementById('detail-subconscious-model');
    const endpointEl = document.getElementById('detail-subconscious-endpoint');
    const keyEnvEl = document.getElementById('detail-subconscious-key-env');
    if (!enabledEl || !providerEl || !modelEl || !endpointEl || !keyEnvEl) return;
    detailSaveInFlight = true;
    setDetailStatus('Saving subconscious runtime contract...', 'warn');
    try {
      const res = await fetch('/api/agents/' + encodeURIComponent(agent) + '/subconscious-runtime', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: enabledEl.checked === true,
          provider: String(providerEl.value || '').trim(),
          model: String(modelEl.value || '').trim(),
          endpoint: String(endpointEl.value || '').trim(),
          keyEnv: String(keyEnvEl.value || '').trim(),
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || payload?.ok === false) {
        throw new Error((payload && (payload.error || payload.detail)) || 'runtime contract save failed');
      }
      setDetailStatus('Subconscious runtime contract saved.', 'ok');
      detailStatusTimer = setTimeout(() => setDetailStatus('', 'muted'), 2000);
      await refresh(true);
    } catch (e) {
      setDetailStatus('Subconscious runtime contract save failed: ' + e.message, 'error');
    } finally {
      detailSaveInFlight = false;
    }
  }

  async function importManagedProject() {
    if (detailSaveInFlight) return;
    if (!latestAgentDetail?.v1) {
      setDetailStatus('Project import is writable only for V1 home agents.', 'error');
      return;
    }
    const sourceEl = document.getElementById('detail-project-import-source');
    const nameEl = document.getElementById('detail-project-import-name');
    const modeEl = document.getElementById('detail-project-import-mode');
    if (!sourceEl || !nameEl || !modeEl) return;
    const sourcePath = String(sourceEl.value || '').trim();
    if (!sourcePath) {
      setDetailStatus('Project import requires a source path.', 'error');
      return;
    }
    detailSaveInFlight = true;
    setDetailStatus('Importing project into workdir/projects...', 'warn');
    try {
      const res = await fetch('/api/agents/' + encodeURIComponent(agent) + '/projects/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourcePath,
          projectName: String(nameEl.value || '').trim(),
          mode: String(modeEl.value || 'copy').trim().toLowerCase(),
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || payload?.ok === false) {
        throw new Error((payload && (payload.error || payload.detail)) || 'project import failed');
      }
      const importedName = payload?.importedProject?.name || '(project)';
      const materialization = payload?.materialization || 'updated';
      setDetailStatus('Project imported: ' + importedName + ' (' + materialization + ').', 'ok');
      detailStatusTimer = setTimeout(() => setDetailStatus('', 'muted'), 2500);
      await refresh(true);
    } catch (e) {
      setDetailStatus('Project import failed: ' + e.message, 'error');
    } finally {
      detailSaveInFlight = false;
    }
  }

  async function removeManagedProject(projectName, projectPath, deleteFiles) {
    if (detailSaveInFlight) return;
    if (!latestAgentDetail?.v1) {
      setDetailStatus('Managed-project removal is writable only for V1 home agents.', 'error');
      return;
    }
    const confirmCopy = deleteFiles
      ? ('Remove ' + (projectName || '(project)') + ' from managedProjects and delete its local path under workdir/projects?')
      : ('Untrack ' + (projectName || '(project)') + ' from managedProjects but keep the current files on disk?');
    if (!window.confirm(confirmCopy)) return;
    detailSaveInFlight = true;
    setDetailStatus(deleteFiles ? 'Removing project from this home...' : 'Removing project from managedProjects...', 'warn');
    try {
      const res = await fetch('/api/agents/' + encodeURIComponent(agent) + '/projects/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectName,
          projectPath,
          deleteFiles: deleteFiles === true,
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || payload?.ok === false) {
        throw new Error((payload && (payload.error || payload.detail)) || 'project removal failed');
      }
      const fileAction = payload?.fileAction ? (' [' + payload.fileAction + ']') : '';
      setDetailStatus((deleteFiles ? 'Project removed from this home: ' : 'Project untracked: ') + (projectName || '(project)') + fileAction + '.', 'ok');
      detailStatusTimer = setTimeout(() => setDetailStatus('', 'muted'), 2500);
      await refresh(true);
    } catch (e) {
      setDetailStatus('Project removal failed: ' + e.message, 'error');
    } finally {
      detailSaveInFlight = false;
    }
  }

  async function migrateWorkspaceEntryFiles() {
    if (detailSaveInFlight) return;
    if (!latestAgentDetail?.v1) {
      setDetailStatus('Workspace entry migration is writable only for V1 home agents.', 'error');
      return;
    }
    detailSaveInFlight = true;
    setDetailStatus('Migrating workspace entry files...', 'warn');
    try {
      const res = await fetch('/api/agents/' + encodeURIComponent(agent) + '/workspace/migrate-entry-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || payload?.ok === false) {
        throw new Error((payload && (payload.error || payload.detail)) || 'workspace migration failed');
      }
      const sync = payload?.workspaceSync || {};
      const summary = [
        sync.agentsRootStatus ? ('root AGENTS ' + sync.agentsRootStatus) : null,
        sync.docsAgentsStatus ? ('docs/AGENTS ' + sync.docsAgentsStatus) : null,
      ].filter(Boolean).join(', ');
      setDetailStatus('Workspace entry migration completed.' + (summary ? ' ' + summary + '.' : ''), 'ok');
      detailStatusTimer = setTimeout(() => setDetailStatus('', 'muted'), 3000);
      await refresh(true);
    } catch (e) {
      setDetailStatus('Workspace entry migration failed: ' + e.message, 'error');
    } finally {
      detailSaveInFlight = false;
    }
  }

  async function saveSupervisorAuditControl() {
    if (detailSaveInFlight) return;
    const supervisorEl = document.getElementById('detail-supervisor-enabled');
    if (!supervisorEl) return;
    detailSaveInFlight = true;
    setDetailStatus('Saving supervisor audit control...', 'warn');
    try {
      const res = await fetch('/api/supervisor/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: supervisorEl.checked === true }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || payload?.ok === false) {
        throw new Error((payload && (payload.error || payload.detail)) || 'supervisor control save failed');
      }
      setDetailStatus('Supervisor audit control saved.', 'ok');
      detailStatusTimer = setTimeout(() => setDetailStatus('', 'muted'), 2000);
      await refresh(true);
    } catch (e) {
      setDetailStatus('Supervisor audit control save failed: ' + e.message, 'error');
    } finally {
      detailSaveInFlight = false;
    }
  }

  const CFG_VALID_FRAMEWORKS = ['claude', 'codex'];
  const CFG_SHELL_METACHAR_RE = /[;&|\x60$(){}!\\\\<>]/;

  function sanitizeExtraArgs(raw) {
    if (!raw) return null;
    const cleaned = String(raw).trim();
    if (!cleaned) return null;
    if (CFG_SHELL_METACHAR_RE.test(cleaned)) return '__REJECTED__';
    return cleaned;
  }

  function onPresetChange(prefix) {
    const sel = document.getElementById('cfg-' + prefix + '-preset');
    const custom = document.getElementById('cfg-' + prefix + '-custom');
    if (!sel || !custom) return;
    if (sel.value === '__custom__') {
      custom.style.display = '';
    } else {
      custom.style.display = 'none';
      if (!sel.value) {
        const fw = document.getElementById('cfg-' + prefix + '-framework');
        const pv = document.getElementById('cfg-' + prefix + '-provider');
        const md = document.getElementById('cfg-' + prefix + '-model');
        const rs = document.getElementById('cfg-' + prefix + '-reasoning');
        const ea = document.getElementById('cfg-' + prefix + '-extraArgs');
        if (fw) fw.value = '';
        if (pv) pv.value = '';
        if (md) md.value = '';
        if (rs) rs.value = '';
        if (ea) ea.value = '';
      }
      const p = _presetCache.find(pp => pp.id === sel.value);
      if (p) {
        const fw = document.getElementById('cfg-' + prefix + '-framework');
        const pv = document.getElementById('cfg-' + prefix + '-provider');
        const md = document.getElementById('cfg-' + prefix + '-model');
        const rs = document.getElementById('cfg-' + prefix + '-reasoning');
        const ea = document.getElementById('cfg-' + prefix + '-extraArgs');
        if (fw) fw.value = p.framework || '';
        if (pv) pv.value = p.provider || '';
        if (md) md.value = p.model || '';
        if (rs) rs.value = p.reasoning || '';
        if (ea) ea.value = p.extraArgs || '';
      }
    }
  }
  window.onPresetChange = onPresetChange;

  async function createPreset() {
    const name = ((document.getElementById('preset-name') || {}).value || '').trim();
    if (!name) { setDetailStatus('Preset name is required.', 'error'); return; }
    const body = {
      name,
      framework: ((document.getElementById('preset-framework') || {}).value || '').trim() || null,
      provider: 'anthropic',
      model: ((document.getElementById('preset-model') || {}).value || '').trim() || null,
      reasoning: ((document.getElementById('preset-reasoning') || {}).value || '').trim() || null,
      extraArgs: ((document.getElementById('preset-extraArgs') || {}).value || '').trim() || null,
    };
    try {
      const r = await fetch('/api/framework-presets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'create failed');
      setDetailStatus('Preset created: ' + (data.preset?.name || ''), 'ok');
      detailStatusTimer = setTimeout(() => setDetailStatus('', 'muted'), 2000);
      await refresh(true);
    } catch (e) { setDetailStatus('Preset create failed: ' + e.message, 'error'); }
  }

  async function deletePreset(id) {
    if (!confirm('Delete this preset?')) return;
    try {
      const r = await fetch('/api/framework-presets/' + encodeURIComponent(id), { method: 'DELETE' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'delete failed');
      setDetailStatus('Preset deleted.', 'ok');
      detailStatusTimer = setTimeout(() => setDetailStatus('', 'muted'), 2000);
      await refresh(true);
    } catch (e) { setDetailStatus('Preset delete failed: ' + e.message, 'error'); }
  }

  window.createPreset = createPreset;
  window.deletePreset = deletePreset;

  function resolveRoleFromUI(prefix) {
    const presetSel = document.getElementById('cfg-' + prefix + '-preset');
    const presetId = presetSel ? presetSel.value : '';
    if (!presetId) return null;
    if (presetId !== '__custom__') {
      const p = _presetCache.find(pp => pp.id === presetId);
      if (p) return { framework: p.framework, provider: p.provider, model: p.model, reasoning: p.reasoning, extraArgs: p.extraArgs || null, apiBaseUrl: p.apiBaseUrl || null };
    }
    const framework = ((document.getElementById('cfg-' + prefix + '-framework') || {}).value || '').trim() || null;
    const provider = ((document.getElementById('cfg-' + prefix + '-provider') || {}).value || '').trim() || null;
    const model = ((document.getElementById('cfg-' + prefix + '-model') || {}).value || '').trim() || null;
    const reasoning = ((document.getElementById('cfg-' + prefix + '-reasoning') || {}).value || '').trim() || null;
    const extraArgs = sanitizeExtraArgs(((document.getElementById('cfg-' + prefix + '-extraArgs') || {}).value));
    if (extraArgs === '__REJECTED__') return '__REJECTED__';
    if (!framework && !provider && !model && !reasoning && !extraArgs) return null;
    if (framework && !CFG_VALID_FRAMEWORKS.includes(framework)) return '__INVALID_FW__';
    return { framework, provider, model, reasoning, extraArgs };
  }

  async function saveDetailConfiguration() {
    if (detailSaveInFlight) return;

    const primary = resolveRoleFromUI('primary');
    const supervisor = resolveRoleFromUI('supervisor');
    if (primary === '__REJECTED__' || supervisor === '__REJECTED__') {
      setDetailStatus('extraArgs contains disallowed shell characters. Only CLI flags are allowed.', 'error');
      return;
    }
    if (primary === '__INVALID_FW__') { setDetailStatus('Invalid primary framework — must be claude or codex.', 'error'); return; }
    if (supervisor === '__INVALID_FW__') { setDetailStatus('Invalid supervisor framework — must be claude or codex.', 'error'); return; }

    const runtimeProfile = (primary || supervisor) ? { primary: primary || null, supervisor: supervisor || null } : null;
    const role = ((document.getElementById('cfg-role') || {}).value || '').trim() || null;

    detailSaveInFlight = true;
    setDetailStatus('Saving configuration...', 'warn');
    try {
      const body = {};
      if (role !== undefined) body.role = role;
      body.runtimeProfile = runtimeProfile;
      const res = await fetch('/api/agents/' + encodeURIComponent(agent), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) throw new Error(data?.error || 'configuration save failed');
      setDetailStatus('Configuration saved.', 'ok');
      detailStatusTimer = setTimeout(() => setDetailStatus('', 'muted'), 3000);
      const banner = document.getElementById('cfg-restart-banner');
      if (banner) banner.style.display = '';
      await refresh(true);
    } catch (e) {
      setDetailStatus('Configuration save failed: ' + e.message, 'error');
    } finally {
      detailSaveInFlight = false;
    }
  }

  window.saveDetailIdentity = saveDetailIdentity;
  window.saveDetailOwner = saveDetailOwner;
  window.importManagedProject = importManagedProject;
  window.removeManagedProject = removeManagedProject;
  window.migrateWorkspaceEntryFiles = migrateWorkspaceEntryFiles;
  window.saveSubconsciousControl = saveSubconsciousControl;
  window.saveDetailGuidance = saveDetailGuidance;
  window.saveSupervisorAuditControl = saveSupervisorAuditControl;
  window.saveDetailConfiguration = saveDetailConfiguration;
  window.saveSubconsciousRuntime = saveSubconsciousRuntime;

  // ── Task list (minimal Jira) ──────────────────────────────────────
  let taskListCache = [];
  let taskDetailViewId = null;

  function fmtTaskTime(iso) {
    if (!iso) return '-';
    try { return new Date(iso).toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }); }
    catch { return iso; }
  }

  async function taskListRefresh() {
    const root = document.getElementById('task-list-root');
    if (!root) return;
    const filterEl = document.getElementById('task-filter-assignee');
    // Restore persisted filter on first load
    if (filterEl && !filterEl._initialized) {
      filterEl._initialized = true;
      const urlAssignee = new URL(window.location).searchParams.get('assignee');
      const saved = urlAssignee || sessionStorage.getItem('task_filter_assignee');
      if (saved) filterEl.value = saved;
      filterEl.addEventListener('change', () => {
        filterEl._userOverride = true;
        sessionStorage.setItem('task_filter_assignee', filterEl.value);
        const u = new URL(window.location);
        if (filterEl.value) u.searchParams.set('assignee', filterEl.value);
        else u.searchParams.delete('assignee');
        history.replaceState(null, '', u);
      });
    }
    // Fall back to URL param / sessionStorage when dropdown value is empty
    // (options not yet populated on first load — race condition)
    let filterVal = filterEl ? filterEl.value : '';
    if (!filterVal && filterEl) {
      const urlAssignee = new URL(window.location).searchParams.get('assignee');
      const saved = urlAssignee || sessionStorage.getItem('task_filter_assignee') || '';
      if (saved) filterVal = saved;
    }
    try {
      const url = filterVal ? '/api/tasks?assignee=' + encodeURIComponent(filterVal) : '/api/tasks';
      const r = await fetch(url);
      if (!r.ok) throw new Error('status ' + r.status);
      taskListCache = await r.json();
    } catch (e) {
      root.innerHTML = '<div class="error-state">Failed to load tasks: ' + esc(e.message) + '</div>';
      return;
    }
    // Populate agent filter dropdown from task assignees + agents list
    if (filterEl && !filterEl._populated) {
      filterEl._populated = true;
      try {
        const ar = await fetch('/api/agents/all');
        if (ar.ok) {
          const agents = await ar.json();
          const names = new Set();
          for (const a of (Array.isArray(agents) ? agents : [])) { if (a.name) names.add(a.name); }
          for (const t of taskListCache) { if (t.assignee) names.add(t.assignee); }
          const sorted = [...names].sort();
          for (const n of sorted) {
            const opt = document.createElement('option');
            opt.value = n;
            opt.textContent = n;
            filterEl.appendChild(opt);
          }
          // Re-apply saved filter now that options exist
          if (filterVal) filterEl.value = filterVal;
        }
      } catch (_) { /* non-critical */ }
    }
    if (taskDetailViewId) {
      const found = taskListCache.find(t => t.id === taskDetailViewId);
      if (found) { renderTaskDetail(found); return; }
      taskDetailViewId = null;
    }
    renderTaskList();
  }

  function renderTaskList() {
    const root = document.getElementById('task-list-root');
    const detailPanel = document.getElementById('task-detail-panel');
    if (detailPanel) detailPanel.classList.add('hidden');
    if (!root) return;
    if (!taskListCache.length) {
      root.innerHTML = '<div class="task-empty-state">No tasks yet. Create one above.</div>';
      return;
    }
    const sorted = [...taskListCache].sort((a, b) => {
      const po = { p0:0, p1:1, p2:2, p3:3 };
      const so = { in_progress:0, accepted:1, blocked:2, created:3, done:4 };
      const sd = (so[a.status] ?? 5) - (so[b.status] ?? 5);
      if (sd !== 0) return sd;
      const pd = (po[a.priority] ?? 2) - (po[b.priority] ?? 2);
      if (pd !== 0) return pd;
      return (b.created_at || '').localeCompare(a.created_at || '');
    });
    let html = '<table class="task-list-table"><thead><tr>'
      + '<th>Status</th><th>Pri</th><th>Title</th><th>Assignee</th><th>Comments</th><th>Created</th>'
      + '</tr></thead><tbody>';
    for (const t of sorted) {
      const cc = Array.isArray(t.comments) ? t.comments.length : 0;
      html += '<tr onclick="taskShowDetail(\\'' + esc(t.id) + '\\')">'
        + '<td><span class="task-status-badge task-status-' + esc(t.status) + '">' + esc(t.status) + '</span></td>'
        + '<td><span class="task-priority-badge task-priority-' + esc(t.priority) + '">' + esc(t.priority || 'p2').toUpperCase() + '</span></td>'
        + '<td>' + esc(t.title || '-') + '</td>'
        + '<td>' + esc(t.assignee || '-') + '</td>'
        + '<td>' + (cc > 0 ? cc : '-') + '</td>'
        + '<td>' + esc(fmtTaskTime(t.created_at)) + '</td>'
        + '</tr>';
    }
    html += '</tbody></table>';
    root.innerHTML = html;
  }

  function renderTaskDetail(task) {
    const detailPanel = document.getElementById('task-detail-panel');
    const root = document.getElementById('task-detail-root');
    if (!detailPanel || !root) return;
    detailPanel.classList.remove('hidden');
    taskDetailViewId = task.id;
    const statusOptions = ['created','accepted','in_progress','blocked','done'];
    let html = '<span class="task-detail-back" onclick="taskBackToList()">&#8592; Back to list</span>'
      + '<div class="task-detail-title">' + esc(task.title || 'Untitled') + '</div>'
      + '<div class="task-detail-meta">'
      + '<strong>ID:</strong> ' + esc(task.id) + ' &middot; '
      + '<strong>Priority:</strong> <span class="task-priority-badge task-priority-' + esc(task.priority) + '">' + esc((task.priority || 'p2').toUpperCase()) + '</span> &middot; '
      + '<strong>Assignee:</strong> ' + esc(task.assignee || 'unassigned') + ' &middot; '
      + '<strong>Created:</strong> ' + esc(fmtTaskTime(task.created_at))
      + '</div>'
      + '<div class="task-detail-meta">'
      + '<strong>Status:</strong> <select class="task-status-select" id="task-detail-status" onchange="taskChangeStatus(\\'' + esc(task.id) + '\\')">';
    for (const s of statusOptions) {
      html += '<option value="' + s + '"' + (task.status === s ? ' selected' : '') + '>' + s + '</option>';
    }
    html += '</select></div>';
    if (task.description) {
      html += '<div class="task-detail-desc">' + esc(task.description) + '</div>';
    }
    if (task.waiting_reason) {
      html += '<div class="task-detail-meta"><strong>Waiting:</strong> ' + esc(task.waiting_reason)
        + (task.waiting_until ? ' (until ' + esc(task.waiting_until) + ')' : '') + '</div>';
    }
    // Comments section
    const comments = Array.isArray(task.comments) ? task.comments : [];
    html += '<div class="task-comments">'
      + '<div class="field-label">Comments (' + comments.length + ')</div>';
    if (comments.length === 0) {
      html += '<div class="task-empty-state" style="padding:8px 0">No comments yet.</div>';
    } else {
      for (const c of comments) {
        html += '<div class="task-comment">'
          + '<div class="task-comment-meta">' + esc(c.author || 'anonymous') + ' &middot; ' + esc(fmtTaskTime(c.ts)) + '</div>'
          + '<div class="task-comment-text">' + esc(c.text) + '</div>'
          + '</div>';
      }
    }
    html += '<div class="task-comment-form">'
      + '<textarea id="task-comment-input" class="detail-textarea" placeholder="Add a comment..."></textarea>'
      + '<button class="detail-save" onclick="taskAddComment(\\'' + esc(task.id) + '\\')">Post</button>'
      + '</div></div>';
    // Delete button
    html += '<div class="detail-actions" style="margin-top:14px">'
      + '<button class="detail-save" style="background:rgba(255,100,100,0.1);border-color:rgba(255,100,100,0.3);color:rgba(255,140,140,0.9)" onclick="taskDelete(\\'' + esc(task.id) + '\\')">Delete Task</button>'
      + '</div>';
    root.innerHTML = html;
  }

  function taskBackToList() {
    taskDetailViewId = null;
    renderTaskList();
  }

  function taskShowDetail(id) {
    const task = taskListCache.find(t => t.id === id);
    if (task) renderTaskDetail(task);
  }

  async function taskCreateSubmit() {
    const titleEl = document.getElementById('task-create-title');
    const prioEl = document.getElementById('task-create-priority');
    const assigneeEl = document.getElementById('task-create-assignee');
    const statusEl = document.getElementById('task-create-status');
    if (!titleEl || !prioEl) return;
    const title = titleEl.value.trim();
    if (!title) { if (statusEl) statusEl.textContent = 'Title is required.'; return; }
    try {
      const body = { title, priority: prioEl.value };
      const assignee = (assigneeEl?.value || '').trim();
      if (assignee) body.assignee = assignee;
      const r = await fetch('/api/tasks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'create failed');
      titleEl.value = '';
      if (assigneeEl) assigneeEl.value = agent;
      if (statusEl) { statusEl.textContent = 'Created: ' + (data.task?.id || ''); setTimeout(() => statusEl.textContent = '', 3000); }
      taskListRefresh();
    } catch (e) {
      if (statusEl) statusEl.textContent = 'Error: ' + e.message;
    }
  }

  async function taskChangeStatus(id) {
    const sel = document.getElementById('task-detail-status');
    if (!sel) return;
    try {
      const r = await fetch('/api/tasks/' + encodeURIComponent(id) + '/transition', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: sel.value }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'transition failed');
      taskListRefresh();
    } catch (e) {
      alert('Status change failed: ' + e.message);
    }
  }

  async function taskAddComment(id) {
    const input = document.getElementById('task-comment-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    try {
      const r = await fetch('/api/tasks/' + encodeURIComponent(id) + '/comments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, author: 'operator' }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'comment failed');
      taskListRefresh();
    } catch (e) {
      alert('Comment failed: ' + e.message);
    }
  }

  async function taskDelete(id) {
    if (!confirm('Delete task ' + id + '?')) return;
    try {
      const r = await fetch('/api/tasks/' + encodeURIComponent(id), { method: 'DELETE' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'delete failed');
      taskDetailViewId = null;
      taskListRefresh();
    } catch (e) {
      alert('Delete failed: ' + e.message);
    }
  }

  window.taskListRefresh = taskListRefresh;
  window.taskCreateSubmit = taskCreateSubmit;
  window.taskShowDetail = taskShowDetail;
  window.taskBackToList = taskBackToList;
  window.taskChangeStatus = taskChangeStatus;
  window.taskAddComment = taskAddComment;
  window.taskDelete = taskDelete;

  async function refresh(forceDetailRender = false) {
    try {
      const [statusRes, detailRes, controlRes, subconsciousRes, subconsciousDetailRes, agentDetailRes, agentStatusRes, unreadRes, queueRes, presetsRes] = await Promise.all([
        fetch('/api/supervisor/status'),
        fetch('/api/supervisor/agents/' + encodeURIComponent(agent) + '?limit=180'),
        fetch('/api/supervisor/control'),
        fetch('/api/subconscious/events/' + encodeURIComponent(agent) + '?limit=40'),
        fetch('/api/subconscious/detail/' + encodeURIComponent(agent)),
        fetch('/api/agents/detail/' + encodeURIComponent(agent)),
        fetch('/api/agents/status'),
        fetch('/api/agents/' + encodeURIComponent(agent) + '/unread-messages?limit=40'),
        fetch('/api/queue'),
        fetch('/api/framework-presets'),
      ]);
      const statusPayload = await statusRes.json();
      const detail = await detailRes.json();
      const supervisorControlPayload = await controlRes.json().catch(() => ({}));
      const subconsciousPayload = await subconsciousRes.json().catch(() => ({ ok: false, events: [] }));
      const subconsciousDetailPayload = await subconsciousDetailRes.json().catch(() => ({ ok: false, stage: 'unknown' }));
      const agentDetailPayload = await agentDetailRes.json().catch(() => ({ error: 'agent detail unavailable' }));
      const agentStatusPayload = await agentStatusRes.json().catch(() => []);
      const unreadPayload = await unreadRes.json().catch(() => ({ unread_total: 0, messages: [] }));
      const queuePayload = await queueRes.json().catch(() => []);
      const presetsPayload = await presetsRes.json().catch(() => []);
      _presetCache = Array.isArray(presetsPayload) ? presetsPayload : [];
      if (!statusRes.ok || !detailRes.ok) throw new Error((detail && detail.error) || 'load failed');
      const statusRows = Array.isArray(agentStatusPayload) ? agentStatusPayload : [];
      const statusRow = statusRows.find((row) => row && row.name === agent) || null;
      const model = buildPageModel(
        agentDetailPayload,
        statusRow,
        detail,
        statusPayload,
        supervisorControlPayload,
        subconsciousPayload,
        subconsciousDetailPayload,
        unreadPayload,
        Array.isArray(queuePayload) ? queuePayload : [],
        statusRows
      );
      const shouldPreserveDirty = !forceDetailRender && hasUnsavedDetailChanges(agentDetailPayload, supervisorControlPayload, subconsciousDetailPayload);
      latestAgentDetail = agentDetailPayload;
      latestSupervisorDetail = detail;
      latestSupervisorControl = supervisorControlPayload;
      latestSupervisorStatus = statusPayload;
      latestSubconsciousPayload = subconsciousPayload;
      latestSubconsciousDetail = subconsciousDetailPayload;
      latestUnreadPayload = unreadPayload;
      latestQueueItems = Array.isArray(queuePayload) ? queuePayload : [];

      renderHeader(agentDetailPayload, model);
      renderCurrentWork(model);
      renderIntervention(model);
      renderOverview(agentDetailPayload, model);
      renderActivity(model);
      renderAuditHistory(model);
      renderInternals(agentDetailPayload, statusPayload, model);
      if (!shouldPreserveDirty) renderSettings(agentDetailPayload, model);
      else setDetailStatus('Unsaved changes in Agent Detail.', 'warn');
      syncStickyOffsets();
      if (activeTab === 'dm' && dmLoaded) loadDmHistory();
    } catch (e) {
      const healthEl = document.getElementById('health-summary');
      healthEl.textContent = 'Load failed: ' + e.message;
      healthEl.classList.add('health-error');
      document.getElementById('current-work-main').textContent = 'Load failed';
      document.getElementById('current-work-main').style.color = 'rgba(248,113,113,0.85)';
      document.getElementById('current-work-reason').textContent = e.message;
      document.getElementById('intervention-main').textContent = 'Data unavailable';
      document.getElementById('intervention-main').style.color = 'rgba(248,113,113,0.85)';
      document.getElementById('intervention-body').textContent = e.message;
    }
  }

  function requestDangerAction(mode) {
    dangerMode = mode;
    const title = document.getElementById('confirm-title');
    const copy = document.getElementById('confirm-copy');
    const cta = document.getElementById('confirm-cta');
    if (mode === 'down') {
      title.textContent = 'Stop Agent';
      copy.textContent = 'This will stop the agent session and mark it offline. Continue?';
      cta.textContent = 'Stop Agent';
    } else {
      title.textContent = 'Remove Agent';
      copy.textContent = 'This permanently removes the agent entry. This cannot be undone.';
      cta.textContent = 'Remove Agent';
    }
    document.getElementById('confirm-modal').classList.remove('hidden');
  }

  function closeDangerModal() {
    dangerMode = null;
    document.getElementById('confirm-modal').classList.add('hidden');
  }

  async function confirmDangerAction() {
    if (!dangerMode) return;
    const cta = document.getElementById('confirm-cta');
    cta.disabled = true;
    try {
      if (dangerMode === 'down') {
        const res = await fetch('/api/agents/' + encodeURIComponent(agent) + '/down', { method: 'POST' });
        const payload = await res.json().catch(() => null);
        if (!res.ok || !payload?.ok) throw new Error((payload && (payload.detail || payload.error)) || 'agent down failed');
        setDetailStatus('Agent stopped. Returning to monitor…', 'ok');
      } else {
        const res = await fetch('/api/agents/' + encodeURIComponent(agent) + '?force=true', { method: 'DELETE' });
        const payload = await res.json().catch(() => null);
        if (!res.ok || !payload?.ok) throw new Error((payload && (payload.detail || payload.error)) || 'remove failed');
        setDetailStatus('Agent removed. Returning to monitor…', 'ok');
      }
      closeDangerModal();
      setTimeout(() => { window.location.href = '/'; }, 650);
    } catch (e) {
      setDetailStatus('Action failed: ' + e.message, 'error');
    } finally {
      cta.disabled = false;
    }
  }

  window.requestDangerAction = requestDangerAction;
  window.closeDangerModal = closeDangerModal;
  window.confirmDangerAction = confirmDangerAction;
  window.sendDm = sendDm;

  window.addEventListener('hashchange', () => {
    const next = hashToTab(window.location.hash);
    setActiveTab(next, { updateHash: false, focusAudit: window.location.hash === '#audit' });
  });
  window.addEventListener('resize', syncStickyOffsets);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDangerModal();
  });

  // ── SSE for real-time DM sync across tabs/devices ────
  {
    const es = new EventSource('/api/stream');
    es.addEventListener('message', (e) => {
      try {
        const msg = JSON.parse(e.data);
        // Only refresh DM if the message involves this agent
        if (dmLoaded && (msg.to === agent || msg.from === agent) && !msg.group) {
          loadDmHistory();
        }
      } catch {}
    });
  }

  setActiveTab(hashToTab(window.location.hash), {
    updateHash: false,
    focusAudit: window.location.hash === '#audit',
  });
  syncStickyOffsets();
  refresh();
  setInterval(refresh, 5000);
})();
</script>
</body>
</html>`;
}
