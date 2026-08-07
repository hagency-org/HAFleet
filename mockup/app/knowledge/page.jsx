'use client';

import Link from 'next/link';
import PageHead from '@/components/PageHead';
import { Toast, useToast } from '@/components/Toast';
import { useT } from '@/components/Prefs';
import { knowledge, acceptedTotal } from '@/lib/mock-data';

/*
 * Knowledge — 培养 read as self-evolution, which is where this fleet is both
 * furthest along and most obviously broken.
 *
 * The per-agent loop already runs: a subconscious watches the transcript, keeps
 * memory blocks and injects guidance into the next prompt. What has no surface
 * is everything *between* agents. Three memories with no connections:
 *
 *   subconscious blocks — one agent, one project, in Letta
 *   knowledge/          — the team's accepted artifacts, in git
 *   agent-knowledge.md  — one workspace, read by nobody else
 *
 * An agent's whole tool surface is eleven MCP tools and none of them reaches
 * knowledge/. So this page does the two things that close the gap: it makes
 * "who actually received a decision" a number, and it gives a private lesson a
 * path into the team's governed artifacts.
 */

export default function KnowledgePage() {
  const t = useT();
  const [toast, say] = useToast();
  const k = knowledge;
  const served = k.memory.filter((m) => m.citations7d > 0).length;
  const starved = k.memory.find((m) => m.endpoint === 'off');

  return (
    <>
      <PageHead
        title={t('kn.title')}
        sub={t('kn.sub', { a: acceptedTotal(), b: k.proposals.length })}
      />

      <div className="cards">
        <div className="card">
          <div className="cap">{t('kn.decisions')}</div>
          <div className="val">{k.accepted.decisions}<small> {t('kn.adrs')}</small></div>
        </div>
        <div className="card">
          <div className="cap">{t('kn.requirements')}</div>
          <div className="val">{k.accepted.requirements}</div>
        </div>
        <div className="card">
          <div className="cap">{t('kn.proposalsCard')}</div>
          <div className={`val${k.proposals.length > 0 ? ' warn' : ''}`}>
            {k.proposals.length}<small> {t('kn.waitingCard')}</small>
          </div>
        </div>
        <div className="card">
          <div className="cap">{t('kn.served')}</div>
          <div className="val">{served}<small> {t('wf.ofQualified', { n: k.memory.length })}</small></div>
        </div>
        <div className="card">
          <div className="cap">{t('kn.citations')}</div>
          <div className="val">{k.memory.reduce((n, m) => n + m.citations7d, 0)}</div>
        </div>
      </div>

      <div className="split">
        <div>
          <h2 className="sec">
            {t('kn.promotion')}
            <span className="note">{t('kn.promotionNote')}</span>
          </h2>

          {k.proposals.length === 0 ? (
            <div className="notice">{t('kn.emptyProposals')}</div>
          ) : k.proposals.map((p) => (
            <div className="panel" key={p.id} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', gap: 9, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span className="badge">{t('kn.proposal')}</span>
                <b style={{ fontSize: 13 }}>{p.title}</b>
              </div>
              <p className="dim" style={{ fontSize: 11.5, margin: '8px 0 4px' }}>
                {t('kn.proposedBy', { who: p.by, from: p.from })}
              </p>
              <p
                className={p.lint === 'pass' ? 'dim' : 'warn-text'}
                style={{ fontSize: 11.5, margin: '0 0 10px' }}
              >
                {p.lint === 'pass' ? t('kn.lintPass') : t('kn.lintFail', { why: t(p.lintWhy) })}
              </p>
              <div className="btn-row">
                {p.lint === 'pass'
                  ? (
                    <button className="btn primary" onClick={() => say('ok', t('kn.promote'))}>
                      {t('kn.promote')}
                    </button>
                  )
                  : (
                    <button className="btn" onClick={() => say('ok', t('kn.viewLint'))}>
                      {t('kn.viewLint')}
                    </button>
                  )}
                <button className="btn" onClick={() => say('ok', t('kn.returnNote'))}>
                  {t('kn.returnNote')}
                </button>
              </div>
            </div>
          ))}
        </div>

        <div>
          <h2 className="sec" style={{ marginTop: 0 }}>
            {t('kn.received')}
            <span className="note">{t('kn.receivedNote')}</span>
          </h2>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('col.employee')}</th>
                  <th className="num">{t('col.citations')}</th>
                  <th>{t('col.memory')}</th>
                </tr>
              </thead>
              <tbody>
                {k.memory.map((m) => (
                  <tr key={m.agent}>
                    <td><Link href={`/agents/${m.agent}`}>{m.agent}</Link></td>
                    <td className="num">
                      {m.citations7d > 0 ? m.citations7d : (
                        <>
                          <span className="mk-dash">0</span>
                          <span className="why-inline">{t('kn.neverFetched')}</span>
                        </>
                      )}
                    </td>
                    <td>
                      <span className={`chip-mem${m.endpoint === 'off' ? ' off' : ''}`}>
                        {m.endpoint === 'off' ? t('kn.memoryOff') : t('kn.memoryLocal')}
                        <i>{m.endpoint === 'off' ? t('kn.noMemory') : t('kn.subconscious')}</i>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {starved && (
            <div className="notice warn">{t('kn.starved', { who: starved.agent })}</div>
          )}
          <div className="notice ok">{t('kn.transcriptsLocal')}</div>
        </div>
      </div>

      <Toast toast={toast} />
    </>
  );
}
