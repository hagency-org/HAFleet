'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import TaskList from '@/components/TaskList';
import { Toast, useToast } from '@/components/Toast';
import { agentLog, board, presets, runtimeStatusText, tasks } from '@/lib/mock-data';

/*
 * Seven tabs, not six. `Configuration` was doing two unrelated jobs and splits into
 * Profile (who this agent is) and Runtime (how it is launched and what shapes it).
 * `Oversight` is READ-ONLY: controls must not sit beside the evidence used to judge
 * them. Both decisions come from the codex content map.
 *
 * ARIA is the full contract, not the `role="tab"` veneer that round 2 called fake:
 * tablist / tab / tabpanel, aria-selected, aria-controls, aria-labelledby, and a
 * roving tabindex driven by Left/Right/Home/End.
 */

const TABS = [
  { id: 'activity', label: 'Activity' },
  { id: 'work', label: 'Work' },
  { id: 'messages', label: 'Messages' },
  { id: 'repos', label: 'Repos' },
  { id: 'profile', label: 'Profile' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'oversight', label: 'Oversight' },
];

export default function AgentTabs({ agent }) {
  const [active, setActive] = useState('activity');
  const [toast, say] = useToast();
  const refs = useRef([]);

  // Selection mirrors the hash so a link and the Back button both work.
  useEffect(() => {
    const fromHash = window.location.hash.replace('#', '');
    if (TABS.some((t) => t.id === fromHash)) setActive(fromHash);
  }, []);

  function select(id, focus = false) {
    setActive(id);
    if (typeof window !== 'undefined') history.replaceState(null, '', `#${id}`);
    if (focus) {
      const i = TABS.findIndex((t) => t.id === id);
      refs.current[i]?.focus();
    }
  }

  function onKeyDown(e) {
    const i = TABS.findIndex((t) => t.id === active);
    if (e.key === 'ArrowRight') { e.preventDefault(); select(TABS[(i + 1) % TABS.length].id, true); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); select(TABS[(i - 1 + TABS.length) % TABS.length].id, true); }
    if (e.key === 'Home') { e.preventDefault(); select(TABS[0].id, true); }
    if (e.key === 'End') { e.preventDefault(); select(TABS[TABS.length - 1].id, true); }
  }

  return (
    <>
      <div className="tabs" role="tablist" aria-label={`${agent.name} sections`} onKeyDown={onKeyDown}>
        {TABS.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => { refs.current[i] = el; }}
            role="tab"
            id={`tab-${t.id}`}
            className="tab"
            aria-selected={active === t.id}
            aria-controls={`panel-${t.id}`}
            /* Roving tabindex: only the selected tab is in the tab order. */
            tabIndex={active === t.id ? 0 : -1}
            onClick={() => select(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`panel-${active}`} aria-labelledby={`tab-${active}`}>
        {active === 'activity' && <Activity agent={agent} />}
        {active === 'work' && <Work agent={agent} onSay={say} />}
        {active === 'messages' && <Messages agent={agent} />}
        {active === 'repos' && <Repos agent={agent} />}
        {active === 'profile' && <Profile agent={agent} onSay={say} />}
        {active === 'runtime' && <Runtime agent={agent} onSay={say} />}
        {active === 'oversight' && <Oversight agent={agent} />}
      </div>

      <Toast toast={toast} />
    </>
  );
}

/* ── Activity ─────────────────────────────────────────────────────────────
 * Three sources, because there is no single one:
 *   tmux  -> GET /api/tmux/capture/:session      (exists today)
 *   acp   -> tail of the supervisor's per-agent log   (file exists; needs one endpoint)
 *   none  -> empty state naming why
 *
 * Round 1 designed a Terminal tab for agents with no pane. Round 2 replaced it with
 * an "ACP session stream" that also does not exist — the ACP host runs no HTTP
 * server. This is the honest third answer.
 */
function Activity({ agent }) {
  const [showFramework, setShowFramework] = useState(false);
  const src = agentLog[agent.name] ?? { source: 'none', lines: [] };
  const isPane = src.source === 'pane';

  return (
    <>
      <div className="notice">
        {isPane ? (
          <>
            <strong>Terminal pane</strong> — captured from <code>{agent.tmux}</code> via{' '}
            <code>/api/tmux/capture</code>. This is the live screen, so it is the ground truth for
            what the agent is doing.
          </>
        ) : (
          <>
            <strong>Agent log</strong> — this agent has no terminal pane, so this is the
            supervisor&apos;s log for it, not a full work history. ANSI colour codes are stripped and
            framework output is collapsed.
          </>
        )}
      </div>

      {isPane ? (
        <div className="log" style={{ marginTop: 12 }}>
          <div className="dim">
            {'$ '}hafleet · pane {agent.tmux}
          </div>
          <div className="faint" style={{ marginTop: 8 }}>
            The prototype does not proxy a live pane. In the product this is the existing
            terminal surface, with its ETag reuse, request sequencing, visibility-aware poll
            rates and auto-scroll preservation carried over unchanged.
          </div>
        </div>
      ) : src.lines.length === 0 ? (
        <div className="empty">
          <div className="big">No activity yet</div>
          <p className="small">
            No pane and no log for this agent. If it was never started, bring it up with{' '}
            <code>hafleet acp-up</code>.
          </p>
        </div>
      ) : (
        <div className="log" style={{ marginTop: 12 }}>
          {src.lines.map((l, i) =>
            l.kind === 'framework' ? (
              <div key={i}>
                <button className="log-fold" onClick={() => setShowFramework((v) => !v)}
                  aria-expanded={showFramework}>
                  {showFramework ? '▾' : '▸'} {l.collapsed} lines of framework output
                </button>
                {showFramework && (
                  <div className="faint" style={{ paddingLeft: 18 }}>
                    {'INFO connection: calling LLM iteration=3'}<br />
                    {'INFO connection: LLM response received iteration=3'}<br />
                    {'INFO connection: all tools in batch completed'}<br />
                    <span style={{ opacity: 0.7 }}>…9 more, ANSI stripped</span>
                  </div>
                )}
              </div>
            ) : (
              <div className="log-row" key={i}>
                <span className="t">{l.at}</span>
                <span className={`k ${l.kind}`}>{l.kind}</span>
                <span>{l.text}</span>
              </div>
            ),
          )}
        </div>
      )}
    </>
  );
}

/* ── Work — the same TaskList, scoped. Not a fork. ─────────────────────── */
function Work({ agent, onSay }) {
  return (
    <>
      <div className="notice">
        Scoped to <strong>{agent.name}</strong>. Same records and same renderer as{' '}
        <Link href="/tasks">all fleet tasks</Link> — Work is a scope, not a separate system.
      </div>
      <div style={{ marginTop: 12 }}>
        <TaskList
          tasks={tasks}
          scope={{ status: 'open', assignee: 'all', priority: 'all', q: '' }}
          lockedAssignee={agent.name}
          onSay={onSay}
        />
      </div>
    </>
  );
}

function Messages({ agent }) {
  const msgs = [
    { at: '01:22', dir: 'in', from: 'system', type: 'request', text: 'Reply with exactly PARITY2.' },
    { at: '01:22', dir: 'out', to: 'system', type: 'reply', text: 'PARITY2' },
    { at: '00:38', dir: 'in', from: 'system', type: 'request', text: 'Reply with exactly HERMES-LIVE.' },
  ];
  return (
    <>
      <div className="notice">
        Direct messages to and from <strong>{agent.name}</strong>. A <code>task</code> is work to do;
        a <code>request</code> or <code>human</code> message is someone waiting for an answer, and
        only those get a reply instruction.
      </div>
      <div className="tbl-wrap" style={{ marginTop: 12 }}>
        <table className="tbl">
          <thead><tr><th>When</th><th>Direction</th><th>Type</th><th>Message</th></tr></thead>
          <tbody>
            {msgs.map((m, i) => (
              <tr key={i}>
                <td className="dim">{m.at}</td>
                <td>{m.dir === 'in' ? `from ${m.from}` : `to ${m.to}`}</td>
                <td><span className="badge">{m.type}</span></td>
                <td>{m.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ── Repos — the per-agent lens, linking to the fleet board ────────────── */
function Repos({ agent }) {
  return (
    <>
      <div className="notice">
        Repositories bound into this agent&apos;s home. The fleet-wide view, with worktrees, specs
        and change requests, is the <Link href="/projects">project board</Link> — this is a lens on
        it, not a replacement.
      </div>
      <div className="tbl-wrap" style={{ marginTop: 12 }}>
        <table className="tbl">
          <thead><tr><th>Repo</th><th>Binding</th><th>Branch</th><th>State</th></tr></thead>
          <tbody>
            {board.repos.slice(0, 3).map((r) => (
              <tr key={r.repo}>
                <td>{r.repo}</td>
                <td className="dim">{r.repo.includes('infra') ? 'symlink' : 'copy'}</td>
                <td className="dim">{r.branch}</td>
                <td>
                  <span className={`badge${r.state === 'dirty' ? ' attention' : ' ok'}`}>{r.state}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="dim" style={{ fontSize: 12, marginTop: 10 }}>
        <strong>copy</strong> means edits stay here. <strong>symlink</strong> means edits land in the
        source repo — worth knowing before committing.
      </p>
    </>
  );
}

/* ── Profile — who is this agent ───────────────────────────────────────── */
function Profile({ agent, onSay }) {
  return (
    <>
      <div className="panel">
        <h3>Identity</h3>
        <dl className="kv">
          <dt>Name</dt><dd>{agent.name}</dd>
          <dt>Environment</dt><dd>{agent.environment}</dd>
          <dt>Created</dt><dd className="dim">2026-08-02</dd>
        </dl>
      </div>
      <div className="panel">
        <h3>Guidance</h3>
        <textarea
          rows={4}
          defaultValue={'Prefer small, reviewable changes. Verify from the path you edited, not a copy of it.'}
          style={{
            width: '100%', font: '400 12.5px var(--sans)', padding: 8,
            border: '1px solid var(--line)', borderRadius: 5, resize: 'vertical',
          }}
        />
        <p className="faint" style={{ fontSize: 11 }}>
          Unsaved edits survive the periodic refresh — the refresh skips this panel while it is
          dirty rather than overwriting what you are typing.
        </p>
      </div>
      <div className="panel">
        <h3>Ownership</h3>
        <dl className="kv">
          <dt>Owner</dt><dd>operator</dd>
          <dt>Escalation</dt><dd className="dim">none configured</dd>
        </dl>
      </div>
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn primary" onClick={() => onSay('ok', 'Profile saved')}>Save profile</button>
        <span className="faint" style={{ fontSize: 11.5 }}>
          One save covers identity, guidance and ownership.
        </span>
      </div>
    </>
  );
}

/* ── Runtime — how it is launched, and what shapes it ──────────────────── */
function Runtime({ agent, onSay }) {
  const preset = presets.find((p) => p.framework === agent.framework);
  return (
    <>
      <div className="panel">
        <h3>Effective runtime</h3>
        <dl className="kv">
          <dt>Framework</dt><dd>{agent.framework}</dd>
          <dt>Transport</dt><dd>{agent.transport}</dd>
          <dt>Pane</dt><dd>{agent.tmux ?? <span className="dim">none — ACP agents have no pane</span>}</dd>
          <dt>Model</dt><dd>{preset?.model ?? <span className="dim">provider default</span>}</dd>
          <dt>Workspace</dt><dd className="dim">~/{agent.name.replace('-agent', '')}-ws</dd>
        </dl>
      </div>
      <div className="panel">
        <h3>Framework preset</h3>
        <dl className="kv">
          <dt>Applied</dt><dd>{preset?.name ?? <span className="dim">none</span>}</dd>
          <dt>Resolved model</dt><dd>{preset?.model ?? '—'}</dd>
        </dl>
        <p className="faint" style={{ fontSize: 11.5, marginTop: 8 }}>
          Global preset management is on <Link href="/config">Config</Link>. Changing a preset does
          not alter a running agent.
        </p>
      </div>
      <div className="panel">
        <h3>Roles</h3>
        <dl className="kv">
          <dt>Primary</dt><dd>engineer</dd>
          <dt>Supervisor</dt><dd className="dim">not a supervisor</dd>
        </dl>
      </div>
      <div className="panel">
        <h3>Supervisor control</h3>
        <dl className="kv">
          <dt>Enabled</dt><dd>yes</dd>
          <dt>Cadence</dt><dd>every 15m</dd>
        </dl>
      </div>
      <div className="panel">
        <h3>Guidance path (subconscious)</h3>
        <dl className="kv">
          <dt>Mode</dt><dd>authoritative</dd>
          <dt>Provider</dt><dd>{agent.framework === 'hermes' ? 'deepseek' : 'inherit'}</dd>
          <dt>Key</dt>
          <dd>
            <code>DEEPSEEK_API_KEY</code>{' '}
            <span className="badge ok">resolved</span>
            <div className="faint" style={{ fontSize: 11 }}>
              The reference is shown, never the value.
            </div>
          </dd>
        </dl>
      </div>
      <div className="panel">
        <h3>Workspace migration</h3>
        <div className="notice warn">
          Disruptive. Moves this agent&apos;s home to the current layout and restarts it. Preview
          first; the outcome is reported when it completes.
        </div>
        <div className="btn-row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={() => onSay('ok', 'Preview: 3 files would move, 0 conflicts')}>
            Preview migration
          </button>
        </div>
      </div>
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn primary" onClick={() => onSay('ok', 'Runtime saved')}>Save runtime</button>
        <button className="btn" onClick={() => onSay('ok', 'Supervisor settings saved')}>Save supervisor</button>
        <span className="faint" style={{ fontSize: 11.5 }}>Saved per subsystem, not all at once.</span>
      </div>
    </>
  );
}

/* ── Oversight — read only. No controls. ──────────────────────────────── */
function Oversight({ agent }) {
  return (
    <>
      <div className="notice">
        Read-only. Every control that could change what you see here lives on{' '}
        <strong>Runtime</strong> — judgement and the levers that affect it are kept apart on purpose.
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <h3>Current assessment</h3>
        <dl className="kv">
          <dt>Signal</dt>
          <dd>
            {agent.activeNow
              ? <span className="badge ok">healthy</span>
              : <span className="badge">idle, no concern</span>}
          </dd>
          <dt>Reason</dt>
          <dd className="dim">
            {agent.activeNow
              ? 'Turn in progress, tools completing normally.'
              : `Idle ${runtimeStatusText(agent).replace('IDLE ', '')} with no unread work.`}
          </dd>
          <dt>Evaluated</dt><dd className="dim">42s ago</dd>
          <dt>Recommended</dt><dd>no action</dd>
        </dl>
      </div>

      <div className="panel">
        <h3>Current work evidence</h3>
        <p className="faint" style={{ fontSize: 11.5 }}>
          A snapshot of the agent&apos;s own docs. <strong>Not</strong> the canonical task record — for
          that, use <Link href="/tasks">Tasks</Link>.
        </p>
        <div className="log" style={{ marginTop: 8 }}>
          <div className="dim">progress.md · captured 6m ago</div>
          <div style={{ marginTop: 6 }}>Wired the rail; seven pages building. Next: contract tests.</div>
        </div>
      </div>

      <div className="panel">
        <h3>Guidance path status</h3>
        <dl className="kv">
          <dt>Active path</dt><dd>authoritative</dd>
          <dt>Stage</dt><dd className="dim">idle</dd>
          <dt>Last injection</dt><dd className="dim">18m ago</dd>
        </dl>
      </div>

      <div className="panel">
        <h3>Recent supervisor decisions</h3>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>When</th><th>Decision</th><th>Reason</th></tr></thead>
            <tbody>
              <tr><td className="dim">42s ago</td><td>no action</td><td className="dim">healthy</td></tr>
              <tr><td className="dim">15m ago</td><td>no action</td><td className="dim">healthy</td></tr>
              <tr><td className="dim">4h ago</td><td>recycled session</td><td className="dim">prompt timed out at 600s</td></tr>
            </tbody>
          </table>
        </div>
        <p className="faint" style={{ fontSize: 11.5, marginTop: 8 }}>
          This and the full audit history are two views of one event collection, not two records.
        </p>
      </div>
    </>
  );
}
