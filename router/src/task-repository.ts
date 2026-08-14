import { createHash, randomUUID } from 'node:crypto';

import type { RouterStore } from './store.js';

const STATUSES = new Set(['created', 'accepted', 'in_progress', 'blocked', 'done']);
const PRIORITIES = new Set(['p0', 'p1', 'p2', 'p3']);
const GRANULARITIES = new Set(['epic', 'task', 'subtask']);
const TRANSITIONS = new Map([
  ['created', new Set(['accepted'])],
  ['accepted', new Set(['in_progress'])],
  ['in_progress', new Set(['blocked', 'done'])],
  ['blocked', new Set(['in_progress'])],
]);

export interface LegacyTask {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  granularity: string;
  assignee: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  heartbeat_at: string | null;
  waiting_reason: string | null;
  waiting_until: string | null;
  parent_id: string | null;
  labels: string[];
  health: null;
  comments: Readonly<Record<string, unknown>>[];
}

interface TaskRow {
  task_id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  granularity: string;
  assignee_name: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  heartbeat_at: string | null;
  waiting_reason: string | null;
  waiting_until: string | null;
  parent_id: string | null;
  labels_json: string;
  comments_json: string;
}

interface MigrationRow {
  state: 'importing' | 'verified' | 'complete';
  source_count: number;
  source_digest: string;
  imported_count: number;
}

export interface TaskStoreLike {
  createTask(body: Readonly<Record<string, unknown>>): LegacyTask;
  getTask(id: string): LegacyTask | null;
  listTasks(filters?: Readonly<Record<string, string>>): LegacyTask[];
  updateTask(id: string, patch: Readonly<Record<string, unknown>>): LegacyTask;
  updateTaskExecution(id: string, patch: Readonly<Record<string, unknown>>): LegacyTask;
  transitionTask(id: string, newStatus: string, extra?: Readonly<Record<string, unknown>>): LegacyTask;
  addComment(id: string, comment: Readonly<Record<string, unknown>>): LegacyTask;
  deleteTask(id: string): LegacyTask | null;
  dump(): LegacyTask[];
}

export interface TaskMigrationResult {
  migrationId: string;
  sourceCount: number;
  importedCount: number;
  sourceDigest: string;
  replayed: boolean;
}

function taskError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function text(value: unknown, max = 255): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, max) : null;
}

function labels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const label = text(item, 64);
    if (label && !result.includes(label) && result.length < 20) result.push(label);
  }
  return result;
}

function records(value: unknown): Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Readonly<Record<string, unknown>> => (
    item !== null && !Array.isArray(item) && typeof item === 'object'
  ));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) output[key] = canonical(input[key]);
    return output;
  }
  return value;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function fromRow(row: TaskRow): LegacyTask {
  const parsedLabels: unknown = JSON.parse(row.labels_json);
  const parsedComments: unknown = JSON.parse(row.comments_json);
  return {
    id: row.task_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    granularity: row.granularity,
    assignee: row.assignee_name,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    heartbeat_at: row.heartbeat_at,
    waiting_reason: row.waiting_reason,
    waiting_until: row.waiting_until,
    parent_id: row.parent_id,
    labels: labels(parsedLabels),
    health: null,
    comments: records(parsedComments),
  };
}

function normalizeLegacy(raw: Readonly<Record<string, unknown>>): LegacyTask {
  const id = text(raw.id, 255);
  const title = text(raw.title, 255);
  const status = text(raw.status, 32) ?? 'created';
  const priority = text(raw.priority, 8) ?? 'p2';
  const granularity = text(raw.granularity, 16) ?? 'task';
  if (!id || !title) throw taskError('migration_invalid', 'legacy task id and title are required');
  if (!STATUSES.has(status) || !PRIORITIES.has(priority) || !GRANULARITIES.has(granularity)) {
    throw taskError('migration_invalid', `legacy task ${id} has an invalid enum value`);
  }
  const now = new Date().toISOString();
  return {
    id,
    title,
    description: text(raw.description, 4096) ?? '',
    status,
    priority,
    granularity,
    assignee: text(raw.assignee, 128),
    created_by: text(raw.created_by, 128),
    created_at: text(raw.created_at, 64) ?? now,
    updated_at: text(raw.updated_at, 64) ?? now,
    started_at: text(raw.started_at, 64),
    completed_at: text(raw.completed_at, 64),
    heartbeat_at: text(raw.heartbeat_at, 64),
    waiting_reason: text(raw.waiting_reason, 1024),
    waiting_until: text(raw.waiting_until, 64),
    parent_id: text(raw.parent_id, 255),
    labels: labels(raw.labels),
    health: null,
    comments: records(raw.comments),
  };
}

function parentFirst(tasks: readonly LegacyTask[]): LegacyTask[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: LegacyTask[] = [];
  const visit = (task: LegacyTask): void => {
    if (visited.has(task.id)) return;
    if (visiting.has(task.id)) throw taskError('migration_invalid', `legacy task parent cycle at ${task.id}`);
    visiting.add(task.id);
    if (task.parent_id) {
      const parent = byId.get(task.parent_id);
      if (!parent) throw taskError('migration_invalid', `legacy task ${task.id} has missing parent ${task.parent_id}`);
      visit(parent);
    }
    visiting.delete(task.id);
    visited.add(task.id);
    ordered.push(task);
  };
  for (const task of [...tasks].sort((left, right) => left.id.localeCompare(right.id))) visit(task);
  return ordered;
}

function insertTask(router: RouterStore, task: LegacyTask): void {
  router.db.prepare<[
    string, string, string, string, string, string, string | null, string | null,
    string | null, string, string, string | null, string | null, string | null,
    string | null, string | null, string, string,
  ]>(`INSERT INTO tasks(
    task_id, title, description, status, priority, granularity, assignee_name,
    created_by, parent_id, labels_json, comments_json, started_at, completed_at,
    heartbeat_at, waiting_reason, waiting_until, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    task.id,
    task.title,
    task.description,
    task.status,
    task.priority,
    task.granularity,
    task.assignee,
    task.created_by,
    task.parent_id,
    JSON.stringify(task.labels),
    JSON.stringify(task.comments),
    task.started_at,
    task.completed_at,
    task.heartbeat_at,
    task.waiting_reason,
    task.waiting_until,
    task.created_at,
    task.updated_at,
  );
}

export function migrateLegacyTasks(
  router: RouterStore,
  source: readonly Readonly<Record<string, unknown>>[],
  migrationId = 'tasks-json-v1',
): TaskMigrationResult {
  const normalized = source.map(normalizeLegacy).sort((left, right) => left.id.localeCompare(right.id));
  const insertionOrder = parentFirst(normalized);
  const sourceDigest = digest(normalized);
  const tx = router.db.transaction((): TaskMigrationResult => {
    const existing = router.db.prepare<[string], MigrationRow>(
      'SELECT state, source_count, source_digest, imported_count FROM task_store_migrations WHERE migration_id = ?',
    ).get(migrationId);
    if (existing?.state === 'complete') {
      if (existing.source_count !== normalized.length || existing.source_digest !== sourceDigest) {
        throw taskError('migration_conflict', 'completed task migration does not match the source');
      }
      return {
        migrationId,
        sourceCount: existing.source_count,
        importedCount: existing.imported_count,
        sourceDigest,
        replayed: true,
      };
    }
    if (existing && (existing.source_count !== normalized.length || existing.source_digest !== sourceDigest)) {
      throw taskError('migration_conflict', 'incomplete task migration does not match the source');
    }
    router.db.prepare<[string, number, string, number]>(
      `INSERT OR IGNORE INTO task_store_migrations(
        migration_id, state, source_count, source_digest, started_at
      ) VALUES (?, 'importing', ?, ?, ?)`,
    ).run(migrationId, normalized.length, sourceDigest, Date.now());
    for (const task of insertionOrder) {
      const row = router.db.prepare<[string], TaskRow>('SELECT * FROM tasks WHERE task_id = ?').get(task.id);
      if (row) {
        if (digest(fromRow(row)) !== digest(task)) {
          throw taskError('migration_conflict', `SQLite task ${task.id} differs from the JSON source`);
        }
      } else {
        insertTask(router, task);
      }
    }
    const imported = router.db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM tasks').get()?.count ?? 0;
    if (imported !== normalized.length) {
      throw taskError('migration_conflict', 'target task count differs after import');
    }
    const target = router.db.prepare<[], TaskRow>('SELECT * FROM tasks ORDER BY task_id').all().map(fromRow);
    if (digest(target) !== sourceDigest) {
      throw taskError('migration_conflict', 'target canonical task digest differs after import');
    }
    const now = Date.now();
    router.db.prepare<[number, number, number, string]>(
      `UPDATE task_store_migrations SET state = 'complete', imported_count = ?,
       verified_at = ?, completed_at = ? WHERE migration_id = ?`,
    ).run(imported, now, now, migrationId);
    return { migrationId, sourceCount: normalized.length, importedCount: imported, sourceDigest, replayed: false };
  });
  return tx();
}

export function createRouterTaskStore(router: RouterStore): TaskStoreLike {
  const get = (id: string): LegacyTask | null => {
    const row = router.db.prepare<[string], TaskRow>('SELECT * FROM tasks WHERE task_id = ?').get(id);
    return row ? fromRow(row) : null;
  };
  const requireTask = (id: string): LegacyTask => {
    const task = get(id);
    if (!task) throw taskError('not_found', `task not found: ${id}`);
    return task;
  };

  const store: TaskStoreLike = {
    createTask(body) {
      const title = text(body.title, 255);
      if (!title) throw taskError('invalid_title', 'title is required');
      const priority = text(body.priority, 8) ?? 'p2';
      const granularity = text(body.granularity, 16) ?? 'task';
      if (!PRIORITIES.has(priority)) throw taskError('invalid_priority', `invalid priority: ${String(body.priority)}`);
      if (!GRANULARITIES.has(granularity)) throw taskError('invalid_granularity', `invalid granularity: ${String(body.granularity)}`);
      const parentId = text(body.parent_id, 255);
      if (parentId && !get(parentId)) throw taskError('invalid_parent', `parent task not found: ${parentId}`);
      const now = new Date().toISOString();
      const task: LegacyTask = {
        id: `task_${randomUUID()}`,
        title,
        description: text(body.description, 4096) ?? '',
        status: 'created',
        priority,
        granularity,
        assignee: text(body.assignee, 128),
        created_by: text(body.created_by, 128),
        created_at: now,
        updated_at: now,
        started_at: null,
        completed_at: null,
        heartbeat_at: null,
        waiting_reason: null,
        waiting_until: null,
        parent_id: parentId,
        labels: labels(body.labels),
        health: null,
        comments: [],
      };
      router.db.transaction(() => insertTask(router, task))();
      return task;
    },
    getTask: get,
    listTasks(filters = {}) {
      let result = router.db.prepare<[], TaskRow>('SELECT * FROM tasks ORDER BY created_at, task_id').all().map(fromRow);
      if (filters.assignee) result = result.filter((task) => task.assignee === filters.assignee);
      if (filters.status) {
        const wanted = new Set(filters.status.split(',').map((item) => item.trim()).filter(Boolean));
        result = result.filter((task) => wanted.has(task.status));
      }
      if (filters.priority) result = result.filter((task) => task.priority === filters.priority);
      if (filters.label) result = result.filter((task) => task.labels.includes(filters.label ?? ''));
      return result;
    },
    updateTask(id, patch) {
      return router.db.transaction(() => {
        const task = requireTask(id);
        if (patch.title !== undefined) task.title = text(patch.title, 255) ?? task.title;
        if (patch.description !== undefined) task.description = text(patch.description, 4096) ?? '';
        if (patch.priority !== undefined) {
          const value = text(patch.priority, 8);
          if (!value || !PRIORITIES.has(value)) throw taskError('invalid_priority', `invalid priority: ${String(patch.priority)}`);
          task.priority = value;
        }
        if (patch.granularity !== undefined) {
          const value = text(patch.granularity, 16);
          if (!value || !GRANULARITIES.has(value)) throw taskError('invalid_granularity', `invalid granularity: ${String(patch.granularity)}`);
          task.granularity = value;
        }
        if (patch.assignee !== undefined) task.assignee = text(patch.assignee, 128);
        if (patch.labels !== undefined) task.labels = labels(patch.labels);
        if (patch.parent_id !== undefined) {
          const parentId = text(patch.parent_id, 255);
          if (parentId && !get(parentId)) throw taskError('invalid_parent', `parent task not found: ${parentId}`);
          task.parent_id = parentId;
        }
        task.updated_at = new Date().toISOString();
        updateRow(router, task);
        return task;
      })();
    },
    updateTaskExecution(id, patch) {
      return router.db.transaction(() => {
        const task = requireTask(id);
        if (patch.heartbeat_at !== undefined) task.heartbeat_at = new Date().toISOString();
        if (patch.waiting_reason !== undefined) task.waiting_reason = text(patch.waiting_reason, 1024);
        if (patch.waiting_until !== undefined) task.waiting_until = text(patch.waiting_until, 64);
        task.updated_at = new Date().toISOString();
        updateRow(router, task);
        return task;
      })();
    },
    transitionTask(id, newStatus, extra = {}) {
      return router.db.transaction(() => {
        const task = requireTask(id);
        if (!STATUSES.has(newStatus)) throw taskError('invalid_status', `invalid status: ${newStatus}`);
        if (!TRANSITIONS.get(task.status)?.has(newStatus)) {
          throw taskError('invalid_transition', `cannot transition from '${task.status}' to '${newStatus}'`);
        }
        const reason = text(extra.waiting_reason, 1024);
        const until = text(extra.waiting_until, 64);
        if (newStatus === 'blocked' && (!reason || !until)) {
          throw taskError(!reason ? 'missing_waiting_reason' : 'missing_waiting_until', 'waiting reason and until are required');
        }
        const now = new Date().toISOString();
        task.status = newStatus;
        task.updated_at = now;
        if ((newStatus === 'accepted' || newStatus === 'in_progress') && !task.started_at) task.started_at = now;
        if (newStatus === 'done') task.completed_at = now;
        task.waiting_reason = newStatus === 'blocked' ? reason : null;
        task.waiting_until = newStatus === 'blocked' ? until : null;
        updateRow(router, task);
        return task;
      })();
    },
    addComment(id, comment) {
      return router.db.transaction(() => {
        const task = requireTask(id);
        const body = text(comment.text, 4096);
        if (!body) throw taskError('invalid_comment', 'comment text is required');
        if (task.comments.length >= 100) throw taskError('limit_exceeded', 'max 100 comments per task');
        task.comments.push({ author: text(comment.author, 128) ?? 'anonymous', text: body, ts: new Date().toISOString() });
        task.updated_at = new Date().toISOString();
        updateRow(router, task);
        return task;
      })();
    },
    deleteTask(id) {
      return router.db.transaction(() => {
        const task = get(id);
        if (!task) return null;
        router.db.prepare<[string]>('DELETE FROM tasks WHERE task_id = ?').run(id);
        return task;
      })();
    },
    dump() { return store.listTasks(); },
  };
  return store;
}

function updateRow(router: RouterStore, task: LegacyTask): void {
  router.db.prepare<[
    string, string, string, string, string, string | null, string | null, string | null,
    string, string, string | null, string | null, string | null, string | null,
    string | null, string, string,
  ]>(`UPDATE tasks SET title = ?, description = ?, status = ?, priority = ?,
    granularity = ?, assignee_name = ?, created_by = ?, parent_id = ?,
    labels_json = ?, comments_json = ?, started_at = ?, completed_at = ?,
    heartbeat_at = ?, waiting_reason = ?, waiting_until = ?, updated_at = ?
    WHERE task_id = ?`).run(
    task.title,
    task.description,
    task.status,
    task.priority,
    task.granularity,
    task.assignee,
    task.created_by,
    task.parent_id,
    JSON.stringify(task.labels),
    JSON.stringify(task.comments),
    task.started_at,
    task.completed_at,
    task.heartbeat_at,
    task.waiting_reason,
    task.waiting_until,
    task.updated_at,
    task.id,
  );
}
