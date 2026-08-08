'use client';

import Link from 'next/link';
import PageHead from '@/components/PageHead';
import { Toast, useToast } from '@/components/Toast';
import { Blank } from '@/components/Blank';
import { useT } from '@/components/Prefs';
import { capability, roleCapacity, fmtTokens } from '@/lib/mock-data';

/*
 * ③ 能力目录 — L2, and the only layer that faces outward.
 *
 * What a project sees is a ROLE. It asks for a System Architect; it never asks
 * for "octos-agent running Kimi K3". The mapping between the two is private to
 * the contributor, and that privacy is what makes this a resource market rather
 * than a directory of remote shells.
 *
 * The role vocabulary is the system's own — six roles, three tiers, per-role
 * default tier and subsumption, all from lib/matrix-agent.js:11-35 — read here
 * through lib/role-capacity.json, which the prototype imports rather than copies
 * so the two cannot drift.
 *
 * A contributor may NARROW this catalogue by withholding an offer. They may not
 * invent a role, because the project side has to recognise the name for any of
 * it to mean anything.
 */
export default function CapabilityPage() {
  const t = useT();
  const [toast, say] = useToast();
  const cards = capability();

  const offered = cards.filter((c) => c.offer?.published);
  const blocked = cards.filter((c) => !c.crossFamilyOk);
  const empty = cards.filter((c) => c.able.length === 0);

  return (
    <>
      <PageHead title={t('cp.title')} sub={t('cp.sub')} />

      <div className="notice">{t('cp.exposeNote')}</div>

      <div className="cards">
        <div className="card"><div className="cap">{t('cp.cRoles')}</div><div className="val">{cards.length}</div></div>
        <div className="card"><div className="cap">{t('cp.cPublished')}</div><div className="val ok">{offered.length}</div></div>
        <div className="card">
          <div className="cap">{t('cp.cUnfillable')}</div>
          <div className={`val${empty.length > 0 ? ' warn' : ''}`}>{empty.length}</div>
        </div>
        <div className="card">
          <div className="cap">{t('cp.cOverTier')}</div>
          {/* The cost of subsumption, as a headline: how many roles I am
              currently offering with a model stronger than they need. */}
          <div className="val">{cards.filter((c) => c.overTier.length > 0).length}</div>
        </div>
        <div className="card">
          <div className="cap">{t('cp.cBlocked')}</div>
          <div className={`val${blocked.length > 0 ? ' warn' : ''}`}>{blocked.length}</div>
        </div>
      </div>

      <h2 className="sec">{t('cp.catalogue')}<span className="note">{t('cp.catalogueNote')}</span></h2>
      <div className="rolegrid">
        {cards.map((c) => (
          <div className={`rolecard${c.able.length === 0 ? ' unhireable' : ''}`} key={c.key}>
            <div className="rc-head">
              <span className="rc-name">{c.role.displayName}</span>
              <span className="rc-stage">{c.offer?.published ? t('cp.published') : t('cp.withheld')}</span>
            </div>

            {/* The requirement, above the staffing. A card that leads with a
                headcount invites the reader to treat the role as a bucket that
                already exists; it is a specification, and it can be unmeetable. */}
            <div className="rc-def">
              <code className="rc-key">{c.key}</code>
              <span className="rc-min">{t('cp.needTier', { tier: c.role.defaultTier })}</span>
            </div>

            {c.role.crossFamily && (
              <div className={`xfam${c.crossFamilyOk ? ' ok' : ' bad'}`}>
                {c.crossFamilyOk
                  ? t('cp.crossOk', { n: c.families.length })
                  : t('cp.crossBad', { n: c.families.length })}
              </div>
            )}

            <div className="rc-staff">
              {c.able.length === 0 ? (
                <div className="rc-gap bad">
                  {t('cp.fillNone')}
                  <div className="rc-elig">
                    {/* Two different shortfalls, two different actions: configure
                        a model I already own, versus acquire capacity I do not. */}
                    {c.unable.some((u) => u.match.why === 'cap.why.noModel')
                      ? t('cp.fixConfigure')
                      : t('cp.fixAcquire')}
                  </div>
                </div>
              ) : (
                <ul className="rc-list">
                  {c.able.map((r) => (
                    <li key={r.agent.name}>
                      <Link href={`/agents/${r.agent.name}`}>{r.agent.name}</Link>
                      <span className="rc-tier">{r.match.tier}</span>
                      <span className="dim">{r.match.family}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Said ONCE per card, not once per agent. Every strong agent is
                over-tier on a medium role, so a per-row badge produced eight
                identical warnings and buried the one fact worth reading: this
                role can be filled, and filling it this way costs more than it
                needs to. */}
            {c.overTier.length > 0 && (
              <div className="rc-excl over">
                {t('cp.overTierCard', { n: c.overTier.length, need: c.role.defaultTier })}
              </div>
            )}

            {c.excluded.length > 0 && (
              <div className="rc-excl">
                {t('cp.excluded', {
                  models: c.excluded.flatMap((e) => e.models).join(', '),
                  why: c.excluded[0].reason,
                })}
              </div>
            )}

            <div className="rc-offer">
              {c.offer ? (
                <>
                  <span className="dim">
                    {t('cp.offerTerms', {
                      n: c.offer.count,
                      cap: fmtTokens(c.offer.budgetCapPerEngagement),
                      rate: fmtTokens(c.offer.rateCap),
                    })}
                  </span>
                  <button
                    className="btn"
                    disabled={c.able.length === 0 || !c.crossFamilyOk}
                    onClick={() => say('ok', t(c.offer.published ? 'cp.wouldWithdraw' : 'cp.wouldPublish', { role: c.role.displayName }))}
                  >
                    {t(c.offer.published ? 'cp.withdraw' : 'cp.publish')}
                  </button>
                </>
              ) : <Blank why="cp.why.noOffer" t={t} />}
            </div>
          </div>
        ))}
      </div>

      {blocked.length > 0 && (
        <>
          <h2 className="sec">{t('cp.blockedHead')}</h2>
          <div className="notice warn">
            {t('cp.blockedNote', { roles: blocked.map((b) => b.role.displayName).join(', ') })}
          </div>
        </>
      )}

      <h2 className="sec">{t('cp.mappingHead')}<span className="note">{t('cp.mappingNote')}</span></h2>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t('col.tier')}</th><th>{t('col.framework')}</th>
              <th>{t('col.model')}</th><th>{t('col.reasoning')}</th><th>{t('col.family')}</th>
            </tr>
          </thead>
          <tbody>
            {roleCapacity.tiers.flatMap((tier) => (
              (roleCapacity.tierAccepts[tier] ?? []).map((c) => (
                <tr key={`${tier}-${c.framework}-${c.model}-${c.reasoning ?? ''}`}>
                  <td><span className={`tierchip ${tier}`}>{tier}</span></td>
                  <td>{c.framework}</td>
                  <td className="mono-s">{c.model}</td>
                  <td>{c.reasoning ?? <Blank why="cp.why.anyReasoning" t={t} />}</td>
                  <td>{c.family}</td>
                </tr>
              ))
            ))}
          </tbody>
        </table>
      </div>

      <Toast toast={toast} />
    </>
  );
}
