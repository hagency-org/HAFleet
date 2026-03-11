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
  const graphs = {};
  const initialGraphs = options.initialGraphs && typeof options.initialGraphs === 'object' ? options.initialGraphs : {};
  for (const [graphId, rawGraph] of Object.entries(initialGraphs)) {
    const graph = normalizeGraph({ ...rawGraph, id: rawGraph?.id || graphId }, { idFactory });
    graphs[graph.id] = graph;
  }

  const persist = () => {
    if (save) save(clone(graphs));
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
  };
}
