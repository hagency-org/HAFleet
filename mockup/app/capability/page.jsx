'use client';

import Link from 'next/link';
import PageHead from '@/components/PageHead';
import { Toast, useToast } from '@/components/Toast';
import { Blank } from '@/components/Blank';
import { useT } from '@/components/Prefs';
import { fmtTokens } from '@/lib/mock-data';
import { useData, Provenance } from '@/components/Data';
import { send } from '@/lib/api';

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
  const { capability, roleCapacity, agents, offers, provenance, refresh } = useData();
  const live = provenance.offers === 'live';

  /*
   * Publishing a role is what makes the contributor discoverable, so it is a real
   * write. The offer's other terms are preserved on toggle — sending only
   * `published` would silently reset the caps a contributor had set, which is the
   * kind of data loss a toggle should never cause.
   */
  async function togglePublish(c) {
    const current = offers.find((o) => o.role === c.key) ?? c.offer ?? {};
    if (!live) {
      return say('ok', t(current.published ? 'cp.wouldWithdraw' : 'cp.wouldPublish', { role: c.role.displayName }));
    }
    const res = await send(`offers/${c.key}`, {
      method: 'PUT',
      body: {
        count: current.count ?? null,
        budgetCapPerEngagement: current.budgetCapPerEngagement ?? null,
        rateCap: current.rateCap ?? null,
        published: !current.published,
      },
    });
    if (!res.ok) return say('fail', res.error);
    await refresh();
    return say('ok', t(current.published ? 'cp.didWithdraw' : 'cp.didPublish', { role: c.role.displayName }));
  }
  /*
   * The offer's TERMS — how many of this role, the per-engagement cap, the daily rate cap.
   * `PUT /api/offers/:role` has always accepted all three; nothing in the console asked for them,
   * so every offer a contributor published carried none and the card read "no terms". Publishing a
   * role while being unable to state its price is the half of the transaction the contributor
   * actually cares about, so the inputs belong next to the toggle rather than in a second place.
   *
   * `published` is carried through unchanged, for the same reason the toggle carries the caps: a
   * write that touches one field must not silently reset the others.
   */
  async function saveTerms(c, patch) {
    const current = offers.find((o) => o.role === c.key) ?? c.offer ?? {};
    if (!live) return say('ok', t('cp.wouldSetTerms', { role: c.role.displayName }));
    const res = await send(`offers/${c.key}`, {
      method: 'PUT',
      body: {
        count: current.count ?? null,
        budgetCapPerEngagement: current.budgetCapPerEngagement ?? null,
        rateCap: current.rateCap ?? null,
        published: current.published ?? false,
        ...patch,
      },
    });
    if (!res.ok) return say('fail', res.error);
    await refresh();
    return say('ok', t('cp.didSetTerms', { role: c.role.displayName }));
  }

  const [toast, say] = useToast();
  /*
   * The offer is joined here rather than inside the capability payload.
   *
   * GET /api/capability answers "can I fill this role", which is a fact about
   * agents and models; GET /api/offers answers "am I advertising it", which is a
   * choice. Keeping them in separate endpoints means publishing a role cannot
   * accidentally look like acquiring the capacity for it — so the join belongs
   * here, in the one view that shows both.
   */
  const cards = capability().map((c) => ({
    ...c,
    offer: offers.find((o) => o.role === c.key) ?? c.offer ?? null,
  }));

  /*
   * Agents that qualify for NOTHING.
   *
   * Said once for the page rather than once per card, for the same reason the
   * over-tier note is per card rather than per agent: an agent with no model is
   * absent from all six roles for one reason, so six identical lines would bury
   * the single fact worth reading. The catalogue is the outward-facing layer, and
   * an agent that no project can ever be offered belongs in its summary — the
   * roster page saying "no model chosen" is not the same claim.
   */
  const deadWeight = agents.filter((a) => cards.every((c) => !c.able.some((r) => r.agent.name === a.name)));

  const offered = cards.filter((c) => c.offer?.published);
  const blocked = cards.filter((c) => !c.crossFamilyOk);
  const empty = cards.filter((c) => c.able.length === 0);

  return (
    <>
      <PageHead title={t('cp.title')} sub={t('cp.sub')} />

      {/* Roles and their qualifying combinations come from a shipped config file;
          which of them I can FILL is computed from live agents; the offer that
          publishes a role has no endpoint at all. Three different provenances on
          one page, so the banner names them separately. */}
      <Provenance slices={['capability', 'agents', 'offers']} />

      <div className="notice">{t('cp.exposeNote')}</div>

      {deadWeight.length > 0 && (
        <div className="notice warn">
          <div>
            {t('cp.deadWeight', {
              n: deadWeight.length,
              of: agents.length,
              names: deadWeight.map((a) => a.name).join(', '),
            })}
          </div>
          <div>{t('cp.deadWeightWhy')}</div>
        </div>
      )}

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
                    {/*
                      * An unset term reads "not set", never `null`.
                      *
                      * The fixture's offers always carried all three, so this line
                      * was only ever exercised with values. A real offer created by
                      * the publish toggle has none of them — nothing asks for them
                      * yet — and the card rendered "offering null, up to null each,
                      * null/day", which is both meaningless and the one thing this
                      * console is not allowed to print.
                      */}
                    {[c.offer.count, c.offer.budgetCapPerEngagement, c.offer.rateCap].every((v) => v == null)
                      ? t('cp.offerNoTerms')
                      : t('cp.offerTerms', {
                        n: c.offer.count ?? t('cp.unset'),
                        cap: fmtTokens(c.offer.budgetCapPerEngagement) ?? t('cp.unset'),
                        rate: fmtTokens(c.offer.rateCap) ?? t('cp.unset'),
                      })}
                  </span>
                  <div className="terms">
                    {/*
                      * A blank field means "not set" and is sent as null, never as 0: an offer of
                      * zero tokens is a refusal, and one that was simply never priced is not.
                      */}
                    <label>
                      {t('cp.termCount')}
                      <input
                        type="number" min="1" placeholder={t('cp.unset')}
                        defaultValue={c.offer.count ?? ''}
                        onBlur={(ev) => {
                          const v = ev.target.value.trim();
                          const next = v === '' ? null : Number(v);
                          if (next !== (c.offer.count ?? null)) saveTerms(c, { count: next });
                        }}
                      />
                    </label>
                    <label>
                      {t('cp.termCap')}
                      <input
                        type="number" min="1" placeholder={t('cp.unset')}
                        defaultValue={c.offer.budgetCapPerEngagement ?? ''}
                        onBlur={(ev) => {
                          const v = ev.target.value.trim();
                          const next = v === '' ? null : Number(v);
                          if (next !== (c.offer.budgetCapPerEngagement ?? null)) saveTerms(c, { budgetCapPerEngagement: next });
                        }}
                      />
                    </label>
                    <label>
                      {t('cp.termRate')}
                      <input
                        type="number" min="1" placeholder={t('cp.unset')}
                        defaultValue={c.offer.rateCap ?? ''}
                        onBlur={(ev) => {
                          const v = ev.target.value.trim();
                          const next = v === '' ? null : Number(v);
                          if (next !== (c.offer.rateCap ?? null)) saveTerms(c, { rateCap: next });
                        }}
                      />
                    </label>
                  </div>
                  <button
                    className="btn"
                    disabled={c.able.length === 0 || !c.crossFamilyOk}
                    onClick={() => togglePublish(c)}
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
