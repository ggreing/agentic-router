// Claude Code hook input -> client-neutral RouterEvent.
// Field names follow the Claude Code 2.1.319-2.1.322 hook payloads recorded in test/fixtures/*.jsonl.
// The main-session model field and its transcript fallback (decision 117) are fixed by
// test/fixtures/spike-leadmodel.jsonl and test/fixtures/transcript-main.jsonl.
import type { RouterEvent, RouterEventType } from '@do-it-all-claude-code/core';

/** Claude Code hook event names this adapter understands. */
export type ClaudeHookEventName =
  | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'SubagentStart'
  | 'SubagentStop' | 'PreCompact' | 'SessionStart' | 'Stop';

export const HOOK_EVENT_TO_TYPE: Readonly<Record<ClaudeHookEventName, RouterEventType>> = {
  UserPromptSubmit: 'prompt_submit',
  PreToolUse: 'pre_tool_use',
  PostToolUse: 'post_tool_use',
  SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop',
  PreCompact: 'pre_compact',
  SessionStart: 'session_start',
  Stop: 'stop',
};

export const TYPE_TO_HOOK_EVENT: Readonly<Record<RouterEventType, ClaudeHookEventName>> = {
  prompt_submit: 'UserPromptSubmit',
  pre_tool_use: 'PreToolUse',
  post_tool_use: 'PostToolUse',
  subagent_start: 'SubagentStart',
  subagent_stop: 'SubagentStop',
  pre_compact: 'PreCompact',
  session_start: 'SessionStart',
  stop: 'Stop',
};

/** Thrown for payloads that are not a supported Claude Code hook input. The daemon should answer 400. */
export class HookInputError extends Error {
  override name = 'HookInputError';
}

export interface ToRouterEventOptions {
  /** ISO-8601 time the event was received; spool replay passes the original time. Default: now. */
  receivedAt?: string;
  /** True when the event is replayed from the local spool. */
  spooled?: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function isClaudeHookEventName(v: unknown): v is ClaudeHookEventName {
  return typeof v === 'string' && Object.hasOwn(HOOK_EVENT_TO_TYPE, v);
}

/**
 * Translates one Claude Code hook input (the JSON the hook receives on stdin) into a RouterEvent.
 * Throws HookInputError when the payload is not an object, has an unknown `hook_event_name`,
 * or lacks `session_id`. Unknown extra fields are kept in `raw` only.
 */
export function toRouterEvent(hookInput: unknown, opts: ToRouterEventOptions = {}): RouterEvent {
  if (!isRecord(hookInput)) throw new HookInputError('hook input must be a JSON object');
  const name = hookInput.hook_event_name;
  if (!isClaudeHookEventName(name)) throw new HookInputError(`unsupported hook_event_name: ${String(name)}`);
  const sessionId = str(hookInput.session_id);
  if (!sessionId) throw new HookInputError('hook input has no session_id');

  const type = HOOK_EVENT_TO_TYPE[name];
  const ev: RouterEvent = {
    type,
    sessionId,
    raw: hookInput,
    receivedAt: opts.receivedAt ?? new Date().toISOString(),
  };
  if (opts.spooled) ev.spooled = true;

  // Present on every event raised inside a subagent; absent for the main session.
  const agentId = str(hookInput.agent_id);
  if (agentId) ev.agentId = agentId;
  const agentType = str(hookInput.agent_type);
  if (agentType !== undefined) ev.agentType = agentType;   // '' for Claude Code internal agents
  const cwd = str(hookInput.cwd);
  if (cwd) ev.cwd = cwd;
  const transcriptPath = str(hookInput.transcript_path);
  if (transcriptPath) ev.transcriptPath = transcriptPath;
  // Main-session model (decisions 117, 144). Claude Code 2.1.322 (contract spike, -p runs) sends no `model`
  // in SessionStart (cwd, hook_event_name, session_id, source, transcript_path, sometimes context_tokens) nor in
  // UserPromptSubmit or any other hook event. It is read generically here in case a build does send one; the
  // daemon learns the model from the status line (its input has model.id) and from the main transcript
  // (leadModelFromTranscript below), which follows a /model switch.
  const leadModel = str(hookInput.model);
  if (leadModel) ev.leadModel = leadModel;

  switch (type) {
    case 'prompt_submit': {
      const prompt = str(hookInput.prompt);
      if (prompt !== undefined) ev.prompt = prompt;
      ev.promptOrigin = promptOrigin(prompt);            // 'user' | 'notification' (decision: never re-triage a notification)
      if (ev.promptOrigin === 'notification') {
        const n = parseTaskNotification(prompt)!;
        const notif: NonNullable<RouterEvent['notification']> = {};
        if (n.taskId !== undefined) notif.taskId = n.taskId;
        if (n.toolUseId !== undefined) notif.toolUseId = n.toolUseId;
        if (n.status !== undefined) notif.status = n.status;
        ev.notification = notif;
      }
      break;
    }
    case 'pre_tool_use':
    case 'post_tool_use': {
      const toolName = str(hookInput.tool_name);
      if (toolName) ev.toolName = toolName;
      if (isRecord(hookInput.tool_input)) ev.toolInput = hookInput.tool_input;
      if (type === 'post_tool_use' && 'tool_response' in hookInput) ev.toolResponse = hookInput.tool_response;
      break;
    }
    case 'session_start': {
      const source = str(hookInput.source);
      if (source) ev.source = source;
      break;
    }
    case 'subagent_stop': {
      const p = str(hookInput.agent_transcript_path);
      if (p) ev.agentTranscriptPath = p;
      if (typeof hookInput.stop_hook_active === 'boolean') ev.stopHookActive = hookInput.stop_hook_active;
      const last = str(hookInput.last_assistant_message);
      if (last !== undefined) ev.lastAssistantMessage = last;
      break;
    }
    case 'stop': {
      if (typeof hookInput.stop_hook_active === 'boolean') ev.stopHookActive = hookInput.stop_hook_active;
      const last = str(hookInput.last_assistant_message);
      if (last !== undefined) ev.lastAssistantMessage = last;
      break;
    }
    case 'subagent_start':
    case 'pre_compact':
      // PreCompact's `trigger` / `custom_instructions` stay in `raw`.
      break;
  }
  return ev;
}

// ---------------------------------------------------------------- helpers for the daemon

/** Effort level Claude Code reports for the agent that raised the event (`effort.level`), e.g. the real effort of a subagent. */
export function hookEffort(ev: RouterEvent): string | undefined {
  const e = ev.raw.effort;
  return isRecord(e) ? str(e.level) : undefined;
}

/** True for a subagent launched from this plugin's role files (`do-it-all-claude-code:<role>`). */
export const ROUTER_AGENT_PREFIX = 'do-it-all-claude-code:';
export function isRouterAgent(agentType: string | undefined): boolean {
  return typeof agentType === 'string' && agentType.startsWith(ROUTER_AGENT_PREFIX);
}
/** `do-it-all-claude-code:coder` -> `coder`; undefined for other agent types. */
export function routerRole(agentType: string | undefined): string | undefined {
  return isRouterAgent(agentType) ? agentType!.slice(ROUTER_AGENT_PREFIX.length) : undefined;
}

/** Agent tool name in Claude Code 2.1.x (older versions used `Task`). */
export const AGENT_TOOL_NAMES: readonly string[] = ['Agent', 'Task'];
export function isAgentToolEvent(ev: RouterEvent): boolean {
  return (ev.type === 'pre_tool_use' || ev.type === 'post_tool_use') && AGENT_TOOL_NAMES.includes(ev.toolName ?? '');
}

/** The Agent call as the lead made it (PreToolUse / PostToolUse `tool_input`). */
export interface AgentCall {
  subagentType?: string;
  model?: string;
  effort?: string;
  prompt?: string;
  description?: string;
  runInBackground?: boolean;
}
export function agentCall(ev: RouterEvent): AgentCall | undefined {
  if (!isAgentToolEvent(ev) || !ev.toolInput) return undefined;
  const t = ev.toolInput;
  const out: AgentCall = {};
  const subagentType = str(t.subagent_type); if (subagentType) out.subagentType = subagentType;
  const model = str(t.model); if (model) out.model = model;
  const effort = str(t.effort); if (effort) out.effort = effort;
  const prompt = str(t.prompt); if (prompt !== undefined) out.prompt = prompt;
  const description = str(t.description); if (description !== undefined) out.description = description;
  if (typeof t.run_in_background === 'boolean') out.runInBackground = t.run_in_background;
  return out;
}

/**
 * Fields of an Agent result (PostToolUse `tool_response`) that the ledger records.
 * Agent calls default to ASYNC: the PostToolUse response is then only `{ isAsync: true,
 * status: "async_launched", agentId, resolvedModel, prompt, description, outputFile }` with NO
 * usage — the usage, report and worktree arrive later in the task-notification (see TaskNotification).
 * A foreground/sync result carries `content`, `usage`, `worktreeBranch` here instead.
 */
export interface AgentResult {
  status?: string;          // "completed" (sync) | "async_launched" (async)
  isAsync?: boolean;
  agentId?: string;
  agentType?: string;
  prompt?: string;
  description?: string;
  resolvedModel?: string;
  outputFile?: string;      // async: file the subagent's output is streamed to
  usage?: Record<string, unknown>;
  totalTokens?: number;
  totalDurationMs?: number;
  totalToolUseCount?: number;
  worktreePath?: string;
  worktreeBranch?: string;
  /** Final report text (the `text` blocks of `content`, joined) — sync results only. */
  text?: string;
}
export function agentResult(ev: RouterEvent): AgentResult | undefined {
  if (ev.type !== 'post_tool_use' || !isAgentToolEvent(ev) || !isRecord(ev.toolResponse)) return undefined;
  const r = ev.toolResponse;
  const out: AgentResult = {};
  for (const k of ['status', 'agentId', 'agentType', 'prompt', 'description', 'resolvedModel', 'outputFile', 'worktreePath', 'worktreeBranch'] as const) {
    const v = str(r[k]); if (v !== undefined) out[k] = v;
  }
  if (typeof r.isAsync === 'boolean') out.isAsync = r.isAsync;
  for (const k of ['totalTokens', 'totalDurationMs', 'totalToolUseCount'] as const) {
    const v = r[k]; if (typeof v === 'number') out[k] = v;
  }
  if (isRecord(r.usage)) out.usage = r.usage;
  if (Array.isArray(r.content)) {
    const parts = r.content.filter(isRecord).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text as string);
    // The first block is a harness note (<tools-used-before-summary>); keep only the report.
    const report = parts.filter(p => !p.startsWith('<tools-used-before-summary>'));
    if (report.length) out.text = report.join('\n');
  }
  return out;
}

// ---------------------------------------------------------------- async task notifications
/**
 * An async Agent finishes by posting a `<task-notification>` as a new UserPromptSubmit. The daemon
 * must recognise it (NOT triage it as a new user request) and record the usage/report/worktree it
 * carries against the subtask, keyed by `taskId` (the subagent's agentId) and `toolUseId` (the
 * original Agent call's tool_use_id).
 */
export interface TaskNotification {
  kind: 'task';
  taskId?: string;          // = the subagent's agent_id
  toolUseId?: string;       // the Agent call's tool_use_id, to rejoin the PostToolUse(Agent) launch
  outputFile?: string;
  status?: string;          // "completed", …
  summary?: string;
  result?: string;          // the subagent's structured report
  worktreePath?: string;
  worktreeBranch?: string;
  usage?: { subagentTokens?: number; toolUses?: number; durationMs?: number };
}

// Shared with the daemon's fallback check: a prompt is a task notification when it
// opens with the <task-notification> tag. Keep this pattern identical on both sides so the adapter's
// RouterEvent.promptOrigin and the daemon's own check never disagree.
const TASK_NOTIFICATION_RE = /^\s*<task-notification[\s>]/;

/** True if a UserPromptSubmit prompt is actually an async-agent task notification, not a user message. */
export function isTaskNotification(prompt: string | undefined): boolean {
  return typeof prompt === 'string' && TASK_NOTIFICATION_RE.test(prompt);
}

/** Client-neutral origin of a prompt_submit: a background task notification vs. a human message. */
export function promptOrigin(prompt: string | undefined): 'user' | 'notification' {
  return isTaskNotification(prompt) ? 'notification' : 'user';
}

function tag(src: string, name: string): string | undefined {
  // Non-greedy, dot-all; tags are simple and never nested with the same name.
  const m = src.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : undefined;
}
function intTag(src: string, name: string): number | undefined {
  const v = tag(src, name);
  if (v === undefined) return undefined;
  const n = Number.parseInt(v.trim(), 10);
  return Number.isFinite(n) ? n : undefined;
}

/** Parses a `<task-notification>` prompt into its fields, or null if the text is not one. */
export function parseTaskNotification(prompt: string | undefined): TaskNotification | null {
  if (!isTaskNotification(prompt)) return null;
  const src = prompt as string;
  const out: TaskNotification = { kind: 'task' };
  const taskId = tag(src, 'task-id')?.trim(); if (taskId) out.taskId = taskId;
  const toolUseId = tag(src, 'tool-use-id')?.trim(); if (toolUseId) out.toolUseId = toolUseId;
  const outputFile = tag(src, 'output-file')?.trim(); if (outputFile) out.outputFile = outputFile;
  const status = tag(src, 'status')?.trim(); if (status) out.status = status;
  const summary = tag(src, 'summary')?.trim(); if (summary) out.summary = summary;
  const result = tag(src, 'result'); if (result !== undefined) out.result = result.trim();
  const wt = tag(src, 'worktree');
  if (wt) {
    const wp = tag(wt, 'worktreePath')?.trim(); if (wp) out.worktreePath = wp;
    const wb = tag(wt, 'worktreeBranch')?.trim(); if (wb) out.worktreeBranch = wb;
  }
  const usageSrc = tag(src, 'usage');
  if (usageSrc) {
    const u: NonNullable<TaskNotification['usage']> = {};
    const st = intTag(usageSrc, 'subagent_tokens'); if (st !== undefined) u.subagentTokens = st;
    const tu = intTag(usageSrc, 'tool_uses'); if (tu !== undefined) u.toolUses = tu;
    const d = intTag(usageSrc, 'duration_ms'); if (d !== undefined) u.durationMs = d;
    if (Object.keys(u).length) out.usage = u;
  }
  return out;
}

/** The task notification carried by a prompt_submit event, or null for a real user prompt / other events. */
export function taskNotification(ev: RouterEvent): TaskNotification | null {
  if (ev.type !== 'prompt_submit') return null;
  return parseTaskNotification(ev.prompt);
}

// ---------------------------------------------------------------- subtask pairing (spec 3.4, audit E16)
/**
 * The `[subtask:<ID>]` tag the lead put on the first line of an Agent prompt, read from the subagent's
 * own transcript (`agentTranscriptPath`). Foreground Agent calls can resolve out of order, so the
 * daemon pairs a subagent to its subtask by THIS tag rather than by launch order (audit E16).
 * Returns the tag, or null when the transcript is missing or carries no tag.
 */
export function subtaskTagFromTranscript(agentTranscriptPath: string | undefined, readFileSync: (p: string) => string): string | null {
  if (!agentTranscriptPath) return null;
  try {
    const m = readFileSync(agentTranscriptPath).match(/\[subtask:([A-Za-z0-9_-]+)\]/);
    return m ? m[1]! : null;
  } catch {
    return null;   // transcript not written yet / unreadable
  }
}

// ---------------------------------------------------------------- lead model (decision 117)
/**
 * The main session's current model id, read from the LAST `assistant` line of the MAIN transcript
 * (`RouterEvent.transcriptPath`) as `message.model`. Only the model id is taken; message content is
 * never inspected. This is the per-request fallback for RouterEvent.leadModel: no hook event carries the
 * model in Claude Code 2.1.322 (decision 144), and one that did would go stale after a /model switch, so the daemon
 * resolves the lead model at each request from here (core's leadModelClass maps the id to a tier).
 * Scans from the end so a mid-session switch is reflected. Returns null when the path is missing,
 * unreadable, or has no assistant line with a model yet (e.g. before the first reply).
 */
export function leadModelFromTranscript(transcriptPath: string | undefined, readFileSync: (p: string) => string): string | null {
  if (!transcriptPath) return null;
  let text: string;
  try { text = readFileSync(transcriptPath); } catch { return null; }
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes('"assistant"')) continue;   // cheap prefilter before JSON.parse
    try {
      const o = JSON.parse(line) as { type?: unknown; message?: unknown };
      if (o.type !== 'assistant' || !isRecord(o.message)) continue;
      const model = str(o.message.model);
      if (model) return model;
    } catch { /* skip a malformed / partially written line */ }
  }
  return null;
}
