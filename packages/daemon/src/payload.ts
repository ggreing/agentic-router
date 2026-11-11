// Masked, size-limited copy of a hook payload for the events table.
import { redact } from '@agentic-router/core';

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
