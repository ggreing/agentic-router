// Phase 1 event handlers (spec 3.4, 3.5). Every event of a session runs through the session queue;
// the slow part of SubagentStop (verify commands) runs outside the queue and its result is written
// back through the queue, so parallel subagents of the same session are not held up.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ACCEPTANCE_RULE_VERSION, ACCEPT_WINDOW_PROMPTS, MAX_STEP_UPS, PRICING_PER_MTOK, RouterToolCall, dissatisfactionRule, holdoutDraw, isReask, promptSimilarity, afterEasyPass, afterOtherResult, afterRaise, atDispatch, costUsd, decideEscalation, formatTriageContext, isRouterToolName, l3SignalRoles, ladderStep,
  leadModelClass, normalizeLeadTriage, readRoleFile, redact, routerToolDef, routerToolErrorText, routerToolName, stepIndex, stepUp, triage,
  type LeadModelClass, type Level, type ReportResultInput, type ReportTriageInput, type RequestEscalationInput, type RequestScopeInput, type Role, type RouterDecision,
  type RouterEvent, type RouterToolErrorCode, type RouterToolName, type RouterToolResult, type Step, type TeamPreset, type TriageResult, type Usage,
  type VerifySignal,
} from '@agentic-router/core';
import type { ConfigFile } from './config.ts';
import { awaitsUser, classifyPrompt } from './continuation.ts';
import { takeSnapshot } from './git.ts';
import { writeJsonAtomic, type HomeLayout } from './home.ts';
import type { AcceptState, AgentRow, ClientRow, Holdout, Ledger, RequestRow, SlotRow, SubtaskReview, SubtaskRow } from './ledger.ts';
import { errorText, nullLogger, type Logger } from './log.ts';
import { cleanVerifyEnv, verifyEnv, withoutEnvValues } from './env.ts';
import { eventPayload, tailText } from './payload.ts';
import { PresetResolver } from './presets.ts';
import { crossCheck, type CrossCheck } from './proxyusage.ts';
import { checkEndState, requestChanges, requestEndState, takeRequestSnapshot, type ChangeStats, type RequestEndState, type RequestSnapshot } from './record.ts';
import { PromptMemory, acceptanceBlob, addSignal, newAcceptState, storedAcceptance } from './accept.ts';
import { LEAD_CLASSES, RELEASE_LEVELS, applyRelease, releaseChange, routingHoldoutRate, routingMode, routingView, type RoutingView } from './routing.ts';
import { BASH_NOT_FOUND, type Shell } from './shell.ts';
import { checkAgentCall, isAgentTool, managedRole, parseScope, parseTag, scopeFileBody, startStep, stepOf } from './policy.ts';
import { SessionQueue } from './queue.ts';
import { TicketStore, addGlobs, removeGlobs, sortScopeGlobs, toolUseIdOf } from './tools.ts';
import {
  readEditedPaths, readLastModel, readLeadUsage, readSubtaskTag, readTranscriptUsage, subagentTranscriptPath, waitForQuiet,
  type LeadUsage, type TranscriptUsage,
} from './transcript.ts';
import { resolveVerifyCommands } from './verify-source.ts';
import { COMMAND_TIMEOUT_MS, TOTAL_TIMEOUT_MS, isEnvFailure, runVerify, type VerifyCommand, type VerifyPlan } from './verify.ts';

export interface VerifySettings {
  commandTimeoutMs: number;
  totalTimeoutMs: number;
  /** Override of the command source (tests). Default: role file x-router.verify, project verify.json. */
  resolveCommands?: (i: { role: string; cwd: string; repoRoot?: string; baseRef?: string }) => Promise<VerifyCommand[]>;
  /** Override of the verify shell (tests). Default: verifyShell(), decision 98. */
  shell?: Shell;
}

export interface RouterOptions {
  ledger: Ledger;
  home: HomeLayout;
  config?: ConfigFile;
  logger?: Logger;
  presets?: Record<Level, TeamPreset>;
  verify?: Partial<VerifySettings>;
  secrets?: string[];
  now?: () => Date;
}

type Deferred = { deferred: () => Promise<() => RouterDecision> };
type Outcome = RouterDecision | Deferred;
interface Ctx { requestId: string | null }

const NONE: RouterDecision = {};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export interface RoleView { role: string; slot: number; step: string; model: string; effort: string; status: string; subtaskId: string | null }
export interface StatusView {
  request: null | {
    id: string; sessionId: string; level: Level; preset: string; status: string; createdAt: string;
    budgetUsd: number; usedUsd: number; leadCostUsd: number; confidence: number; source: string;
    leadDirect: boolean;               // decision 87: the lead does the work itself (L0)
    outcome: string | null;            // direct | delegated | no_delegation, set when the request closes
    presetSource: string | null;       // default | user | project | user+project (teams.yaml)
    forcedFrom: string | null;         // decision 107: the rules' level when config.forceLevel planned another
    replannedFrom: string | null;      // T6: the lead-direct level before the first router Agent call
    leadModel: string | null;          // decision 117: the lead's model when the request opened
    leadClass: string | null;          // opus | sonnet | haiku | other
  };
  roles: RoleView[];
  costUsd: number;
  /** costUsd includes estimates from task notifications (decision 84). */
  costEstimated: boolean;
  /** Some subagent costs are unknown and not in costUsd. */
  costUnknown: boolean;
  sessionCostUsd: number;
  /** Decision 97: the node, router home and port the hooks of the latest sessions report (latest 10). */
  clients: ClientRow[];
  /** Spec 3.5 step changes: a miss raises a slot one step; stepping down after easy results waits for review scores. */
  stepAdjust: { up: 'on'; down: 'on' | 'off' };
  /** Decision 138: auto-release mode, holdout share, and per lead class and level the two arms and what the rule says. */
  routing: RoutingView;
}

export class Router {
  readonly ledger: Ledger;
  readonly #home: HomeLayout;
  readonly #config: ConfigFile;
  readonly #log: Logger;
  readonly #resolver: PresetResolver;
  readonly #verify: VerifySettings;
  readonly #secrets: string[];
  readonly #now: () => Date;
  readonly #queue = new SessionQueue();
  readonly #abort = new AbortController();
  readonly #inflight = new Set<Promise<unknown>>();        // verify runs (outside the queue)
  readonly #snapshots = new Map<string, Promise<RequestSnapshot | undefined>>();   // T7: request start states being taken
  readonly #prompts = new PromptMemory();                   // decision 137: the last prompts of a session, in memory only
  readonly #tickets = new TicketStore();                    // decision 134: PreToolUse of a router tool -> its tools/call

  constructor(o: RouterOptions) {
    this.ledger = o.ledger;
    this.#home = o.home;
    this.#config = o.config ?? {};
    this.#log = o.logger ?? nullLogger;
    // review #5 (budgets) and the teams.yaml layers (decision 88 gap)
    this.#resolver = new PresetResolver({
      ...(o.presets ? { base: o.presets } : {}), homeRoot: o.home.root, log: this.#log,
      ...(this.#config.budgetsUsd ? { budgets: this.#config.budgetsUsd } : {}),
      ...(this.#config.delegateFrom ? { delegateFrom: this.#config.delegateFrom } : {}),
    });
    this.#verify = { commandTimeoutMs: COMMAND_TIMEOUT_MS, totalTimeoutMs: TOTAL_TIMEOUT_MS, ...o.verify };
    this.#secrets = o.secrets ?? [];
    this.#now = o.now ?? (() => new Date());
  }

  /** Handles one event in session order and returns what the client should do. */
  async process(ev: RouterEvent): Promise<RouterDecision> {
    const key = ev.sessionId || '_';
    const out = await this.#queue.run(key, () => this.#handle(ev));
    if (!('deferred' in out)) return out;
    const work = out.deferred();
    this.#inflight.add(work);
    let finish: () => RouterDecision;
    try {
      finish = await work;
    } finally {
      this.#inflight.delete(work);
    }
    return this.#queue.run(key, finish);
  }

  /** Resolves when no event is queued and no verification is running. */
  async drain(): Promise<void> {
    while (this.#queue.size || this.#inflight.size) {
      await Promise.allSettled([...this.#inflight]);
      await this.#queue.drain();
    }
  }

  /** Kills running verify commands (daemon shutdown); their stops are answered without a verdict. */
  abort(): void {
    this.#abort.abort();
  }

  #at(): string {
    return this.#now().toISOString();
  }

  async #handle(ev: RouterEvent): Promise<Outcome> {
    const ctx: Ctx = { requestId: null };
    if (ev.leadModel && !ev.agentId && !ev.spooled) {
      try { this.ledger.setSessionLeadModel(ev.sessionId, ev.leadModel, this.#at()); } catch { /* best effort */ }
    }
    try {
      switch (ev.type) {
        case 'prompt_submit': return this.#promptSubmit(ev, ctx);
        case 'pre_tool_use': return this.#preToolUse(ev, ctx);
        case 'subagent_start': return await this.#subagentStart(ev, ctx);
        case 'subagent_stop': return this.#subagentStop(ev, ctx);
        case 'post_tool_use': return this.#postToolUse(ev, ctx);
        case 'session_start': return this.#sessionStart(ev, ctx);
        case 'stop': return this.#stop(ev, ctx);
        case 'pre_compact': return this.#preCompact(ev, ctx);
        default: return NONE;
      }
    } catch (e) {
      this.#log.error('handler failed', { type: ev.type, sessionId: ev.sessionId, error: errorText(e) });
      return NONE;   // fail open: the client keeps working without the router
    } finally {
      this.#record(ev, ctx);
    }
  }

  #record(ev: RouterEvent, ctx: Ctx): void {
    try {
      this.ledger.insertEvent({
        sessionId: ev.sessionId, requestId: ctx.requestId, agentId: ev.agentId ?? null, type: ev.type,
        toolName: ev.toolName ?? null, receivedAt: ev.receivedAt || this.#at(), spooled: ev.spooled === true,
        payload: eventPayload(withoutEnvValues(ev.raw), this.#secrets),   // decision 99: env names only
      });
    } catch (e) {
      this.#log.error('event record failed', { type: ev.type, error: errorText(e) });
    }
  }

  // ------------------------------------------------------------------ prompt_submit

  #promptSubmit(ev: RouterEvent, ctx: Ctx): RouterDecision {
    if (ev.agentId) return NONE;
    const prompt = ev.prompt ?? '';
    const latest = this.ledger.latestRequest(ev.sessionId);
    // The adapter's promptOrigin / notification fields decide; without them the prompt prefix is checked.
    const fromAdapter = ev.notification ? true : ev.promptOrigin === undefined ? undefined : ev.promptOrigin === 'notification';
    const cls = classifyPrompt(prompt, latest, fromAdapter);
    ctx.requestId = latest?.id ?? null;
    if (cls.kind === 'command') return NONE;
    // Audit #12: a prompt replayed from the spool is history. A duplicate of a prompt already seen is
    // ignored; one older than the session's latest request is recorded as a closed request of its own
    // time and never closes the newer one or continues it.
    const promptId = str(ev.raw.prompt_id);
    if (cls.kind === 'new' && promptId && this.ledger.requestByPromptId(ev.sessionId, promptId)) return NONE;
    if (ev.spooled && latest && ev.receivedAt && latest.createdAt > ev.receivedAt) {
      if (cls.kind === 'new') this.#newRequest(ev, prompt, undefined, { createdAt: ev.receivedAt, closedAt: ev.receivedAt });
      return NONE;
    }
    if (cls.kind === 'notification') {
      // Part of the current request: no triage, no new request, no context. A request closed by the lead's
      // Stop is reopened so Agent calls made while handling the result stay in it; one awaiting the user stays so.
      if (latest?.status === 'closed') this.ledger.setRequestStatus(latest.id, 'open', this.#at());
      this.#expireStale(ev.sessionId);
      const agentId = notificationTaskId(ev, prompt);
      if (!agentId) return NONE;
      this.#notificationStatus(agentId, ev, prompt);
      this.#notificationEstimate(agentId, prompt, latest);
      // Decision 85: an async Agent result reaches the lead only now, so the subtask's verdict goes with it.
      const result = this.#subtaskResult(agentId);
      return result ? { context: result } : NONE;
    }
    if (cls.kind === 'level') return this.#routerLevel(ev, cls.level, latest, ctx);
    if ((cls.kind === 'resume' || cls.kind === 'continue') && latest) {
      if (cls.kind === 'continue') this.#acceptOnPrompt(ev, prompt, 'continue', latest.id);   // decision 137
      this.ledger.reopenRequest(latest.id, this.#at());
      // An HITL answer continues silently; /router resume re-reads the ledger into the lead's context.
      return cls.kind === 'resume' ? { context: this.#summary(latest.id, 'resumed') } : NONE;
    }
    if (latest && latest.status !== 'closed') {
      this.ledger.setRequestStatus(latest.id, 'closed', this.#at());   // superseded by the new prompt
      this.#recordClose(latest.id, ev);
    }
    this.#acceptOnPrompt(ev, prompt, 'new');   // decision 137: this prompt is in the window of the requests before it
    const req = this.#newRequest(ev, prompt);
    ctx.requestId = req.id;
    if (!ev.spooled) this.#prompts.remember(ev.sessionId, req.id, prompt, this.#now().getTime());
    const notice = !ev.spooled && req.leadClass && routingMode(this.#config) === 'on' ? this.ledger.takeReleaseNotice(req.leadClass) : undefined;   // decision 138
    return { context: this.#triageContext(req.triage, req.team, ev.cwd, req.leadModel), ...(notice ? { userMessage: notice } : {}) };
  }

  /** The brief for the lead; an uncertain triage also names the L2 team the lead would call (core). */
  #triageContext(t: TriageResult, team: TeamPreset, cwd: string | undefined, leadModel: string | null): string {
    return formatTriageContext(t, team, this.#resolver.resolve(cwd, leadModel ?? undefined).presets);   // the L2 and L3 of teams.yaml (decision 113)
  }

  /**
   * Decision 117: the lead's model for a new request: the hook input's, else the model of the main
   * transcript's latest assistant message (a /model switch shows there), else the last one a hook input
   * of the session named. Undefined: not known ('other', delegation from L2).
   */
  #leadModelFor(ev: RouterEvent): string | undefined {
    return ev.leadModel ?? readLastModel(str(ev.raw.transcript_path)) ?? this.ledger.sessionLeadModel(ev.sessionId);
  }

  /** Opens a request; a pending `/router level` of the session (kept in the ledger) applies to it and is used up. */
  #newRequest(ev: RouterEvent, prompt: string, rationale?: string, when: { createdAt?: string; closedAt?: string } = {}): RequestRow {
    const leadModel = this.#leadModelFor(ev);
    const { presets, source } = this.#resolver.resolve(ev.cwd, leadModel);
    const t = triage({ prompt, ...(ev.cwd ? { cwd: ev.cwd } : {}) }, presets);
    if (rationale) t.rationale = rationale;
    // Decision 107: a forced level (benchmarks, debugging) wins over the rules and over /router level.
    const forced = this.#config.forceLevel;
    const opened = this.ledger.tx(() => {
      const manual = forced ? undefined : this.ledger.getPendingLevel(ev.sessionId);
      const final = forced ? this.#forcedTriage(t, forced, presets) : manual ? this.#manualTriage(t, manual, presets) : t;
      const id = `r-${randomUUID()}`;
      // decision 138: a request the rules planned may be handled lead-direct on purpose (holdout, released level)
      const plan = forced || manual || ev.spooled || when.closedAt
        ? { triage: final, team: presets[final.level] }
        : this.#routingPlan(id, final, presets, leadModelClass(leadModel));
      const req = this.ledger.createRequest({
        id, sessionId: ev.sessionId, promptId: str(ev.raw.prompt_id) ?? null,
        createdAt: when.createdAt ?? (ev.spooled && ev.receivedAt ? ev.receivedAt : this.#at()),
        ...(when.closedAt ? { closedAt: when.closedAt } : {}),
        triage: plan.triage, team: plan.team, presetSource: source, leadModel: leadModel ?? null, leadClass: leadModelClass(leadModel),
        ...('holdout' in plan && plan.holdout ? { holdout: plan.holdout } : {}),
        ...(forced ? { forcedFrom: t.level } : {}),
      });
      if (!manual) return req;
      this.ledger.clearPendingLevel(ev.sessionId);
      this.ledger.setOverriddenTriage(req.id, t);
      return this.ledger.getRequest(req.id)!;
    });
    if (!when.closedAt) this.#opened(opened, ev, prompt);
    return opened;
  }

  /** T7: the work tree at the request's start (taken after the hook answers) and, opt-in, its prompt. */
  #opened(req: RequestRow, ev: RouterEvent, prompt: string): void {
    if (this.#config.recordPrompts === true && prompt) this.ledger.setRequestPrompt(req.id, redact(prompt, this.#secrets).slice(0, 16_384));
    if (ev.spooled || !ev.cwd) return;
    const snap = takeRequestSnapshot(ev.cwd).catch(e => {
      this.#log.warn('request start state not recorded', { requestId: req.id, error: errorText(e) });
      return undefined;
    });
    this.#snapshots.set(req.id, snap);
    this.#track(snap.then(s => this.#queue.run(ev.sessionId || '_', () => {
      if (s) this.ledger.setRequestSnapshot(req.id, s);
      this.#snapshots.delete(req.id);
    })));
  }

  /** Background work the daemon waits for before it closes the ledger. */
  #track(p: Promise<unknown>): void {
    const work = p.catch(e => this.#log.error('background work failed', { error: errorText(e) }));
    this.#inflight.add(work);
    void work.finally(() => this.#inflight.delete(work));
  }

  /**
   * T7: the request-end record, written each time a request closes (a request reopened by a task
   * notification and closed again is written again): the triage and its features, the plan, what changed
   * in the work tree, time, subtasks, verify failures and costs, including the lead's own usage read from
   * the main session's transcript. Runs after the hook answers.
   */
  #recordClose(requestId: string, ev: RouterEvent): void {
    const transcript = str(ev.raw.transcript_path);
    this.#track((async () => {
      const req = this.ledger.getRequest(requestId);
      if (!req) return;
      const snap = (await this.#snapshots.get(requestId)) ?? this.ledger.getRequestSnapshot<RequestSnapshot>(requestId);
      const prompts = this.ledger.promptEvents(requestId);
      const span = {
        promptIds: new Set(prompts.map(p => p.promptId).filter((x): x is string => !!x)),
        from: req.createdAt, to: req.closedAt ?? this.#at(),
      };
      await waitForQuiet(transcript);
      const [changes, lead, agents] = await Promise.all([
        snap ? requestChanges(snap).catch(e => { this.#log.warn('request changes not counted', { requestId, error: errorText(e) }); return null; }) : Promise.resolve(null),
        readLeadUsage(transcript, span),
        this.#rereadAgents(requestId, transcript),
      ]);
      // decision 137: the files this request changed, for the checks of its acceptance window
      const endState = snap ? await requestEndState(snap).catch(() => null) : null;
      await this.#queue.run(ev.sessionId || '_', () => {
        for (const a of agents) this.#applyReread(a, requestId);
        if (endState?.files.length && !this.ledger.getAcceptState(requestId)?.done) this.ledger.setEndState(requestId, endState);
        this.#writeRecord(requestId, changes, lead, prompts);
      });
    })());
  }

  /**
   * The cost of every agent of a request, read again when the request closes: a subagent whose last lines
   * came after its stop, and one that never stopped (still running, or cut off when the session ended;
   * its transcript is found next to the main one) are counted as far as their transcript goes.
   */
  async #rereadAgents(requestId: string, mainTranscript: string | undefined): Promise<Array<{ agentId: string; subtaskId: string | null; running: boolean; usage: TranscriptUsage }>> {
    const out: Array<{ agentId: string; subtaskId: string | null; running: boolean; usage: TranscriptUsage }> = [];
    for (const a of this.ledger.listAgents(requestId)) {
      const file = a.transcriptPath ?? subagentTranscriptPath(mainTranscript, a.agentId);
      if (!file || !fs.existsSync(file)) continue;
      await waitForQuiet(file, 200, 1000);
      out.push({ agentId: a.agentId, subtaskId: a.subtaskId, running: !a.stoppedAt, usage: await readTranscriptUsage(file) });
    }
    return out;
  }

  /** Replaces an agent's transcript cost when the new read found more API calls than were recorded. */
  #applyReread(a: { agentId: string; subtaskId: string | null; running: boolean; usage: TranscriptUsage }, requestId: string): void {
    if (!a.usage.ok || !a.usage.models.length) return;
    const recorded = this.ledger.listCosts(requestId).filter(c => c.agent_id === a.agentId && c.source === 'transcript').reduce((s, c) => s + Number(c.calls ?? 0), 0);
    const found = a.usage.models.reduce((s, m) => s + m.calls, 0);
    if (found <= recorded) return;
    const managed = !!a.subtaskId;
    this.#recordTranscriptCost({ type: 'subagent_stop', sessionId: '', raw: {} } as unknown as RouterEvent, a.agentId, requestId, a.subtaskId, a.usage, managed,
      a.running ? 'partial: the subagent had not stopped when the request closed' : undefined);
    this.#log.info('subagent cost read again at request close', { requestId, agentId: a.agentId, calls: { recorded, found }, running: a.running });
  }

  #writeRecord(requestId: string, changes: ChangeStats | null, lead: LeadUsage, prompts: Array<{ promptId: string | null; notification: boolean }>): void {
    const at = this.#at();
    if (lead.ok) {
      this.ledger.replaceLeadCosts(requestId, lead.models.map(m => ({
        requestId, subtaskId: null, agentId: null, source: 'lead' as const, modelId: m.modelId, calls: m.calls,
        inputTokens: m.inputTokens, outputTokens: m.outputTokens, cacheWriteTokens: m.cacheWriteTokens, cacheReadTokens: m.cacheReadTokens,
        usd: m.usd, createdAt: at, ...(m.usd === null ? { note: `unknown: no price for model ${m.modelId}` } : {}),
      })));
      if (lead.matchedBy === 'time' && prompts.some(p => p.promptId)) {
        this.#log.warn('lead usage: none of the request\'s prompt ids is in the transcript; matched by time instead', { requestId });
      }
    } else {
      this.#log.warn('lead usage not recorded', { requestId, reason: lead.reason });
    }
    const r = this.ledger.getRequest(requestId);
    if (!r) return;
    const subs = this.ledger.listSubtasks(requestId);
    const costs = this.ledger.listCosts(requestId);
    const proxy = this.#proxyCosts(requestId);   // decision 130: proxy rows are the cost source when there are any
    const subCost = (id: string) => round6(costs.filter(c => c.subtask_id === id && proxy.counts(String(c.source)) && c.usd !== null)
      .reduce((a, c) => a + Number(c.usd), 0));
    // the rules' own judgement: not a manual /router level and not the T6 re-plan
    type Judged = TriageResult & { kind?: string; rule?: string; teamScore?: number; l3Signs?: boolean; features?: Record<string, unknown> };
    const all = [r.overriddenTriage, r.replannedFrom, r.triage].filter((x): x is TriageResult => !!x) as Judged[];
    const judged = all.find(t => t.source !== 'manual' && !/^re-planned at L[23]/.test(t.rationale)) ?? (r.triage as Judged);
    const extras = this.ledger.requestExtras(requestId);
    const closedAt = r.closedAt ?? at;
    const durationMs = Math.max(0, Date.parse(closedAt) - Date.parse(r.createdAt));
    const flags = this.ledger.costFlags(requestId);
    const outcome = r.outcome ?? (subs.length ? 'delegated' : r.team.leadDirect ? 'direct' : 'no_delegation');
    const notifications = prompts.filter(p => p.notification).length;
    const acceptance = this.#acceptAtClose(requestId, changes, subs.length);   // decision 137
    const record = {
      version: 1,
      triage: {
        kind: judged.kind ?? null, level: r.forcedFrom ?? judged.level, confidence: judged.confidence, source: judged.source,
        rule: judged.rule ?? null, teamScore: judged.teamScore ?? null, l3Signs: judged.l3Signs ?? null, taskType: judged.taskType, rationale: judged.rationale,
      },
      features: judged.features ?? null,
      plan: {
        level: r.level, preset: r.preset, leadDirect: r.team.leadDirect === true, presetSource: r.presetSource, budgetUsd: r.budgetUsd,
        forcedFrom: r.forcedFrom, replannedFrom: r.replannedFrom?.level ?? null,
        manualLevel: [r.triage, r.replannedFrom, r.overriddenTriage].find(t => t?.source === 'manual')?.level ?? null,
        leadModel: r.leadModel, leadClass: r.leadClass,
        holdout: r.holdout,   // decision 138
      },
      acceptance: acceptanceBlob(acceptance, ACCEPTANCE_RULE_VERSION),
      outcome,
      changes,
      time: { durationMs, activeMs: Math.max(0, durationMs - extras.awaitingMs), awaitingMs: extras.awaitingMs },
      turns: { prompts: prompts.length, notifications, continuations: Math.max(0, prompts.length - 1 - notifications) },
      subtasks: subs.map(s => ({
        id: s.id, role: s.role, slot: s.slot, step: s.step, upCount: s.upCount, status: s.status, verdict: s.verdict, attempts: s.attempts, costUsd: subCost(s.id),
        ...(s.review ? { review: { verdict: s.review.verdict, by: s.review.by } } : {}),
      })),
      // decision 135: where each slot ended, with the raises that still count and its step-downs
      slots: this.ledger.getSlots(requestId).map(x => ({ role: x.role, slot: x.slot, step: x.step, ups: x.upCount, downs: x.downCount })),
      // decision 127: the lead's own size judgement (router_report_triage), a label for calibrating the triage
      ...((lt) => (lt ? { leadTriage: lt } : {}))(this.ledger.getLeadTriage<Record<string, unknown>>(requestId)),
      verifyFailures: this.ledger.listAgents(requestId).reduce((a, x) => a + x.failCount, 0),
      runningAtClose: subs.filter(s => s.status === 'running' || s.status === 'pending').map(s => s.id),
      lead: lead.ok
        ? { calls: lead.calls, model: lead.leadModel, models: lead.models, usd: round6(r.leadCostUsd), matchedBy: lead.matchedBy }
        : { calls: null, model: null, models: [], usd: null, reason: lead.reason },
      costs: {
        subtaskUsd: round6(r.usedUsd), leadUsd: lead.ok || proxy.source === 'proxy' ? round6(r.leadCostUsd) : null, totalUsd: round6(r.usedUsd + r.leadCostUsd),
        estimated: flags.estimated, unknown: flags.unknown, budgetExceeded: r.usedUsd > r.budgetUsd,
        source: proxy.source, ...(proxy.crossCheck.length ? { crossCheck: proxy.crossCheck } : {}),
      },
    };
    this.ledger.upsertRecord({
      requestId, sessionId: r.sessionId, createdAt: r.createdAt, closedAt, kind: record.triage.kind, level: record.triage.level, finalLevel: r.level,
      outcome, changedFiles: changes?.changedFiles ?? null, linesAdded: changes?.linesAdded ?? null, linesRemoved: changes?.linesRemoved ?? null,
      durationMs, activeMs: record.time.activeMs, subtaskUsd: record.costs.subtaskUsd, leadUsd: record.costs.leadUsd, totalUsd: record.costs.totalUsd,
      record, prompt: extras.prompt, acceptance: storedAcceptance(acceptance), acceptSignals: acceptance.signals,
    });
    this.#evaluateRelease(r.leadClass);   // decision 138
  }

  #manualTriage(base: TriageResult, level: Level, presets: Record<Level, TeamPreset>): TriageResult {
    const p = presets[level];
    return withKind({
      ...base, level, source: 'manual', confidence: 1, preset: p.id, budgetUsd: p.budgetUsd,
      rationale: `manual level via /router level (rule result was ${base.level}, source=${base.source}, confidence=${base.confidence.toFixed(2)})`,
    }, p);
  }

  /** Decision 107: the request is planned at the forced level; the rules' result stays in the rationale. */
  #forcedTriage(base: TriageResult, level: Level, presets: Record<Level, TeamPreset>): TriageResult {
    const p = presets[level];
    return withKind({
      ...base, level, preset: p.id, budgetUsd: p.budgetUsd,
      rationale: `forced ${level}; rule said ${base.level} (source=${base.source}, confidence=${base.confidence.toFixed(2)}): ${base.rationale}`,
    }, p);
  }

  /**
   * `/router level <L>` (decision): with a request in progress in this session (open or
   * awaiting the user), re-plan it at <L> (manual triage, new preset and budget; the replaced triage is
   * kept) and inject the new team brief; running subtasks keep their step, new Agent calls use the new
   * steps. Without one, <L> applies to the next request of the session.
   */
  #routerLevel(ev: RouterEvent, level: Level | null, latest: RequestRow | undefined, ctx: Ctx): RouterDecision {
    if (!level) return { userMessage: '[agentic-router] usage: /router level L0|L1|L2|L3' };
    if (latest && latest.status !== 'closed') {
      const { presets } = this.#resolver.resolve(ev.cwd, latest.leadModel ?? undefined);
      const t = this.#manualTriage(latest.triage, level, presets);
      const team = presets[level];
      this.ledger.replanRequest(latest.id, t, team);
      this.ledger.reopenRequest(latest.id, this.#at());
      ctx.requestId = latest.id;
      return {
        context: [
          this.#triageContext(t, team, ev.cwd, latest.leadModel),
          `[agentic-router] level set manually to ${level} for request ${latest.id} (was ${latest.level}). Subtasks already running keep their step; new Agent calls must use the steps above.`,
        ].join('\n'),
      };
    }
    this.ledger.setPendingLevel(ev.sessionId, level, this.#at());
    return { context: `[agentic-router] /router level ${level}: no request is in progress, so the next request in this session will run at level ${level} (manual).` };
  }

  /**
   * T6: re-plans a lead-direct request as a team request (preset, budget); the triage it had is kept for
   * learning. Decision 113: the first call picks the level: a role whose start step differs between the L2
   * and L3 teams (core l3SignalRoles, the same list the brief gives the lead) called at its L3 start step
   * means L3; anything else means L2 (a call that matches neither team is then denied against L2). An L3
   * team that is lead-direct is never chosen.
   */
  #escalate(req: RequestRow, ev: RouterEvent, role: Role, model: string | undefined, effort: string | undefined, onlyL3 = false): RequestRow {
    const { presets } = this.#resolver.resolve(ev.cwd, req.leadModel ?? undefined);
    const asked = stepOf(model, effort)?.step;
    const signals = presets.L3.leadDirect ? [] : l3SignalRoles(onlyL3 ? req.team : presets.L2, presets.L3);
    const level: Level = asked && signals.includes(role) && asked === startStep(presets.L3, 'L3', role) ? 'L3' : 'L2';
    if (onlyL3 && level !== 'L3') return req;   // a team request stays at its level
    return this.#replanAs(req, level, presets, `the lead called a router subagent (${role} at ${asked ?? 'an unknown step'}) in a lead-direct ${req.level} request`);
  }

  /** The one place a request moves up to a team level: by the lead's first Agent call, or by router_report_triage. */
  #replanAs(req: RequestRow, level: Level, presets: Record<Level, TeamPreset>, why: string): RequestRow {
    const team = presets[level];
    const t = withKind({
      ...req.triage, level, preset: team.id, budgetUsd: team.budgetUsd,
      rationale: `re-planned at ${level}: ${why} (${req.triage.rationale})`,
    }, team);
    this.#log.info('request re-planned as a team request', { requestId: req.id, from: req.level, to: level });
    return this.ledger.escalateRequest(req.id, t, team);
  }

  /**
   * Decision 119: an L2 team request whose triage saw L3 signs (planned as L2) may still become L3 on its
   * first Agent call; not one set by /router level or config.forceLevel.
   */
  #offersL3(req: RequestRow): boolean {
    return (req.triage as { l3Signs?: unknown }).l3Signs === true && req.level === 'L2' && req.triage.source !== 'manual'
      && !req.forcedFrom && !req.replannedFrom && this.ledger.listSubtasks(req.id).length === 0;
  }

  /** The request an Agent call belongs to; when the prompt was missed (daemon restart) a default one is opened. */
  #currentRequest(ev: RouterEvent): RequestRow {
    const latest = this.ledger.latestRequest(ev.sessionId);
    if (latest && latest.status !== 'closed') return latest;
    return this.#newRequest(ev, '', 'no prompt seen by the router for this turn: default team');
  }

  // ------------------------------------------------------------------ pre_tool_use (Agent)

  #preToolUse(ev: RouterEvent, ctx: Ctx): RouterDecision {
    if (isRouterToolName(ev.toolName)) return this.#preRouterTool(ev, ctx);
    if (ev.agentId || !isAgentTool(ev.toolName)) {
      ctx.requestId = this.ledger.latestRequest(ev.sessionId)?.id ?? null;
      return NONE;   // subagent tool calls are checked by guard.mjs
    }
    const input = obj(ev.toolInput);
    const agentType = str(input.subagent_type);
    const role = managedRole(agentType);
    if (role === undefined) return NONE;
    let req = this.#currentRequest(ev);
    ctx.requestId = req.id;
    const prompt = str(input.prompt);
    const deny = (reason: string): RouterDecision => {
      this.#log.info('agent call denied', { requestId: req.id, reason });
      return { deny: { reason: `[agentic-router] ${reason}` } };
    };
    if (role === null) return deny(`unknown router agent type "${agentType}". Use agentic-router:architect, ui-designer, coder, reviewer or tester.`);
    const tag = parseTag(prompt);
    if (!tag) {
      return deny('the Agent prompt must start with "[subtask:<ID>]" on its first line (ID: letters, digits, "_", "-", "."; for example "[subtask:A1]"). '
        + 'Optionally put "[scope: <glob>, <glob>]" on the second line to set the files the subagent may edit.');
    }
    const scope = parseScope(prompt);
    if (!scope.ok) return deny(`subtask ${tag}: ${scope.reason}`);
    // Audit #12: the same Agent call seen twice (a spooled copy of an event already handled) is not dispatched again.
    const toolUseId = str(ev.raw.tool_use_id);
    if (toolUseId && this.ledger.subtaskByToolUseId(ev.sessionId, toolUseId)) return NONE;
    this.#expireStale(ev.sessionId);
    // T6 (decisions 104-111): the lead of a lead-direct request decided to delegate: the request becomes
    // a team request at L2, and this call is checked against the L2 team like any other.
    if (req.team.leadDirect) req = this.#escalate(req, ev, role, str(input.model), str(input.effort));
    // decision 119: an automatic L3 is planned with the L2 team; its brief offers the L3 team, which the
    // lead takes by making its first call at the L3 start step of a signal role
    else if (this.#offersL3(req)) req = this.#escalate(req, ev, role, str(input.model), str(input.effort), true);

    const subtasks = this.ledger.listSubtasks(req.id);
    const active = (s: SubtaskRow) => s.status === 'pending' || s.status === 'running';
    // Audit #10: a tag is busy while it runs in any request of the session (scope files are keyed by
    // session and tag). A subtask of this request that was allowed but never started may be re-dispatched.
    const neverStarted = (s: SubtaskRow) => s.requestId === req.id && s.status === 'pending' && !s.agentId;
    const tagBusy = this.ledger.activeSubtasksInSession(ev.sessionId).some(s => s.id === tag && !neverStarted(s));
    const check = checkAgentCall({
      tag, role, level: req.level, preset: req.team, budgetUsd: req.budgetUsd, spentUsd: req.usedUsd,
      fableOptIn: this.#config.fableOptIn === true,
      busySlots: subtasks.filter(s => s.role === role && active(s) && s.id !== tag).map(s => s.slot),
      tagBusy,
      slotSteps: Object.fromEntries(this.ledger.getSlots(req.id).filter(x => x.role === role).map(x => [x.slot, x.step])),
      ...(str(input.model) ? { model: str(input.model)! } : {}),
      ...(str(input.effort) ? { effort: str(input.effort)! } : {}),
    });
    if (!check.ok) return ev.spooled ? NONE : deny(check.reason);

    // Compatibility #9: without its scope file the guard cannot hold the subagent to its scope, so the call
    // is denied (written first, so a failed write leaves no pending subtask behind).
    // decision 129: protected paths granted to this subtask id after a user turn stay granted for a new attempt
    const granted = this.ledger.getSubtask(req.id, tag)?.protectedGranted ?? [];
    try {
      writeJsonAtomic(this.#home.scopeFile(ev.sessionId, tag), scopeBody(scope.allowed, scope.unscoped, granted));
    } catch (e) {
      this.#log.error('scope file not written', { sessionId: ev.sessionId, subtask: tag, error: errorText(e) });
      if (!ev.spooled) return deny(`subtask ${tag}: the router could not write its scope file (${errorText(e).slice(0, 120)}); try the call again.`);
    }
    this.ledger.dispatchSubtask({
      requestId: req.id, id: tag, role, slot: check.slot, step: check.step, writeScope: scope.allowed,
      unscoped: scope.unscoped, agentType: agentType!, toolUseId: str(ev.raw.tool_use_id) ?? null, at: this.#at(),
    });
    this.#slotDispatched(req.id, role, check.slot);   // step-down (decision 135)
    return NONE;
  }

  // ------------------------------------------------------------------ subagent_start

  async #subagentStart(ev: RouterEvent, ctx: Ctx): Promise<RouterDecision> {
    const agentId = ev.agentId;
    if (!agentId) return NONE;
    const known = this.ledger.getAgent(agentId);
    // Decision 99: the toolchain variables the relay forwarded from this subagent's hook environment.
    const env = cleanVerifyEnv(ev.raw.verifyEnv ?? (ev as { verifyEnv?: unknown }).verifyEnv);
    if (known) {
      if (env) this.ledger.updateAgent(agentId, { verifyEnv: env });
      // With async Agent runs, PostToolUse(Agent) ("async_launched") can arrive before SubagentStart and has
      // already confirmed the pairing (integration run 3, E2). The start state belongs to this event: keep
      // the cwd and take the work-tree snapshot now, so the stop check has its baseline.
      ctx.requestId = known.requestId;
      if (!known.snapshot || !known.cwd) {
        const snapshot = ev.cwd && !known.snapshot && !ev.spooled ? await takeSnapshot(ev.cwd).catch(() => undefined) : undefined;
        this.ledger.updateAgent(agentId, {
          ...(ev.cwd && !known.cwd ? { cwd: ev.cwd } : {}),
          ...(ev.agentType && !known.agentType ? { agentType: ev.agentType } : {}),
          ...(snapshot ? { snapshot } : {}),
        });
      }
      const sub = known.requestId && known.subtaskId ? this.ledger.getSubtask(known.requestId, known.subtaskId) : undefined;
      if (sub) {
        if (sub.status === 'pending') this.ledger.updateSubtask(sub.requestId, sub.id, { status: 'running' }, this.#at());
        this.#writeAgentFile(agentId, ev.sessionId, sub);
      }
      return NONE;
    }
    const role = managedRole(ev.agentType);
    const base = { agentId, sessionId: ev.sessionId, agentType: ev.agentType ?? null, cwd: ev.cwd ?? null, startedAt: this.#at() };
    if (role === undefined || role === null) {
      ctx.requestId = this.ledger.latestRequest(ev.sessionId)?.id ?? null;
      this.ledger.insertAgent({ ...base, requestId: ctx.requestId, subtaskId: null, role: null, slot: null, step: null, snapshot: null, pairing: 'unmanaged' });
      return NONE;
    }
    // Audit #11: an agent pairs with a pending subtask of the session's current request only.
    // Audit E16: by the tag in its own transcript when that is already readable, else by start order.
    const current = this.ledger.latestRequest(ev.sessionId)?.id;
    const tag = readSubtaskTag(str(ev.raw.agent_transcript_path));
    const tagged = tag && current ? this.ledger.getSubtask(current, tag) : undefined;
    const byTag = tagged && tagged.status === 'pending' && !tagged.agentId && tagged.agentType === ev.agentType ? tagged : undefined;
    const sub = byTag ?? (current ? this.ledger.nextPendingSubtask(ev.sessionId, ev.agentType!, current) : undefined);
    // Audit #12: a replayed start comes after the fact; the tree now is not the start state (baseline unknown).
    const snapshot = ev.cwd && !ev.spooled ? await takeSnapshot(ev.cwd).catch(() => undefined) : undefined;
    if (!sub) {
      ctx.requestId = this.ledger.latestRequest(ev.sessionId)?.id ?? null;
      this.ledger.insertAgent({ ...base, requestId: ctx.requestId, subtaskId: null, role, slot: null, step: null, snapshot: snapshot ?? null, pairing: 'unmatched' });
      if (env) this.ledger.updateAgent(agentId, { verifyEnv: env });
      this.#log.warn('subagent started without a pending subtask', { agentId, agentType: ev.agentType });
      return NONE;
    }
    ctx.requestId = sub.requestId;
    this.ledger.insertAgent({ ...base, requestId: sub.requestId, subtaskId: sub.id, role: sub.role, slot: sub.slot, step: sub.step, snapshot: snapshot ?? null, pairing: byTag ? 'confirmed' : 'order' });
    if (env) this.ledger.updateAgent(agentId, { verifyEnv: env });
    this.ledger.updateSubtask(sub.requestId, sub.id, { agentId, status: 'running' }, this.#at());
    this.#writeAgentFile(agentId, ev.sessionId, sub);
    return NONE;
  }

  /** Audit E16: re-pairs an agent with the subtask its transcript's tag names (same request, same agent type, still active). */
  #pairByTag(agent: AgentRow, transcript: string | undefined): AgentRow | undefined {
    if (!agent.requestId || agent.pairing === 'unmanaged') return undefined;
    const tag = readSubtaskTag(transcript);
    if (!tag || tag === agent.subtaskId) return undefined;
    const sub = this.ledger.getSubtask(agent.requestId, tag);
    if (!sub || (sub.status !== 'pending' && sub.status !== 'running') || (agent.agentType && sub.agentType !== agent.agentType)) return undefined;
    this.#rebind(agent, sub, 'transcript tag');
    if (sub.status === 'pending') this.ledger.updateSubtask(sub.requestId, sub.id, { status: 'running' }, this.#at());
    return this.ledger.getAgent(agent.agentId);
  }

  /**
   * Spec 3.5: two failures in a row (a miss) raise the slot one ladder step; the next Agent call for that
   * slot must use it. After MAX_STEP_UPS raises (or at the top step) a further miss goes to the user.
   * Stepping down after easy results needs review scores and is not done yet.
   */
  #stepUpAfterMiss(requestId: string, sub: SubtaskRow, at: string, verdict: 'miss' | 'rejected' = 'miss'): void {
    const state = this.ledger.getSlots(requestId).find(x => x.role === sub.role && x.slot === sub.slot);
    const ups = state?.upCount ?? 0;
    const next = ups < MAX_STEP_UPS ? stepUp(sub.step, this.#config.fableOptIn === true) : null;
    if (!next) {
      this.ledger.updateSubtask(requestId, sub.id, { status: 'hitl', verdict }, at);
      this.#log.warn('miss with no step left to try: the user decides', { requestId, subtaskId: sub.id, step: sub.step, ups, verdict });
      return;
    }
    this.#raiseSlot(requestId, sub.role, sub.slot, next, ups + 1, at);
    this.ledger.updateSubtask(requestId, sub.id, { status: 'failed', verdict, upCount: ups + 1 }, at);
    this.#log.info('slot raised after a miss', { requestId, subtaskId: sub.id, role: sub.role, slot: sub.slot, from: sub.step, to: next, verdict });
  }

  /** Spec 3.5: the step a slot now runs at after this subtask's miss, for the lead's next call. */
  #raisedNote(sub: SubtaskRow): string {
    const state = this.ledger.getSlots(sub.requestId).find(x => x.role === sub.role && x.slot === sub.slot);
    if (!state || state.step === sub.step) return '';
    const st = ladderStep(state.step);
    if (stepIndex(state.step) < stepIndex(sub.step)) {
      return ` The ${sub.role} slot ${sub.slot} now runs one step lower, at ${state.step} (model="${st.alias}", effort="${st.effort}"), after two easy results: its next subtask must use these values.`;
    }
    return ` The ${sub.role} slot ${sub.slot} now runs one step higher, at ${state.step} (model="${st.alias}", effort="${st.effort}"): a new attempt must use these values.`;
  }

  /** Moves an agent to another subtask of its request (the order-based pairing was wrong). */
  #rebind(agent: AgentRow, sub: SubtaskRow, by: string): void {
    const at = this.#at();
    this.#log.warn('pairing repaired', { agentId: agent.agentId, from: agent.subtaskId, to: sub.id, by });
    if (agent.subtaskId) this.ledger.unbindSubtaskAgent(sub.requestId, agent.subtaskId, agent.agentId, at);
    this.ledger.updateAgent(agent.agentId, { subtaskId: sub.id, role: sub.role, slot: sub.slot, step: sub.step, pairing: 'confirmed' });
    if (sub.agentId !== agent.agentId) this.ledger.updateSubtask(sub.requestId, sub.id, { agentId: agent.agentId }, at);
    this.#writeAgentFile(agent.agentId, agent.sessionId, sub);
  }

  #writeAgentFile(agentId: string, sessionId: string, sub: SubtaskRow): void {
    // Audit #10: the agent's own scope, so the guard needs no (session, tag) lookup once the pair is known.
    // Audit E16: `pairing` says how the pair was found. 'order' (start order only) can be wrong for foreground
    // calls that start out of order, so the guard prefers the transcript's tag while it says 'order'.
    const pairing = this.ledger.getAgent(agentId)?.pairing === 'confirmed' ? 'confirmed' : 'order';
    try {
      writeJsonAtomic(this.#home.agentFile(agentId), {
        sessionId, subtaskId: sub.id, role: sub.role, slot: sub.slot, step: sub.step, pairing, scope: scopeBody(sub.writeScope, sub.unscoped, sub.protectedGranted),
      });
    } catch (e) {
      // the guard falls back to the transcript tag and the scope file
      this.#log.error('agent file not written', { agentId, subtask: sub.id, error: errorText(e) });
    }
  }

  // ------------------------------------------------------------------ subagent_stop

  /**
   * Every stop: the subagent's cost is read from its transcript (decision #4; spooled stops too, the file
   * outlives the agent). Router subagents on a live stop are also verified and may be blocked. Both run
   * outside the queue; the results are written back through it.
   */
  #subagentStop(ev: RouterEvent, ctx: Ctx): Outcome {
    const agentId = ev.agentId;
    if (!agentId) return NONE;
    let agent = this.ledger.getAgent(agentId);
    // Audit E16: the order-based pairing is checked against the subagent's own transcript before verify.
    if (agent && !ev.spooled && agent.pairing !== 'confirmed') agent = this.#pairByTag(agent, ev.agentTranscriptPath) ?? agent;
    const requestId = agent?.requestId ?? this.ledger.latestRequest(ev.sessionId)?.id ?? null;
    ctx.requestId = requestId;
    const managed = !!agent?.requestId && !!agent.subtaskId;
    const sub = managed ? this.ledger.getSubtask(agent!.requestId!, agent!.subtaskId!) : undefined;
    const cwd = ev.cwd ?? agent?.cwd ?? undefined;
    // Replayed after an outage: the agent is long gone, nothing to verify or block.
    const plan = !ev.spooled && agent && sub && cwd ? this.#planVerify(agent, sub, cwd) : undefined;
    if (ev.spooled && agent) this.ledger.updateAgent(agentId, { stoppedAt: this.#at() });
    if (agent && ev.agentTranscriptPath) this.ledger.updateAgent(agentId, { transcriptPath: ev.agentTranscriptPath });
    return {
      deferred: async () => {
        // verify first: by then Claude Code has written the subagent's last lines (measurement, decision 107 runs)
        const signals = plan ? await this.#runPlan(plan, sub!, agent!, ev.agentTranscriptPath) : undefined;
        await waitForQuiet(ev.agentTranscriptPath);
        const usage = await readTranscriptUsage(ev.agentTranscriptPath);
        return () => {
          this.#recordTranscriptCost(ev, agentId, requestId, agent?.subtaskId ?? null, usage, managed);
          if (signals && plan) return this.#finishStop(ev, agentId, signals, plan);
          if (ev.spooled && managed) this.#markUnverified(agentId);
          return NONE;
        };
      },
    };
  }

  #recordTranscriptCost(ev: RouterEvent, agentId: string, requestId: string | null, subtaskId: string | null, usage: TranscriptUsage, managed: boolean, extraNote?: string): void {
    try {
      const at = this.#at();
      const base = { requestId, subtaskId, agentId, source: 'transcript' as const, createdAt: at };
      let reason = usage.ok ? (usage.models.length ? '' : 'no assistant usage in the transcript') : usage.reason;
      if (reason && !managed && !ev.agentTranscriptPath) {
        this.#log.warn('subagent cost not recorded', { agentId, reason });   // an internal agent without a transcript path
        return;
      }
      // Audit #14: a model without a price is estimated on its own (its tokens at the step model's output
      // rate, an over-estimate); the priced models' exact cost stays next to it.
      const agentRow = this.ledger.getAgent(agentId);
      const fallbackModel = agentRow?.step ? ladderStep(agentRow.step).modelId : agentRow?.resolvedModel ?? MOST_EXPENSIVE_MODEL;
      const rows = usage.ok && usage.models.length
        ? usage.models.map(m => {
          const row = {
            ...base, modelId: m.modelId, calls: m.calls, inputTokens: m.inputTokens, outputTokens: m.outputTokens,
            cacheWriteTokens: m.cacheWriteTokens, cacheReadTokens: m.cacheReadTokens, usd: m.usd,
          };
          if (m.usd !== null) return row;
          const tokens = m.inputTokens + m.outputTokens + m.cacheWriteTokens + m.cacheReadTokens;
          const est = outputRateEstimate(fallbackModel, tokens);
          return est === null
            ? { ...row, note: `unknown: no price for model ${m.modelId}` }
            : { ...row, source: 'estimate' as const, usd: est, note: `estimated: model ${m.modelId} has no price; ${tokens} tokens at the ${fallbackModel} output rate` };
        })
        : [{ ...base, modelId: null, calls: 0, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, usd: null, note: `unknown: ${reason}` }];
      if (!reason && rows.some(r => r.usd === null)) reason = 'model without a price';
      if (rows.some(r => r.source === 'estimate')) this.#log.warn('part of a subagent cost estimated: a model without a price', { agentId, requestId });
      if (extraNote) for (const r of rows) (r as { note?: string }).note = (r as { note?: string }).note ? `${(r as { note?: string }).note}; ${extraNote}` : extraNote;
      // Decision 84: an estimate from the task notification stays until a readable transcript replaces it.
      if (reason && this.ledger.agentCostState(agentId) === 'estimate') {
        this.#log.warn('subagent transcript unreadable: keeping the notification estimate', { agentId, requestId, reason });
        return;
      }
      this.ledger.replaceAgentCosts(agentId, rows);
      if (reason) this.#log.warn('subagent cost unknown: not counted in the budget until an estimate or the transcript arrives', { agentId, requestId, reason });
    } catch (e) {
      this.#log.error('transcript cost failed', { agentId, error: errorText(e) });
    }
  }

  /**
   * Decision 84: when a subagent's transcript could not give its cost (or has not been read yet), the task
   * notification's `<subagent_tokens>N` is priced as N output tokens of the step's model, the most expensive
   * rate, so the estimate errs high. A cost already known from the transcript is left alone.
   */
  #notificationEstimate(agentId: string, prompt: string, latest: RequestRow | undefined): void {
    try {
      const tokens = Number(/<subagent_tokens>\s*(\d+)\s*<\/subagent_tokens>/.exec(prompt)?.[1] ?? NaN);
      if (!Number.isFinite(tokens)) return;
      const state = this.ledger.agentCostState(agentId);
      if (state === 'actual') return;
      const agent = this.ledger.getAgent(agentId);
      const modelId = agent?.step ? ladderStep(agent.step).modelId : agent?.resolvedModel ?? null;
      const usd = modelId ? outputRateEstimate(modelId, tokens) : null;
      if (usd === null) {
        this.#log.warn('notification tokens without a priced model: cost stays unknown', { agentId, modelId, tokens });
        return;
      }
      const requestId = agent?.requestId ?? latest?.id ?? null;
      this.ledger.replaceAgentCosts(agentId, [{
        requestId, subtaskId: agent?.subtaskId ?? null, agentId, source: 'estimate', modelId, calls: 0,
        inputTokens: 0, outputTokens: tokens, cacheWriteTokens: 0, cacheReadTokens: 0, usd, createdAt: this.#at(),
        note: `estimated from notification tokens: ${tokens} subagent tokens at the ${modelId} output rate (no readable transcript${state === 'none' ? ' yet' : ''})`,
      }]);
      this.#log.warn('subagent cost estimated from the task notification', { agentId, requestId, tokens, usd });
    } catch (e) {
      this.#log.error('notification estimate failed', { error: errorText(e) });
    }
  }

  /** One line for the lead: the subtask's latest verification and cost, or undefined when no subtask is bound. */
  #subtaskResult(agentId: string): string | undefined {
    const agent = this.ledger.getAgent(agentId);
    if (!agent?.requestId || !agent.subtaskId) return undefined;
    const sub = this.ledger.getSubtask(agent.requestId, agent.subtaskId);
    if (!sub) return undefined;
    const st = ladderStep(sub.step);
    const head = `[agentic-router] subtask ${sub.id} (${sub.role} @${sub.step}, model=${st.alias}, effort=${st.effort})`;
    const signals = this.ledger.listSignals(agent.requestId, sub.id).filter(x => x.agentId === agentId && x.attempt === agent.stopCount);
    const checks = signals.map(x => `${x.kind} ${!x.ok ? 'failed' : /: skipped \(/.test(x.detail ?? '') ? 'skipped' : 'ok'}`).join(', ');
    const scope = signals.find(x => x.kind === 'scope');
    const files = /(\d+) file\(s\) changed/.exec(scope?.detail ?? '')?.[1];
    const tree = agent.snapshot?.isolated === false ? 'working tree' : agent.snapshot?.isolated ? 'worktree' : undefined;
    const where = [files !== undefined ? `${files} file(s)` : undefined, tree].filter(Boolean).join(', ');
    const state = this.ledger.agentCostState(agentId);
    const { usd, partlyEstimated: partly } = this.ledger.agentCostUsd(agentId);   // proxy rows first (decision 130)
    const cost = state === 'actual' ? (partly ? `cost ~$${usd.toFixed(4)} (partly estimated)` : `cost $${usd.toFixed(4)}`)
      : state === 'estimate' ? `cost ~$${usd.toFixed(4)} (estimated)` : state === 'unknown' ? 'cost unknown' : '';
    const tail = `${where ? ` (${where})` : ''}${cost ? `; ${cost}` : ''}`;
    const firstFailure = signals.find(x => !x.ok)?.detail?.split('\n')[0]?.slice(0, 200);
    switch (sub.status) {
      case 'passed':
        // Decision 87: tell the lead not to spend a turn re-running what the router already ran.
        return `${head}: verify passed — ${checks || 'no checks configured'}${tail} (already verified by the router; no need to re-run).`;
      case 'failed':
        if (sub.verdict === 'rejected') {
          return `${head}: its result was reported as wrong (review by ${sub.review?.by ?? 'the lead'})${tail}.` + this.#raisedNote(sub) + ' Decide: dispatch a new attempt with what was wrong, or report to the user.';
        }
        if (!signals.length) {
          return `${head}: the subagent ended with an error before it finished; verify did not run${tail}. Decide: dispatch a new attempt or report to the user.`;
        }
        return `${head}: verify failed again after one fix attempt (miss) — ${checks}${firstFailure ? `. First failure: ${firstFailure}` : ''}${tail}.`
          + this.#raisedNote(sub) + ' Decide: dispatch a new attempt with what failed, or report to the user.';
      case 'hitl': {
        if (sub.verdict === 'held') {
          if (signals.some(x => x.detail?.includes(`: held, ${BASH_NOT_FOUND}`))) {
            return `${head}: verify held: ${BASH_NOT_FOUND}; the verify commands did not run${tail}. Tell the user.`;
          }
          const files = signals.map(x => /: held, (.+?) changed since the subtask started/.exec(x.detail ?? '')?.[1]).find(Boolean);
          return `${head}: verify held: ${files ?? 'its inputs'} changed; ask the user to confirm before running${tail}.`;
        }
        if (sub.verdict === 'unverified') {
          const env = signals.filter(isEnvFailure).map(x => (x.detail ?? '').split('; verify cannot run')[0]);
          if (env.length) {
            return `${head}: verify could not run in this environment (${env.join('; ')}); this is not counted as a failure, check the result yourself before relying on it${tail}.`;
          }
          return `${head}: verify did not run (router was offline); check the result yourself before relying on it${tail}.`;
        }
        if (sub.verdict === 'rejected') {
          return `${head}: its result was reported as wrong and the slot has no raise left (${MAX_STEP_UPS} step-ups or the top step)${tail}. Ask the user how to continue (spec 3.5).`;
        }
        if (sub.verdict === 'miss') {
          return `${head}: verify failed again at step ${sub.step} after ${MAX_STEP_UPS} step-ups — ${checks}${tail}. Ask the user how to continue (spec 3.5).`;
        }
        return `${head}: needs the user's decision before it can continue${tail}.`;
      }
      case 'cancelled':
        return `${head}: the subagent was stopped before it finished; verify did not run${tail}. Its slot is free; dispatch it again if it is still needed.`;
      default:
        return sub.verdict === 'fail_once'
          ? `${head}: verification failed once and the subagent was asked to fix it; no final result yet${tail}.`
          : `${head}: no verification result yet (status ${sub.status})${tail}.`;
    }
  }

  #planVerify(agent: AgentRow, sub: SubtaskRow, cwd: string): VerifyPlan {
    const root = agent.snapshot?.root;
    // Audit #6: a sibling's scope excuses a change in the shared tree only if that sibling could have made
    // it: it has an explicit scope (not the whole repo), a role that writes, and it ran at the same time.
    const now = this.#at();
    const overlaps = (a: AgentRow) => a.startedAt <= now && (a.stoppedAt ?? now) >= agent.startedAt;
    const shared = root
      ? this.ledger.listAgents(agent.requestId!)
        .filter(a => a.agentId !== agent.agentId && a.subtaskId && a.snapshot?.root === root && overlaps(a))
        .map(a => this.ledger.getSubtask(agent.requestId!, a.subtaskId!))
        .filter((s): s is SubtaskRow => !!s && !s.unscoped && this.#roleWrites(s.role))
        .flatMap(s => s.writeScope)
      : [];
    return {
      cwd, ...(root ? { root } : {}), commands: [], secrets: this.#secrets, signal: this.#abort.signal,
      env: verifyEnv(agent.verifyEnv ?? undefined),
      commandTimeoutMs: this.#verify.commandTimeoutMs, totalTimeoutMs: this.#verify.totalTimeoutMs,
      ...(this.#verify.shell ? { shell: this.#verify.shell } : {}),
      scope: {
        allowed: sub.writeScope, protected: scopeFileBody([], false).protected, unscoped: sub.unscoped,
        ...(sub.protectedGranted.length ? { protectedGranted: sub.protectedGranted } : {}),   // decision 129
        snapshot: agent.snapshot, ...(shared.length ? { sharedAllowed: [...new Set(shared)] } : {}),
      },
    };
  }

  async #runPlan(plan: VerifyPlan, sub: SubtaskRow, agent: AgentRow, transcript: string | undefined): Promise<VerifySignal[]> {
    try {
      const root = agent.snapshot?.root;
      const baseRef = agent.snapshot?.head;
      // Audit #9: in the user's checkout, out-of-scope changes count only when this subagent's edit tools made them.
      if (plan.scope && root && agent.snapshot?.isolated === false) {
        const edited = await readEditedPaths(transcript, root);
        if (edited) plan.scope.editedPaths = edited;
      }
      const src = { role: sub.role, cwd: plan.cwd, ...(root ? { repoRoot: root } : {}), ...(baseRef ? { baseRef } : {}) };
      if (this.#verify.resolveCommands) plan.commands = await this.#verify.resolveCommands(src);
      else {
        const r = await resolveVerifyCommands({ ...src, ...(this.#config.pluginDir ? { pluginDir: this.#config.pluginDir } : {}) });
        plan.commands = r.commands;
        if (r.warning) this.#log.warn('verify source', { subtaskId: sub.id, warning: r.warning });
      }
      return await runVerify(plan);
    } catch (e) {
      return [{ kind: 'tool_error', ok: false, detail: `verification could not run: ${tailText(errorText(e), 500, this.#secrets)}` }];
    }
  }

  #finishStop(ev: RouterEvent, agentId: string, signals: VerifySignal[], plan: VerifyPlan): RouterDecision {
    const ctx: Ctx = { requestId: null };
    try {
      if (this.#abort.signal.aborted) return NONE;
      const agent = this.ledger.getAgent(agentId);
      if (!agent || !agent.requestId || !agent.subtaskId) return NONE;
      ctx.requestId = agent.requestId;
      const sub = this.ledger.getSubtask(agent.requestId, agent.subtaskId);
      if (!sub) return NONE;
      const at = this.#at();
      const attempt = agent.stopCount + 1;
      this.ledger.insertSignals({ requestId: agent.requestId, subtaskId: sub.id, agentId, attempt, at }, signals);
      if (signals.some(x => x.kind === 'scope' && x.detail?.startsWith('no start snapshot'))) {
        this.#log.warn('scope check without a start snapshot: uncommitted changes are reported, not failed', { agentId, subtaskId: sub.id });
      }
      const outcome = plan.outcome ?? {};
      // Audit #9: what the verify commands wrote is not the subagent's on the next stop.
      if (outcome.artifacts && agent.snapshot) {
        this.ledger.updateAgent(agentId, { snapshot: { ...agent.snapshot, artifacts: { ...agent.snapshot.artifacts, ...outcome.artifacts } } });
      }
      if (outcome.gitBlocked) this.#log.warn('git metadata or attributes changed during the subtask: git and verify were not run', { agentId, subtaskId: sub.id });
      // Decision 91: the verify inputs changed, so the commands were held; neither pass nor miss, the user decides.
      const scopeFailed = signals.some(x => x.kind === 'scope' && !x.ok);
      // Decision 98: no bash to run the commands in: held the same way, the user decides.
      if ((outcome.held || outcome.noShell) && !scopeFailed) {
        this.ledger.updateAgent(agentId, { stopCount: attempt, stoppedAt: at });
        this.ledger.updateSubtask(agent.requestId, sub.id, { status: 'hitl', verdict: 'held' }, at);
        if (outcome.noShell) this.#log.warn('verify held: no bash to run the commands in', { agentId, subtaskId: sub.id });
        else this.#log.warn('verify held: its inputs changed during the subtask', { agentId, subtaskId: sub.id, files: outcome.held });
        return NONE;
      }
      // Decision 122: a check that could not run here (a tool is missing) is not the subagent's failure.
      const failed = signals.filter(x => !x.ok && !isEnvFailure(x));
      if (!failed.length && signals.some(isEnvFailure)) {
        this.ledger.updateAgent(agentId, { stopCount: attempt, stoppedAt: at });
        this.ledger.updateSubtask(agent.requestId, sub.id, { status: 'hitl', verdict: 'unverified' }, at);
        this.#log.warn('verify could not run in this environment: subtask left unverified', { agentId, subtaskId: sub.id, commands: outcome.envMissing });
        return NONE;
      }
      if (!failed.length) {
        this.ledger.updateAgent(agentId, { stopCount: attempt, stoppedAt: at });
        this.ledger.updateSubtask(agent.requestId, sub.id, { status: 'passed', verdict: 'meet' }, at);
        return NONE;
      }
      const fails = agent.failCount + 1;
      if (fails === 1 && ev.stopHookActive !== true) {
        this.ledger.updateAgent(agentId, { stopCount: attempt, failCount: fails });
        this.ledger.updateSubtask(agent.requestId, sub.id, { verdict: 'fail_once' }, at);
        return { block: { reason: blockReason(sub.id, failed, agent.snapshot?.isolated === false) } };
      }
      this.ledger.updateAgent(agentId, { stopCount: attempt, failCount: fails, stoppedAt: at });
      this.#stepUpAfterMiss(agent.requestId, sub, at);
      return NONE;
    } catch (e) {
      this.#log.error('subagent_stop finish failed', { agentId, error: errorText(e) });
      return NONE;
    }
  }

  /** Decision 89: a router subagent's stop replayed from the spool was never verified; the lead is told. */
  #markUnverified(agentId: string): void {
    const agent = this.ledger.getAgent(agentId);
    if (!agent?.requestId || !agent.subtaskId) return;
    const sub = this.ledger.getSubtask(agent.requestId, agent.subtaskId);
    if (!sub || (sub.status !== 'pending' && sub.status !== 'running')) return;
    this.ledger.updateSubtask(agent.requestId, sub.id, { status: 'hitl', verdict: 'unverified' }, this.#at());
    this.#log.warn('router subagent finished while the router was offline: not verified', { agentId, subtaskId: sub.id });
  }

  // ------------------------------------------------------------------ post_tool_use (Agent)

  #postToolUse(ev: RouterEvent, ctx: Ctx): RouterDecision {
    if (ev.agentId || !isAgentTool(ev.toolName)) {
      ctx.requestId = this.ledger.latestRequest(ev.sessionId)?.id ?? null;
      return NONE;
    }
    const resp = obj(ev.toolResponse);
    const input = obj(ev.toolInput);
    const agentId = str(resp.agentId);
    const tag = parseTag(str(resp.prompt) ?? str(input.prompt));
    const at = this.#at();
    let agent = agentId ? this.ledger.getAgent(agentId) : undefined;
    const requestId = agent?.requestId ?? this.ledger.latestRequest(ev.sessionId)?.id ?? null;
    ctx.requestId = requestId;
    if (managedRole(str(input.subagent_type)) === undefined && !agent?.subtaskId) {
      if (agent && str(resp.resolvedModel)) this.ledger.updateAgent(agent.agentId, { resolvedModel: str(resp.resolvedModel)! });   // for a notification estimate
      this.#recordUsage(resp, requestId, null, agentId ?? null, at);
      return NONE;
    }
    // Confirm (or repair) the order-based pairing with the tag the result carries.
    const sub = tag && requestId ? this.ledger.getSubtask(requestId, tag) : undefined;
    if (agentId && sub) {
      if (!agent) {
        this.ledger.insertAgent({
          agentId, sessionId: ev.sessionId, requestId, subtaskId: sub.id, agentType: str(resp.agentType) ?? sub.agentType,
          role: sub.role, slot: sub.slot, step: sub.step, cwd: null, snapshot: null, pairing: 'confirmed', startedAt: at,
        });
        this.#writeAgentFile(agentId, ev.sessionId, sub);   // the guard needs it before the subagent's first tool call
      } else if (agent.subtaskId !== sub.id) {
        this.#rebind(agent, sub, 'Agent result');
      } else {
        this.ledger.updateAgent(agentId, { pairing: 'confirmed' });
      }
      if (sub.agentId !== agentId) this.ledger.updateSubtask(requestId!, sub.id, { agentId }, at);
      agent = this.ledger.getAgent(agentId);
    }
    if (agentId) {
      this.ledger.updateAgent(agentId, {
        ...(str(resp.resolvedModel) ? { resolvedModel: str(resp.resolvedModel)! } : {}),
        ...(str(resp.worktreeBranch) ? { worktreeBranch: str(resp.worktreeBranch)! } : {}),
        ...(str(resp.worktreePath) ? { worktreePath: str(resp.worktreePath)! } : {}),
      });
    }
    this.#recordUsage(resp, requestId, sub?.id ?? agent?.subtaskId ?? null, agentId ?? null, at);
    return NONE;
  }

  /**
   * PostToolUse(Agent) usage covers the last API call only (and is absent for async runs): kept as an
   * 'agent_result' row to cross-check the transcript cost, never added to usedUsd (decision #4).
   */
  #recordUsage(resp: Record<string, unknown>, requestId: string | null, subtaskId: string | null, agentId: string | null, at: string): void {
    const usage = resp.usage;
    if (!usage || typeof usage !== 'object') return;
    const u = usage as Usage;
    const modelId = str(resp.resolvedModel) ?? null;
    const usd = modelId ? costUsd(modelId, u) : null;
    this.ledger.addCost({
      requestId, subtaskId, agentId, source: 'agent_result', modelId, calls: 1,
      inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0, cacheReadTokens: u.cache_read_input_tokens ?? 0,
      usd, createdAt: at,
    });
  }

  // ------------------------------------------------------------------ session_start / stop

  #sessionStart(ev: RouterEvent, ctx: Ctx): RouterDecision {
    this.#recordClient(ev);
    const latest = this.ledger.latestRequest(ev.sessionId);
    ctx.requestId = latest?.id ?? null;
    if (ev.source === 'resume' && !ev.spooled) this.#acceptOnTurnEnd(ev.sessionId, false);   // decision 137
    if (!latest || (ev.source !== 'compact' && ev.source !== 'resume')) return NONE;
    if (latest.status === 'closed') return NONE;   // audit #13: nothing in progress to restore
    return { context: this.#summary(latest.id, ev.source === 'compact' ? 'after compaction' : 'resumed session') };
  }

  #stop(ev: RouterEvent, ctx: Ctx): RouterDecision {
    if (ev.agentId) return NONE;
    const latest = this.ledger.latestRequest(ev.sessionId);
    ctx.requestId = latest?.id ?? null;
    this.#expireStale(ev.sessionId);
    if (!ev.spooled) this.#acceptOnTurnEnd(ev.sessionId, true);   // decision 137
    if (!latest || latest.status === 'closed') return NONE;
    // Audit #13: a turn the lead spent on a task notification does not answer an open question to the user.
    if (latest.status === 'awaiting_user' && this.#turnStartedByNotification(ev.sessionId)) return NONE;
    const next = awaitsUser(ev.lastAssistantMessage) ? 'awaiting_user' : 'closed';   // decision 56
    this.ledger.setRequestStatus(latest.id, next, this.#at());
    if (next === 'closed') {
      // Decision 87: a lead-direct request (L0) that ends without subtasks finished as planned.
      const delegated = this.ledger.listSubtasks(latest.id).length > 0;
      this.ledger.setOutcome(latest.id, delegated ? 'delegated' : latest.team.leadDirect ? 'direct' : 'no_delegation');
      this.#recordClose(latest.id, ev);
    }
    return NONE;
  }

  readonly #roleTools = new Map<string, { mtimeMs: number; writes: boolean }>();

  /**
   * Decision 103 (audit #6): whether a role can write files, from its role file's `tools`
   * (<pluginDir>/agents/<role>.md, core readRoleFile). No tools line = all tools (Claude Code), so it writes.
   * A role file that cannot be read counts as read-only: an unknown sibling never excuses a change.
   */
  #roleWrites(role: string): boolean {
    const dir = this.#config.pluginDir;
    if (!dir) return false;
    const file = path.join(dir, 'agents', `${role}.md`);
    try {
      const { mtimeMs } = fs.statSync(file);
      const hit = this.#roleTools.get(file);
      if (hit?.mtimeMs === mtimeMs) return hit.writes;
      const tools = readRoleFile(file).tools.map(x => x.replace(/\(.*$/, '').trim());
      const writes = tools.length === 0 || tools.some(x => EDIT_TOOLS.has(x));
      this.#roleTools.set(file, { mtimeMs, writes });
      return writes;
    } catch (e) {
      this.#log.warn('role file unreadable: its subagents do not excuse changes of siblings', { role, error: errorText(e) });
      return false;
    }
  }

  /** Decision 97: the relay's routerClient from SessionStart (what the hooks of this session see). */
  #recordClient(ev: RouterEvent): void {
    const c = ev.raw.routerClient;
    if (!c || typeof c !== 'object' || Array.isArray(c)) return;
    const o = c as Record<string, unknown>;
    const text = (v: unknown) => (typeof v === 'string' && v.length <= 1024 ? v : null);
    const port = typeof o.port === 'number' && Number.isInteger(o.port) && o.port > 0 && o.port < 65536 ? o.port : null;
    try {
      this.ledger.setClient({
        sessionId: ev.sessionId, node: text(o.node), nodeVersion: text(o.nodeVersion), routerHome: text(o.routerHome), port,
        seenAt: ev.spooled && ev.receivedAt ? ev.receivedAt : this.#at(),   // a replayed start keeps its own time
      });
    } catch (e) {
      this.#log.warn('router client not recorded', { sessionId: ev.sessionId, error: errorText(e) });
    }
  }

  /** Whether the session's latest prompt was a task notification (read from the recorded events). */
  #turnStartedByNotification(sessionId: string): boolean {
    const payload = this.ledger.lastEventPayload(sessionId, 'prompt_submit');
    if (!payload) return false;
    try {
      return classifyPrompt(String((JSON.parse(payload) as { prompt?: unknown }).prompt ?? '')).kind === 'notification';
    } catch {
      return false;
    }
  }

  /** Audit #11: a subtask the router allowed but whose subagent never started is cancelled after a while. */
  #expireStale(sessionId: string): void {
    const before = new Date(this.#now().getTime() - STALE_PENDING_MS).toISOString();
    const gone = this.ledger.cancelStalePending(sessionId, before, this.#at());
    if (gone.length) this.#log.warn('subtasks allowed but never started were cancelled', { sessionId, subtasks: gone });
  }

  /** Audit #11: a notification that the subagent was killed or failed ends its subtask (verify never ran). */
  #notificationStatus(agentId: string, ev: RouterEvent, prompt: string): void {
    const status = (ev.notification?.status ?? /<status>\s*([^<\s]+)\s*<\/status>/.exec(prompt)?.[1] ?? '').toLowerCase();
    const ended = status === 'killed' || status === 'stopped' || status === 'cancelled' ? 'cancelled'
      : status === 'failed' || status === 'error' ? 'failed' : undefined;
    if (!ended) return;
    const agent = this.ledger.getAgent(agentId);
    if (!agent?.requestId || !agent.subtaskId) return;
    const sub = this.ledger.getSubtask(agent.requestId, agent.subtaskId);
    if (!sub || (sub.status !== 'pending' && sub.status !== 'running')) return;
    this.ledger.updateSubtask(agent.requestId, sub.id, { status: ended }, this.#at());
    this.ledger.updateAgent(agentId, { stoppedAt: this.#at() });
  }

  // ------------------------------------------------------------------ pre_compact

  /**
   * Spec 3.6: just before compaction, leave the ledger state; the hook's plain stdout is also the
   * compaction guidance. Only while a request is in progress (open or awaiting the user); session_start
   * (compact) re-injects the full summary afterwards.
   */
  #preCompact(ev: RouterEvent, ctx: Ctx): RouterDecision {
    const r = this.ledger.latestRequest(ev.sessionId);
    ctx.requestId = r?.id ?? null;
    if (!r || r.status === 'closed') return NONE;
    const subs = this.ledger.listSubtasks(r.id);
    const shown = subs.slice(-MAX_COMPACT_SUBTASKS);
    const open = subs.filter(s => s.status === 'pending' || s.status === 'running');
    const line = (s: SubtaskRow) => {
      const st = ladderStep(s.step);
      const scope = s.unscoped ? 'whole repo' : s.writeScope.join(', ');
      return `  - ${s.id}: ${s.role}#${s.slot} @${s.step} (model=${st.alias}, effort=${st.effort}) ${s.status}${s.verdict ? `/${s.verdict}` : ''}; scope: ${scope}`;
    };
    return {
      context: [
        'Agentic Router: keep this team state in the compacted summary.',
        `- Request ${r.id}: level ${r.level} (source=${r.triage.source}), preset ${r.preset}, budget $${r.budgetUsd}, spent $${r.usedUsd.toFixed(4)}.`,
        ...(subs.length ? ['- Subtasks (ID: role#slot @step (model, effort) status; scope):', ...shown.map(line)] : ['- No subtasks dispatched yet.']),
        ...(subs.length > shown.length ? [`  (${subs.length - shown.length} earlier subtasks omitted)`] : []),
        open.length ? `- Unfinished: ${open.map(s => s.id).join(', ')}. Keep their IDs, roles, steps and scopes so they can be continued.` : '- All dispatched subtasks are finished.',
        '- Keep the Agent prompt format exactly: first line [subtask:<ID>], second line [scope: <glob>, <glob>], with the model and effort of the subtask\'s step.',
      ].join('\n'),
    };
  }

  // ------------------------------------------------------------------ router tools (decisions 127-129, 134)

  /**
   * PreToolUse of a router MCP tool: lead only. A call from the main session leaves a ticket under its
   * tool-use id (the tools/call that follows carries the same id) and is allowed without a prompt; a call
   * from inside a subagent is denied and gets no ticket.
   */
  #preRouterTool(ev: RouterEvent, ctx: Ctx): RouterDecision {
    ctx.requestId = this.ledger.latestRequest(ev.sessionId)?.id ?? null;
    if (ev.agentId) return { deny: { reason: routerToolErrorText('not_lead') } };
    if (ev.spooled) return NONE;
    const toolUseId = str(ev.raw.tool_use_id);
    const tool = routerToolName(ev.toolName);
    if (toolUseId && tool) this.#tickets.add(toolUseId, ev.sessionId, tool, this.#now().getTime());
    return { allow: { reason: '[agentic-router] router tool call by the lead' } };
  }

  /**
   * One call of a router MCP tool, as the plugin's server posts it. The session comes from the ticket its
   * PreToolUse left (decision 134); without a tool-use id only router_get_plan is answered, for the session
   * the server was started in, and says so. Runs in the session's queue like a hook event. Never throws.
   */
  async tool(body: unknown): Promise<RouterToolResult> {
    const parsed = RouterToolCall.safeParse(body);
    if (!parsed.success) return toolError('invalid_input', 'the call is malformed.');
    const call = parsed.data;
    const def = routerToolDef(call.tool);
    if (!def) return toolError('unknown_tool');
    const toolUseId = toolUseIdOf(call.meta);
    let sessionId = toolUseId ? this.#tickets.redeem(toolUseId, def.name, this.#now().getTime()) : undefined;
    let boundBy: 'ticket' | 'spawn_session' = 'ticket';
    if (!sessionId && !toolUseId && def.name === 'router_get_plan' && call.bind.spawnSessionId) {
      sessionId = call.bind.spawnSessionId;
      boundBy = 'spawn_session';
    }
    if (!sessionId) return toolError('not_bound');
    const input = def.input.safeParse(call.input ?? {});
    if (!input.success) {
      return toolError('invalid_input', input.error.issues.slice(0, 5).map(i => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ').slice(0, 400));
    }
    const sid = sessionId;
    return this.#queue.run(sid, () => {
      const ctx: Ctx = { requestId: null };
      let out: RouterToolResult;
      try {
        out = this.#runTool(def.name, input.data, { sessionId: sid, cwd: call.bind.projectDir, boundBy }, ctx);
      } catch (e) {
        this.#log.error('router tool failed', { tool: def.name, sessionId: sid, error: errorText(e) });
        out = toolError('internal');
      }
      try {
        this.ledger.insertEvent({
          sessionId: sid, requestId: ctx.requestId, agentId: null, type: 'tool_call', toolName: def.name, receivedAt: this.#at(), spooled: false,
          payload: eventPayload({ tool: def.name, input: input.data, ok: out.ok, ...(out.ok ? {} : { code: out.code }), boundBy }, this.#secrets),
        });
      } catch (e) {
        this.#log.error('tool call record failed', { tool: def.name, error: errorText(e) });
      }
      return out;
    });
  }

  #runTool(name: RouterToolName, input: unknown, bind: ToolBinding, ctx: Ctx): RouterToolResult {
    if (name === 'router_get_plan') return this.#toolPlan(bind, ctx);
    const req = this.ledger.latestRequest(bind.sessionId);
    if (!req || req.status === 'closed') return toolError('no_request');
    ctx.requestId = req.id;
    switch (name) {
      case 'router_report_triage': return this.#toolReportTriage(req, input as ReportTriageInput, bind);
      case 'router_report_result': return this.#toolReportResult(req, input as ReportResultInput);
      case 'router_request_escalation': return this.#toolEscalation(req, input as RequestEscalationInput);
      case 'router_request_scope': return this.#toolScope(req, input as RequestScopeInput);
      default: return toolError('unknown_tool');
    }
  }

  /** What a slot's next Agent call must use. */
  #slotView(requestId: string, role: Role, slot: number, fallback: Step) {
    const state = this.ledger.getSlots(requestId).find(x => x.role === role && x.slot === slot);
    const step = state?.step ?? fallback;
    const st = ladderStep(step);
    const upCount = state?.upCount ?? 0;
    return { role, slot, step, model: st.alias, effort: st.effort, upCount, upsLeft: Math.max(0, MAX_STEP_UPS - upCount) };
  }

  /** router_get_plan: the ledger's view of the session's latest request. Read-only; opens nothing. */
  #toolPlan(bind: ToolBinding, ctx: Ctx): RouterToolResult {
    const view = this.status(bind.sessionId);
    if (!view.request) return { ok: true, result: { request: null, boundBy: bind.boundBy } };
    const r = view.request;
    ctx.requestId = r.id;
    const row = this.ledger.getRequest(r.id);
    const slots = this.ledger.getSlots(r.id);
    return {
      ok: true,
      result: {
        requestId: r.id,
        request: {
          id: r.id, level: r.level, preset: r.preset, leadDirect: r.leadDirect, status: r.status, budgetUsd: r.budgetUsd, usedUsd: r.usedUsd,
          source: r.source, l3Signs: (row?.triage as { l3Signs?: unknown } | undefined)?.l3Signs === true,
        },
        roles: view.roles.map(x => {
          const upCount = slots.find(y => y.role === x.role && y.slot === x.slot)?.upCount ?? 0;
          return { ...x, upCount, upsLeft: Math.max(0, MAX_STEP_UPS - upCount) };
        }),
        subtasks: this.ledger.listSubtasks(r.id).slice(-MAX_PLAN_SUBTASKS).map(s => ({
          id: s.id, role: s.role, slot: s.slot, step: s.step, status: s.status, verdict: s.verdict, attempts: s.attempts,
          scope: s.unscoped ? null : s.writeScope, unscoped: s.unscoped, protectedGranted: s.protectedGranted,
          review: s.review ? { verdict: s.review.verdict, by: s.review.by } : null,
        })),
        pendingUser: this.ledger.listConfirmations(r.id).map(c => ({ kind: c.kind, subtaskId: c.subtaskId })),
        boundBy: bind.boundBy,
      },
    };
  }

  /**
   * router_report_triage: the lead's size judgement, kept on the request as a label for calibrating the
   * triage (decisions 109, 111), before the first subtask only. A judgement larger than the plan re-plans the
   * request exactly where the lead's first Agent call would (decisions 113, 119), through the same function,
   * so the Agent call that follows finds a team request and does not re-plan again.
   */
  #toolReportTriage(req: RequestRow, raw: ReportTriageInput, bind: ToolBinding): RouterToolResult {
    if (this.ledger.listSubtasks(req.id).length) return toolError('too_late');
    const v = normalizeLeadTriage(raw);
    this.ledger.setLeadTriage(req.id, { ...v, at: this.#at(), plannedLevel: req.level, plannedLeadDirect: req.team.leadDirect === true });
    let now = req;
    if (v.kind === 'team') {
      const { presets } = this.#resolver.resolve(bind.cwd, req.leadModel ?? undefined);
      const wantL3 = v.level === 'L3' && !presets.L3.leadDirect;
      const why = `the lead judged the request as ${v.level} (about ${v.files} file${v.files === 1 ? '' : 's'}, confidence ${v.confidence.toFixed(2)})`;
      if (req.team.leadDirect) {
        const level: Level = wantL3 ? 'L3' : 'L2';
        if (!presets[level].leadDirect) now = this.#replanAs(req, level, presets, `${why} in a lead-direct ${req.level} request`);
      } else if (wantL3 && this.#offersL3(req)) {
        now = this.#replanAs(req, 'L3', presets, why);
      }
    }
    const replanned = now.level !== req.level || now.team.leadDirect !== req.team.leadDirect;
    return {
      ok: true,
      result: {
        requestId: req.id, recorded: true, replanned, level: now.level, preset: now.preset, leadDirect: now.team.leadDirect === true, budgetUsd: now.budgetUsd,
        ...(replanned ? { brief: this.#triageContext(now.triage, now.team, bind.cwd, now.leadModel) } : {}),
      },
    };
  }

  #reviewSignal(req: RequestRow, sub: SubtaskRow, review: SubtaskReview, extra: { issues?: number | undefined; categories?: readonly string[] | undefined }, at: string): void {
    const agent = sub.agentId ? this.ledger.getAgent(sub.agentId) : undefined;
    const detail = [
      `${review.verdict} by ${review.by}${review.bySubtaskId ? ` (subtask ${review.bySubtaskId})` : ''}`,
      ...(extra.issues !== undefined ? [`issues ${extra.issues}`] : []),
      ...(extra.categories?.length ? [`categories ${extra.categories.join(', ')}`] : []),
      ...(review.margin ? [`margin ${review.margin}`] : []),
    ].join('; ');
    this.ledger.insertSignals({ requestId: req.id, subtaskId: sub.id, agentId: sub.agentId ?? null, attempt: agent?.stopCount ?? sub.attempts, at },
      [{ kind: 'review', ok: review.verdict === 'accept', detail }]);
  }

  /**
   * A reject of a finished subtask: failed, whatever verify said, and one failure of its slot. Two in a row
   * raise the slot like a verify miss does (same function, same 3-raise limit). An accept ends the streak; a
   * verify pass alone does not, since the reject that matters here comes after a pass.
   */
  #applyReject(req: RequestRow, sub: SubtaskRow, review: SubtaskReview, extra: { issues?: number | undefined; categories?: readonly string[] | undefined }, at: string): { raisedTo?: Step; atLimit: boolean } {
    this.ledger.updateSubtask(req.id, sub.id, { status: 'failed', verdict: 'rejected', review }, at);
    this.#reviewSignal(req, sub, review, extra, at);
    this.#otherResult(req.id, sub, at);   // step-down (decision 135): a reject ends an easy streak
    const slot = this.ledger.getSlots(req.id).find(x => x.role === sub.role && x.slot === sub.slot);
    if (slot && slot.step !== sub.step) return { atLimit: false };   // the slot was raised since this attempt ran
    const streak = (slot?.failStreak ?? 0) + 1;
    if (streak < REJECTS_FOR_RAISE) {
      this.ledger.setSlotCounters(req.id, sub.role, sub.slot, sub.step, { failStreak: streak }, at);
      return { atLimit: false };
    }
    this.#stepUpAfterMiss(req.id, sub, at, 'rejected');
    const after = this.ledger.getSlots(req.id).find(x => x.role === sub.role && x.slot === sub.slot);
    if (after && after.step !== sub.step) return { raisedTo: after.step, atLimit: false };
    this.ledger.setSlotCounters(req.id, sub.role, sub.slot, sub.step, { failStreak: 0 }, at);
    return { atLimit: true };
  }

  /** router_report_result: the judgement of a finished subtask by the lead, or by a reviewer or tester subtask. */
  #toolReportResult(req: RequestRow, i: ReportResultInput): RouterToolResult {
    const sub = this.ledger.getSubtask(req.id, i.subtaskId);
    if (!sub) return toolError('unknown_subtask');
    if (sub.status === 'pending' || sub.status === 'running') return toolError('not_finished');
    if (sub.status === 'cancelled') return toolError('not_allowed', 'the subtask was cancelled; there is no result to judge.');
    if (i.by !== 'lead') {
      const judge = this.ledger.getSubtask(req.id, i.bySubtaskId!);
      if (!judge) return toolError('unknown_subtask', `no subtask ${i.bySubtaskId} in the current request.`);
      if (judge.role !== i.by) return toolError('not_allowed', `subtask ${judge.id} is a ${judge.role}, not a ${i.by}.`);
      const finished = judge.status === 'passed' || (judge.status === 'hitl' && (judge.verdict === 'held' || judge.verdict === 'unverified'));
      if (!finished) return toolError('not_allowed', `subtask ${judge.id} must be finished without a failure of its own before its verdict counts.`);
    }
    const at = this.#at();
    const review: SubtaskReview = { verdict: i.verdict, by: i.by, ...(i.bySubtaskId ? { bySubtaskId: i.bySubtaskId } : {}), ...(i.margin ? { margin: i.margin } : {}), at };
    const extra = { issues: i.issues, categories: i.categories };
    let raisedTo: Step | undefined;
    let steppedDownTo: Step | undefined;
    let atLimit = false;
    if (i.verdict === 'accept') {
      this.ledger.updateSubtask(req.id, sub.id, { review }, at);
      this.#reviewSignal(req, sub, review, extra, at);
      if (this.ledger.getSlots(req.id).some(x => x.role === sub.role && x.slot === sub.slot)) {
        this.ledger.setSlotCounters(req.id, sub.role, sub.slot, sub.step, { failStreak: 0 }, at);
      }
      steppedDownTo = this.#acceptedResult(req, sub, review, at);   // step-down (decision 135)
    } else if (sub.review?.verdict === 'reject') {
      // the same attempt judged again (a reviewer after the lead): the judgement is replaced, the failure is not counted twice
      this.ledger.updateSubtask(req.id, sub.id, { review }, at);
      this.#reviewSignal(req, sub, review, extra, at);
    } else {
      ({ raisedTo, atLimit } = { raisedTo: undefined, ...this.#applyReject(req, sub, review, extra, at) });
    }
    const after = this.ledger.getSubtask(req.id, sub.id)!;
    return {
      ok: true,
      result: {
        requestId: req.id, subtaskId: sub.id, recorded: true, verdict: i.verdict, by: i.by, status: after.status,
        raised: raisedTo !== undefined, ...(steppedDownTo ? { steppedDown: true } : {}), slot: this.#slotView(req.id, sub.role, sub.slot, sub.step),
        next: i.verdict === 'accept' ? 'none' : atLimit ? 'ask_user' : raisedTo ? 'retry_at_raised_step' : 'retry_at_same_step',
        ...(i.verdict === 'reject' && !raisedTo && !atLimit ? { escalation: 'router_request_escalation can raise the slot before the next attempt' } : {}),
      },
    };
  }

  /** Whether the user sent a prompt after the lead's request was answered needs_user (decisions 128, 129). */
  #userTurn(req: RequestRow, kind: 'escalation' | 'scope', subtaskId: string, confirmed: boolean | undefined): boolean {
    if (confirmed !== true) return false;
    const pending = this.ledger.getConfirmation(req.id, kind, subtaskId);
    return !!pending && this.ledger.userPromptAfter(req.sessionId, pending.afterEventId);
  }

  /**
   * router_request_escalation (decision 128): raise a finished subtask's slot one step without waiting for a
   * second failure. The request counts as the lead's reject when none was reported. The grant rule is core's
   * decideEscalation; a granted raise moves the slot exactly as a miss does, so the next Agent call for it is
   * checked against the new step and the 3-raise limit is shared.
   */
  #toolEscalation(req: RequestRow, i: RequestEscalationInput): RouterToolResult {
    let sub = this.ledger.getSubtask(req.id, i.subtaskId);
    if (!sub) return toolError('unknown_subtask');
    if (sub.status === 'pending' || sub.status === 'running') return toolError('not_finished');
    if (sub.status === 'cancelled') return toolError('not_allowed', 'the subtask was cancelled; dispatch it again instead.');
    const at = this.#at();
    const granted = (how: string): RouterToolResult => {
      this.ledger.clearConfirmation(req.id, 'escalation', i.subtaskId);
      return { ok: true, result: { requestId: req.id, subtaskId: i.subtaskId, granted: true, how, from: sub!.step, ...this.#slotView(req.id, sub!.role, sub!.slot, sub!.step) } };
    };
    const slotOf = () => this.ledger.getSlots(req.id).find(x => x.role === sub!.role && x.slot === sub!.slot);
    if (stepIndex(slotOf()?.step ?? sub.step) > stepIndex(sub.step)) return granted('already_raised');
    let atLimit = false;
    if (sub.review?.verdict !== 'reject') {
      const r = this.#applyReject(req, sub, { verdict: 'reject', by: 'lead', at }, {}, at);
      if (r.raisedTo) return granted('second_failure');
      atLimit = r.atLimit;
      sub = this.ledger.getSubtask(req.id, i.subtaskId)!;
    }
    const slot = slotOf();
    const step = slot?.step ?? sub.step;
    const upCount = slot?.upCount ?? 0;
    const fableOptIn = this.#config.fableOptIn === true;
    const d = atLimit
      ? { granted: false as const, code: 'needs_user' as const, why: 'limit' as const }
      : decideEscalation({
        step, upCount, fableOptIn, evidence: sub.review?.verdict === 'reject' && sub.review.by !== 'lead' ? 'independent' : 'lead',
        leadOnlyRaises: slot?.leadRaises ?? 0, userTurn: this.#userTurn(req, 'escalation', sub.id, i.userConfirmed),
      });
    if (d.granted) {
      this.#raiseSlot(req.id, sub.role, sub.slot, d.to, upCount + 1, at);
      if (d.leadOnly) this.ledger.setSlotCounters(req.id, sub.role, sub.slot, d.to, { leadRaises: (slot?.leadRaises ?? 0) + 1 }, at);
      this.ledger.updateSubtask(req.id, sub.id, { upCount: upCount + 1 }, at);
      this.#log.info('slot raised on request', { requestId: req.id, subtaskId: sub.id, role: sub.role, slot: sub.slot, from: step, to: d.to, reason: i.reason, leadOnly: d.leadOnly });
      return granted(d.leadOnly ? 'lead_judgement' : sub.review?.by !== 'lead' ? 'review_reject' : 'user_turn');
    }
    if (d.why === 'limit') {
      if (sub.status !== 'hitl') this.ledger.updateSubtask(req.id, sub.id, { status: 'hitl' }, at);
      this.ledger.clearConfirmation(req.id, 'escalation', sub.id);
      return toolError('needs_user', `the ${sub.role} slot ${sub.slot} has no raise left (${MAX_STEP_UPS} step-ups or the top step). Stop this subtask and ask the user: retry at the same step, reduce the scope, fix it by hand, or stop.`,
        { subtaskId: sub.id, why: 'limit', ...this.#slotView(req.id, sub.role, sub.slot, sub.step) });
    }
    this.ledger.setConfirmation({ requestId: req.id, sessionId: req.sessionId, kind: 'escalation', subtaskId: sub.id, payload: { reason: i.reason }, at });
    const to = stepUp(step, fableOptIn);
    const what = d.why === 'tier'
      ? `the next step (${to ?? 'none'}) changes the model, which needs more than your judgement alone`
      : 'this slot was already raised once on your judgement alone in this request';
    const asked = i.userConfirmed === true ? ' No user turn was seen since this request was first made.' : '';
    return toolError('needs_user', `${what}. Ask the user to confirm the raise (or have a reviewer judge the result and report it), then call again with userConfirmed true.${asked}`,
      { subtaskId: sub.id, why: d.why, ...this.#slotView(req.id, sub.role, sub.slot, sub.step) });
  }

  /**
   * router_request_scope: changes what a pending or running subtask may edit; the scope file and the agent
   * file are rewritten, and the guard reads them on every call. The [scope: ...] line stays the one way to set
   * a scope at dispatch (decision 60), so a finished subtask is refused here. A glob that names a protected
   * path (decision 129) is granted after a user turn only, kept per subtask id for a later attempt, and never
   * for .git or the router's folder.
   */
  #toolScope(req: RequestRow, i: RequestScopeInput): RouterToolResult {
    const sub = this.ledger.getSubtask(req.id, i.subtaskId);
    if (!sub) return toolError('unknown_subtask');
    const add = sortScopeGlobs(i.add ?? []);
    if (add.never.length) return toolError('not_allowed', `these paths can never be given to a subtask: ${add.never.join(', ')}.`);
    const active = sub.status === 'pending' || sub.status === 'running';
    const ordinary = add.ordinary.length > 0 || (i.remove?.length ?? 0) > 0;
    if (!active && !add.protectedPaths.length) return toolError('not_running');
    if (active && sub.unscoped && i.remove?.length) return toolError('not_allowed', 'the subtask was dispatched without a [scope: ...] line (whole repository); there is nothing to remove.');
    const at = this.#at();
    const news = add.protectedPaths.filter(g => !sub.protectedGranted.includes(g));
    if (news.length) {
      const pending = this.ledger.getConfirmation(req.id, 'scope', sub.id);
      const asked = Array.isArray((pending?.payload as { globs?: unknown } | undefined)?.globs) ? (pending!.payload as { globs: string[] }).globs : [];
      if (!(this.#userTurn(req, 'scope', sub.id, i.userConfirmed) && news.every(g => asked.includes(g)))) {
        this.ledger.setConfirmation({ requestId: req.id, sessionId: req.sessionId, kind: 'scope', subtaskId: sub.id, payload: { globs: news }, at });
        return toolError('needs_user', `these are protected paths: ${news.join(', ')}. Ask the user to confirm that subtask ${sub.id} may edit them, then call again with the same globs and userConfirmed true. Nothing was changed.`,
          { subtaskId: sub.id, protectedPaths: news });
      }
      this.ledger.clearConfirmation(req.id, 'scope', sub.id);
    }
    const protectedGranted = removeGlobs(addGlobs(sub.protectedGranted, add.protectedPaths), i.remove ?? []);
    const writeScope = active && !sub.unscoped ? removeGlobs(addGlobs(sub.writeScope, add.ordinary), i.remove ?? []) : sub.writeScope;
    this.ledger.updateSubtask(req.id, sub.id, { writeScope, protectedGranted }, at);
    const now = this.ledger.getSubtask(req.id, sub.id)!;
    if (active) {
      try {
        writeJsonAtomic(this.#home.scopeFile(req.sessionId, now.id), scopeBody(now.writeScope, now.unscoped, now.protectedGranted));
      } catch (e) {
        this.#log.error('scope file not rewritten', { sessionId: req.sessionId, subtask: now.id, error: errorText(e) });
        this.ledger.updateSubtask(req.id, sub.id, { writeScope: sub.writeScope, protectedGranted: sub.protectedGranted }, at);
        return toolError('internal', 'the router could not rewrite the scope file; the scope is unchanged.');
      }
      if (now.agentId) this.#writeAgentFile(now.agentId, req.sessionId, now);
    }
    this.#log.info('subtask scope changed', { requestId: req.id, subtaskId: now.id, live: active, scope: now.writeScope, protectedGranted: now.protectedGranted });
    return {
      ok: true,
      result: {
        requestId: req.id, subtaskId: now.id, live: active, scope: now.unscoped ? null : now.writeScope, unscoped: now.unscoped, protectedGranted: now.protectedGranted,
        ...(!active && ordinary ? { note: 'the subtask is finished: only the protected paths were granted; set its other paths with the [scope: ...] line when you dispatch it again' } : {}),
      },
    };
  }

  // ------------------------------------------------------------------ proxy cost source (decision 130)
  //
  // In API-key mode the proxy's usage rows (POST /router/v1/usage, proxyusage.ts) are recorded as cost rows of
  // source 'proxy'; once a request has any, the ledger counts them for usedUsd and leadCostUsd and the
  // transcript rows stay as the cross-check. Here: which rows a subtask's cost is made of, and the cross-check
  // written into the request record.

  #proxyCosts(requestId: string): { source: 'proxy' | 'transcript'; counts: (source: string) => boolean; crossCheck: CrossCheck[] } {
    if (!this.ledger.hasProxyCosts(requestId)) return { source: 'transcript', counts: s => s === 'transcript' || s === 'estimate', crossCheck: [] };
    return { source: 'proxy', counts: s => s === 'proxy', crossCheck: crossCheck(this.ledger, this.#log, requestId) };
  }

  // ------------------------------------------------------------------ step-down (spec 3.5, decision 135)
  //
  // Two easy passes in a row on a slot move it one step down for its next subtask; every raise locks the slot
  // at its new step for the next two dispatches. The rule is core's (ladder.ts SlotAdjust); this section keeps
  // its state in the slot row. An easy pass is a first attempt that passed verify without a fix round and
  // that a finished reviewer or tester subtask accepted with margin "easy" (router_report_result). Verify
  // alone, and the lead's own "easy", never count. Slots live for one request.

  #stepDownOn(): boolean {
    return this.#config.stepDown !== 'off';
  }

  #slotRow(requestId: string, role: Role, slot: number): SlotRow | undefined {
    return this.ledger.getSlots(requestId).find(x => x.role === role && x.slot === slot);
  }

  /** A raise (verify miss, second reject, granted request): the slot moves up and is locked there. */
  #raiseSlot(requestId: string, role: Role, slot: number, to: Step, upCount: number, at: string): void {
    const before = this.#slotRow(requestId, role, slot);
    this.ledger.setSlot(requestId, role, slot, to, upCount, at);
    const a = afterRaise(before ?? { step: to, upCount: upCount - 1, easyStreak: 0, lastEasy: false, lockStep: null, lockLeft: 0, downCount: 0 }, to);
    this.ledger.setSlotAdjust(requestId, role, slot, { ...a, step: to, upCount }, at);
  }

  /** A new subtask takes the slot: an unreported previous result ends the streak, one locked task is used up. */
  #slotDispatched(requestId: string, role: Role, slot: number): void {
    const row = this.#slotRow(requestId, role, slot);
    if (!row) return;   // never raised, no easy pass yet: nothing to keep
    const a = atDispatch(row);
    if (a.easyStreak !== row.easyStreak || a.lastEasy !== row.lastEasy || a.lockLeft !== row.lockLeft) this.ledger.setSlotAdjust(requestId, role, slot, a, this.#at());
  }

  /** A result that is not an easy pass ends the slot's easy streak (when the subtask is still the slot's latest). */
  #otherResult(requestId: string, sub: SubtaskRow, at: string): void {
    const row = this.#slotRow(requestId, sub.role, sub.slot);
    if (!row || (!row.easyStreak && !row.lastEasy)) return;
    if (this.ledger.latestSubtaskOnSlot(requestId, sub.role, sub.slot) !== sub.id) return;
    this.ledger.setSlotAdjust(requestId, sub.role, sub.slot, afterOtherResult(row), at);
  }

  /**
   * An accept was reported for `sub` (its row as it was before this report). Returns the step the slot moved
   * down to, if it did. A late report for a subtask that is no longer the slot's latest changes nothing, and
   * the same easy pass reported twice counts once.
   */
  #acceptedResult(req: RequestRow, sub: SubtaskRow, review: SubtaskReview, at: string): Step | undefined {
    if (this.ledger.latestSubtaskOnSlot(req.id, sub.role, sub.slot) !== sub.id) return undefined;
    const row = this.#slotRow(req.id, sub.role, sub.slot);
    const step = row?.step ?? sub.step;
    const agent = sub.agentId ? this.ledger.getAgent(sub.agentId) : undefined;
    const easy = this.#stepDownOn() && review.margin === 'easy' && review.by !== 'lead'
      && sub.attempts === 1 && sub.status === 'passed' && sub.verdict === 'meet' && (agent?.failCount ?? 0) === 0 && sub.step === step;
    if (!easy) {
      this.#otherResult(req.id, sub, at);
      return undefined;
    }
    const was = sub.review;
    if (was?.verdict === 'accept' && was.margin === 'easy' && was.by !== 'lead' && row?.lastEasy) return undefined;   // already counted
    const r = afterEasyPass(row ?? { step, upCount: 0, easyStreak: 0, lastEasy: false, lockStep: null, lockLeft: 0, downCount: 0 });
    this.ledger.setSlotAdjust(req.id, sub.role, sub.slot, r.state, at);
    if (!r.steppedDownTo) return undefined;
    this.ledger.setSlotCounters(req.id, sub.role, sub.slot, r.steppedDownTo, { failStreak: 0 }, at);
    this.#log.info('slot lowered after two easy results', { requestId: req.id, subtaskId: sub.id, role: sub.role, slot: sub.slot, from: step, to: r.steppedDownTo });
    return r.steppedDownTo;
  }

  // ------------------------------------------------------------------ acceptance (spec 3.8, decision 137)
  //
  // After a request closes, the next two user prompts of the session are its window. At each of them, and at
  // the Stop that follows, the request's files are looked at again (reverted, mostly deleted, committed); the
  // prompt itself is compared with the request's prompt held in memory (the same request again) and, on the
  // first one, read for a dissatisfaction phrase. What is stored: signals, two similarity numbers, a rule id.
  // The verdict rule is core's (acceptance.ts); "accepted" means no objection was seen.

  /** A user prompt arrived: it counts in the window of the session's closed requests. */
  #acceptOnPrompt(ev: RouterEvent, prompt: string, kind: 'new' | 'continue', except?: string): void {
    if (ev.spooled) return;
    const now = this.#now().getTime();
    const at = this.#at();
    for (const w of this.ledger.acceptWindows(ev.sessionId)) {
      if (w.status !== 'closed' || w.requestId === except) continue;
      const state = w.state ?? newAcceptState();
      if (state.done || state.applicable === false) continue;
      if (state.promptsSeen >= ACCEPT_WINDOW_PROMPTS) {   // the window passed without a Stop closing it
        state.done = true;
        this.#saveAccept(ev.sessionId, w.requestId, state);
        continue;
      }
      const turn = ++state.promptsSeen;
      if (kind === 'new') {
        const previous = this.#prompts.get(ev.sessionId, w.requestId, now);
        const sim = previous === undefined ? undefined : promptSimilarity(previous, prompt);
        state.similarity.push(sim ?? null);
        if (previous === undefined && turn === 1) addSignal(state, { kind: 'unavailable', turn, at, value: 'previous prompt not in memory' });
        if (sim && isReask(sim)) addSignal(state, { kind: 'reask', turn, at, value: Math.max(sim.jaccard, sim.containment) });
      }
      if (turn === 1) {
        const rule = dissatisfactionRule(prompt);
        if (rule) addSignal(state, { kind: 'dissatisfied', turn, at, value: rule });
      }
      this.#saveAccept(ev.sessionId, w.requestId, state);
      this.#checkFiles(ev.sessionId, w.requestId, turn, false);
    }
  }

  /** A turn ended (or the session was resumed): the files of the requests in their window are looked at again. */
  #acceptOnTurnEnd(sessionId: string, closing: boolean): void {
    for (const w of this.ledger.acceptWindows(sessionId)) {
      if (w.status !== 'closed' || !w.state || w.state.done || w.state.applicable === false) continue;
      this.#checkFiles(sessionId, w.requestId, w.state.promptsSeen, closing);
    }
  }

  /** Reads the request's files again, after the hook answers; the result is written back through the session queue. */
  #checkFiles(sessionId: string, requestId: string, turn: number, closing: boolean): void {
    const es = this.ledger.getEndState<RequestEndState>(requestId);
    if (!es) {
      if (closing) this.#closeWindow(sessionId, requestId);
      return;
    }
    this.#track((async () => {
      const res = await checkEndState(es);
      await this.#queue.run(sessionId || '_', () => {
        const state = this.ledger.getAcceptState(requestId);
        if (!state || state.done) return;
        const at = this.#at();
        if (!res.available) addSignal(state, { kind: 'unavailable', turn, at, value: res.why });
        else {
          if (res.signals.reverted) addSignal(state, { kind: 'reverted', turn, at, value: res.signals.revertedFiles });
          if (res.signals.mostlyDeleted) addSignal(state, { kind: 'mostly_deleted', turn, at });
          if (res.committed) addSignal(state, { kind: 'committed', turn, at });
        }
        if (storedAcceptance(state) === 'not_accepted' || (closing && state.promptsSeen >= ACCEPT_WINDOW_PROMPTS)) state.done = true;
        this.#saveAccept(sessionId, requestId, state);
      });
    })());
  }

  #closeWindow(sessionId: string, requestId: string): void {
    const state = this.ledger.getAcceptState(requestId);
    if (!state || state.done || state.promptsSeen < ACCEPT_WINDOW_PROMPTS) return;
    state.done = true;
    this.#saveAccept(sessionId, requestId, state);
  }

  /** Stores what was seen; a record that exists already follows; a closed window drops the end state and the prompt. */
  #saveAccept(sessionId: string, requestId: string, state: AcceptState): void {
    this.ledger.setAcceptState(requestId, state);
    if (state.done) {
      this.ledger.setEndState(requestId, null);
      this.#prompts.forget(sessionId, requestId);
    }
    if (state.applicable === undefined || !this.ledger.getRecord(requestId)) return;   // the record is written at close with this state
    this.ledger.setRecordAcceptance(requestId, storedAcceptance(state), state.signals, acceptanceBlob(state, ACCEPTANCE_RULE_VERSION));
    this.#evaluateRelease(this.ledger.getRequest(requestId)?.leadClass ?? null);
  }

  /** At the record write: whether the request is one to accept at all, and its acceptance so far. */
  #acceptAtClose(requestId: string, changes: ChangeStats | null, subtasks: number): AcceptState {
    const state = this.ledger.getAcceptState(requestId) ?? newAcceptState();
    state.applicable = (changes?.changedFiles ?? 0) > 0 || subtasks > 0;
    this.ledger.setAcceptState(requestId, state);
    return state;
  }

  // ------------------------------------------------------------------ auto-release (spec 3.8, decision 138)
  //
  // The baseline is the user's own work: a share of the requests at a delegated level (config holdoutRate) is
  // handled lead-direct on purpose. When the comparison (routing.ts, core release.ts) says a level costs
  // clearly more delegated than direct, mode 'on' raises that lead class's start level and tells the user;
  // the default mode 'observe' only shows it. A released level keeps a probe share delegated, to come back.

  /** How a new request planned by the rules is staffed: as its level says, or lead-direct on purpose (holdout, released). */
  #routingPlan(requestId: string, t: TriageResult, presets: Record<Level, TeamPreset>, leadClass: string): { triage: TriageResult; team: TeamPreset; holdout?: Holdout } {
    const base = presets[t.level];
    const mode = routingMode(this.#config);
    if (mode === 'off' || base.leadDirect || !RELEASE_LEVELS.includes(t.level)) return { triage: t, team: base };
    const auto = mode === 'on' ? this.ledger.getRelease(leadClass)?.autoDelegateFrom ?? null : null;
    const released = !!auto && LEVEL_ORDER.indexOf(t.level) < LEVEL_ORDER.indexOf(auto);
    const drawn = holdoutDraw(requestId, routingHoldoutRate(this.#config));
    if (released ? drawn : !drawn) return { triage: t, team: base, ...(released ? { holdout: 'probe' as const } : {}) };
    const team: TeamPreset = { ...base, leadDirect: true };
    const why = released
      ? `released (decision 138): ${t.level} requests of this lead are handled directly for now`
      : 'holdout (decision 138): handled directly on purpose, to measure what delegation saves';
    return { triage: withKind({ ...t, rationale: `${why}; ${t.rationale}` }, team), team, holdout: released ? 'released' : 'direct' };
  }

  /** After a record changed: in mode 'on', apply what the rule says for this lead class. */
  #evaluateRelease(leadClass: string | null): void {
    if (!leadClass || routingMode(this.#config) !== 'on' || !(LEAD_CLASSES as readonly string[]).includes(leadClass)) return;
    try {
      const change = releaseChange(this.ledger, this.#config, leadClass as LeadModelClass, this.#at());
      if (!change) return;
      applyRelease(this.ledger, this.#config, change, this.#at());
      this.#log.info(change.kind === 'release' ? 'level released: handled lead-direct from now' : 'level re-enabled: delegated again', {
        leadClass, level: change.level, ratio: change.decision.ratio, delegated: change.decision.need.delegated[0], direct: change.decision.need.direct[0],
      });
    } catch (e) {
      this.#log.error('auto-release evaluation failed', { leadClass, error: errorText(e) });
    }
  }

  /** What status, router_get_plan and the dashboard show about auto-release. */
  routing(): RoutingView {
    return routingView(this.ledger, this.#config, this.#at());
  }

  /** `agentic-router routing reset`: every released level is delegated again; the records stay. */
  routingReset(): { cleared: number } {
    const cleared = this.ledger.clearReleases();
    this.#log.info('auto-release state cleared', { cleared });
    return { cleared };
  }

  // ------------------------------------------------------------------ summaries

  #summary(requestId: string, why: string): string {
    const r = this.ledger.getRequest(requestId);
    if (!r) return '';
    const subs = this.ledger.listSubtasks(requestId).map(s => {
      const st = ladderStep(s.step);
      return `${s.id} ${s.role}#${s.slot} @${s.step} (model=${st.alias}, effort=${st.effort}) ${s.status}${s.verdict ? `/${s.verdict}` : ''}`;
    });
    return [
      this.#triageContext(r.triage, r.team, undefined, r.leadModel),
      `[agentic-router] ledger (${why}): request ${r.id}, spent $${r.usedUsd.toFixed(4)} of $${r.budgetUsd}.`,
      subs.length ? `subtasks: ${subs.join('; ')}.` : 'no subtasks dispatched yet.',
    ].join('\n');
  }

  status(sessionId?: string): StatusView {
    const r = sessionId ? this.ledger.latestRequest(sessionId) : this.ledger.latestRequestAny();
    const clients = this.ledger.recentClients(10);
    const stepAdjust = { up: 'on' as const, down: this.#stepDownOn() ? 'on' as const : 'off' as const };
    const routing = this.routing();
    if (!r) return { request: null, roles: [], costUsd: 0, costEstimated: false, costUnknown: false, sessionCostUsd: sessionId ? this.ledger.sessionCostUsd(sessionId) : 0, clients, stepAdjust, routing };
    const subs = this.ledger.listSubtasks(r.id);
    const slots = this.ledger.getSlots(r.id);
    const roles: RoleView[] = [];
    const seen = new Set<string>();
    const view = (role: string, slot: number, step: RoleView['step'], status: string, subtaskId: string | null): RoleView => {
      const st = ladderStep(step as Parameters<typeof ladderStep>[0]);
      return { role, slot, step, model: st.alias, effort: st.effort, status, subtaskId };
    };
    for (const m of r.team.roles) {
      for (let slot = 0; slot < m.count; slot++) {
        const last = [...subs].reverse().find(s => s.role === m.role && s.slot === slot);
        seen.add(`${m.role}#${slot}`);
        const raised = slots.find(x => x.role === m.role && x.slot === slot)?.step;   // spec 3.5: the slot's step after a miss
        roles.push(last ? view(m.role, slot, raised ?? last.step, last.status, last.id) : view(m.role, slot, raised ?? m.start, 'idle', null));
      }
    }
    for (const s of [...subs].reverse()) {
      if (seen.has(`${s.role}#${s.slot}`)) continue;
      seen.add(`${s.role}#${s.slot}`);
      roles.push(view(s.role, s.slot, s.step, s.status, s.id));
    }
    return {
      request: {
        id: r.id, sessionId: r.sessionId, level: r.level, preset: r.preset, status: r.status, createdAt: r.createdAt,
        budgetUsd: r.budgetUsd, usedUsd: r.usedUsd, leadCostUsd: r.leadCostUsd, confidence: r.triage.confidence, source: r.triage.source,
        leadDirect: r.team.leadDirect === true, outcome: r.outcome,
        presetSource: r.presetSource, forcedFrom: r.forcedFrom, replannedFrom: r.replannedFrom?.level ?? null,
        leadModel: r.leadModel, leadClass: r.leadClass,
      },
      roles,
      costUsd: round6(r.usedUsd + r.leadCostUsd),
      ...((f) => ({ costEstimated: f.estimated, costUnknown: f.unknown }))(this.ledger.costFlags(r.id)),
      sessionCostUsd: round6(this.ledger.sessionCostUsd(r.sessionId)),
      clients,
      stepAdjust,
      routing,
    };
  }
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** A planned triage's kind follows its team: a lead-direct preset is 'direct', a team preset 'team' (two-stage triage). */
function withKind(t: TriageResult, team: TeamPreset): TriageResult {
  return 'kind' in t ? { ...t, kind: team.leadDirect ? 'direct' : 'team' } as TriageResult : t;
}

/** The subagent a task notification reports on: the adapter's parsed taskId, else the <task-id> tag. */
function notificationTaskId(ev: RouterEvent, prompt: string): string | undefined {
  return ev.notification?.taskId || /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(prompt)?.[1];
}

/** Decision 84: N tokens all priced at the model's output rate (the long-prompt rate when N is that large). */
export function outputRateEstimate(modelId: string, tokens: number): number | null {
  const p = PRICING_PER_MTOK[modelId];
  if (!p) return null;
  const long = p.longPromptOver !== undefined && p.longPromptOutput !== undefined && tokens > p.longPromptOver;
  return round6(tokens * (long ? p.longPromptOutput! : p.output) / 1e6);
}
const MAX_COMPACT_SUBTASKS = 20;
/** Audit #11: an allowed subtask whose subagent has not started after this long never will. */
const STALE_PENDING_MS = 30_000;
const LEVEL_ORDER: readonly Level[] = ['L0', 'L1', 'L2', 'L3'];
/** Decision 127: this many rejects in a row on a slot raise it, as two verify failures do. */
const REJECTS_FOR_RAISE = 2;
/** router_get_plan lists this many of the latest subtasks. */
const MAX_PLAN_SUBTASKS = 20;

interface ToolBinding { sessionId: string; cwd: string | undefined; boundBy: 'ticket' | 'spawn_session' }

/** A refused tool call: a code the lead can act on and one sentence (core routerToolErrorText). */
function toolError(code: RouterToolErrorCode, detail?: string, result?: Record<string, unknown>): RouterToolResult {
  return { ok: false, code, message: routerToolErrorText(code, detail), ...(result ? { result } : {}) };
}

/** A scope file's body; protected paths granted to the subtask (decision 129) ride along for the guard. */
function scopeBody(allowed: string[], unscoped: boolean, granted: readonly string[]) {
  return { ...scopeFileBody(allowed, unscoped), ...(granted.length ? { protectedGranted: [...granted] } : {}) };
}
/** Tools that write files (decision 103): a role file without any of them is read-only. */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** Audit #14: the fallback for pricing an unknown model's tokens when the subagent's step is not known. */
const MOST_EXPENSIVE_MODEL = Object.entries(PRICING_PER_MTOK).sort((a, b) => b[1].output - a[1].output)[0]![0];

function blockReason(subtaskId: string, failed: VerifySignal[], shared: boolean): string {
  const lines = failed.map(f => `- ${f.kind}: ${(f.detail ?? 'failed').split('\n').join('\n  ')}`);
  return [
    `[agentic-router] verification failed for subtask ${subtaskId}:`,
    ...lines,
    ...(shared ? ['These checks ran in the shared work tree (the user\'s checkout). Changes that were already uncommitted when you started are not counted as yours; do not revert or commit them.'] : []),
    'Fix these, re-run the checks, then finish again. If the work needs files outside your scope, do not edit them: list them under "범위 변경 요청" (scope change request) in your report.',
  ].join('\n');
}
