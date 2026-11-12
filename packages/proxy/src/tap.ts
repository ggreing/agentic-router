// Reads usage from a copy of the response bytes. The bytes sent to Claude Code are the upstream's own;
// this parser only looks at its copy: decompressed when the upstream compressed the body, then parsed as
// server-sent events (streaming) or JSON (non-streaming), and only the id, model and usage fields are kept.
//
// Usage of a streamed message = message_start.message.usage, with each later message_delta.usage field
// replacing the earlier value (output_tokens is cumulative; deltas may restate input and cache fields).
import zlib from 'node:zlib';

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

export interface TapResult {
  messageId?: string;
  model?: string;
  usage?: Usage;
  sawStart: boolean;
  sawStop: boolean;
  /** An `error` event inside the stream, or an error JSON body: its type. */
  errorType?: string;
}

/** Data lines of events we do not parse (content deltas) are skipped, never held whole. */
const MAX_EVENT_DATA = 64 * 1024;
const MAX_JSON_BODY = 1024 * 1024;
const PARSED_EVENTS = new Set(['message_start', 'message_delta', 'message_stop', 'error']);

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

function cleanUsage(u: unknown): Usage | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const o = u as Record<string, unknown>;
  const out: Usage = {};
  for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const) {
    const v = num(o[k]);
    if (v !== undefined) out[k] = v;
  }
  const cc = o.cache_creation;
  if (cc && typeof cc === 'object') {
    const c = cc as Record<string, unknown>;
    const w5 = num(c.ephemeral_5m_input_tokens);
    const w1 = num(c.ephemeral_1h_input_tokens);
    if (w5 !== undefined || w1 !== undefined) out.cache_creation = { ...(w5 !== undefined ? { ephemeral_5m_input_tokens: w5 } : {}), ...(w1 !== undefined ? { ephemeral_1h_input_tokens: w1 } : {}) };
  }
  return out;
}

function merge(base: Usage | undefined, delta: Usage | undefined): Usage | undefined {
  if (!delta) return base;
  return { ...(base ?? {}), ...delta, ...(base?.cache_creation || delta.cache_creation ? { cache_creation: { ...base?.cache_creation, ...delta.cache_creation } } : {}) };
}

export class UsageTap {
  readonly result: TapResult = { sawStart: false, sawStop: false };
  readonly #sse: boolean;
  readonly #inflate: zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | undefined;
  readonly #decoder = new TextDecoder();
  #line = '';
  #skipLine = false;
  #event = '';
  #data = '';
  #dataTooLong = false;
  #json = '';
  #jsonTooLong = false;
  #done = false;

  constructor(contentType: string | undefined, contentEncoding: string | undefined) {
    this.#sse = /text\/event-stream/i.test(contentType ?? '');
    const enc = (contentEncoding ?? '').trim().toLowerCase();
    this.#inflate = enc === 'gzip' || enc === 'x-gzip' ? zlib.createGunzip() : enc === 'deflate' ? zlib.createInflate() : enc === 'br' ? zlib.createBrotliDecompress() : undefined;
    if (this.#inflate) {
      this.#inflate.on('data', (c: Buffer) => this.#text(this.#decoder.decode(c, { stream: true })));
      this.#inflate.on('error', () => { /* a broken compressed copy only loses usage, never the response */ });
    }
  }

  /** Feeds a chunk of the response body exactly as it came from the upstream. */
  write(chunk: Buffer): void {
    if (this.#done) return;
    if (this.#inflate) this.#inflate.write(chunk);
    else this.#text(this.#decoder.decode(chunk, { stream: true }));
  }

  /** Ends the copy; resolves when a compressed copy has been fully decoded. */
  end(): Promise<TapResult> {
    if (this.#done) return Promise.resolve(this.result);
    return new Promise(resolve => {
      const finish = () => {
        this.#text(this.#decoder.decode());
        if (this.#sse) { if (!this.#skipLine && this.#line) this.#feedLine(this.#line); this.#dispatch(); } else this.#parseJson();
        this.#done = true;
        resolve(this.result);
      };
      if (this.#inflate) {
        this.#inflate.once('end', finish);
        this.#inflate.once('error', finish);
        this.#inflate.end();
      } else finish();
    });
  }

  #text(s: string): void {
    if (!s) return;
    if (!this.#sse) {
      if (this.#jsonTooLong) return;
      if (this.#json.length + s.length > MAX_JSON_BODY) { this.#jsonTooLong = true; this.#json = ''; return; }
      this.#json += s;
      return;
    }
    let start = 0;
    for (;;) {
      const nl = s.indexOf('\n', start);
      const end = nl < 0 ? s.length : nl;
      if (!this.#skipLine) {
        this.#line += s.slice(start, end);
        // a line too long to keep (a large content delta) is skipped up to its end, never held whole
        if (this.#line.length > MAX_EVENT_DATA) {
          if (this.#line.startsWith('data') && PARSED_EVENTS.has(this.#event)) this.#dataTooLong = true;
          this.#line = '';
          this.#skipLine = true;
        }
      }
      if (nl < 0) break;
      if (this.#skipLine) this.#skipLine = false;
      else this.#feedLine(this.#line);
      this.#line = '';
      start = nl + 1;
    }
  }

  #feedLine(raw: string): void {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === '') { this.#dispatch(); return; }
    if (line.startsWith(':')) return;                         // comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') { this.#event = value; return; }
    if (field === 'data') {
      if (!PARSED_EVENTS.has(this.#event) && this.#event !== '') return;
      if (this.#dataTooLong || this.#data.length + value.length > MAX_EVENT_DATA) { this.#dataTooLong = true; this.#data = ''; return; }
      this.#data = this.#data ? `${this.#data}\n${value}` : value;
    }
  }

  #dispatch(): void {
    const event = this.#event;
    const data = this.#data;
    const tooLong = this.#dataTooLong;
    this.#event = '';
    this.#data = '';
    this.#dataTooLong = false;
    if (!data || tooLong) return;
    let o: Record<string, unknown>;
    try { o = JSON.parse(data) as Record<string, unknown>; } catch { return; }
    const type = typeof o.type === 'string' ? o.type : event;
    if (type === 'message_start') {
      const m = o.message as Record<string, unknown> | undefined;
      this.result.sawStart = true;
      if (typeof m?.id === 'string') this.result.messageId = m.id;
      if (typeof m?.model === 'string') this.result.model = m.model;
      this.result.usage = merge(this.result.usage, cleanUsage(m?.usage));
    } else if (type === 'message_delta') {
      this.result.usage = merge(this.result.usage, cleanUsage(o.usage));
    } else if (type === 'message_stop') {
      this.result.sawStop = true;
    } else if (type === 'error') {
      const e = o.error as Record<string, unknown> | undefined;
      this.result.errorType = typeof e?.type === 'string' ? e.type : 'error';
    }
  }

  #parseJson(): void {
    if (this.#jsonTooLong || !this.#json) return;
    let o: Record<string, unknown>;
    try { o = JSON.parse(this.#json) as Record<string, unknown>; } catch { return; }
    if (o.type === 'message') {
      this.result.sawStart = true;
      this.result.sawStop = true;
      if (typeof o.id === 'string') this.result.messageId = o.id;
      if (typeof o.model === 'string') this.result.model = o.model;
      this.result.usage = cleanUsage(o.usage);
    } else if (o.type === 'error') {
      const e = o.error as Record<string, unknown> | undefined;
      this.result.errorType = typeof e?.type === 'string' ? e.type : 'error';
    }
  }
}
