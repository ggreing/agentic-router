// Shared contracts for all packages.
// Spec references are to "Agentic Router Proxy.docx" (docs/spec).

export type Level = 'L0' | 'L1' | 'L2' | 'L3';
export type Step = 's1' | 's2' | 's3' | 's4' | 's5' | 's6' | 's7';
export type Tier = 'T1' | 'T2' | 'T3' | 'T3+';
export type ModelAlias = 'haiku' | 'sonnet' | 'opus' | 'fable';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type Role = 'architect' | 'ui-designer' | 'coder' | 'reviewer' | 'tester';
export type TaskType = 'question' | 'edit' | 'feature' | 'debug' | 'design' | 'refactor';
export type TriageSource = 'rule' | 'vector' | 'judge' | 'haiku' | 'lead' | 'manual' | 'default';   // judge: stage-2 model (decisions 104, 115)

/** One rung of the model x effort ladder (spec 3.5). Model changes only at tier boundaries. */
export interface LadderStep {
  step: Step;
  tier: Tier;
  alias: ModelAlias;        // passed as the per-call `model` of the Agent tool
  effort: Effort;           // passed as the per-call `effort` of the Agent tool
  modelId: string;          // pinned full ID, used for pricing and reporting
  optIn: boolean;           // s7 (Fable) only when the user enables it
  coefficient?: number;     // measured effective cost vs s1 (Phase 0, Appendix E)
}

/** Result of triage for one user request (spec 3.2). */
export interface TriageResult {
  level: Level;
  confidence: number;       // 0..1
  source: TriageSource;
  taskType: TaskType;
  preset: string;           // team preset id (normally the level, e.g. "L2")
  budgetUsd: number;        // per-request cap (provisional until Phase 0 KPI targets)
  rationale: string;        // one line, shown to the lead and stored for learning
}

export interface TeamMember { role: Role; count: number; start: Step }
export interface TeamPreset {
  id: string;
  level: Level;
  roles: TeamMember[];      // L0: a single coder; the lead (main session) is implicit
  leadMayAdjust: boolean;
  budgetUsd: number;
  // Decision 87: the lead makes the change itself (no team); the router only triages and records.
  // Phase 1 e2e round 3: delegating an L0 change cost more than the lead doing it (lead overhead dominates).
  leadDirect?: boolean;
}

// ---------------------------------------------------------------- evaluation (spec 3.5)

export type SignalKind = 'build' | 'typecheck' | 'lint' | 'test' | 'scope' | 'review' | 'error_repeat' | 'max_turns' | 'tool_error';
export interface VerifySignal { kind: SignalKind; ok: boolean; detail?: string }

/** Outcome of one session: 1st failure, miss (2 consecutive failures), meet, ample (first-try pass + review score >= threshold). */
export type Verdict = 'fail_once' | 'miss' | 'meet' | 'ample';

/** Per role-slot state; the step carries across subtasks (no reset). */
export interface SlotState {
  role: Role;
  slot: number;
  step: Step;
  easyStreak: number;                                  // consecutive "ample" results; 2 => step down
  floorLock?: { step: Step; tasksLeft: number };       // after a step-up: no step-down below `step` for 2 tasks
}

export type AdjustAction = 'retry' | 'hold' | 'step_up' | 'step_down' | 'hitl' | 'budget_pause';
export interface AdjustDecision { action: AdjustAction; nextStep: Step; respawn: boolean; reason: string }

// ---------------------------------------------------------------- hook events (client-neutral)

export type RouterEventType =
  | 'prompt_submit' | 'pre_tool_use' | 'post_tool_use' | 'subagent_start'
  | 'subagent_stop' | 'pre_compact' | 'session_start' | 'stop';

/** A client hook payload translated by an adapter. `raw` is never logged unredacted. */
export interface RouterEvent {
  type: RouterEventType;
  sessionId: string;
  agentId?: string;          // set for events raised inside a subagent
  agentType?: string;        // e.g. "agentic-router:coder"; empty for the main session and internal agents
  cwd?: string;              // worktree root for isolated subagents
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResponse?: unknown;
  prompt?: string;           // prompt_submit
  leadModel?: string;        // main-session model id when the hook input or transcript shows it (decision 117)
  // prompt_submit: 'notification' when the "prompt" is Claude Code's <task-notification> for a finished
  // background subagent (Agent calls run async by default). Such prompts are never a new request.
  promptOrigin?: 'user' | 'notification';
  notification?: { taskId?: string; toolUseId?: string; status?: string };   // parsed from a <task-notification>
  source?: string;           // session_start: startup | resume | compact | clear
  transcriptPath?: string;
  agentTranscriptPath?: string;   // subagent_stop
  stopHookActive?: boolean;       // subagent_stop / stop
  lastAssistantMessage?: string;  // subagent_stop / stop: carries the [router:awaiting-user] marker (decision 56)
  raw: Record<string, unknown>;
  receivedAt: string;        // ISO-8601
  spooled?: boolean;         // replayed from the local spool after a daemon outage
}

/** What the router asks the client to do. Adapters render it into the client's hook output. */
export interface RouterDecision {
  context?: string;               // added to the model's context; never replaces the prompt
  userMessage?: string;           // short notice for the user (status, HITL)
  deny?: { reason: string };      // pre_tool_use: refuse the call; the reason is shown to the model
  block?: { reason: string };     // subagent_stop / stop: keep the agent working; the reason is shown to the model
}

// ---------------------------------------------------------------- ledger (spec 3.6, 4.3)

export type SubtaskStatus = 'pending' | 'running' | 'passed' | 'failed' | 'hitl' | 'cancelled';

export interface SubtaskRecord {
  id: string;                // the [subtask:<ID>] tag the lead puts on the first line of the Agent prompt
  requestId: string;
  role: Role;
  slot: number;
  step: Step;
  writeScope: string[];      // repo-relative globs the subagent may edit
  agentId?: string;          // bound at SubagentStart (order), verified at first tool call (tag), confirmed at PostToolUse(Agent)
  attempts: number;
  upCount: number;           // > 3 => HITL
  status: SubtaskStatus;
}

export interface RequestRecord {
  id: string;
  sessionId: string;
  createdAt: string;
  triage: TriageResult;
  leadCostUsd: number;
  usedUsd: number;
}
