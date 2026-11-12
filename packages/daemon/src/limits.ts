// Subscription rate-limit capture (spec 3.8; decision 132 deferred this to Phase 3). The Claude Code
// status line input carries `rate_limits`; plugin/statusline.mjs posts it here and the daemon stores the
// latest per session for the dashboard. This module owns the storage: the ledger migration (v11) runs
// LIMITS_SCHEMA and the daemon's POST /router/v1/limits route calls recordLimits.
//
// rate_limits shape, from the Claude Code status line docs (code.claude.com/docs/en/statusline), verbatim:
//   "rate_limits": {
//     "five_hour":   { "used_percentage": 23.5, "resets_at": 1738425600 },
//     "seven_day":   { "used_percentage": 41.2, "resets_at": 1738857600 },
//     "spend_limit": { "used_percentage": 62.8, "resets_at": 1740787200, "used_usd": 314.12, "limit_usd": 500, "period": "monthly" }
//   }
// Docs caveats carried into the parsing here: rate_limits appears only for Pro/Max/Ultra subscribers (or
// behind a spend-limit gateway) and only after the first API response; each window is independently
// absent; Claude Code drops a window once its resets_at passes. So every field is optional.
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export const LIMITS_SCHEMA = `
CREATE TABLE IF NOT EXISTS session_limits (
  session_id       TEXT PRIMARY KEY,
  five_hour_pct    REAL,
  five_hour_reset  INTEGER,
  seven_day_pct    REAL,
  seven_day_reset  INTEGER,
  spend_pct        REAL,
  spend_reset      INTEGER,
  spend_used_usd   REAL,
  spend_limit_usd  REAL,
  spend_period     TEXT,
  updated_at       TEXT NOT NULL
);
`;

/** Creates the session_limits table. The ledger migration runs the same SQL; tests call this directly. */
export function applyLimitsSchema(db: DatabaseSync): void {
  db.exec(LIMITS_SCHEMA);
}

export interface LimitWindow { usedPercentage: number; resetsAt: number | null }
export interface SpendLimit extends LimitWindow { usedUsd: number | null; limitUsd: number | null; period: string | null }
export interface SessionLimits {
  fiveHour: LimitWindow | null;
  sevenDay: LimitWindow | null;
  spendLimit: SpendLimit | null;
  updatedAt: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function parseWindow(w: unknown): LimitWindow | null {
  if (!isObj(w)) return null;
  const pct = numOrNull(w.used_percentage);
  if (pct === null) return null;              // a window with no percentage carries nothing useful
  return { usedPercentage: pct, resetsAt: numOrNull(w.resets_at) };
}
function parseSpend(w: unknown): SpendLimit | null {
  const base = parseWindow(w);
  if (!base || !isObj(w)) return null;
  return { ...base, usedUsd: numOrNull(w.used_usd), limitUsd: numOrNull(w.limit_usd), period: strOrNull(w.period) };
}

export interface ParsedRateLimits { fiveHour: LimitWindow | null; sevenDay: LimitWindow | null; spendLimit: SpendLimit | null }
/** Reads the status line's `rate_limits` object defensively; returns null when nothing usable is present. */
export function parseRateLimits(rateLimits: unknown): ParsedRateLimits | null {
  if (!isObj(rateLimits)) return null;
  const fiveHour = parseWindow(rateLimits.five_hour);
  const sevenDay = parseWindow(rateLimits.seven_day);
  const spendLimit = parseSpend(rateLimits.spend_limit);
  if (!fiveHour && !sevenDay && !spendLimit) return null;
  return { fiveHour, sevenDay, spendLimit };
}

export interface RecordLimitsInput { sessionId: string; rateLimits: unknown; at: string }
/** Stores (replaces) a session's latest rate limits. A no-op when nothing usable parses. Returns true if stored. */
export function recordLimits(db: DatabaseSync, input: RecordLimitsInput): boolean {
  if (!input.sessionId) return false;
  const p = parseRateLimits(input.rateLimits);
  if (!p) return false;
  const vals: SQLInputValue[] = [
    input.sessionId,
    p.fiveHour?.usedPercentage ?? null, p.fiveHour?.resetsAt ?? null,
    p.sevenDay?.usedPercentage ?? null, p.sevenDay?.resetsAt ?? null,
    p.spendLimit?.usedPercentage ?? null, p.spendLimit?.resetsAt ?? null,
    p.spendLimit?.usedUsd ?? null, p.spendLimit?.limitUsd ?? null, p.spendLimit?.period ?? null,
    input.at,
  ];
  db.prepare(`INSERT INTO session_limits (session_id, five_hour_pct, five_hour_reset, seven_day_pct, seven_day_reset,
      spend_pct, spend_reset, spend_used_usd, spend_limit_usd, spend_period, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (session_id) DO UPDATE SET five_hour_pct = excluded.five_hour_pct, five_hour_reset = excluded.five_hour_reset,
      seven_day_pct = excluded.seven_day_pct, seven_day_reset = excluded.seven_day_reset, spend_pct = excluded.spend_pct,
      spend_reset = excluded.spend_reset, spend_used_usd = excluded.spend_used_usd, spend_limit_usd = excluded.spend_limit_usd,
      spend_period = excluded.spend_period, updated_at = excluded.updated_at`).run(...vals);
  return true;
}

type Row = Record<string, SQLInputValue>;
function toLimits(r: Row): SessionLimits {
  const win = (pct: unknown, reset: unknown): LimitWindow | null =>
    numOrNull(pct) === null ? null : { usedPercentage: Number(pct), resetsAt: numOrNull(reset) };
  const spend = win(r.spend_pct, r.spend_reset);
  return {
    fiveHour: win(r.five_hour_pct, r.five_hour_reset),
    sevenDay: win(r.seven_day_pct, r.seven_day_reset),
    spendLimit: spend ? { ...spend, usedUsd: numOrNull(r.spend_used_usd), limitUsd: numOrNull(r.spend_limit_usd), period: strOrNull(r.spend_period) } : null,
    updatedAt: String(r.updated_at ?? ''),
  };
}

/**
 * The latest stored limits for a session, or (no sessionId) the most recently updated session's. Returns
 * null when nothing is stored — and also when the table has not been created yet, so the dashboard
 * degrades gracefully instead of erroring.
 */
export function latestLimits(db: DatabaseSync, sessionId?: string): SessionLimits | null {
  try {
    const r = (sessionId
      ? db.prepare('SELECT * FROM session_limits WHERE session_id = ?').get(sessionId)
      : db.prepare('SELECT * FROM session_limits ORDER BY updated_at DESC, rowid DESC LIMIT 1').get()) as Row | undefined;
    return r ? toLimits(r) : null;
  } catch {
    return null;   // table absent (pre-migration) or read error
  }
}
