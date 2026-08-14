export interface WorktreeSpec {
    repositoryPath: string;
    worktreesDir: string;
    agentId: string;
    threadRootEventId: string;
    bootstrap?: readonly string[];
}
export interface WorktreeInfo {
    path: string;
    branch: string;
    safeLabel: string;
    resourceId: string;
    created: boolean;
}
export interface WorktreeInspection extends WorktreeInfo {
    dirty: boolean;
}
export declare class WorktreeManager {
    private readonly preparations;
    ensureAsync(spec: WorktreeSpec): Promise<WorktreeInfo>;
    ensure(spec: WorktreeSpec): WorktreeInfo;
    inspect(spec: WorktreeSpec): WorktreeInspection;
    remove(spec: WorktreeSpec, force?: boolean): WorktreeInfo;
    private registeredWorktrees;
}
