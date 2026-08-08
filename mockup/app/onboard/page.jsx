'use client';

import { useMemo, useState } from 'react';
import PageHead from '@/components/PageHead';
import { Toast, useToast } from '@/components/Toast';
import { useT } from '@/components/Prefs';
import {
  detected, detectState, onboardable, onboardCommand, onboardSteps, agents,
  presets, tierOf, roleCapacity,
} from '@/lib/mock-data';

/*
 * Onboarding — detect what this host can run, then bring one up.
 *
 * The CLI path already exists and is documented in docs/agent-onboarding.md; this is
 * the same four steps behind a form. Two things it must not pretend:
 *
 * 1. HAFleet does not install frameworks and does not hold their credentials. The
 *    operator's own correction on the Config page applies twice over here: an agent
 *    authenticates itself BEFORE it joins the fleet. So an unauthenticated framework
 *    gets the one command that fixes it and no input field.
 *
 * 2. Detection needs an endpoint that does not exist yet — GET /api/frameworks/detect.
 *    Named as new in the design doc rather than drawn as if it were already there,
 *    which is the mistake the "ACP session stream" round made.
 *
 * The `--model` field is offered only when the chosen adapter declares
 * `launch.acpModelFlag`. hermes dies on a flag it does not take and codex-acp accepts
 * it and silently ignores it, so a form that always shows the field is a form that
 * lies for two of the five frameworks.
 */

const STATES = ['ready', 'needs_auth', 'needs_setup', 'absent'];

function StateBadge({ state, t }) {
  const cls = { ready: ' ok', needs_auth: ' attention', needs_setup: ' attention', absent: '' }[state];
  return (
    <span className={`badge${cls}`} title={t(`ob.st.${state}Why`)}>
      {t(`ob.st.${state}`)}
    </span>
  );
}

export default function OnboardPage() {
  const t = useT();
  const [toast, say] = useToast();
  const [name, setName] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [framework, setFramework] = useState('');
  const [supervised, setSupervised] = useState(true);
  // A contribution preset, not a role. The role is DERIVED from the model via
  // lib/role-capacity.json, so asking for one here would let an agent claim a
  // role its model cannot sustain — which is what the previous console did.
  const [role, setRole] = useState('');
  const [model, setModel] = useState('');
  const [phase, setPhase] = useState(null); // null | step id | 'done' | 'failed'

  const ready = onboardable();
  const chosen = detected.find((f) => f.id === framework) ?? null;
  const taken = agents.some((a) => a.name === name);
  const badName = name !== '' && !/^[\w-]+$/.test(name);
  const canStart = name && !taken && !badName && workspace && chosen && phase === null;

  const byState = useMemo(() => {
    const order = Object.fromEntries(STATES.map((s, i) => [s, i]));
    return [...detected].sort((a, b) => order[detectState(a)] - order[detectState(b)]);
  }, []);

  const command = onboardCommand({ name, workspace, framework, supervised, model });

  function start() {
    // Walk the four real steps rather than showing one spinner: step 4 is the slow
    // one and the only one that can fail after the others succeeded, so collapsing
    // them would hide where onboarding actually got to.
    let i = 0;
    setPhase(onboardSteps[0].id);
    const tick = () => {
      i += 1;
      if (i < onboardSteps.length) {
        setPhase(onboardSteps[i].id);
        setTimeout(tick, i === onboardSteps.length - 1 ? 1400 : 600);
        return;
      }
      // hermes with a missing extra is the fixture's crash-loop case; everything
      // else comes up. A real failure carries the log tail, so this one does too.
      const fails = framework === 'hermes';
      setPhase(fails ? 'failed' : 'done');
      say(fails ? 'fail' : 'ok', fails ? t('ob.failed', { name }) : t('ob.ok', { name }));
    };
    setTimeout(tick, 600);
  }

  return (
    <>
      <PageHead title={t('ob.title')} sub={t('ob.sub', { n: '9s' })}>
        <button className="btn" onClick={() => say('ok', t('ob.rescanned', { n: detected.length }))}>
          {t('ob.rescan')}
        </button>
      </PageHead>

      <div className="notice">{t('ob.explain')}</div>

      <h2 className="sec">
        {t('ob.detected')}
        <span className="note">{t('ob.detectedNote')}</span>
      </h2>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t('col.framework2')}</th>
              <th>{t('col.state')}</th>
              <th>{t('col.version')}</th>
              <th>{t('col.transport')}</th>
              <th>{t('col.credential')}</th>
              <th>{t('ob.prereqs')}</th>
              <th>{t('col.startWith')}</th>
            </tr>
          </thead>
          <tbody>
            {byState.map((f) => {
              const state = detectState(f);
              return (
                <tr key={f.id}>
                  <td>
                    <div>{f.displayName}</div>
                    <div className="faint" style={{ fontSize: 11 }}>
                      <code>{f.command}</code>
                    </div>
                  </td>
                  <td><StateBadge state={state} t={t} /></td>
                  <td className="dim">{f.version ?? <span className="faint">{t('ob.notOnPath')}</span>}</td>
                  {/* Transport comes from the adapter, not from a choice made here. */}
                  <td className="dim">{f.transport}</td>
                  <td>
                    <code style={{ fontSize: 11.5 }}>{f.credentialHome}</code>
                    {!f.credentialPresent && (
                      <div className="faint" style={{ fontSize: 11 }}>
                        {t('ob.fixWith')}: <code>{f.authFix}</code>
                      </div>
                    )}
                  </td>
                  {/* Its own column: "not authenticated" and "an extra is missing" are
                      different problems with different fixes, and stacking them in one
                      cell made a framework look like it had two credential faults. */}
                  <td>
                    {f.setup.length === 0 ? (
                      <span className="faint">—</span>
                    ) : (
                      f.setup.map((s) => (
                        <div key={s.key} style={{ fontSize: 11.5, marginBottom: 3 }}>
                          <span className={`badge${s.ok ? ' ok' : ' attention'}`}>{t(s.key)}</span>
                          {!s.ok && (
                            <div className="faint" style={{ fontSize: 11, marginTop: 2 }}>
                              <code>{s.fix}</code>
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </td>
                  <td className="dim"><code style={{ fontSize: 11.5 }}>{f.startWith}</code></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {ready.length === 0 ? (
        <div className="empty" style={{ marginTop: 22 }}>
          <div className="big">{t('ob.noneReady')}</div>
          <p className="small">{t('ob.noneReadyNote')}</p>
        </div>
      ) : (
        <div className="split even" style={{ marginTop: 4 }}>
          <div>
            <h2 className="sec">
              {t('ob.form')}
              <span className="note">{t('ob.formNote')}</span>
            </h2>
            <div className="panel">
              <div className="field">
                <label htmlFor="ob-name">{t('ob.name')}</label>
                <input
                  id="ob-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="ops-agent"
                  aria-invalid={taken || badName}
                  aria-describedby="ob-name-hint"
                />
                <p id="ob-name-hint" className={taken || badName ? 'bad-hint' : 'faint hint'}>
                  {taken ? t('ob.nameTaken', { name }) : badName ? t('ob.nameBad') : t('ob.nameHint')}
                </p>
              </div>

              <div className="field">
                <label htmlFor="ob-ws">{t('ob.workspace')}</label>
                <input
                  id="ob-ws"
                  value={workspace}
                  onChange={(e) => setWorkspace(e.target.value)}
                  placeholder="~/ops-ws"
                  aria-describedby="ob-ws-hint"
                />
                <p id="ob-ws-hint" className="faint hint">{t('ob.workspaceHint')}</p>
              </div>

              <div className="field">
                <label htmlFor="ob-fw">{t('ob.framework')}</label>
                {/* Only `ready` frameworks are selectable. Offering an unauthenticated
                    one and failing at step 4 wastes the 30-second health wait to tell
                    the operator something detection already knew. */}
                <select id="ob-fw" value={framework} onChange={(e) => { setFramework(e.target.value); setModel(''); }}>
                  <option value="">{t('ob.pickFramework')}</option>
                  {ready.map((f) => (
                    <option key={f.id} value={f.id}>{`${f.displayName} · ${f.transport}`}</option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label htmlFor="ob-preset">{t('ob.preset')}</label>
                <select
                  id="ob-preset"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  aria-describedby="ob-preset-hint"
                >
                  <option value="">{t('ob.presetNone')}</option>
                  {presets
                    .filter((p) => !chosen || p.framework === chosen.id)
                    .map((p) => (
                      <option key={p.id} value={p.id}>{`${p.name} — ${p.model}`}</option>
                    ))}
                </select>
                {/* A role is not chosen here. It is DERIVED: the model decides the
                    tier, and the tier decides which roles this agent can be
                    offered as (lib/role-capacity.json). Asking for a role at
                    registration was the previous console's model, and it let an
                    agent claim a role its model could not sustain. */}
                <p id="ob-preset-hint" className="faint hint">{t('ob.presetHint')}</p>
              </div>

              {role ? (
                <div className="notice">
                  {(() => {
                    const p = presets.find((x) => x.id === role);
                    const tier = tierOf(p);
                    const rank = { lightweight: 0, medium: 1, strong: 2 };
                    const fillable = Object.values(roleCapacity.roles)
                      .filter((r) => rank[tier] >= rank[r.defaultTier])
                      .map((r) => r.displayName);
                    return t('ob.presetOutcome', { tier, roles: fillable.join(', ') });
                  })()}
                </div>
              ) : (
                <div className="notice warn">{t('ob.presetOmitted')}</div>
              )}

              {chosen?.transport === 'acp' && (
                <div className="field">
                  <label htmlFor="ob-sup">
                    <input
                      id="ob-sup"
                      type="checkbox"
                      checked={supervised}
                      onChange={(e) => setSupervised(e.target.checked)}
                    />{' '}
                    {t('ob.supervised')}
                  </label>
                  <p className="faint hint">{t('ob.supervisedNote')}</p>
                </div>
              )}

              {chosen?.transport === 'tmux' && (
                <div className="notice warn">{t('ob.tmuxNote', { name: chosen.displayName })}</div>
              )}

              {chosen && (chosen.acpModelFlag ? (
                <div className="field">
                  <label htmlFor="ob-model">{t('ob.model')}</label>
                  <input
                    id="ob-model"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="gpt-5-codex"
                    aria-describedby="ob-model-hint"
                  />
                  <p id="ob-model-hint" className="faint hint">
                    {t('ob.modelNote', { flag: chosen.acpModelFlag })}
                  </p>
                </div>
              ) : (
                <div className="notice">{t('ob.noModelFlag', { name: chosen.displayName })}</div>
              ))}

              {chosen && (
                <>
                  <h3 style={{ marginTop: 16 }}>{t('ob.permissions')}</h3>
                  <p className="dim" style={{ fontSize: 12.5, margin: '4px 0 0' }}>
                    {chosen.permissionSummary}
                  </p>
                </>
              )}

              <h3 style={{ marginTop: 16 }}>{t('ob.equivalent')}</h3>
              {/* .cmd, not .log: a command that wraps mid-token cannot be copied
                  correctly, and `--model gpt-5-\ncodex` is a different command. It
                  scrolls sideways in its own box instead. */}
              <div className="log cmd"><div>{`$ ${command}`}</div></div>

              <div className="btn-row" style={{ marginTop: 14 }}>
                <button className="btn primary" disabled={!canStart} onClick={start}>
                  {phase && phase !== 'done' && phase !== 'failed' ? t('ob.starting') : t('ob.start')}
                </button>
              </div>
            </div>
          </div>

          <div>
            <h2 className="sec">{t('ob.willDo')}</h2>
            <div className="panel">
              <ol className="steps">
                {onboardSteps.map((s, i) => {
                  const at = onboardSteps.findIndex((x) => x.id === phase);
                  const done = phase === 'done' || (at > -1 && i < at) || (phase === 'failed' && i < 3);
                  const now = phase === s.id;
                  const bad = phase === 'failed' && i === 3;
                  return (
                    <li key={s.id} className={bad ? 'bad' : done ? 'done' : now ? 'now' : ''}>
                      <span className="mark" aria-hidden="true">{bad ? '✕' : done ? '✓' : now ? '…' : i + 1}</span>
                      {t(s.label)}
                    </li>
                  );
                })}
              </ol>
              <p className="faint hint">{t('ob.healthNote')}</p>
            </div>

            {phase === 'failed' && (
              <div className="notice warn" style={{ borderColor: 'var(--bad)', color: 'var(--bad)', background: 'var(--bad-soft)' }}>
                <strong>{t('ob.failed', { name })}</strong>
                <div style={{ marginTop: 6 }}>{t('ob.failedLog', { n: 3, name })}</div>
              </div>
            )}

            <h2 className="sec">{t('ob.oneHostTitle')}</h2>
            <div className="notice">{t('ob.oneHost')}</div>
          </div>
        </div>
      )}

      <Toast toast={toast} />
    </>
  );
}
