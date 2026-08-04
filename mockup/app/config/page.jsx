'use client';

import { useState } from 'react';
import Link from 'next/link';
import PageHead from '@/components/PageHead';
import { Toast, useToast } from '@/components/Toast';
import { presets, credentials, agents } from '@/lib/mock-data';

/*
 * Config — three sections separated by blast radius, not by data type.
 *
 * The live page mixes agent start/delete with framework presets and credentials in
 * one flat surface, so a preset edit and an irreversible delete look alike. Here
 * each section states its scope, and the destructive one is marked and last.
 */
export default function ConfigPage() {
  const [toast, say] = useToast();
  const [removing, setRemoving] = useState(null);

  return (
    <>
      <PageHead title="Config">
        <span className="badge attention">fleet-wide</span>
      </PageHead>

      <h2 className="sec" style={{ marginTop: 6 }}>
        Framework presets
        <span className="note">applied when an agent is created; changing one does not affect a running agent</span>
      </h2>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr><th>Preset</th><th>Framework</th><th>Model</th><th /></tr></thead>
          <tbody>
            {presets.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td className="dim">{p.framework}</td>
                <td className="dim">{p.model}</td>
                <td>
                  <button className="btn" onClick={() => say('ok', `Preset ${p.name} deleted`)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="btn-row" style={{ marginTop: 10 }}>
        <button className="btn primary" onClick={() => say('ok', 'New preset form would open here')}>
          + Add preset
        </button>
      </div>

      <h2 className="sec">
        Credentials
        <span className="note">stored per provider; a blank field leaves the existing value unchanged</span>
      </h2>
      <div className="panel">
        {credentials.map((c) => (
          <div key={c.env} style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
            <code style={{ minWidth: 210, fontSize: 12 }}>{c.env}</code>
            <input
              type="password"
              placeholder={c.set ? '••••••••••••  (unchanged)' : 'not set'}
              aria-label={c.env}
              style={{
                flex: 1, maxWidth: 300, font: '400 12px var(--mono)', padding: '5px 9px',
                border: '1px solid var(--line)', borderRadius: 5,
              }}
            />
            <span className={c.set ? 'badge ok' : 'badge'}>
              {c.set ? `set ${c.setAgo}` : 'unset'}
            </span>
          </div>
        ))}
        <div className="btn-row" style={{ marginTop: 4 }}>
          <button className="btn" onClick={() => say('ok', 'Credentials saved; blank fields left unchanged')}>
            Save credentials
          </button>
        </div>
        <p className="faint" style={{ fontSize: 11.5, marginTop: 8 }}>
          Values are never displayed, only their set state and age. To clear one, use the explicit
          Clear action rather than submitting an empty field — a blank field means “unchanged”.
        </p>
      </div>

      <h2 className="sec">
        Agent lifecycle
        <span className="badge attention" style={{ marginLeft: 8 }}>destructive</span>
        <span className="note">creates and removes agents across the fleet</span>
      </h2>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr><th>Agent</th><th>Framework</th><th>Transport</th><th>State</th><th /></tr></thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.name}>
                <td><Link href={`/agents/${a.name}`}>{a.name}</Link></td>
                <td className="dim">{a.framework}</td>
                <td className="dim">{a.transport}</td>
                <td>
                  <span className={`badge${a.activeNow ? ' ok' : ''}`}>
                    {a.activeNow ? 'active' : 'idle'}
                  </span>
                </td>
                <td>
                  <div className="btn-row">
                    <button className="btn warn" onClick={() => say('ok', `${a.name} stopped`)}>Stop</button>
                    <button className="btn danger" onClick={() => setRemoving(a.name)}>Remove</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="btn-row" style={{ marginTop: 10 }}>
        <button className="btn" onClick={() => say('ok', 'New agent form would open here')}>+ New agent</button>
      </div>

      {removing && (
        <div className="notice warn" style={{ marginTop: 14, borderColor: 'var(--bad)', color: 'var(--bad)', background: 'var(--bad-soft)' }}>
          Remove <strong>{removing}</strong>? This deregisters it and deletes its record. It cannot be
          undone.
          <div className="btn-row" style={{ marginTop: 10 }}>
            <button className="btn danger" onClick={() => { say('ok', `${removing} removed`); setRemoving(null); }}>
              Remove permanently
            </button>
            <button className="btn" onClick={() => setRemoving(null)}>Cancel</button>
          </div>
        </div>
      )}

      <Toast toast={toast} />
    </>
  );
}
