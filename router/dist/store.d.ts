import type { ActivationResult, ActiveTaskBinding, ApprovalDecisionEvent, AttachInputsResult, AttachTaskInputsInput, AuthenticatedMessageInput, CapabilityInput, ClaimDispatchInput, ClaimResult, CreateTaskIntentInput, EnqueueDispatchInput, EnqueueResult, EventPage, IngestResult, MatrixCommand, MatrixDeliveryFailure, MatrixDeliveryReceipt, LaunchDescriptor, OutcomeInspectionResult, OutcomeResolutionResult, ParkDispatchInput, ReconcileReport, Refusal, ReplyCommand, RouterOptions, RouterSnapshot, ResolveOutcomeUnknownInput, RunnerEffectInput, SessionInboxMessage, SessionView, SetSessionOverridesInput, SettleDispatchInput, SettleSuccess, StartedPayload, StoredMessageResult, TaskDeliveryResult, TaskDispatchFailureResult, TaskIntentResult } from './types.js';
export declare class RouterStore {
    readonly dbPath: string;
    private readonly now;
    private readonly randomBytes;
    private readonly eventRetention;
    constructor(options: RouterOptions);
    close(): void;
    private applyMigrations;
    private emit;
    private trimEvents;
    private resolveSessionInternal;
    resolveSession(input: {
        agentId: string;
        agentName: string;
        roomId: string;
        threadRootEventId?: string | null;
    }): SessionView;
    sessionById(sessionIdInput: string): SessionView | null;
    setSessionOverrides(input: SetSessionOverridesInput): SessionView | Refusal;
    queueSessionNotice(input: {
        roomId: string;
        threadRootEventId?: string | null;
        senderAgentName: string;
        dedupeKey: string;
        body: string;
    }): {
        ok: true;
    } | Refusal;
    initializeIngestionCursor(sourceInput: string, cursorInput: string): {
        created: boolean;
        value: string;
    };
    readIngestionCursor(sourceInput: string): string | null;
    advanceIngestionCursor(sourceInput: string, cursorInput: string): void;
    private storeMessageInternal;
    storeTaskMessage(input: AuthenticatedMessageInput): StoredMessageResult;
    ingestMessage(input: AuthenticatedMessageInput): IngestResult;
    createTaskIntent(input: CreateTaskIntentInput): TaskIntentResult;
    attachTaskInputs(input: AttachTaskInputsInput): AttachInputsResult;
    claimMatrixCommand(claimMs?: number): MatrixCommand | null;
    recordMatrixDelivery(input: MatrixDeliveryReceipt): ActivationResult;
    recordMatrixFailure(input: MatrixDeliveryFailure): TaskDeliveryResult;
    recordTaskDispatchFailure(taskIdInput: string, errorCodeInput: string): TaskDispatchFailureResult;
    private findThreadSession;
    findActiveTaskBinding(agentIdInput: string, roomIdInput: string, rootInput: string): ActiveTaskBinding | Refusal;
    enqueueDispatch(input: EnqueueDispatchInput): EnqueueResult;
    private ensureResource;
    registerWorkspace(input: {
        resourceId: string;
        safeLabel: string;
        backendPath: string;
        branchName?: string | null;
    }): void;
    claimDispatch(input: ClaimDispatchInput): ClaimResult;
    nextQueuedDispatchAt(): number | null;
    getLaunchDescriptor(input: CapabilityInput): LaunchDescriptor | Refusal;
    private validateCapability;
    takePayload(input: CapabilityInput): StartedPayload | Refusal;
    private buildRunnerContext;
    acknowledgeRunnerEffect(input: RunnerEffectInput): {
        ok: true;
    } | Refusal;
    parkForApproval(input: ParkDispatchInput): {
        ok: true;
        replayed: boolean;
    } | Refusal;
    recordApprovalDecision(input: ApprovalDecisionEvent): {
        ok: true;
        replayed: boolean;
    } | Refusal;
    reconcileApprovalDecision(input: {
        approvalId: string;
        decisionEventId: string;
        decision: 'allow' | 'deny';
    }): {
        ok: true;
        replayed: boolean;
        deliverable: boolean;
    } | Refusal;
    readApprovalDecision(input: CapabilityInput & {
        approvalId: string;
        operationDigest: string;
    }): {
        ok: true;
        decision: 'allow' | 'deny' | null;
    } | Refusal;
    resumeAfterApproval(input: CapabilityInput & {
        approvalId: string;
        operationDigest: string;
    }): {
        ok: true;
        decision: 'allow' | 'deny';
    } | Refusal;
    settleAndRelease(input: SettleDispatchInput): SettleSuccess | Refusal;
    claimReplyCommand(claimMs?: number): ReplyCommand | null;
    recordReplyDelivery(input: {
        commandId: string;
        claimToken: string;
        eventId: string;
    }): {
        ok: true;
        replayed: boolean;
    } | Refusal;
    recordReplyFailure(input: {
        commandId: string;
        claimToken: string;
        errorCode: string;
    }): {
        ok: true;
        replayed: boolean;
    } | Refusal;
    cancelBeforeStart(dispatchIdInput: string, reasonInput?: string): {
        ok: true;
        state: 'cancelled_before_start';
    } | Refusal;
    requeueBeforeStart(input: CapabilityInput, retryDelayMs?: number, reasonInput?: string): {
        ok: true;
        state: 'queued';
        retryAt: number;
    } | Refusal;
    markOutcomeUnknown(dispatchIdInput: string, reasonInput: string): {
        ok: true;
        state: 'outcome_unknown';
    } | Refusal;
    private settleUnknownInternal;
    private enqueueThreadNotice;
    private enqueueTaskNotice;
    private insertNotice;
    private recordNoticeDelivery;
    private recordNoticeFailure;
    beginOutcomeInspection(dispatchIdInput: string, ttlMs?: number): OutcomeInspectionResult;
    resolveOutcomeUnknown(input: ResolveOutcomeUnknownInput): OutcomeResolutionResult;
    inspectWorkspace(resourceIdInput: string): Readonly<Record<string, unknown>> | Refusal;
    clearWorkspaceDirty(resourceIdInput: string): {
        ok: true;
    } | Refusal;
    checkInbox(input: CapabilityInput): readonly SessionInboxMessage[] | Refusal;
    checkInboxForAgent(input: CapabilityInput, agentNameInput: string): readonly SessionInboxMessage[] | Refusal;
    createTaskFromDispatch(input: CapabilityInput & {
        toolCallId: string;
        rootMessageId: string;
        inputMessageIds: readonly string[];
        task: {
            title: string;
            description?: string;
            priority?: 'p0' | 'p1' | 'p2' | 'p3';
            granularity?: 'epic' | 'task' | 'subtask';
            assigneeAgentId: string;
            assigneeName: string;
            parentId?: string | null;
            labels?: readonly string[];
        };
        acknowledgementBody?: string;
    }): TaskIntentResult;
    assembleContext(sessionIdInput: string, tokenBudget?: number): Readonly<Record<string, unknown>> | Refusal;
    updateRollingSummary(sessionIdInput: string, summaryInput: string): {
        ok: true;
        contextGeneration: number;
    } | Refusal;
    snapshot(): RouterSnapshot;
    eventsAfter(after: number, limit?: number): EventPage;
    private meta;
    reconcileOnStart(): ReconcileReport;
}
export declare function openRouter(options: RouterOptions): RouterStore;
