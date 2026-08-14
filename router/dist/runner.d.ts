import type { RouterStore } from './store.js';
import type { ClaimSuccess, Refusal, SettleSuccess } from './types.js';
export interface OwnerApprovalRequest {
    approvalId: string;
    dispatchId: string;
    operationDigest: string;
    framework: 'codex';
    kind: 'command' | 'file_change' | 'permissions';
    reason: string | null;
    command: string | null;
    cwd: string | null;
    upstreamThreadId: string;
    upstreamTurnId: string;
    upstreamItemId: string;
    upstreamRequestId: string;
}
export interface OwnerApprovalVerdict {
    decisionEventId: string;
    decision: 'allow' | 'deny';
}
export type OwnerApprovalHandler = (request: OwnerApprovalRequest) => Promise<OwnerApprovalVerdict>;
export interface RunnerBaseOptions {
    router: RouterStore;
    claim: ClaimSuccess;
    cwd: string;
    env?: Readonly<Record<string, string>>;
    acknowledgementTimeoutMs?: number;
    executionTimeoutMs?: number;
    signal?: AbortSignal;
    /**
     * Whether this dispatch holds the workspace lease. Defaults to `false` so
     * that a caller which forgets to pass it gets the confined runtime rather
     * than an unserialized, untracked writable one.
     */
    mayWrite?: boolean;
}
export interface CodexRunnerOptions extends RunnerBaseOptions {
    executable?: string;
    model?: string;
    effort?: 'low' | 'medium' | 'high' | 'xhigh';
    approvalTimeoutMs: number;
    maxParkedRunners: number;
    requestOwnerApproval: OwnerApprovalHandler;
    mcpServer?: {
        name: string;
        command: string;
        args: readonly string[];
        envVars: readonly string[];
    };
}
export interface ClaudeRunnerOptions extends RunnerBaseOptions {
    executable?: string;
    args?: readonly string[];
}
export interface RunnerCompletion {
    dispatchId: string;
    state: 'completed' | 'outcome_unknown';
    text: string;
    exitCode: number | null;
}
export declare function operationDigest(method: string, params: Readonly<Record<string, unknown>>): string;
export declare function runClaudeDispatch(options: ClaudeRunnerOptions): Promise<RunnerCompletion>;
export declare function runCodexDispatch(options: CodexRunnerOptions): Promise<RunnerCompletion>;
export declare function isCompletedSettlement(result: SettleSuccess | Refusal): result is SettleSuccess;
