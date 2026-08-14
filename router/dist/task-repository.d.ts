import type { RouterStore } from './store.js';
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
export declare function migrateLegacyTasks(router: RouterStore, source: readonly Readonly<Record<string, unknown>>[], migrationId?: string): TaskMigrationResult;
export declare function createRouterTaskStore(router: RouterStore): TaskStoreLike;
