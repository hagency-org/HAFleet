'use client';

import { useState } from 'react';
import { Toast, useToast } from '@/components/Toast';
import { useT } from '@/components/Prefs';

/*
 * Stop and Remove, deliberately exiled.
 *
 * Round 1 put these in the page header beside the refresh controls. Codex objected:
 * rare destructive controls do not belong next to frequent navigation, and a
 * confirmation helps after a slip, not before one. So they sit below everything,
 * behind a divider, with their own label — and Remove requires typing the name,
 * because a confirm dialog is a reflex whereas typing is a decision.
 */
export default function AgentActions({ agent }) {
  const t = useT();
  const [confirming, setConfirming] = useState(null);
  const [typed, setTyped] = useState('');
  const [toast, say] = useToast();

  return (
    <>
      <div className="danger-zone">
        <span className="lbl">{t('ag.agentActions')}</span>
        {confirming === null && (
          <>
            <button className="btn warn" onClick={() => setConfirming('stop')}>{t('ag.stopAgent')}</button>
            <button className="btn danger" onClick={() => { setConfirming('remove'); setTyped(''); }}>
              {t('ag.removeAgent')}
            </button>
          </>
        )}
      </div>

      {confirming === 'stop' && (
        <div className="notice warn" style={{ marginTop: 10 }}>
          {t('ag.stopConfirm', { name: agent.name })}
          <div className="btn-row" style={{ marginTop: 10 }}>
            <button className="btn warn" onClick={() => { setConfirming(null); say('ok', t('ag.stopped', { name: agent.name })); }}>
              {t('ag.stopIt')}
            </button>
            <button className="btn" onClick={() => setConfirming(null)}>{t('act.cancel')}</button>
          </div>
        </div>
      )}

      {confirming === 'remove' && (
        <div className="notice warn" style={{ marginTop: 10, borderColor: 'var(--bad)', color: 'var(--bad)', background: 'var(--bad-soft)' }}>
          {t('ag.removeConfirm', { name: agent.name })}
          <div className="btn-row" style={{ marginTop: 10 }}>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={agent.name}
              aria-label={t('ag.typeToConfirm', { name: agent.name })}
              style={{ font: '400 12px var(--sans)', padding: '5px 9px', border: '1px solid var(--bad)', borderRadius: 5 }}
            />
            <button
              className="btn danger"
              disabled={typed !== agent.name}
              onClick={() => { setConfirming(null); say('ok', t('ag.removed', { name: agent.name })); }}
            >
              {t('ag.removePermanently')}
            </button>
            <button className="btn" onClick={() => setConfirming(null)}>{t('act.cancel')}</button>
          </div>
        </div>
      )}

      <Toast toast={toast} />
    </>
  );
}
