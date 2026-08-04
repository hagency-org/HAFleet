'use client';

import PageHead from '@/components/PageHead';
import { pool, dispatch } from '@/lib/mock-data';
import { useT } from '@/components/Prefs';

/*
 * Capacity — the human window onto a live scheduler.
 *
 * An earlier draft called this a read-only grid and suggested retiring it if nothing
 * read it. That was wrong, and wrong because I checked the PAGE and not the API.
 * /api/pool is consumed by lib/matrix-agent.js and src/dispatch-lease-store.mjs:
 * POST /api/dispatch asks for "a <role> agent at <capability>", selectAgent() picks
 * one from these cells, and a lease marks it busy until the TTL lapses. GET /api/pool
 * reaps expired leases before answering, and an expired lease raises the
 * `dispatch_lease_expired` alert.
 *
 * So the grid is the scheduler's state. The only thing wrong with the old page was
 * its name: POOL named the data structure rather than the question.
 */
function Cell({ pair, t }) {
  if (!pair) return <td className="dim" title={t('cap.noneInRole')}>–</td>;
  const [idle, total] = pair;
  const cls = idle > 0 ? 'cap-free' : total > 1 ? 'cap-tight' : 'cap-busy';
  const barCls = idle > 0 ? '' : total > 1 ? 'tight' : 'busy';
  return (
    <td>
      <div className={`cap-cell ${barCls}`}>
        <span className={cls}>{idle}/{total}</span>
        <span className="bar"><i style={{ width: `${(idle / total) * 100}%` }} /></span>
      </div>
    </td>
  );
}

export default function CapacityPage() {
  const t = useT();

  return (
    <>
      <PageHead title={t('cap.title')} sub={t('cap.sub', { n: '8s' })} />

      <p className="dim" style={{ fontSize: 12.5, maxWidth: '76ch' }}>
        {t('cap.explain')}
      </p>

      <div className="tbl-wrap" style={{ marginTop: 14 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>{t('col.role')}</th>
              {pool.capabilities.map((c) => <th key={c}>{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {pool.roles.map((r) => (
              <tr key={r.role}>
                <td>{r.role}</td>
                {pool.capabilities.map((c) => <Cell key={c} pair={r.cells[c]} t={t} />)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="legend">
        <span><i style={{ background: 'var(--ok)' }} />{t('cap.idleAvailable')}</span>
        <span><i style={{ background: 'var(--warn)' }} />{t('cap.allBusyMany')}</span>
        <span><i style={{ background: 'var(--line-strong)' }} />{t('cap.allBusyOne')}</span>
        <span><i style={{ background: 'transparent', border: '1px solid var(--line-strong)' }} />– {t('cap.notSupported')}</span>
      </div>

      <h2 className="sec">
        {t('cap.activeLeases')}
        <span className="note">{t('cap.leaseNote')}</span>
      </h2>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr><th>{t('col.agent')}</th><th>{t('col.cell')}</th><th>{t('col.owner')}</th><th>{t('col.lease')}</th><th className="num">{t('col.expiresIn')}</th></tr>
          </thead>
          <tbody>
            {dispatch.leases.map((l) => (
              <tr key={l.leaseId}>
                <td>{l.agent}</td>
                <td className="dim">{l.role} · {l.capability}</td>
                <td className="dim">{l.owner}</td>
                <td className="faint">{l.leaseId}</td>
                <td className="num">{l.expiresIn}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="dim" style={{ fontSize: 12, marginTop: 8 }}>
        {t('cap.ttlNote', { n: dispatch.leaseTtlMinutes })}
      </p>

      {dispatch.queuedTickets.length > 0 && (
        <>
          <h2 className="sec">
            {t('cap.waitingCell')}
            <span className="note">{t('cap.waitingNote')}</span>
          </h2>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>{t('col.ticket')}</th><th>{t('col.cell')}</th><th className="num">{t('col.waitingFor')}</th></tr></thead>
              <tbody>
                {dispatch.queuedTickets.map((tk) => (
                  <tr key={tk.ticket}>
                    <td className="faint">{tk.ticket}</td>
                    <td className="dim">{tk.role} · {tk.capability}</td>
                    <td className="num">{tk.waiting}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="dim" style={{ fontSize: 12, marginTop: 8 }}>
            {t('cap.twoQueues')}
          </p>
        </>
      )}

      <div className="notice" style={{ marginTop: 22 }}>
        <strong>{t(dispatch.autoProvisionCap > 0 ? 'cap.autoProvOn' : 'cap.autoProvOff')}</strong>{' '}
        {t('cap.autoProvNote', { n: dispatch.autoProvisionCap })}
      </div>

    </>
  );
}
