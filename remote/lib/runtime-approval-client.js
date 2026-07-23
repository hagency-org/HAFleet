const DEFAULT_POLL_INTERVAL_MS = 1000;
export const APPROVAL_CHANNEL_FAILURE_MESSAGE = 'Agent Chat approval channel failed; request denied.';
export const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1000;
export const APPROVAL_HOOK_TIMEOUT_MARGIN_SECONDS = 60;

export function resolveApprovalTtlMs(env = process.env) {
  const raw = Number.parseInt(env.AGENTCHAT_APPROVAL_TTL_MS || String(DEFAULT_APPROVAL_TTL_MS), 10);
  return Number.isFinite(raw) && raw > 0 ? Math.max(5_000, raw) : DEFAULT_APPROVAL_TTL_MS;
}

export function approvalHookTimeoutSeconds(env = process.env) {
  return Math.ceil(resolveApprovalTtlMs(env) / 1000) + APPROVAL_HOOK_TIMEOUT_MARGIN_SECONDS;
}

function terminalDecision(approval) {
  if (!approval || typeof approval !== 'object') return null;
  if (approval.status === 'approved' && approval.decision === 'allow') return 'allow';
  if (approval.status === 'denied' || approval.status === 'expired') return 'deny';
  return null;
}

export async function awaitRuntimeApproval({
  api,
  approval,
  agent,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = () => Date.now(),
}) {
  if (typeof api !== 'function') throw new Error('approval API function required');
  if (!approval?.id || !agent) throw new Error('approval id and agent required');
  let current = approval;
  const deadline = Math.max(Number(current.expires_at || 0), now()) + Math.max(1000, pollIntervalMs * 2);

  while (now() <= deadline) {
    const behavior = terminalDecision(current);
    if (behavior) return { behavior, approval: current };
    if (current.status === 'consumed') return null;
    if (current.status !== 'pending') return null;
    await sleep(pollIntervalMs);
    const response = await api('GET', `/api/approvals/${encodeURIComponent(current.id)}`);
    current = response?.approval || null;
    if (!current) return null;
  }
  return null;
}

export async function consumeRuntimeApproval(api, approval, agent) {
  if (!approval?.id) throw new Error('approval id required');
  return api('POST', `/api/approvals/${encodeURIComponent(approval.id)}/consume`, {
    agent,
    ...(approval.input_digest ? { input_digest: approval.input_digest } : {}),
  });
}

export async function resolveAndConsumeRuntimeApproval({
  api,
  approval,
  agent,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  sleep,
  now,
}) {
  const outcome = await awaitRuntimeApproval({
    api,
    approval,
    agent,
    pollIntervalMs,
    ...(sleep ? { sleep } : {}),
    ...(now ? { now } : {}),
  });
  if (!outcome?.approval) {
    return {
      behavior: 'deny',
      approval: null,
      denial_reason: 'approval_channel_unavailable',
    };
  }

  // Consume before telling the runtime. If delivery fails after this point,
  // the runtime is denied or remains blocked, but an allow can never replay.
  await consumeRuntimeApproval(api, outcome.approval, agent);
  return {
    ...outcome,
    denial_reason: outcome.approval.denial_reason || '',
  };
}

export function deniedRuntimeApproval(reason = 'approval_channel_unavailable') {
  return {
    behavior: 'deny',
    approval: null,
    denial_reason: reason,
  };
}

export async function failClosedRuntimeApproval(operation, {
  onError,
  failureReason = 'approval_channel_failed',
} = {}) {
  try {
    return await operation();
  } catch (error) {
    onError?.(error);
    return deniedRuntimeApproval(failureReason);
  }
}

export function claudeChannelServerOptions(enabled) {
  if (!enabled) return undefined;
  return {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
    },
    instructions: 'Agent Chat relays runtime permission requests only through owner-authenticated Matrix UI actions.',
  };
}
