'use client';

import { useState } from 'react';
import PageHead from '@/components/PageHead';
import { Toast, useToast } from '@/components/Toast';
import {
  runtimeStatusText, presetOf, tierOf, familyOf, remaining, committed, fmtTokens,
  engagements, roleCapacity,
} from '@/lib/mock-data';
import { Blank } from '@/components/Blank';
import { useT } from '@/components/Prefs';

/*
 * Split out of the route so app/agents/[name]/page.jsx can stay a server component
 * and keep generateStaticParams — the header is the only part of it that needs the
 * locale.
 *
 * Refresh cadence is named for what it polls, and only offered when there is a pane
 * to poll: 10/sec was pane polling, and an ACP agent has no pane, it has a log.
 *
 * Both controls do something. They were drawn as buttons with no handler, which is
 * worse than omitting them: a control that looks live and does nothing teaches the
 * operator to distrust every other control on the page. Pause toggles and reports it;
 * the cadence button states that it affects the display and not the agent, which is
 * the confusion the old "10/sec" label caused in the first place.
 */
export default function AgentHeader({ agent }) {
  const t = useT();
  const [toast, say] = useToast();
  const [paused, setPaused] = useState(false);

  // What this agent CONTRIBUTES, on the record where the contributor looks. The
  // previous console showed which bench an agent belonged to and which projects
  // it was a member of — a dispatcher's framing. A lender asks three things: what
  // model am I giving away, how much of my ceiling is already promised, and who
  // is currently drawing on it.
  const preset = presetOf(agent);
  const tier = tierOf(preset);
  const serving = engagements.filter((e) => e.agent === agent.name && e.state === 'active');

  return (
    <>
      <PageHead title={agent.name}>
        <button
          className="btn"
          title={t(agent.tmux ? 'ag.refreshPaneTitle' : 'ag.refreshLogTitle')}
          onClick={() => say('ok', t('ag.cadenceNote'))}
        >
          {t(agent.tmux ? 'ag.refreshPane' : 'ag.refreshLog')}
        </button>
        {agent.tmux && (
          <button
            className={`btn${paused ? ' warn' : ''}`}
            title={t('ag.pauseTitle')}
            aria-pressed={paused}
            onClick={() => {
              setPaused((v) => !v);
              say('ok', t(paused ? 'ag.resumed' : 'ag.paused'));
            }}
          >
            {t(paused ? 'ag.resumeDisplay' : 'ag.pauseDisplay')}
          </button>
        )}
      </PageHead>

      <div className="btn-row" style={{ margin: '-8px 0 4px' }}>
        {/* ACTIVE / IDLE stay untranslated: they are the strings runtimeStatusText()
            emits and the same words appear in `hafleet ls`. */}
        <span className={`badge${agent.activeNow ? ' ok' : ''}`}>{runtimeStatusText(agent)}</span>
        <span className="badge">
          {agent.transport === 'acp' ? t('ag.noPane') : `TMUX · ${agent.tmux}`}
        </span>
        <span className="badge">{agent.framework}</span>
        {agent.mcp && <span className="badge ok">{t('ag.mcpConnected')}</span>}
        {/* Paused is a state the page is in, so it belongs with the other state
            badges and not only inside a toast that disappears. */}
        {paused && <span className="badge attention">{t('ag.paused')}</span>}
      </div>

      <div className="affil">
        <div className="af-row">
          <span className="af-line">{t('ag.contributes')}</span>
          {preset ? (
            <>
              <span className="mono-s">{preset.model}</span>
              <span className={`tierchip ${tier}`}>{tier}</span>
              <span className="dim">{familyOf(preset)}</span>
              {preset.reasoning && <span className="badge">{`${t('col.reasoning')} ${preset.reasoning}`}</span>}
            </>
          ) : (
            /* The state that makes an agent useless, said plainly: it is running
               and lending nothing, because nobody chose a model for it. */
            <Blank why="ag.why.noPreset" t={t} />
          )}
        </div>
        <div className="af-row">
          <span className="af-line">{t('ag.ceiling')}</span>
          {preset ? (
            <>
              <span className="amount">{fmtTokens(preset.ceiling.tokens)}</span>
              <span className="dim">
                {t('ag.committedLeft', {
                  used: fmtTokens(committed(agent.name)),
                  left: fmtTokens(remaining(agent.name)),
                })}
              </span>
              {!preset.ceiling.enforced && <span className="badge warn-b">{t('rs.notEnforced')}</span>}
            </>
          ) : <Blank why="ag.why.noCeiling" t={t} />}
        </div>
        <div className="af-row">
          <span className="af-line">{t('ag.serving')}</span>
          {serving.length ? serving.map((e) => (
            <span className="chip-role" key={e.id}>
              {`${e.project} · ${roleCapacity.roles[e.role]?.displayName ?? e.role}`}
            </span>
          )) : <Blank why="ag.why.notServing" t={t} />}
        </div>
      </div>

      <Toast toast={toast} />
    </>
  );
}
