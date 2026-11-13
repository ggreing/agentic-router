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
// Core's price table through its dependency-free subpath: the key-holding process runs no third-party code
// (core's index pulls in zod and yaml; the wire types below are type-only imports, erased at runtime).
import { sealedCall, type UsageRow, type UsageRowState } from '@agentic-router/core';
import { PRICING_PER_MTOK, costUsd } from '@agentic-router/core/pricing';
import { errorText, type Logger } from './log.ts';
import type { ProxyPaths } from './paths.ts';
import type { TapResult } from './tap.ts';

export type { UsageRow };
export type RowState = UsageRowState;

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

/** Where the daemon is: its port and token, and the router home (its endpoint file may name a Unix socket, decision 156). */
export interface DaemonTarget { port: number; token: string; home?: string }

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
export async function postDaemon(target: DaemonTarget, p: string, body: unknown, timeoutMs: number): Promise<number> {
  // decision 156: sealed with the daemon token as the shared secret, which never travels; a listener that is not the
  // daemon gets nothing it can read and gives no answer this accepts, so the rows stay spooled for the real daemon
  try {
    return (await sealedCall({ port: target.port, secret: target.token, method: 'POST', path: p, body: JSON.stringify(body), timeoutMs, ...(target.home ? { home: target.home } : {}) })).status;
  } catch { return 0; }
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
