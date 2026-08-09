'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Toast, useToast } from '@/components/Toast';
import { agentLog, runtimeStatusText, fmtTokens } from '@/lib/mock-data';
import { useData } from '@/components/Data';
import { useT } from '@/components/Prefs';

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

// Ids, not labels: the id is the URL hash and must not change with the language,
// while the visible word must. Keeping them in one list keeps the two in step.
/*
 * Four tabs, down from seven. `work`, `messages` and `repos` answered a
 * dispatcher's questions — which task, what queue, which repositories — and this
 * console has no dispatcher. A contributor asks: what does this agent contribute
 * (runtime), is it alive (activity), how is it being judged (oversight), and who
 * is it (profile). Runtime leads because it IS the L1 detail page: the model, the
 * preset, and whether that preset was applied or inherited.
 */
const TABS = ['runtime', 'activity', 'oversight', 'profile'];

export default function AgentTabs({ agent }) {
  const { presets, presetOf, tierOf } = useData();
  const t = useT();
  const [active, setActive] = useState('activity');
  const [toast, say] = useToast();
  const refs = useRef([]);

  // Selection mirrors the hash so a link and the Back button both work.
  useEffect(() => {
    const fromHash = window.location.hash.replace('#', '');
    if (TABS.includes(fromHash)) setActive(fromHash);
  }, []);

  function select(id, focus = false) {
    setActive(id);
    if (typeof window !== 'undefined') history.replaceState(null, '', `#${id}`);
    if (focus) {
      const i = TABS.indexOf(id);
      refs.current[i]?.focus();
    }
  }

  function onKeyDown(e) {
    const i = TABS.indexOf(active);
    if (e.key === 'ArrowRight') { e.preventDefault(); select(TABS[(i + 1) % TABS.length], true); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); select(TABS[(i - 1 + TABS.length) % TABS.length], true); }
    if (e.key === 'Home') { e.preventDefault(); select(TABS[0], true); }
    if (e.key === 'End') { e.preventDefault(); select(TABS[TABS.length - 1], true); }
  }

  return (
    <>
      <div
        className="tabs"
        role="tablist"
        aria-label={t('ag.sections', { name: agent.name })}
        onKeyDown={onKeyDown}
      >
        {TABS.map((id, i) => (
          <button
            key={id}
            ref={(el) => { refs.current[i] = el; }}
            role="tab"
            id={`tab-${id}`}
            className="tab"
            aria-selected={active === id}
            aria-controls={`panel-${id}`}
            /* Roving tabindex: only the selected tab is in the tab order. */
            tabIndex={active === id ? 0 : -1}
            onClick={() => select(id)}
          >
            {t(`ag.${id}`)}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`panel-${active}`} aria-labelledby={`tab-${active}`}>
        {active === 'activity' && <Activity agent={agent} />}
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
  const t = useT();
  const [showFramework, setShowFramework] = useState(false);
  const src = agentLog[agent.name] ?? { source: 'none', lines: [] };
  const isPane = src.source === 'pane';

  return (
    <>
      <div className="notice">
        {isPane ? t('ag.paneNotice', { s: agent.tmux }) : t('ag.logNotice')}
      </div>

      {isPane ? (
        <div className="log" style={{ marginTop: 12 }}>
          <div className="dim">
            {'$ '}hafleet · pane {agent.tmux}
          </div>
          <div className="faint" style={{ marginTop: 8 }}>{t('ag.paneStub')}</div>
        </div>
      ) : src.lines.length === 0 ? (
        <div className="empty">
          <div className="big">{t('ag.noActivity')}</div>
          <p className="small">{t('ag.noActivityNote')}</p>
        </div>
      ) : (
        <div className="log" style={{ marginTop: 12 }}>
          {src.lines.map((l, i) =>
            l.kind === 'framework' ? (
              <div key={i}>
                <button className="log-fold" onClick={() => setShowFramework((v) => !v)}
                  aria-expanded={showFramework}>
                  {`${showFramework ? '▾' : '▸'} ${t('ag.frameworkLines', { n: l.collapsed })}`}
                </button>
                {showFramework && (
                  <div className="faint" style={{ paddingLeft: 18 }}>
                    {'INFO connection: calling LLM iteration=3'}<br />
                    {'INFO connection: LLM response received iteration=3'}<br />
                    {'INFO connection: all tools in batch completed'}<br />
                    <span style={{ opacity: 0.7 }}>{t('ag.moreStripped', { n: 9 })}</span>
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

function Profile({ agent, onSay }) {
  const t = useT();
  return (
    <>
      <div className="panel">
        <h3>{t('ag.identity')}</h3>
        <dl className="kv">
          <dt>{t('ag.name')}</dt><dd>{agent.name}</dd>
          <dt>{t('ag.environment')}</dt><dd>{agent.environment}</dd>
          <dt>{t('ag.createdOn')}</dt><dd className="dim">2026-08-02</dd>
        </dl>
      </div>
      <div className="panel">
        <h3>{t('ag.guidance')}</h3>
        {/* key={} forces a remount when the language changes, because defaultValue is
            only read on mount — without it the guidance text would stay in whichever
            language the panel first rendered in. */}
        <textarea
          key={t('ag.guidanceText')}
          rows={4}
          defaultValue={t('ag.guidanceText')}
          style={{
            width: '100%', font: '400 12.5px var(--sans)', padding: 8,
            border: '1px solid var(--line)', borderRadius: 5, resize: 'vertical',
          }}
        />
        <p className="faint" style={{ fontSize: 11 }}>{t('ag.dirtyPanelNote')}</p>
      </div>
      <div className="panel">
        <h3>{t('ag.ownership')}</h3>
        <dl className="kv">
          <dt>{t('ag.owner')}</dt><dd>{t('ag.operator')}</dd>
          <dt>{t('ag.escalation')}</dt><dd className="dim">{t('ag.noneConfigured')}</dd>
        </dl>
      </div>
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn primary" onClick={() => onSay('ok', t('ag.profileSaved'))}>
          {t('ag.saveProfile')}
        </button>
        <span className="faint" style={{ fontSize: 11.5 }}>{t('ag.oneSaveNote')}</span>
      </div>
    </>
  );
}

/* ── Runtime — how it is launched, and what shapes it ──────────────────── */
function Runtime({ agent, onSay }) {
  const t = useT();
  const preset = presets.find((p) => p.framework === agent.framework);
  return (
    <>
      <div className="panel">
        <h3>{t('ag.effectiveRuntime')}</h3>
        <dl className="kv">
          <dt>{t('col.framework')}</dt><dd>{agent.framework}</dd>
          <dt>{t('col.transport')}</dt><dd>{agent.transport}</dd>
          <dt>{t('ag.pane')}</dt><dd>{agent.tmux ?? <span className="dim">{t('ag.noPaneAcp')}</span>}</dd>
          <dt>{t('col.model')}</dt><dd>{preset?.model ?? <span className="dim">{t('ag.providerDefault')}</span>}</dd>
          <dt>{t('ag.workspace')}</dt><dd className="dim">~/{agent.name.replace('-agent', '')}-ws</dd>
        </dl>
      </div>
      <div className="panel">
        <h3>{t('ag.frameworkPreset')}</h3>
        <dl className="kv">
          <dt>{t('ag.applied')}</dt><dd>{preset?.name ?? <span className="dim">{t('common.none')}</span>}</dd>
          <dt>{t('ag.resolvedModel')}</dt><dd>{preset?.model ?? '—'}</dd>
        </dl>
        <p className="faint" style={{ fontSize: 11.5, marginTop: 8 }}>
          {t('ag.presetNote')} <Link href="/config">{t('nav.config')}</Link>
        </p>
      </div>
      <div className="panel">
        <h3>{t('ag.roles')}</h3>
        <dl className="kv">
          <dt>{t('ag.primary')}</dt><dd>{t('ag.engineer')}</dd>
          <dt>{t('ag.supervisor')}</dt><dd className="dim">{t('ag.notSupervisor')}</dd>
        </dl>
      </div>
      <div className="panel">
        <h3>{t('ag.supervisorControl')}</h3>
        <dl className="kv">
          <dt>{t('ag.enabled')}</dt><dd>{t('ag.yes')}</dd>
          <dt>{t('ag.cadence')}</dt><dd>{t('ag.every15m')}</dd>
        </dl>
      </div>
      <div className="panel">
        <h3>{t('ag.guidancePath')}</h3>
        <dl className="kv">
          <dt>{t('ag.mode')}</dt><dd>{t('ag.authoritative')}</dd>
          <dt>{t('col.provider')}</dt><dd>{agent.framework === 'hermes' ? 'deepseek' : t('ag.inherit')}</dd>
          <dt>{t('ag.key')}</dt>
          <dd>
            <code>DEEPSEEK_API_KEY</code>{' '}
            <span className="badge ok">{t('cf.resolved')}</span>
            <div className="faint" style={{ fontSize: 11 }}>{t('ag.refShown')}</div>
          </dd>
        </dl>
      </div>
      <div className="panel">
        <h3>{t('ag.migration')}</h3>
        <div className="notice warn">{t('ag.migrationWarn')}</div>
        <div className="btn-row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={() => onSay('ok', t('ag.previewResult'))}>
            {t('ag.previewMigration')}
          </button>
        </div>
      </div>
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn primary" onClick={() => onSay('ok', t('ag.runtimeSaved'))}>
          {t('ag.saveRuntime')}
        </button>
        <button className="btn" onClick={() => onSay('ok', t('ag.supervisorSaved'))}>
          {t('ag.saveSupervisor')}
        </button>
        <span className="faint" style={{ fontSize: 11.5 }}>{t('ag.perSubsystem')}</span>
      </div>
    </>
  );
}

/* ── Oversight — read only. No controls. ──────────────────────────────── */
function Oversight({ agent }) {
  const t = useT();
  return (
    <>
      <div className="notice">{t('ag.readOnlyNote')}</div>

      <div className="panel" style={{ marginTop: 12 }}>
        <h3>{t('ag.assessment')}</h3>
        <dl className="kv">
          <dt>{t('ag.signal')}</dt>
          <dd>
            {agent.activeNow
              ? <span className="badge ok">{t('ag.healthy')}</span>
              : <span className="badge">{t('ag.idleNoConcern')}</span>}
          </dd>
          <dt>{t('col.reason')}</dt>
          <dd className="dim">
            {agent.activeNow
              ? t('ag.reasonActive')
              : t('ag.reasonIdle', { span: runtimeStatusText(agent).replace('IDLE ', '') })}
          </dd>
          <dt>{t('ag.evaluated')}</dt><dd className="dim">{t('common.ago', { n: '42s' })}</dd>
          <dt>{t('ag.recommended')}</dt><dd>{t('ag.noAction')}</dd>
        </dl>
      </div>

      <div className="panel">
        <h3>{t('ag.workEvidence')}</h3>
        <p className="faint" style={{ fontSize: 11.5 }}>
          {t('ag.evidenceNote')} <Link href="/tasks">{t('nav.tasks')}</Link>
        </p>
        <div className="log" style={{ marginTop: 8 }}>
          <div className="dim">{t('ag.captured', { n: '6m' })}</div>
          <div style={{ marginTop: 6 }}>{t('ag.progressLine')}</div>
        </div>
      </div>

      <div className="panel">
        <h3>{t('ag.pathStatus')}</h3>
        <dl className="kv">
          <dt>{t('ag.activePath')}</dt><dd>{t('ag.authoritative')}</dd>
          <dt>{t('ag.stage')}</dt><dd className="dim">{t('ag.stageIdle')}</dd>
          <dt>{t('ag.lastInjection')}</dt><dd className="dim">{t('common.ago', { n: '18m' })}</dd>
        </dl>
      </div>

      <div className="panel">
        <h3>{t('ag.decisions')}</h3>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>{t('col.when')}</th><th>{t('col.decision')}</th><th>{t('col.reason')}</th></tr></thead>
            <tbody>
              {[
                { at: '42s', decision: 'ag.noAction', reason: 'ag.healthy' },
                { at: '15m', decision: 'ag.noAction', reason: 'ag.healthy' },
                { at: '4h', decision: 'ag.recycled', reason: 'ag.promptTimeout' },
              ].map((d, i) => (
                <tr key={i}>
                  <td className="dim">{t('common.ago', { n: d.at })}</td>
                  <td>{t(d.decision)}</td>
                  <td className="dim">{t(d.reason)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="faint" style={{ fontSize: 11.5, marginTop: 8 }}>{t('ag.oneCollection')}</p>
      </div>
    </>
  );
}
