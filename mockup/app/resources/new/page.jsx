'use client';

import { useState } from 'react';
import Link from 'next/link';
import PageHead from '@/components/PageHead';
import { Toast, useToast } from '@/components/Toast';
import { useT } from '@/components/Prefs';
import { presetCommand, fmtTokens } from '@/lib/mock-data';
import { useData, Provenance } from '@/components/Data';
import { send } from '@/lib/api';

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
function reasoningChoices(roleCapacity, framework) {
  const seen = new Set();
  for (const tier of roleCapacity.tiers) {
    for (const c of roleCapacity.tierAccepts[tier] ?? []) {
      if (c.framework === framework && c.reasoning) seen.add(c.reasoning);
    }
  }
  return [...seen];
}

/** Which roles this combination would qualify for, computed live from the config. */
function qualifiesFor(roleCapacity, framework, model, reasoning) {
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
  const {
    FRAMEWORKS, MODEL_SELECTABLE, modelsFor, roleCapacity, frameworks, detected,
    provenance, refresh,
  } = useData();
  const live = provenance.presets === 'live';
  const [toast, say] = useToast();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState({
    name: '', framework: null, provider: null, model: null, reasoning: null,
    tokens: 1_000_000, rateCapPerDay: 50_000,
  });

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const selectable = draft.framework ? MODEL_SELECTABLE[draft.framework] : null;
  const models = draft.framework ? modelsFor(draft.framework) : [];
  const reasonings = draft.framework ? reasoningChoices(roleCapacity, draft.framework) : [];
  const outcome = draft.framework && draft.model
    ? qualifiesFor(roleCapacity, draft.framework, draft.model, draft.reasoning)
    : { tier: null, roles: [] };
  // The manifest for the chosen framework, when the live endpoint supplied one.
  const manifest = frameworks.find((f) => f.id === draft.framework) ?? null;
  const chosenDetect = detected.find((f) => f.id === draft.framework) ?? null;

  return (
    <>
      <PageHead title={t('wz.title')} sub={t('wz.sub')}>
        <Link className="btn" href="/resources">{t('wz.cancel')}</Link>
      </PageHead>

      <Provenance slices={['frameworks', 'ceilings']} />

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
            {FRAMEWORKS.map((f) => {
              const mf = frameworks.find((x) => x.id === f) ?? null;
              // The host probe, which knows whether it is actually installed here.
              const det = detected.find((x) => x.id === f) ?? null;
              return (
                <button
                  key={f}
                  /*
                   * Disabled when nothing can be selected for it.
                   *
                   * `codex-acp` has zero qualifying combinations, so choosing it led to
                   * an empty model step with a permanently disabled Next — a dead end
                   * reached by clicking, with nothing on screen explaining why. A
                   * control that cannot lead anywhere should not be pressable.
                   */
                  className={`fw${draft.framework === f ? ' on' : ''}${modelsFor(f).length === 0 ? ' fw-dead' : ''}`}
                  disabled={modelsFor(f).length === 0}
                  aria-pressed={draft.framework === f}
                  onClick={() => set({ framework: f, model: null, provider: null, reasoning: null })}
                >
                  <b>{mf?.displayName ?? f}</b>
                  <span className="dim">{f}</span>
                  <span className="dim">{t('wz.nModels', { n: modelsFor(f).length })}</span>
                  {modelsFor(f).length === 0
                    ? <span className="badge warn-b">{t('wz.noQualifyingModel')}</span>
                    : MODEL_SELECTABLE[f]?.ok === false && (
                      <span className="badge warn-b">{t('wz.modelFixed')}</span>
                    )}
                  {/*
                    * NOT INSTALLED is the fact worth warning about. `launchable:false`
                    * is not: every ACP manifest carries it, and each one's reason says
                    * "start it with hafleet acp-up instead" — a different command, not
                    * an inability. Warning on it told a contributor their working
                    * framework could not run.
                    */}
                  {det && det.state === 'absent' && (
                    <span className="badge warn-b">{t('wz.notInstalled')}</span>
                  )}
                  {det && det.state === 'needs_auth' && (
                    <span className="badge warn-b">{t('wz.needsAuth')}</span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Stated up front, because it changes what the next step can promise. */}
          {selectable?.ok === false && (
            <div className="notice warn">{t(selectable.why)}</div>
          )}

          {/* How it starts, from the probe — not a warning, a fact. */}
          {chosenDetect && chosenDetect.state !== 'absent' && (
            <div className="notice">
              {t('wz.startsWith', { cmd: chosenDetect.startWith })}
            </div>
          )}
          {chosenDetect && chosenDetect.state === 'absent' && (
            <div className="notice warn">
              <div><b>{t('wz.notInstalled')}</b></div>
              <div>{t('wz.notInstalledWhy', { fix: chosenDetect.fix ?? '' })}</div>
            </div>
          )}

          {/*
            * THE SANDBOX BEING LENT.
            *
            * The design asked for this in step 1 and the fixture could not supply
            * it: `permissionSummary` and the refused flags live in the manifests,
            * which had no endpoint until GET /api/frameworks existed. A
            * contributor deciding what to lend is deciding what permissions to
            * lend, so this is a first-step fact rather than a footnote.
            */}
          {manifest && (
            <dl className="kv" style={{ marginTop: 14 }}>
              <dt>{t('wz.transport')}</dt><dd className="mono-s">{manifest.transport}</dd>
              {manifest.permissionSummary && (
                <>
                  <dt>{t('wz.sandbox')}</dt>
                  <dd>{manifest.permissionSummary}</dd>
                </>
              )}
              {manifest.refusedFlags?.length > 0 && (
                <>
                  <dt>{t('wz.refuses')}</dt>
                  <dd>
                    {manifest.refusedFlags.map((fl) => (
                      <span className="badge" key={fl}>{fl}</span>
                    ))}
                    <div className="dim">{t('wz.refusesNote')}</div>
                  </dd>
                </>
              )}
            </dl>
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
          {/*
            * The preset's NAME, which the form never asked for.
            *
            * A preset is reusable across agents — that is its whole point — so it
            * needs a name a contributor recognises six weeks later. Without this
            * field the name was auto-derived as `codex · gpt-5.6-sol`, which is the
            * model configuration restated rather than a label: two presets on the
            * same model at different reasoning levels would be indistinguishable in
            * every list that shows them. The printed equivalent command already
            * referenced a `name`, which is how the omission surfaced.
            */}
          <div className="field-row">
            <label htmlFor="wz-name">{t('wz.presetName')}</label>
            <input
              id="wz-name" type="text" style={{ width: 240 }}
              value={draft.name}
              placeholder={`${draft.framework} · ${draft.model ?? ''}`}
              onChange={(e) => set({ name: e.target.value })}
            />
            <span className="dim">{t('wz.presetNameHint')}</span>
          </div>
          <div className="field-row">
            <label htmlFor="wz-tokens">{t('wz.monthlyTokens')}</label>
            <input
              id="wz-tokens" type="number" min="100000" step="100000"
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
          <button
            className="btn primary"
            onClick={async () => {
              if (!live) return say('ok', t('wz.wouldCreate'));
              /*
               * The ceiling goes in the payload. It used to be omitted on purpose,
               * because POST /api/framework-presets built its record from a closed
               * field list and dropped it — sending it would have made the form
               * appear to save a budget the backend never held. It persists now, so
               * withholding it would silently discard the one field the contributor
               * actually came to set.
               */
              const res = await send('framework-presets', {
                body: {
                  name: draft.name?.trim() || `${draft.framework} · ${draft.model}`,
                  framework: draft.framework,
                  provider: draft.provider,
                  model: draft.model,
                  reasoning: draft.reasoning,
                  ceiling: {
                    tokens: draft.tokens,
                    period: 'monthly',
                    rateCapPerDay: draft.rateCapPerDay || null,
                  },
                },
              });
              if (!res.ok) return say('fail', res.error);
              await refresh();
              return say('ok', t('wz.didCreate', { name: res.body?.preset?.name ?? draft.model }));
            }}
          >
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
          <div className="notice">{t(live ? 'wz.ceilingSaved' : 'wz.ceilingOmitted')}</div>
        </>
      )}

      <Toast toast={toast} />
    </>
  );
}
