import { createHash, randomBytes } from 'crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'fs';
import path from 'path';

const STORE_VERSION = 1;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_AUDIT_LIMIT = 2000;
const MXID_RE = /^@[^:\s]+:[^\s]+$/;
const ROOM_ID_RE = /^![^:\s]+:[^\s]+$/;
const TERMINAL_STATES = new Set(['approved', 'denied', 'expired', 'consumed']);

export class ApprovalStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ApprovalStoreError';
    this.code = code;
  }
}

function text(value, field, max = 512) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > max) {
    throw new ApprovalStoreError('bad_request', `${field} must be 1..${max} characters`);
  }
  return normalized;
}

function optionalText(value, max = 4096) {
  if (value === null || value === undefined) return '';
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized.length > max) {
    throw new ApprovalStoreError('bad_request', `text exceeds ${max} characters`);
  }
  return normalized;
}

function fullMxid(value, field = 'owner_mxid') {
  const normalized = text(value, field, 255);
  if (!MXID_RE.test(normalized)) {
    throw new ApprovalStoreError('bad_request', `${field} must be a full Matrix MXID`);
  }
  return normalized;
}

function roomId(value, field) {
  const normalized = text(value, field, 255);
  if (!ROOM_ID_RE.test(normalized)) {
    throw new ApprovalStoreError('bad_request', `${field} must be a full Matrix room id`);
  }
  return normalized;
}

function bindingKey(agent, projectRoomId) {
  return `${agent}\u0000${projectRoomId}`;
}

function digestRequest(input) {
  const canonical = JSON.stringify({
    agent: input.agent,
    runtime: input.runtime,
    project: input.project,
    project_room_id: input.projectRoomId,
    owner_mxid: input.ownerMxid,
    owner_dm_room_id: input.ownerDmRoomId,
    upstream_request_id: input.upstreamRequestId,
    tool_name: input.toolName,
    description: input.description,
    input_preview: input.inputPreview,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function publicRecord(record) {
  if (!record) return null;
  return {
    id: record.id,
    agent: record.agent,
    runtime: record.runtime,
    project: record.project,
    project_room_id: record.projectRoomId,
    owner_mxid: record.ownerMxid,
    owner_dm_room_id: record.ownerDmRoomId,
    upstream_request_id: record.upstreamRequestId,
    input_digest: record.inputDigest,
    status: record.status,
    decision: record.decision || null,
    denial_reason: record.denialReason || null,
    created_at: record.createdAt,
    expires_at: record.expiresAt,
    decided_at: record.decidedAt || null,
    consumed_at: record.consumedAt || null,
  };
}

function matrixRecord(record) {
  const safe = publicRecord(record);
  if (!safe) return null;
  return {
    ...safe,
    tool_name: record.toolName,
    description: record.description,
    input_preview: record.inputPreview,
  };
}

export class ApprovalStore {
  constructor(filePath, options = {}) {
    this.filePath = path.resolve(filePath);
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0
      ? Math.floor(options.ttlMs)
      : DEFAULT_TTL_MS;
    this.auditLimit = Number.isFinite(options.auditLimit) && options.auditLimit > 0
      ? Math.floor(options.auditLimit)
      : DEFAULT_AUDIT_LIMIT;
    this.state = this._load();
  }

  _load() {
    if (!existsSync(this.filePath)) {
      return { version: STORE_VERSION, bindings: {}, requests: {}, audit: [] };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
      return {
        version: STORE_VERSION,
        bindings: parsed?.bindings && typeof parsed.bindings === 'object' ? parsed.bindings : {},
        requests: parsed?.requests && typeof parsed.requests === 'object' ? parsed.requests : {},
        audit: Array.isArray(parsed?.audit) ? parsed.audit.slice(-this.auditLimit) : [],
      };
    } catch (error) {
      throw new ApprovalStoreError('persistence_failed', `failed to load approval store: ${error.message}`);
    }
  }

  _save() {
    const dir = path.dirname(this.filePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const bytes = JSON.stringify(this.state, null, 2) + '\n';
    let fd = null;
    try {
      writeFileSync(tmp, bytes, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      fd = openSync(tmp, 'r');
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(tmp, this.filePath);
      chmodSync(this.filePath, 0o600);
    } catch (error) {
      if (fd !== null) {
        try { closeSync(fd); } catch {}
      }
      throw new ApprovalStoreError('persistence_failed', `failed to persist approval store: ${error.message}`);
    }
  }

  _audit(type, detail = {}) {
    this.state.audit.push({ type, at: this.now(), ...detail });
    if (this.state.audit.length > this.auditLimit) {
      this.state.audit.splice(0, this.state.audit.length - this.auditLimit);
    }
  }

  _expire(record, now = this.now()) {
    if (record?.status !== 'pending' || now < Number(record.expiresAt || 0)) return false;
    record.status = 'expired';
    record.decision = 'deny';
    record.denialReason = 'approval_expired';
    record.decidedAt = now;
    this._audit('approval.expired', { requestId: record.id, agent: record.agent });
    return true;
  }

  upsertBinding(input) {
    const now = this.now();
    const agent = text(input?.agent, 'agent', 128);
    const project = text(input?.project, 'project', 255);
    const projectRoomId = roomId(input?.project_room_id ?? input?.projectRoomId, 'project_room_id');
    const ownerMxid = fullMxid(input?.owner_mxid ?? input?.ownerMxid);
    const ownerDmRoomId = roomId(input?.owner_dm_room_id ?? input?.ownerDmRoomId, 'owner_dm_room_id');
    const key = bindingKey(agent, projectRoomId);
    const previous = this.state.bindings[key] || null;
    const changedOwner = previous && (
      previous.ownerMxid !== ownerMxid || previous.ownerDmRoomId !== ownerDmRoomId
    );
    const binding = {
      agent,
      project,
      projectRoomId,
      ownerMxid,
      ownerDmRoomId,
      active: true,
      createdAt: previous?.createdAt || now,
      updatedAt: now,
    };
    this.state.bindings[key] = binding;
    if (changedOwner) {
      for (const record of Object.values(this.state.requests)) {
        if (record.status !== 'pending' || record.agent !== agent || record.projectRoomId !== projectRoomId) continue;
        record.status = 'denied';
        record.decision = 'deny';
        record.denialReason = 'owner_binding_changed';
        record.decidedAt = now;
        this._audit('approval.denied', { requestId: record.id, agent, reason: 'owner_binding_changed' });
      }
    }
    this._audit(previous ? 'binding.updated' : 'binding.created', {
      agent,
      project,
      projectRoomId,
      ownerMxid,
    });
    this._save();
    return { ...binding };
  }

  removeBinding(agentValue, projectRoomIdValue) {
    const agent = text(agentValue, 'agent', 128);
    const projectRoomId = roomId(projectRoomIdValue, 'project_room_id');
    const key = bindingKey(agent, projectRoomId);
    const binding = this.state.bindings[key];
    if (!binding) return null;
    const now = this.now();
    delete this.state.bindings[key];
    for (const record of Object.values(this.state.requests)) {
      if (record.status !== 'pending' || record.agent !== agent || record.projectRoomId !== projectRoomId) continue;
      record.status = 'denied';
      record.decision = 'deny';
      record.denialReason = 'owner_binding_removed';
      record.decidedAt = now;
    }
    this._audit('binding.removed', { agent, projectRoomId, ownerMxid: binding.ownerMxid });
    this._save();
    return { ...binding };
  }

  listBindings(filters = {}) {
    const agent = typeof filters.agent === 'string' ? filters.agent.trim() : '';
    const project = typeof filters.project === 'string' ? filters.project.trim() : '';
    return Object.values(this.state.bindings)
      .filter((binding) => binding?.active !== false)
      .filter((binding) => !agent || binding.agent === agent)
      .filter((binding) => !project || binding.project === project || binding.projectRoomId === project)
      .map((binding) => ({ ...binding }));
  }

  createRequest(input) {
    const now = this.now();
    const agent = text(input?.agent, 'agent', 128);
    const runtime = text(input?.runtime, 'runtime', 32).toLowerCase();
    if (runtime !== 'claude' && runtime !== 'codex') {
      throw new ApprovalStoreError('bad_request', 'runtime must be claude or codex');
    }
    const upstreamRequestId = text(input?.upstream_request_id ?? input?.upstreamRequestId, 'upstream_request_id', 255);
    const requestedProject = optionalText(input?.project, 255);
    const toolName = text(input?.tool_name ?? input?.toolName, 'tool_name', 255);
    const description = optionalText(input?.description, 4096);
    const inputPreview = optionalText(input?.input_preview ?? input?.inputPreview, 8192);

    for (const record of Object.values(this.state.requests)) {
      this._expire(record, now);
      if (record.status === 'pending'
        && record.agent === agent
        && record.runtime === runtime
        && record.upstreamRequestId === upstreamRequestId) {
        this._save();
        return publicRecord(record);
      }
    }

    const bindings = this.listBindings({ agent, project: requestedProject });
    const binding = bindings.length === 1 ? bindings[0] : null;
    const id = `approval_${randomBytes(16).toString('hex')}`;
    const expiresAtRaw = Number(input?.expires_at ?? input?.expiresAt);
    const expiresAt = Number.isFinite(expiresAtRaw) && expiresAtRaw > now
      ? Math.min(Math.floor(expiresAtRaw), now + this.ttlMs)
      : now + this.ttlMs;

    if (!binding) {
      const reason = bindings.length === 0 ? 'owner_binding_missing' : 'owner_binding_ambiguous';
      const denied = {
        id,
        agent,
        runtime,
        project: requestedProject || null,
        projectRoomId: null,
        ownerMxid: null,
        ownerDmRoomId: null,
        upstreamRequestId,
        toolName,
        description,
        inputPreview,
        inputDigest: null,
        status: 'denied',
        decision: 'deny',
        denialReason: reason,
        createdAt: now,
        expiresAt,
        decidedAt: now,
        consumedAt: null,
      };
      this.state.requests[id] = denied;
      this._audit('approval.denied', { requestId: id, agent, reason });
      this._save();
      return publicRecord(denied);
    }

    const record = {
      id,
      agent,
      runtime,
      project: binding.project,
      projectRoomId: binding.projectRoomId,
      ownerMxid: binding.ownerMxid,
      ownerDmRoomId: binding.ownerDmRoomId,
      upstreamRequestId,
      toolName,
      description,
      inputPreview,
      status: 'pending',
      decision: null,
      denialReason: null,
      createdAt: now,
      expiresAt,
      decidedAt: null,
      consumedAt: null,
    };
    record.inputDigest = digestRequest(record);
    this.state.requests[id] = record;
    this._audit('approval.created', {
      requestId: id,
      agent,
      project: record.project,
      projectRoomId: record.projectRoomId,
      ownerMxid: record.ownerMxid,
    });
    this._save();
    return publicRecord(record);
  }

  getRequest(id, options = {}) {
    const normalizedId = typeof id === 'string' ? id.trim() : '';
    const record = this.state.requests[normalizedId];
    if (!record) return null;
    if (this._expire(record)) this._save();
    return options.matrix === true ? matrixRecord(record) : publicRecord(record);
  }

  submitMatrixVerdict(id, input) {
    const normalizedId = typeof id === 'string' ? id.trim() : '';
    const record = this.state.requests[normalizedId];
    if (!record) return { ok: false, code: 'not_found', record: null };
    const now = this.now();
    if (this._expire(record, now)) {
      this._audit('approval.verdict_rejected', { requestId: normalizedId, reason: 'expired' });
      this._save();
      return { ok: false, code: 'expired', record: publicRecord(record) };
    }
    if (record.status !== 'pending') {
      this._audit('approval.verdict_rejected', { requestId: normalizedId, reason: 'not_pending', status: record.status });
      this._save();
      return { ok: false, code: 'not_pending', record: publicRecord(record) };
    }

    const action = typeof input?.action === 'string' ? input.action.trim() : '';
    const expected = {
      senderMxid: record.ownerMxid,
      roomId: record.ownerDmRoomId,
      agent: record.agent,
      project: record.project,
      projectRoomId: record.projectRoomId,
      inputDigest: record.inputDigest,
    };
    const actual = {
      senderMxid: input?.sender_mxid ?? input?.senderMxid,
      roomId: input?.room_id ?? input?.roomId,
      agent: input?.agent,
      project: input?.project,
      projectRoomId: input?.project_room_id ?? input?.projectRoomId,
      inputDigest: input?.input_digest ?? input?.inputDigest,
    };
    const mismatch = Object.keys(expected).find((key) => expected[key] !== actual[key]);
    if (mismatch || (action !== 'approve_once' && action !== 'deny')) {
      const reason = mismatch ? `${mismatch}_mismatch` : 'invalid_action';
      this._audit('approval.verdict_rejected', {
        requestId: normalizedId,
        reason,
        senderMxid: typeof actual.senderMxid === 'string' ? actual.senderMxid : null,
        roomId: typeof actual.roomId === 'string' ? actual.roomId : null,
      });
      this._save();
      return { ok: false, code: reason, record: publicRecord(record) };
    }

    record.status = action === 'approve_once' ? 'approved' : 'denied';
    record.decision = action === 'approve_once' ? 'allow' : 'deny';
    record.denialReason = action === 'deny' ? 'owner_denied' : null;
    record.decidedAt = now;
    record.matrixEventId = optionalText(input?.event_id ?? input?.eventId, 255) || null;
    this._audit('approval.verdict_accepted', {
      requestId: normalizedId,
      agent: record.agent,
      decision: record.decision,
      senderMxid: record.ownerMxid,
      roomId: record.ownerDmRoomId,
      eventId: record.matrixEventId,
    });
    this._save();
    return { ok: true, code: record.status, record: publicRecord(record) };
  }

  denyPending(id, reason = 'delivery_failed') {
    const record = this.state.requests[id];
    if (!record) return null;
    const now = this.now();
    if (this._expire(record, now)) {
      this._save();
      return publicRecord(record);
    }
    if (record.status !== 'pending') return publicRecord(record);
    record.status = 'denied';
    record.decision = 'deny';
    record.denialReason = optionalText(reason, 255) || 'delivery_failed';
    record.decidedAt = now;
    this._audit('approval.denied', { requestId: id, agent: record.agent, reason: record.denialReason });
    this._save();
    return publicRecord(record);
  }

  consumeDecision(id, agentValue, inputDigestValue = null) {
    const record = this.state.requests[id];
    if (!record) return { ok: false, code: 'not_found', record: null };
    const now = this.now();
    if (this._expire(record, now)) {
      this._save();
      return { ok: false, code: 'expired', record: publicRecord(record) };
    }
    if (record.agent !== agentValue) return { ok: false, code: 'agent_mismatch', record: publicRecord(record) };
    if (inputDigestValue && record.inputDigest !== inputDigestValue) {
      return { ok: false, code: 'input_digest_mismatch', record: publicRecord(record) };
    }
    if (record.status === 'pending') return { ok: false, code: 'pending', record: publicRecord(record) };
    if (record.status === 'consumed') return { ok: false, code: 'consumed', record: publicRecord(record) };
    if (!TERMINAL_STATES.has(record.status)) return { ok: false, code: 'invalid_state', record: publicRecord(record) };

    const decision = record.decision === 'allow' ? 'allow' : 'deny';
    record.status = 'consumed';
    record.consumedAt = now;
    this._audit('approval.consumed', { requestId: id, agent: record.agent, decision });
    this._save();
    return { ok: true, code: 'consumed', decision, record: publicRecord(record) };
  }

  listAudit() {
    return this.state.audit.map((entry) => ({ ...entry }));
  }
}

export function createApprovalStore(filePath, options = {}) {
  return new ApprovalStore(filePath, options);
}
