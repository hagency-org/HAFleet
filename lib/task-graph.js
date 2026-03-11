const GRAPH_STATUSES = new Set(['active', 'complete', 'failed', 'cancelled']);
const NODE_STATUSES = new Set(['pending', 'dispatched', 'active', 'complete', 'failed', 'skipped', 'cancelled']);
const TERMINAL_NODE_STATUSES = new Set(['complete', 'failed', 'skipped', 'cancelled']);

export { GRAPH_STATUSES, NODE_STATUSES, TERMINAL_NODE_STATUSES };

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createGraphError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeText(value, maxLength = 255) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function normalizeStringArray(value, maxLength = 255) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const normalized = normalizeText(item, maxLength);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizeGraphStatus(value, fallback = 'active') {
  const normalized = normalizeText(value, 32) || fallback;
  if (!GRAPH_STATUSES.has(normalized)) {
    throw createGraphError('invalid_graph_status', `invalid graph status: ${value}`);
  }
  return normalized;
}

function normalizeNodeStatus(value, fallback = 'pending') {
  const normalized = normalizeText(value, 32) || fallback;
  if (!NODE_STATUSES.has(normalized)) {
    throw createGraphError('invalid_node_status', `invalid node status: ${value}`);
  }
  return normalized;
}

function normalizeTimestamp(value, fallback = null) {
  const normalized = normalizeText(value, 128);
  if (!normalized) return fallback;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function normalizeCondition(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw createGraphError('invalid_condition', 'condition must be an object');
  }
  const out = {};
  const dep = normalizeText(value.dep, 255);
  const path = normalizeText(value.path ?? value.field, 512);
  const op = normalizeText(value.op, 16);
  if (dep) out.dep = dep;
  if (path) out.path = path;
  if (op) out.op = op;
  if (Object.prototype.hasOwnProperty.call(value, 'eq')) out.eq = value.eq;
  if (Object.prototype.hasOwnProperty.call(value, 'neq')) out.neq = value.neq;
  if (Object.prototype.hasOwnProperty.call(value, 'in')) out.in = Array.isArray(value.in) ? [...value.in] : value.in;
  if (Object.prototype.hasOwnProperty.call(value, 'value')) out.value = value.value;
  return Object.keys(out).length > 0 ? out : null;
}

function normalizeNode(raw, nodeId) {
  const id = normalizeText(raw?.id, 255) || normalizeText(nodeId, 255);
  if (!id) throw createGraphError('invalid_node_id', 'node id required');
  const assignee = normalizeText(raw?.assignee, 255);
  if (!assignee) throw createGraphError('invalid_node_assignee', `node '${id}' assignee required`);
  const description = normalizeText(raw?.description, 4000);
  if (!description) throw createGraphError('invalid_node_description', `node '${id}' description required`);

  return {
    id,
    assignee,
    description,
    depends_on: normalizeStringArray(raw?.depends_on, 255),
    status: normalizeNodeStatus(raw?.status, 'pending'),
    result: Object.prototype.hasOwnProperty.call(raw || {}, 'result') ? clone(raw.result) : null,
    error: normalizeText(raw?.error, 4000),
    condition: normalizeCondition(raw?.condition),
    message_id: normalizeText(raw?.message_id, 255),
    dispatchedAt: normalizeTimestamp(raw?.dispatchedAt ?? raw?.dispatched_at, null),
    completedAt: normalizeTimestamp(raw?.completedAt ?? raw?.completed_at, null),
    startedAt: normalizeTimestamp(raw?.startedAt ?? raw?.started_at, null),
  };
}

function normalizeNodes(rawNodes) {
  if (!rawNodes || typeof rawNodes !== 'object' || Array.isArray(rawNodes)) {
    throw createGraphError('invalid_nodes', 'nodes must be an object');
  }
  const out = {};
  for (const [nodeId, rawNode] of Object.entries(rawNodes)) {
    const node = normalizeNode(rawNode, nodeId);
    out[node.id] = node;
  }
  if (Object.keys(out).length === 0) {
    throw createGraphError('invalid_nodes', 'graph must contain at least one node');
  }
  for (const node of Object.values(out)) {
    for (const depId of node.depends_on) {
      if (!out[depId]) {
        throw createGraphError('invalid_dependency', `node '${node.id}' depends on missing node '${depId}'`);
      }
      if (depId === node.id) {
        throw createGraphError('invalid_dependency', `node '${node.id}' cannot depend on itself`);
      }
    }
    if (node.condition?.dep && !out[node.condition.dep]) {
      throw createGraphError('invalid_condition', `node '${node.id}' condition references missing dep '${node.condition.dep}'`);
    }
  }
  return out;
}

function defaultGraphId() {
  return `graph_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeGraph(raw, options = {}) {
  const idFactory = typeof options.idFactory === 'function' ? options.idFactory : defaultGraphId;
  const id = normalizeText(raw?.id, 255) || idFactory();
  const owner = normalizeText(raw?.owner, 255);
  if (!owner) throw createGraphError('invalid_graph_owner', 'graph owner required');
  const label = normalizeText(raw?.label, 4000);
  if (!label) throw createGraphError('invalid_graph_label', 'graph label required');
  const createdAt = normalizeTimestamp(raw?.createdAt ?? raw?.created_at, new Date().toISOString());
  const updatedAt = normalizeTimestamp(raw?.updatedAt ?? raw?.updated_at, createdAt);
  const completedAt = normalizeTimestamp(raw?.completedAt ?? raw?.completed_at, null);

  return {
    id,
    owner,
    label,
    status: normalizeGraphStatus(raw?.status, 'active'),
    nodes: normalizeNodes(raw?.nodes),
    createdAt,
    updatedAt,
    completedAt,
  };
}

export function createTaskGraphStore(options = {}) {
  const save = typeof options.save === 'function' ? options.save : null;
  const idFactory = typeof options.idFactory === 'function' ? options.idFactory : defaultGraphId;
  const dispatchMessage = typeof options.dispatchMessage === 'function' ? options.dispatchMessage : null;
  const emitEvent = typeof options.emitEvent === 'function' ? options.emitEvent : null;
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
  const graphs = {};
  const initialGraphs = options.initialGraphs && typeof options.initialGraphs === 'object' ? options.initialGraphs : {};
  for (const [graphId, rawGraph] of Object.entries(initialGraphs)) {
    const graph = normalizeGraph({ ...rawGraph, id: rawGraph?.id || graphId }, { idFactory });
    graphs[graph.id] = graph;
  }

  const persist = () => {
    if (save) save(clone(graphs));
  };
  const notify = (eventName, payload) => {
    if (emitEvent) emitEvent(eventName, clone(payload));
  };
  const isTerminalNodeStatus = (status) => TERMINAL_NODE_STATUSES.has(status);
  const getNestedValue = (value, fieldPath) => {
    const normalizedPath = normalizeText(fieldPath, 512);
    if (!normalizedPath) return undefined;
    const parts = normalizedPath.split('.');
    let current = value;
    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== 'object') return undefined;
      current = current[part];
    }
    return current;
  };
  const buildDependencyResults = (graph, node) => node.depends_on
    .filter((depId) => graph.nodes[depId]?.status === 'complete')
    .map((depId) => ({
      nodeId: depId,
      assignee: graph.nodes[depId].assignee,
      result: clone(graph.nodes[depId].result),
    }));
  const evaluateCondition = (graph, node) => {
    if (!node.condition) return true;
    const depId = normalizeText(node.condition.dep, 255) || node.depends_on[0] || null;
    if (!depId) return false;
    const dep = graph.nodes[depId];
    if (!dep) return null;
    if (dep.status === 'pending' || dep.status === 'dispatched' || dep.status === 'active') return null;
    if (dep.status !== 'complete') return false;
    const path = node.condition.path || node.condition.field || null;
    const value = path ? getNestedValue(dep.result, path) : dep.result;
    if (node.condition.eq !== undefined) return value === node.condition.eq;
    if (node.condition.neq !== undefined) return value !== node.condition.neq;
    if (node.condition.in !== undefined) return Array.isArray(node.condition.in) && node.condition.in.includes(value);
    if (node.condition.op === 'eq') return value === node.condition.value;
    if (node.condition.op === 'neq') return value !== node.condition.value;
    if (node.condition.op === 'in') return Array.isArray(node.condition.value) && node.condition.value.includes(value);
    return Boolean(value);
  };
  const markNodeTerminal = (graph, node, status, extras = {}) => {
    const terminalAt = now();
    node.status = normalizeNodeStatus(status, status);
    node.completedAt = terminalAt;
    if (Object.prototype.hasOwnProperty.call(extras, 'error')) {
      node.error = normalizeText(extras.error, 4000);
    }
    if (Object.prototype.hasOwnProperty.call(extras, 'result')) {
      node.result = clone(extras.result);
    }
    notify('task_graph_node_completed', {
      graphId: graph.id,
      nodeId: node.id,
      status: node.status,
      error: node.error || null,
      completedAt: node.completedAt,
    });
    return terminalAt;
  };
  const dispatchNode = (graph, node) => {
    if (!dispatchMessage) throw createGraphError('dispatch_unavailable', 'task graph dispatch unavailable');
    const dispatchedAt = now();
    const dependencyResults = buildDependencyResults(graph, node);
    const message = dispatchMessage({
      from: graph.owner,
      to: node.assignee,
      type: 'request',
      priority: 'high',
      summary: `Task assigned: ${node.description}`,
      full: [
        '## Task Graph Assignment',
        '',
        `Graph: ${graph.label} (${graph.id})`,
        `Node: ${node.id}`,
        `Description: ${node.description}`,
        '',
        dependencyResults.length > 0
          ? `Dependency results:\n${dependencyResults.map((dep) => {
            const serialized = JSON.stringify(dep.result);
            return `- ${dep.nodeId} (${dep.assignee}): ${(serialized || 'null').slice(0, 500)}`;
          }).join('\n')}`
          : 'No dependencies.',
      ].join('\n'),
      schema: {
        kind: 'task_graph_dispatch',
        version: 1,
        payload: {
          graphId: graph.id,
          nodeId: node.id,
          description: node.description,
          dependencyResults,
        },
      },
    });
    node.status = 'dispatched';
    node.dispatchedAt = dispatchedAt;
    node.message_id = normalizeText(message?.id, 255);
    notify('task_graph_node_dispatched', {
      graphId: graph.id,
      nodeId: node.id,
      assignee: node.assignee,
      messageId: node.message_id,
      dispatchedAt,
    });
    return message;
  };
  const finalizeGraphIfTerminal = (graph) => {
    const nodes = Object.values(graph.nodes);
    if (nodes.length === 0 || !nodes.every((node) => isTerminalNodeStatus(node.status))) return false;
    if (graph.status !== 'active') return false;
    const completedAt = now();
    graph.status = nodes.some((node) => node.status === 'failed') ? 'failed' : 'complete';
    graph.completedAt = completedAt;
    graph.updatedAt = completedAt;
    notify('task_graph_completed', {
      graphId: graph.id,
      status: graph.status,
      completedAt,
    });
    return true;
  };

  return {
    dump() {
      return clone(graphs);
    },

    createGraph(input) {
      const graph = normalizeGraph(input, { idFactory });
      if (graphs[graph.id]) {
        throw createGraphError('graph_exists', `graph already exists: ${graph.id}`);
      }
      graphs[graph.id] = graph;
      persist();
      return clone(graph);
    },

    getGraph(graphId) {
      const id = normalizeText(graphId, 255);
      return id && graphs[id] ? clone(graphs[id]) : null;
    },

    listGraphs(filter = {}) {
      const status = filter?.status ? normalizeGraphStatus(filter.status) : null;
      return Object.values(graphs)
        .filter((graph) => !status || graph.status === status)
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
        .map((graph) => clone(graph));
    },

    deleteGraph(graphId) {
      const id = normalizeText(graphId, 255);
      if (!id || !graphs[id]) return null;
      const graph = graphs[id];
      if (graph.status !== 'cancelled') {
        graph.status = 'cancelled';
        graph.completedAt = new Date().toISOString();
        graph.updatedAt = graph.completedAt;
        for (const node of Object.values(graph.nodes)) {
          if (!TERMINAL_NODE_STATUSES.has(node.status)) {
            node.status = 'cancelled';
            node.completedAt = graph.completedAt;
          }
        }
        persist();
      }
      return clone(graph);
    },

    advanceGraph(graphId) {
      const id = normalizeText(graphId, 255);
      if (!id || !graphs[id]) return null;
      const graph = graphs[id];
      if (graph.status !== 'active') return clone(graph);

      let changed = false;
      let progress = false;
      do {
        progress = false;
        for (const node of Object.values(graph.nodes)) {
          if (node.status !== 'pending') continue;

          const failedDeps = node.depends_on.filter((depId) => {
            const depStatus = graph.nodes[depId]?.status;
            return depStatus === 'failed' || depStatus === 'cancelled';
          });
          if (failedDeps.length > 0) {
            markNodeTerminal(graph, node, 'failed', { error: `dependency failed: ${failedDeps.join(', ')}` });
            changed = true;
            progress = true;
            continue;
          }

          const allDepsResolved = node.depends_on.every((depId) => {
            const depStatus = graph.nodes[depId]?.status;
            return depStatus === 'complete' || depStatus === 'skipped';
          });
          if (!allDepsResolved) continue;

          const conditionResult = evaluateCondition(graph, node);
          if (conditionResult === null) continue;
          if (conditionResult === false) {
            markNodeTerminal(graph, node, 'skipped');
            changed = true;
            progress = true;
            continue;
          }

          try {
            dispatchNode(graph, node);
          } catch (error) {
            markNodeTerminal(graph, node, 'failed', {
              error: `dispatch failed: ${error?.message || error}`,
            });
          }
          changed = true;
          progress = true;
        }
      } while (progress);

      if (finalizeGraphIfTerminal(graph)) changed = true;
      if (changed) {
        graph.updatedAt = now();
        persist();
      }
      return clone(graph);
    },
  };
}
