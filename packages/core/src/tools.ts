// Router MCP tools (spec 3.3, decision 127): the five lead-only tools, their input schemas and the
// rules that need no ledger.
//
// Hooks stay the system of record and every tool is optional: a session that never calls one behaves
// the same. A tool reads the ledger or carries a judgement of the lead that hooks cannot see.
// Inputs are strict objects of ids, enums, numbers and globs, never free text (decision 110, spec 5.2).
// The plugin's stdio server cannot import this package, so it ships the output of routerToolList() as a
// JSON file; the daemon validates every call again with the schemas here.
import { z } from 'zod';
import { crossesTier, stepUp } from './ladder.ts';
import type { Level, Step } from './types.ts';

// ------------------------------------------------------------------ names

export const ROUTER_PLUGIN_NAME = 'do-it-all-claude-code';
export const ROUTER_MCP_SERVER = 'router';
/** Claude Code names a plugin server's tool mcp__plugin_<plugin>_<server>__<tool>. */
export const ROUTER_TOOL_PREFIX = `mcp__plugin_${ROUTER_PLUGIN_NAME}_${ROUTER_MCP_SERVER}__`;

export const ROUTER_TOOL_NAMES = [
  'router_get_plan', 'router_report_triage', 'router_report_result', 'router_request_escalation', 'router_request_scope',
] as const;
export type RouterToolName = typeof ROUTER_TOOL_NAMES[number];

/** The router tool a Claude Code tool name refers to, or undefined for any other tool. */
export function routerToolName(toolName: string | undefined): RouterToolName | undefined {
  if (!toolName || !toolName.startsWith(ROUTER_TOOL_PREFIX)) return undefined;
  const short = toolName.slice(ROUTER_TOOL_PREFIX.length);
  return (ROUTER_TOOL_NAMES as readonly string[]).includes(short) ? short as RouterToolName : undefined;
}

/** True for every tool of the router's MCP server, including a name this version does not know. */
export const isRouterToolName = (toolName: string | undefined): boolean => !!toolName && toolName.startsWith(ROUTER_TOOL_PREFIX);

// ------------------------------------------------------------------ shared pieces

/** The [subtask:<ID>] tag rule of the Agent prompt's first line. */
export const SUBTASK_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const subtaskId = z.string().regex(SUBTASK_ID_RE);

export const MAX_SCOPE_GLOB_CHARS = 200;
export const MAX_SCOPE_GLOBS = 20;

/** A scope glob as the ledger keeps it: forward slashes, no leading "./". */
export function normalizeScopeGlob(glob: string): string {
  return glob.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Why a scope glob is refused, or undefined when it is fine: globs are repo-relative (decision 60). */
export function scopeGlobProblem(glob: string): string | undefined {
  const g = normalizeScopeGlob(glob);
  if (!g) return 'empty';
  if (g.startsWith('/') || /^[A-Za-z]:/.test(g) || g.startsWith('~') || g.split('/').includes('..')) return 'not repo-relative (no absolute path, "~" or "..")';
  if (/[\r\n\0]/.test(g)) return 'contains a line break';
  return undefined;
}

const scopeGlob = z.string().min(1).max(MAX_SCOPE_GLOB_CHARS).refine(g => scopeGlobProblem(g) === undefined, 'scope globs must be repo-relative (no absolute path, "~" or "..")');
const scopeGlobs = z.array(scopeGlob).min(1).max(MAX_SCOPE_GLOBS);

/**
 * Protected paths a subtask can never be given by router_request_scope (decision 129); credential paths
 * are refused by the guard on their own. Every other protected path needs a user turn first.
 */
export const NEVER_GRANTABLE_WRITE_PATHS = ['.git/**', '**/.git/**', '.do-it-all-claude-code/**', '**/.do-it-all-claude-code/**', '.agentic-router/**', '**/.agentic-router/**'] as const;

// ------------------------------------------------------------------ inputs

export const GetPlanInput = z.strictObject({});

/** The lead's own size judgement: the judge's answer without its sentence (triage-judge.ts). */
export const ReportTriageInput = z.strictObject({
  kind: z.enum(['direct', 'team']),
  level: z.enum(['L0', 'L1', 'L2', 'L3']),
  files: z.number().int().min(0).max(999),
  confidence: z.number().min(0).max(1),
});

export const REVIEW_CATEGORIES = ['wrong_behavior', 'incomplete', 'regression', 'out_of_scope', 'style'] as const;

export const ReportResultInput = z.strictObject({
  subtaskId,
  verdict: z.enum(['accept', 'reject']),
  by: z.enum(['lead', 'reviewer', 'tester']),
  bySubtaskId: subtaskId.optional(),
  margin: z.enum(['easy', 'normal']).optional(),
  issues: z.number().int().min(0).max(99).optional(),
  categories: z.array(z.enum(REVIEW_CATEGORIES)).max(REVIEW_CATEGORIES.length).optional(),
}).superRefine((v, ctx) => {
  if (v.by !== 'lead' && !v.bySubtaskId) ctx.addIssue({ code: 'custom', path: ['bySubtaskId'], message: 'required when by is "reviewer" or "tester": the subtask of the agent that judged the work' });
  if (v.by === 'lead' && v.bySubtaskId) ctx.addIssue({ code: 'custom', path: ['bySubtaskId'], message: 'only with by "reviewer" or "tester"' });
  if (v.bySubtaskId && v.bySubtaskId === v.subtaskId) ctx.addIssue({ code: 'custom', path: ['bySubtaskId'], message: 'a subtask cannot judge itself' });
  if (v.margin && v.verdict !== 'accept') ctx.addIssue({ code: 'custom', path: ['margin'], message: 'only with verdict "accept"' });
});

export const ESCALATION_REASONS = ['wrong_result', 'review_reject', 'repeated_error', 'verify_gap'] as const;

export const RequestEscalationInput = z.strictObject({
  subtaskId,
  reason: z.enum(ESCALATION_REASONS),
  userConfirmed: z.boolean().optional(),
});

export const RequestScopeInput = z.strictObject({
  subtaskId,
  add: scopeGlobs.optional(),
  remove: scopeGlobs.optional(),
  userConfirmed: z.boolean().optional(),
}).superRefine((v, ctx) => {
  if (!v.add && !v.remove) ctx.addIssue({ code: 'custom', path: ['add'], message: 'give add, remove or both' });
});

export type GetPlanInput = z.infer<typeof GetPlanInput>;
export type ReportTriageInput = z.infer<typeof ReportTriageInput>;
export type ReportResultInput = z.infer<typeof ReportResultInput>;
export type RequestEscalationInput = z.infer<typeof RequestEscalationInput>;
export type RequestScopeInput = z.infer<typeof RequestScopeInput>;

export interface RouterToolInputs {
  router_get_plan: GetPlanInput;
  router_report_triage: ReportTriageInput;
  router_report_result: ReportResultInput;
  router_request_escalation: RequestEscalationInput;
  router_request_scope: RequestScopeInput;
}

// ------------------------------------------------------------------ the tool list

export interface RouterToolDef { name: RouterToolName; description: string; input: z.ZodType }

export const ROUTER_TOOLS: readonly RouterToolDef[] = [
  {
    name: 'router_get_plan', input: GetPlanInput,
    description: 'Do It All Claude Code, lead only. Returns the plan of the current request from the router ledger: level, team, budget and spend, each role slot with the model and effort its next Agent call must use, and the subtasks with their status and verify result. Read-only. Use it after a compaction or resume, or before dispatching a subtask again.',
  },
  {
    name: 'router_report_triage', input: ReportTriageInput,
    description: 'Do It All Claude Code, lead only. Reports your own judgement of the request size before the first subtask is dispatched: direct (L0 trivial, L1 small fix) or team (L2 module-level, L3 new service or architecture change), the number of files you expect to change, and your confidence. The router records it and, when you judge a request larger than planned, re-plans it and returns the team and the Agent call values to use.',
  },
  {
    name: 'router_report_result', input: ReportResultInput,
    description: 'Do It All Claude Code, lead only. Reports the judgement of a finished subtask: accept or reject, and who judged it (you, or a reviewer or tester subtask named in bySubtaskId). Use reject when the result is wrong even though the router\'s verify passed. A reject counts as a failure of that subtask; two failures in a row raise its slot one step, and the answer gives the model and effort for the next attempt.',
  },
  {
    name: 'router_request_escalation', input: RequestEscalationInput,
    description: 'Do It All Claude Code, lead only. Asks to run the next attempt of a finished subtask one ladder step higher without waiting for a second failure. Granted at once after a reviewer or tester reject; on your judgement alone once per slot within the same model. Otherwise the answer is needs_user: ask the user, then call again with userConfirmed true. The answer gives the model and effort to use.',
  },
  {
    name: 'router_request_scope', input: RequestScopeInput,
    description: 'Do It All Claude Code, lead only. Changes the paths a pending or running subtask may edit: add or remove repo-relative globs. For a finished subtask, dispatch it again with a new [scope: ...] line instead. Adding a protected path (.env files, CI config, .claude/) answers needs_user: ask the user, then call again with userConfirmed true.',
  },
];

export function routerToolDef(name: string): RouterToolDef | undefined {
  return ROUTER_TOOLS.find(t => t.name === name);
}

export interface McpToolListEntry { name: string; description: string; inputSchema: Record<string, unknown> }

/** The `tools` array of an MCP tools/list result. Cross-field rules are not in the JSON Schema; the daemon checks them. */
export function routerToolList(): McpToolListEntry[] {
  return ROUTER_TOOLS.map(t => {
    const { $schema: _dialect, ...inputSchema } = z.toJSONSchema(t.input) as Record<string, unknown>;
    return { name: t.name, description: t.description, inputSchema };
  });
}

// ------------------------------------------------------------------ call envelope and errors

/** What the plugin's server posts to the daemon for one tools/call (POST /router/v1/tools/call). */
export const RouterToolCall = z.strictObject({
  tool: z.string().min(1).max(64),
  /** The call's arguments as the client sent them; validated against the tool's schema by the daemon. */
  input: z.unknown().optional(),
  /** `_meta` of the tools/call request, when the client sent one. */
  meta: z.record(z.string(), z.unknown()).optional(),
  bind: z.strictObject({
    /** Random id of the server process. */
    instanceId: z.string().min(1).max(64),
    /** CLAUDE_CODE_SESSION_ID of the server process: the session it was started in, stale after /clear. A tie-breaker only. */
    spawnSessionId: z.string().max(128).optional(),
    projectDir: z.string().max(1024).optional(),
  }),
});
export type RouterToolCall = z.infer<typeof RouterToolCall>;

export const ROUTER_TOOL_ERRORS = {
  daemon_unreachable: 'the router is not running. Continue without this tool; do not retry.',
  not_bound: 'the router could not tell which session made this call. Call the tool again.',
  not_lead: 'router tools are for the lead only.',
  no_request: 'the router has no request in progress for this session.',
  unknown_tool: 'the router does not know this tool.',
  invalid_input: 'the input does not match the tool\'s schema.',
  unknown_subtask: 'no such subtask in the current request.',
  not_finished: 'the subtask is still running; wait for its result.',
  not_running: 'the subtask is finished; dispatch it again with a new [scope: ...] line instead.',
  too_late: 'a subtask was already dispatched for this request; the judgement was not recorded.',
  not_allowed: 'the router does not allow this.',
  needs_user: 'ask the user first, then call again with userConfirmed true.',
  timeout: 'the router did not answer in time.',
  internal: 'the router failed to handle this call. Continue without this tool.',
} as const;
export type RouterToolErrorCode = keyof typeof ROUTER_TOOL_ERRORS;

/** The text of a tool error result (`isError: true`): a code the lead can act on, then one sentence. */
export function routerToolErrorText(code: RouterToolErrorCode, detail?: string): string {
  return `[do-it-all-claude-code] ${code}: ${detail ?? ROUTER_TOOL_ERRORS[code]}`;
}

/** What the daemon answers for one call; the server turns it into the MCP tool result. */
export type RouterToolResult =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; code: RouterToolErrorCode; message: string; result?: Record<string, unknown> };

// ------------------------------------------------------------------ rules without a ledger

/** A lead's level moved to its kind's nearest level, as for the judge: direct is at most L1, team at least L2. */
export function normalizeLeadTriage(v: ReportTriageInput): ReportTriageInput {
  const level: Level = v.kind === 'direct' ? (v.level === 'L0' ? 'L0' : 'L1') : (v.level === 'L3' ? 'L3' : 'L2');
  return { ...v, level };
}

/** Spec 3.5: at most this many raises of a slot, whatever caused them; a further one is the user's decision. */
export const MAX_STEP_UPS = 3;
/** Decision 128: raises of a slot per request on the lead's word alone, without asking the user. */
export const MAX_LEAD_ONLY_RAISES = 1;

export interface EscalationState {
  /** The step the slot runs at now. */
  step: Step;
  /** Raises of the slot so far (misses, rejects, requests). */
  upCount: number;
  fableOptIn: boolean;
  /** 'independent': a finished reviewer or tester subtask rejected the work. 'lead': the lead's judgement only. */
  evidence: 'independent' | 'lead';
  /** Raises already granted on this slot in this request on the lead's word alone. */
  leadOnlyRaises: number;
  /** The ledger shows a user turn after the request that was answered needs_user. */
  userTurn: boolean;
}

export type EscalationDecision =
  | { granted: true; to: Step; leadOnly: boolean }
  | { granted: false; code: 'needs_user'; why: 'limit' | 'tier' | 'second_lead_only' };

/**
 * Whether a requested raise is granted (decision 128). The 3-raise limit and the top step come first and
 * always go to the user (HITL, spec 5.3). A reviewer or tester reject raises at once. The lead's word alone
 * raises once per slot and request, and never across a model change (s2 to s3, s4 to s5); anything more
 * needs a user turn.
 */
export function decideEscalation(s: EscalationState): EscalationDecision {
  const to = s.upCount < MAX_STEP_UPS ? stepUp(s.step, s.fableOptIn) : null;
  if (!to) return { granted: false, code: 'needs_user', why: 'limit' };
  if (s.evidence === 'independent') return { granted: true, to, leadOnly: false };
  if (s.userTurn) return { granted: true, to, leadOnly: false };
  if (crossesTier(s.step, to)) return { granted: false, code: 'needs_user', why: 'tier' };
  if (s.leadOnlyRaises >= MAX_LEAD_ONLY_RAISES) return { granted: false, code: 'needs_user', why: 'second_lead_only' };
  return { granted: true, to, leadOnly: true };
}
