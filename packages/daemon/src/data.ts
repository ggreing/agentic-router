// `do-it-all-claude-code data export` / `data purge` (spec 3.7 data management, 4.4 data minimisation). One
// implementation for the daemon routes and for the CLI when the daemon is not running.
//
// export: one JSON line per closed request (its T7 record, its verify signals and its acceptance), after a
// header line. Every string is masked again on the way out (key and token patterns, plus the daemon's and the
// proxy's own token values). Left out: prompt text unless recordPrompts is on, raw session ids (a short hash
// groups the requests of a session instead), agent ids, rate-limit usage and anything account-related (spec
// 4.4: "kept local, excluded from export by default"), proxy rows and their token ids.
//
// purge: closed requests (all, or closed before a date) with every row that carries their request id, then
// the rows with no request (events, agents, costs, signals, proxy rows, rate limits) from before the date.
// Nothing of a session that still has an open request or one awaiting the user is touched: the router reads
// those sessions' events back (prompt ids, confirmations, acceptance). Then VACUUM and a WAL checkpoint, so the
// removed rows do not linger in free pages or the write-ahead log.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { redact, safeName } from '@do-it-all-claude-code/core';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { MINIMAL_MARK, minimalPayload } from './payload.ts';

type Row = Record<string, SQLInputValue>;

export const EXPORT_VERSION = 1;

/** Per-session tables that `purge --all` empties (outside live sessions): the lead model seen, hook clients, a pending /router level. */
export const SESSION_TABLES = ['sessions', 'clients', 'pending_levels'] as const;

/** Every ledger table with a request_id column, children first (subtasks references requests). */
export const REQUEST_TABLES = ['confirmations', 'slots', 'signals', 'costs', 'proxy_rows', 'events', 'agents', 'subtasks', 'request_records', 'requests'] as const;

/** An ISO time from a date or a date-time; undefined when it does not parse. */
export function isoTime(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v.trim() || v.length > 40) return undefined;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? `${v.trim()}T00:00:00.000Z` : v.trim());
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

const sessionHash = (id: unknown) => createHash('sha256').update(String(id)).digest('hex').slice(0, 16);

function json(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  try { return JSON.parse(String(v)); } catch { return null; }
}

function masked(v: unknown, secrets: string[]): unknown {
  if (typeof v === 'string') return redact(v, secrets);
  if (Array.isArray(v)) return v.map(x => masked(x, secrets));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, masked(x, secrets)]));
  return v;
}

export interface ExportOptions {
  since?: string;
  until?: string;
  /** config.recordPrompts: only then is a stored prompt exported. */
  includePrompts: boolean;
  /** Values that must never appear (the daemon and proxy tokens). */
  secrets: string[];
  now?: () => Date;
}

/** The export as JSON lines: a header, then one line per closed request (closed_at in [since, until)). */
export function* exportLines(db: DatabaseSync, o: ExportOptions): Generator<string> {
  yield JSON.stringify({
    type: 'export', version: EXPORT_VERSION, exportedAt: (o.now?.() ?? new Date()).toISOString(), since: o.since ?? null, until: o.until ?? null,
    prompts: o.includePrompts, excluded: ['tokens and keys', 'rate-limit usage', 'account information', 'raw session ids', 'agent ids', 'proxy rows'],
  });
  const where: string[] = [];
  const args: SQLInputValue[] = [];
  if (o.since) { where.push('closed_at >= ?'); args.push(o.since); }
  if (o.until) { where.push('closed_at < ?'); args.push(o.until); }
  const signals = db.prepare('SELECT subtask_id, attempt, kind, ok, detail, created_at, exit_code, duration_ms, tests_passed, tests_failed FROM signals WHERE request_id = ? ORDER BY id');
  const rows = db.prepare(`SELECT * FROM request_records ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY closed_at, request_id`).iterate(...args) as Iterable<Row>;
  for (const r of rows) {
    const line = {
      type: 'request', requestId: r.request_id, session: sessionHash(r.session_id), createdAt: r.created_at, closedAt: r.closed_at,
      kind: r.kind, level: r.level, finalLevel: r.final_level, outcome: r.outcome,
      changedFiles: r.changed_files, linesAdded: r.lines_added, linesRemoved: r.lines_removed, durationMs: r.duration_ms, activeMs: r.active_ms,
      subtaskUsd: r.subtask_usd, leadUsd: r.lead_usd, totalUsd: r.total_usd,
      record: json(r.record), acceptance: r.acceptance ?? null, acceptSignals: json(r.accept_signals),
      signals: (signals.all(String(r.request_id)) as Row[]).map(x => ({
        subtaskId: x.subtask_id, attempt: x.attempt, kind: x.kind, ok: Number(x.ok) === 1, detail: x.detail, createdAt: x.created_at,
        // decision 149: the structured verify result (the output tail is stored only with recordPrompts on)
        ...Object.fromEntries(([['exitCode', x.exit_code], ['durationMs', x.duration_ms], ['testsPassed', x.tests_passed], ['testsFailed', x.tests_failed]] as const).filter(([, v]) => v !== null && v !== undefined)),
      })),
      ...(o.includePrompts && typeof r.prompt === 'string' && r.prompt ? { prompt: r.prompt } : {}),
    };
    yield JSON.stringify(masked(line, o.secrets));
  }
}

export interface PurgeOptions {
  /** Requests closed before this ISO time; rows without a request from before it. */
  before?: string;
  all?: boolean;
  /** Count what would go, change nothing. */
  dryRun?: boolean;
}

export interface PurgeResult {
  dryRun: boolean;
  /** Closed requests removed (or that would be). */
  requests: number;
  /** Open or awaiting requests in the range, left alone with everything of their sessions. */
  keptOpen: number;
  /** Rows per table. */
  rows: Record<string, number>;
  /** --all: files per kind (spool, scopes, agents, logs truncated). */
  files?: Record<string, number>;
  compacted: boolean;
}

export function purge(db: DatabaseSync, o: PurgeOptions): PurgeResult {
  if (!o.all && !o.before) throw new RangeError('purge needs a date (before) or all');
  const before = o.all ? null : o.before!;
  const rows: Record<string, number> = {};
  const add = (t: string, n: number | bigint) => { if (Number(n)) rows[t] = (rows[t] ?? 0) + Number(n); };
  const time = (col: string) => (before ? ` AND ${col} < ?` : '');
  const t = (): SQLInputValue[] => (before ? [before] : []);
  let requests = 0;
  let keptOpen = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('CREATE TEMP TABLE IF NOT EXISTS purge_ids (id TEXT PRIMARY KEY); DELETE FROM purge_ids;');
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS live_sessions (id TEXT PRIMARY KEY); DELETE FROM live_sessions;
      INSERT INTO live_sessions SELECT DISTINCT session_id FROM requests WHERE status IN ('open', 'awaiting_user');`);
    keptOpen = Number((db.prepare(`SELECT COUNT(*) AS c FROM requests WHERE status IN ('open', 'awaiting_user')${time('created_at')}`).get(...t()) as Row).c);
    // closed requests, and records whose request row is gone
    db.prepare(`INSERT OR IGNORE INTO purge_ids SELECT id FROM requests WHERE status = 'closed'${time('COALESCE(closed_at, created_at)')}`).run(...t());
    db.prepare(`INSERT OR IGNORE INTO purge_ids SELECT request_id FROM request_records WHERE request_id NOT IN (SELECT id FROM requests)${time('closed_at')}`).run(...t());
    requests = Number((db.prepare('SELECT COUNT(*) AS c FROM purge_ids').get() as Row).c);
    for (const table of REQUEST_TABLES) {
      const col = table === 'requests' ? 'id' : 'request_id';
      add(table, db.prepare(`DELETE FROM ${table} WHERE ${col} IN (SELECT id FROM purge_ids)`).run().changes);
    }
    // rows that belong to no request, outside live sessions
    const notLive = (col: string) => ` AND (${col} IS NULL OR ${col} NOT IN (SELECT id FROM live_sessions))`;
    add('events', db.prepare(`DELETE FROM events WHERE request_id IS NULL${notLive('session_id')}${time('received_at')}`).run(...t()).changes);
    add('agents', db.prepare(`DELETE FROM agents WHERE request_id IS NULL${notLive('session_id')}${time('started_at')}`).run(...t()).changes);
    add('proxy_rows', db.prepare(`DELETE FROM proxy_rows WHERE request_id IS NULL${notLive('session_id')}${time('received_at')}`).run(...t()).changes);
    add('costs', db.prepare(`DELETE FROM costs WHERE request_id IS NULL${time('created_at')}`).run(...t()).changes);
    add('signals', db.prepare(`DELETE FROM signals WHERE request_id IS NULL${time('created_at')}`).run(...t()).changes);
    add('session_limits', db.prepare(`DELETE FROM session_limits WHERE 1 = 1${notLive('session_id')}${time('updated_at')}`).run(...t()).changes);
    // --all (decision 142): the per-session tables too, outside live sessions
    if (!before) for (const table of SESSION_TABLES) add(table, db.prepare(`DELETE FROM ${table} WHERE 1 = 1${notLive('session_id')}`).run().changes);
    db.exec('DELETE FROM purge_ids; DELETE FROM live_sessions;');
    db.exec(o.dryRun ? 'ROLLBACK' : 'COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
  let compacted = false;
  if (!o.dryRun && Object.keys(rows).length) {
    db.exec('VACUUM');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    compacted = true;
  }
  return { dryRun: o.dryRun === true, requests, keptOpen, rows, compacted };
}

// ------------------------------------------------------------------ decision 141: event minimisation

/** The router event types whose payload is a hook input (tool_call rows hold the router tools' own arguments). */
export const HOOK_EVENT_TYPES = ['prompt_submit', 'pre_tool_use', 'post_tool_use', 'subagent_start', 'subagent_stop', 'pre_compact', 'session_start', 'stop'] as const;

/**
 * Brings stored hook events into the minimal form (decisions 141-142; recordPrompts off): rows written before,
 * or while recordPrompts was on. A payload cut at the size limit does not parse; it becomes a stub that keeps
 * only its prompt_id. Returns the rows changed.
 */
export function scrubProse(db: DatabaseSync): number {
  const rows = db.prepare(`SELECT id, payload FROM events WHERE type IN (${HOOK_EVENT_TYPES.map(() => '?').join(', ')}) AND instr(payload, ?) = 0`)
    .all(...HOOK_EVENT_TYPES, `"${MINIMAL_MARK}":1`) as Row[];
  if (!rows.length) return 0;
  const update = db.prepare('UPDATE events SET payload = ? WHERE id = ?');
  let changed = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of rows) {
      const text = String(r.payload);
      let next: string;
      try {
        next = JSON.stringify(minimalPayload(JSON.parse(text)));
      } catch {
        const promptId = /"prompt_id":"([A-Za-z0-9._-]{1,128})"/.exec(text)?.[1];
        next = JSON.stringify({ [MINIMAL_MARK]: 1, payload_unreadable: true, chars: text.length, ...(promptId ? { prompt_id: promptId } : {}) });
      }
      if (next !== text) { update.run(next, Number(r.id)); changed++; }
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* rolled back */ }
    throw e;
  }
  if (changed) db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return changed;
}

/** Decision 141 (a): how long events are kept; 0 keeps them. */
export const DEFAULT_EVENT_RETENTION_DAYS = 30;
export const MAX_EVENT_RETENTION_DAYS = 3650;

/**
 * Drops events older than `days` (decision 141 (a)), outside sessions with an open or awaiting request (the
 * router reads those back). Run at daemon start and daily. Returns the rows removed.
 */
export function pruneEvents(db: DatabaseSync, days: number, nowIso: string): number {
  if (!(days > 0)) return 0;
  const cutoff = new Date(Date.parse(nowIso) - days * 86_400_000).toISOString();
  const n = Number(db.prepare(`DELETE FROM events WHERE received_at < ?
      AND session_id NOT IN (SELECT DISTINCT session_id FROM requests WHERE status IN ('open', 'awaiting_user'))`).run(cutoff).changes);
  if (n) db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return n;
}

// ------------------------------------------------------------------ decision 142: purge --all, the files

/** The router home's folders that purge --all clears; `root` adds limits-cache/ and the dashboard launch page. */
export interface DataHome { spoolDir: string; scopesDir: string; agentsDir: string; logsDir: string; root?: string }

/** Sessions with an open request or one awaiting the user: purge and retention leave everything of them alone. */
export function liveSessions(db: DatabaseSync): Set<string> {
  return new Set((db.prepare("SELECT DISTINCT session_id AS s FROM requests WHERE status IN ('open', 'awaiting_user')").all() as Row[]).map(r => String(r.s)));
}

/**
 * The files `purge --all` clears: the spool; the scope, agent and limits-cache files of sessions that are not
 * live (the guard reads those of running subagents); the logs (current ones truncated, since the daemon and the
 * proxy keep them open; rotated ones deleted); the dashboard launch page. A link or junction is never followed or
 * removed (audit C5): only regular files directly in these folders count. Counts per kind; with dryRun only counts.
 */
export function purgeFiles(home: DataHome, live: ReadonlySet<string>, dryRun = false): Record<string, number> {
  const out: Record<string, number> = {};
  const regular = (p: string) => { try { return fs.lstatSync(p).isFile(); } catch { return false; } };
  const realDir = (d: string) => { try { return fs.lstatSync(d).isDirectory(); } catch { return false; } };   // not a link to elsewhere
  const list = (dir: string, re: RegExp) => {
    if (!realDir(dir)) return [];
    try { return fs.readdirSync(dir).filter(f => re.test(f)).map(f => path.join(dir, f)).filter(regular); } catch { return []; }
  };
  const drop = (kind: string, file: string) => { if (!dryRun) { try { fs.rmSync(file, { force: true }); } catch { return; } } out[kind] = (out[kind] ?? 0) + 1; };
  for (const f of list(home.spoolDir, /\.jsonl(\.sending)?$/)) drop('spool', f);
  const livePrefixes = [...live].map(s => `${safeName(s).slice(0, 40)}__`);
  for (const f of list(home.scopesDir, /\.json$/)) if (!livePrefixes.some(p => path.basename(f).startsWith(p))) drop('scopes', f);
  for (const f of list(home.agentsDir, /\.json$/)) {
    let session: unknown;
    try { session = (JSON.parse(fs.readFileSync(f, 'utf8')) as { sessionId?: unknown }).sessionId; } catch { /* unreadable: not live */ }
    if (typeof session !== 'string' || !live.has(session)) drop('agents', f);
  }
  for (const f of list(home.logsDir, /\.log\.\d+$/)) drop('logs', f);   // rotated
  for (const f of list(home.logsDir, /\.log$/)) {
    let size = 0;
    try { size = fs.statSync(f).size; } catch { continue; }
    if (!size) continue;
    if (!dryRun) { try { fs.truncateSync(f, 0); } catch { continue; } }
    out.logs = (out.logs ?? 0) + 1;
  }
  if (home.root) {
    // the status line's per-session stamp (plugin/statusline.mjs names the file by this rule)
    const liveStamps = new Set([...live].map(s => `${String(s).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128)}.json`));
    for (const f of list(path.join(home.root, 'limits-cache'), /\.json$/)) if (!liveStamps.has(path.basename(f))) drop('limitsCache', f);
    const page = path.join(home.root, 'dashboard-open.html');
    if (regular(page)) drop('launchPage', page);
  }
  return out;
}

/**
 * Decision 142: with recordPrompts off at ledger open, the prompt text kept while it was on goes too (the request
 * column and the request record's copy). Turning the option off means "don't keep my prompts". Returns the rows.
 */
export function scrubStoredPrompts(db: DatabaseSync): number {
  const n = Number(db.prepare('UPDATE requests SET prompt_text = NULL WHERE prompt_text IS NOT NULL').run().changes)
    + Number(db.prepare('UPDATE request_records SET prompt = NULL WHERE prompt IS NOT NULL').run().changes);
  if (n) db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return n;
}
