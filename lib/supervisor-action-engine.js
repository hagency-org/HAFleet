// SupervisorActionEngine — threshold-based nudge/escalation decisions.

const DEFAULT_WARN_AFTER = 2;
const DEFAULT_ESCALATE_AFTER = 3;
const DEFAULT_COOLDOWN_MS = 300_000; // 5 min

export function createSupervisorActionEngine({ snapshotStore, sendMessage, broadcastSSE, alertStore }) {
  const warnAfter = parseInt(process.env.SUPERVISOR_WARN_AFTER || String(DEFAULT_WARN_AFTER), 10);
  const escalateAfter = parseInt(process.env.SUPERVISOR_ESCALATE_AFTER || String(DEFAULT_ESCALATE_AFTER), 10);
  const cooldownMs = parseInt(process.env.SUPERVISOR_WARN_COOLDOWN_MS || String(DEFAULT_COOLDOWN_MS), 10);

  function evaluateAction(targetAgent, snapshot) {
    if (!snapshot || !snapshot.negative) return null;
    if (snapshot.confidence < 0.7) return null;

    const consecutive = snapshot.consecutiveNegative || 0;
    const now = Date.now();

    // Nudge: consecutive negative >= warnAfter, respecting cooldown
    if (consecutive >= warnAfter) {
      const lastNudge = snapshot.lastNudgeAt || 0;
      if ((now - lastNudge) > cooldownMs) {
        const nudgeMsg = {
          from: 'system',
          to: targetAgent,
          type: 'inform',
          priority: 'high',
          summary: `Supervisor: you appear ${snapshot.state}. ${snapshot.reason}`,
          full: `[Supervisor assessment] Agent ${targetAgent} classified as ${snapshot.state} (confidence: ${snapshot.confidence.toFixed(2)}, consecutive: ${consecutive}).\n\nReason: ${snapshot.reason}\n\nPlease verify you are on-task and making progress.`,
          schema: {
            kind: 'supervisor_nudge',
            version: 1,
            payload: {
              target: targetAgent,
              state: snapshot.state,
              confidence: snapshot.confidence,
              consecutive,
              reason: snapshot.reason,
            },
          },
        };
        sendMessage(nudgeMsg);
        snapshotStore.recordNudge(targetAgent);

        if (alertStore) {
          try {
            alertStore.ingest({
              alertType: 'supervisor_nudge',
              dedupeKey: `supervisor_nudge:${targetAgent}`,
              severity: 'info',
              source: 'supervisor',
              sourceAgent: targetAgent,
              summary: `Supervisor: ${targetAgent} appears ${snapshot.state}`,
              detail: `Confidence: ${snapshot.confidence.toFixed(2)}, consecutive: ${consecutive}. ${snapshot.reason}`,
            });
          } catch { /* non-fatal */ }
        }

        if (broadcastSSE) {
          broadcastSSE('supervisor_audit', {
            type: 'nudge',
            agent: targetAgent,
            state: snapshot.state,
            confidence: snapshot.confidence,
            consecutive,
            ts: now,
          });
        }
      }
    }

    // Escalate: consecutive negative >= escalateAfter
    if (consecutive >= escalateAfter) {
      const lastEscalation = snapshot.lastEscalationAt || 0;
      if ((now - lastEscalation) > cooldownMs) {
        const escalationMsg = {
          from: 'system',
          to: 'ac-topleader',
          type: 'request',
          priority: 'urgent',
          summary: `Supervisor escalation: ${targetAgent} is ${snapshot.state}`,
          full: `[Supervisor escalation] Agent ${targetAgent} has been ${snapshot.state} for ${consecutive} consecutive assessments (confidence: ${snapshot.confidence.toFixed(2)}).\n\nReason: ${snapshot.reason}\n\nThis requires coordinator attention.`,
          schema: {
            kind: 'escalation',
            version: 1,
            payload: {
              target: targetAgent,
              state: snapshot.state,
              confidence: snapshot.confidence,
              consecutive,
              reason: snapshot.reason,
              source: 'supervisor',
            },
          },
        };
        sendMessage(escalationMsg);
        snapshotStore.recordEscalation(targetAgent);

        if (alertStore) {
          try {
            alertStore.ingest({
              alertType: 'supervisor_escalation',
              dedupeKey: `supervisor_escalation:${targetAgent}`,
              severity: 'warning',
              source: 'supervisor',
              sourceAgent: targetAgent,
              summary: `Supervisor escalation: ${targetAgent} is ${snapshot.state}`,
              detail: `Confidence: ${snapshot.confidence.toFixed(2)}, consecutive: ${consecutive}. ${snapshot.reason}`,
            });
          } catch { /* non-fatal */ }
        }

        if (broadcastSSE) {
          broadcastSSE('supervisor_audit', {
            type: 'escalation',
            agent: targetAgent,
            state: snapshot.state,
            confidence: snapshot.confidence,
            consecutive,
            ts: now,
          });
        }
      }
    }

    return { nudged: consecutive >= warnAfter, escalated: consecutive >= escalateAfter };
  }

  return { evaluateAction };
}
