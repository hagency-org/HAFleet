// Task system foundation — in-memory store with JSON persistence.

const STATUSES = new Set(['created', 'accepted', 'in_progress', 'blocked', 'done']);
const PRIORITIES = new Set(['p0', 'p1', 'p2', 'p3']);
const GRANULARITIES = new Set(['epic', 'task', 'subtask']);

// Valid status transitions: from → Set<to>
const TRANSITIONS = new Map([
  ['created',     new Set(['accepted'])],
  ['accepted',    new Set(['in_progress'])],
  ['in_progress', new Set(['blocked', 'done'])],
  ['blocked',     new Set(['in_progress'])],
]);

export { STATUSES, PRIORITIES, GRANULARITIES, TRANSITIONS };

function generateId() {
  const ts = Math.floor(Date.now() / 1000);
  const rand = Math.random().toString(36).slice(2, 8);
  return `task_${ts}_${rand}`;
}

function normalizeText(value, maxLen = 255) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t ? t.slice(0, maxLen) : null;
}

function normalizeLabels(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const label = normalizeText(item, 64);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

function createTaskError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function createTaskStore({ initialData, save }) {
  const tasks = new Map();

  // Load initial data
  if (Array.isArray(initialData)) {
    for (const t of initialData) {
      if (t && t.id) tasks.set(t.id, t);
    }
  }

  function persist() {
    save([...tasks.values()]);
  }

  function createTask(body) {
    const title = normalizeText(body.title, 255);
    if (!title) throw createTaskError('invalid_title', 'title is required');

    const priority = normalizeText(body.priority, 8) || 'p2';
    if (!PRIORITIES.has(priority)) throw createTaskError('invalid_priority', `invalid priority: ${body.priority}`);

    const granularity = normalizeText(body.granularity, 16) || 'task';
    if (!GRANULARITIES.has(granularity)) throw createTaskError('invalid_granularity', `invalid granularity: ${body.granularity}`);

    const assignee = normalizeText(body.assignee, 128) || null;
    const created_by = normalizeText(body.created_by, 128) || null;
    const parent_id = normalizeText(body.parent_id, 64) || null;
    if (parent_id && !tasks.has(parent_id)) {
      throw createTaskError('invalid_parent', `parent task not found: ${parent_id}`);
    }

    const now = new Date().toISOString();
    let id = generateId();
    for (let i = 0; i < 10 && tasks.has(id); i++) id = generateId();
    if (tasks.has(id)) throw createTaskError('id_collision', 'failed to generate unique task id');
    const task = {
      id,
      title,
      description: normalizeText(body.description, 4096) || '',
      status: 'created',
      priority,
      granularity,
      assignee,
      created_by,
      created_at: now,
      updated_at: now,
      started_at: null,
      completed_at: null,
      heartbeat_at: null,
      waiting_reason: null,
      waiting_until: null,
      parent_id,
      labels: normalizeLabels(body.labels),
      health: null,
      comments: [],
    };
    tasks.set(task.id, task);
    persist();
    return task;
  }

  function getTask(id) {
    return tasks.get(id) || null;
  }

  function listTasks(filters = {}) {
    let result = [...tasks.values()];
    if (filters.assignee) {
      result = result.filter(t => t.assignee === filters.assignee);
    }
    if (filters.status) {
      const statuses = filters.status.split(',').map(s => s.trim()).filter(Boolean);
      if (statuses.length) result = result.filter(t => statuses.includes(t.status));
    }
    if (filters.priority) {
      result = result.filter(t => t.priority === filters.priority);
    }
    if (filters.label) {
      result = result.filter(t => t.labels && t.labels.includes(filters.label));
    }
    return result;
  }

  // Operator update: can modify all fields (title, description, priority, etc.)
  function updateTask(id, patch) {
    const task = tasks.get(id);
    if (!task) throw createTaskError('not_found', `task not found: ${id}`);

    const now = new Date().toISOString();
    let changed = false;

    if (patch.title !== undefined) {
      const v = normalizeText(patch.title, 255);
      if (v) { task.title = v; changed = true; }
    }
    if (patch.description !== undefined) {
      task.description = normalizeText(patch.description, 4096) || '';
      changed = true;
    }
    if (patch.priority !== undefined) {
      const v = normalizeText(patch.priority, 8);
      if (v && PRIORITIES.has(v)) { task.priority = v; changed = true; }
      else throw createTaskError('invalid_priority', `invalid priority: ${patch.priority}`);
    }
    if (patch.granularity !== undefined) {
      const v = normalizeText(patch.granularity, 16);
      if (v && GRANULARITIES.has(v)) { task.granularity = v; changed = true; }
      else throw createTaskError('invalid_granularity', `invalid granularity: ${patch.granularity}`);
    }
    if (patch.assignee !== undefined) {
      task.assignee = normalizeText(patch.assignee, 128) || null;
      changed = true;
    }
    if (patch.labels !== undefined) {
      task.labels = normalizeLabels(patch.labels);
      changed = true;
    }
    if (patch.parent_id !== undefined) {
      const pid = normalizeText(patch.parent_id, 64) || null;
      if (pid && !tasks.has(pid)) throw createTaskError('invalid_parent', `parent task not found: ${pid}`);
      task.parent_id = pid;
      changed = true;
    }

    if (changed) {
      task.updated_at = now;
      persist();
    }
    return task;
  }

  // Agent execution update: only heartbeat and waiting metadata
  function updateTaskExecution(id, patch) {
    const task = tasks.get(id);
    if (!task) throw createTaskError('not_found', `task not found: ${id}`);

    const now = new Date().toISOString();
    let changed = false;

    if (patch.heartbeat_at !== undefined) {
      task.heartbeat_at = now;
      changed = true;
    }
    if (patch.waiting_reason !== undefined) {
      task.waiting_reason = normalizeText(patch.waiting_reason, 1024) || null;
      changed = true;
    }
    if (patch.waiting_until !== undefined) {
      task.waiting_until = normalizeText(patch.waiting_until, 64) || null;
      changed = true;
    }

    if (changed) {
      task.updated_at = now;
      persist();
    }
    return task;
  }

  function transitionTask(id, newStatus, extra = {}) {
    const task = tasks.get(id);
    if (!task) throw createTaskError('not_found', `task not found: ${id}`);

    if (!STATUSES.has(newStatus)) {
      throw createTaskError('invalid_status', `invalid status: ${newStatus}`);
    }

    const allowed = TRANSITIONS.get(task.status);
    if (!allowed || !allowed.has(newStatus)) {
      throw createTaskError('invalid_transition', `cannot transition from '${task.status}' to '${newStatus}'`);
    }

    // Validate blocked metadata BEFORE mutating task state
    if (newStatus === 'blocked') {
      const reason = normalizeText(extra.waiting_reason, 1024);
      const until = normalizeText(extra.waiting_until, 64);
      if (!reason) throw createTaskError('missing_waiting_reason', 'waiting_reason is required when transitioning to blocked');
      if (!until) throw createTaskError('missing_waiting_until', 'waiting_until is required when transitioning to blocked');
    }

    const now = new Date().toISOString();
    task.status = newStatus;
    task.updated_at = now;

    if (newStatus === 'accepted' || newStatus === 'in_progress') {
      if (!task.started_at) task.started_at = now;
    }
    if (newStatus === 'done') {
      task.completed_at = now;
      task.waiting_reason = null;
      task.waiting_until = null;
    }
    if (newStatus === 'blocked') {
      task.waiting_reason = normalizeText(extra.waiting_reason, 1024);
      task.waiting_until = normalizeText(extra.waiting_until, 64);
    }
    if (newStatus === 'in_progress') {
      task.waiting_reason = null;
      task.waiting_until = null;
    }

    persist();
    return task;
  }

  function addComment(id, comment) {
    const task = tasks.get(id);
    if (!task) throw createTaskError('not_found', `task not found: ${id}`);
    const author = normalizeText(comment.author, 128);
    const text = normalizeText(comment.text, 4096);
    if (!text) throw createTaskError('invalid_comment', 'comment text is required');
    if (!Array.isArray(task.comments)) task.comments = [];
    const entry = { author: author || 'anonymous', text, ts: new Date().toISOString() };
    task.comments.push(entry);
    task.updated_at = new Date().toISOString();
    persist();
    return task;
  }

  function deleteTask(id) {
    const task = tasks.get(id);
    if (!task) return null;
    tasks.delete(id);
    persist();
    return task;
  }

  function dump() {
    return [...tasks.values()];
  }

  return { createTask, getTask, listTasks, updateTask, updateTaskExecution, transitionTask, addComment, deleteTask, dump };
}
