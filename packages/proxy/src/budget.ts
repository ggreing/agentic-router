// Budget blocking before a request is sent (decision 130; never mid-stream: cutting a stream makes Claude
// Code show an incomplete response and retry). Three caps, checked in order:
//   1. the local token's daily total (decision 131 default $100) - limits what a stolen local token can spend
//   2. the global daily total ($300)
//   3. the request's budget, from the daemon (GET /router/v1/budget, wave 2), plus what this proxy has
//      added since the daemon answered. Without an answer only the daily caps apply (fail open for the
//      request budget, closed for the caps).
// Daily totals live in proxy.db (node:sqlite); a day is the local calendar day.
// Overshoot is bounded by the responses already in flight when a cap is reached.
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import type { DaemonTarget } from './usage.ts';

export type BlockKind = 'token_daily' | 'daily' | 'request';
export interface Block { kind: BlockKind; message: string }

export interface RequestBudget { requestId: string; budgetUsd: number; spentUsd: number }
export type BudgetSource = (sessionId: string, promptId: string) => Promise<RequestBudget | undefined>;

export const BUDGET_PATH = '/router/v1/budget';
const CACHE_MS = 2000;

export const localDay = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const usd = (x: number) => `$${x.toFixed(2)}`;

/** The daemon's request budget for a prompt (wave 2 route); undefined when it has none or does not answer. */
export function daemonBudgetSource(target: () => DaemonTarget | undefined, timeoutMs = 500): BudgetSource {
  return (sessionId, promptId) => new Promise(resolve => {
    const t = target();
    if (!t) { resolve(undefined); return; }
    const q = `?session_id=${encodeURIComponent(sessionId)}&prompt_id=${encodeURIComponent(promptId)}`;
    const req = http.request({
      host: '127.0.0.1', port: t.port, method: 'GET', path: `${BUDGET_PATH}${q}`, timeout: timeoutMs,
      headers: { authorization: `Bearer ${t.token}`, host: `127.0.0.1:${t.port}` },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c as Buffer));
      res.on('end', () => {
        if (res.statusCode !== 200) { resolve(undefined); return; }
        try {
          const o = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Partial<RequestBudget>;
          const ok = typeof o.requestId === 'string' && typeof o.budgetUsd === 'number' && typeof o.spentUsd === 'number';
          resolve(ok ? { requestId: o.requestId!, budgetUsd: o.budgetUsd!, spentUsd: o.spentUsd! } : undefined);
        } catch { resolve(undefined); }
      });
      res.on('error', () => resolve(undefined));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(undefined));
    req.end();
  });
}

export class Budget {
  readonly #db: DatabaseSync;
  readonly #tokenCap: number;
  readonly #dailyCap: number;
  readonly #source: BudgetSource;
  readonly #now: () => Date;
  readonly #cache = new Map<string, { at: number; value: RequestBudget | undefined; added: number }>();

  constructor(o: { dbFile: string; tokenDailyCapUsd: number; dailyCapUsd: number; source: BudgetSource; now?: () => Date }) {
    this.#db = new DatabaseSync(o.dbFile);
    this.#db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;
      CREATE TABLE IF NOT EXISTS daily (day TEXT NOT NULL, token_id TEXT NOT NULL, usd REAL NOT NULL DEFAULT 0, PRIMARY KEY (day, token_id));`);
    this.#tokenCap = o.tokenDailyCapUsd;
    this.#dailyCap = o.dailyCapUsd;
    this.#source = o.source;
    this.#now = o.now ?? (() => new Date());
  }

  spent(tokenId?: string): { token: number; day: number } {
    const day = localDay(this.#now());
    const t = tokenId ? this.#db.prepare('SELECT usd FROM daily WHERE day = ? AND token_id = ?').get(day, tokenId) as { usd?: number } | undefined : undefined;
    const all = this.#db.prepare('SELECT COALESCE(SUM(usd), 0) AS usd FROM daily WHERE day = ?').get(day) as { usd: number };
    return { token: Number(t?.usd ?? 0), day: Number(all.usd) };
  }

  /** Null when the request may go upstream. */
  async check(a: { tokenId: string; sessionId: string | null; promptId: string | null }): Promise<Block | null> {
    const s = this.spent(a.tokenId);
    if (s.token >= this.#tokenCap) {
      return { kind: 'token_daily', message: `agentic-router: the daily cap for this local token is reached (${usd(s.token)} of ${usd(this.#tokenCap)}). It resets at local midnight; change proxy.tokenDailyCapUsd in config.json to raise it.` };
    }
    if (s.day >= this.#dailyCap) {
      return { kind: 'daily', message: `agentic-router: the daily API budget is reached (${usd(s.day)} of ${usd(this.#dailyCap)}). It resets at local midnight; change proxy.dailyCapUsd in config.json to raise it.` };
    }
    if (a.sessionId && a.promptId) {
      const r = await this.#request(a.sessionId, a.promptId);
      if (r && r.value && r.value.spentUsd + r.added >= r.value.budgetUsd) {
        const spent = r.value.spentUsd + r.added;
        return { kind: 'request', message: `agentic-router: the budget of this request is reached (${usd(spent)} of ${usd(r.value.budgetUsd)}). Raise it with /router level, or start a new request.` };
      }
    }
    return null;
  }

  async #request(sessionId: string, promptId: string): Promise<{ value: RequestBudget | undefined; added: number } | undefined> {
    const key = `${sessionId}\n${promptId}`;
    const hit = this.#cache.get(key);
    const now = this.#now().getTime();
    if (hit && now - hit.at < CACHE_MS) return hit;
    let value: RequestBudget | undefined;
    try { value = await this.#source(sessionId, promptId); } catch { value = undefined; }
    // keep the last known answer when the daemon stops answering
    const entry = { at: now, value: value ?? hit?.value, added: value ? 0 : hit?.added ?? 0 };
    this.#cache.set(key, entry);
    if (this.#cache.size > 1000) this.#cache.delete(this.#cache.keys().next().value!);
    return entry;
  }

  /** Counts a priced row against the caps (and the cached request budget until the daemon answers again). */
  add(a: { tokenId: string; sessionId: string | null; promptId: string | null; usd: number }): void {
    if (!(a.usd > 0)) return;
    const day = localDay(this.#now());
    this.#db.prepare(`INSERT INTO daily (day, token_id, usd) VALUES (?, ?, ?)
      ON CONFLICT (day, token_id) DO UPDATE SET usd = usd + excluded.usd`).run(day, a.tokenId, a.usd);
    if (a.sessionId && a.promptId) {
      const hit = this.#cache.get(`${a.sessionId}\n${a.promptId}`);
      if (hit) hit.added += a.usd;
    }
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }
}
