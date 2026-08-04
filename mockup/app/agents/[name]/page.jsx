import { notFound } from 'next/navigation';
import AgentHeader from '@/components/AgentHeader';
import AgentTabs from '@/components/AgentTabs';
import AgentActions from '@/components/AgentActions';
import { agents } from '@/lib/mock-data';

export function generateStaticParams() {
  return agents.map((a) => ({ name: a.name }));
}

export default async function AgentPage({ params }) {
  const { name } = await params;
  const agent = agents.find((a) => a.name === name);
  if (!agent) notFound();

  return (
    <>
      <AgentHeader agent={agent} />
      <AgentTabs agent={agent} />
      <AgentActions agent={agent} />
    </>
  );
}
