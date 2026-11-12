// Read-only metrics read-model for the local dashboard (spec 2.2, 3.7, 3.8; decision 132).
// Pure queries over the ledger's request_records / costs / signals — no writes, no HTTP. The daemon's
// dashboard routes (wave 2) call these and serialise the result; keeping them here makes the KPI math,
// keyset pagination and masking unit-testable against an in-memory Ledger with no server.
//
// MVP proxies (decision 132): "success" is the verify outcome (acceptance detection comes later); the
// Phase-0 OFF baseline is undetermined (Appendix B), so baseline deltas are null until it is measured.
// No prompt text is ever returned unless request_records.prompt is set (config.recordPrompts, decision 109).
import type { SQLInputValue } from 'node:sqlite';
import { redact, type Level } from '@agentic-router/core';
import type { Ledger } from './ledger.ts';

type Row = Record<string, SQLInputValue>;
const s = (v: unknown): string => String(v ?? '');
const sn = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number => Number(v ?? 0);
const nn = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
function parse<T>(v: unknown, fallback: T): T {
  try { return JSON.parse(String(v)) as T; } catch { return fallback; }
}

/** The shape of the T7 `record` blob (packages/daemon/src/router.ts); only the fields the dashboard reads. */
interface RecordBlob {
  triage?: { kind?: string | null; level?: Level; confidence?: number; source?: string; rule?: string | null };
  plan?: { manualLevel?: Level | null; replannedFrom?: Level | null; leadClass?: string | null; forcedFrom?: Level | null };
  outcome?: string;
  subtasks?: Array<{ id: string; role: string; slot: number; step: string; upCount: number; status: string; verdict: string | null; attempts: number; costUsd: number }>;
  verifyFailures?: number;
  costs?: { subtaskUsd?: number; leadUsd?: number | null; totalUsd?: number; estimated?: boolean; unknown?: boolean; budgetExceeded?: boolean };
}

export interface MetricsWindow { since?: string; until?: string }
export interface RequestsQuery extends MetricsWindow {
  limit?: number;
  before?: { closedAt: string; requestId: string } | null;
  level?: Level;
  status?: string;   // request_records has closed rows only; kept for forward-compat filtering
  outcome?: string;
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const clampLimit = (n?: number): number => Math.min(MAX_LIMIT, Math.max(1, Math.floor(n ?? DEFAULT_LIMIT)));

/** A request "succeeded" (MVP verify proxy): a direct request, or every subtask reached status 'passed'. */
function recordSucceeded(rec: RecordBlob): boolean {
  const subs = rec.subtasks ?? [];
  if (!subs.length) return rec.outcome !== 'no_delegation';
  return subs.every(x => x.status === 'passed');
}
/** The initial team held: no manual override, no re-plan, no slot ever stepped up. */
function teamHeld(rec: RecordBlob): boolean {
  const p = rec.plan ?? {};
  if (p.manualLevel != null || p.replannedFrom != null) return false;
  return (rec.subtasks ?? []).every(x => (x.upCount ?? 0) === 0);
}
function startStepHeld(rec: RecordBlob): boolean {
  return (rec.subtasks ?? []).every(x => (x.upCount ?? 0) === 0);
}

function windowClause(w: MetricsWindow, params: SQLInputValue[]): string {
  const parts: string[] = [];
  if (w.since) { parts.push('closed_at >= ?'); params.push(w.since); }
  if (w.until) { parts.push('closed_at <= ?'); params.push(w.until); }
  return parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
}

export interface MetricsSummary {
  window: MetricsWindow;
  total: number;
  successful: number;
  successRate: number | null;
  teamFitRate: number | null;
  startStepFitRate: number | null;
  upRate: number | null;
  costPerAcceptedTaskUsd: number | null;
  cost: { totalUsd: number; leadUsd: number; subtaskUsd: number };
  cacheHitRate: number | null;
  flags: { estimated: number; unknown: number; budgetExceeded: number };
  byLevel: Array<{ level: Level; count: number; totalUsd: number; successRate: number | null }>;
  /** Phase-0 OFF baseline is undetermined (Appendix B); deltas are pending until it is set. */
  baseline: null;
}

/** KPI tiles for the overview screen (spec 3.8). */
export function metricsSummary(ledger: Ledger, w: MetricsWindow = {}): MetricsSummary {
  const params: SQLInputValue[] = [];
  const rows = ledger.db.prepare(`SELECT level, total_usd, lead_usd, subtask_usd, record FROM request_records${windowClause(w, params)}`).all(...params) as Row[];
  const total = rows.length;
  let successful = 0, teamFit = 0, startStepFit = 0, upAny = 0;
  let totalUsd = 0, leadUsd = 0, subtaskUsd = 0, acceptedUsd = 0;
  let estimated = 0, unknown = 0, budgetExceeded = 0;
  const byLevel = new Map<Level, { count: number; totalUsd: number; ok: number }>();
  for (const r of rows) {
    const rec = parse<RecordBlob>(r.record, {});
    const ok = recordSucceeded(rec);
    const tUsd = num(r.total_usd);
    totalUsd += tUsd; leadUsd += num(r.lead_usd); subtaskUsd += num(r.subtask_usd);
    if (ok) { successful++; acceptedUsd += tUsd; }
    if (teamHeld(rec)) teamFit++;
    if (startStepHeld(rec)) startStepFit++;
    if ((rec.subtasks ?? []).some(x => (x.upCount ?? 0) > 0)) upAny++;
    const f = rec.costs ?? {};
    if (f.estimated) estimated++;
    if (f.unknown) unknown++;
    if (f.budgetExceeded) budgetExceeded++;
    const lvl = s(r.level) as Level;
    const b = byLevel.get(lvl) ?? { count: 0, totalUsd: 0, ok: 0 };
    b.count++; b.totalUsd += tUsd; if (ok) b.ok++;
    byLevel.set(lvl, b);
  }
  const rate = (a: number, b: number): number | null => (b > 0 ? a / b : null);
  // cache-hit over costs of the windowed requests (meaningful in API mode; may be empty in subscription mode)
  const cp: SQLInputValue[] = [];
  const cClause = windowClause(w, cp).replace(/closed_at/g, 'r.closed_at');
  const c = ledger.db.prepare(`SELECT COALESCE(SUM(c.input_tokens),0) i, COALESCE(SUM(c.cache_read_tokens),0) cr
    FROM costs c JOIN request_records r ON r.request_id = c.request_id${cClause}`).get(...cp) as Row;
  const denom = num(c.i) + num(c.cr);

  return {
    window: w,
    total, successful,
    successRate: rate(successful, total),
    teamFitRate: rate(teamFit, total),
    startStepFitRate: rate(startStepFit, total),
    upRate: rate(upAny, total),
    costPerAcceptedTaskUsd: successful > 0 ? round6(acceptedUsd / successful) : null,
    cost: { totalUsd: round6(totalUsd), leadUsd: round6(leadUsd), subtaskUsd: round6(subtaskUsd) },
    cacheHitRate: denom > 0 ? round6(num(c.cr) / denom) : null,
    flags: { estimated, unknown, budgetExceeded },
    byLevel: [...byLevel.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([level, v]) => ({ level, count: v.count, totalUsd: round6(v.totalUsd), successRate: rate(v.ok, v.count) })),
    baseline: null,
  };
}

export interface TimelineRow {
  requestId: string;
  createdAt: string;
  closedAt: string;
  kind: string | null;
  level: Level;
  finalLevel: Level;
  outcome: string | null;
  leadClass: string | null;
  changedFiles: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  durationMs: number | null;
  activeMs: number | null;
  leadUsd: number | null;
  subtaskUsd: number;
  totalUsd: number;
  success: boolean;
  subtasks: number;
  verifyFailures: number;
  estimated: boolean;
  unknown: boolean;
  budgetExceeded: boolean;
}

/**
 * Timeline rows, newest first, with keyset pagination on (closed_at, request_id) so inserts never shift a
 * page. `before` is the last row of the previous page; omit for the first page. Returns up to `limit` rows
 * and the `nextCursor` to pass as `before` next time (null when the page is the last).
 */
export function metricsRequests(ledger: Ledger, q: RequestsQuery = {}): { rows: TimelineRow[]; nextCursor: { closedAt: string; requestId: string } | null } {
  const limit = clampLimit(q.limit);
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (q.since) { where.push('closed_at >= ?'); params.push(q.since); }
  if (q.until) { where.push('closed_at <= ?'); params.push(q.until); }
  if (q.level) { where.push('level = ?'); params.push(q.level); }
  if (q.outcome) { where.push('outcome = ?'); params.push(q.outcome); }
  if (q.before) { where.push('(closed_at < ? OR (closed_at = ? AND request_id < ?))'); params.push(q.before.closedAt, q.before.closedAt, q.before.requestId); }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const rows = ledger.db.prepare(`SELECT request_id, created_at, closed_at, kind, level, final_level, outcome,
      changed_files, lines_added, lines_removed, duration_ms, active_ms, lead_usd, subtask_usd, total_usd, record
    FROM request_records${clause} ORDER BY closed_at DESC, request_id DESC LIMIT ?`).all(...params, limit + 1) as Row[];
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? { closedAt: s(page[page.length - 1]!.closed_at), requestId: s(page[page.length - 1]!.request_id) } : null;
  const mapped = page.map((r): TimelineRow => {
    const rec = parse<RecordBlob>(r.record, {});
    const f = rec.costs ?? {};
    return {
      requestId: s(r.request_id), createdAt: s(r.created_at), closedAt: s(r.closed_at),
      kind: sn(r.kind), level: s(r.level) as Level, finalLevel: s(r.final_level) as Level, outcome: sn(r.outcome),
      leadClass: rec.plan?.leadClass ?? null,
      changedFiles: nn(r.changed_files), linesAdded: nn(r.lines_added), linesRemoved: nn(r.lines_removed),
      durationMs: nn(r.duration_ms), activeMs: nn(r.active_ms),
      leadUsd: nn(r.lead_usd), subtaskUsd: num(r.subtask_usd), totalUsd: num(r.total_usd),
      success: recordSucceeded(rec), subtasks: (rec.subtasks ?? []).length, verifyFailures: rec.verifyFailures ?? 0,
      estimated: !!f.estimated, unknown: !!f.unknown, budgetExceeded: !!f.budgetExceeded,
    };
  });
  return { rows: mapped, nextCursor };
}

export interface RequestDetail {
  requestId: string;
  record: Record<string, unknown>;
  signals: Array<{ subtaskId: string | null; attempt: number; kind: string; ok: boolean; detail?: string }>;
  prompt: string | null;
}

/** One request's full T7 record plus its verify/review signals, masked. `null` when the request is unknown. */
export function metricsRequestDetail(ledger: Ledger, requestId: string): RequestDetail | null {
  const row = ledger.db.prepare('SELECT record, prompt FROM request_records WHERE request_id = ?').get(requestId) as Row | undefined;
  if (!row) return null;
  const record = parse<Record<string, unknown>>(row.record, {});
  const signals = ledger.listSignals(requestId).map(x => ({
    subtaskId: x.subtaskId, attempt: x.attempt, kind: String(x.kind), ok: x.ok,
    ...(x.detail === undefined ? {} : { detail: redact(x.detail) }),
  }));
  // prompt is null unless recordPrompts was on; redact defensively even then.
  const prompt = row.prompt === null || row.prompt === undefined ? null : redact(String(row.prompt));
  return { requestId, record: maskRecord(record), signals, prompt };
}

/** Removes any free-text the record may carry (triage.rationale) so the API returns ledger fields only. */
function maskRecord(rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...rec };
  const t = out.triage;
  if (t && typeof t === 'object' && 'rationale' in (t as Record<string, unknown>)) {
    const { rationale, ...rest } = t as Record<string, unknown>;
    out.triage = { ...rest, rationale: typeof rationale === 'string' ? redact(rationale) : rationale };
  }
  return out;
}

export interface TriageReport {
  window: MetricsWindow;
  overall: { total: number; levelHeld: number; teamFit: number; startStepFit: number };
  byRule: Array<{ rule: string; count: number; reinforced: number; upStreaks: number; suggestLevelUp: boolean; suggestStepUp: boolean }>;
  byLevel: Array<{ planned: Level; final: Level; count: number }>;
}

/**
 * Triage-vs-actual aggregates and non-binding rule-adjustment suggestions (spec 3.7). For each triage rule:
 * `reinforced` = the lead grew the team (outcome delegated while the plan was lead-direct, or a re-plan up);
 * `upStreaks` = requests where a slot stepped up. Repeated reinforcement suggests the rule's level is too low;
 * repeated up-streaks suggest its start step is too low. Suggestions are surfaced, never auto-applied.
 */
export function metricsTriageReport(ledger: Ledger, w: MetricsWindow = {}): TriageReport {
  const params: SQLInputValue[] = [];
  const rows = ledger.db.prepare(`SELECT level, final_level, record FROM request_records${windowClause(w, params)}`).all(...params) as Row[];
  let levelHeld = 0, teamFit = 0, startStepFit = 0;
  const byRule = new Map<string, { count: number; reinforced: number; upStreaks: number }>();
  const byLevel = new Map<string, { planned: Level; final: Level; count: number }>();
  for (const r of rows) {
    const rec = parse<RecordBlob>(r.record, {});
    const planned = s(r.level) as Level;
    const final = s(r.final_level) as Level;
    if (planned === final) levelHeld++;
    if (teamHeld(rec)) teamFit++;
    if (startStepHeld(rec)) startStepFit++;
    const lk = `${planned}>${final}`;
    const lb = byLevel.get(lk) ?? { planned, final, count: 0 };
    lb.count++; byLevel.set(lk, lb);
    const rule = rec.triage?.rule ?? '(none)';
    const b = byRule.get(rule) ?? { count: 0, reinforced: 0, upStreaks: 0 };
    b.count++;
    const grew = (rec.plan?.replannedFrom != null) || (planned !== final);
    if (grew) b.reinforced++;
    if ((rec.subtasks ?? []).some(x => (x.upCount ?? 0) > 0)) b.upStreaks++;
    byRule.set(rule, b);
  }
  const SUGGEST_MIN = 3;        // at least this many reinforcements / up-streaks before suggesting a change
  return {
    window: w,
    overall: { total: rows.length, levelHeld, teamFit, startStepFit },
    byRule: [...byRule.entries()].sort((a, b) => b[1].count - a[1].count).map(([rule, v]) => ({
      rule, count: v.count, reinforced: v.reinforced, upStreaks: v.upStreaks,
      suggestLevelUp: v.reinforced >= SUGGEST_MIN && v.reinforced * 2 >= v.count,
      suggestStepUp: v.upStreaks >= SUGGEST_MIN && v.upStreaks * 2 >= v.count,
    })),
    byLevel: [...byLevel.values()].sort((a, b) => b.count - a.count),
  };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
