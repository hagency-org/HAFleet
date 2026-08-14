import type Database from 'better-sqlite3';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

import type { RouterStore } from './store.js';

export const AGENT_OPS_CONTRACT = 'com.hafleet.agent_ops.v1';
export const AGENT_OPS_ERROR_CODES = [
  'bad_request',
  'not_found',
  'feature_disabled',
  'device_enrollment_required',
  'device_mismatch',
  'scope_mismatch',
  'invalid_capability',
  'capability_expired',
  'capability_consumed',
  'auth_fence_stale',
  'idempotency_conflict',
  'precondition_failed',
  'inspection_required',
  'inspection_expired',
  'invalid_transition',
  'loopback_required',
  'host_mismatch',
  'browser_origin_forbidden',
  'internal_error',
] as const;
const JSON_SAFE_MAX = Number.MAX_SAFE_INTEGER;
const DEFAULT_GRANT_TTL_MS = 2 * 60_000;
const DEFAULT_SESSION_TTL_MS = 5 * 60_000;
const DEFAULT_ACTION_TTL_MS = 2 * 60_000;
const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60_000;
const MAX_REQUEST_NONCES_PER_SESSION = 10_000;
export const AGENT_OPS_LIMITS = Object.freeze({
  grant_ttl_ms: DEFAULT_GRANT_TTL_MS,
  grant_ttl_max_ms: 10 * 60_000,
  session_ttl_ms: DEFAULT_SESSION_TTL_MS,
  session_ttl_max_ms: 15 * 60_000,
  action_ttl_ms: DEFAULT_ACTION_TTL_MS,
  action_ttl_max_ms: 5 * 60_000,
  request_nonce_max_chars: 255,
  request_nonces_per_session: MAX_REQUEST_NONCES_PER_SESSION,
  action_capability_max_chars: 8192,
  request_body_max_bytes: 100 * 1024,
});

export type AgentOpsActionKind =
  | 'cancel_dispatch'
  | 'mark_resource_inspected'
  | 'begin_outcome_inspection'
  | 'resolve_outcome';
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

type AgentOpsResult<T extends Readonly<Record<string, unknown>>> = ({ ok: true } & T) | AgentOpsRefusal;

interface AgentOpsMetaRow {
  contract_schema: string;
  stream_epoch: string;
  action_hmac_key: Buffer;
  server_identity_fingerprint: string | null;
}

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

interface AgentOpsGrantRow {
  grant_jti: string;
  matrix_event_id: string;
  request_digest: string;
  scope_id: string;
  client_nonce: string;
  client_public_jwk_json: string;
  server_challenge: string;
  audience: string;
  auth_fence_generation: number;
  issued_at: number;
  expires_at: number;
  consumed_at: number | null;
  revoked_at: number | null;
}

interface AgentOpsSessionRow {
  client_session_id: string;
  scope_id: string;
  capability_hash: string;
  client_public_jwk_json: string;
  audience: string;
  auth_fence_generation: number;
  issued_at: number;
  expires_at: number;
  revoked_at: number | null;
}

interface AgentOpsIdempotencyRow {
  request_digest: string;
  action_kind: string;
  response_json: string;
}

interface ProjectionTaskRow {
  task_id: string;
  title: string;
  status: string;
  assignee_name: string | null;
  started_at: string | null;
  created_at: string;
  entity_version: number;
  room_id: string;
  thread_root_event_id: string;
  activation_state: string;
}

interface ProjectionDispatchRow {
  dispatch_id: string;
  session_id: string;
  task_id: string | null;
  state: string;
  workspace_resource_id: string | null;
  may_write: number;
  created_at: number;
  started_at: number | null;
  parked_at: number | null;
  settled_at: number | null;
  terminal_reason: string | null;
  entity_version: number;
  agent_name: string;
  room_id: string;
  thread_root_event_id: string | null;
}

interface ProjectionResourceRow {
  resource_id: string;
  safe_label: string;
  branch_name: string | null;
  dirty: number;
  dirty_reason: string | null;
  dirty_generation: number;
  dirty_dispatch_id: string | null;
  entity_version: number;
  task_id: string | null;
}

interface LeaseRow {
  resource_id: string;
  dispatch_id: string;
}

interface ActionPayload {
  v: 1;
  jti: string;
  client_session_id: string;
  scope_id: string;
  projection_id: string;
  stream_epoch: string;
  auth_fence_generation: number;
  snapshot_seq: number;
  action_kind: AgentOpsActionKind;
  target: AgentOpsTarget;
  resource_precondition: AgentOpsResourcePrecondition | null;
  allowed_resolutions: AgentOpsResolution[];
  expires_at_unix_ms: number;
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

function refusal(code: AgentOpsRefusal['code'], message: string): AgentOpsRefusal {
  return { ok: false, code, message };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      output[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return output;
  }
  return value;
}

export function agentOpsCanonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function agentOpsDigest(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : agentOpsCanonicalJson(value)).digest('hex');
}

function requiredText(value: unknown, field: string, max = 512): string {
  if (typeof value !== 'string') throw new Error(`${field} must be 1..${max} characters`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(`${field} must be 1..${max} characters`);
  return normalized;
}

function matrixCurveKey(value: unknown, field: string): string {
  const key = requiredText(value, field, 512);
  if (!/^[A-Za-z0-9+/]{43}=?$/.test(key) || Buffer.from(key, 'base64').length !== 32) {
    throw new Error(`${field} must be a Matrix base64 32-byte key`);
  }
  return key.replace(/=+$/u, '');
}

function strictEd25519Jwk(value: Readonly<Record<string, unknown>>): Readonly<Record<string, string>> {
  if (!exactKeys(value, ['kty', 'crv', 'x']) || value.kty !== 'OKP' || value.crv !== 'Ed25519') {
    throw new Error('client_public_jwk must contain exactly an Ed25519 kty, crv and x');
  }
  const x = requiredText(value.x, 'client_public_jwk.x', 128);
  if (!/^[A-Za-z0-9_-]{43}$/.test(x) || Buffer.from(x, 'base64url').length !== 32) {
    throw new Error('client_public_jwk.x must be unpadded base64url for 32 bytes');
  }
  return { kty: 'OKP', crv: 'Ed25519', x };
}

function safeInteger(value: unknown, field: string, { positive = false }: { positive?: boolean } = {}): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (positive && (value as number) === 0)) {
    throw new Error(`${field} must be ${positive ? 'a positive' : 'a non-negative'} JSON-safe integer`);
  }
  return value as number;
}

function scopeMaterial(input: AgentOpsScopeInput): Readonly<{
  owner_mxid: string;
  owner_dm_room_id: string;
  project_room_id: string;
  stable_agent_id: string;
}> {
  return {
    owner_mxid: requiredText(input.ownerMxid, 'owner_mxid', 255),
    owner_dm_room_id: requiredText(input.ownerDmRoomId, 'owner_dm_room_id', 255),
    project_room_id: requiredText(input.projectRoomId, 'project_room_id', 255),
    stable_agent_id: requiredText(input.stableAgentId, 'stable_agent_id', 255),
  };
}

export function agentOpsScopeId(input: AgentOpsScopeInput): string {
  return `scope_${agentOpsDigest(scopeMaterial(input))}`;
}

function projectionId(scopeId: string): string {
  return `projection_${agentOpsDigest({ contract: AGENT_OPS_CONTRACT, scope_id: scopeId }).slice(0, 48)}`;
}

function isRefusal(value: AgentOpsSessionRow | AgentOpsRefusal): value is AgentOpsRefusal {
  return 'ok' in value && value.ok === false;
}

function tokenHash(token: string): string {
  return agentOpsDigest(`agent-ops-token\0${token}`);
}

function equalText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function base64url(value: Buffer): string {
  return value.toString('base64url');
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('stored JSON is not an object');
  return parsed as Record<string, unknown>;
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function normalizeResolution(value: unknown): Readonly<Record<string, string>> {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('resolution must be an object');
  }
  const resolution = value as Readonly<Record<string, unknown>>;
  const kind = requiredText(resolution.kind, 'resolution.kind', 64);
  if (kind === 'continue') {
    if (!exactKeys(resolution, ['kind', 'recovery_instruction'])) {
      throw new Error('continue requires only kind and recovery_instruction');
    }
    return {
      kind,
      recovery_instruction: requiredText(resolution.recovery_instruction, 'resolution.recovery_instruction', 8_000),
    };
  }
  if (!['accept_completed', 'keep_blocked'].includes(kind) || !exactKeys(resolution, ['kind'])) {
    throw new Error('terminal resolution must contain only a supported kind');
  }
  return { kind };
}

function looksSensitive(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return true;
  if (/(?:^|[\s=:('"\[])(?:\/Users\/|\/home\/|\/var\/|\/tmp\/|~\/|[A-Za-z]:[\\/]|\\\\)/u.test(normalized)) return true;
  if (/(?:bearer|access[_-]?token|api[_-]?token|secret|password)\s*[:=]\s*\S+/iu.test(normalized)) return true;
  return false;
}

function privacyText(value: string | null | undefined, fallback: string): string {
  const normalized = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim() : '';
  if (!normalized || looksSensitive(normalized)) return fallback;
  return normalized.slice(0, 500);
}

function parseTimestamp(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function syntheticResourceId(dispatchId: string): string {
  return `dispatch_effect_${agentOpsDigest(dispatchId).slice(0, 40)}`;
}

export class AgentOpsService {
  private readonly router: RouterStore;
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly grantTtlMs: number;
  private readonly sessionTtlMs: number;
  private readonly actionTtlMs: number;

  constructor(router: RouterStore, options: {
    now?: () => number;
    grantTtlMs?: number;
    sessionTtlMs?: number;
    actionTtlMs?: number;
  } = {}) {
    this.router = router;
    this.db = router.db;
    this.now = options.now ?? Date.now;
    this.grantTtlMs = Math.max(30_000, Math.min(options.grantTtlMs ?? DEFAULT_GRANT_TTL_MS, 10 * 60_000));
    this.sessionTtlMs = Math.max(30_000, Math.min(options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS, 15 * 60_000));
    this.actionTtlMs = Math.max(15_000, Math.min(options.actionTtlMs ?? DEFAULT_ACTION_TTL_MS, 5 * 60_000));
    this.ensureMeta();
  }

  private ensureMeta(): void {
    const prior = this.db.prepare<[], AgentOpsMetaRow>('SELECT * FROM agent_ops_meta WHERE id = 1').get();
    if (prior) {
      if (prior.contract_schema !== AGENT_OPS_CONTRACT || prior.action_hmac_key.length !== 32) {
        throw new Error('agent operations metadata is incompatible');
      }
      return;
    }
    this.db.prepare<[string, string, Buffer, number]>(
      `INSERT INTO agent_ops_meta(id, contract_schema, stream_epoch, action_hmac_key, created_at)
       VALUES (1, ?, ?, ?, ?)`,
    ).run(AGENT_OPS_CONTRACT, randomUUID(), randomBytes(32), this.now());
  }

  private meta(): AgentOpsMetaRow {
    const row = this.db.prepare<[], AgentOpsMetaRow>('SELECT * FROM agent_ops_meta WHERE id = 1').get();
    if (!row) throw new Error('agent operations metadata is missing');
    return row;
  }

  bindServerIdentity(fingerprintInput: string): { rotated: boolean; revokedScopes: number } {
    const fingerprint = requiredText(fingerprintInput, 'server_identity_fingerprint', 255);
    const tx = this.db.transaction(() => {
      const meta = this.meta();
      if (meta.server_identity_fingerprint === fingerprint) return { rotated: false, revokedScopes: 0 };
      const scopes = this.db.prepare<[], Pick<AgentOpsScopeRow, 'scope_id' | 'auth_fence_generation'>>(
        'SELECT scope_id, auth_fence_generation FROM agent_ops_scopes',
      ).all();
      const now = this.now();
      for (const scope of scopes) {
        this.db.prepare<[number, number, string]>(
          'UPDATE agent_ops_scopes SET auth_fence_generation = ?, updated_at = ? WHERE scope_id = ?',
        ).run(scope.auth_fence_generation + 1, now, scope.scope_id);
        this.revokeDerivedAuthority(scope.scope_id, now);
      }
      this.db.prepare<[string]>('UPDATE agent_ops_meta SET server_identity_fingerprint = ? WHERE id = 1')
        .run(fingerprint);
      return { rotated: meta.server_identity_fingerprint !== null, revokedScopes: scopes.length };
    });
    return tx();
  }

  scope(scopeId: string): AgentOpsScopeRow | null {
    return this.db.prepare<[string], AgentOpsScopeRow>(
      'SELECT * FROM agent_ops_scopes WHERE scope_id = ?',
    ).get(scopeId) ?? null;
  }

  enrollDevice(input: AgentOpsScopeInput & AgentOpsDeviceInput): AgentOpsResult<{
    replayed: boolean;
    scopeId: string;
    projectionId: string;
    authFenceGeneration: number;
  }> {
    try {
      const material = scopeMaterial(input);
      const agentName = requiredText(input.agentName, 'agent_name', 255);
      const deviceId = requiredText(input.matrixDeviceId, 'matrix_device_id', 255);
      const ed25519 = matrixCurveKey(input.matrixDeviceEd25519, 'matrix_device_ed25519');
      const curve25519 = matrixCurveKey(input.matrixDeviceCurve25519, 'matrix_device_curve25519');
      const scopeId = agentOpsScopeId(input);
      const tx = this.db.transaction(() => {
        const prior = this.scope(scopeId);
        const now = this.now();
        if (!prior) {
          const projection = projectionId(scopeId);
          this.db.prepare<[
            string, string, string, string, string, string, string, string, string, string, number, number,
          ]>(`INSERT INTO agent_ops_scopes(
            scope_id, owner_mxid, owner_dm_room_id, project_room_id, stable_agent_id,
            agent_name, projection_id, matrix_device_id, matrix_device_ed25519,
            matrix_device_curve25519, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            scopeId,
            material.owner_mxid,
            material.owner_dm_room_id,
            material.project_room_id,
            material.stable_agent_id,
            agentName,
            projection,
            deviceId,
            ed25519,
            curve25519,
            now,
            now,
          );
          return { ok: true as const, replayed: false, scopeId, projectionId: projection, authFenceGeneration: 1 };
        }
        const sameDevice = prior.matrix_device_id === deviceId
          && prior.matrix_device_ed25519 === ed25519
          && prior.matrix_device_curve25519 === curve25519;
        if (sameDevice) {
          if (prior.agent_name !== agentName) {
            this.db.prepare<[string, number, string]>(
              'UPDATE agent_ops_scopes SET agent_name = ?, updated_at = ? WHERE scope_id = ?',
            ).run(agentName, now, scopeId);
          }
          return {
            ok: true as const,
            replayed: true,
            scopeId,
            projectionId: prior.projection_id,
            authFenceGeneration: prior.auth_fence_generation,
          };
        }
        const nextFence = prior.auth_fence_generation + 1;
        this.db.prepare<[string, string, string, string, number, number, string]>(
          `UPDATE agent_ops_scopes SET agent_name = ?, matrix_device_id = ?,
           matrix_device_ed25519 = ?, matrix_device_curve25519 = ?,
           auth_fence_generation = ?, updated_at = ? WHERE scope_id = ?`,
        ).run(agentName, deviceId, ed25519, curve25519, nextFence, now, scopeId);
        this.revokeDerivedAuthority(scopeId, now);
        return {
          ok: true as const,
          replayed: false,
          scopeId,
          projectionId: prior.projection_id,
          authFenceGeneration: nextFence,
        };
      });
      return tx();
    } catch (error) {
      return refusal('bad_request', error instanceof Error ? error.message : String(error));
    }
  }

  revokeScope(scopeIdInput: string, clearDevice = false): AgentOpsResult<{
    scopeId: string;
    authFenceGeneration: number;
  }> {
    try {
      const scopeId = requiredText(scopeIdInput, 'scope_id', 255);
      const tx = this.db.transaction(() => {
        const scope = this.scope(scopeId);
        if (!scope) return refusal('not_found', 'agent operations scope not found');
        const now = this.now();
        const nextFence = scope.auth_fence_generation + 1;
        if (clearDevice) {
          this.db.prepare<[number, number, string]>(
            `UPDATE agent_ops_scopes SET matrix_device_id = NULL, matrix_device_ed25519 = NULL,
             matrix_device_curve25519 = NULL, auth_fence_generation = ?, updated_at = ? WHERE scope_id = ?`,
          ).run(nextFence, now, scopeId);
        } else {
          this.db.prepare<[number, number, string]>(
            'UPDATE agent_ops_scopes SET auth_fence_generation = ?, updated_at = ? WHERE scope_id = ?',
          ).run(nextFence, now, scopeId);
        }
        this.revokeDerivedAuthority(scopeId, now);
        return { ok: true as const, scopeId, authFenceGeneration: nextFence };
      });
      return tx();
    } catch (error) {
      return refusal('bad_request', error instanceof Error ? error.message : String(error));
    }
  }

  revokeScopesByBinding(input: Partial<Pick<AgentOpsScopeInput, 'ownerMxid' | 'ownerDmRoomId' | 'projectRoomId' | 'stableAgentId'>>): number {
    const clauses: string[] = [];
    const values: string[] = [];
    if (input.ownerMxid) { clauses.push('owner_mxid = ?'); values.push(input.ownerMxid); }
    if (input.ownerDmRoomId) { clauses.push('owner_dm_room_id = ?'); values.push(input.ownerDmRoomId); }
    if (input.projectRoomId) { clauses.push('project_room_id = ?'); values.push(input.projectRoomId); }
    if (input.stableAgentId) { clauses.push('stable_agent_id = ?'); values.push(input.stableAgentId); }
    if (clauses.length === 0) return 0;
    const rows = this.db.prepare<string[], Pick<AgentOpsScopeRow, 'scope_id'>>(
      `SELECT scope_id FROM agent_ops_scopes WHERE ${clauses.join(' AND ')}`,
    ).all(...values);
    for (const row of rows) this.revokeScope(row.scope_id);
    return rows.length;
  }

  private revokeDerivedAuthority(scopeId: string, now: number): void {
    this.db.prepare<[number, string]>('UPDATE agent_ops_grants SET revoked_at = ? WHERE scope_id = ? AND revoked_at IS NULL')
      .run(now, scopeId);
    this.db.prepare<[number, string]>('UPDATE agent_ops_sessions SET revoked_at = ? WHERE scope_id = ? AND revoked_at IS NULL')
      .run(now, scopeId);
  }

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
  }> {
    try {
      const scopeId = agentOpsScopeId(input);
      const matrixEventId = requiredText(input.matrixEventId, 'matrix_event_id', 255);
      const clientNonce = requiredText(input.clientNonce, 'client_nonce', 255);
      const audience = requiredText(input.audience, 'audience', 512);
      const parsedJwk = strictEd25519Jwk(input.clientPublicJwk);
      const clientPublicJwkJson = agentOpsCanonicalJson(parsedJwk);
      const requestDigest = agentOpsDigest({
        scope: scopeMaterial(input),
        matrix_device_id: input.matrixDeviceId,
        matrix_device_ed25519: input.matrixDeviceEd25519,
        matrix_device_curve25519: input.matrixDeviceCurve25519,
        matrix_event_id: matrixEventId,
        client_nonce: clientNonce,
        client_public_jwk: parsedJwk,
        audience,
      });
      const tx = this.db.transaction(() => {
        const scope = this.scope(scopeId);
        if (!scope || !scope.matrix_device_id || !scope.matrix_device_ed25519 || !scope.matrix_device_curve25519) {
          return refusal('device_enrollment_required', 'operator device enrollment is required for this scope');
        }
        if (
          scope.matrix_device_id !== requiredText(input.matrixDeviceId, 'matrix_device_id', 255)
          || scope.matrix_device_ed25519 !== matrixCurveKey(input.matrixDeviceEd25519, 'matrix_device_ed25519')
          || scope.matrix_device_curve25519 !== matrixCurveKey(input.matrixDeviceCurve25519, 'matrix_device_curve25519')
        ) {
          return refusal('device_mismatch', 'Matrix device does not match the enrolled scope device');
        }
        const prior = this.db.prepare<[string], AgentOpsGrantRow>(
          'SELECT * FROM agent_ops_grants WHERE matrix_event_id = ?',
        ).get(matrixEventId);
        if (prior) {
          if (prior.request_digest !== requestDigest || prior.scope_id !== scopeId) {
            return refusal('idempotency_conflict', 'Matrix bootstrap event id was reused with different content');
          }
          if (prior.revoked_at !== null || prior.expires_at < this.now()) {
            return refusal('capability_expired', 'bootstrap grant is no longer valid');
          }
          return {
            ok: true as const,
            replayed: true,
            grantJti: prior.grant_jti,
            scopeId,
            projectionId: scope.projection_id,
            clientNonce: prior.client_nonce,
            serverChallenge: prior.server_challenge,
            audience: prior.audience,
            authFenceGeneration: prior.auth_fence_generation,
            expiresAtUnixMs: prior.expires_at,
          };
        }
        const now = this.now();
        const grantJti = randomUUID();
        const challenge = base64url(randomBytes(32));
        const expiresAt = now + this.grantTtlMs;
        this.db.prepare<[
          string, string, string, string, string, string, string, string, number, number, number,
        ]>(`INSERT INTO agent_ops_grants(
          grant_jti, matrix_event_id, request_digest, scope_id, client_nonce,
          client_public_jwk_json, server_challenge, audience,
          auth_fence_generation, issued_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          grantJti,
          matrixEventId,
          requestDigest,
          scopeId,
          clientNonce,
          clientPublicJwkJson,
          challenge,
          audience,
          scope.auth_fence_generation,
          now,
          expiresAt,
        );
        return {
          ok: true as const,
          replayed: false,
          grantJti,
          scopeId,
          projectionId: scope.projection_id,
          clientNonce,
          serverChallenge: challenge,
          audience,
          authFenceGeneration: scope.auth_fence_generation,
          expiresAtUnixMs: expiresAt,
        };
      });
      return tx();
    } catch (error) {
      return refusal('bad_request', error instanceof Error ? error.message : String(error));
    }
  }

  grantProofDescriptor(input: {
    grantJti: string;
    clientNonce: string;
    serverChallenge: string;
    audience: string;
  }): AgentOpsResult<{
    clientPublicJwk: Readonly<Record<string, unknown>>;
    scopeId: string;
    authFenceGeneration: number;
  }> {
    try {
      const grantJti = requiredText(input.grantJti, 'grant_jti', 255);
      const row = this.db.prepare<[string], AgentOpsGrantRow>('SELECT * FROM agent_ops_grants WHERE grant_jti = ?').get(grantJti);
      if (!row) return refusal('invalid_capability', 'bootstrap grant was not found');
      const scope = this.scope(row.scope_id);
      if (!scope || scope.auth_fence_generation !== row.auth_fence_generation) {
        return refusal('auth_fence_stale', 'bootstrap grant was revoked by a scope change');
      }
      if (row.revoked_at !== null || row.consumed_at !== null) return refusal('capability_consumed', 'bootstrap grant was consumed or revoked');
      if (row.expires_at < this.now()) return refusal('capability_expired', 'bootstrap grant expired');
      if (
        row.client_nonce !== input.clientNonce
        || row.server_challenge !== input.serverChallenge
        || row.audience !== input.audience
      ) return refusal('scope_mismatch', 'bootstrap exchange fields do not match the grant');
      return {
        ok: true,
        clientPublicJwk: parseJsonObject(row.client_public_jwk_json),
        scopeId: row.scope_id,
        authFenceGeneration: row.auth_fence_generation,
      };
    } catch (error) {
      return refusal('bad_request', error instanceof Error ? error.message : String(error));
    }
  }

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
  }> {
    try {
      const grantJti = requiredText(input.grantJti, 'grant_jti', 255);
      const tx = this.db.transaction(() => {
        this.pruneExpiredClientState(this.now());
        const row = this.db.prepare<[string], AgentOpsGrantRow>('SELECT * FROM agent_ops_grants WHERE grant_jti = ?').get(grantJti);
        if (!row) return refusal('invalid_capability', 'bootstrap grant was not found');
        const scope = this.scope(row.scope_id);
        if (!scope || scope.auth_fence_generation !== row.auth_fence_generation) {
          return refusal('auth_fence_stale', 'bootstrap grant was revoked by a scope change');
        }
        const now = this.now();
        if (row.revoked_at !== null || row.consumed_at !== null) return refusal('capability_consumed', 'bootstrap grant was consumed or revoked');
        if (row.expires_at < now) return refusal('capability_expired', 'bootstrap grant expired');
        if (
          row.client_nonce !== input.clientNonce
          || row.server_challenge !== input.serverChallenge
          || row.audience !== input.audience
        ) return refusal('scope_mismatch', 'bootstrap exchange fields do not match the grant');
        const clientSessionId = randomUUID();
        const capability = base64url(randomBytes(32));
        const expiresAt = now + this.sessionTtlMs;
        const consumed = this.db.prepare<[number, string]>(
          'UPDATE agent_ops_grants SET consumed_at = ? WHERE grant_jti = ? AND consumed_at IS NULL AND revoked_at IS NULL',
        ).run(now, grantJti);
        if (consumed.changes !== 1) return refusal('capability_consumed', 'bootstrap grant was already consumed');
        this.db.prepare<[string, string, string, string, string, number, number, number]>(
          `INSERT INTO agent_ops_sessions(
            client_session_id, scope_id, capability_hash, client_public_jwk_json,
            audience, auth_fence_generation, issued_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          clientSessionId,
          row.scope_id,
          tokenHash(capability),
          row.client_public_jwk_json,
          row.audience,
          row.auth_fence_generation,
          now,
          expiresAt,
        );
        return {
          ok: true as const,
          clientSessionId,
          sessionCapability: capability,
          scopeId: row.scope_id,
          projectionId: scope.projection_id,
          streamEpoch: this.meta().stream_epoch,
          authFenceGeneration: row.auth_fence_generation,
          expiresAtUnixMs: expiresAt,
        };
      });
      return tx();
    } catch (error) {
      return refusal('bad_request', error instanceof Error ? error.message : String(error));
    }
  }

  sessionProofDescriptor(input: {
    clientSessionId: string;
    sessionCapability: string;
    audience: string;
  }): AgentOpsResult<{
    auth: AgentOpsAuthContext;
    clientPublicJwk: Readonly<Record<string, unknown>>;
  }> {
    try {
      const session = this.liveSession(input.clientSessionId, input.sessionCapability);
      if (isRefusal(session)) return session;
      if (!equalText(session.audience, input.audience)) return refusal('scope_mismatch', 'client audience does not match the session');
      return {
        ok: true,
        auth: {
          clientSessionId: session.client_session_id,
          scopeId: session.scope_id,
          authFenceGeneration: session.auth_fence_generation,
          audience: session.audience,
        },
        clientPublicJwk: parseJsonObject(session.client_public_jwk_json),
      };
    } catch (error) {
      return refusal('bad_request', error instanceof Error ? error.message : String(error));
    }
  }

  consumeRequestNonce(input: AgentOpsAuthContext & { nonce: string; sessionCapability: string }): AgentOpsResult<{ consumed: true }> {
    try {
      const nonce = requiredText(input.nonce, 'proof_nonce', 255);
      const tx = this.db.transaction(() => {
        const session = this.liveSession(input.clientSessionId, input.sessionCapability);
        if (isRefusal(session)) return session;
        if (session.scope_id !== input.scopeId || session.auth_fence_generation !== input.authFenceGeneration) {
          return refusal('auth_fence_stale', 'client session scope or fence changed');
        }
        const nonceCount = this.db.prepare<[string], { count: number }>(
          'SELECT COUNT(*) AS count FROM agent_ops_request_nonces WHERE client_session_id = ?',
        ).get(input.clientSessionId)?.count ?? 0;
        if (nonceCount >= MAX_REQUEST_NONCES_PER_SESSION) {
          this.db.prepare<[number, string]>(
            'UPDATE agent_ops_sessions SET revoked_at = ? WHERE client_session_id = ? AND revoked_at IS NULL',
          ).run(this.now(), input.clientSessionId);
          return refusal('capability_consumed', 'client session request nonce budget was exhausted');
        }
        try {
          this.db.prepare<[string, string, number]>(
            'INSERT INTO agent_ops_request_nonces(client_session_id, nonce, consumed_at) VALUES (?, ?, ?)',
          ).run(input.clientSessionId, nonce, this.now());
        } catch (error) {
          if (String(error).includes('UNIQUE constraint failed')) return refusal('capability_consumed', 'request proof nonce was already consumed');
          throw error;
        }
        return { ok: true as const, consumed: true as const };
      });
      return tx();
    } catch (error) {
      return refusal('bad_request', error instanceof Error ? error.message : String(error));
    }
  }

  private liveSession(clientSessionIdInput: string, capabilityInput: string): AgentOpsSessionRow | AgentOpsRefusal {
    const clientSessionId = requiredText(clientSessionIdInput, 'client_session_id', 255);
    const capability = requiredText(capabilityInput, 'session_capability', 512);
    const row = this.db.prepare<[string], AgentOpsSessionRow>(
      'SELECT * FROM agent_ops_sessions WHERE client_session_id = ?',
    ).get(clientSessionId);
    if (!row || !equalText(row.capability_hash, tokenHash(capability))) return refusal('invalid_capability', 'client session capability is invalid');
    if (row.revoked_at !== null) return refusal('auth_fence_stale', 'client session was revoked');
    if (row.expires_at < this.now()) return refusal('capability_expired', 'client session expired');
    const scope = this.scope(row.scope_id);
    if (!scope || scope.auth_fence_generation !== row.auth_fence_generation) return refusal('auth_fence_stale', 'client session auth fence is stale');
    return row;
  }

  private pruneExpiredClientState(now: number): void {
    this.db.prepare<[number]>('DELETE FROM agent_ops_action_uses WHERE consumed_at < ?')
      .run(now - IDEMPOTENCY_RETENTION_MS);
    this.db.prepare<[number]>('DELETE FROM agent_ops_idempotency WHERE created_at < ?')
      .run(now - IDEMPOTENCY_RETENTION_MS);
    this.db.prepare<[number]>(
      `DELETE FROM agent_ops_sessions WHERE expires_at < ?
       AND NOT EXISTS (
         SELECT 1 FROM agent_ops_action_uses uses
         WHERE uses.client_session_id = agent_ops_sessions.client_session_id
       )`,
    ).run(now);
  }

  snapshot(auth: AgentOpsAuthContext): AgentOpsResult<{ snapshot: Readonly<Record<string, unknown>> }> {
    const tx = this.db.transaction(() => {
      const session = this.db.prepare<[string], AgentOpsSessionRow>(
        'SELECT * FROM agent_ops_sessions WHERE client_session_id = ?',
      ).get(auth.clientSessionId);
      const scope = this.scope(auth.scopeId);
      if (!session || !scope || session.revoked_at !== null || session.expires_at < this.now()) {
        return refusal('invalid_capability', 'client session is no longer live');
      }
      if (
        session.scope_id !== scope.scope_id
        || session.auth_fence_generation !== scope.auth_fence_generation
        || auth.authFenceGeneration !== scope.auth_fence_generation
      ) return refusal('auth_fence_stale', 'projection auth fence is stale');
      const meta = this.meta();
      const eventMeta = this.db.prepare<[], { high_watermark: number }>(
        'SELECT high_watermark FROM router_event_meta WHERE id = 1',
      ).get();
      const seq = safeInteger(eventMeta?.high_watermark ?? 0, 'seq');
      const tasks = this.db.prepare<[string, string], ProjectionTaskRow>(
        `SELECT t.*, b.room_id, b.thread_root_event_id, b.activation_state
         FROM tasks t JOIN task_bindings b ON b.task_id = t.task_id
         WHERE b.assignee_agent_id = ? AND b.room_id = ?
         ORDER BY t.updated_at DESC, t.task_id`,
      ).all(scope.stable_agent_id, scope.project_room_id);
      const dispatches = this.db.prepare<[string, string], ProjectionDispatchRow>(
        `SELECT d.*, s.agent_name, s.room_id, s.thread_root_event_id
         FROM dispatches d JOIN sessions s ON s.session_id = d.session_id
         WHERE s.agent_id = ? AND s.room_id = ?
         ORDER BY d.created_at DESC, d.dispatch_id`,
      ).all(scope.stable_agent_id, scope.project_room_id);
      const resources = this.db.prepare<[string, string], ProjectionResourceRow>(
        `SELECT r.*, d.task_id
         FROM resources r JOIN dispatches d ON d.workspace_resource_id = r.resource_id
         JOIN sessions s ON s.session_id = d.session_id
         WHERE s.agent_id = ? AND s.room_id = ?
           AND d.dispatch_id = (
             SELECT d2.dispatch_id FROM dispatches d2
             JOIN sessions s2 ON s2.session_id = d2.session_id
             WHERE d2.workspace_resource_id = r.resource_id
               AND s2.agent_id = s.agent_id AND s2.room_id = s.room_id
             ORDER BY d2.created_at DESC, d2.dispatch_id DESC LIMIT 1
           )
         ORDER BY r.safe_label, r.resource_id`,
      ).all(scope.stable_agent_id, scope.project_room_id);
      const leases = this.db.prepare<[], LeaseRow>('SELECT resource_id, dispatch_id FROM resource_leases').all();
      const leaseByResource = new Map(leases.map((row) => [row.resource_id, row.dispatch_id]));
      const dispatchById = new Map(dispatches.map((row) => [row.dispatch_id, row]));
      const taskById = new Map(tasks.map((row) => [row.task_id, row]));
      const resourceById = new Map(resources.map((row) => [row.resource_id, row]));

      const availableAction = (
        actionKind: AgentOpsActionKind,
        target: AgentOpsTarget,
        resource: AgentOpsResourcePrecondition | null,
        allowed: AgentOpsResolution[] = [],
      ): Readonly<Record<string, unknown>> => {
        const expiresAt = this.now() + this.actionTtlMs;
        const payload: ActionPayload = {
          v: 1,
          jti: randomUUID(),
          client_session_id: auth.clientSessionId,
          scope_id: scope.scope_id,
          projection_id: scope.projection_id,
          stream_epoch: meta.stream_epoch,
          auth_fence_generation: scope.auth_fence_generation,
          snapshot_seq: seq,
          action_kind: actionKind,
          target,
          resource_precondition: resource,
          allowed_resolutions: allowed,
          expires_at_unix_ms: expiresAt,
        };
        return {
          action_id: payload.jti,
          kind: actionKind,
          target,
          ...(resource ? { resource_precondition: resource } : {}),
          ...(allowed.length > 0 ? { allowed_resolutions: allowed } : {}),
          expires_at_unix_ms: expiresAt,
          capability: this.encodeAction(payload),
        };
      };

      const threadFor = (dispatch: ProjectionDispatchRow | undefined, task: ProjectionTaskRow | undefined): Readonly<Record<string, string>> | undefined => {
        const room = dispatch?.room_id ?? task?.room_id;
        const root = dispatch?.thread_root_event_id ?? task?.thread_root_event_id;
        return room && root ? { room_id: room, thread_root_event_id: root } : undefined;
      };

      const taskRows = tasks.map((task) => {
        const dispatch = dispatches.find((candidate) => candidate.task_id === task.task_id);
        const start = task.started_at ? parseTimestamp(task.started_at, parseTimestamp(task.created_at, this.now())) : parseTimestamp(task.created_at, this.now());
        return {
          task_id: task.task_id,
          entity_version: task.entity_version,
          title: privacyText(task.title, 'Task details redacted'),
          agent: privacyText(task.assignee_name, scope.agent_name),
          state: privacyText(task.status, 'unknown'),
          ...(dispatch ? { dispatch_state: dispatch.state } : {}),
          elapsed_ms: Math.max(0, this.now() - start),
          thread: { room_id: task.room_id, thread_root_event_id: task.thread_root_event_id },
        };
      });

      const queue = dispatches
        .filter((row) => ['queued', 'leased', 'started', 'parked'].includes(row.state))
        .map((row) => {
          const heldBy = row.workspace_resource_id ? leaseByResource.get(row.workspace_resource_id) : undefined;
          const waiting = row.state === 'parked'
            ? 'waiting for owner approval'
            : heldBy && heldBy !== row.dispatch_id
              ? 'waiting for workspace lease'
              : row.state === 'queued'
                ? 'waiting for runner capacity'
                : 'runner active';
          return {
            dispatch_id: row.dispatch_id,
            entity_version: row.entity_version,
            ...(row.task_id ? { task_id: row.task_id } : {}),
            agent: privacyText(row.agent_name, scope.agent_name),
            state: row.state,
            waiting_on: waiting,
            ...(heldBy && heldBy !== row.dispatch_id && dispatchById.has(heldBy)
              ? { held_by_dispatch_id: heldBy }
              : {}),
            ...(row.state === 'parked' ? { attention_kind: 'parked_approval' } : {}),
          };
        });

      const worktrees = resources.map((row) => {
        const target: AgentOpsTarget = { entity_kind: 'resource', entity_id: row.resource_id, entity_version: row.entity_version };
        const precondition = { resource_id: row.resource_id, dirty_generation: row.dirty_generation };
        const actions = row.dirty === 1 && row.dirty_dispatch_id === null && this.resourceScopeCount(row.resource_id) === 1
          ? [availableAction('mark_resource_inspected', target, precondition)]
          : [];
        return {
          resource_id: row.resource_id,
          entity_version: row.entity_version,
          label: privacyText(row.safe_label, 'Workspace'),
          branch: privacyText(row.branch_name, 'not applicable'),
          dirty: row.dirty === 1,
          dirty_generation: row.dirty_generation,
          ...(row.task_id ? { task_id: row.task_id } : {}),
          available_actions: actions,
        };
      });

      const attention: Readonly<Record<string, unknown>>[] = [];
      for (const row of dispatches) {
        const task = row.task_id ? taskById.get(row.task_id) : undefined;
        const resource = row.workspace_resource_id ? resourceById.get(row.workspace_resource_id) : undefined;
        if (row.state === 'outcome_unknown') {
          const resolved = this.db.prepare<[string], { found: number }>(
            'SELECT 1 AS found FROM outcome_resolutions WHERE dispatch_id = ?',
          ).get(row.dispatch_id);
          if (resolved) continue;
          const target: AgentOpsTarget = { entity_kind: 'dispatch', entity_id: row.dispatch_id, entity_version: row.entity_version };
          const precondition = resource
            ? { resource_id: resource.resource_id, dirty_generation: resource.dirty_generation }
            : { resource_id: syntheticResourceId(row.dispatch_id), dirty_generation: 0 };
          attention.push({
            id: `outcome_unknown:${row.dispatch_id}`,
            kind: 'outcome_unknown',
            summary: 'Runner outcome is unknown; inspect the result before choosing recovery',
            ...(row.task_id ? { task_id: row.task_id } : {}),
            dispatch_id: row.dispatch_id,
            resource_id: precondition.resource_id,
            agent: privacyText(row.agent_name, scope.agent_name),
            waiting_ms: Math.max(0, this.now() - (row.settled_at ?? row.created_at)),
            ...(threadFor(row, task) ? { thread: threadFor(row, task) } : {}),
            available_actions: [availableAction('begin_outcome_inspection', target, precondition)],
          });
        } else if (row.state === 'parked') {
          const target: AgentOpsTarget = { entity_kind: 'dispatch', entity_id: row.dispatch_id, entity_version: row.entity_version };
          attention.push({
            id: `parked:${row.dispatch_id}`,
            kind: 'parked_approval',
            summary: 'Runner is waiting for an owner decision in the encrypted approval room',
            ...(row.task_id ? { task_id: row.task_id } : {}),
            dispatch_id: row.dispatch_id,
            ...(row.workspace_resource_id ? { resource_id: row.workspace_resource_id } : {}),
            agent: privacyText(row.agent_name, scope.agent_name),
            waiting_ms: Math.max(0, this.now() - (row.parked_at ?? row.created_at)),
            ...(threadFor(row, task) ? { thread: threadFor(row, task) } : {}),
            available_actions: [availableAction('cancel_dispatch', target, null)],
          });
        }
      }
      for (const task of tasks.filter((row) => row.activation_state === 'thread_delivery_failed')) {
        attention.push({
          id: `thread_delivery_failed:${task.task_id}`,
          kind: 'thread_delivery_failed',
          summary: 'Task thread could not be created; no runner was dispatched',
          task_id: task.task_id,
          agent: privacyText(task.assignee_name, scope.agent_name),
          thread: { room_id: task.room_id, thread_root_event_id: task.thread_root_event_id },
          available_actions: [],
        });
      }
      for (const resource of resources.filter((row) => row.dirty === 1)) {
        if (resource.dirty_dispatch_id && dispatchById.get(resource.dirty_dispatch_id)?.state === 'outcome_unknown') continue;
        const target: AgentOpsTarget = { entity_kind: 'resource', entity_id: resource.resource_id, entity_version: resource.entity_version };
        const precondition = { resource_id: resource.resource_id, dirty_generation: resource.dirty_generation };
        attention.push({
          id: `workspace_dirty:${resource.resource_id}`,
          kind: 'workspace_dirty',
          summary: 'Released workspace is marked dirty and needs human inspection',
          ...(resource.task_id ? { task_id: resource.task_id } : {}),
          resource_id: resource.resource_id,
          available_actions: resource.dirty_dispatch_id === null
            && this.resourceScopeCount(resource.resource_id) === 1
            ? [availableAction('mark_resource_inspected', target, precondition)]
            : [],
        });
      }

      const snapshot = {
        schema: AGENT_OPS_CONTRACT,
        scope: {
          scope_id: scope.scope_id,
          project_room_id: scope.project_room_id,
          agent_id: scope.stable_agent_id,
          owner_mxid: scope.owner_mxid,
          owner_dm_room_id: scope.owner_dm_room_id,
        },
        projection_id: scope.projection_id,
        stream_epoch: meta.stream_epoch,
        auth_fence_generation: scope.auth_fence_generation,
        seq,
        attention,
        tasks: taskRows,
        queue,
        worktrees,
      };
      return { ok: true as const, snapshot };
    });
    return tx();
  }

  invalidation(auth: AgentOpsAuthContext, after: number): AgentOpsResult<{ invalidation: Readonly<Record<string, unknown>> | null }> {
    const snapshot = this.snapshot(auth);
    if (!snapshot.ok) return snapshot;
    const seq = safeInteger(snapshot.snapshot.seq, 'snapshot.seq');
    return {
      ok: true,
      invalidation: seq > after ? {
        schema: AGENT_OPS_CONTRACT,
        scope_id: auth.scopeId,
        projection_id: snapshot.snapshot.projection_id,
        stream_epoch: snapshot.snapshot.stream_epoch,
        auth_fence_generation: snapshot.snapshot.auth_fence_generation,
        seq,
      } : null,
    };
  }

  cancelDispatch(auth: AgentOpsAuthContext, command: AgentOpsCommandEnvelope): AgentOpsResult<{ response: Readonly<Record<string, unknown>>; replayed: boolean }> {
    return this.applyMutation(auth, command, 'cancel_dispatch', (payload) => {
      const row = this.dispatchInScope(auth.scopeId, payload.target.entity_id);
      if (!row) return refusal('not_found', 'dispatch is outside the authorized scope or does not exist');
      if (row.entity_version !== payload.target.entity_version) return refusal('precondition_failed', 'dispatch entity version changed');
      const result = ['queued', 'leased'].includes(row.state)
        ? this.router.cancelBeforeStart(row.dispatch_id, 'agent_ops_client_cancelled_before_start')
        : ['started', 'parked'].includes(row.state)
          ? this.router.markOutcomeUnknown(row.dispatch_id, 'agent_ops_client_cancelled_after_start')
          : refusal('invalid_transition', `dispatch is already terminal: ${row.state}`);
      if (!result.ok) return this.mapRouterRefusal(result.code, result.message);
      return { ok: true as const, response: { schema: AGENT_OPS_CONTRACT, dispatch_id: row.dispatch_id, state: result.state } };
    });
  }

  markResourceInspected(auth: AgentOpsAuthContext, command: AgentOpsCommandEnvelope): AgentOpsResult<{ response: Readonly<Record<string, unknown>>; replayed: boolean }> {
    return this.applyMutation(auth, command, 'mark_resource_inspected', (payload) => {
      if (!payload.resource_precondition) return refusal('bad_request', 'resource precondition is required');
      const row = this.resourceInScope(auth.scopeId, payload.target.entity_id);
      if (!row) return refusal('not_found', 'resource is outside the authorized scope or does not exist');
      if (row.dirty_dispatch_id) return refusal('inspection_required', 'outcome_unknown quarantine requires dispatch inspection');
      if (this.resourceScopeCount(row.resource_id) !== 1) {
        return refusal('scope_mismatch', 'shared resource inspection requires the Dashboard operator boundary');
      }
      if (row.entity_version !== payload.target.entity_version || row.dirty_generation !== payload.resource_precondition.dirty_generation) {
        return refusal('precondition_failed', 'resource version or dirty generation changed');
      }
      const result = this.router.clearWorkspaceDirty(row.resource_id);
      if (!result.ok) return this.mapRouterRefusal(result.code, result.message);
      return { ok: true as const, response: { schema: AGENT_OPS_CONTRACT, resource_id: row.resource_id, inspected: true } };
    });
  }

  beginOutcomeInspection(auth: AgentOpsAuthContext, command: AgentOpsCommandEnvelope): AgentOpsResult<{ response: Readonly<Record<string, unknown>>; replayed: boolean }> {
    return this.applyMutation(auth, command, 'begin_outcome_inspection', (payload) => {
      if (!payload.resource_precondition) return refusal('bad_request', 'resource precondition is required');
      const row = this.dispatchInScope(auth.scopeId, payload.target.entity_id);
      if (!row) return refusal('not_found', 'dispatch is outside the authorized scope or does not exist');
      if (row.entity_version !== payload.target.entity_version) return refusal('precondition_failed', 'dispatch entity version changed');
      const realResource = row.workspace_resource_id ? this.resourceInScope(auth.scopeId, row.workspace_resource_id) : null;
      if (realResource) {
        if (
          payload.resource_precondition.resource_id !== realResource.resource_id
          || payload.resource_precondition.dirty_generation !== realResource.dirty_generation
        ) return refusal('precondition_failed', 'resource dirty generation changed');
      } else if (
        payload.resource_precondition.resource_id !== syntheticResourceId(row.dispatch_id)
        || payload.resource_precondition.dirty_generation !== 0
      ) return refusal('precondition_failed', 'non-writing dispatch effect precondition changed');
      const result = this.router.beginOutcomeInspection(row.dispatch_id);
      if (!result.ok) return this.mapRouterRefusal(result.code, result.message);
      const scope = this.scope(auth.scopeId);
      if (!scope) return refusal('scope_mismatch', 'client scope no longer exists');
      const meta = this.meta();
      const eventMeta = this.db.prepare<[], { high_watermark: number }>('SELECT high_watermark FROM router_event_meta WHERE id = 1').get();
      const snapshotSeq = eventMeta?.high_watermark ?? payload.snapshot_seq;
      const current = this.dispatchInScope(auth.scopeId, row.dispatch_id);
      if (!current) return refusal('not_found', 'dispatch disappeared during inspection');
      const allowed: AgentOpsResolution[] = current.task_id
        ? ['continue', 'accept_completed', 'keep_blocked']
        : ['continue'];
      const resolutionPayload: ActionPayload = {
        v: 1,
        jti: randomUUID(),
        client_session_id: auth.clientSessionId,
        scope_id: auth.scopeId,
        projection_id: scope.projection_id,
        stream_epoch: meta.stream_epoch,
        auth_fence_generation: scope.auth_fence_generation,
        snapshot_seq: snapshotSeq,
        action_kind: 'resolve_outcome',
        target: { entity_kind: 'dispatch', entity_id: current.dispatch_id, entity_version: current.entity_version },
        resource_precondition: payload.resource_precondition,
        allowed_resolutions: allowed,
        expires_at_unix_ms: Math.min(result.expiresAt, this.now() + this.actionTtlMs),
      };
      const resource = realResource ? {
        resource_id: realResource.resource_id,
        entity_version: realResource.entity_version,
        dirty_generation: realResource.dirty_generation,
        label: privacyText(realResource.safe_label, 'Workspace'),
        branch: privacyText(realResource.branch_name, 'not applicable'),
        dirty_reason: privacyText(realResource.dirty_reason, 'Runner result requires inspection'),
      } : {
        resource_id: syntheticResourceId(current.dispatch_id),
        entity_version: 1,
        dirty_generation: 0,
        label: 'No writable workspace',
        branch: 'not applicable',
        dirty_reason: 'Runner result requires inspection',
      };
      return {
        ok: true as const,
        response: {
          schema: AGENT_OPS_CONTRACT,
          scope_id: auth.scopeId,
          projection_id: scope.projection_id,
          stream_epoch: meta.stream_epoch,
          auth_fence_generation: scope.auth_fence_generation,
          snapshot_seq: snapshotSeq,
          client_session_id: auth.clientSessionId,
          inspection_id: result.inspectionId,
          inspection_token: result.inspectionToken,
          dispatch_target: resolutionPayload.target,
          task_id: result.taskId,
          terminal_reason: privacyText(result.terminalReason, 'Runner stopped before its final outcome was confirmed'),
          expires_at_unix_ms: result.expiresAt,
          resource,
          resolution_action: {
            action_id: resolutionPayload.jti,
            kind: 'resolve_outcome',
            target: resolutionPayload.target,
            resource_precondition: payload.resource_precondition,
            allowed_resolutions: allowed,
            expires_at_unix_ms: resolutionPayload.expires_at_unix_ms,
            capability: this.encodeAction(resolutionPayload),
          },
        },
      };
    });
  }

  resolveOutcome(auth: AgentOpsAuthContext, command: AgentOpsCommandEnvelope & {
    inspection_id: string;
    inspection_token: string;
    operator_note: string;
    resolution: Readonly<Record<string, unknown>>;
  }): AgentOpsResult<{ response: Readonly<Record<string, unknown>>; replayed: boolean }> {
    return this.applyMutation(auth, command, 'resolve_outcome', (payload) => {
      if (!payload.resource_precondition) return refusal('bad_request', 'resource precondition is required');
      const inspectionId = requiredText(command.inspection_id, 'inspection_id', 255);
      const inspectionToken = requiredText(command.inspection_token, 'inspection_token', 512);
      const operatorNote = requiredText(command.operator_note, 'operator_note', 2_000);
      const resolution = normalizeResolution(command.resolution);
      const kind = resolution.kind as AgentOpsResolution;
      if (!payload.allowed_resolutions.includes(kind)) return refusal('invalid_transition', 'resolution is not authorized by this action');
      let recoveryInstruction: string | null = null;
      if (kind === 'continue') {
        recoveryInstruction = requiredText(resolution.recovery_instruction, 'resolution.recovery_instruction', 8_000);
      }
      const row = this.dispatchInScope(auth.scopeId, payload.target.entity_id);
      if (!row) return refusal('not_found', 'dispatch is outside the authorized scope or does not exist');
      if (row.entity_version !== payload.target.entity_version) return refusal('precondition_failed', 'dispatch entity version changed');
      const realResource = row.workspace_resource_id ? this.resourceInScope(auth.scopeId, row.workspace_resource_id) : null;
      if (realResource) {
        if (
          payload.resource_precondition.resource_id !== realResource.resource_id
          || payload.resource_precondition.dirty_generation !== realResource.dirty_generation
        ) return refusal('precondition_failed', 'resource dirty generation changed');
      } else if (
        payload.resource_precondition.resource_id !== syntheticResourceId(row.dispatch_id)
        || payload.resource_precondition.dirty_generation !== 0
      ) return refusal('precondition_failed', 'non-writing dispatch effect precondition changed');
      const result = this.router.resolveOutcomeUnknown({
        dispatchId: row.dispatch_id,
        inspectionId,
        inspectionToken,
        requestId: `agent_ops:${auth.scopeId}:${command.request_id}`,
        action: kind,
        operatorNote,
        recoveryInstruction,
      });
      if (!result.ok) return this.mapRouterRefusal(result.code, result.message);
      return {
        ok: true as const,
        response: {
          schema: AGENT_OPS_CONTRACT,
          resolution: result.action,
          task_id: result.taskId,
          replacement_dispatch_id: result.replacementDispatchId,
          idempotent_request_replay: result.replayed,
        },
      };
    });
  }

  private applyMutation(
    auth: AgentOpsAuthContext,
    command: AgentOpsCommandEnvelope,
    expectedKind: AgentOpsActionKind,
    apply: (payload: ActionPayload) => AgentOpsResult<{ response: Readonly<Record<string, unknown>> }>,
  ): AgentOpsResult<{ response: Readonly<Record<string, unknown>>; replayed: boolean }> {
    try {
      const commonKeys = [
        'action_capability', 'auth_fence_generation', 'client_session_id', 'projection_id',
        'request_id', 'resource_precondition', 'schema', 'scope_id', 'snapshot_seq',
        'stream_epoch', 'target',
      ];
      const actionKeys = expectedKind === 'resolve_outcome'
        ? ['inspection_id', 'inspection_token', 'operator_note', 'resolution']
        : [];
      const allowedKeys = new Set([...commonKeys, ...actionKeys]);
      const unknownKeys = Object.keys(command).filter((key) => !allowedKeys.has(key));
      if (unknownKeys.length > 0) throw new Error(`unknown command field: ${unknownKeys.sort()[0]}`);
      const normalized = this.normalizeCommand(command);
      const commandRecord: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(command));
      const canonicalCommand: Readonly<Record<string, unknown>> = {
        ...normalized,
        resource_precondition: normalized.resource_precondition ?? null,
        ...(expectedKind === 'resolve_outcome' ? {
          inspection_id: requiredText(commandRecord.inspection_id, 'inspection_id', 255),
          inspection_token: requiredText(commandRecord.inspection_token, 'inspection_token', 512),
          operator_note: requiredText(commandRecord.operator_note, 'operator_note', 2_000),
          resolution: normalizeResolution(commandRecord.resolution),
        } : {}),
      };
      const requestDigest = agentOpsDigest(canonicalCommand);
      const tx = this.db.transaction(() => {
        const session = this.db.prepare<[string], AgentOpsSessionRow>(
          'SELECT * FROM agent_ops_sessions WHERE client_session_id = ?',
        ).get(auth.clientSessionId);
        const scope = this.scope(auth.scopeId);
        if (!session || !scope || session.revoked_at !== null || session.expires_at < this.now()) {
          return refusal('invalid_capability', 'client session is no longer live');
        }
        if (
          session.scope_id !== auth.scopeId
          || session.auth_fence_generation !== scope.auth_fence_generation
          || auth.authFenceGeneration !== scope.auth_fence_generation
        ) return refusal('auth_fence_stale', 'client session auth fence is stale');
        const prior = this.db.prepare<[string, string], AgentOpsIdempotencyRow>(
          'SELECT request_digest, action_kind, response_json FROM agent_ops_idempotency WHERE scope_id = ? AND request_id = ?',
        ).get(auth.scopeId, normalized.request_id);
        if (prior) {
          if (prior.request_digest !== requestDigest || prior.action_kind !== expectedKind) {
            return refusal('idempotency_conflict', 'request id was reused with different canonical content');
          }
          return { ok: true as const, response: this.unsealResponse(prior.response_json), replayed: true };
        }
        const decoded = this.decodeAction(normalized.action_capability);
        if (!decoded.ok) return decoded;
        const payload = decoded.payload;
        const meta = this.meta();
        if (
          payload.action_kind !== expectedKind
          || payload.client_session_id !== auth.clientSessionId
          || payload.scope_id !== auth.scopeId
          || payload.projection_id !== normalized.projection_id
          || payload.stream_epoch !== normalized.stream_epoch
          || payload.auth_fence_generation !== normalized.auth_fence_generation
          || payload.snapshot_seq !== normalized.snapshot_seq
          || agentOpsCanonicalJson(payload.target) !== agentOpsCanonicalJson(normalized.target)
          || agentOpsCanonicalJson(payload.resource_precondition) !== agentOpsCanonicalJson(normalized.resource_precondition ?? null)
          || payload.projection_id !== scope.projection_id
          || payload.stream_epoch !== meta.stream_epoch
          || payload.auth_fence_generation !== scope.auth_fence_generation
        ) return refusal('scope_mismatch', 'action capability binding does not match the command or live scope');
        if (payload.expires_at_unix_ms < this.now()) return refusal('capability_expired', 'action capability expired');
        const used = this.db.prepare<[string], { action_jti: string }>(
          'SELECT action_jti FROM agent_ops_action_uses WHERE action_jti = ?',
        ).get(payload.jti);
        if (used) return refusal('capability_consumed', 'action capability was already consumed');
        const result = apply(payload);
        if (!result.ok) return result;
        const now = this.now();
        this.db.prepare<[string, string, string, number]>(
          'INSERT INTO agent_ops_action_uses(action_jti, client_session_id, request_id, consumed_at) VALUES (?, ?, ?, ?)',
        ).run(payload.jti, auth.clientSessionId, normalized.request_id, now);
        this.db.prepare<[string, string, string, string, string, number]>(
          `INSERT INTO agent_ops_idempotency(
            scope_id, request_id, request_digest, action_kind, response_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          auth.scopeId,
          normalized.request_id,
          requestDigest,
          expectedKind,
          this.sealResponse(result.response),
          now,
        );
        this.db.prepare<[number]>(
          'DELETE FROM agent_ops_idempotency WHERE created_at < ?',
        ).run(now - IDEMPOTENCY_RETENTION_MS);
        return { ok: true as const, response: result.response, replayed: false };
      });
      return tx();
    } catch (error) {
      return refusal('bad_request', error instanceof Error ? error.message : String(error));
    }
  }

  private normalizeCommand(command: AgentOpsCommandEnvelope): AgentOpsCommandEnvelope {
    if (command.schema !== AGENT_OPS_CONTRACT) throw new Error('command schema is not supported');
    const target = command.target;
    if (!target || !['dispatch', 'resource'].includes(target.entity_kind)) throw new Error('target entity kind is invalid');
    if (Object.keys(target).sort().join(',') !== 'entity_id,entity_kind,entity_version') {
      throw new Error('target must contain exactly entity_kind, entity_id and entity_version');
    }
    const normalized: AgentOpsCommandEnvelope = {
      schema: AGENT_OPS_CONTRACT,
      request_id: requiredText(command.request_id, 'request_id', 255),
      client_session_id: requiredText(command.client_session_id, 'client_session_id', 255),
      scope_id: requiredText(command.scope_id, 'scope_id', 255),
      projection_id: requiredText(command.projection_id, 'projection_id', 255),
      stream_epoch: requiredText(command.stream_epoch, 'stream_epoch', 255),
      auth_fence_generation: safeInteger(command.auth_fence_generation, 'auth_fence_generation', { positive: true }),
      snapshot_seq: safeInteger(command.snapshot_seq, 'snapshot_seq'),
      action_capability: requiredText(command.action_capability, 'action_capability', 8192),
      target: {
        entity_kind: target.entity_kind,
        entity_id: requiredText(target.entity_id, 'target.entity_id', 255),
        entity_version: safeInteger(target.entity_version, 'target.entity_version', { positive: true }),
      },
    };
    if (command.resource_precondition !== undefined && command.resource_precondition !== null) {
      if (Object.keys(command.resource_precondition).sort().join(',') !== 'dirty_generation,resource_id') {
        throw new Error('resource_precondition must contain exactly resource_id and dirty_generation');
      }
      normalized.resource_precondition = {
        resource_id: requiredText(command.resource_precondition.resource_id, 'resource_precondition.resource_id', 512),
        dirty_generation: safeInteger(command.resource_precondition.dirty_generation, 'resource_precondition.dirty_generation'),
      };
    }
    if (normalized.client_session_id !== command.client_session_id || normalized.scope_id !== command.scope_id) {
      throw new Error('command identifiers must be canonical');
    }
    return normalized;
  }

  private encodeAction(payload: ActionPayload): string {
    const encoded = base64url(Buffer.from(agentOpsCanonicalJson(payload)));
    const mac = createHmac('sha256', this.meta().action_hmac_key).update(`aoc1.${encoded}`).digest();
    return `aoc1.${encoded}.${base64url(mac)}`;
  }

  private decodeAction(token: string): AgentOpsResult<{ payload: ActionPayload }> {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'aoc1' || !parts[1] || !parts[2]) return refusal('invalid_capability', 'action capability format is invalid');
    const expected = createHmac('sha256', this.meta().action_hmac_key).update(`aoc1.${parts[1]}`).digest();
    let actual: Buffer;
    try { actual = Buffer.from(parts[2], 'base64url'); } catch { return refusal('invalid_capability', 'action capability signature is invalid'); }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return refusal('invalid_capability', 'action capability signature is invalid');
    try {
      const value = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Readonly<Record<string, unknown>>;
      if (!value || Array.isArray(value) || typeof value !== 'object' || !exactKeys(value, [
        'v', 'jti', 'client_session_id', 'scope_id', 'projection_id', 'stream_epoch',
        'auth_fence_generation', 'snapshot_seq', 'action_kind', 'target',
        'resource_precondition', 'allowed_resolutions', 'expires_at_unix_ms',
      ])) return refusal('invalid_capability', 'action capability payload is invalid');
      const kind = value.action_kind;
      if (!['cancel_dispatch', 'mark_resource_inspected', 'begin_outcome_inspection', 'resolve_outcome'].includes(String(kind))) {
        return refusal('invalid_capability', 'action capability kind is invalid');
      }
      const targetValue = value.target;
      if (!targetValue || Array.isArray(targetValue) || typeof targetValue !== 'object'
          || !exactKeys(targetValue as Readonly<Record<string, unknown>>, ['entity_kind', 'entity_id', 'entity_version'])) {
        return refusal('invalid_capability', 'action capability target is invalid');
      }
      const targetRecord = targetValue as Readonly<Record<string, unknown>>;
      const expectedEntityKind = kind === 'mark_resource_inspected' ? 'resource' : 'dispatch';
      if (targetRecord.entity_kind !== expectedEntityKind) return refusal('invalid_capability', 'action capability target kind is invalid');
      let resourcePrecondition: AgentOpsResourcePrecondition | null = null;
      if (value.resource_precondition !== null) {
        if (!value.resource_precondition || Array.isArray(value.resource_precondition)
            || typeof value.resource_precondition !== 'object'
            || !exactKeys(value.resource_precondition as Readonly<Record<string, unknown>>, ['resource_id', 'dirty_generation'])) {
          return refusal('invalid_capability', 'action capability resource precondition is invalid');
        }
        const resource = value.resource_precondition as Readonly<Record<string, unknown>>;
        resourcePrecondition = {
          resource_id: requiredText(resource.resource_id, 'resource_precondition.resource_id', 512),
          dirty_generation: safeInteger(resource.dirty_generation, 'resource_precondition.dirty_generation'),
        };
      }
      if ((kind === 'cancel_dispatch') !== (resourcePrecondition === null)) {
        return refusal('invalid_capability', 'action capability resource binding is invalid');
      }
      if (!Array.isArray(value.allowed_resolutions)) return refusal('invalid_capability', 'action capability resolutions are invalid');
      const resolutions = value.allowed_resolutions.map((item) => requiredText(item, 'allowed_resolution', 64) as AgentOpsResolution);
      if (resolutions.some((item) => !['continue', 'accept_completed', 'keep_blocked'].includes(item))
          || new Set(resolutions).size !== resolutions.length
          || (kind !== 'resolve_outcome' && resolutions.length !== 0)
          || (kind === 'resolve_outcome' && resolutions.length === 0)) {
        return refusal('invalid_capability', 'action capability resolutions are invalid');
      }
      const payload: ActionPayload = {
        v: value.v === 1 ? 1 : (() => { throw new Error('action capability version is invalid'); })(),
        jti: requiredText(value.jti, 'jti', 255),
        client_session_id: requiredText(value.client_session_id, 'client_session_id', 255),
        scope_id: requiredText(value.scope_id, 'scope_id', 255),
        projection_id: requiredText(value.projection_id, 'projection_id', 255),
        stream_epoch: requiredText(value.stream_epoch, 'stream_epoch', 255),
        auth_fence_generation: safeInteger(value.auth_fence_generation, 'auth_fence_generation', { positive: true }),
        snapshot_seq: safeInteger(value.snapshot_seq, 'snapshot_seq'),
        action_kind: kind as AgentOpsActionKind,
        target: {
          entity_kind: expectedEntityKind,
          entity_id: requiredText(targetRecord.entity_id, 'target.entity_id', 255),
          entity_version: safeInteger(targetRecord.entity_version, 'target.entity_version', { positive: true }),
        },
        resource_precondition: resourcePrecondition,
        allowed_resolutions: resolutions,
        expires_at_unix_ms: safeInteger(value.expires_at_unix_ms, 'expires_at_unix_ms', { positive: true }),
      };
      return { ok: true, payload };
    } catch {
      return refusal('invalid_capability', 'action capability payload is invalid');
    }
  }

  private sealResponse(response: Readonly<Record<string, unknown>>): string {
    const key = createHmac('sha256', this.meta().action_hmac_key).update('agent-ops-idempotency-seal-v1').digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(agentOpsCanonicalJson(response)), cipher.final()]);
    return agentOpsCanonicalJson({ v: 1, iv: base64url(iv), tag: base64url(cipher.getAuthTag()), ciphertext: base64url(ciphertext) });
  }

  private unsealResponse(value: string): Readonly<Record<string, unknown>> {
    const sealed = parseJsonObject(value);
    if (sealed.v !== 1 || typeof sealed.iv !== 'string' || typeof sealed.tag !== 'string' || typeof sealed.ciphertext !== 'string') {
      throw new Error('stored Agent Operations response seal is invalid');
    }
    const key = createHmac('sha256', this.meta().action_hmac_key).update('agent-ops-idempotency-seal-v1').digest();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64url'));
    return parseJsonObject(Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8'));
  }

  private dispatchInScope(scopeId: string, dispatchId: string): ProjectionDispatchRow | null {
    const scope = this.scope(scopeId);
    if (!scope) return null;
    return this.db.prepare<[string, string, string], ProjectionDispatchRow>(
      `SELECT d.*, s.agent_name, s.room_id, s.thread_root_event_id
       FROM dispatches d JOIN sessions s ON s.session_id = d.session_id
       WHERE d.dispatch_id = ? AND s.agent_id = ? AND s.room_id = ?`,
    ).get(dispatchId, scope.stable_agent_id, scope.project_room_id) ?? null;
  }

  private resourceInScope(scopeId: string, resourceId: string): ProjectionResourceRow | null {
    const scope = this.scope(scopeId);
    if (!scope) return null;
    return this.db.prepare<[string, string, string], ProjectionResourceRow>(
      `SELECT r.*, d.task_id FROM resources r JOIN dispatches d ON d.workspace_resource_id = r.resource_id
       JOIN sessions s ON s.session_id = d.session_id
       WHERE r.resource_id = ? AND s.agent_id = ? AND s.room_id = ?
       ORDER BY d.created_at DESC LIMIT 1`,
    ).get(resourceId, scope.stable_agent_id, scope.project_room_id) ?? null;
  }

  private resourceScopeCount(resourceId: string): number {
    return this.db.prepare<[string], { count: number }>(
      `SELECT COUNT(DISTINCT s.agent_id || char(0) || s.room_id) AS count
       FROM dispatches d JOIN sessions s ON s.session_id = d.session_id
       WHERE d.workspace_resource_id = ?`,
    ).get(resourceId)?.count ?? 0;
  }

  private mapRouterRefusal(code: string, message: string): AgentOpsRefusal {
    if (code === 'not_found') return refusal('not_found', message);
    if (code === 'inspection_required') return refusal('inspection_required', message);
    if (code === 'inspection_expired') return refusal('inspection_expired', message);
    if (code === 'idempotency_conflict') return refusal('idempotency_conflict', message);
    if (code === 'workspace_quarantined') return refusal('precondition_failed', message);
    if (code === 'bad_request') return refusal('bad_request', message);
    return refusal('invalid_transition', message);
  }
}
