'use client';

import Link from 'next/link';
import PageHead from '@/components/PageHead';
import { useT } from '@/components/Prefs';
import { assignments, dispatch } from '@/lib/mock-data';

/*
 * Assignments — the demand side, which had no window onto it at all.
 *
 * `POST /api/dispatch` exists, returns routed/provision/queued, and nothing in
 * the product ever showed the result. A queued request that says only "queued"
 * is a backlog; one that names the constraint it failed is a diagnosis, so
 * every waiting row carries its reason.
 *
 * `acceptance_pending` renders as a state and never as a button. Accepting
 * delivery is the customer's act, in the Matrix room — the console can show
 * that it is waiting and must not offer to do it.
 */

const LIFECYCLE_CLASS = {
  executing: 'run',
  acceptance_pending: 'pend',
  queued: 'wait',
};

function State({ state, t }) {
  return (
    <span className={`wstate ${LIFECYCLE_CLASS[state]}`}>
      <i aria-hidden="true" />
      {t(`as.state.${state}`)}
    </span>
  );
}

export default function AssignmentsPage() {
  const t = useT();
  const active = assignments.filter((a) => a.state !== 'queued');
  const queued = assignments.filter((a) => a.state === 'queued');
  const executing = active.filter((a) => a.state === 'executing');

  return (
    <>
      <PageHead
        title={t('as.title')}
        sub={t('as.sub', { a: executing.length, b: queued.length })}
      />

      <h2 className="sec">{t('as.active')}<span className="note">{t('as.activeNote')}</span></h2>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t('col.assignment')}</th>
              <th>{t('col.requestedBy')}</th>
              <th>{t('col.needs')}</th>
              <th>{t('col.lifecycle')}</th>
              <th>{t('col.staffed')}</th>
              <th className="num">{t('col.leaseLeft')}</th>
            </tr>
          </thead>
          <tbody>
            {active.map((a) => (
              <tr key={a.id}>
                <td className="faint">{a.id}</td>
                <td>
                  {a.room}
                  <div className="faint" style={{ fontSize: 10.5 }}>
                    {`${a.requester} · ${a.workItem}`}
                  </div>
                  <div className="dim" style={{ fontSize: 11 }}>{a.title}</div>
                </td>
                <td className="dim">{`${a.role} · ${a.capability}`}</td>
                <td>
                  <State state={a.state} t={t} />
                  <div className="faint" style={{ fontSize: 10.5 }}>
                    {a.state === 'executing'
                      ? t('as.gen', { n: a.generation, t: a.since })
                      : t('as.deliveredAgo', { n: a.since })}
                  </div>
                </td>
                <td><Link href={`/agents/${a.agent}`}>{a.agent}</Link></td>
                <td className="num">
                  {a.leaseLeft ?? <span className="dim">{t('as.released')}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="notice">{t('as.acceptanceNote')}</div>

      <h2 className="sec">{t('as.queued')}<span className="note">{t('as.queuedNote')}</span></h2>
      {queued.length === 0 ? (
        <div className="notice">{t('as.emptyQueue')}</div>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('col.assignment')}</th>
                <th>{t('col.requestedBy')}</th>
                <th>{t('col.needs')}</th>
                <th>{t('col.blockedOn')}</th>
                <th className="num">{t('col.waitingFor2')}</th>
              </tr>
            </thead>
            <tbody>
              {queued.map((a) => (
                <tr key={a.id}>
                  <td className="faint">{a.id}</td>
                  <td>
                    {a.room}
                    <div className="dim" style={{ fontSize: 11 }}>{a.title}</div>
                  </td>
                  <td className="dim">{`${a.role} · ${a.capability}`}</td>
                  <td>
                    <span className="wstate unassigned"><i aria-hidden="true" />{t('as.state.queued')}</span>
                    <div className="faint" style={{ fontSize: 10.5 }}>
                      {t(a.blocked, { role: a.role })}
                    </div>
                  </td>
                  <td className="num">{a.waiting}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="notice warn">{t('as.autoProvOff')}</div>
      <p className="dim" style={{ fontSize: 12, marginTop: 10 }}>
        {t('cap.twoQueues')}{' '}
        <Link href="/capacity">{t('nav.capacity')}</Link>
        {dispatch.autoProvisionCap > 0 ? '' : ''}
      </p>
    </>
  );
}
