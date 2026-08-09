'use client';

import Link from 'next/link';
import AgentHeader from '@/components/AgentHeader';
import AgentTabs from '@/components/AgentTabs';
import AgentActions from '@/components/AgentActions';
import { Provenance, useData } from '@/components/Data';
import { useT } from '@/components/Prefs';

/*
 * One agent, resolved against whichever roster is loaded.
 *
 * Why this is a client component rather than the page itself: the page has to stay
 * a server module to export `generateStaticParams`, but the roster it must resolve
 * against is fetched in the browser. Resolving on the server meant every live
 * agent 404'd, because the only names the server knew were the fixture's.
 *
 * The not-found state is deliberately not `notFound()`. A 404 tells the reader the
 * URL is wrong, which is the wrong diagnosis when the real cause is that the
 * backend is unreachable and the fixture roster is standing in. So it names the
 * agent it looked for, says which roster it searched, and offers the way back.
 */
export default function AgentDetail({ name }) {
  const t = useT();
  const { agents, provenance, loading } = useData();
  const agent = agents.find((a) => a.name === name);

  if (!agent) {
    return (
      <>
        <Provenance slices={['agents']} />
        <div className="empty">
          <div className="big">{t('ad.notFound', { name })}</div>
          <p className="small">
            {loading
              ? t('ad.stillLoading')
              : t('ad.notInRoster', {
                n: agents.length,
                from: t(provenance.agents === 'live' ? 'ad.fromLive' : 'ad.fromFixture'),
              })}
          </p>
          <Link className="btn" href="/resources">{t('ad.back')}</Link>
        </div>
      </>
    );
  }

  return (
    <>
      <Provenance slices={['agents', 'presets', 'ceilings', 'engagements']} />
      <AgentHeader agent={agent} />
      <AgentTabs agent={agent} />
      <AgentActions agent={agent} />
    </>
  );
}
