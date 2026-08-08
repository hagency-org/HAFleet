'use client';

import { useState } from 'react';
import Link from 'next/link';
import PageHead from '@/components/PageHead';
import { Toast, useToast } from '@/components/Toast';
import { useT } from '@/components/Prefs';
import {
  FRAMEWORKS, MODEL_SELECTABLE, modelsFor, presetCommand, roleCapacity, fmtTokens,
} from '@/lib/mock-data';

/*
 * ② 配置向导 — four steps, and three of them write a field that already exists.
 *
 * The output is a **preset** (framework-presets.json, POST /api/framework-presets),
 * whose fields are exactly what normalizeRuntimeProfileRole() accepts at
 * backend-v2.js:713 — framework, provider, model, reasoning. A preset is reusable,
 * so "my Opus donation" is configured once and attached to several agents.
 *
 * The fourth step, the budget, has NO upstream field. It is also the only step the
 * contributor really cares about, which is an uncomfortable combination: the thing
 * they are deciding is the thing the system cannot yet hold. So it is collected,
 * labelled unenforced, and left out of the printed command — a form that silently
 * sent a ceiling the endpoint drops would be worse than one that admits the gap.
 */

const STEPS = ['framework', 'model', 'reasoning', 'budget'];

/** Codex thinking levels, from the real enumeration's `reasoning` values. */
function reasoningChoices(framework) {
  const seen = new Set();
  for (const tier of roleCapacity.tiers) {
    for (const c of roleCapacity.tierAccepts[tier] ?? []) {
      if (c.framework === framework && c.reasoning) seen.add(c.reasoning);
    }
  }
  return [...seen];
}

/** Which roles this combination would qualify for, computed live from the config. */
function qualifiesFor(framework, model, reasoning) {
  const rank = { lightweight: 0, medium: 1, strong: 2 };
  let tier = null;
  for (const tr of roleCapacity.tiers) {
    const hit = (roleCapacity.tierAccepts[tr] ?? []).find((c) => (
      c.framework === framework && c.model === model
      && (c.reasoning === undefined || c.reasoning === reasoning)
    ));
    if (hit) { tier = tr; break; }
  }
  if (!tier) return { tier: null, roles: [] };
  const roles = Object.entries(roleCapacity.roles)
    .filter(([, r]) => rank[tier] >= rank[r.defaultTier])
    .map(([k, r]) => ({ key: k, name: r.displayName }));
  return { tier, roles };
}

export default function WizardPage() {
  const t = useT();
  const [toast, say] = useToast();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState({
    name: '', framework: null, provider: null, model: null, reasoning: null,
    tokens: 1_000_000, rateCapPerDay: 50_000,
  });

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const selectable = draft.framework ? MODEL_SELECTABLE[draft.framework] : null;
  const models = draft.framework ? modelsFor(draft.framework) : [];
  const reasonings = draft.framework ? reasoningChoices(draft.framework) : [];
  const outcome = draft.framework && draft.model
    ? qualifiesFor(draft.framework, draft.model, draft.reasoning)
    : { tier: null, roles: [] };

  return (
    <>
      <PageHead title={t('wz.title')} sub={t('wz.sub')}>
        <Link className="btn" href="/resources">{t('wz.cancel')}</Link>
      </PageHead>

      {/* Progress is a list of steps with the current one marked, not a bar: the
          reader needs to know which decision they are on, not a percentage. */}
      <ol className="steps wizard">
        {STEPS.map((s, i) => (
          <li key={s} className={i === step ? 'on' : i < step ? 'done' : ''}>
            <span className="n">{i + 1}</span>
            <span>{t(`wz.step.${s}`)}</span>
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div className="panel">
          <h3 className="sub">{t('wz.pickFramework')}</h3>
          <div className="fw-grid">
            {FRAMEWORKS.map((f) => (
              <button
                key={f}
                className={`fw${draft.framework === f ? ' on' : ''}`}
                aria-pressed={draft.framework === f}
                onClick={() => set({ framework: f, model: null, provider: null, reasoning: null })}
              >
                <b>{f}</b>
                <span className="dim">{t('wz.nModels', { n: modelsFor(f).length })}</span>
                {MODEL_SELECTABLE[f]?.ok === false && (
                  <span className="badge warn-b">{t('wz.modelFixed')}</span>
                )}
              </button>
            ))}
          </div>
          {/* Stated up front, because it changes what the next step can promise. */}
          {selectable?.ok === false && (
            <div className="notice warn">{t(selectable.why)}</div>
          )}
        </div>
      )}

      {step === 1 && (
        <div className="panel">
          <h3 className="sub">{t('wz.pickModel')}</h3>
          {models.length === 0 ? (
            <div className="notice">{t('wz.noModels')}</div>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t('col.model')}</th><th>{t('col.provider')}</th>
                    <th>{t('col.family')}</th><th>{t('col.tier')}</th><th>{t('col.action')}</th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((m) => (
                    <tr key={`${m.model}-${m.tier}-${m.reasoning ?? ''}`}>
                      <td className="mono-s">{m.model}</td>
                      <td>{m.provider}</td>
                      <td>{m.family}</td>
                      <td>
                        <span className={`tierchip ${m.tier}`}>{m.tier}</span>
                        {m.reasoning && <span className="dim"> {t('wz.atReasoning', { r: m.reasoning })}</span>}
                      </td>
                      <td>
                        <button
                          className={`btn${draft.model === m.model && draft.reasoning === (m.reasoning ?? null) ? ' primary' : ''}`}
                          onClick={() => set({ model: m.model, provider: m.provider, reasoning: m.reasoning ?? null })}
                        >
                          {t('wz.pick')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="panel">
          <h3 className="sub">{t('wz.pickReasoning')}</h3>
          {reasonings.length === 0 ? (
            <div className="notice">{t('wz.noReasoning', { f: draft.framework ?? '' })}</div>
          ) : (
            <>
              <div className="prefs-row" role="group" aria-label={t('wz.pickReasoning')}>
                {reasonings.map((r) => (
                  <button
                    key={r}
                    className="seg"
                    aria-pressed={draft.reasoning === r}
                    onClick={() => set({ reasoning: r })}
                  >
                    {r}
                  </button>
                ))}
              </div>
              {/* The consequence, not just the setting. Thinking level is what
                  decides the tier for Codex, so it decides which roles I can
                  offer — a fact a bare radio group hides. */}
              <div className="notice">{t('wz.reasoningDecidesTier')}</div>
            </>
          )}
        </div>
      )}

      {step === 3 && (
        <div className="panel">
          <h3 className="sub">{t('wz.setBudget')}</h3>
          <div className="field-row">
            <label htmlFor="wz-tokens">{t('wz.monthlyTokens')}</label>
            <input
              id="wz-tokens" type="number" min="0" step="100000"
              value={draft.tokens}
              onChange={(e) => set({ tokens: Number(e.target.value) })}
            />
            <span className="dim">{fmtTokens(draft.tokens)}</span>
          </div>
          <div className="field-row">
            <label htmlFor="wz-rate">{t('wz.rateCap')}</label>
            <input
              id="wz-rate" type="number" min="0" step="10000"
              value={draft.rateCapPerDay}
              onChange={(e) => set({ rateCapPerDay: Number(e.target.value) })}
            />
            <span className="dim">{`${fmtTokens(draft.rateCapPerDay)}/d`}</span>
          </div>
          {/* The uncomfortable admission, made once and plainly. */}
          <div className="notice warn">{t('wz.budgetNotEnforced')}</div>
        </div>
      )}

      {/* The outcome travels with every step once a model is chosen, because
          "which roles does this let me offer" is the question the whole wizard is
          really answering, and finding out only at the end is too late to change
          a decision cheaply. */}
      {outcome.tier && (
        <div className="panel outcome">
          <h3 className="sub">{t('wz.outcome')}</h3>
          <div className="prov-row">
            <span className="grow">{t('wz.qualifiesTier')}</span>
            <span className={`tierchip ${outcome.tier}`}>{outcome.tier}</span>
          </div>
          <div className="prov-row">
            <span className="grow">{t('wz.qualifiesRoles', { n: outcome.roles.length })}</span>
            <span>{outcome.roles.map((r) => <span className="chip-role" key={r.key}>{r.name}</span>)}</span>
          </div>
        </div>
      )}

      <div className="btn-row">
        <button className="btn" disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>
          {t('wz.back')}
        </button>
        {step < STEPS.length - 1 ? (
          <button
            className="btn primary"
            disabled={step === 0 ? !draft.framework : step === 1 ? !draft.model : false}
            onClick={() => setStep((s) => s + 1)}
          >
            {t('wz.next')}
          </button>
        ) : (
          <button className="btn primary" onClick={() => say('ok', t('wz.wouldCreate'))}>
            {t('wz.create')}
          </button>
        )}
      </div>

      {/* Shown, not hidden: a contributor must be able to reproduce and script
          what the form did, and seeing the command is how you notice the form
          built the wrong one. */}
      {draft.framework && (
        <>
          <h2 className="sec">{t('wz.equivalent')}</h2>
          <pre className="cmd">{presetCommand(draft)}</pre>
          <div className="notice">{t('wz.ceilingOmitted')}</div>
        </>
      )}

      <Toast toast={toast} />
    </>
  );
}
