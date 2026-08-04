'use client';

import { useState } from 'react';
import Link from 'next/link';
import PageHead from '@/components/PageHead';
import { Toast, useToast } from '@/components/Toast';
import { presets, agents } from '@/lib/mock-data';

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
        Provider readiness
        <span className="badge" style={{ marginLeft: 8 }}>read only</span>
        <span className="note">HAFleet does not hold provider credentials</span>
      </h2>
      <div className="notice">
        An agent authenticates itself <strong>before</strong> it joins the fleet — its provider
        credential lives with the framework, not here. HAFleet never sees the secret and offers no
        way to set one; it only reports whether the agent resolved a provider, because that is the
        most common reason onboarding fails.
      </div>
      <div className="tbl-wrap" style={{ marginTop: 12 }}>
        <table className="tbl">
          <thead>
            <tr><th>Agent</th><th>Credential lives in</th><th>Provider</th><th>State</th><th>If unresolved</th></tr>
          </thead>
          <tbody>
            {agents.map((a) => {
              const home = {
                hermes: '~/.hermes/',
                codex: '~/.codex/',
                'codex-acp': '~/.codex/',
                claude: '~/.claude/',
                octos: '~/.config/octos/config.json',
              }[a.framework] ?? '—';
              const fix = {
                hermes: 'hermes auth add <provider>',
                codex: 'codex login',
                'codex-acp': 'codex login',
                claude: 'claude login',
                octos: 'edit octos config.json',
              }[a.framework] ?? '—';
              const provider = a.framework === 'hermes' ? 'deepseek' : 'account default';
              return (
                <tr key={a.name}>
                  <td><Link href={`/agents/${a.name}`}>{a.name}</Link></td>
                  <td><code style={{ fontSize: 11.5 }}>{home}</code></td>
                  <td className="dim">{provider}</td>
                  <td><span className="badge ok">resolved</span></td>
                  <td><code style={{ fontSize: 11.5 }}>{fix}</code></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="dim" style={{ fontSize: 12, marginTop: 10 }}>
        HAFleet&apos;s own secrets — <code>API_TOKEN</code>, per-agent tokens,{' '}
        <code>MATRIX_REG_TOKEN</code> — are set once in <code>.env</code> at mode 600 during
        install. They are deliberately not editable from a browser: a dashboard that can rewrite
        its own auth token is a dashboard that can lock everyone out of itself.
      </p>

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
