import { notFound } from 'next/navigation';
import PageHead from '@/components/PageHead';
import AgentTabs from '@/components/AgentTabs';
import AgentActions from '@/components/AgentActions';
import { agents, runtimeStatusText } from '@/lib/mock-data';

export function generateStaticParams() {
  return agents.map((a) => ({ name: a.name }));
}

export default async function AgentPage({ params }) {
  const { name } = await params;
  const agent = agents.find((a) => a.name === name);
  if (!agent) notFound();

  return (
    <>
      <PageHead title={agent.name}>
        {/* Refresh cadence is named for what it polls, and only offered when there
            is a pane to poll. 10/sec was pane polling; an ACP agent reads a log. */}
        <button className="btn" title={agent.tmux
          ? 'How often this browser re-reads the pane. Does not affect the agent.'
          : 'How often this browser re-reads the agent log. Does not affect the agent.'}>
          {agent.tmux ? 'Refresh: 10/sec' : 'Refresh: 3s'}
        </button>
        {agent.tmux && (
          <button className="btn" title="Stop refreshing this view. The agent keeps running.">
            Pause display
          </button>
        )}
      </PageHead>

      <div className="btn-row" style={{ margin: '-8px 0 4px' }}>
        <span className={`badge${agent.activeNow ? ' ok' : ''}`}>{runtimeStatusText(agent)}</span>
        <span className="badge">
          {agent.transport === 'acp' ? 'ACP · no pane' : `TMUX · ${agent.tmux}`}
        </span>
        <span className="badge">{agent.framework}</span>
        {agent.mcp && <span className="badge ok">MCP connected</span>}
      </div>

      <AgentTabs agent={agent} />
      <AgentActions agent={agent} />
    </>
  );
}
