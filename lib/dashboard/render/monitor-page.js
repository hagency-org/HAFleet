export function renderMonitorPage({ idleThreshold, idleThresholdSec }) {
  return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Agent Monitor</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><circle cx='32' cy='32' r='24' fill='none' stroke='%2300f0ff' stroke-width='3'/><circle cx='32' cy='32' r='6' fill='%2300f0ff'/></svg>"/>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;overflow:hidden;background:#060a12;font-family:'SF Mono','Fira Code','Consolas',monospace;overscroll-behavior:none}

/* Layout */
#app{display:flex;flex-direction:column;height:100vh;overflow:hidden}
#main-row{display:flex;flex:1;min-height:0;padding:12px;gap:12px}

/* Queue panel (left) — always reserves width */
#queue-panel{
  width:280px;flex-shrink:0;overflow-y:auto;
  display:flex;flex-direction:column;
  border-radius:8px;
  scrollbar-width:thin;scrollbar-color:rgba(168,85,247,0.15) transparent;
}
#queue-panel.has-items{
  background:rgba(6,10,18,0.88);
  border:1px solid rgba(168,85,247,0.2);
  backdrop-filter:blur(12px);
}
.panel-header{
  padding:10px 14px;font-size:10px;letter-spacing:2px;
  color:rgba(168,85,247,0.6);
  border-bottom:1px solid rgba(168,85,247,0.1);
  display:flex;align-items:center;gap:8px;flex-shrink:0;
}
.panel-header .dot{
  width:6px;height:6px;border-radius:50%;background:#a855f7;
  animation:pulse-dot 2s infinite;
}
@keyframes pulse-dot{
  0%,100%{opacity:0.4;box-shadow:none}
  50%{opacity:1;box-shadow:0 0 8px #a855f7}
}
.queue-item{padding:10px 14px;border-bottom:1px solid rgba(168,85,247,0.06);transition:background 0.2s;overflow:hidden;min-width:0}
.queue-item:hover{background:rgba(168,85,247,0.05)}
.queue-item:last-child{border-bottom:none}
.qi-route{font-size:11px;margin-bottom:3px}
.qi-from{color:rgba(0,240,255,0.6)}
.qi-arrow{color:rgba(168,85,247,0.3);margin:0 4px}
.qi-target{color:#a855f7}
.qi-payload{font-size:10px;color:rgba(255,255,255,0.2);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.qi-wait{font-size:10px;color:rgba(168,85,247,0.3);margin-top:3px}
.qi-idle{font-size:10px;margin-top:2px}
.qi-idle-busy{color:rgba(251,191,36,0.5)}
.qi-idle-ready{color:rgba(52,211,153,0.6)}
.qi-idle-warn{color:rgba(248,113,113,0.5)}
.qi-redir{color:rgba(251,191,36,0.5);font-size:9px}
.qi-actions{margin-top:6px;display:flex;gap:6px}
.qi-btn{font-family:inherit;letter-spacing:1px;border-radius:4px;cursor:pointer;border:1px solid;transition:all .2s;background:transparent}
.qi-btn-send{font-size:10px;padding:4px 14px;color:#34d399;border-color:rgba(52,211,153,0.4);font-weight:600}
.qi-btn-send:hover{background:rgba(52,211,153,0.15);border-color:#34d399}
.qi-btn-cancel{font-size:8px;padding:2px 8px;color:rgba(248,113,113,0.45);border-color:rgba(248,113,113,0.15)}
.qi-btn-cancel:hover{background:rgba(248,113,113,0.08);border-color:rgba(248,113,113,0.35);color:#f87171}

/* Reminder panel (right) */
#right-col{
  width:280px;flex-shrink:0;display:flex;flex-direction:column;gap:8px;min-height:0;
}
#reminder-panel{
  overflow-y:auto;
  display:flex;flex-direction:column;
  border-radius:8px;min-height:0;max-height:100%;
  scrollbar-width:thin;scrollbar-color:rgba(251,191,36,0.15) transparent;
}
#reminder-panel.has-items{
  background:rgba(6,10,18,0.88);
  border:1px solid rgba(251,191,36,0.2);
  backdrop-filter:blur(12px);
}
.reminder-header{
  padding:10px 14px;font-size:10px;letter-spacing:2px;
  color:rgba(251,191,36,0.6);
  border-bottom:1px solid rgba(251,191,36,0.1);
  display:flex;align-items:center;gap:8px;flex-shrink:0;
}
.reminder-header .dot{width:6px;height:6px;border-radius:50%;background:#fbbf24;animation:pulse-dot-r 2s infinite}
@keyframes pulse-dot-r{0%,100%{opacity:0.4;box-shadow:none}50%{opacity:1;box-shadow:0 0 8px #fbbf24}}
.reminder-item{padding:10px 14px;border-bottom:1px solid rgba(251,191,36,0.06);transition:background 0.2s;overflow:hidden;min-width:0}
.reminder-item:hover{background:rgba(251,191,36,0.05)}
.reminder-item:last-child{border-bottom:none}
.ri-target{font-size:11px;color:#fbbf24}
.ri-msg{font-size:10px;color:rgba(255,255,255,0.25);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.ri-countdown{font-size:12px;color:rgba(251,191,36,0.7);margin-top:4px;font-weight:bold}
.ri-created{font-size:9px;color:rgba(251,191,36,0.25);margin-top:2px}
.ri-actions{margin-top:6px}
.ri-btn-cancel{font-family:inherit;font-size:9px;letter-spacing:1px;padding:3px 10px;border-radius:4px;cursor:pointer;border:1px solid rgba(248,113,113,0.3);color:#f87171;background:transparent;transition:all .2s}
.ri-btn-cancel:hover{background:rgba(248,113,113,0.12);border-color:#f87171}

/* Center monitor panel */
#monitor-panel{
  flex:1;min-width:0;
  display:flex;flex-direction:column;
  background:linear-gradient(170deg,rgba(8,14,22,0.85) 0%,rgba(4,8,14,0.9) 50%,rgba(6,12,18,0.85) 100%);
  border:1px solid rgba(0,240,255,0.15);border-radius:10px;
  overflow:hidden;
  box-shadow:0 0 30px rgba(0,240,255,0.04),0 0 60px rgba(0,240,255,0.02),inset 0 1px 0 rgba(0,240,255,0.06);
}
.monitor-header{
  padding:10px 24px;
  border-bottom:1px solid rgba(0,240,255,0.08);
  font-size:10px;letter-spacing:3px;color:rgba(0,240,255,0.5);
  flex-shrink:0;
  text-shadow:0 0 8px rgba(0,240,255,0.15);
}
#agent-buttons-wrap{
  position:relative;flex-shrink:0;
  border-bottom:1px solid rgba(0,240,255,0.08);
}
#agent-buttons{
  padding:10px 24px;display:flex;flex-wrap:wrap;gap:8px;
  overflow:hidden;transition:max-height .25s ease;
}
#agent-toggle{
  position:absolute;right:10px;bottom:4px;
  background:rgba(10,14,20,0.85);border:1px solid rgba(0,240,255,0.15);border-radius:4px;
  color:rgba(0,240,255,0.5);font-size:10px;padding:1px 8px;cursor:pointer;
  font-family:inherit;z-index:2;transition:all .2s;
}
#agent-toggle:hover{color:#00f0ff;border-color:rgba(0,240,255,0.3)}
.agent-btn{
  display:inline-flex;align-items:center;gap:6px;
  padding:5px 12px;border-radius:6px;cursor:pointer;
  font-family:inherit;font-size:11px;
  border:1px solid rgba(0,240,255,0.15);
  background:rgba(0,240,255,0.04);color:rgba(0,240,255,0.5);
  transition:all .2s;
}
.agent-btn:hover{background:rgba(0,240,255,0.10);border-color:rgba(0,240,255,0.3);color:#00f0ff}
.agent-btn.selected{background:rgba(0,240,255,0.12);border-color:#00f0ff;color:#00f0ff}
.agent-btn.active-agent .dot{color:#34d399}
.agent-btn.inactive-agent .dot{color:rgba(255,255,255,0.15)}
.agent-btn.remote-agent .dot{color:#a78bfa;font-size:9px}
.agent-btn.remote-agent.alive{opacity:1}
.agent-btn.remote-agent:not(.alive){opacity:0.45}
.agent-btn.no-tmux{opacity:0.35;cursor:default}
.agent-group{width:100%;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.agent-group-label{width:100%;font-size:9px;letter-spacing:1.5px;color:rgba(0,240,255,0.25);text-transform:uppercase;padding:2px 0 0 2px;margin-top:4px}
.agent-group-label:first-child{margin-top:0}
.agent-group-label .agent-group-count{font-size:8px;color:rgba(0,240,255,0.15);letter-spacing:0;text-transform:none;margin-left:6px}
.monitor-bar{
  display:flex;align-items:center;justify-content:space-between;
  padding:8px 24px;margin:5px 0 0 0;
  border-bottom:1px solid rgba(0,240,255,0.08);
  font-size:11px;color:rgba(0,240,255,0.4);flex-shrink:0;
}
.monitor-bar-name{color:#00f0ff;font-size:12px;text-shadow:0 0 6px rgba(0,240,255,0.2)}
.monitor-bar-btns{display:flex;gap:6px}
#btn-scroll-bottom,#btn-pause,#btn-speed,#btn-audit{
  padding:4px 14px;border-radius:5px;font-family:inherit;font-size:10px;
  letter-spacing:1px;cursor:pointer;
  border:1px solid rgba(0,240,255,0.25);
  background:rgba(0,240,255,0.06);color:#00f0ff;
  transition:all .2s;
}
#btn-scroll-bottom:hover,#btn-pause:hover,#btn-speed:hover,#btn-audit:hover{background:rgba(0,240,255,0.15)}
#btn-pause.paused{border-color:rgba(251,191,36,0.4);color:#fbbf24;background:rgba(251,191,36,0.06)}
#btn-speed.turbo{border-color:rgba(52,211,153,0.45);color:#34d399;background:rgba(52,211,153,0.08)}
#terminal-wrap{flex:1;min-height:0;overflow:hidden;position:relative;margin:5px;border-radius:18px / 14px}
#terminal-wrap.hidden{display:none}
/* CRT barrel — heavy elliptical vignette */
#terminal-wrap::before{
  content:'';position:absolute;inset:0;pointer-events:none;z-index:3;
  border-radius:18px / 14px;
  background:
    radial-gradient(ellipse 105% 105% at 50% 50%,transparent 45%,rgba(0,0,0,0.25) 58%,rgba(0,0,0,0.55) 72%,rgba(0,0,0,0.92) 100%);
  box-shadow:
    inset 0 0 120px rgba(0,240,255,0.03),
    inset 0 0 40px rgba(160,192,160,0.05);
}
/* CRT barrel — thick bezel frame */
#terminal-wrap::after{
  content:'';position:absolute;inset:-3px;pointer-events:none;z-index:4;
  border-radius:22px / 18px;
  border:3px solid rgba(0,0,0,0.7);
  box-shadow:
    inset 0 0 30px 12px rgba(0,0,0,0.6),
    inset 0 2px 6px rgba(160,200,160,0.08),
    inset 0 -2px 6px rgba(0,0,0,0.4),
    0 0 12px rgba(0,0,0,0.5);
}
#terminal{
  position:absolute;inset:0;overflow-y:auto;
  background:
    repeating-linear-gradient(0deg,rgba(120,170,120,0.06) 0px,rgba(120,170,120,0.06) 1px,transparent 1px,transparent 2px),
    #030303;
  background-attachment:local;
  padding:12px 22px;
  border:1px solid rgba(0,240,255,0.06);border-radius:18px / 14px;
  font-family:'SF Mono','Fira Code','Consolas',monospace;font-size:12px;line-height:18px;
  color:#a0c8a0;white-space:pre-wrap;word-break:break-all;
  scrollbar-width:thin;scrollbar-color:rgba(0,240,255,0.08) transparent;
  text-shadow:0 0 3px rgba(140,200,140,0.5),0 0 10px rgba(140,200,140,0.15),0 0 20px rgba(140,200,140,0.05);
  box-shadow:inset 0 0 120px rgba(0,0,0,0.75);
  animation:crt-flicker 3s infinite;
}
@keyframes crt-flicker{
  0%,100%{opacity:1}
  48%{opacity:1}
  49%{opacity:0.96}
  50%{opacity:1}
  92%{opacity:1}
  93%{opacity:0.94}
  94%{opacity:1}
  97%{opacity:0.97}
  98%{opacity:1}
}
/* Low-power mode when tab is hidden */
body.page-hidden .panel-header .dot,
body.page-hidden .reminder-header .dot,
body.page-hidden #terminal{
  animation:none !important;
}
body.page-hidden #terminal{
  text-shadow:none;
  box-shadow:inset 0 0 60px rgba(0,0,0,0.5);
}
body.page-hidden #queue-panel.has-items,
body.page-hidden #reminder-panel.has-items{
  backdrop-filter:none;
}
@media (prefers-reduced-motion: reduce){
  .panel-header .dot,
  .reminder-header .dot,
  #terminal{
    animation:none !important;
  }
}
#monitor-empty{
  display:flex;align-items:center;justify-content:center;
  flex:1;color:rgba(0,240,255,0.12);font-size:11px;letter-spacing:3px;
  text-shadow:0 0 6px rgba(0,240,255,0.1);
}
#agent-info{
  display:none;padding:10px 14px;
  background:rgba(6,10,18,0.88);
  border:1px solid rgba(0,240,255,0.1);border-radius:8px;
  backdrop-filter:blur(12px);
  font-size:10px;line-height:1.7;color:rgba(0,240,255,0.35);
  flex-shrink:0;overflow:visible;max-height:none;
}
#agent-info.visible{display:block}
#agent-info .ai-identity-row{display:flex;align-items:center;gap:4px}
#agent-info .ai-identity-edit{
  background:none;border:none;color:rgba(0,240,255,0.25);cursor:pointer;font-size:10px;padding:0 2px;
}
#agent-info .ai-identity-edit:hover{color:rgba(0,240,255,0.6)}
#agent-info .ai-identity-input{
  background:rgba(0,0,0,0.4);border:1px solid rgba(0,240,255,0.2);border-radius:3px;
  color:rgba(255,255,255,0.7);font-size:10px;font-style:italic;font-family:inherit;
  padding:2px 6px;width:100%;outline:none;
}
#agent-info .ai-identity-input:focus{border-color:rgba(0,240,255,0.5)}
#agent-info .ai-v1-wrap{
  margin-top:8px;
  border-top:1px solid rgba(0,240,255,0.1);
  padding-top:8px;
}
#agent-info .ai-v1-title{
  color:rgba(0,240,255,0.5);
  font-size:9px;
  letter-spacing:1px;
  margin-bottom:6px;
}
#agent-info .ai-v1-row{
  margin-top:4px;
}
#agent-info .ai-v1-input,
#agent-info .ai-v1-textarea{
  width:100%;
  background:rgba(0,0,0,0.35);
  border:1px solid rgba(0,240,255,0.2);
  border-radius:4px;
  color:rgba(255,255,255,0.75);
  font-family:inherit;
  font-size:10px;
  padding:4px 6px;
  outline:none;
}
#agent-info .ai-v1-input:focus,
#agent-info .ai-v1-textarea:focus{
  border-color:rgba(0,240,255,0.55);
}
#agent-info .ai-v1-textarea{
  resize:vertical;
  min-height:52px;
  line-height:1.35;
}
#agent-info .ai-v1-hint{
  color:rgba(0,240,255,0.22);
  font-size:9px;
  margin-top:4px;
  word-break:break-word;
}
#agent-info .ai-v1-project-list{
  margin-top:4px;
  color:rgba(0,240,255,0.32);
  font-size:9px;
  line-height:1.35;
}
#agent-info .ai-v1-save{
  margin-top:6px;
  background:none;
  border:1px solid rgba(95,210,255,0.35);
  border-radius:4px;
  color:rgba(95,210,255,0.85);
  cursor:pointer;
  font-size:9px;
  padding:2px 8px;
  font-family:inherit;
}
#agent-info .ai-v1-save:hover{
  border-color:rgba(95,210,255,0.8);
  color:#5fd2ff;
}
.ai-action-row{margin-top:8px;display:flex;justify-content:flex-end;align-items:center;gap:8px;flex-wrap:wrap}
.ai-action-spacer{flex:1;min-width:20px}
.ai-audit-btn{
  background:none;border:1px solid rgba(95,210,255,0.35);border-radius:3px;
  color:rgba(95,210,255,0.9);cursor:pointer;font-size:9px;padding:2px 8px;font-family:inherit;
}
.ai-audit-btn:hover{border-color:rgba(95,210,255,0.75);color:#5fd2ff}
.ai-down-btn{
  background:none;border:1px solid rgba(251,191,36,0.35);border-radius:3px;
  color:rgba(251,191,36,0.8);cursor:pointer;font-size:9px;padding:2px 8px;font-family:inherit;
}
.ai-down-btn:hover{border-color:rgba(251,191,36,0.65);color:#fbbf24}
.ai-down-btn.confirm{
  background:rgba(251,191,36,0.15);border-color:rgba(251,191,36,0.9);color:#fbbf24;
}
.ai-down-btn.downing{
  opacity:0.5;pointer-events:none;
}
.ai-delete-btn{
  background:none;border:1px solid rgba(255,80,80,0.25);border-radius:3px;
  color:rgba(255,80,80,0.5);cursor:pointer;font-size:9px;padding:2px 8px;font-family:inherit;
}
.ai-delete-btn:hover{border-color:rgba(255,80,80,0.5);color:rgba(255,80,80,0.8)}
.ai-delete-btn.confirm{
  background:rgba(255,40,40,0.15);border-color:rgba(255,60,60,0.7);color:#ff4444;
}
.ai-delete-btn.deleting{
  opacity:0.5;pointer-events:none;
}
#delete-toast{
  position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) scale(0.8);
  background:rgba(255,60,60,0.15);border:1px solid rgba(255,80,80,0.5);
  border-radius:8px;padding:12px 28px;color:#ff6666;font-size:13px;letter-spacing:2px;
  backdrop-filter:blur(12px);opacity:0;pointer-events:none;
  transition:opacity 0.2s, transform 0.2s;z-index:9999;
}
#delete-toast.show{opacity:1;transform:translate(-50%,-50%) scale(1)}
.root-modal{
  position:fixed;inset:0;z-index:40;
  display:flex;align-items:center;justify-content:center;
  background:rgba(3,7,11,0.68);padding:18px;
}
.root-modal.hidden{display:none}
.root-modal-card{
  width:min(420px,100%);
  border-radius:16px;
  border:1px solid rgba(243,107,125,0.24);
  background:#0d1723;
  box-shadow:0 24px 54px rgba(0,0,0,0.35);
  padding:18px;
}
.root-modal-title{font-size:16px;color:rgba(255,255,255,0.9);font-family:inherit}
.root-modal-copy{margin-top:10px;font-size:12px;line-height:1.6;color:rgba(255,255,255,0.4)}
.root-modal-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:18px}
.root-modal-btn{
  font-family:inherit;font-size:10px;letter-spacing:1px;padding:4px 14px;
  border-radius:4px;cursor:pointer;border:1px solid;background:transparent;transition:all .2s;
}
.root-modal-btn.cancel{color:rgba(255,255,255,0.4);border-color:rgba(255,255,255,0.15)}
.root-modal-btn.cancel:hover{color:rgba(255,255,255,0.6);border-color:rgba(255,255,255,0.3)}
.root-modal-btn.danger{color:#f87171;border-color:rgba(248,113,113,0.35)}
.root-modal-btn.danger:hover{background:rgba(248,113,113,0.1);border-color:#f87171}
.root-modal-btn.warn{color:#fbbf24;border-color:rgba(251,191,36,0.35)}
.root-modal-btn.warn:hover{background:rgba(251,191,36,0.1);border-color:#fbbf24}
.root-modal-btn:disabled{opacity:0.45;pointer-events:none}
#agent-info .ai-label{color:rgba(0,240,255,0.2);margin-right:4px}
#agent-info .ai-val{color:rgba(0,240,255,0.6)}
#agent-info .ai-identity{color:rgba(255,255,255,0.35);font-style:italic}
#agent-info .ai-tag{
  display:inline-block;padding:1px 8px;border-radius:3px;margin-right:4px;
  font-size:9px;letter-spacing:1px;
}
#agent-info .ai-tag-claude{background:rgba(168,85,247,0.15);color:#a855f7;border:1px solid rgba(168,85,247,0.25)}
#agent-info .ai-tag-codex{background:rgba(52,211,153,0.15);color:#34d399;border:1px solid rgba(52,211,153,0.25)}
#agent-info .ai-tag-active{background:rgba(52,211,153,0.1);color:#34d399;border:1px solid rgba(52,211,153,0.2)}
#agent-info .ai-tag-inactive{background:rgba(255,255,255,0.03);color:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.08)}
#agent-info .ai-tag-focused{background:rgba(52,211,153,0.1);color:#34d399;border:1px solid rgba(52,211,153,0.2)}
#agent-info .ai-tag-alert{background:rgba(248,113,113,0.12);color:#f87171;border:1px solid rgba(248,113,113,0.28)}
#agent-info .ai-tag-neutral{background:rgba(95,210,255,0.08);color:rgba(95,210,255,0.8);border:1px solid rgba(95,210,255,0.22)}
#agent-info .ai-groups{color:rgba(168,85,247,0.5)}
#agent-info .ai-summary-grid{
  display:grid;
  grid-template-columns:repeat(2,minmax(0,1fr));
  gap:6px;
  margin-top:8px;
}
#agent-info .ai-summary-item{
  border:1px solid rgba(0,240,255,0.12);
  background:rgba(0,0,0,0.22);
  border-radius:4px;
  padding:6px;
}
#agent-info .ai-summary-k{
  color:rgba(0,240,255,0.24);
  font-size:8px;
  letter-spacing:1px;
}
#agent-info .ai-summary-v{
  color:rgba(255,255,255,0.72);
  font-size:11px;
  margin-top:2px;
}
#agent-info .ai-warning{
  margin-top:8px;
  border:1px solid rgba(248,113,113,0.18);
  background:rgba(248,113,113,0.08);
  border-radius:4px;
  padding:6px;
}
#agent-info .ai-warning-title{
  color:#f87171;
  font-size:9px;
  letter-spacing:1px;
}
#agent-info .ai-warning-body{
  color:rgba(255,255,255,0.68);
  font-size:10px;
  line-height:1.4;
  margin-top:4px;
}
#agent-info .ai-summary-note{
  margin-top:8px;
  color:rgba(0,240,255,0.22);
  font-size:9px;
  line-height:1.4;
}
#agent-info .ai-unread-wrap{margin-top:8px;border-top:1px solid rgba(0,240,255,0.1);padding-top:8px}
#agent-info .ai-unread-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
#agent-info .ai-unread-title{color:rgba(0,240,255,0.5);font-size:9px;letter-spacing:1px}
#agent-info .ai-unread-meta{color:rgba(0,240,255,0.25);font-size:9px}
#agent-info .ai-unread-list{display:flex;flex-direction:column;gap:6px}
#agent-info .ai-unread-item{border:1px solid rgba(0,240,255,0.12);background:rgba(0,0,0,0.25);border-radius:4px;padding:6px}
#agent-info .ai-unread-route{color:rgba(0,240,255,0.45);font-size:9px;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#agent-info .ai-unread-summary{color:rgba(255,255,255,0.58);font-size:10px;line-height:1.35;word-break:break-word}
#agent-info .ai-unread-sub{color:rgba(0,240,255,0.28);font-size:9px;margin-top:4px}
#agent-info .ai-unread-actions{margin-top:5px;text-align:right}
#agent-info .ai-unread-cancel{
  background:none;border:1px solid rgba(248,113,113,0.35);border-radius:3px;
  color:#f87171;cursor:pointer;font-size:9px;padding:1px 8px;font-family:inherit;
}
#agent-info .ai-unread-cancel:hover{background:rgba(248,113,113,0.1);border-color:#f87171}
#agent-info .ai-unread-empty{color:rgba(0,240,255,0.2);font-size:9px}

/* Message log (bottom) */
#msglog{
  flex-shrink:0;height:140px;overflow-y:auto;
  background:rgba(6,10,18,0.95);
  border-top:1px solid rgba(0,240,255,0.08);
  padding:8px 16px;
  scrollbar-width:thin;scrollbar-color:rgba(0,240,255,0.15) transparent;
}
.log-entry{font-size:11px;line-height:1.5;color:rgba(0,240,255,0.45);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.log-entry .ts{color:rgba(0,240,255,0.25)}
.log-entry .from{color:#00f0ff}
.log-entry .to{color:#a855f7}
.log-entry .arrow{color:rgba(0,240,255,0.3)}
.log-entry .payload{color:rgba(255,255,255,0.3);overflow:hidden;text-overflow:ellipsis;max-width:100%}

/* Mobile FABs (hidden on desktop) */
.mobile-fab{display:none}

/* ── Mobile ──────────────────────────────────────── */
@media (max-width:768px){
  /* FAB dots */
  .mobile-fab{
    display:flex;align-items:center;justify-content:center;
    position:fixed;z-index:100;width:36px;height:36px;border-radius:50%;
    cursor:pointer;-webkit-tap-highlight-color:transparent;
    border:1px solid rgba(0,240,255,0.2);
    backdrop-filter:blur(8px);
  }
  .mobile-fab-dot{width:8px;height:8px;border-radius:50%}
  #mobile-fab-queue{
    top:10px;left:10px;background:rgba(168,85,247,0.15);
  }
  #mobile-fab-queue .mobile-fab-dot{background:#a855f7;box-shadow:0 0 6px #a855f7}
  #mobile-fab-queue.has-count{border-color:rgba(168,85,247,0.5)}
  #mobile-fab-reminder{
    top:10px;right:10px;background:rgba(251,191,36,0.15);
  }
  #mobile-fab-reminder .mobile-fab-dot{background:#fbbf24;box-shadow:0 0 6px #fbbf24}
  #mobile-fab-reminder.has-count{border-color:rgba(251,191,36,0.5)}

  /* Hide side panels and log by default */
  #queue-panel,#right-col,#msglog{display:none!important}

  /* Mobile overlay panel */
  #queue-panel.mobile-open,#right-col.mobile-open{
    display:flex!important;flex-direction:column;
    position:fixed;top:52px;bottom:0;width:85vw;max-width:320px;
    z-index:90;background:rgba(6,10,18,0.96);
    backdrop-filter:blur(16px);
    border:1px solid rgba(0,240,255,0.12);border-radius:0 12px 12px 0;
    overflow-y:auto;
  }
  #queue-panel.mobile-open{left:0;border-radius:0 12px 12px 0}
  #right-col.mobile-open{right:0;left:auto;border-radius:12px 0 0 12px}
  #right-col.mobile-open #reminder-panel{flex:none;overflow-y:visible}
  #right-col.mobile-open #agent-info{flex:none;overflow-y:visible}
  #right-col.mobile-open #agent-info.visible{display:block}

  /* Mobile overlay backdrop */
  .mobile-backdrop{
    display:none;position:fixed;inset:0;z-index:80;
    background:rgba(0,0,0,0.5);-webkit-tap-highlight-color:transparent;
  }
  .mobile-backdrop.active{display:block}

  /* Main row: full width, no side padding */
  #main-row{padding:6px;gap:0}
  #monitor-panel{border-radius:10px}
  .monitor-header{padding:8px 14px;font-size:9px}
  #agent-buttons{padding:8px 10px;gap:5px}
  .agent-btn{padding:4px 8px;font-size:10px;gap:4px}
  .monitor-bar{padding:6px 12px;margin:3px 0 0}
  .monitor-bar-name{font-size:11px}
  #btn-scroll-bottom,#btn-pause,#btn-speed,#btn-audit{padding:3px 10px;font-size:9px}
  #terminal{padding:8px 12px;font-size:11px}
  #terminal-wrap{margin:3px;border-radius:14px / 11px}
  #terminal-wrap::before{border-radius:14px / 11px}
  #terminal-wrap::after{border-radius:16px / 13px}
  #terminal{border-radius:14px / 11px}
}
select{cursor:pointer}
select option{background:#0d1723;color:#e2eaf3}
</style>
</head>
<body>
<div id="app">
  <div id="mobile-fab-queue" class="mobile-fab" onclick="toggleMobilePanel('queue')"><span class="mobile-fab-dot"></span></div>
  <div id="mobile-fab-reminder" class="mobile-fab" onclick="toggleMobilePanel('reminder')"><span class="mobile-fab-dot"></span></div>
  <div id="mobile-backdrop" class="mobile-backdrop" onclick="closeMobilePanels()"></div>
  <div id="main-row">
    <div id="queue-panel">
      <div class="panel-header"><span class="dot"></span>PENDING QUEUE</div>
      <div id="queue-list"></div>
    </div>
    <div id="monitor-panel">
      <div class="monitor-header" style="display:flex;align-items:center;gap:12px">AGENT MONITOR<a href="/alerts" id="alert-badge" style="font-size:10px;color:rgba(255,107,107,0.7);text-decoration:none;display:none"></a><button id="btn-new-agent" onclick="openNewAgentModal()" style="margin-left:auto;font-size:10px;color:rgba(0,240,255,0.4);background:none;border:1px solid rgba(0,240,255,0.15);padding:2px 8px;cursor:pointer;letter-spacing:1px;font-family:inherit">+ NEW</button><a href="/tasks" style="font-size:10px;color:rgba(0,240,255,0.4);text-decoration:none;letter-spacing:1px">TASKS</a><a href="/config" style="font-size:10px;color:rgba(0,240,255,0.4);text-decoration:none;letter-spacing:1px">CONFIG</a></div>
      <div id="agent-buttons-wrap">
        <div id="agent-buttons"><span style="color:rgba(0,240,255,0.2);font-size:10px">loading agents...</span></div>
        <button id="agent-toggle" title="Show all agents">▼ more</button>
      </div>
      <div class="monitor-bar">
        <span class="monitor-bar-name" id="monitor-label">Select an agent to monitor</span>
        <span class="monitor-bar-btns">
          <button id="btn-scroll-bottom" style="display:none">&#8615; BOTTOM</button>
          <button id="btn-speed" style="display:none">10HZ</button>
          <button id="btn-audit" style="display:none" onclick="openAuditPage()">DETAIL</button>
          <button id="btn-pause" style="display:none">&#9646;&#9646; PAUSE</button>
        </span>
      </div>
      <div id="monitor-empty">NO AGENT SELECTED</div>
      <div id="terminal-wrap" class="hidden"><div id="terminal"></div></div>
    </div>
    <div id="right-col">
      <div id="reminder-panel">
        <div class="reminder-header"><span class="dot"></span>REMINDERS</div>
        <div id="reminder-list"></div>
      </div>
      <div id="agent-info"></div>
    </div>
  </div>
  <div id="msglog"></div>
  <div id="delete-toast"></div>
  <div id="root-confirm-modal" class="root-modal hidden">
    <div class="root-modal-card">
      <div class="root-modal-title" id="root-confirm-title">Confirm action</div>
      <div class="root-modal-copy" id="root-confirm-copy"></div>
      <div class="root-modal-actions">
        <button class="root-modal-btn cancel" onclick="closeRootModal()">Cancel</button>
        <button class="root-modal-btn" id="root-confirm-cta" onclick="confirmRootAction()">Confirm</button>
      </div>
    </div>
  </div>
</div>

<div id="new-agent-modal" style="display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.7);align-items:center;justify-content:center">
  <div style="background:#0d1926;border:1px solid rgba(0,240,255,0.15);padding:24px;width:400px;max-width:90vw">
    <div style="font-size:12px;letter-spacing:2px;color:rgba(0,240,255,0.6);margin-bottom:16px">NEW AGENT</div>
    <div style="margin-bottom:10px">
      <label style="font-size:10px;color:rgba(255,255,255,0.5);letter-spacing:1px">NAME *</label>
      <input id="na-name" style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:6px 8px;background:rgba(0,0,0,0.3);border:1px solid rgba(0,240,255,0.15);color:#e0e0e0;font-family:inherit;font-size:12px" placeholder="my-agent">
    </div>
    <div style="margin-bottom:10px">
      <label style="font-size:10px;color:rgba(255,255,255,0.5);letter-spacing:1px">PRESET *</label>
      <select id="na-preset" style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:6px 8px;background:rgba(0,0,0,0.3);border:1px solid rgba(0,240,255,0.15);color:#e0e0e0;font-family:inherit;font-size:12px;cursor:pointer">
        <option value="">Loading presets...</option>
      </select>
    </div>
    <div style="margin-bottom:10px">
      <label style="font-size:10px;color:rgba(255,255,255,0.5);letter-spacing:1px">IDENTITY</label>
      <input id="na-identity" style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:6px 8px;background:rgba(0,0,0,0.3);border:1px solid rgba(0,240,255,0.15);color:#e0e0e0;font-family:inherit;font-size:12px" placeholder="One-line description">
    </div>
    <div style="margin-bottom:16px">
      <label style="font-size:10px;color:rgba(255,255,255,0.5);letter-spacing:1px">GUIDANCE</label>
      <textarea id="na-guidance" rows="3" style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:6px 8px;background:rgba(0,0,0,0.3);border:1px solid rgba(0,240,255,0.15);color:#e0e0e0;font-family:inherit;font-size:12px;resize:vertical" placeholder="Human-authored intent / instructions"></textarea>
    </div>
    <div id="na-status" style="font-size:11px;margin-bottom:10px;min-height:16px"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button onclick="closeNewAgentModal()" style="padding:6px 14px;background:none;border:1px solid rgba(255,255,255,0.15);color:rgba(255,255,255,0.5);cursor:pointer;font-family:inherit;font-size:11px">Cancel</button>
      <button onclick="submitNewAgent()" style="padding:6px 14px;background:rgba(0,240,255,0.1);border:1px solid rgba(0,240,255,0.3);color:#00f0ff;cursor:pointer;font-family:inherit;font-size:11px">Create</button>
    </div>
  </div>
</div>

<script>
var _naPresets = [];
window.openNewAgentModal = async function() {
  var m = document.getElementById('new-agent-modal');
  m.style.display = 'flex';
  document.getElementById('na-name').value = '';
  document.getElementById('na-identity').value = '';
  document.getElementById('na-guidance').value = '';
  document.getElementById('na-status').textContent = '';
  var sel = document.getElementById('na-preset');
  sel.innerHTML = '<option value="">Loading...</option>';
  _naPresets = [];
  try {
    var r = await fetch('/api/framework-presets');
    if (r.ok) _naPresets = await r.json();
  } catch {}
  sel.innerHTML = '';
  for (var i = 0; i < _naPresets.length; i++) {
    var p = _naPresets[i];
    var opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name + ' (' + (p.framework || '?') + ')';
    sel.appendChild(opt);
  }
  if (_naPresets.length === 0) sel.innerHTML = '<option value="">No presets available</option>';
  document.getElementById('na-name').focus();
};
window.closeNewAgentModal = function() {
  document.getElementById('new-agent-modal').style.display = 'none';
};
window.submitNewAgent = async function() {
  var name = (document.getElementById('na-name').value || '').trim();
  if (!name) { document.getElementById('na-status').textContent = 'Name is required.'; document.getElementById('na-status').style.color = '#ff6b6b'; return; }
  if (!/^[\\w\\-]+$/.test(name)) { document.getElementById('na-status').textContent = 'Invalid name — use letters, digits, hyphens, underscores.'; document.getElementById('na-status').style.color = '#ff6b6b'; return; }
  var presetId = document.getElementById('na-preset').value;
  if (!presetId) { document.getElementById('na-status').textContent = 'Preset is required.'; document.getElementById('na-status').style.color = '#ff6b6b'; return; }
  var preset = _naPresets.find(function(p) { return p.id === presetId; });
  var fw = preset ? (preset.framework || 'claude') : 'claude';
  var identity = (document.getElementById('na-identity').value || '').trim() || null;
  var guidance = (document.getElementById('na-guidance').value || '').trim() || null;
  var body = {
    name: name,
    type: fw,
    identity: identity,
    role: guidance,
    presetId: presetId,
  };
  document.getElementById('na-status').textContent = 'Creating...';
  document.getElementById('na-status').style.color = 'rgba(0,240,255,0.6)';
  try {
    var r = await fetch('/api/agents/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    var data = await r.json().catch(function() { return {}; });
    if (!r.ok) throw new Error(data.error || 'creation failed (HTTP ' + r.status + ')');

    document.getElementById('na-status').textContent = 'Created. Starting agent...';
    document.getElementById('na-status').style.color = 'rgba(0,240,255,0.6)';
    try {
      var sr = await fetch('/api/agents/' + encodeURIComponent(name) + '/start', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      var sd = await sr.json().catch(function() { return {}; });
      if (sr.ok) {
        document.getElementById('na-status').textContent = 'Agent "' + name + '" starting — will appear in queue shortly.';
        document.getElementById('na-status').style.color = '#34d399';
      } else {
        document.getElementById('na-status').textContent = 'Created but start failed: ' + (sd.error || 'unknown');
        document.getElementById('na-status').style.color = '#ffd93d';
      }
    } catch (startErr) {
      document.getElementById('na-status').textContent = 'Created but start failed: ' + startErr.message;
      document.getElementById('na-status').style.color = '#ffd93d';
    }
    setTimeout(function() { closeNewAgentModal(); }, 3000);
  } catch (e) {
    document.getElementById('na-status').textContent = 'Failed: ' + e.message;
    document.getElementById('na-status').style.color = '#ff6b6b';
  }
};
document.getElementById('new-agent-modal').addEventListener('click', function(e) {
  if (e.target === this) closeNewAgentModal();
});

(() => {
  const IDLE_THRESHOLD_MS = ${idleThreshold};
  const IDLE_THRESHOLD_SEC = ${idleThresholdSec};
  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function toNonNegInt(v, fallback = 0) {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }
  function fmtSpanSec(sec) {
    const s = Math.max(0, toNonNegInt(sec, 0));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm' + (s % 60) + 's';
    if (s < 86400) return Math.floor(s / 3600) + 'h' + Math.floor((s % 3600) / 60) + 'm';
    return Math.floor(s / 86400) + 'd' + Math.floor((s % 86400) / 3600) + 'h';
  }
  function runtimeStatusText(activeNow, activeDurationSec, idleDurationSec) {
    if (activeNow) return 'ACTIVE ' + fmtSpanSec(activeDurationSec);
    return 'IDLE ' + fmtSpanSec(idleDurationSec);
  }

  // ── Message log ─────────────────────────────
  const msglogEl = document.getElementById('msglog');
  function addLogEntry(msg) {
    if (document.hidden) return;
    const ts = new Date(msg.ts).toLocaleTimeString();
    const payload = (msg.payload || '').slice(0, 120);
    const div = document.createElement('div');
    div.className = 'log-entry';
    div.innerHTML =
      '<span class="ts">' + ts + '</span> '
      + '<span class="from">' + esc(msg.from) + '</span> '
      + '<span class="arrow">&#10145;</span> '
      + '<span class="to">' + esc(msg.to) + '</span> '
      + '<span class="payload">' + esc(payload) + '</span>';
    msglogEl.appendChild(div);
    while (msglogEl.children.length > 200) msglogEl.removeChild(msglogEl.firstChild);
    msglogEl.scrollTop = msglogEl.scrollHeight;
  }

  // ── Queue panel ─────────────────────────────
  const queuePanel = document.getElementById('queue-panel');
  const queueList = document.getElementById('queue-list');
  let queueItems = [];

  let queueActionPending = false;
  let queueRenderLocked = false;
  let queueRenderPending = false;
  let lastQueueHtml = '';
  function computeQueueWaitStr(queuedAt) {
    const wait = Math.floor((Date.now() - queuedAt) / 1000);
    return wait < 60 ? wait + 's' : Math.floor(wait / 60) + 'm ' + (wait % 60) + 's';
  }

  function updateQueueTimersInPlace() {
    const byId = new Map(queueItems.map(item => [String(item.id), item]));
    for (const row of queueList.querySelectorAll('.queue-item[data-id]')) {
      const id = row.getAttribute('data-id');
      const item = byId.get(String(id));
      if (!item) continue;
      const waitEl = row.querySelector('.qi-wait');
      if (waitEl) waitEl.textContent = 'waiting ' + computeQueueWaitStr(item.queuedAt);
    }
  }

  function renderQueuePanel() {
    if (document.hidden) return;
    if (queueActionPending) return;
    if (queueItems.length === 0) { queuePanel.classList.remove('has-items'); queueList.innerHTML = ''; lastQueueHtml = ''; return; }
    queuePanel.classList.add('has-items');
    const html = queueItems.map(item => {
      const waitStr = computeQueueWaitStr(item.queuedAt);
      const payload = (item.payload || '').slice(0, 80);
      const observation = item.targetObservation || {};
      const observationState = typeof observation.state === 'string' ? observation.state : '';
      const idleRaw = Number(item.targetIdleMs);
      const idleMs = Number.isFinite(idleRaw) ? idleRaw : -1;
      let idleStr, idleClass;
      if (observationState === 'pane-missing' || (!observationState && idleMs < 0)) {
        idleStr = 'pane not found';
        idleClass = 'qi-idle-warn';
      } else if (observationState === 'capture-failed') {
        idleStr = 'capture failed';
        idleClass = 'qi-idle-warn';
      } else if (observationState === 'list-failed') {
        idleStr = 'observation unavailable';
        idleClass = 'qi-idle-warn';
      } else if (observationState === 'untracked') {
        idleStr = 'not observed yet';
        idleClass = 'qi-idle-warn';
      }
      else if (idleMs >= IDLE_THRESHOLD_MS) {
        const s = Math.floor(idleMs / 1000);
        idleStr = 'idle ' + (s < 60 ? s + 's' : Math.floor(s/60) + 'm' + (s%60) + 's') + ' (delivering soon)';
        idleClass = 'qi-idle-ready';
      } else {
        const s = Math.floor(idleMs / 1000);
        idleStr = 'target active (idle ' + s + 's / ' + IDLE_THRESHOLD_SEC + 's)';
        idleClass = 'qi-idle-busy';
      }
      const redir = item.redirectedFrom ? ' <span class="qi-redir">(was ' + esc(item.redirectedFrom) + ')</span>' : '';
      return '<div class="queue-item" data-id="' + item.id + '">'
        + '<div class="qi-route"><span class="qi-from">' + esc(item.from) + '</span>'
        + '<span class="qi-arrow"> &#10145; </span>'
        + '<span class="qi-target">' + esc(item.to) + '</span>' + redir + '</div>'
        + '<div class="qi-payload">' + esc(payload) + '</div>'
        + '<div class="qi-wait">waiting ' + waitStr + '</div>'
        + '<div class="qi-idle ' + idleClass + '">' + idleStr + '</div>'
        + '<div class="qi-actions">'
        + '<button class="qi-btn qi-btn-send" onclick="queueAction(' + item.id + ',\\'send\\')">SEND NOW</button>'
        + '<button class="qi-btn qi-btn-cancel" onclick="queueAction(' + item.id + ',\\'cancel\\')">CANCEL</button>'
        + '</div></div>';
    }).join('');
    if (html !== lastQueueHtml) { queueList.innerHTML = html; lastQueueHtml = html; }
  }
  function requestQueueRender(force = false) {
    if (queueRenderLocked && !force) {
      queueRenderPending = true;
      updateQueueTimersInPlace();
      return;
    }
    queueRenderPending = false;
    renderQueuePanel();
  }
  setInterval(() => requestQueueRender(false), 2000);

  queuePanel.addEventListener('mouseenter', () => {
    queueRenderLocked = true;
  });
  queuePanel.addEventListener('mouseleave', () => {
    queueRenderLocked = false;
    if (queueRenderPending) requestQueueRender(true);
  });

  window.queueAction = async function(id, action) {
    // Optimistic: remove immediately, restore on failure
    const removed = queueItems.find(i => i.id === id);
    queueItems = queueItems.filter(i => i.id !== id);
    queueActionPending = false;
    requestQueueRender(true);
    try {
      let res;
      if (action === 'send') {
        res = await fetch('/api/queue/' + id + '/send', { method: 'POST' });
      } else {
        const sourceMsgId = (removed && removed.notifyMeta && typeof removed.notifyMeta.sourceMsgId === 'string')
          ? removed.notifyMeta.sourceMsgId.trim()
          : '';
        const targetAgent = (removed && typeof removed.to === 'string')
          ? String(removed.to).split(':', 1)[0]
          : '';
        const isBackendNotification = removed && removed.from === 'agent-chat-v2';
        if (isBackendNotification && sourceMsgId && targetAgent) {
          res = await fetch('/api/agents/' + encodeURIComponent(targetAgent) + '/unread-messages/' + encodeURIComponent(sourceMsgId) + '/cancel', {
            method: 'POST'
          });
        } else {
          res = await fetch('/api/queue/' + id, { method: 'DELETE' });
        }
      }
      let body = null;
      try { body = await res.json(); } catch (e) {
        console.debug('[agent-detail] queue action response parse skipped:', e.message);
      }
      if (!res.ok || (body && body.ok === false)) {
        throw new Error((body && body.reason) || ('HTTP ' + res.status));
      }
      if (action !== 'send' && monitoredAgent && removed && typeof removed.to === 'string') {
        const targetAgent = String(removed.to).split(':', 1)[0];
        if (targetAgent === monitoredAgent.name) fetchAgentDetail(monitoredAgent.name);
      }
    } catch (e) {
      console.debug('[agent-detail] queue action failed, restoring removed entry:', e.message);
      if (removed) { queueItems.push(removed); requestQueueRender(true); }
    }
  };

  // ── Reminder panel ─────────────────────────
  const reminderPanel = document.getElementById('reminder-panel');
  const reminderList = document.getElementById('reminder-list');
  let reminderItems = [];

  function fmtCountdown(ms) {
    if (ms <= 0) return 'firing...';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    const h = Math.floor(m / 60);
    return h + 'h ' + (m % 60) + 'm';
  }

  let reminderActionPending = false;
  let lastReminderHtml = '';
  function renderReminderPanel() {
    if (document.hidden) return;
    if (reminderActionPending) return;
    if (reminderItems.length === 0) { reminderPanel.classList.remove('has-items'); reminderList.innerHTML = ''; lastReminderHtml = ''; return; }
    reminderPanel.classList.add('has-items');
    const html = reminderItems.map(item => {
      const remaining = item.remainingMs || 0;
      const created = new Date(item.createdAt).toLocaleTimeString();
      const msg = (item.msg || '').slice(0, 80);
      return '<div class="reminder-item">'
        + '<div class="ri-target">' + esc(item.target) + '</div>'
        + '<div class="ri-msg">' + esc(msg) + '</div>'
        + '<div class="ri-countdown">&#9200; ' + fmtCountdown(remaining) + '</div>'
        + '<div class="ri-created">set at ' + created + '</div>'
        + '<div class="ri-actions">'
        + '<button class="ri-btn-cancel" onclick="cancelReminder(' + item.id + ')">CANCEL</button>'
        + '</div></div>';
    }).join('');
    if (html !== lastReminderHtml) { reminderList.innerHTML = html; lastReminderHtml = html; }
  }
  setInterval(renderReminderPanel, 2000);

  window.cancelReminder = async function(id) {
    // Optimistic: remove immediately, restore on failure
    const removed = reminderItems.find(i => i.id === id);
    reminderItems = reminderItems.filter(i => i.id !== id);
    reminderActionPending = false;
    renderReminderPanel();
    try {
      await fetch('/api/reminders/' + id, { method: 'DELETE' });
    } catch {
      if (removed) { reminderItems.push(removed); renderReminderPanel(); }
    }
  };

  // ── Agent Monitor ───────────────────────────
  const agentButtonsEl = document.getElementById('agent-buttons');
  const agentToggleEl  = document.getElementById('agent-toggle');
  const monitorLabelEl = document.getElementById('monitor-label');
  const monitorEmptyEl = document.getElementById('monitor-empty');
  const terminalWrapEl = document.getElementById('terminal-wrap');
  const terminalEl     = document.getElementById('terminal');
  const btnPause       = document.getElementById('btn-pause');
  const btnSpeed       = document.getElementById('btn-speed');
  const btnAudit       = document.getElementById('btn-audit');
  const btnScrollBottom = document.getElementById('btn-scroll-bottom');
  const agentInfoEl    = document.getElementById('agent-info');

  // Agent list collapse/expand
  let agentListExpanded = false;
  function calcTwoRowHeight() {
    const btns = agentButtonsEl.querySelectorAll('.agent-btn');
    if (btns.length === 0) return 86;
    // Find distinct row tops
    const tops = new Set();
    for (const b of btns) tops.add(Math.round(b.offsetTop));
    const sorted = [...tops].sort((a, b) => a - b);
    if (sorted.length <= 2) return agentButtonsEl.scrollHeight; // fits in 2 rows
    // Height = bottom of 2nd row buttons + padding
    const secondRowTop = sorted[1];
    let maxBottom = 0;
    for (const b of btns) {
      if (Math.round(b.offsetTop) === secondRowTop) {
        maxBottom = Math.max(maxBottom, b.offsetTop + b.offsetHeight);
      }
    }
    const style = getComputedStyle(agentButtonsEl);
    const padTop = parseFloat(style.paddingTop) || 0;
    const padBottom = parseFloat(style.paddingBottom) || 0;
    return maxBottom + padBottom + 2; // +2 for rounding
  }
  function updateAgentToggle() {
    if (!agentToggleEl) return;
    const twoRowH = calcTwoRowHeight();
    if (agentButtonsEl.scrollHeight <= twoRowH + 4) {
      agentToggleEl.style.display = 'none';
      agentButtonsEl.style.maxHeight = '';
    } else {
      agentToggleEl.style.display = '';
      if (!agentListExpanded) agentButtonsEl.style.maxHeight = twoRowH + 'px';
      else agentButtonsEl.style.maxHeight = agentButtonsEl.scrollHeight + 'px';
    }
    agentToggleEl.textContent = agentListExpanded ? '▲ less' : '▼ more';
  }
  if (agentToggleEl) {
    agentToggleEl.addEventListener('click', () => {
      agentListExpanded = !agentListExpanded;
      agentButtonsEl.classList.toggle('expanded', agentListExpanded);
      updateAgentToggle();
    });
  }

  btnScrollBottom.addEventListener('click', () => {
    terminalEl.scrollTop = terminalEl.scrollHeight;
  });

  let monitoredAgent = null;
  let monitorPaused  = false;
  let terminalTurboMode = true; // keep per-agent monitor at 10Hz when visible, unless toggled to ECO.
  let agentStatusList = [];
  const STATUS_SYNC_INTERVAL_MS = 30000;
  const STATUS_SYNC_INTERVAL_HIDDEN_MS = 120000;
  const TERMINAL_POLL_TURBO_MS = 100;
  const TERMINAL_POLL_VISIBLE_MS = 400;
  const TERMINAL_POLL_HIDDEN_MS = 3000;
  const DURATION_TICK_VISIBLE_MS = 1000;
  const DURATION_TICK_HIDDEN_MS = 4000;
  const DETAIL_REFRESH_VISIBLE_MS = 2500;
  const DETAIL_REFRESH_HIDDEN_MS = 10000;
  const UNREAD_PANEL_LIMIT = 1;
  let lastStatusSyncAt = 0;
  let statusSyncTimer = null;
  let terminalPollTimer = null;
  let durationTickTimer = null;
  let statusPollTimer = null;
  let detailRefreshTimer = null;
  let agentDetailRequestSeq = 0;
  let agentDetailAbortController = null;

  function updateSelectedRuntimeBadge() {
    if (!monitoredAgent) return;
    const snap = agentStatusList.find(x => x.name === monitoredAgent.name);
    if (!snap) return;
    const stateEl = document.getElementById('ai-runtime-state');
    if (stateEl) {
      const activeNow = !!snap.activeNow;
      const a = toNonNegInt(snap.activeDurationSec, 0);
      const i = toNonNegInt(snap.idleDurationSec, 0);
      stateEl.textContent = runtimeStatusText(activeNow, a, i);
      stateEl.classList.toggle('ai-tag-active', activeNow);
      stateEl.classList.toggle('ai-tag-inactive', !activeNow);
    }
  }

  function scheduleStatusSyncSoon(reason = '') {
    const now = Date.now();
    if (now - lastStatusSyncAt < 3000) return;
    if (statusSyncTimer) return;
    statusSyncTimer = setTimeout(() => {
      statusSyncTimer = null;
      fetchAgentStatus(reason || 'switch').catch(() => {});
    }, 400);
  }

  function updateSpeedButton() {
    if (!btnSpeed) return;
    if (terminalTurboMode) {
      btnSpeed.textContent = '10HZ';
      btnSpeed.classList.add('turbo');
    } else {
      btnSpeed.textContent = 'ECO';
      btnSpeed.classList.remove('turbo');
    }
  }

  function showAgentDetailLoading(name) {
    if (!agentInfoEl) return;
    const safeName = esc(String(name || ''));
    agentInfoEl.innerHTML = '<span class="ai-label">agent</span><span class="ai-val">' + safeName + '</span><br>'
      + '<span class="ai-unread-empty">Loading summary...</span>';
    agentInfoEl.classList.add('visible');
  }

  function showAgentDetailError(name, message) {
    if (!agentInfoEl) return;
    const safeName = esc(String(name || ''));
    const safeMessage = esc(String(message || 'Summary unavailable.'));
    agentInfoEl.innerHTML = '<span class="ai-label">agent</span><span class="ai-val">' + safeName + '</span><br>'
      + '<span class="ai-unread-empty">' + safeMessage + '</span>';
    agentInfoEl.classList.add('visible');
  }

  function hasCurrentSupervisorIssue(state) {
    const classification = String(state?.classification || '').trim().toLowerCase();
    if (classification === 'stalled_wait' || classification === 'suspected_eos') return true;
    const lifecycleState = String(state?.lifecycleState || '').trim().toLowerCase();
    return lifecycleState === 'active' && classification.length > 0;
  }

  function scheduleDetailRefresh() {
    if (detailRefreshTimer) clearInterval(detailRefreshTimer);
    const interval = document.hidden ? DETAIL_REFRESH_HIDDEN_MS : DETAIL_REFRESH_VISIBLE_MS;
    detailRefreshTimer = setInterval(() => {
      if (!monitoredAgent) return;
      fetchAgentDetail(monitoredAgent.name, { preserveVisible: true });
    }, interval);
  }

  btnPause.addEventListener('click', () => {
    monitorPaused = !monitorPaused;
    if (monitorPaused) {
      btnPause.innerHTML = '&#9654; RESUME';
      btnPause.classList.add('paused');
    } else {
      btnPause.innerHTML = '&#9646;&#9646; PAUSE';
      btnPause.classList.remove('paused');
      if (monitoredAgent) fetchTerminal();
    }
  });

  if (btnSpeed) {
    btnSpeed.addEventListener('click', () => {
      terminalTurboMode = !terminalTurboMode;
      updateSpeedButton();
      scheduleTerminalPoll();
      if (monitoredAgent && !monitorPaused && !document.hidden) {
        fetchTerminal();
      }
    });
  }

  function selectAgent(agent) {
    monitoredAgent = agent;
    monitorPaused = false;
    terminalEtag = null;
    btnPause.innerHTML = '&#9646;&#9646; PAUSE';
    btnPause.classList.remove('paused');
    btnPause.style.display = '';
    if (btnSpeed) {
      btnSpeed.style.display = '';
      updateSpeedButton();
    }
    if (btnAudit) btnAudit.style.display = '';
    btnScrollBottom.style.display = '';
    monitorLabelEl.textContent = 'Monitoring: ' + agent.name;
    monitorEmptyEl.style.display = 'none';
    terminalWrapEl.classList.remove('hidden');
    terminalEl.textContent = '';
    for (const btn of agentButtonsEl.querySelectorAll('.agent-btn')) {
      btn.classList.toggle('selected', btn.dataset.name === agent.name);
    }
    showAgentDetailLoading(agent.name);
    fetchAgentDetail(agent.name, { preserveVisible: true });
    fetchTerminal().then(() => {
      requestAnimationFrame(() => {
        terminalEl.scrollTop = terminalEl.scrollHeight;
      });
    });
  }

  async function fetchAgentDetail(name, options = {}) {
    const targetName = String(name || '').trim();
    if (!targetName) return;

    const requestSeq = ++agentDetailRequestSeq;
    if (agentDetailAbortController) {
      try { agentDetailAbortController.abort(); } catch (e) {
        console.debug('[agent-detail] previous request abort skipped:', e.message);
      }
    }
    const controller = new AbortController();
    agentDetailAbortController = controller;

    if (!options.preserveVisible) {
      agentInfoEl.classList.remove('visible');
    }

    try {
      const [detailRespRaw, supervisorRespRaw, supervisorStatusRaw] = await Promise.allSettled([
        fetch('/api/agents/detail/' + encodeURIComponent(targetName), { signal: controller.signal }),
        fetch('/api/supervisor/agents/' + encodeURIComponent(targetName) + '?limit=1', { signal: controller.signal }),
        fetch('/api/supervisor/status', { signal: controller.signal }),
      ]);

      if (requestSeq !== agentDetailRequestSeq) return;
      if (!monitoredAgent || monitoredAgent.name !== targetName) return;

      if (detailRespRaw.status !== 'fulfilled') return;
      const res = detailRespRaw.value;
      if (!res.ok) return;
      const d = await res.json();
      if (requestSeq !== agentDetailRequestSeq) return;
      if (!monitoredAgent || monitoredAgent.name !== targetName) return;

      let supervisorData = { latest: null, state: {} };
      let supervisorStatus = { enabled: null, runtime: { running: null } };
      try {
        if (supervisorRespRaw.status === 'fulfilled' && supervisorRespRaw.value.ok) {
          const payload = await supervisorRespRaw.value.json();
          if (payload && typeof payload === 'object') supervisorData = payload;
        }
      } catch (e) {
        console.debug('[agent-detail] supervisor detail fetch skipped:', e.message);
      }
      try {
        if (supervisorStatusRaw.status === 'fulfilled' && supervisorStatusRaw.value.ok) {
          const payload = await supervisorStatusRaw.value.json();
          if (payload && typeof payload === 'object') supervisorStatus = payload;
        }
      } catch (e) {
        console.debug('[agent-detail] supervisor status fetch skipped:', e.message);
      }
      const statusSnap = agentStatusList.find(x => x.name === targetName) || {};
      const activeNow = typeof statusSnap.activeNow === 'boolean'
        ? statusSnap.activeNow
        : (typeof d.active === 'boolean' ? d.active : false);
      const activeDurationSec = toNonNegInt(
        statusSnap.activeDurationSec !== undefined ? statusSnap.activeDurationSec : d.activeDurationSec,
        0
      );
      const idleDurationSec = toNonNegInt(
        statusSnap.idleDurationSec !== undefined ? statusSnap.idleDurationSec : d.idleDurationSec,
        0
      );
      const latestEval = supervisorData.latest && typeof supervisorData.latest === 'object'
        ? supervisorData.latest
        : null;
      const latestStatus = String(latestEval?.status || '').trim();
      const parts = [];
      if (d.agentType) {
        const cls = d.agentType === 'claude' ? 'ai-tag-claude' : 'ai-tag-codex';
        parts.push('<span class="ai-tag ' + cls + '">' + esc(d.agentType.toUpperCase()) + '</span>');
      }
      parts.push('<span class="ai-tag ' + (activeNow ? 'ai-tag-active' : 'ai-tag-inactive') + '" id="ai-runtime-state">'
        + esc(runtimeStatusText(activeNow, activeDurationSec, idleDurationSec)) + '</span>');
      const currentSupervisorIssue = hasCurrentSupervisorIssue(supervisorData.state || {});
      const showCurrentSupervisorWarning = latestStatus && currentSupervisorIssue;
      if (latestStatus && showCurrentSupervisorWarning) {
        const auditCls = latestStatus === 'FOCUSED'
          ? 'ai-tag-focused'
          : ((latestStatus === 'DRIFTING' || latestStatus === 'LOST' || latestStatus === 'STUCK') ? 'ai-tag-alert' : 'ai-tag-neutral');
        parts.push('<span class="ai-tag ' + auditCls + '">' + esc(latestStatus) + '</span>');
      }
      if (d.v1) parts.push('<span class="ai-tag ai-tag-neutral">V1 HOME</span>');
      parts.push('<span class="ai-tag ' + (d.subconsciousEnabled ? 'ai-tag-focused' : 'ai-tag-inactive') + '">'
        + esc(d.subconsciousEnabled ? 'SUBCONSCIOUS ON' : 'SUBCONSCIOUS OFF') + '</span>');
      parts.push('<br>');
      parts.push('<div class="ai-identity">' + esc(d.identity || '(no identity)') + '</div>');
      const supervisorEnabled = supervisorStatus?.enabled === true;
      const supervisorRunning = supervisorStatus?.runtime?.running === true;
      if (latestEval && latestStatus && latestStatus !== 'FOCUSED' && (showCurrentSupervisorWarning || ((supervisorEnabled || supervisorRunning) && currentSupervisorIssue))) {
        const reasonText = String(latestEval.reason || '').trim() || 'Supervisor raised a non-focused state.';
        const domainText = String(latestEval.domain || '').trim();
        const patternText = String(latestEval.pattern || '').trim();
        parts.push('<div class="ai-warning">'
          + '<div class="ai-warning-title">Supervisor Warning</div>'
          + '<div class="ai-warning-body">' + esc(reasonText)
          + ((domainText || patternText) ? ('<br>' + esc([domainText, patternText].filter(Boolean).join(' · '))) : '')
          + '</div></div>');
      } else {
      }
      parts.push('<div class="ai-action-row">'
        + '<button class="ai-audit-btn" onclick="openAuditPage()">Open Agent Detail</button>'
        + '<div class="ai-action-spacer"></div>'
        + '<button class="ai-down-btn" id="ai-down-btn" onclick="downAgent()">Stop Agent</button>'
        + '<div style="width:12px"></div>'
        + '<button class="ai-delete-btn" id="ai-delete-btn" onclick="deleteAgent()">Remove Agent</button>'
        + '</div>');
      if (requestSeq !== agentDetailRequestSeq) return;
      if (!monitoredAgent || monitoredAgent.name !== targetName) return;
      agentInfoEl.innerHTML = parts.join('');
      agentInfoEl.classList.add('visible');
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      console.error('fetchAgentDetail error:', e);
      if (requestSeq !== agentDetailRequestSeq) return;
      if (!monitoredAgent || monitoredAgent.name !== targetName) return;
      showAgentDetailError(targetName, 'Summary unavailable. Refresh or reopen the panel.');
    } finally {
      if (requestSeq === agentDetailRequestSeq && agentDetailAbortController === controller) {
        agentDetailAbortController = null;
      }
    }
  }

  window.openAuditPage = function() {
    if (!monitoredAgent || !monitoredAgent.name) return;
    const url = '/agents/' + encodeURIComponent(monitoredAgent.name);
    window.location.href = url;
  };

  let rootDangerMode = null;

  function showActionToast(text) {
    const toast = document.getElementById('delete-toast');
    toast.textContent = text;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 1500);
  }

  function clearMonitoredAgentView() {
    monitoredAgent = null;
    monitorPaused = true;
    monitorLabelEl.textContent = '';
    monitorEmptyEl.style.display = '';
    terminalWrapEl.classList.add('hidden');
    btnPause.style.display = 'none';
    if (btnSpeed) btnSpeed.style.display = 'none';
    if (btnAudit) btnAudit.style.display = 'none';
    btnScrollBottom.style.display = 'none';
    agentInfoEl.classList.remove('visible');
    agentInfoEl.innerHTML = '';
    fetchAgentStatus();
  }

  window.downAgent = function() {
    if (!monitoredAgent) return;
    rootDangerMode = 'down';
    document.getElementById('root-confirm-title').textContent = 'Stop Agent';
    document.getElementById('root-confirm-copy').textContent = 'This will stop the agent session for "' + monitoredAgent.name + '" and mark it offline. Continue?';
    const cta = document.getElementById('root-confirm-cta');
    cta.textContent = 'Stop Agent';
    cta.className = 'root-modal-btn warn';
    cta.disabled = false;
    document.getElementById('root-confirm-modal').classList.remove('hidden');
  };

  window.deleteAgent = function() {
    if (!monitoredAgent) return;
    rootDangerMode = 'delete';
    document.getElementById('root-confirm-title').textContent = 'Remove Agent';
    document.getElementById('root-confirm-copy').textContent = 'This permanently removes the agent entry for "' + monitoredAgent.name + '". This cannot be undone. Continue?';
    const cta = document.getElementById('root-confirm-cta');
    cta.textContent = 'Remove Agent';
    cta.className = 'root-modal-btn danger';
    cta.disabled = false;
    document.getElementById('root-confirm-modal').classList.remove('hidden');
  };

  window.closeRootModal = function() {
    rootDangerMode = null;
    document.getElementById('root-confirm-modal').classList.add('hidden');
  };

  window.confirmRootAction = async function() {
    if (!rootDangerMode || !monitoredAgent) return;
    const cta = document.getElementById('root-confirm-cta');
    cta.disabled = true;
    const name = monitoredAgent.name;
    try {
      if (rootDangerMode === 'down') {
        cta.textContent = 'Stopping...';
        const r = await fetch('/api/agents/' + encodeURIComponent(name) + '/down', { method: 'POST' });
        const d = await r.json().catch(() => null);
        if (!r.ok || !d || !d.ok) throw new Error((d && (d.detail || d.error)) || 'stop failed');
        showActionToast('STOPPED: ' + name);
      } else {
        cta.textContent = 'Removing...';
        const r = await fetch('/api/agents/' + encodeURIComponent(name) + '?force=true', { method: 'DELETE' });
        const d = await r.json().catch(() => null);
        if (!r.ok || !d || !d.ok) throw new Error((d && (d.detail || d.error)) || 'remove failed');
        showActionToast('REMOVED: ' + name);
      }
      closeRootModal();
      clearMonitoredAgentView();
    } catch (e) {
      cta.textContent = 'Failed: ' + e.message;
      setTimeout(() => closeRootModal(), 2000);
    }
  };

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && rootDangerMode) closeRootModal();
  });

  let terminalEtag = null;
  let terminalFetching = false;
  async function fetchTerminal() {
    if (!monitoredAgent || monitorPaused || terminalFetching) return;
    terminalFetching = true;
    try {
      let url = '/api/tmux/capture/' + encodeURIComponent(monitoredAgent.tmux);
      if (monitoredAgent.remote && monitoredAgent.server) {
        url += '?server=' + encodeURIComponent(monitoredAgent.server);
      }
      const headers = {};
      if (terminalEtag) headers['If-None-Match'] = terminalEtag;
      const res = await fetch(url, { headers });
      if (res.status === 304) { terminalFetching = false; return; }
      const etag = res.headers.get('ETag');
      if (etag) terminalEtag = etag;
      const text = await res.text();
      const wasAtBottom = terminalEl.scrollTop + terminalEl.clientHeight >= terminalEl.scrollHeight - 30;
      terminalEl.textContent = text;
      if (wasAtBottom) terminalEl.scrollTop = terminalEl.scrollHeight;
    } catch (e) {
      console.error('fetchTerminal error:', e);
      terminalEl.textContent = '[Error fetching terminal: ' + e.message + ']';
    }
    terminalFetching = false;
  }

  function scheduleTerminalPoll() {
    if (terminalPollTimer) clearTimeout(terminalPollTimer);
    const waitMs = document.hidden
      ? TERMINAL_POLL_HIDDEN_MS
      : (terminalTurboMode ? TERMINAL_POLL_TURBO_MS : TERMINAL_POLL_VISIBLE_MS);
    terminalPollTimer = setTimeout(async () => {
      terminalPollTimer = null;
      if (monitoredAgent && !monitorPaused) await fetchTerminal();
      scheduleTerminalPoll();
    }, waitMs);
  }

  function renderAgentButtons(agents) {
    agentStatusList = agents;
    // Hide dead agents entirely
    agents = agents.filter(a => a.alive !== false);
    const selectedName = monitoredAgent?.name;
    if (agents.length === 0) {
      agentButtonsEl.innerHTML = '<span style="color:rgba(0,240,255,0.2);font-size:10px">no known agents</span>';
      return;
    }
    // Sort:
    // 1) local before remote
    // 2) active before idle
    // 3) among idle, smaller idleDurationSec first (more recently active first)
    // 4) tie-break with lastTmuxActivitySec desc, then name asc
    agents.sort((a, b) => {
      const tierOf = x => {
        if (x.remote) return 2;           // remote
        return 0;                         // local alive/idle
      };
      const ta = tierOf(a), tb = tierOf(b);
      if (ta !== tb) return ta - tb;

      const aActive = typeof a.activeNow === 'boolean' ? a.activeNow : !!a.active;
      const bActive = typeof b.activeNow === 'boolean' ? b.activeNow : !!b.active;
      if (aActive !== bActive) return aActive ? -1 : 1;

      if (!aActive && !bActive) {
        const aIdle = toNonNegInt(a.idleDurationSec, Number.MAX_SAFE_INTEGER);
        const bIdle = toNonNegInt(b.idleDurationSec, Number.MAX_SAFE_INTEGER);
        if (aIdle !== bIdle) return aIdle - bIdle;
      }

      const aLast = toNonNegInt(a.lastTmuxActivitySec, 0);
      const bLast = toNonNegInt(b.lastTmuxActivitySec, 0);
      if (aLast !== bLast) return bLast - aLast;

      return a.name.localeCompare(b.name);
    });
    const envOrder = ['live', 'dev', 'benchmark', 'ephemeral'];
    const envLabels = { live: 'Live', dev: 'Dev', benchmark: 'Benchmark', ephemeral: 'Ephemeral' };
    const envGroups = {};
    for (const a of agents) { const e = a.environment || 'live'; (envGroups[e] || (envGroups[e] = [])).push(a); }
    function agentBtnHtml(a) {
      const isRemote = a.remote;
      const isActive = typeof a.activeNow === 'boolean' ? a.activeNow : !!a.active;
      const isSupervisor = a.name.startsWith('supervisor-');
      const dot = isRemote ? '&#9826;' : (isActive ? '&#9679;' : '&#9675;');
      const cls = ['agent-btn', isRemote ? 'remote-agent' : (isActive ? 'active-agent' : 'inactive-agent'), isRemote && a.alive ? 'alive' : '', a.name === selectedName ? 'selected' : ''].filter(Boolean).join(' ');
      const supBadge = isSupervisor ? '<span style="font-size:8px;opacity:0.6;margin-left:4px;vertical-align:middle">SUP</span>' : '';
      const targetName = isSupervisor ? a.name.replace(/^supervisor-/, '') : '';
      return '<button class="' + cls + '" data-name="' + esc(a.name) + '" data-tmux="' + esc(a.tmux || '') + '"'
        + (targetName ? ' data-sup-target="' + esc(targetName) + '"' : '') + '>'
        + '<span class="dot">' + dot + '</span>' + esc(a.name) + supBadge + '</button>';
    }
    let html = '';
    for (const env of envOrder) {
      const group = envGroups[env];
      if (!group || group.length === 0) continue;
      const activeCount = group.filter(a => a.remote ? a.alive : (typeof a.activeNow === 'boolean' ? a.activeNow : !!a.active)).length;
      html += '<div class="agent-group-label">' + esc(envLabels[env]) + '<span class="agent-group-count">' + activeCount + ' active / ' + group.length + '</span></div>';
      html += group.map(agentBtnHtml).join('');
    }
    if (agentButtonsEl._lastHtml === html) return;
    agentButtonsEl._lastHtml = html;
    agentButtonsEl.innerHTML = html;
    for (const btn of agentButtonsEl.querySelectorAll('.agent-btn')) {
      btn.addEventListener('click', () => {
        const supTarget = btn.dataset.supTarget;
        if (supTarget) {
          const target = agentStatusList.find(x => x.name === supTarget);
          if (target && target.tmux) { selectAgent(target); return; }
        }
        const agent = agentStatusList.find(x => x.name === btn.dataset.name);
        if (agent && agent.tmux) selectAgent(agent);
      });
    }
    updateAgentToggle();
  }

  async function fetchAgentStatus(_reason = 'poll') {
    try {
      const res = await fetch('/api/agents/status');
      if (!res.ok) return;
      const rows = await res.json();
      const now = Date.now();
      const normalized = rows.map(row => ({
        ...row,
        activeNow: typeof row.activeNow === 'boolean' ? row.activeNow : !!row.active,
        activeDurationSec: toNonNegInt(row.activeDurationSec, 0),
        idleDurationSec: toNonNegInt(row.idleDurationSec, 0),
        _localTickAt: now,
      }));
      renderAgentButtons(normalized);
      updateSelectedRuntimeBadge();
      lastStatusSyncAt = now;
    } catch (e) {
      console.debug('[agent-status] status fetch skipped:', e.message);
    }
  }

  function tickAgentDurationsLocal() {
    if (!agentStatusList.length) return;
    const now = Date.now();
    let switched = false;
    for (const a of agentStatusList) {
      const last = Number(a._localTickAt) || now;
      const deltaSec = Math.floor((now - last) / 1000);
      if (deltaSec <= 0) continue;
      a._localTickAt = last + deltaSec * 1000;

      if (typeof a.idleMs === 'number' && a.idleMs >= 0) {
        a.idleMs += deltaSec * 1000;
      }

      const wasActive = !!a.activeNow;
      if (wasActive) {
        a.activeDurationSec = toNonNegInt(a.activeDurationSec, 0) + deltaSec;
        a.idleDurationSec = 0;
        if (typeof a.idleMs === 'number' && a.idleMs >= IDLE_THRESHOLD_MS) {
          a.activeNow = false;
          a.active = false;
          a.activeDurationSec = 0;
          a.idleDurationSec = 0;
          switched = true;
        }
      } else {
        a.activeNow = false;
        a.active = false;
        a.activeDurationSec = 0;
        a.idleDurationSec = toNonNegInt(a.idleDurationSec, 0) + deltaSec;
      }
    }
    updateSelectedRuntimeBadge();
    if (switched) scheduleStatusSyncSoon('state-switch');
  }

  // ── SSE ─────────────────────────────────────
  function connectSSE() {
    const evtSource = new EventSource('/api/stream');
    evtSource.onmessage = (e) => {
      try { addLogEntry(JSON.parse(e.data)); } catch (err) {
        console.debug('[sse] message parse skipped:', err.message);
      }
    };
    evtSource.addEventListener('queue', (e) => {
      try { queueItems = JSON.parse(e.data); requestQueueRender(false); } catch (err) {
        console.debug('[sse] queue parse skipped:', err.message);
      }
    });
    evtSource.addEventListener('reminders', (e) => {
      try { reminderItems = JSON.parse(e.data); renderReminderPanel(); } catch (err) {
        console.debug('[sse] reminders parse skipped:', err.message);
      }
    });
    for (const evt of ['task_created', 'task_updated', 'task_deleted']) {
      evtSource.addEventListener(evt, () => {
        if (typeof activeTab !== 'undefined' && activeTab === 'tasks' && typeof taskListRefresh === 'function') {
          taskListRefresh();
        }
      });
    }
  }

  // ── Init ────────────────────────────────────
  async function init() {
    // Load recent messages for log
    try {
      const res = await fetch('/api/messages');
      const msgs = await res.json();
      for (const msg of msgs.slice(-50)) addLogEntry(msg);
    } catch (e) { console.error('messages load failed:', e); }
    // Initial state
    try { const r = await fetch('/api/queue'); queueItems = await r.json(); requestQueueRender(true); } catch (e) {
      console.debug('[init] queue load skipped:', e.message);
    }
    try { const r = await fetch('/api/reminders'); reminderItems = await r.json(); renderReminderPanel(); } catch (e) {
      console.debug('[init] reminders load skipped:', e.message);
    }
    await fetchAgentStatus('init');
    statusPollTimer = setInterval(() => {
      if (!document.hidden) fetchAgentStatus('poll');
    }, STATUS_SYNC_INTERVAL_MS);
    durationTickTimer = setInterval(() => {
      if (!document.hidden) tickAgentDurationsLocal();
    }, DURATION_TICK_VISIBLE_MS);
    scheduleTerminalPoll();
    scheduleDetailRefresh();
    connectSSE();
    // Alert badge
    async function refreshAlertBadge(){
      try{
        const r=await fetch('/api/alerts/stats');
        if(!r.ok)return;
        const s=await r.json();
        const open=(s.byStatus.open||0)+(s.byStatus.acknowledged||0)+(s.byStatus.assigned||0);
        const crit=s.bySeverity.critical||0;
        const badge=document.getElementById('alert-badge');
        if(badge){
          if(open>0){badge.style.display='inline';badge.textContent='\\u26a0 '+open+' alert'+(open>1?'s':'')+(crit?' ('+crit+' crit)':'');}
          else{badge.style.display='none'}
        }
      }catch{}
    }
    refreshAlertBadge();
    setInterval(refreshAlertBadge,30000);
  }

  // ── Mobile panel toggle ─────────────────────
  const mobileBackdrop = document.getElementById('mobile-backdrop');
  const mobileFabQueue = document.getElementById('mobile-fab-queue');
  const mobileFabReminder = document.getElementById('mobile-fab-reminder');

  window.toggleMobilePanel = function(which) {
    const qp = document.getElementById('queue-panel');
    const rc = document.getElementById('right-col');
    if (which === 'queue') {
      const opening = !qp.classList.contains('mobile-open');
      rc.classList.remove('mobile-open');
      qp.classList.toggle('mobile-open');
      mobileBackdrop.classList.toggle('active', opening);
    } else {
      const opening = !rc.classList.contains('mobile-open');
      qp.classList.remove('mobile-open');
      rc.classList.toggle('mobile-open');
      mobileBackdrop.classList.toggle('active', opening);
    }
  };
  window.closeMobilePanels = function() {
    document.getElementById('queue-panel').classList.remove('mobile-open');
    document.getElementById('right-col').classList.remove('mobile-open');
    mobileBackdrop.classList.remove('active');
  };

  // Update FAB dot indicators when queue/reminder have items
  function updateMobileFabs() {
    if (document.hidden) return;
    mobileFabQueue.classList.toggle('has-count', queueItems.length > 0);
    mobileFabReminder.classList.toggle('has-count', reminderItems.length > 0);
  }
  setInterval(updateMobileFabs, 2000);

  document.addEventListener('visibilitychange', () => {
    document.body.classList.toggle('page-hidden', document.hidden);
    if (statusPollTimer) {
      clearInterval(statusPollTimer);
      statusPollTimer = setInterval(() => {
        if (!document.hidden) fetchAgentStatus('poll');
      }, document.hidden ? STATUS_SYNC_INTERVAL_HIDDEN_MS : STATUS_SYNC_INTERVAL_MS);
    }
    if (durationTickTimer) {
      clearInterval(durationTickTimer);
      durationTickTimer = setInterval(() => {
        if (!document.hidden) tickAgentDurationsLocal();
      }, document.hidden ? DURATION_TICK_HIDDEN_MS : DURATION_TICK_VISIBLE_MS);
    }
    scheduleTerminalPoll();
    scheduleDetailRefresh();
    if (!document.hidden) {
      requestQueueRender(true);
      renderReminderPanel();
      updateMobileFabs();
      fetchAgentStatus('visibility').catch(() => {});
      if (monitoredAgent) fetchAgentDetail(monitoredAgent.name, { preserveVisible: true });
      if (monitoredAgent && !monitorPaused) fetchTerminal();
    }
  });

  init();
})();
</script>
</body>
</html>`;
}
