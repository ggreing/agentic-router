// Subagent cost from its transcript (decision 84, after integration run 2).
// PostToolUse(Agent) carries only the last API call's usage, and none at all when the Agent tool runs
// asynchronously, so the daemon reads SubagentStop's agent_transcript_path instead: every assistant
// message usage, de-duplicated by message.id (one response is written as one line per content block,
// each repeating the same usage), priced per call with core costUsd (so the Haiku long-prompt rate
// applies per call), and summed per model.
// Only message.id, model and usage are read; no conversation content reaches the ledger or the log.
// An unexpected format never throws: it yields { ok: false } and the decision-84 estimate path applies.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { costUsd, type Usage } from '@agentic-router/core';

export const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024;

export interface ModelUsage {
  modelId: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  usd: number | null;            // null when the model has no price
}

export type TranscriptUsage = { ok: true; models: ModelUsage[] } | { ok: false; reason: string };

export async function readTranscriptUsage(file: string | undefined): Promise<TranscriptUsage> {
  if (!file) return { ok: false, reason: 'no agent_transcript_path in SubagentStop' };
  if (!path.isAbsolute(file) || path.extname(file) !== '.jsonl') return { ok: false, reason: 'agent_transcript_path is not an absolute .jsonl path' };
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return { ok: false, reason: 'transcript not found' };
  }
  if (!st.isFile()) return { ok: false, reason: 'transcript is not a file' };
  if (st.size > MAX_TRANSCRIPT_BYTES) return { ok: false, reason: `transcript larger than ${MAX_TRANSCRIPT_BYTES} bytes` };

  const calls = new Map<string, { model: string; usage: Usage }>();
  try {
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes('"assistant"') || !line.includes('"usage"')) continue;
      let o: { type?: unknown; message?: { id?: unknown; model?: unknown; usage?: unknown } };
      try { o = JSON.parse(line); } catch { continue; }
      const m = o.message;
      if (o.type !== 'assistant' || !m || typeof m.id !== 'string' || !m.usage || typeof m.usage !== 'object') continue;
      calls.set(m.id, { model: typeof m.model === 'string' ? m.model : 'unknown', usage: m.usage as Usage });   // last line wins
    }
  } catch (e) {
    return { ok: false, reason: `transcript unreadable: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
  }

  return { ok: true, models: aggregateCalls(calls) };
}

/** Per-model sums of de-duplicated API calls, each priced with core costUsd; zero-usage lines are skipped. */
function aggregateCalls(calls: Map<string, { model: string; usage: Usage }>): ModelUsage[] {
  const byModel = new Map<string, ModelUsage>();
  for (const { model, usage: raw } of calls.values()) {
    const u = cleanUsage(raw);
    // Audit #14: a line without any tokens (e.g. model "<synthetic>", written by Claude Code itself) is no API call.
    if (!u.input_tokens && !u.output_tokens && !u.cache_read_input_tokens && !u.cache_creation_input_tokens) continue;
    const row = byModel.get(model) ?? { modelId: model, calls: 0, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, usd: 0 };
    row.calls++;
    row.inputTokens += u.input_tokens ?? 0;
    row.outputTokens += u.output_tokens ?? 0;
    row.cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
    row.cacheReadTokens += u.cache_read_input_tokens ?? 0;
    const usd = costUsd(model, u);
    row.usd = usd === null || !Number.isFinite(usd) || row.usd === null ? null : row.usd + usd;
    byModel.set(model, row);
  }
  for (const r of byModel.values()) if (r.usd !== null) r.usd = Math.round(r.usd * 1e6) / 1e6;
  return [...byModel.values()];
}

/** Which part of the main session's transcript belongs to one request (T7). */
export interface RequestSpan {
  /** prompt_id of every prompt of the request (opening prompt, answers, task notifications). */
  promptIds: ReadonlySet<string>;
  /** Used for lines that carry no prompt id: the request's open and close times (ISO). */
  from: string;
  to: string;
}

/** promptId: lines tied to the request's prompts; time: the request's time window (no prompt ids, or none of them matched). */
export type LeadMatch = 'promptId' | 'time';
export type LeadUsage = { ok: true; models: ModelUsage[]; leadModel: string | null; calls: number; matchedBy: LeadMatch } | { ok: false; reason: string };

/**
 * T7: the lead's (main session's) API usage during one request, from its transcript, de-duplicated by
 * message.id like decision 84. Claude Code writes promptId on user lines only (prompts and tool results),
 * so in file order every assistant line belongs to the promptId of the nearest user line above it
 * (sidechain lines skipped). Lines of the request's prompts (the opening prompt, answers and task
 * notifications) count. Without prompt ids in the transcript, or when none of them is one of the
 * request's (the hook's prompt_id and the transcript's could differ), the request's time window decides.
 * Only ids, model, usage, promptId, timestamp and isSidechain are read; no conversation content.
 */
export async function readLeadUsage(file: string | undefined, span: RequestSpan): Promise<LeadUsage> {
  if (!file) return { ok: false, reason: 'no transcript_path' };
  if (!path.isAbsolute(file) || path.extname(file) !== '.jsonl') return { ok: false, reason: 'transcript_path is not an absolute .jsonl path' };
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { ok: false, reason: 'transcript is not a file' };
    if (st.size > MAX_TRANSCRIPT_BYTES) return { ok: false, reason: `transcript larger than ${MAX_TRANSCRIPT_BYTES} bytes` };
  } catch {
    return { ok: false, reason: 'transcript not found' };
  }
  const from = Date.parse(span.from);
  const to = Date.parse(span.to);
  type Call = { model: string; usage: Usage };
  const byPrompt = new Map<string, Call>();
  const byTime = new Map<string, Call>();
  let lastByPrompt: string | null = null;
  let lastByTime: string | null = null;
  let current: string | undefined;
  let matched = false;
  try {
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes('"type"')) continue;
      let o: { type?: unknown; isSidechain?: unknown; promptId?: unknown; timestamp?: unknown; message?: { id?: unknown; model?: unknown; usage?: unknown } };
      try { o = JSON.parse(line); } catch { continue; }
      if (o.isSidechain === true) continue;
      if (o.type === 'user' && typeof o.promptId === 'string') {
        current = o.promptId;
        if (span.promptIds.has(current)) matched = true;
      }
      const m = o.message;
      if (o.type !== 'assistant' || !m || typeof m.id !== 'string' || !m.usage || typeof m.usage !== 'object') continue;
      const pid = typeof o.promptId === 'string' ? o.promptId : current;
      const at = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
      const model = typeof m.model === 'string' ? m.model : 'unknown';
      const call = { model, usage: m.usage as Usage };
      if (pid !== undefined && span.promptIds.has(pid)) {
        byPrompt.set(m.id, call);
        if (model !== '<synthetic>') lastByPrompt = model;
      }
      if (Number.isFinite(at) && at >= from && at <= to) {
        byTime.set(m.id, call);
        if (model !== '<synthetic>') lastByTime = model;
      }
    }
  } catch (e) {
    return { ok: false, reason: `transcript unreadable: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
  }
  const matchedBy: LeadMatch = matched ? 'promptId' : 'time';
  const models = aggregateCalls(matched ? byPrompt : byTime);
  return { ok: true, models, leadModel: matched ? lastByPrompt : lastByTime, calls: models.reduce((a, x) => a + x.calls, 0), matchedBy };
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * Audit #9: the repo-relative paths this subagent's edit tools wrote (tool inputs' file_path /
 * notebook_path only; nothing else of the transcript is read). Undefined when the transcript is unreadable.
 */
export async function readEditedPaths(file: string | undefined, root: string): Promise<string[] | undefined> {
  if (!file || !path.isAbsolute(file) || path.extname(file) !== '.jsonl') return undefined;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_TRANSCRIPT_BYTES) return undefined;
  } catch {
    return undefined;
  }
  const out = new Set<string>();
  try {
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes('"tool_use"')) continue;
      let o: { type?: unknown; message?: { content?: unknown } };
      try { o = JSON.parse(line); } catch { continue; }
      if (o.type !== 'assistant' || !Array.isArray(o.message?.content)) continue;
      for (const b of o.message.content as Array<{ type?: unknown; name?: unknown; input?: { file_path?: unknown; notebook_path?: unknown } }>) {
        if (b?.type !== 'tool_use' || typeof b.name !== 'string' || !EDIT_TOOLS.has(b.name)) continue;
        const p = typeof b.input?.file_path === 'string' ? b.input.file_path : typeof b.input?.notebook_path === 'string' ? b.input.notebook_path : undefined;
        if (!p) continue;
        const rel = path.relative(root, path.resolve(root, p)).replace(/\\/g, '/');
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) out.add(rel);
      }
    }
  } catch {
    return undefined;
  }
  return [...out];
}

const TAG = /\[subtask:([A-Za-z0-9_-]+)\]/;
const TAG_HEAD_BYTES = 64 * 1024;

/**
 * Audit E16: the `[subtask:<ID>]` tag of the prompt the subagent was started with, from the head of its
 * own transcript (the first user message), or undefined. Foreground Agent calls can start out of order,
 * so this tag, not the start order, says which subtask an agent works on. Same contract as the adapter's
 * subtaskTagFromTranscript; read here because the daemon loads the adapter only through its seam.
 */
export function readSubtaskTag(file: string | undefined): string | undefined {
  if (!file || !path.isAbsolute(file) || path.extname(file) !== '.jsonl') return undefined;
  let head: string;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(TAG_HEAD_BYTES);
      head = buf.subarray(0, fs.readSync(fd, buf, 0, TAG_HEAD_BYTES, 0)).toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch {
    return undefined;   // not written yet, or unreadable
  }
  for (const line of head.split(/\r?\n/)) {
    if (!line.includes('"user"')) continue;
    try {
      const o = JSON.parse(line) as { type?: unknown; message?: { content?: unknown } };
      if (o.type !== 'user') continue;
      const c = o.message?.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => (typeof b?.text === 'string' ? b.text : '')).join('\n') : '';
      return TAG.exec(text)?.[1];   // the first user message is the prompt; no tag there: none
    } catch {
      return TAG.exec(line)?.[1];   // a first line cut at the read limit
    }
  }
  return undefined;
}

const tok = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

/** Only the token counts, as non-negative numbers; anything else in the usage block is ignored. */
function cleanUsage(u: Usage): Usage {
  const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : undefined;
  const w1h = tok(cc?.ephemeral_1h_input_tokens);
  const w5m = tok(cc?.ephemeral_5m_input_tokens);
  return {
    input_tokens: tok(u.input_tokens) ?? 0,
    output_tokens: tok(u.output_tokens) ?? 0,
    cache_read_input_tokens: tok(u.cache_read_input_tokens) ?? 0,
    cache_creation_input_tokens: tok(u.cache_creation_input_tokens) ?? 0,
    ...(w1h !== undefined || w5m !== undefined ? { cache_creation: { ephemeral_1h_input_tokens: w1h ?? 0, ephemeral_5m_input_tokens: w5m ?? 0 } } : {}),
  };
}
