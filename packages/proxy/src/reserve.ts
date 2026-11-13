// The hold a POST /v1/messages puts on the daily caps while it is in flight, sized from the request itself
// (Appendix B: a request may not start when its worst case does not fit in what is left of a cap). The proxy reads
// a bounded copy of the body for this and forwards the bytes exactly as received; nothing here changes them.
//
//   hold = (promptBytes x dearest input-side rate + max_tokens x output rate) x the model's fast multiple for speed "fast"
//
//   promptBytes  the decoded body length. Every token covers at least one byte of the UTF-8 JSON text, and JSON
//                syntax, escapes and base64 media only add bytes per token, so the byte count bounds the prompt's
//                tokens from above (content the API fetches itself, such as a file_id document or a server tool's
//                result, is not in the body; settle charges it afterwards).
//   input rate   the model's highest input-side price: its long-prompt rate where it has one, at the 1-hour cache
//                write multiplier (2x), the dearest way a prompt token is billed (Claude Code marks most of its
//                prompt for caching, and a cache miss writes all of it).
//   output rate  the model's highest output price (the long-prompt rate where it has one).
//   model        one core's price table does not know (or no model at all) is priced as the dearest model in the
//                table for this request (decision 103).
// Settle replaces the hold with the actual cost (server.ts).
import zlib from 'node:zlib';
import { CACHE_MULTIPLIER, PRICING_PER_MTOK, type ModelPrice } from '@do-it-all-claude-code/core/pricing';

/** The Messages API's request size limit (32 MB, read as MiB so a body the API accepts is never refused here). */
export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
/** max_tokens when the body has no usable one: the largest output of the current models (the API refuses such a request, and the hold is released). */
export const MAX_TOKENS_FALLBACK = 128_000;
/** Fast mode for a model the price table gives no fast multiple (the published fast prices are all 2x). */
export const FAST_MODE_MULTIPLIER = 2;

export interface RequestShape {
  model: string | null;
  maxTokens: number | null;
  fast: boolean;
  /** Bytes of the decoded body (MAX_REQUEST_BYTES when it could not be decoded). */
  promptBytes: number;
  /** Why the body could not be read, when it could not (the hold is then the largest request). */
  unreadable?: string;
}

const DECODERS: Record<string, ((b: Buffer, o: zlib.ZlibOptions) => Buffer) | undefined> = {
  gzip: zlib.gunzipSync, 'x-gzip': zlib.gunzipSync, deflate: zlib.inflateSync,
  br: (b, o) => zlib.brotliDecompressSync(b, o),
  zstd: (zlib as { zstdDecompressSync?: (b: Buffer, o: zlib.ZlibOptions) => Buffer }).zstdDecompressSync,
};

/** The body decoded (bounded, so a compressed bomb cannot exhaust memory); a reason when it cannot be. */
function decode(body: Buffer, contentEncoding: string | undefined, limit: number): Buffer | string {
  const enc = (contentEncoding ?? '').trim().toLowerCase();
  if (!enc || enc === 'identity') return body;
  const d = DECODERS[enc];
  if (!d) return `content-encoding ${enc.slice(0, 40)} cannot be read`;
  try { return d(body, { maxOutputLength: limit }); } catch (e) {
    return e instanceof RangeError ? `decoded body over ${limit} bytes` : `${enc} body cannot be decoded`;
  }
}

/** model, max_tokens and speed from a request body; nothing else of it is looked at. */
export function requestShape(body: Buffer, contentEncoding: string | undefined, limit = MAX_REQUEST_BYTES): RequestShape {
  const text = decode(body, contentEncoding, limit);
  if (typeof text === 'string') return { model: null, maxTokens: null, fast: false, promptBytes: limit, unreadable: text };
  let o: Record<string, unknown> = {};
  try {
    const v: unknown = JSON.parse(text.toString('utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) o = v as Record<string, unknown>;
  } catch { /* not JSON: the API refuses it; priced as the dearest model with the fallback max_tokens */ }
  const mt = o.max_tokens;
  return {
    model: typeof o.model === 'string' ? o.model : null,
    maxTokens: typeof mt === 'number' && Number.isInteger(mt) && mt >= 0 ? mt : null,
    fast: o.speed === 'fast',
    promptBytes: text.length,
  };
}

/** USD per token at a model's dearest input-side rate and its dearest output rate. */
function rates(p: ModelPrice): { input: number; output: number } {
  const inputBase = Math.max(p.input, p.longPromptInput ?? 0);
  const write = Math.max(CACHE_MULTIPLIER.write1h, CACHE_MULTIPLIER.write5m, 1);
  return { input: (inputBase * write) / 1e6, output: Math.max(p.output, p.longPromptOutput ?? 0) / 1e6 };
}

export interface Reservation {
  usd: number;
  /** The model the hold was priced as: the request's own, or the dearest one for an unknown model. */
  pricedAs: string;
  /** One line for the 429 message and the log. */
  basis: string;
}

export function reservationFor(s: RequestShape): Reservation {
  const maxTokens = s.maxTokens ?? MAX_TOKENS_FALLBACK;
  const cost = (p: ModelPrice) => { const r = rates(p); return (s.promptBytes * r.input + maxTokens * r.output) * (s.fast ? p.fast ?? FAST_MODE_MULTIPLIER : 1); };
  const known = s.model !== null && Object.hasOwn(PRICING_PER_MTOK, s.model) ? s.model : null;
  let pricedAs = known ?? '';
  let usd = known ? cost(PRICING_PER_MTOK[known]!) : -1;
  if (!known) for (const [id, p] of Object.entries(PRICING_PER_MTOK)) { const c = cost(p); if (c > usd) { usd = c; pricedAs = id; } }
  usd = Math.ceil(usd * 1e6) / 1e6;
  const model = known ? known : `${s.model === null ? 'no model' : 'an unknown model'}, priced as ${pricedAs}`;
  const basis = s.unreadable
    ? `${s.unreadable}, so it is held as the largest request (${model})`
    : `${model}, up to ${s.promptBytes} prompt bytes and max_tokens ${maxTokens}${s.maxTokens === null ? ' (none given)' : ''}${s.fast ? ', fast mode' : ''}`;
  return { usd, pricedAs, basis };
}
