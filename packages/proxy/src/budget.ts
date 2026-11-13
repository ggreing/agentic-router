// Budget blocking before a request is sent (decision 130; never mid-stream: cutting a stream makes Claude
// Code show an incomplete response and retry). Three caps, checked in order:
//   1. the local token's daily total (decision 131 default $100) - limits what a stolen local token can spend
//   2. the global daily total ($300)
//   3. the request's budget, from the daemon (GET /router/v1/budget, wave 2), plus what this proxy has
//      added since the daemon answered. Without an answer only the daily caps apply (fail open for the
//      request budget, closed for the caps).
// Daily totals live in proxy.db (node:sqlite); a day is the local calendar day.
// A POST /v1/messages holds its worst case (reserve.ts) against the daily caps from the check to the end of its
// response, and starts only when that hold fits in what is left: a cap is passed only by what the request body
// cannot show (content the API fetches itself), not by requests in flight.
import { sealedCall, type BudgetAnswer } from '@do-it-all-claude-code/core';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { DaemonTarget } from './usage.ts';

export type BlockKind = 'token_daily' | 'daily' | 'request';
export interface Block { kind: BlockKind; message: string }

/** The daemon's answer for a request (core proxy-wire). */
export type RequestBudget = BudgetAnswer;
export type BudgetSource = (sessionId: string, promptId: string) => Promise<RequestBudget | undefined>;

export const BUDGET_PATH = '/router/v1/budget';
const CACHE_MS = 2000;

export const localDay = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const usd = (x: number) => `$${x.toFixed(2)}`;
/** Small amounts keep their cents' fractions, so a hold of $0.004 does not read as $0.00. */
const money = (x: number) => (x > 0 && x < 1 ? `$${x.toFixed(4)}` : usd(x));

/**
 * The daemon's request budget for a prompt (wave 2 route); undefined when it has none or does not answer.
 * Decision 156: a sealed call (core sealedCall), so the daemon token never travels: a listener on the daemon's
 * port without the token learns nothing and cannot answer, and the request budget then fails open.
 */
export function daemonBudgetSource(target: () => DaemonTarget | undefined, timeoutMs = 500): BudgetSource {
  return async (sessionId, promptId) => {
    const t = target();
    if (!t) return undefined;
    const q = `?session_id=${encodeURIComponent(sessionId)}&prompt_id=${encodeURIComponent(promptId)}`;
    try {
      const r = await sealedCall({ port: t.port, secret: t.token, method: 'GET', path: `${BUDGET_PATH}${q}`, timeoutMs, ...(t.home ? { home: t.home } : {}) });
      if (r.status !== 200) return undefined;
      const o = JSON.parse(r.body) as Partial<RequestBudget>;
      const ok = typeof o.requestId === 'string' && typeof o.budgetUsd === 'number' && typeof o.spentUsd === 'number';
      return ok ? { requestId: o.requestId!, budgetUsd: o.budgetUsd!, spentUsd: o.spentUsd! } : undefined;
    } catch { return undefined; }
  };
}

export class Budget {
  readonly #db: DatabaseSync;
  readonly #tokenCap: number;
  readonly #dailyCap: number;
  readonly #source: BudgetSource;
  readonly #now: () => Date;
  readonly #cache = new Map<string, { at: number; value: RequestBudget | undefined; added: number }>();
  // A6: a worst-case amount reserved against the daily caps at check time and replaced with the actual at settle.
  readonly #pending = new Map<string, { tokenId: string; sessionId: string | null; promptId: string | null; reserved: number; day: string }>();

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

  /**
   * A6: checks the caps and, if clear, RESERVES a worst-case amount synchronously so a concurrent burst
   * cannot all pass one cap (the reservation is in the daily totals that the next check reads). Returns a
   * reservation id to settle() after the response, or a Block. The reservation is released if the request
   * budget blocks. `spent()` already includes outstanding reservations.
   */
  async check(a: { tokenId: string; sessionId: string | null; promptId: string | null; reserveUsd: number; reserveBasis?: string }): Promise<{ block: Block } | { reservationId: string }> {
    // synchronous critical section — no await before the reserve, so concurrent checks see each other's holds
    const s = this.spent(a.tokenId);
    const reserved = a.reserveUsd > 0 ? a.reserveUsd : 0;
    if (s.token >= this.#tokenCap) {
      return { block: { kind: 'token_daily', message: `do-it-all-claude-code: the daily cap for this local token is reached (${usd(s.token)} of ${usd(this.#tokenCap)}). It resets at local midnight; change proxy.tokenDailyCapUsd in config.json to raise it.` } };
    }
    if (s.day >= this.#dailyCap) {
      return { block: { kind: 'daily', message: `do-it-all-claude-code: the daily API budget is reached (${usd(s.day)} of ${usd(this.#dailyCap)}). It resets at local midnight; change proxy.dailyCapUsd in config.json to raise it.` } };
    }
    // the request's own worst case must fit in what is left (in-flight holds included): a request is never started
    // that could take a cap past its limit on its own
    const doesNotFit = (kind: 'token_daily' | 'daily', capName: string, cap: number, spent: number, setting: string): Block => ({
      kind,
      message: `do-it-all-claude-code: this request is held at up to ${money(reserved)} (its worst case${a.reserveBasis ? `: ${a.reserveBasis}` : ''}), `
        + `more than the ${money(Math.max(0, cap - spent))} left of ${capName} (${usd(spent)} of ${usd(cap)} used or held). `
        + `A lower max_tokens or a shorter conversation needs less; ${setting} in config.json raises the cap, and it resets at local midnight.`,
    });
    if (s.token + reserved > this.#tokenCap) return { block: doesNotFit('token_daily', 'the daily cap for this local token', this.#tokenCap, s.token, 'proxy.tokenDailyCapUsd') };
    if (s.day + reserved > this.#dailyCap) return { block: doesNotFit('daily', 'the daily API budget', this.#dailyCap, s.day, 'proxy.dailyCapUsd') };
    const reservationId = randomUUID();
    const day = localDay(this.#now());
    this.#addDaily(day, a.tokenId, reserved);
    this.#pending.set(reservationId, { tokenId: a.tokenId, sessionId: a.sessionId, promptId: a.promptId, reserved, day });
    // request budget (async): if it blocks, release the reservation
    if (a.sessionId && a.promptId) {
      const r = await this.#request(a.sessionId, a.promptId);
      if (r && r.value && r.value.spentUsd + r.added >= r.value.budgetUsd) {
        this.settle(reservationId, 0);
        const spent = r.value.spentUsd + r.added;
        return { block: { kind: 'request', message: `do-it-all-claude-code: the budget of this request is reached (${usd(spent)} of ${usd(r.value.budgetUsd)}). Raise it with /router level, or start a new request.` } };
      }
    }
    return { reservationId };
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

  /** Adds (or, with a negative usd, removes) to a day's token total. */
  #addDaily(day: string, tokenId: string, usd: number): void {
    if (usd === 0) return;
    this.#db.prepare(`INSERT INTO daily (day, token_id, usd) VALUES (?, ?, ?)
      ON CONFLICT (day, token_id) DO UPDATE SET usd = MAX(0, usd + excluded.usd)`).run(day, tokenId, usd);
  }

  /** A6: replaces a reservation with the actual (or an estimate) cost. A 2xx that could not be priced should
   *  still pass a positive estimate here so an unparsed success or a partial stream is charged, not free. */
  settle(reservationId: string, actualUsd: number): void {
    const p = this.#pending.get(reservationId);
    if (!p) return;
    this.#pending.delete(reservationId);
    const actual = actualUsd > 0 ? actualUsd : 0;
    this.#addDaily(p.day, p.tokenId, actual - p.reserved);   // net: the reservation becomes the real cost
    if (actual > 0 && p.sessionId && p.promptId) {
      const hit = this.#cache.get(`${p.sessionId}\n${p.promptId}`);
      if (hit) hit.added += actual;
    }
  }

  /** Directly counts a priced amount against the caps (seeding, and any non-reserving caller). */
  add(a: { tokenId: string; sessionId: string | null; promptId: string | null; usd: number }): void {
    if (!(a.usd > 0)) return;
    this.#addDaily(localDay(this.#now()), a.tokenId, a.usd);
    if (a.sessionId && a.promptId) {
      const hit = this.#cache.get(`${a.sessionId}\n${a.promptId}`);
      if (hit) hit.added += a.usd;
    }
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }
}
