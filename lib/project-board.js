const RESERVED_GROUPS = new Set(['info']);
const TASK_STATUSES = ['created', 'accepted', 'in_progress', 'blocked', 'done'];
const AGENT_TASK_STATUSES = new Set(['active', 'waiting', 'blocked', 'done']);
const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;
const DEFAULT_ACTIVITY_LIMIT = 20;

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}

function text(value, max = 512) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, max) : null;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestampValue(value) {
  const parsed = timestampMs(value);
  if (parsed === null) return null;
  return new Date(parsed).toISOString();
}

function booleanOrNull(value) {
  return value === true ? true : (value === false ? false : null);
}

function safeUrl(value) {
  const candidate = text(value, 2048);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function uniqueNames(value) {
  const names = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    const name = text(item, 128);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

function normalizeActivityLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_ACTIVITY_LIMIT;
  return Math.max(1, Math.min(parsed, 100));
}

function normalizeStaleAfterMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1_000) return DEFAULT_STALE_AFTER_MS;
  return Math.min(parsed, 7 * 24 * 60 * 60 * 1000);
}

function safeRuntime(agent) {
  const primary = agent?.runtimeProfile?.primary;
  const framework = text(primary?.framework, 32) || text(agent?.type, 32);
  return {
    framework,
    provider: text(primary?.provider, 64),
    model: text(primary?.model, 256),
    reasoning: text(primary?.reasoning, 64),
  };
}

function safeAgentTask(value, now, staleAfterMs) {
  if (!value || typeof value !== 'object') return null;
  const status = text(value.status, 32)?.toLowerCase();
  if (!status || !AGENT_TASK_STATUSES.has(status)) return null;
  const heartbeatAt = timestampValue(value.heartbeat_at);
  const heartbeatMs = timestampMs(heartbeatAt);
  const ageMs = heartbeatMs === null ? null : Math.max(0, now - heartbeatMs);
  const freshnessRelevant = status === 'active' || status === 'waiting' || status === 'blocked';
  return {
    id: text(value.id, 256),
    owner: text(value.owner, 128),
    status,
    updatedAt: timestampValue(value.updated_at),
    heartbeatAt,
    heartbeatAgeMs: ageMs,
    stale: freshnessRelevant && (ageMs === null || ageMs > staleAfterMs),
    waitingReason: status === 'waiting' ? text(value.waiting_reason, 600) : null,
    waitingUntil: status === 'waiting' ? timestampValue(value.waiting_until) : null,
  };
}

function safeProjectAgent(agent, name, now, staleAfterMs) {
  if (!agent || typeof agent !== 'object') {
    return {
      name,
      registered: false,
      role: null,
      capability: null,
      runtime: { framework: null, provider: null, model: null, reasoning: null },
      state: 'unregistered',
      online: null,
      healthy: null,
      blocked: false,
      blockedReason: null,
      activeNow: null,
      lastSeen: null,
      task: null,
      worktreeCount: 0,
    };
  }

  return {
    name,
    registered: true,
    role: text(agent.role, 64),
    capability: text(agent.capability, 32),
    runtime: safeRuntime(agent),
    state: text(agent.state, 32) || (agent.online === true ? 'online' : 'offline'),
    online: booleanOrNull(agent.online),
    healthy: booleanOrNull(agent.healthy),
    blocked: agent.blocked === true,
    blockedReason: agent.blocked === true ? text(agent.blockedReason, 600) : null,
    activeNow: booleanOrNull(agent.activeNow),
    lastSeen: timestampValue(agent.lastSeen),
    task: safeAgentTask(agent.task, now, staleAfterMs),
    worktreeCount: 0,
  };
}

function safeSync(value) {
  if (!value || typeof value !== 'object') return { status: 'unknown', error: null, observedAt: null };
  return {
    status: text(value.status, 32) || 'unknown',
    error: text(value.error, 255),
    observedAt: timestampValue(value.observedAt),
  };
}

function safeRepository(value) {
  if (!value || typeof value !== 'object') return null;
  const id = text(value.id, 255);
  const fullName = text(value.fullName, 255);
  if (!id || !fullName) return null;
  return {
    id,
    provider: text(value.provider, 32) || 'unknown',
    host: text(value.host, 255),
    owner: text(value.owner, 255),
    name: text(value.name, 128) || fullName,
    fullName,
    webUrl: safeUrl(value.webUrl),
    sync: safeSync(value.sync),
  };
}

function safeSpec(value, context) {
  if (!value || typeof value !== 'object') return null;
  const id = text(value.id, 128);
  const name = text(value.name, 255);
  const file = text(value.file, 512);
  if (!id || !name || !file) return null;
  return {
    id: `${context.worktreeId}:${id}`,
    sourceId: id,
    worktreeId: context.worktreeId,
    agent: context.agent,
    branch: context.branch,
    repositoryId: context.repositoryId,
    kind: text(value.kind, 32) || 'task',
    name,
    file,
    satisfies: uniqueNames(value.satisfies).slice(0, 40),
    tags: uniqueNames(value.tags).slice(0, 40),
    scenarios: Math.max(0, finiteNumber(value.scenarios) || 0),
    tests: Math.max(0, finiteNumber(value.tests) || 0),
    modifiedAt: timestampValue(value.modifiedAt),
  };
}

function safePublishTarget(value) {
  if (!value || typeof value !== 'object') return null;
  const repositoryId = text(value.repositoryId, 255);
  const repository = text(value.repository, 255);
  if (!repositoryId || !repository) return null;
  return {
    provider: text(value.provider, 32) || 'git',
    repositoryId,
    repository,
    url: safeUrl(value.url),
  };
}

function safeIssue(value, context = {}) {
  if (!value || typeof value !== 'object') return null;
  const id = text(value.id, 255);
  const title = text(value.title, 255);
  if (!id || !title) return null;
  const source = text(value.source, 32) || 'remote';
  return {
    id: context.worktreeId && source === 'local' ? `${context.worktreeId}:${id}` : id,
    sourceId: id,
    source,
    provider: text(value.provider, 32),
    repositoryId: text(value.repositoryId, 255) || context.repositoryId || null,
    repository: text(value.repository, 255),
    worktreeId: context.worktreeId || null,
    agent: context.agent || null,
    branch: context.branch || null,
    number: finiteNumber(value.number),
    title,
    state: text(value.state, 32) || (source === 'local' ? 'local' : 'unknown'),
    file: source === 'local' ? text(value.file, 512) : null,
    url: safeUrl(value.url),
    updatedAt: timestampValue(value.updatedAt),
    modifiedAt: timestampValue(value.modifiedAt),
    labels: uniqueNames(value.labels).slice(0, 20),
    assignees: uniqueNames(value.assignees).slice(0, 20),
    publishTarget: safePublishTarget(value.publishTarget),
  };
}

function safeChangeRequest(value) {
  if (!value || typeof value !== 'object') return null;
  const id = text(value.id, 255);
  const title = text(value.title, 255);
  if (!id || !title) return null;
  const checks = value.checks && typeof value.checks === 'object' ? value.checks : {};
  return {
    id,
    provider: text(value.provider, 32) || 'git',
    kind: text(value.kind, 32) || 'change_request',
    repositoryId: text(value.repositoryId, 255),
    repository: text(value.repository, 255),
    number: finiteNumber(value.number),
    title,
    state: text(value.state, 32) || 'unknown',
    url: safeUrl(value.url),
    headBranch: text(value.headBranch, 255),
    baseBranch: text(value.baseBranch, 255),
    updatedAt: timestampValue(value.updatedAt),
    mergeState: text(value.mergeState, 64),
    checks: {
      passed: Math.max(0, finiteNumber(checks.passed) || 0),
      failed: Math.max(0, finiteNumber(checks.failed) || 0),
      pending: Math.max(0, finiteNumber(checks.pending) || 0),
    },
    additions: finiteNumber(value.additions),
    deletions: finiteNumber(value.deletions),
    changedFiles: finiteNumber(value.changedFiles),
  };
}

function safeWorktree(value) {
  if (!value || typeof value !== 'object') return null;
  const id = text(value.id, 255);
  const agent = text(value.agent, 128);
  const project = text(value.project, 128);
  if (!id || !agent || !project) return null;
  const repository = safeRepository(value.repository);
  const git = value.git && typeof value.git === 'object' ? value.git : {};
  const context = {
    worktreeId: id,
    agent,
    branch: text(git.branch, 255),
    repositoryId: repository?.id || null,
  };
  return {
    id,
    agent,
    project,
    mode: text(value.mode, 64) || 'unknown',
    locationLabel: text(value.locationLabel, 255) || project,
    available: value.available === true,
    repository,
    git: {
      available: git.available === true,
      error: text(git.error, 255),
      branch: context.branch,
      head: text(git.head, 64),
      dirty: booleanOrNull(git.dirty),
      changeCount: finiteNumber(git.changeCount),
      isWorktree: booleanOrNull(git.isWorktree),
    },
    specs: asArray(value.specs).map(spec => safeSpec(spec, context)).filter(Boolean),
    localIssues: asArray(value.localIssues).map(issue => safeIssue(issue, context)).filter(Boolean),
    remoteIssues: asArray(value.remoteIssues).map(issue => safeIssue(issue)).filter(Boolean),
    changeRequests: asArray(value.changeRequests).map(safeChangeRequest).filter(Boolean),
  };
}

function dedupeById(values) {
  const output = [];
  const seen = new Set();
  for (const value of values) {
    if (!value?.id || seen.has(value.id)) continue;
    seen.add(value.id);
    output.push(value);
  }
  return output;
}

function safeBinding(value) {
  if (!value || typeof value !== 'object') return null;
  const group = text(value.group, 128);
  const project = text(value.project, 128);
  if (!group || !project) return null;
  return {
    id: text(value.bindingId, 255) || `${group}:${project}`,
    group,
    project,
    workflowId: text(value.workflowId, 128),
    workflowVersion: text(value.workflowVersion, 64),
  };
}

function safeTask(task) {
  if (!task || typeof task !== 'object') return null;
  const id = text(task.id, 128);
  const title = text(task.title, 255);
  const status = text(task.status, 32)?.toLowerCase();
  if (!id || !title || !TASK_STATUSES.includes(status)) return null;
  return {
    id,
    title,
    status,
    priority: text(task.priority, 8) || 'p2',
    granularity: text(task.granularity, 16) || 'task',
    assignee: text(task.assignee, 128),
    createdBy: text(task.created_by, 128),
    createdAt: timestampValue(task.created_at),
    updatedAt: timestampValue(task.updated_at),
    startedAt: timestampValue(task.started_at),
    completedAt: timestampValue(task.completed_at),
    heartbeatAt: timestampValue(task.heartbeat_at),
    waitingReason: status === 'blocked' ? text(task.waiting_reason, 600) : null,
    waitingUntil: status === 'blocked' ? timestampValue(task.waiting_until) : null,
    labels: uniqueNames(task.labels).slice(0, 20),
    health: task.health && typeof task.health === 'object'
      ? {
          state: text(task.health.state, 32),
          confidence: finiteNumber(task.health.confidence),
        }
      : null,
  };
}

function safeGraphNode(id, node) {
  if (!node || typeof node !== 'object') return null;
  return {
    id: text(id, 128),
    assignee: text(node.assignee, 128),
    description: text(node.description, 600),
    status: text(node.status, 32) || 'pending',
    dependsOn: uniqueNames(node.depends_on),
    dispatchedAt: timestampValue(node.dispatchedAt),
    completedAt: timestampValue(node.completedAt),
  };
}

function safeGraph(graph) {
  if (!graph || typeof graph !== 'object') return null;
  const id = text(graph.id, 255);
  const label = text(graph.label, 255);
  if (!id || !label) return null;
  const nodes = Object.entries(graph.nodes && typeof graph.nodes === 'object' ? graph.nodes : {})
    .map(([nodeId, node]) => safeGraphNode(nodeId, node))
    .filter(Boolean);
  return {
    id,
    label,
    owner: text(graph.owner, 128),
    status: text(graph.status, 32) || 'active',
    createdAt: timestampValue(graph.createdAt),
    updatedAt: timestampValue(graph.updatedAt),
    completedAt: timestampValue(graph.completedAt),
    nodes,
    counts: nodes.reduce((acc, node) => {
      acc[node.status] = (acc[node.status] || 0) + 1;
      return acc;
    }, {}),
  };
}

function safeActivity(message) {
  if (!message || typeof message !== 'object') return null;
  const id = text(message.id, 128);
  const summary = text(message.summary, 600);
  if (!id || !summary) return null;
  return {
    id,
    ts: timestampValue(message.ts),
    from: text(message.from, 128) || 'unknown',
    type: text(message.type, 32) || 'inform',
    priority: text(message.priority, 16) || 'normal',
    summary,
    replyTo: text(message.reply_to, 128),
  };
}

function compareNewest(left, right, field) {
  const leftMs = timestampMs(left?.[field]) || 0;
  const rightMs = timestampMs(right?.[field]) || 0;
  if (rightMs !== leftMs) return rightMs - leftMs;
  return String(right?.id || '').localeCompare(String(left?.id || ''));
}

function projectHealth(summary) {
  if (summary.blockedAgents > 0 || summary.tasks.blocked > 0 || summary.graphs.failed > 0) return 'blocked';
  if (summary.staleAgents > 0 || summary.offlineAgents > 0 || summary.dirtyWorktrees > 0) return 'attention';
  if (summary.workingAgents > 0 || summary.tasks.in_progress > 0 || summary.graphs.active > 0) return 'active';
  if (summary.waitingAgents > 0) return 'waiting';
  return 'idle';
}

export function buildProjectBoardSnapshot({
  groups = [],
  agents = [],
  bindings = [],
  tasks = [],
  taskGraphs = [],
  messages = [],
  now = Date.now(),
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  activityLimit = DEFAULT_ACTIVITY_LIMIT,
} = {}) {
  const generatedAtMs = finiteNumber(now) ?? Date.now();
  const staleWindow = normalizeStaleAfterMs(staleAfterMs);
  const recentLimit = normalizeActivityLimit(activityLimit);
  const agentByName = new Map(
    asArray(agents)
      .filter(agent => agent && typeof agent === 'object' && text(agent.name, 128))
      .map(agent => [text(agent.name, 128).toLowerCase(), agent]),
  );
  const safeTasks = asArray(tasks).map(safeTask).filter(Boolean);
  const safeGraphs = asArray(taskGraphs).map(safeGraph).filter(Boolean);
  const bindingByGroup = new Map(
    asArray(bindings)
      .map(safeBinding)
      .filter(Boolean)
      .map(binding => [binding.group.toLowerCase(), binding]),
  );

  const projects = asArray(groups)
    .filter(group => group && typeof group === 'object')
    .map(group => ({
      name: text(group.name, 128),
      createdAt: timestampValue(group.createdAt),
      members: uniqueNames(group.members),
    }))
    .filter(group => group.name && !RESERVED_GROUPS.has(group.name))
    .map(group => {
      const memberKeys = new Set(group.members.map(name => name.toLowerCase()));
      const binding = bindingByGroup.get(group.name.toLowerCase()) || null;
      const boundProjectKey = binding?.project.toLowerCase() || null;
      const worktrees = binding
        ? group.members.flatMap(name => {
            const agent = agentByName.get(name.toLowerCase());
            return asArray(agent?.projectInspections)
              .filter(item => text(item?.project, 128)?.toLowerCase() === boundProjectKey)
              .map(safeWorktree)
              .filter(Boolean);
          })
        : [];
      const repositories = dedupeById(worktrees.map(item => item.repository).filter(Boolean));
      const specs = dedupeById(worktrees.flatMap(item => item.specs))
        .sort((left, right) => compareNewest(left, right, 'modifiedAt'));
      const localIssues = dedupeById(worktrees.flatMap(item => item.localIssues))
        .sort((left, right) => compareNewest(left, right, 'modifiedAt'));
      const remoteIssues = dedupeById(worktrees.flatMap(item => item.remoteIssues))
        .sort((left, right) => compareNewest(left, right, 'updatedAt'));
      const changeRequests = dedupeById(worktrees.flatMap(item => item.changeRequests))
        .sort((left, right) => compareNewest(left, right, 'updatedAt'));
      const projectAgents = group.members.map(name =>
        safeProjectAgent(agentByName.get(name.toLowerCase()), name, generatedAtMs, staleWindow));
      for (const projectAgent of projectAgents) {
        projectAgent.worktreeCount = worktrees.filter(item =>
          item.agent.toLowerCase() === projectAgent.name.toLowerCase()).length;
      }
      const projectTasks = safeTasks
        .filter(task => task.assignee && memberKeys.has(task.assignee.toLowerCase()))
        .sort((left, right) => compareNewest(left, right, 'updatedAt'));
      const taskLanes = Object.fromEntries(TASK_STATUSES.map(status => [
        status,
        projectTasks.filter(task => task.status === status),
      ]));
      const projectGraphs = safeGraphs
        .filter(graph =>
          (graph.owner && memberKeys.has(graph.owner.toLowerCase()))
          || graph.nodes.some(node => node.assignee && memberKeys.has(node.assignee.toLowerCase())))
        .sort((left, right) => compareNewest(left, right, 'updatedAt'));
      const activity = asArray(messages)
        .filter(message => message?.group === group.name)
        .map(safeActivity)
        .filter(Boolean)
        .sort((left, right) => compareNewest(left, right, 'ts'))
        .slice(0, recentLimit);

      const graphCounts = { active: 0, complete: 0, failed: 0, cancelled: 0 };
      for (const graph of projectGraphs) {
        if (Object.prototype.hasOwnProperty.call(graphCounts, graph.status)) graphCounts[graph.status]++;
      }
      const summary = {
        members: group.members.length,
        registeredAgents: projectAgents.filter(agent => agent.registered).length,
        onlineAgents: projectAgents.filter(agent => agent.registered && agent.online === true).length,
        offlineAgents: projectAgents.filter(agent => agent.registered && agent.online === false).length,
        workingAgents: projectAgents.filter(agent =>
          agent.activeNow === true || agent.task?.status === 'active').length,
        waitingAgents: projectAgents.filter(agent => agent.task?.status === 'waiting').length,
        blockedAgents: projectAgents.filter(agent =>
          agent.blocked === true || agent.task?.status === 'blocked').length,
        staleAgents: projectAgents.filter(agent => agent.task?.stale === true).length,
        tasks: Object.fromEntries(TASK_STATUSES.map(status => [status, taskLanes[status].length])),
        graphs: graphCounts,
        recentActivity: activity.length,
        repositories: repositories.length,
        worktrees: worktrees.length,
        dirtyWorktrees: worktrees.filter(item => item.git.dirty === true).length,
        specs: specs.length,
        localIssues: localIssues.length,
        remoteIssues: remoteIssues.length,
        changeRequests: changeRequests.length,
        openChangeRequests: changeRequests.filter(item =>
          item.state === 'open' || item.state === 'draft').length,
      };

      return {
        id: group.name,
        name: group.name,
        createdAt: group.createdAt,
        binding,
        health: projectHealth(summary),
        summary,
        agents: projectAgents,
        repositories,
        worktrees: worktrees.map(item => ({
          ...item,
          specs: undefined,
          localIssues: undefined,
          remoteIssues: undefined,
          changeRequests: undefined,
        })),
        specs,
        issues: {
          local: localIssues,
          remote: remoteIssues,
        },
        changeRequests,
        taskLanes,
        graphs: projectGraphs,
        activity,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  const totals = projects.reduce((acc, project) => {
    acc.projects++;
    acc.members += project.summary.members;
    acc.registeredAgents += project.summary.registeredAgents;
    acc.onlineAgents += project.summary.onlineAgents;
    acc.workingAgents += project.summary.workingAgents;
    acc.blockedAgents += project.summary.blockedAgents;
    acc.staleAgents += project.summary.staleAgents;
    acc.repositories += project.summary.repositories;
    acc.worktrees += project.summary.worktrees;
    acc.dirtyWorktrees += project.summary.dirtyWorktrees;
    acc.specs += project.summary.specs;
    acc.localIssues += project.summary.localIssues;
    acc.remoteIssues += project.summary.remoteIssues;
    acc.changeRequests += project.summary.changeRequests;
    for (const status of TASK_STATUSES) acc.tasks[status] += project.summary.tasks[status];
    return acc;
  }, {
    projects: 0,
    members: 0,
    registeredAgents: 0,
    onlineAgents: 0,
    workingAgents: 0,
    blockedAgents: 0,
    staleAgents: 0,
    repositories: 0,
    worktrees: 0,
    dirtyWorktrees: 0,
    specs: 0,
    localIssues: 0,
    remoteIssues: 0,
    changeRequests: 0,
    tasks: Object.fromEntries(TASK_STATUSES.map(status => [status, 0])),
  });

  return {
    generatedAt: new Date(generatedAtMs).toISOString(),
    staleAfterMs: staleWindow,
    activityLimit: recentLimit,
    totals,
    projects,
  };
}

export {
  DEFAULT_ACTIVITY_LIMIT,
  DEFAULT_STALE_AFTER_MS,
  TASK_STATUSES,
};
