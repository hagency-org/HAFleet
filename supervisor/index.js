import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { loadSupervisorConfig } from './config.js';
import { collectAgentContext } from './collector.js';
import { LLMJudge } from './judge.js';
import { SupervisorStateStore } from './state.js';
import { buildWarningPayload } from './action.js';

function readJsonl(filePath, limit = 2000) {
  try {
    if (!existsSync(filePath)) return [];
    const raw = readFileSync(filePath, 'utf-8');
    if (!raw.trim()) return [];
    const rows = raw.trim().split('\n');
    const tail = rows.slice(-Math.max(1, limit));
    const parsed = [];
    for (const line of tail) {
      try {
        parsed.push(JSON.parse(line));
      } catch {}
    }
    return parsed;
  } catch {
    return [];
  }
}

function safeAppendJsonl(filePath, obj) {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(obj)}\n`);
}

function hashInput(input) {
  return createHash('sha1').update(JSON.stringify(input)).digest('hex');
}

function isNegative(status) {
  return status === 'DRIFTING' || status === 'LOST' || status === 'STUCK';
}

export class SupervisorService {
  constructor(deps = {}) {
    this.config = deps.config || loadSupervisorConfig(process.env);
    this.getAgents = deps.getAgents;
    this.getRuntime = deps.getRuntime;
    this.emitSystemInfo = deps.emitSystemInfo;
    this.broadcastSSE = deps.broadcastSSE;

    this.enabled = this.config.enabled;
    this.disabledReason = this.config.disabledReason || null;
    this.stateStore = new SupervisorStateStore(this.config.stateFile, this.config.warnAfter, this.config.warnCooldownMs);
    this.events = readJsonl(this.config.logFile, this.config.eventHistoryLimit);
    this.latestByAgent = new Map();
    this.judge = this.enabled ? new LLMJudge(this.config) : null;

    this.running = false;
    this.timer = null;
    this.lastSweepAt = 0;
    this.lastSweepDurationMs = 0;
    this.lastSweepError = null;
    this.lastSweepEvaluated = 0;
    this.lastSweepActive = 0;

    for (const ev of this.events) {
      if (ev && ev.agent) this.latestByAgent.set(ev.agent, ev);
    }
  }

  start() {
    if (!this.enabled) {
      console.log(`[supervisor] disabled: ${this.disabledReason || 'unknown reason'}`);
      return;
    }
    if (this.timer) return;
    this.runSweep().catch((e) => {
      this.lastSweepError = String(e?.message || e);
      console.error(`[supervisor] initial sweep failed: ${this.lastSweepError}`);
    });
    this.timer = setInterval(() => {
      this.runSweep().catch((e) => {
        this.lastSweepError = String(e?.message || e);
        console.error(`[supervisor] sweep failed: ${this.lastSweepError}`);
      });
    }, this.config.intervalMs);
    console.log(`[supervisor] started interval=${this.config.intervalMs}ms provider=${this.config.llm.provider} model=${this.config.llm.model}`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  appendEvent(event) {
    this.events.push(event);
    if (this.events.length > this.config.eventHistoryLimit) {
      this.events = this.events.slice(this.events.length - this.config.eventHistoryLimit);
    }
    this.latestByAgent.set(event.agent, event);
    safeAppendJsonl(this.config.logFile, event);
    if (typeof this.broadcastSSE === 'function') {
      this.broadcastSSE('supervisor_audit', event);
    }
  }

  resolveCandidates() {
    const all = (typeof this.getAgents === 'function' ? this.getAgents() : []) || [];
    const rows = [];
    for (const agent of all) {
      if (!agent || !agent.name || !agent.tmux) continue;
      if (agent.online !== true) continue;
      const runtime = typeof this.getRuntime === 'function' ? (this.getRuntime(agent.name) || {}) : {};
      if (this.config.skipBlocked && runtime.blocked === true) continue;
      if (this.config.activeOnly && runtime.activeNow !== true) continue;
      rows.push({ agent, runtime });
    }
    rows.sort((a, b) => String(a.agent.name).localeCompare(String(b.agent.name)));
    return rows.slice(0, this.config.maxAgentsPerSweep);
  }

  async evaluateOne(candidate) {
    const agentName = candidate.agent.name;
    const context = collectAgentContext(this.config, agentName, candidate.agent, candidate.runtime || {});

    const now = Date.now();
    let judgment = null;
    let error = null;
    let skipped = null;

    if (!context.docs.hasCurrentTask || !context.docs.hasRole || !context.docs.hasBoundaries) {
      skipped = 'missing-doc-sections';
    } else if (context.pane.error) {
      skipped = context.pane.error;
    } else if (!context.pane.text) {
      skipped = 'empty-pane';
    }

    if (!skipped) {
      try {
        judgment = await this.judge.evaluate(context);
      } catch (e) {
        error = String(e?.message || e);
      }
    }

    const derivedStatus = judgment
      ? judgment.status
      : (skipped ? 'SKIPPED' : 'ERROR');
    const derivedDomain = judgment
      ? judgment.domain
      : 'unknown';

    const event = {
      id: `supervisor_${now}_${agentName}_${Math.random().toString(36).slice(2, 8)}`,
      ts: now,
      agent: agentName,
      sweepAt: this.lastSweepAt || now,
      status: derivedStatus,
      domain: derivedDomain,
      reason: judgment?.reason || (skipped ? `Skipped: ${skipped}` : `Judge error: ${error || 'unknown'}`),
      pattern: judgment?.pattern || null,
      suggestion: judgment?.suggestion || null,
      negative: isNegative(derivedStatus),
      skipped,
      error,
      inputHash: hashInput({
        currentTask: context.docs.currentTask,
        roleText: context.docs.roleText,
        boundariesText: context.docs.boundariesText,
        paneHash: context.pane.hash,
      }),
      pane: {
        target: context.pane.target,
        source: context.pane.source,
        hash: context.pane.hash,
      },
      workspace: {
        source: context.workspacePathSource || 'none',
        effectivePath: context.workspacePath || null,
        metaPath: context.workspacePathMeta || null,
        runtimePath: context.workspacePathRuntime || null,
        mismatch: context.workspacePathMismatch === true,
      },
      docs: {
        docsRoot: context.docs.docsRoot,
        agentsPath: context.docs.agentsPath,
        planPath: context.docs.planPath,
        hasRole: context.docs.hasRole,
        hasBoundaries: context.docs.hasBoundaries,
        hasCurrentTask: context.docs.hasCurrentTask,
        currentTask: context.docs.currentTask,
      },
      runtime: {
        blocked: context.runtime.blocked,
        blockedReason: context.runtime.blockedReason,
        activeNow: context.runtime.activeNow,
        activeDurationSec: context.runtime.activeDurationSec,
        idleDurationSec: context.runtime.idleDurationSec,
      },
      llm: judgment
        ? {
            provider: judgment.provider,
            model: judgment.model,
            usage: judgment.usage || null,
            latencyMs: judgment.latencyMs,
          }
        : null,
      action: null,
    };

    const apply = this.stateStore.applyJudgment(
      agentName,
      { status: event.status, domain: event.domain, reason: event.reason, pattern: event.pattern, suggestion: event.suggestion },
      now,
      event.id
    );

    event.state = {
      consecutiveNegative: apply.current.consecutiveNegative,
      lastWarningAt: apply.current.lastWarningAt,
      lastStatus: apply.current.lastStatus,
    };

    if (!skipped && !error && apply.shouldWarn) {
      const warning = buildWarningPayload(agentName, context, judgment, apply.current, this.config);
      if (typeof this.emitSystemInfo === 'function') {
        this.emitSystemInfo(warning.summary, warning.full);
      }
      event.action = {
        type: 'matrix_warning',
        warnedAt: now,
        summary: warning.summary,
      };
    }

    this.appendEvent(event);
    return event;
  }

  async runSweep() {
    if (!this.enabled) return;
    if (this.running) return;
    this.running = true;
    const started = Date.now();
    this.lastSweepAt = started;
    this.lastSweepError = null;

    try {
      const candidates = this.resolveCandidates();
      this.lastSweepActive = candidates.length;
      this.stateStore.clearMissingAgents(candidates.map(row => row.agent.name));

      let evaluated = 0;
      for (const row of candidates) {
        await this.evaluateOne(row);
        evaluated++;
      }
      this.lastSweepEvaluated = evaluated;
      this.stateStore.save();
    } catch (e) {
      this.lastSweepError = String(e?.message || e);
      throw e;
    } finally {
      this.lastSweepDurationMs = Date.now() - started;
      this.running = false;
    }
  }

  getStatus() {
    return {
      enabled: this.enabled,
      disabledReason: this.disabledReason,
      intervalMs: this.config.intervalMs,
      activeOnly: this.config.activeOnly,
      skipBlocked: this.config.skipBlocked,
      warnAfter: this.config.warnAfter,
      warnCooldownMs: this.config.warnCooldownMs,
      matrixInfoGroup: this.config.matrixInfoGroup,
      matrixMentions: this.config.matrixMentions,
      llm: {
        provider: this.config.llm.provider,
        model: this.config.llm.model,
        endpoint: this.config.llm.endpoint,
      },
      runtime: {
        running: this.running,
        lastSweepAt: this.lastSweepAt || null,
        lastSweepDurationMs: this.lastSweepDurationMs,
        lastSweepError: this.lastSweepError,
        lastSweepActive: this.lastSweepActive,
        lastSweepEvaluated: this.lastSweepEvaluated,
      },
      eventCount: this.events.length,
    };
  }

  getAgentSummaries() {
    const rows = [];
    for (const [agentName, snapshot] of Object.entries(this.stateStore.agents)) {
      const latest = this.latestByAgent.get(agentName) || null;
      rows.push({
        agent: agentName,
        lastStatus: snapshot.lastStatus || null,
        consecutiveNegative: Number(snapshot.consecutiveNegative) || 0,
        lastReason: snapshot.lastReason || null,
        lastDomain: snapshot.lastDomain || null,
        lastPattern: snapshot.lastPattern || null,
        lastJudgedAt: Number(snapshot.lastJudgedAt) || null,
        lastWarningAt: Number(snapshot.lastWarningAt) || null,
        latestEventId: snapshot.lastEventId || null,
        latest,
      });
    }
    rows.sort((a, b) => (b.lastJudgedAt || 0) - (a.lastJudgedAt || 0));
    return rows;
  }

  getAgentDetail(agentName, limit = 120) {
    const key = String(agentName || '').trim();
    const snapshot = this.stateStore.snapshot(key);
    const events = this.events.filter(ev => ev.agent === key).slice(-Math.max(1, Math.min(limit, 500)));
    const latest = events.length ? events[events.length - 1] : (this.latestByAgent.get(key) || null);
    return {
      agent: key,
      state: snapshot,
      latest,
      events,
    };
  }
}

export function createSupervisorService(deps) {
  return new SupervisorService(deps);
}
