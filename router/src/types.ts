export type ScopeKind = 'main' | 'thread';
export type WorkspaceMode = 'shared' | 'worktree';
export type DispatchState =
  | 'queued'
  | 'leased'
  | 'started'
  | 'parked'
  | 'completed'
  | 'cancelled_before_start'
  | 'outcome_unknown';

export type RefusalCode =
  | 'bad_request'
  | 'not_found'
  | 'idempotency_conflict'
  | 'missing_task_binding'
  | 'missing_task_credential'
  | 'task_not_active'
  | 'unsupported_framework'
  | 'remote_runner_unsupported'
  | 'resource_unavailable'
  | 'workspace_quarantined'
  | 'live_runner_cap'
  | 'parked_runner_cap'
  | 'invalid_capability'
  | 'capability_expired'
  | 'dispatch_not_current'
  | 'invalid_transition'
  | 'approval_mismatch'
  | 'inspection_required'
  | 'inspection_expired'
  | 'matrix_command_conflict';

export interface Refusal {
  ok: false;
  code: RefusalCode;
  message: string;
}

export interface SessionView {
  sessionId: string;
  agentId: string;
  agentName: string;
  roomId: string;
  scopeKind: ScopeKind;
  threadRootEventId: string | null;
  contextGeneration: number;
  lastActive: number;
  modelOverride: string | null;
  modeOverride: 'plan' | 'auto' | null;
}

export interface SetSessionOverridesInput {
  agentId: string;
  agentName: string;
  roomId: string;
  threadRootEventId?: string | null;
  /** undefined leaves the stored value; null clears it. */
  model?: string | null;
  /** undefined leaves the stored value; null clears it. */
  mode?: 'plan' | 'auto' | null;
  requestedBy: string;
}

export interface AuthenticatedMessageInput {
  messageId: string;
  roomId: string;
  matrixEventId?: string | null;
  threadRootEventId?: string | null;
  senderMxid?: string | null;
  senderName?: string | null;
  recipientAgentId: string;
  recipientAgentName: string;
  normalizedBody: string;
  receivedAt?: number;
  explicitTask?: boolean;
}

export interface IngestSuccess {
  ok: true;
  created: boolean;
  messageId: string;
  session: SessionView;
}
export type IngestResult = IngestSuccess | Refusal;

export interface StoredMessageSuccess {
  ok: true;
  created: boolean;
  messageId: string;
}
export type StoredMessageResult = StoredMessageSuccess | Refusal;

export interface TaskRecordInput {
  taskId?: string;
  title: string;
  description?: string;
  priority?: 'p0' | 'p1' | 'p2' | 'p3';
  granularity?: 'epic' | 'task' | 'subtask';
  assigneeAgentId: string;
  assigneeName: string;
  creatorAgentId?: string | null;
  createdBy?: string | null;
  parentId?: string | null;
  labels?: readonly string[];
}

export interface CreateTaskIntentInput {
  requestScope: string;
  requestKey: string;
  roomId: string;
  threadRootEventId: string;
  rootMessageId: string;
  inputMessageIds: readonly string[];
  task: TaskRecordInput;
  acknowledgementBody?: string;
}

export interface TaskIntentSuccess {
  ok: true;
  replayed: boolean;
  taskId: string;
  commandId: string;
  transactionId: string;
  activationState: 'pending_thread';
}
export type TaskIntentResult = TaskIntentSuccess | Refusal;

export interface AttachTaskInputsInput {
  taskId: string;
  requestScope: string;
  requestKey: string;
  messageIds: readonly string[];
}

export interface AttachInputsSuccess {
  ok: true;
  replayed: boolean;
  attached: number;
}
export type AttachInputsResult = AttachInputsSuccess | Refusal;

export interface MatrixCommand {
  commandId: string;
  taskId: string;
  transactionId: string;
  roomId: string;
  threadRootEventId: string;
  body: string;
  senderAgentName: string;
  payloadDigest: string;
  claimToken: string;
  claimUntil: number;
}

export interface ReplyCommand {
  commandId: string;
  dispatchId: string | null;
  transactionId: string;
  roomId: string;
  threadRootEventId: string | null;
  body: string;
  senderAgentName: string;
  payloadDigest: string;
  claimToken: string;
  claimUntil: number;
}

export interface MatrixDeliveryReceipt {
  commandId: string;
  claimToken: string;
  eventId: string;
}

export interface MatrixDeliveryFailure {
  commandId: string;
  claimToken: string;
  errorCode: string;
}

export interface ActivationSuccess {
  ok: true;
  replayed: boolean;
  taskId: string;
  sessionId: string;
  agentId: string;
  agentName: string;
  roomId: string;
  threadRootEventId: string;
  threadAnchorEventId: string;
}
export type ActivationResult = ActivationSuccess | Refusal;

export interface TaskDeliveryFailureResult {
  ok: true;
  replayed: boolean;
  taskId: string;
  activationState: 'thread_delivery_failed';
}
export type TaskDeliveryResult = TaskDeliveryFailureResult | Refusal;

export interface TaskDispatchFailureSuccess {
  ok: true;
  replayed: boolean;
  taskId: string;
  state: 'blocked';
}
export type TaskDispatchFailureResult = TaskDispatchFailureSuccess | Refusal;

export interface EnqueueDispatchInput {
  sessionId: string;
  taskId?: string | null;
  framework: 'claude' | 'codex' | 'octos';
  serverId?: string | null;
  localServerId: string;
  workspaceMode?: WorkspaceMode;
  workspaceResourceId?: string | null;
  namedResourceIds?: readonly string[];
  mayWrite?: boolean;
  payload: Readonly<Record<string, unknown>>;
}

export interface EnqueueSuccess {
  ok: true;
  dispatchId: string;
  state: DispatchState;
}
export type EnqueueResult = EnqueueSuccess | Refusal;

export interface ClaimDispatchInput {
  runnerId: string;
  leaseMs: number;
  capabilityTtlMs: number;
  maxLiveRunners: number;
}

export interface ClaimSuccess {
  ok: true;
  dispatchId: string;
  runnerId: string;
  fenceGeneration: number;
  capability: string;
  leaseUntil: number;
  workspaceResourceId: string | null;
}

export interface LaunchDescriptor {
  dispatchId: string;
  framework: 'claude' | 'codex';
  cwd: string;
  agentId: string;
  agentName: string;
  sessionId: string;
  roomId: string;
  taskId: string | null;
  workspaceMode: WorkspaceMode;
  /**
   * Whether this dispatch holds a workspace lease and may therefore write.
   * A dispatch without it must be launched into a read-only runtime: it takes
   * no lease and leaves no dirty marker, so writes from it would be both
   * unserialized and untracked.
   */
  mayWrite: boolean;
  /** Operator-set per-session model override, forwarded verbatim to the CLI. */
  modelOverride: string | null;
}

export interface ActiveTaskBinding {
  taskId: string;
  sessionId: string;
  agentId: string;
  agentName: string;
  roomId: string;
  threadRootEventId: string;
  threadAnchorEventId: string;
}
export type ClaimResult = ClaimSuccess | Refusal | null;

export interface CapabilityInput {
  dispatchId: string;
  runnerId: string;
  fenceGeneration: number;
  capability: string;
}

export interface StartedPayload {
  ok: true;
  dispatchId: string;
  sessionId: string;
  taskId: string | null;
  fenceGeneration: number;
  payload: Readonly<Record<string, unknown>>;
  inbox: readonly SessionInboxMessage[];
  context: RunnerContext;
}

export interface RunnerContext {
  contextGeneration: number;
  rollingSummary: string;
  messages: readonly SessionInboxMessage[];
  coordinatorDigest: readonly Readonly<Record<string, unknown>>[];
  taskDigest: Readonly<Record<string, unknown>> | null;
  tokenBudget: number;
}

export interface SessionInboxMessage {
  messageId: string;
  senderName: string | null;
  body: string;
  receivedAt: number;
}

export interface RunnerEffectInput extends CapabilityInput {
  acceptedAt?: number;
}

export interface ParkDispatchInput extends CapabilityInput {
  approvalId: string;
  operationDigest: string;
  upstreamThreadId?: string | null;
  upstreamTurnId?: string | null;
  upstreamItemId?: string | null;
  upstreamRequestId?: string | null;
  maxParkedRunners: number;
}

export interface ApprovalDecisionEvent {
  decisionEventId: string;
  approvalId: string;
  dispatchId: string;
  operationDigest: string;
  decision: 'allow' | 'deny';
}

export interface SettleDispatchInput extends CapabilityInput {
  outcome: 'completed' | 'outcome_unknown';
  reason?: string | null;
  output?: Readonly<Record<string, unknown>> | null;
  workspaceDirty?: boolean;
}

export interface CompletedSettleSuccess {
  ok: true;
  state: 'completed';
  fenced: boolean;
}
export interface OutcomeUnknownSettleSuccess {
  ok: true;
  state: 'outcome_unknown';
  fenced: boolean;
  workspaceDirty: boolean;
}
export type SettleSuccess = CompletedSettleSuccess | OutcomeUnknownSettleSuccess;

export type OutcomeResolutionAction = 'continue' | 'accept_completed' | 'keep_blocked';

export interface OutcomeInspectionSuccess {
  ok: true;
  inspectionId: string;
  inspectionToken: string;
  dispatchId: string;
  taskId: string | null;
  expiresAt: number;
  resource: Readonly<{
    resourceId: string;
    safeLabel: string;
    branchName: string | null;
    dirtyGeneration: number;
    dirtyReason: string | null;
  }> | null;
  terminalReason: string | null;
}
export type OutcomeInspectionResult = OutcomeInspectionSuccess | Refusal;

export interface ResolveOutcomeUnknownInput {
  dispatchId: string;
  inspectionId: string;
  inspectionToken: string;
  requestId: string;
  action: OutcomeResolutionAction;
  operatorNote: string;
  recoveryInstruction?: string | null;
}

export interface OutcomeResolutionSuccess {
  ok: true;
  replayed: boolean;
  dispatchId: string;
  action: OutcomeResolutionAction;
  taskId: string | null;
  replacementDispatchId: string | null;
}
export type OutcomeResolutionResult = OutcomeResolutionSuccess | Refusal;

export interface RouterEvent {
  seq: number;
  schemaVersion: number;
  at: number;
  kind: string;
  payload: Readonly<Record<string, unknown>>;
}

export interface RouterSnapshot {
  schemaVersion: number;
  lowWatermark: number;
  highWatermark: number;
  sessions: readonly Readonly<Record<string, unknown>>[];
  tasks: readonly Readonly<Record<string, unknown>>[];
  dispatches: readonly Readonly<Record<string, unknown>>[];
  resources: readonly Readonly<Record<string, unknown>>[];
  attention: readonly Readonly<Record<string, unknown>>[];
}

export interface EventPage {
  schemaVersion: number;
  lowWatermark: number;
  highWatermark: number;
  gap: boolean;
  events: readonly RouterEvent[];
}

export interface ReconcileReport {
  requeued: number;
  outcomeUnknown: number;
  expiredMatrixClaims: number;
}

export interface RouterOptions {
  dbPath: string;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  eventRetention?: number;
}
