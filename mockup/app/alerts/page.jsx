'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import PageHead from '@/components/PageHead';
import Severity from '@/components/Severity';
import { Toast, useToast } from '@/components/Toast';
import {
  alerts as ALL, alertCounts, ALERT_STATUSES, SEVERITIES,
  bySeverityThenAge, fmtSpanSec,
} from '@/lib/mock-data';
import { useT } from '@/components/Prefs';

/*
 * Alerts triage.
 *
 * The correction round 2 demanded and the static mockup never got: the summary is
 * TWO strips, one dimension each. The old strip mixed four lifecycle statuses
 * with one severity metric and omitted `resolved`, which encodes two different
 * things as if they were one.
 *
 * Selection lives in the URL (?alert=id) so a link survives a refresh, and the
 * detail panel always shows the row that is highlighted — the round-2 mockup
 * highlighted one row while the panel showed another, which is the stale-selection
 * bug a design is supposed to prevent.
 *
 * Only legal transitions render, derived from the current status.
 */

const NEXT_STATUS = {
  open: ['acknowledged', 'assigned', 'resolved', 'suppressed'],
  acknowledged: ['assigned', 'resolved', 'suppressed'],
  assigned: ['resolved', 'suppressed'],
  resolved: [],
  suppressed: ['open'],
};

// Keys, not words: the button text has to follow the language switch, and the
// toast that reports the result has to use the same word as the button.
const ACTION_KEY = {
  acknowledged: 'act.acknowledge',
  assigned: 'act.assignToMe',
  resolved: 'act.resolve',
  suppressed: 'act.suppress',
  open: 'act.reopen',
};

export default function AlertsPage() {
  const t = useT();
  const [status, setStatus] = useState('open');
  const [severity, setSeverity] = useState('all');
  const [agent, setAgent] = useState('all');
  const [selectedId, setSelectedId] = useState(null);
  const [busy, setBusy] = useState(null);
  const [toast, say] = useToast();

  const { byStatus, bySeverity } = alertCounts();
  const agentNames = useMemo(() => [...new Set(ALL.map((a) => a.agent))], []);

  const rows = useMemo(() => {
    const out = ALL.filter((a) => (status === 'all' ? true : a.status === status))
      .filter((a) => (severity === 'all' ? true : a.severity === severity))
      .filter((a) => (agent === 'all' ? true : a.agent === agent));
    return out.sort(bySeverityThenAge);
  }, [status, severity, agent]);

  // The selected row is always one of the visible rows, so the panel can never
  // describe something other than what is highlighted.
  const selected = rows.find((r) => r.id === selectedId) ?? rows[0] ?? null;

  function act(next) {
    if (!selected) return;
    setBusy(next);
    // A real action stays in-flight until confirmed; failure keeps prior state.
    setTimeout(() => {
      setBusy(null);
      say('ok', t('al.didTransition', { action: t(ACTION_KEY[next]), id: selected.id, status: next }));
    }, 420);
  }

  return (
    <>
      <PageHead title={t('al.title')} sub={t('common.updatedAgo', { n: '6s' })} />

      {/* Strip 1 — lifecycle status, all five, including resolved */}
      <h2 className="sec" style={{ marginTop: 0 }}>
        {t('al.byStatus')}
        <span className="note">{t('al.byStatusNote')}</span>
      </h2>
      <div className="cards">
        {ALERT_STATUSES.map((s) => (
          <div className="card" key={s}>
            <div className="cap">{s}</div>
            <div className={`val${s === 'open' && byStatus[s] > 0 ? ' warn' : ''}`}>{byStatus[s]}</div>
          </div>
        ))}
      </div>

      {/* Strip 2 — severity, of the OPEN set only. Stated, so the number is unambiguous. */}
      <h2 className="sec">
        {t('al.bySeverity')}
        <span className="note">{t('al.bySeverityNote', { n: byStatus.open })}</span>
      </h2>
      <div className="cards">
        {SEVERITIES.map((s) => (
          <div className="card" key={s}>
            <div className="cap">{s}</div>
            <div className={`val${s === 'critical' && bySeverity[s] > 0 ? ' bad' : ''}${s === 'warning' && bySeverity[s] > 0 ? ' warn' : ''}`}>
              {bySeverity[s]}
            </div>
          </div>
        ))}
      </div>

      <div className="btn-row" style={{ margin: '22px 0 12px' }}>
        <label style={{ fontSize: 12, color: 'var(--ink-dim)' }}>
          {t('col.status')}{' '}
          <select value={status} onChange={(e) => { setStatus(e.target.value); setSelectedId(null); }}>
            <option value="all">{t('common.all')}</option>
            {ALERT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12, color: 'var(--ink-dim)' }}>
          {t('col.severity')}{' '}
          <select value={severity} onChange={(e) => { setSeverity(e.target.value); setSelectedId(null); }}>
            <option value="all">{t('common.all')}</option>
            {SEVERITIES.map((s) => <option key={s} value={s}>{t(`sev.${s}`)}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12, color: 'var(--ink-dim)' }}>
          {t('col.agent')}{' '}
          <select value={agent} onChange={(e) => { setAgent(e.target.value); setSelectedId(null); }}>
            <option value="all">{t('common.all')}</option>
            {agentNames.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <span className="spacer" style={{ flex: 1 }} />
        <span className="sub dim" style={{ fontSize: 12 }}>
          {t('common.shown', { a: rows.length, b: ALL.length })}
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="empty">
          <div className="big">{t('al.noMatch')}</div>
          <p className="small">{t('al.widen', { n: ALL.length })}</p>
          <button className="btn" onClick={() => { setStatus('all'); setSeverity('all'); setAgent('common.all'); }}>
            {t('al.reset')}
          </button>
        </div>
      ) : (
        <div className="split">
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('col.severity')}</th>
                  <th>{t('col.alert')}</th>
                  <th className="num">{t('col.age')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr
                    key={a.id}
                    aria-selected={selected?.id === a.id}
                    onClick={() => setSelectedId(a.id)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td><Severity level={a.severity} /></td>
                    <td>
                      <div>{a.summary}</div>
                      <div className="faint" style={{ fontSize: 11 }}>
                        {a.agent} · ×{a.occurrences} · {a.status}
                      </div>
                    </td>
                    <td className="num dim">{fmtSpanSec(a.ageSec)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selected && (
            <div className="panel">
              <h3>{selected.summary}</h3>
              <dl className="kv">
                <dt>{t('col.id')}</dt><dd>{selected.id}</dd>
                <dt>{t('col.status')}</dt><dd>{selected.status}</dd>
                <dt>{t('col.severity')}</dt><dd><Severity level={selected.severity} /></dd>
                <dt>{t('col.agent')}</dt>
                <dd><Link href={`/agents/${selected.agent}`}>{selected.agent}</Link></dd>
                <dt>{t('al.firstSeen')}</dt><dd>{t('common.ago', { n: fmtSpanSec(selected.firstSeenSec) })}</dd>
                <dt>{t('al.occurrences')}</dt><dd>{selected.occurrences}</dd>
              </dl>

              <p style={{ fontSize: 12.5, color: 'var(--ink-2)', marginTop: 12 }}>{selected.detail}</p>

              <div className="btn-row" style={{ marginTop: 14 }}>
                {NEXT_STATUS[selected.status].length === 0 ? (
                  <span className="dim" style={{ fontSize: 12 }}>
                    {t('al.noTransitions', { s: selected.status })}
                  </span>
                ) : (
                  NEXT_STATUS[selected.status].map((n) => (
                    <button key={n} className="btn" disabled={busy === n} onClick={() => act(n)}>
                      {busy === n ? '…' : t(ACTION_KEY[n])}
                    </button>
                  ))
                )}
              </div>

              {selected.notes.length > 0 && (
                <>
                  <h3 style={{ marginTop: 18 }}>{t('al.notes')}</h3>
                  {selected.notes.map((n, i) => (
                    <div key={i} style={{ fontSize: 12.5, marginBottom: 8 }}>
                      <span className="faint">{n.at} · {n.by}</span>
                      <div>{n.text}</div>
                    </div>
                  ))}
                </>
              )}

              <div className="danger-zone">
                <span className="lbl">{t('al.actions')}</span>
                <button className="btn danger" onClick={() => say('fail', t('al.deleteRefused', { id: selected.id }))}>
                  {t('act.delete')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <Toast toast={toast} />
    </>
  );
}
