import AgentDetail from '@/components/AgentDetail';
import { agents } from '@/lib/mock-data';

/*
 * The fixture's names, pre-generated so the static export has a page per agent.
 *
 * Live agent names are NOT here and cannot be: this runs at build time and the
 * backend may not exist then. `dynamicParams` defaults to true, so `next dev` and
 * `next start` render an unlisted name on demand — which is the whole point,
 * because a live roster's names are chosen by whoever registered the agents.
 *
 * This file stays a server component only because `generateStaticParams` cannot
 * live in a 'use client' module. Resolution against live data happens in
 * AgentDetail, which reads the data context.
 */
export function generateStaticParams() {
  return agents.map((a) => ({ name: a.name }));
}

export default async function AgentPage({ params }) {
  const { name } = await params;
  return <AgentDetail name={name} />;
}
