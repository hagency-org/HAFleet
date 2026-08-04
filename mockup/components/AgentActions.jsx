'use client';

import { useState } from 'react';
import { Toast, useToast } from '@/components/Toast';

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
  const [confirming, setConfirming] = useState(null);
  const [typed, setTyped] = useState('');
  const [toast, say] = useToast();

  return (
    <>
      <div className="danger-zone">
        <span className="lbl">Agent actions</span>
        {confirming === null && (
          <>
            <button className="btn warn" onClick={() => setConfirming('stop')}>Stop agent</button>
            <button className="btn danger" onClick={() => { setConfirming('remove'); setTyped(''); }}>
              Remove agent
            </button>
          </>
        )}
      </div>

      {confirming === 'stop' && (
        <div className="notice warn" style={{ marginTop: 10 }}>
          Stop <strong>{agent.name}</strong>? It stays registered and the supervisor will restart it.
          <div className="btn-row" style={{ marginTop: 10 }}>
            <button className="btn warn" onClick={() => { setConfirming(null); say('ok', `${agent.name} stopped`); }}>
              Stop it
            </button>
            <button className="btn" onClick={() => setConfirming(null)}>Cancel</button>
          </div>
        </div>
      )}

      {confirming === 'remove' && (
        <div className="notice warn" style={{ marginTop: 10, borderColor: 'var(--bad)', color: 'var(--bad)', background: 'var(--bad-soft)' }}>
          Remove <strong>{agent.name}</strong> permanently. This deregisters it and deletes its
          record. It cannot be undone. Type the agent name to confirm.
          <div className="btn-row" style={{ marginTop: 10 }}>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={agent.name}
              aria-label={`Type ${agent.name} to confirm removal`}
              style={{ font: '400 12px var(--sans)', padding: '5px 9px', border: '1px solid var(--bad)', borderRadius: 5 }}
            />
            <button
              className="btn danger"
              disabled={typed !== agent.name}
              onClick={() => { setConfirming(null); say('ok', `${agent.name} removed`); }}
            >
              Remove permanently
            </button>
            <button className="btn" onClick={() => setConfirming(null)}>Cancel</button>
          </div>
        </div>
      )}

      <Toast toast={toast} />
    </>
  );
}
