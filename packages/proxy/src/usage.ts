// One usage row per proxied exchange, reported to the daemon (decision 130: proxy rows are the cost source in
// API mode). Rows carry ids, the attribution headers, the model and token counts: never a body, a prompt, a
// header beyond these, or a credential.
//
// Rows are sent in batches to POST /router/v1/usage (daemon token, loopback). When the daemon is down, the
// route is missing (404, before the daemon side exists) or it fails, rows go to <home>/proxy-spool/*.jsonl and
// are sent again later; the daemon takes each row id once, so a replay never double counts.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { errorText, type Logger } from './log.ts';
import type { ProxyPaths } from './paths.ts';
import type { TapResult, Usage } from './tap.ts';

// Core's price table, loaded on its own so the key-holding process runs no third-party code (core's index
// pulls in zod and yaml). Until core exports a `./pricing` subpath, the file is imported by its location.
interface PricingModule {
  costUsd(modelId: string, u: Usage): number | null;
  PRICING_PER_MTOK: Record<string, { input: number; output: number }>;
}
const { PRICING_PER_MTOK, costUsd } = await import(new URL('../../core/src/pricing.ts', import.meta.url).href) as PricingModule;

export type RowState = 'complete' | 'partial' | 'error';

export interface UsageRow {
  id: string;
  messageId: string | null;
  upstreamRequestId: string | null;
  sessionId: string | null;
  agentId: string | null;
  parentAgentId: string | null;
  promptId: string | null;
  requestClass: string | null;
  agentType: string | null;
  path: string;
  model: string | null;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite5m: number; cacheWrite1h: number };
  /** Priced with core's table; for a model without a price, at the most expensive model's rates (an over-estimate). */
  usd: number;
  priced: boolean;
  state: RowState;
  httpStatus: number;
  /** Short hash of the local token used (per-token daily cap); never the token. */
  tokenId: string;
  startedAt: string;
  endedAt: string;
}

/** Attribution headers Claude Code sends (llm-gateway protocol); a value is kept only when it is short and printable. */
export function attribution(headers: http.IncomingHttpHeaders): Pick<UsageRow, 'sessionId' | 'agentId' | 'parentAgentId' | 'promptId' | 'requestClass' | 'agentType'> {
  const h = (name: string): string | null => {
    const v = headers[name];
    const s = Array.isArray(v) ? v[0] : v;
    return typeof s === 'string' && s.length > 0 && s.length <= 128 && /^[\x21-\x7e]+$/.test(s) ? s : null;
  };
  return {
    sessionId: h('x-claude-code-session-id'),
    agentId: h('x-claude-code-agent-id'),
    parentAgentId: h('x-claude-code-parent-agent-id'),
    promptId: h('x-claude-code-prompt-id'),
    requestClass: h('x-claude-code-request-class'),
    agentType: h('x-claude-code-agent-type'),
  };
}

const MOST_EXPENSIVE = Object.entries(PRICING_PER_MTOK).sort((a, b) => b[1].output - a[1].output)[0]![0];

export function price(model: string | null, tap: TapResult): { usd: number; priced: boolean } {
  const u = tap.usage ?? {};
  const known = model ? costUsd(model, u) : null;
  if (known !== null && Number.isFinite(known)) return { usd: round6(known), priced: true };
  const est = costUsd(MOST_EXPENSIVE, u);
  return { usd: round6(est ?? 0), priced: false };
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

export function tokensOf(tap: TapResult): UsageRow['usage'] {
  const u = tap.usage ?? {};
  const w5 = u.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const w1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  return {
    input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? w5 + w1, cacheWrite5m: w5, cacheWrite1h: w1,
  };
}

export interface DaemonTarget { port: number; token: string }

export interface ReporterOptions {
  paths: ProxyPaths;
  /** Where the daemon is now (read at each send: its port or token may change). Undefined: not configured. */
  daemon: () => DaemonTarget | undefined;
  log: Logger;
  batchMs?: number;
  batchSize?: number;
  replayMs?: number;
  timeoutMs?: number;
}

export const USAGE_PATH = '/router/v1/usage';

/** POSTs JSON to the daemon on loopback; resolves the status code (0: no answer). */
export function postDaemon(target: DaemonTarget, p: string, body: unknown, timeoutMs: number): Promise<number> {
  return new Promise(resolve => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: target.port, method: 'POST', path: p, timeout: timeoutMs,
      headers: { authorization: `Bearer ${target.token}`, 'content-type': 'application/json', 'content-length': data.length, host: `127.0.0.1:${target.port}` },
    }, res => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); res.on('error', () => resolve(0)); });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(0));
    req.end(data);
  });
}

export class UsageReporter {
  readonly #o: Required<Omit<ReporterOptions, 'paths' | 'daemon' | 'log'>> & ReporterOptions;
  #queue: UsageRow[] = [];
  #timer: NodeJS.Timeout | undefined;
  #replayTimer: NodeJS.Timeout | undefined;
  #sending: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(o: ReporterOptions) {
    this.#o = { batchMs: 1000, batchSize: 20, replayMs: 30_000, timeoutMs: 3000, ...o };
    fs.mkdirSync(o.paths.spoolDir, { recursive: true, mode: 0o700 });
    this.#replayTimer = setInterval(() => { void this.replay(); }, this.#o.replayMs);
    this.#replayTimer.unref();
  }

  add(row: UsageRow): void {
    if (this.#closed) { this.#spool([row]); return; }
    this.#queue.push(row);
    if (this.#queue.length >= this.#o.batchSize) void this.flush();
    else if (!this.#timer) { this.#timer = setTimeout(() => { void this.flush(); }, this.#o.batchMs); this.#timer.unref(); }
  }

  /** Sends what is queued (rows the daemon does not take go to the spool). */
  flush(): Promise<void> {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = undefined; }
    const rows = this.#queue;
    this.#queue = [];
    if (!rows.length) return this.#sending;
    this.#sending = this.#sending.then(() => this.#send(rows));
    return this.#sending;
  }

  async #send(rows: UsageRow[]): Promise<void> {
    const target = this.#o.daemon();
    const status = target ? await postDaemon(target, USAGE_PATH, { rows }, this.#o.timeoutMs) : 0;
    if (status >= 200 && status < 300) return;
    this.#spool(rows);
    if (status === 404) this.#o.log.info('daemon has no usage route yet: rows spooled', { rows: rows.length });
    else this.#o.log.warn('usage rows spooled', { rows: rows.length, status });
  }

  #spool(rows: UsageRow[]): void {
    try {
      const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const file = path.join(this.#o.paths.spoolDir, `rows-${day}.jsonl`);
      fs.appendFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
    } catch (e) {
      this.#o.log.error('usage rows lost: spool write failed', { rows: rows.length, error: errorText(e) });
    }
  }

  /** Sends spooled rows again; a file is removed once the daemon took all of its rows. */
  async replay(): Promise<number> {
    const target = this.#o.daemon();
    if (!target) return 0;
    let sent = 0;
    let names: string[] = [];
    try { names = fs.readdirSync(this.#o.paths.spoolDir).filter(f => f.endsWith('.jsonl')).sort(); } catch { return 0; }
    for (const name of names) {
      const file = path.join(this.#o.paths.spoolDir, name);
      const work = `${file}.sending`;
      try { fs.renameSync(file, work); } catch { continue; }   // a new file is started by the next spool write
      const rows = fs.readFileSync(work, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l) as UsageRow]; } catch { return []; } });
      let ok = true;
      for (let i = 0; i < rows.length && ok; i += 100) {
        const status = await postDaemon(target, USAGE_PATH, { rows: rows.slice(i, i + 100) }, this.#o.timeoutMs);
        ok = status >= 200 && status < 300;
      }
      if (ok) { sent += rows.length; fs.rmSync(work, { force: true }); }
      else {
        // back to the spool for the next attempt
        fs.appendFileSync(file, fs.readFileSync(work), { mode: 0o600 });
        fs.rmSync(work, { force: true });
        break;
      }
    }
    if (sent) this.#o.log.info('spooled usage rows sent', { rows: sent });
    return sent;
  }

  /** Flushes and stops; rows that cannot be sent stay in the spool. */
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#replayTimer) clearInterval(this.#replayTimer);
    await this.flush();
    await this.#sending;
  }
}
