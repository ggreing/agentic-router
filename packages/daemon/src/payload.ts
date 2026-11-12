// Masked, size-limited copy of a hook payload for the events table.
import { redact } from '@agentic-router/core';
import { AWAITING_USER_MARKER, TASK_NOTIFICATION } from './continuation.ts';

export const MAX_STRING = 2000;
export const MAX_ARRAY = 50;
export const MAX_DEPTH = 6;
export const MAX_PAYLOAD = 16_384;

function compact(v: unknown, secrets: string[], depth: number): unknown {
  if (typeof v === 'string') {
    const s = redact(v, secrets);
    return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…[${s.length - MAX_STRING} chars omitted]` : s;
  }
  if (v === null || typeof v !== 'object') return v;
  if (depth >= MAX_DEPTH) return '[nested]';
  if (Array.isArray(v)) {
    const head = v.slice(0, MAX_ARRAY).map(x => compact(x, secrets, depth + 1));
    if (v.length > MAX_ARRAY) head.push(`[${v.length - MAX_ARRAY} items omitted]`);
    return head;
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = compact(x, secrets, depth + 1);
  return out;
}

// ------------------------------------------------------------------ decisions 141-142: minimal hook payloads
//
// With recordPrompts off, a hook payload is stored (events table) and spooled (plugin/hooks/relay.mjs, which
// carries a copy of this function; a test keeps the two equal) in a minimal form: an allowlist of fields per
// event, prose replaced by its size. Kept: ids, tool name, model, effort, paths, flags, verify-env names, and
// what a replay needs to route the same way: a task notification's structured tags (ids, status, usage, the
// worktree) without its summary and result, the Agent prompt's [subtask:]/[scope:] lines without the spec, and
// the awaiting-user marker without the message. Dropped: the user's prompt, /compact instructions, the lead's
// and subagents' last messages, the Agent spec, the Agent result. `_min: 1` marks the form (idempotent).

export const MINIMAL_MARK = '_min';
const KEEP = ['hook_event_name', 'session_id', 'agent_id', 'agent_type', 'prompt_id', 'tool_name', 'tool_use_id', 'permission_mode', 'cwd',
  'transcript_path', 'agent_transcript_path', 'source', 'model', 'trigger', 'stop_hook_active', 'routerClient'] as const;
const AGENT_INPUT = ['subagent_type', 'model', 'effort', 'isolation', 'run_in_background'] as const;
const AGENT_RESPONSE = ['status', 'agentId', 'agentType', 'resolvedModel', 'isAsync', 'totalTokens', 'totalDurationMs', 'totalToolUseCount',
  'worktreePath', 'worktreeBranch', 'outputFile', 'usage'] as const;
const ROUTER_TOOL = /^mcp__plugin_agentic-router_router__/;
// the dispatch lines the router parses (policy.ts): the tag that starts line 1, the scope that is line 2
const TAG_LINE = /^\s*\[subtask:\s*([A-Za-z0-9_.-]{1,64})\s*\]/;
const SCOPE_LINE = /^\s*\[scope:[^\]]*\]\s*$/;
const NOTIFICATION_TAGS = ['task-id', 'tool-use-id', 'output-file', 'status'] as const;
const PATH_LIKE = /^[^<>\n]{1,1024}$/;

export type PromptKind = 'user' | 'notification' | 'command';
export const promptKind = (prompt: string): PromptKind => (TASK_NOTIFICATION.test(prompt) ? 'notification' : /^\s*\//.test(prompt) ? 'command' : 'user');

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const tagOf = (src: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(src)?.[1]?.trim();

/** A task notification reduced to its structured tags, in a fixed order (so reducing it again gives the same text). */
export function notificationSkeleton(prompt: string): string {
  const lines = ['<task-notification>'];
  for (const t of NOTIFICATION_TAGS) { const v = tagOf(prompt, t); if (v && PATH_LIKE.test(v)) lines.push(`<${t}>${v}</${t}>`); }
  const wt = tagOf(prompt, 'worktree');
  if (wt) {
    const parts = (['worktreePath', 'worktreeBranch'] as const).map(t => [t, tagOf(wt, t)] as const).filter(([, v]) => v && PATH_LIKE.test(v));
    if (parts.length) lines.push(`<worktree>${parts.map(([t, v]) => `<${t}>${v}</${t}>`).join('')}</worktree>`);
  }
  const usage = tagOf(prompt, 'usage');
  if (usage) {
    const parts = (['subagent_tokens', 'tool_uses', 'duration_ms'] as const).map(t => [t, tagOf(usage, t)] as const).filter(([, v]) => v && /^\d{1,12}$/.test(v));
    if (parts.length) lines.push(`<usage>${parts.map(([t, v]) => `<${t}>${v}</${t}>`).join('')}</usage>`);
  }
  lines.push('</task-notification>');
  return lines.join('\n');
}

/** The minimal form of a hook input (see above); a payload already in it comes out unchanged. */
export function minimalPayload(raw: unknown): unknown {
  if (!isObj(raw)) return raw;
  const again = raw[MINIMAL_MARK] === 1;
  const size = (o: Obj, k: string): number | undefined => (again && typeof o[`${k}_chars`] === 'number' ? o[`${k}_chars`] as number : typeof o[k] === 'string' ? (o[k] as string).length : undefined);
  const out: Obj = { [MINIMAL_MARK]: 1 };
  for (const k of KEEP) if (raw[k] !== undefined) out[k] = raw[k];
  // verify-env names only (decision 142): the values reach the daemon live and stay in its memory
  if (raw.verifyEnv !== undefined) {
    out.verifyEnv = (isObj(raw.verifyEnv) ? Object.keys(raw.verifyEnv) : Array.isArray(raw.verifyEnv) ? raw.verifyEnv : []).filter((k): k is string => typeof k === 'string').sort();
  }
  const event = String(raw.hook_event_name ?? '');
  if (event === 'UserPromptSubmit' || raw.prompt !== undefined || raw.prompt_chars !== undefined) {
    const kind: PromptKind = again && (raw.prompt_kind === 'user' || raw.prompt_kind === 'notification' || raw.prompt_kind === 'command')
      ? raw.prompt_kind : promptKind(typeof raw.prompt === 'string' ? raw.prompt : '');
    const n = size(raw, 'prompt');
    if (n !== undefined) out.prompt_chars = n;
    out.prompt_kind = kind;
    if (kind === 'notification' && typeof raw.prompt === 'string') out.prompt = notificationSkeleton(raw.prompt);
  }
  for (const k of ['custom_instructions', 'last_assistant_message']) {
    const n = size(raw, k);
    if (n !== undefined) out[`${k}_chars`] = n;
  }
  if (typeof raw.last_assistant_message === 'string' && raw.last_assistant_message.includes(AWAITING_USER_MARKER)) out.last_assistant_message = AWAITING_USER_MARKER;
  const tool = typeof raw.tool_name === 'string' ? raw.tool_name : '';
  if (isObj(raw.tool_input)) {
    if (tool === 'Agent') {
      const ti = raw.tool_input;
      const t: Obj = {};
      for (const k of AGENT_INPUT) if (ti[k] !== undefined) t[k] = ti[k];
      const n = size(ti, 'prompt');
      if (n !== undefined) t.prompt_chars = n;
      const ls = typeof ti.prompt === 'string' ? ti.prompt.split(/\r?\n/) : [];
      const tag = TAG_LINE.exec(ls[0] ?? '')?.[1];
      const scope = SCOPE_LINE.test(ls[1] ?? '') ? ls[1]!.trim() : undefined;
      if (tag || scope) t.prompt = scope ? `${tag ? `[subtask:${tag}]` : ''}\n${scope}` : `[subtask:${tag}]`;
      out.tool_input = t;
    } else if (ROUTER_TOOL.test(tool)) out.tool_input = raw.tool_input;   // router tool arguments: ids, enums and globs only (core/tools.ts)
    else out.tool_input = {};
  }
  if (isObj(raw.tool_response) && tool === 'Agent') {
    const tr = raw.tool_response;
    const r: Obj = {};
    for (const k of AGENT_RESPONSE) if (tr[k] !== undefined) r[k] = tr[k];
    const text = Array.isArray(tr.content) ? tr.content.reduce((a: number, b: unknown) => a + (isObj(b) && typeof b.text === 'string' ? b.text.length : 0), 0) : undefined;
    const n = again && typeof tr.text_chars === 'number' ? tr.text_chars : text;
    if (n !== undefined) r.text_chars = n;
    out.tool_response = r;
  }
  return out;
}

/**
 * The kind of a stored prompt_submit payload: its `prompt_kind`, or (kept with recordPrompts, or written before
 * decision 141) read off the prompt text. Undefined when the payload does not parse.
 */
export function storedPromptKind(payload: string): PromptKind | undefined {
  try {
    const p = JSON.parse(payload) as { prompt_kind?: unknown; prompt?: unknown };
    if (p.prompt_kind === 'user' || p.prompt_kind === 'notification' || p.prompt_kind === 'command') return p.prompt_kind;
    return promptKind(String(p.prompt ?? ''));
  } catch { return undefined; }
}

export function eventPayload(raw: unknown, secrets: string[] = []): string {
  let s = redact(JSON.stringify(compact(raw, secrets, 0)) ?? 'null', secrets);
  if (s.length > MAX_PAYLOAD) s = `${s.slice(0, MAX_PAYLOAD)}…[truncated ${s.length - MAX_PAYLOAD} chars]`;
  return s;
}

/** Short masked text for signal details and block reasons. Keeps the end, where errors usually are. */
export function tailText(text: string, max: number, secrets: string[] = []): string {
  const s = redact(text, secrets).trim();
  return s.length > max ? `…${s.slice(s.length - max)}` : s;
}
