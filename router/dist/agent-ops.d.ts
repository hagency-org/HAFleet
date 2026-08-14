import type { RouterStore } from './store.js';
export declare const AGENT_OPS_CONTRACT = "com.hafleet.agent_ops.v1";
export declare const AGENT_OPS_ERROR_CODES: readonly ['bad_request', 'not_found', 'feature_disabled', 'device_enrollment_required', 'device_mismatch', 'scope_mismatch', 'invalid_capability', 'capability_expired', 'capability_consumed', 'auth_fence_stale', 'idempotency_conflict', 'precondition_failed', 'inspection_required', 'inspection_expired', 'invalid_transition', 'loopback_required', 'host_mismatch', 'browser_origin_forbidden', 'internal_error'];
export declare const AGENT_OPS_LIMITS: Readonly<{
    grant_ttl_ms: number;
    grant_ttl_max_ms: number;
    session_ttl_ms: number;
    session_ttl_max_ms: number;
    action_ttl_ms: number;
    action_ttl_max_ms: number;
    request_nonce_max_chars: 255;
    request_nonces_per_session: 10000;
    action_capability_max_chars: 8192;
    request_body_max_bytes: number;
}>;
export type AgentOpsActionKind = 'cancel_dispatch' | 'mark_resource_inspected' | 'begin_outcome_inspection' | 'resolve_outcome';
export type AgentOpsResolution = 'continue' | 'accept_completed' | 'keep_blocked';
export type AgentOpsEntityKind = 'dispatch' | 'resource';
export interface AgentOpsScopeInput {
    ownerMxid: string;
    ownerDmRoomId: string;
    projectRoomId: string;
    stableAgentId: string;
    agentName: string;
}
export interface AgentOpsDeviceInput {
    matrixDeviceId: string;
    matrixDeviceEd25519: string;
    matrixDeviceCurve25519: string;
}
export interface AgentOpsTarget {
    entity_kind: AgentOpsEntityKind;
    entity_id: string;
    entity_version: number;
}
export interface AgentOpsResourcePrecondition {
    resource_id: string;
    dirty_generation: number;
}
export interface AgentOpsAuthContext {
    clientSessionId: string;
    scopeId: string;
    authFenceGeneration: number;
    audience: string;
}
export interface AgentOpsRefusal {
    ok: false;
    code: (typeof AGENT_OPS_ERROR_CODES)[number];
    message: string;
}
type AgentOpsResult<T extends Readonly<Record<string, unknown>>> = ({
    ok: true;
} & T) | AgentOpsRefusal;
interface AgentOpsScopeRow {
    scope_id: string;
    owner_mxid: string;
    owner_dm_room_id: string;
    project_room_id: string;
    stable_agent_id: string;
    agent_name: string;
    projection_id: string;
    matrix_device_id: string | null;
    matrix_device_ed25519: string | null;
    matrix_device_curve25519: string | null;
    auth_fence_generation: number;
    created_at: number;
    updated_at: number;
}
export interface AgentOpsCommandEnvelope {
    schema: string;
    request_id: string;
    client_session_id: string;
    scope_id: string;
    projection_id: string;
    stream_epoch: string;
    auth_fence_generation: number;
    snapshot_seq: number;
    action_capability: string;
    target: AgentOpsTarget;
    resource_precondition?: AgentOpsResourcePrecondition | null;
}
export declare function agentOpsCanonicalJson(value: unknown): string;
export declare function agentOpsDigest(value: unknown): string;
export declare function agentOpsScopeId(input: AgentOpsScopeInput): string;
export declare class AgentOpsService {
    private readonly router;
    private readonly db;
    private readonly now;
    private readonly grantTtlMs;
    private readonly sessionTtlMs;
    private readonly actionTtlMs;
    constructor(router: RouterStore, options?: {
        now?: () => number;
        grantTtlMs?: number;
        sessionTtlMs?: number;
        actionTtlMs?: number;
    });
    private ensureMeta;
    private meta;
    bindServerIdentity(fingerprintInput: string): {
        rotated: boolean;
        revokedScopes: number;
    };
    scope(scopeId: string): AgentOpsScopeRow | null;
    enrollDevice(input: AgentOpsScopeInput & AgentOpsDeviceInput): AgentOpsResult<{
        replayed: boolean;
        scopeId: string;
        projectionId: string;
        authFenceGeneration: number;
    }>;
    revokeScope(scopeIdInput: string, clearDevice?: boolean): AgentOpsResult<{
        scopeId: string;
        authFenceGeneration: number;
    }>;
    revokeScopesByBinding(input: Partial<Pick<AgentOpsScopeInput, 'ownerMxid' | 'ownerDmRoomId' | 'projectRoomId' | 'stableAgentId'>>): number;
    private revokeDerivedAuthority;
    issueGrant(input: AgentOpsScopeInput & AgentOpsDeviceInput & {
        matrixEventId: string;
        clientNonce: string;
        clientPublicJwk: Readonly<Record<string, unknown>>;
        audience: string;
    }): AgentOpsResult<{
        replayed: boolean;
        grantJti: string;
        scopeId: string;
        projectionId: string;
        clientNonce: string;
        serverChallenge: string;
        audience: string;
        authFenceGeneration: number;
        expiresAtUnixMs: number;
    }>;
    grantProofDescriptor(input: {
        grantJti: string;
        clientNonce: string;
        serverChallenge: string;
        audience: string;
    }): AgentOpsResult<{
        clientPublicJwk: Readonly<Record<string, unknown>>;
        scopeId: string;
        authFenceGeneration: number;
    }>;
    exchangeGrant(input: {
        grantJti: string;
        clientNonce: string;
        serverChallenge: string;
        audience: string;
    }): AgentOpsResult<{
        clientSessionId: string;
        sessionCapability: string;
        scopeId: string;
        projectionId: string;
        streamEpoch: string;
        authFenceGeneration: number;
        expiresAtUnixMs: number;
    }>;
    sessionProofDescriptor(input: {
        clientSessionId: string;
        sessionCapability: string;
        audience: string;
    }): AgentOpsResult<{
        auth: AgentOpsAuthContext;
        clientPublicJwk: Readonly<Record<string, unknown>>;
    }>;
    consumeRequestNonce(input: AgentOpsAuthContext & {
        nonce: string;
        sessionCapability: string;
    }): AgentOpsResult<{
        consumed: true;
    }>;
    private liveSession;
    private pruneExpiredClientState;
    snapshot(auth: AgentOpsAuthContext): AgentOpsResult<{
        snapshot: Readonly<Record<string, unknown>>;
    }>;
    invalidation(auth: AgentOpsAuthContext, after: number): AgentOpsResult<{
        invalidation: Readonly<Record<string, unknown>> | null;
    }>;
    cancelDispatch(auth: AgentOpsAuthContext, command: AgentOpsCommandEnvelope): AgentOpsResult<{
        response: Readonly<Record<string, unknown>>;
        replayed: boolean;
    }>;
    markResourceInspected(auth: AgentOpsAuthContext, command: AgentOpsCommandEnvelope): AgentOpsResult<{
        response: Readonly<Record<string, unknown>>;
        replayed: boolean;
    }>;
    beginOutcomeInspection(auth: AgentOpsAuthContext, command: AgentOpsCommandEnvelope): AgentOpsResult<{
        response: Readonly<Record<string, unknown>>;
        replayed: boolean;
    }>;
    resolveOutcome(auth: AgentOpsAuthContext, command: AgentOpsCommandEnvelope & {
        inspection_id: string;
        inspection_token: string;
        operator_note: string;
        resolution: Readonly<Record<string, unknown>>;
    }): AgentOpsResult<{
        response: Readonly<Record<string, unknown>>;
        replayed: boolean;
    }>;
    private applyMutation;
    private normalizeCommand;
    private encodeAction;
    private decodeAction;
    private sealResponse;
    private unsealResponse;
    private dispatchInScope;
    private resourceInScope;
    private resourceScopeCount;
    private mapRouterRefusal;
}
export {};
