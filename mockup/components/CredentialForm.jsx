'use client';

import { useState } from 'react';
import { useT } from '@/components/Prefs';
import { send } from '@/lib/api';

/*
 * ENTERING A PROJECT SIDE'S CREDENTIAL — the half of ADR-016 decision 8 that did not exist.
 *
 * Until this, an operator set a credential with `curl`. That is not a UI gap so much as a place where
 * the product told an operator to hand-assemble JSON containing somebody else's server secret, and
 * get the field names right from a source file.
 *
 * WHAT ENTERING IT HERE COSTS, said plainly rather than assumed away: the token passes through the
 * browser. The read side is closed — `publicSide` is an allow-list projection, and the two
 * credential-RETURNING endpoints are excluded from the console proxy — so this form can write a
 * credential it can never read back. That asymmetry is the design: an operator who wants to know
 * whether a credential works reads `accessState`, not the token.
 *
 * TWO KINDS, DIFFERENT FIELDS, and the form asks for exactly the ones the chosen kind needs.
 * `appservice` is four fields and mints nothing per agent; `registrationToken` is one and registers
 * real accounts. Offering the union and letting the backend reject would make the shape of the
 * decision invisible at the moment it is made.
 *
 * NO PARTIAL WRITE. `PUT .../credential` replaces the whole object, and a body that omits the field
 * used to DESTROY the existing credential — which is why the endpoint now demands it explicitly. So
 * this form submits a complete credential or nothing, and withdrawal is its own button with its own
 * confirmation, because re-issuing costs the project side a homeserver restart.
 */
const KINDS = ['appservice', 'registrationToken'];

const EMPTY = {
  appservice: { asToken: '', hsToken: '', namespace: '@ac_.*', senderLocalpart: 'hafleet' },
  registrationToken: { registrationToken: '' },
};

export default function CredentialForm({ side, live, onDone }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState(side.credentialKind ?? 'appservice');
  const [fields, setFields] = useState(EMPTY[side.credentialKind ?? 'appservice']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const set = (name, value) => setFields((f) => ({ ...f, [name]: value }));
  const pick = (next) => { setKind(next); setFields(EMPTY[next]); setError(null); };

  /*
   * Required means required HERE, not just server-side. The backend refuses an incomplete credential
   * too, but a refusal after submit teaches the operator the field list one round trip at a time —
   * and on this path a round trip may be the one that wipes what was there.
   */
  const missing = Object.entries(fields).filter(([, v]) => !String(v).trim()).map(([k]) => k);

  async function submit(event) {
    event.preventDefault();
    if (!live || missing.length) return;
    setBusy(true);
    setError(null);
    const res = await send(`project-sides/${encodeURIComponent(side.id)}/credential`, {
      method: 'PUT',
      body: { credential: { kind, ...fields } },
    });
    setBusy(false);
    if (!res.ok) { setError(res.error || t('cr.failed')); return; }
    /*
     * Cleared on success, and this is the one place a form SHOULD forget what was typed: leaving a
     * token in a React state that a later render could show is a copy of somebody else's secret kept
     * for no reason.
     */
    setFields(EMPTY[kind]);
    setOpen(false);
    await onDone?.();
  }

  async function withdraw() {
    if (!live) return;
    setBusy(true);
    setError(null);
    const res = await send(`project-sides/${encodeURIComponent(side.id)}/credential`, {
      method: 'PUT',
      // Explicit null, which is what the endpoint requires to distinguish withdrawal from an omission.
      body: { credential: null },
    });
    setBusy(false);
    if (!res.ok) { setError(res.error || t('cr.failed')); return; }
    await onDone?.();
  }

  if (!open) {
    return (
      <div className="cred-actions">
        <button type="button" className="btn-s" disabled={!live} onClick={() => setOpen(true)}>
          {side.hasCredential ? t('cr.replace') : t('cr.set')}
        </button>
        {side.hasCredential && (
          <button
            type="button"
            className="btn-s danger"
            disabled={!live || busy}
            onClick={() => {
              /*
               * Confirmed, because withdrawal is not ours to undo: re-issuing means the project side
               * installs a new registration and RESTARTS their homeserver. The cost of the mistake
               * lands on somebody we cannot reach.
               */
              if (window.confirm(t('cr.withdrawConfirm', { side: side.id }))) withdraw();
            }}
          >
            {t('cr.withdraw')}
          </button>
        )}
        {!live && <span className="dim">{t('cr.needLive')}</span>}
        {error && <span className="stranded">{error}</span>}
      </div>
    );
  }

  return (
    <form className="cred-form" onSubmit={submit}>
      <div className="notice">{t('cr.transitWarning')}</div>

      <label className="cred-row">
        <span>{t('cr.kind')}</span>
        <select value={kind} onChange={(e) => pick(e.target.value)}>
          {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
      </label>
      <div className="dim">{t(kind === 'appservice' ? 'cr.kindAs' : 'cr.kindReg')}</div>

      {Object.keys(fields).map((name) => (
        <label className="cred-row" key={name}>
          <span className="mono">{name}</span>
          <input
            // `text` for the namespace and localpart, `password` for the two that are secrets: masking
            // a namespace helps nobody read what they typed, and masking a token keeps it off a
            // screen somebody else may be looking at.
            type={/token/i.test(name) ? 'password' : 'text'}
            value={fields[name]}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => set(name, e.target.value)}
          />
        </label>
      ))}

      <div className="cred-actions">
        <button type="submit" className="btn-s primary" disabled={busy || missing.length > 0}>
          {busy ? t('cr.saving') : t('cr.save')}
        </button>
        <button
          type="button"
          className="btn-s"
          disabled={busy}
          onClick={() => { setFields(EMPTY[kind]); setOpen(false); setError(null); }}
        >
          {t('cr.cancel')}
        </button>
        {missing.length > 0 && <span className="dim">{t('cr.missing', { n: missing.join(', ') })}</span>}
        {error && <span className="stranded">{error}</span>}
      </div>
    </form>
  );
}
