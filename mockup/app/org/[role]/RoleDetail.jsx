'use client';

import Link from 'next/link';
import PageHead from '@/components/PageHead';
import { useT } from '@/components/Prefs';
import { useProjectedView, ViewToggle } from '@/components/ViewToggle';
import { ScopeSections } from '@/components/ScopeSections';
import { orgGroups, roleOf, retiredRoles, TIER_RUNTIME } from '@/lib/mock-data';

/*
 * One role — the unit level of the dotted line.
 *
 * Definition first, staffing second, then the same five sections every other scope
 * renders. The definition leads because it is the thing that can be wrong: a role
 * nobody satisfies usually means the specification drifted, not that hiring failed.
 */
export default function RoleDetail({ roleKey }) {
  const t = useT();
  const [view, choose] = useProjectedView();

  const role = roleOf(roleKey);
  const g = orgGroups(view).find((x) => x.role.key === roleKey);
  const aliases = retiredRoles.filter((r) => r.aliasTo === roleKey);

  return (
    <>
      <PageHead title={role.name} sub={t('og.roleSub', { key: role.key, stage: t(`stage.${role.stage}`) })}>
        <ViewToggle view={view} choose={choose} />
      </PageHead>

      {view === 'assigned' && <div className="notice warn">{t('cap.assignedHypothetical')}</div>}

      <h2 className="sec">{t('og.definition')}<span className="note">{t('og.skillsAsserted')}</span></h2>
      <div className="panel">
        <div className="prov-row">
          <span className="grow">{t('og.minTier')}</span>
          <span>{`${role.minTier} · ${TIER_RUNTIME[role.minTier]}`}</span>
        </div>
        <div className="prov-row">
          <span className="grow">{t('og.floorNote')}</span>
        </div>
        {role.narrowedFrom && (
          <div className="prov-row">
            <span className="grow">{t('og.narrowedRow', { tier: role.narrowedFrom })}</span>
          </div>
        )}
        <div className="prov-row">
          <span className="grow">{t('og.hasSkills')}</span>
          <span>{role.skills.map((s) => <span className="chip-skill" key={s}>{s}</span>)}</span>
        </div>
        {aliases.length > 0 && (
          <div className="prov-row">
            <span className="grow">{t('og.receivesFrom')}</span>
            <span>{aliases.map((a) => <code key={a.key}>{a.key}</code>)}</span>
          </div>
        )}
      </div>

      {g.allocated.length === 0 && (
        <div className={`notice${g.gap === 'unhireable' ? ' warn' : ''}`}>
          {t(`og.gap.${g.gap}`, { n: g.gap === 'contended' ? g.qualified.length : g.eligible.length })}
        </div>
      )}

      {g.eligible.length > 0 && (
        <div className="notice">
          {t('og.eligibleList', { names: g.eligible.map((e) => e.agent).join(', ') })}
        </div>
      )}

      <ScopeSections dim="role" scope={roleKey} view={view} people={g.allocated} />

      <p className="dim" style={{ fontSize: 12, marginTop: 18 }}>
        <Link href="/org">{t('og.backToOrg')}</Link>
      </p>
    </>
  );
}
