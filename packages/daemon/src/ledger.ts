// Phase 1 ledger (spec 3.6, 4.3): node:sqlite in WAL mode.
// Tables: requests, subtasks, agents, events (masked, size-limited), signals, costs;
// pending_levels holds a `/router level` waiting for the session's next request (schema v3).
// All statements are synchronous; callers serialise per session through SessionQueue, and every
// update re-reads or increments in SQL, so concurrent subagents never overwrite each other.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type {
  Level, RequestRecord, Role, SignalKind, Step, SubtaskRecord, SubtaskStatus, TeamPreset, TriageResult, Verdict,
  UsageRow, VerifySignal,
} from '@agentic-router/core';
import type { Snapshot } from './git.ts';

export const SCHEMA_VERSION = 10;

export type RequestStatus = 'open' | 'awaiting_user' | 'closed';

/**
 * Verdict of a subtask: core's Verdict, plus two outcomes where the router did not judge the work, both
 * left to the lead and the user (status 'hitl', never counted as a miss):
 * - held: the verify inputs changed, so the commands were not run (decision 91)
 * - unverified: the stop was replayed from the spool after an outage; verify never ran (decision 89)
 * And one the lead reports: rejected = the result is wrong whatever verify said (router_report_result); status 'failed'.
 */
export type SubtaskVerdict = Verdict | 'held' | 'unverified' | 'rejected';

/** The latest judgement reported for a subtask's result (router_report_result, decision 127). */
export interface SubtaskReview {
  verdict: 'accept' | 'reject';
  by: 'lead' | 'reviewer' | 'tester';
  bySubtaskId?: string;
  margin?: 'easy' | 'normal';
  at: string;
}

/** A request of the lead that waits for a user turn (decisions 128, 129). */
export interface ConfirmationRow {
  requestId: string;
  kind: 'escalation' | 'scope';
  subtaskId: string;
  payload: unknown;
  /** The newest event of the session when the request was made; a later user prompt is the user turn. */
  afterEventId: number;
  createdAt: string;
}
/**
 * How a closed request was carried out (decision 87): direct = a lead-direct preset (L0) finished by the
 * lead without subtasks, the expected outcome; delegated = subtasks ran; no_delegation = a team preset
 * finished without any subtask.
 */
export type RequestOutcome = 'direct' | 'delegated' | 'no_delegation';
export type Pairing = 'order' | 'confirmed' | 'unmatched' | 'unmanaged';

export interface RequestRow extends RequestRecord {
  promptId: string | null;
  level: Level;
  preset: string;
  budgetUsd: number;
  team: TeamPreset;
  status: RequestStatus;
  closedAt: string | null;
  turns: number;
  /** Triage that a manual `/router level` replaced (kept for learning); null when never overridden. */
  overriddenTriage: TriageResult | null;
  outcome: RequestOutcome | null;
  /** Where the team presets came from: default | user | project | user+project (teams.yaml). */
  presetSource: string | null;
  /** Decision 107: the level the rules gave when config.forceLevel planned the request at another one. */
  forcedFrom: Level | null;
  /** T6: the triage of a lead-direct request before the lead's first router Agent call re-planned it at L2. */
  replannedFrom: TriageResult | null;
  /** Decision 117: the lead's model when the request opened (null: not known) and its class. */
  leadModel: string | null;
  leadClass: string | null;
}

export interface SubtaskRow extends SubtaskRecord {
  agentType: string;
  unscoped: boolean;
  verdict: SubtaskVerdict | null;
  toolUseId: string | null;
  /** The judgement reported for the current attempt; a new dispatch clears it. */
  review: SubtaskReview | null;
  /** Protected paths this subtask may edit, granted after a user turn (decision 129); kept across dispatches. */
  protectedGranted: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentRow {
  agentId: string;
  sessionId: string;
  requestId: string | null;
  subtaskId: string | null;
  agentType: string | null;
  role: Role | null;
  slot: number | null;
  step: Step | null;
  cwd: string | null;
  snapshot: Snapshot | null;
  /** Decision 99: toolchain variables the relay forwarded at SubagentStart, for this agent's verify. */
  verifyEnv: Record<string, string> | null;
  /** The subagent's own transcript (from SubagentStop), re-read when the request closes. */
  transcriptPath: string | null;
  pairing: Pairing;
  startedAt: string;
  stoppedAt: string | null;
  stopCount: number;
  failCount: number;
  resolvedModel: string | null;
  worktreeBranch: string | null;
  worktreePath: string | null;
}

export interface SignalRow extends VerifySignal {
  requestId: string | null;
  subtaskId: string | null;
  agentId: string | null;
  attempt: number;
  createdAt: string;
}

/**
 * Where a cost row comes from (decisions #4 and 84):
 * - transcript: a subagent's whole session from its transcript; counts toward usedUsd. usd null + note = unknown
 *   (not counted; the status reports the request's cost as partly unknown).
 * - estimate: no readable transcript, but the task notification reported the subagent's tokens; priced at the
 *   model's output rate (an over-estimate) and counted. A later readable transcript replaces it.
 * - agent_result: PostToolUse(Agent) usage (last call only); recorded for cross-checking, never counted.
 * - lead: the main session (Phase 1: not recorded); counts toward leadCostUsd.
 */
/** proxy: a usage row of the API-key mode proxy (decision 130); once a request has them they are its cost source. */
export type CostSource = 'transcript' | 'estimate' | 'agent_result' | 'lead' | 'proxy';

/** actual: transcript cost known; estimate: from notification tokens; unknown: neither; none: nothing recorded. */
export type AgentCostState = 'actual' | 'estimate' | 'unknown' | 'none';

export interface CostInput {
  requestId: string | null;
  subtaskId: string | null;
  agentId: string | null;
  source: CostSource;
  modelId: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  usd: number | null;
  calls?: number;
  note?: string;
  createdAt: string;
}

export interface EventInput {
  sessionId: string;
  requestId: string | null;
  agentId: string | null;
  type: string;
  toolName: string | null;
  receivedAt: string;
  spooled: boolean;
  payload: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS requests (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  prompt_id     TEXT,
  level         TEXT NOT NULL,
  preset        TEXT NOT NULL,
  budget_usd    REAL NOT NULL,
  triage        TEXT NOT NULL,
  team          TEXT NOT NULL,
  lead_cost_usd REAL NOT NULL DEFAULT 0,
  used_usd      REAL NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'open',
  closed_at     TEXT,
  turns         INTEGER NOT NULL DEFAULT 1,
  override_from TEXT,
  outcome       TEXT,
  preset_source TEXT,
  forced_from   TEXT,
  replanned_from TEXT,
  start_snapshot TEXT,
  awaiting_since TEXT,
  awaiting_ms    INTEGER NOT NULL DEFAULT 0,
  prompt_text    TEXT,
  lead_model     TEXT,
  lead_class     TEXT,
  lead_triage    TEXT
);
CREATE INDEX IF NOT EXISTS requests_by_session ON requests(session_id, created_at);

CREATE TABLE IF NOT EXISTS subtasks (
  request_id  TEXT NOT NULL REFERENCES requests(id),
  id          TEXT NOT NULL,
  role        TEXT NOT NULL,
  slot        INTEGER NOT NULL,
  step        TEXT NOT NULL,
  write_scope TEXT NOT NULL,
  unscoped    INTEGER NOT NULL DEFAULT 0,
  agent_type  TEXT NOT NULL,
  agent_id    TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  up_count    INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL,
  verdict     TEXT,
  tool_use_id TEXT,
  dispatch_seq INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  review      TEXT,
  protected_granted TEXT,
  PRIMARY KEY (request_id, id)
);
CREATE INDEX IF NOT EXISTS subtasks_pending ON subtasks(status, agent_type, dispatch_seq);

CREATE TABLE IF NOT EXISTS agents (
  agent_id        TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  request_id      TEXT,
  subtask_id      TEXT,
  agent_type      TEXT,
  role            TEXT,
  slot            INTEGER,
  step            TEXT,
  cwd             TEXT,
  snapshot        TEXT,
  verify_env      TEXT,
  transcript_path TEXT,
  pairing         TEXT NOT NULL,
  started_at      TEXT NOT NULL,
  stopped_at      TEXT,
  stop_count      INTEGER NOT NULL DEFAULT 0,
  fail_count      INTEGER NOT NULL DEFAULT 0,
  resolved_model  TEXT,
  worktree_branch TEXT,
  worktree_path   TEXT
);
CREATE INDEX IF NOT EXISTS agents_by_request ON agents(request_id);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  request_id  TEXT,
  agent_id    TEXT,
  type        TEXT NOT NULL,
  tool_name   TEXT,
  received_at TEXT NOT NULL,
  spooled     INTEGER NOT NULL DEFAULT 0,
  payload     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_session ON events(session_id, id);

CREATE TABLE IF NOT EXISTS signals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT,
  subtask_id TEXT,
  agent_id   TEXT,
  attempt    INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  ok         INTEGER NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS signals_by_subtask ON signals(request_id, subtask_id);

CREATE TABLE IF NOT EXISTS costs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id         TEXT,
  subtask_id         TEXT,
  agent_id           TEXT,
  source             TEXT NOT NULL,
  model_id           TEXT,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  usd                REAL,
  created_at         TEXT NOT NULL,
  calls              INTEGER,
  note               TEXT
);
CREATE INDEX IF NOT EXISTS costs_by_request ON costs(request_id);

-- decision 130 (v10): usage rows from the API-key mode proxy, one per exchange, stored once by id
CREATE TABLE IF NOT EXISTS proxy_rows (
  id                  TEXT PRIMARY KEY,
  message_id          TEXT,
  upstream_request_id TEXT,
  session_id          TEXT,
  agent_id            TEXT,
  parent_agent_id     TEXT,
  prompt_id           TEXT,
  request_class       TEXT,
  agent_type          TEXT,
  path                TEXT NOT NULL,
  model               TEXT,
  input               INTEGER NOT NULL,
  output              INTEGER NOT NULL,
  cache_read          INTEGER NOT NULL,
  cache_write         INTEGER NOT NULL,
  cache_write_5m      INTEGER NOT NULL,
  cache_write_1h      INTEGER NOT NULL,
  usd                 REAL NOT NULL,
  priced              INTEGER NOT NULL,
  state               TEXT NOT NULL,
  http_status         INTEGER NOT NULL,
  token_id            TEXT NOT NULL,
  started_at          TEXT NOT NULL,
  ended_at            TEXT NOT NULL,
  received_at         TEXT NOT NULL,
  request_id          TEXT,
  subtask_id          TEXT,
  attributed_by       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS proxy_rows_message ON proxy_rows(message_id);
CREATE INDEX IF NOT EXISTS proxy_rows_request ON proxy_rows(request_id);
CREATE INDEX IF NOT EXISTS costs_by_agent ON costs(agent_id, source);

CREATE TABLE IF NOT EXISTS pending_levels (
  session_id TEXT PRIMARY KEY,
  level      TEXT NOT NULL,
  set_at     TEXT NOT NULL
);

-- T7 (decisions 104-111): one row per closed request: what was planned, what happened, what it cost.
-- No prompt text unless config.recordPrompts is on.
CREATE TABLE IF NOT EXISTS request_records (
  request_id    TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  closed_at     TEXT NOT NULL,
  kind          TEXT,
  level         TEXT NOT NULL,
  final_level   TEXT NOT NULL,
  outcome       TEXT,
  changed_files INTEGER,
  lines_added   INTEGER,
  lines_removed INTEGER,
  duration_ms   INTEGER,
  active_ms     INTEGER,
  subtask_usd   REAL,
  lead_usd      REAL,
  total_usd     REAL,
  record        TEXT NOT NULL,
  prompt        TEXT
);
CREATE INDEX IF NOT EXISTS request_records_closed ON request_records (closed_at);

-- spec 3.5: the step of each role slot of a request after misses (absent: the preset's start step)
CREATE TABLE IF NOT EXISTS slots (
  request_id TEXT NOT NULL,
  role       TEXT NOT NULL,
  slot       INTEGER NOT NULL,
  step       TEXT NOT NULL,
  up_count   INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  fail_streak INTEGER NOT NULL DEFAULT 0,
  lead_raises INTEGER NOT NULL DEFAULT 0,
  easy_streak INTEGER NOT NULL DEFAULT 0,
  last_easy   INTEGER NOT NULL DEFAULT 0,
  lock_step   TEXT,
  lock_left   INTEGER NOT NULL DEFAULT 0,
  down_count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (request_id, role, slot)
);

-- decisions 128, 129: a raise or a protected-path grant the lead asked for that needs a user turn first
CREATE TABLE IF NOT EXISTS confirmations (
  request_id     TEXT NOT NULL,
  kind           TEXT NOT NULL,
  subtask_id     TEXT NOT NULL,
  payload        TEXT NOT NULL,
  after_event_id INTEGER NOT NULL,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (request_id, kind, subtask_id)
);

-- decision 117: the lead's model as last seen for each session
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  lead_model TEXT,
  seen_at    TEXT NOT NULL
);

-- decision 97: what each session's hooks see (from SessionStart routerClient), for doctor
CREATE TABLE IF NOT EXISTS clients (
  session_id   TEXT PRIMARY KEY,
  node         TEXT,
  node_version TEXT,
  router_home  TEXT,
  port         INTEGER,
  seen_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS clients_seen ON clients (seen_at);
`;

type Row = Record<string, SQLInputValue>;
const s = (v: unknown): string => String(v);
const sn = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const n = (v: unknown): number => Number(v ?? 0);
const nn = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const json = <T>(v: unknown): T => JSON.parse(String(v)) as T;

function toRequest(r: Row): RequestRow {
  return {
    id: s(r.id), sessionId: s(r.session_id), createdAt: s(r.created_at), promptId: sn(r.prompt_id),
    level: s(r.level) as Level, preset: s(r.preset), budgetUsd: n(r.budget_usd),
    triage: json<TriageResult>(r.triage), team: json<TeamPreset>(r.team),
    leadCostUsd: n(r.lead_cost_usd), usedUsd: n(r.used_usd), status: s(r.status) as RequestStatus,
    closedAt: sn(r.closed_at), turns: n(r.turns),
    overriddenTriage: r.override_from === null || r.override_from === undefined ? null : json<TriageResult>(r.override_from),
    outcome: sn(r.outcome) as RequestOutcome | null,
    presetSource: sn(r.preset_source), forcedFrom: sn(r.forced_from) as Level | null,
    leadModel: sn(r.lead_model), leadClass: sn(r.lead_class),
    replannedFrom: r.replanned_from === null || r.replanned_from === undefined ? null : json<TriageResult>(r.replanned_from),
  };
}

function toSubtask(r: Row): SubtaskRow {
  const agentId = sn(r.agent_id);
  return {
    id: s(r.id), requestId: s(r.request_id), role: s(r.role) as Role, slot: n(r.slot), step: s(r.step) as Step,
    writeScope: json<string[]>(r.write_scope), ...(agentId ? { agentId } : {}),
    attempts: n(r.attempts), upCount: n(r.up_count), status: s(r.status) as SubtaskStatus,
    agentType: s(r.agent_type), unscoped: n(r.unscoped) === 1, verdict: sn(r.verdict) as SubtaskVerdict | null,
    toolUseId: sn(r.tool_use_id), createdAt: s(r.created_at), updatedAt: s(r.updated_at),
    review: r.review === null || r.review === undefined ? null : json<SubtaskReview>(r.review),
    protectedGranted: r.protected_granted === null || r.protected_granted === undefined ? [] : json<string[]>(r.protected_granted),
  };
}

function toConfirmation(r: Row): ConfirmationRow {
  return {
    requestId: s(r.request_id), kind: s(r.kind) as ConfirmationRow['kind'], subtaskId: s(r.subtask_id), payload: json<unknown>(r.payload),
    afterEventId: n(r.after_event_id), createdAt: s(r.created_at),
  };
}

function toAgent(r: Row): AgentRow {
  return {
    agentId: s(r.agent_id), sessionId: s(r.session_id), requestId: sn(r.request_id), subtaskId: sn(r.subtask_id),
    agentType: sn(r.agent_type), role: sn(r.role) as Role | null, slot: nn(r.slot), step: sn(r.step) as Step | null,
    cwd: sn(r.cwd), snapshot: r.snapshot === null || r.snapshot === undefined ? null : json<Snapshot>(r.snapshot),
    verifyEnv: r.verify_env === null || r.verify_env === undefined ? null : json<Record<string, string>>(r.verify_env),
    transcriptPath: sn(r.transcript_path),
    pairing: s(r.pairing) as Pairing, startedAt: s(r.started_at), stoppedAt: sn(r.stopped_at),
    stopCount: n(r.stop_count), failCount: n(r.fail_count), resolvedModel: sn(r.resolved_model),
    worktreeBranch: sn(r.worktree_branch), worktreePath: sn(r.worktree_path),
  };
}

export interface NewRequest {
  id: string;
  sessionId: string;
  createdAt: string;
  promptId: string | null;
  triage: TriageResult;
  team: TeamPreset;
  /** A request replayed from the spool after a newer one opened is recorded as already closed (audit #12). */
  closedAt?: string;
  presetSource?: string;
  forcedFrom?: Level;
  leadModel?: string | null;
  leadClass?: string;
}

export interface DispatchInput {
  requestId: string;
  id: string;
  role: Role;
  slot: number;
  step: Step;
  writeScope: string[];
  unscoped: boolean;
  agentType: string;
  toolUseId: string | null;
  at: string;
}

export type AgentPatch = Partial<Pick<AgentRow,
  'requestId' | 'subtaskId' | 'role' | 'slot' | 'step' | 'pairing' | 'stoppedAt' | 'stopCount' | 'failCount' |
  'resolvedModel' | 'worktreeBranch' | 'worktreePath' | 'cwd' | 'agentType' | 'snapshot' | 'verifyEnv' | 'transcriptPath'>>;

const AGENT_COLS: Record<keyof AgentPatch, string> = {
  requestId: 'request_id', subtaskId: 'subtask_id', role: 'role', slot: 'slot', step: 'step', pairing: 'pairing',
  stoppedAt: 'stopped_at', stopCount: 'stop_count', failCount: 'fail_count', resolvedModel: 'resolved_model',
  worktreeBranch: 'worktree_branch', worktreePath: 'worktree_path', cwd: 'cwd', agentType: 'agent_type', snapshot: 'snapshot',
  verifyEnv: 'verify_env', transcriptPath: 'transcript_path',
};

export interface ClientRow {
  sessionId: string;
  node: string | null;
  nodeVersion: string | null;
  routerHome: string | null;
  port: number | null;
  seenAt: string;
}

export interface RecordRow {
  requestId: string;
  sessionId: string;
  createdAt: string;
  closedAt: string;
  kind: string | null;
  level: Level;
  finalLevel: Level;
  outcome: string | null;
  changedFiles: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  durationMs: number | null;
  activeMs: number | null;
  subtaskUsd: number;
  leadUsd: number | null;
  totalUsd: number;
  record: Record<string, unknown>;
  prompt: string | null;
}

export type SubtaskPatch = Partial<Pick<SubtaskRow, 'status' | 'verdict' | 'agentId' | 'upCount' | 'writeScope' | 'review' | 'protectedGranted'>>;

export interface SlotRow {
  role: Role; slot: number; step: Step; upCount: number; failStreak: number; leadRaises: number;
  /** Decision 135 (core SlotAdjust): easy passes in a row, whether the latest result was one, the floor lock, step-downs so far. */
  easyStreak: number; lastEasy: boolean; lockStep: Step | null; lockLeft: number; downCount: number;
}

export class Ledger {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    const v = n((this.db.prepare('PRAGMA user_version').get() as Row | undefined)?.user_version);
    if (v > SCHEMA_VERSION) throw new Error(`ledger schema v${v} is newer than this daemon (v${SCHEMA_VERSION})`);
    // v1..v3 -> v4: costs.calls / costs.note (transcript costs). Added before SCHEMA so its index can use them.
    const costCols = (this.db.prepare('PRAGMA table_info(costs)').all() as Row[]).map(r => s(r.name));
    if (costCols.length && !costCols.includes('calls')) this.db.exec('ALTER TABLE costs ADD COLUMN calls INTEGER; ALTER TABLE costs ADD COLUMN note TEXT;');
    this.db.exec(SCHEMA);
    if (v === 1) this.db.exec('ALTER TABLE requests ADD COLUMN override_from TEXT');   // v1 -> v2: manual level overrides
    // v1..v4 -> v5: requests.outcome (decision 87)
    const reqCols = (this.db.prepare('PRAGMA table_info(requests)').all() as Row[]).map(r => s(r.name));
    if (!reqCols.includes('outcome')) this.db.exec('ALTER TABLE requests ADD COLUMN outcome TEXT');
    // v1..v5 -> v6: preset source (teams.yaml), forced level (decision 107), T6 re-plan
    for (const c of ['preset_source', 'forced_from', 'replanned_from', 'start_snapshot', 'awaiting_since', 'prompt_text', 'lead_model', 'lead_class']) {
      if (!reqCols.includes(c)) this.db.exec(`ALTER TABLE requests ADD COLUMN ${c} TEXT`);
    }
    if (!reqCols.includes('awaiting_ms')) this.db.exec('ALTER TABLE requests ADD COLUMN awaiting_ms INTEGER NOT NULL DEFAULT 0');
    // v2 -> v3: pending_levels is created by SCHEMA (CREATE TABLE IF NOT EXISTS)
    // v1..v5 -> v6: agents.verify_env (decision 99)
    const agentCols = (this.db.prepare('PRAGMA table_info(agents)').all() as Row[]).map(r => s(r.name));
    if (!agentCols.includes('verify_env')) this.db.exec('ALTER TABLE agents ADD COLUMN verify_env TEXT');
    // v6 -> v7: agents.transcript_path (cost re-read when the request closes); sessions is created by SCHEMA
    if (!agentCols.includes('transcript_path')) this.db.exec('ALTER TABLE agents ADD COLUMN transcript_path TEXT');
    // v7 -> v8: router tools (decisions 127-129); confirmations is created by SCHEMA
    if (!reqCols.includes('lead_triage')) this.db.exec('ALTER TABLE requests ADD COLUMN lead_triage TEXT');
    const subCols = (this.db.prepare('PRAGMA table_info(subtasks)').all() as Row[]).map(r => s(r.name));
    for (const c of ['review', 'protected_granted']) if (!subCols.includes(c)) this.db.exec(`ALTER TABLE subtasks ADD COLUMN ${c} TEXT`);
    const slotCols = (this.db.prepare('PRAGMA table_info(slots)').all() as Row[]).map(r => s(r.name));
    for (const c of ['fail_streak', 'lead_raises']) if (!slotCols.includes(c)) this.db.exec(`ALTER TABLE slots ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 0`);
    // v8 -> v9: step-down state per slot (decision 135)
    for (const c of ['easy_streak', 'last_easy', 'lock_left', 'down_count']) if (!slotCols.includes(c)) this.db.exec(`ALTER TABLE slots ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 0`);
    if (!slotCols.includes('lock_step')) this.db.exec('ALTER TABLE slots ADD COLUMN lock_step TEXT');
    // v9 -> v10: proxy_rows (decision 130) is created by SCHEMA; request totals are recounted from the cost rows
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  journalMode(): string {
    return s((this.db.prepare('PRAGMA journal_mode').get() as Row).journal_mode);
  }

  #txDepth = 0;

  /** Runs fn in one transaction; a nested call joins the outer one. */
  tx<T>(fn: () => T): T {
    if (this.#txDepth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.#txDepth++;
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.#txDepth--;
    }
  }

  // ------------------------------------------------------------------ events

  insertEvent(e: EventInput): void {
    this.db.prepare(`INSERT INTO events (session_id, request_id, agent_id, type, tool_name, received_at, spooled, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(e.sessionId, e.requestId, e.agentId, e.type, e.toolName, e.receivedAt, e.spooled ? 1 : 0, e.payload);
  }

  // ------------------------------------------------------------------ requests

  createRequest(r: NewRequest): RequestRow {
    this.db.prepare(`INSERT INTO requests (id, session_id, created_at, prompt_id, level, preset, budget_usd, triage, team, status, closed_at,
        preset_source, forced_from, lead_model, lead_class) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(r.id, r.sessionId, r.createdAt, r.promptId, r.triage.level, r.triage.preset, r.triage.budgetUsd,
        JSON.stringify(r.triage), JSON.stringify(r.team), r.closedAt ? 'closed' : 'open', r.closedAt ?? null,
        r.presetSource ?? null, r.forcedFrom ?? null, r.leadModel ?? null, r.leadClass ?? null);
    return this.getRequest(r.id)!;
  }

  /** Payload of the session's latest event of a type (masked, size-limited copy of the hook input). */
  lastEventPayload(sessionId: string, type: string): string | undefined {
    const r = this.db.prepare('SELECT payload FROM events WHERE session_id = ? AND type = ? ORDER BY id DESC LIMIT 1').get(sessionId, type) as Row | undefined;
    return r ? s(r.payload) : undefined;
  }

  /** The session's request opened by this Claude Code prompt_id, if any (a replayed duplicate, audit #12). */
  requestByPromptId(sessionId: string, promptId: string): RequestRow | undefined {
    const r = this.db.prepare('SELECT * FROM requests WHERE session_id = ? AND prompt_id = ? LIMIT 1').get(sessionId, promptId) as Row | undefined;
    return r && toRequest(r);
  }

  getRequest(id: string): RequestRow | undefined {
    const r = this.db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as Row | undefined;
    return r && toRequest(r);
  }

  /** Most recent request of the session, whatever its status. */
  latestRequest(sessionId: string): RequestRow | undefined {
    const r = this.db.prepare('SELECT * FROM requests WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(sessionId) as Row | undefined;
    return r && toRequest(r);
  }

  latestRequestAny(): RequestRow | undefined {
    const r = this.db.prepare('SELECT * FROM requests ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as Row | undefined;
    return r && toRequest(r);
  }

  setOutcome(id: string, outcome: RequestOutcome): void {
    this.db.prepare('UPDATE requests SET outcome = ? WHERE id = ?').run(outcome, id);
  }

  setRequestStatus(id: string, status: RequestStatus, at: string): void {
    this.tx(() => {
      this.#leaveAwaiting(id, status, at);
      this.db.prepare('UPDATE requests SET status = ?, closed_at = ? WHERE id = ?').run(status, status === 'closed' ? at : null, id);
    });
  }

  /** T7: time spent awaiting the user is summed in awaiting_ms (it is not active work on the request). */
  #leaveAwaiting(id: string, next: RequestStatus, at: string): void {
    const r = this.db.prepare('SELECT status, awaiting_since FROM requests WHERE id = ?').get(id) as Row | undefined;
    if (!r) return;
    if (next === 'awaiting_user') {
      if (r.awaiting_since === null || r.awaiting_since === undefined) this.db.prepare('UPDATE requests SET awaiting_since = ? WHERE id = ?').run(at, id);
      return;
    }
    if (r.awaiting_since === null || r.awaiting_since === undefined) return;
    const ms = Math.max(0, Date.parse(at) - Date.parse(s(r.awaiting_since)));
    this.db.prepare('UPDATE requests SET awaiting_ms = awaiting_ms + ?, awaiting_since = NULL WHERE id = ?').run(Number.isFinite(ms) ? ms : 0, id);
  }

  setRequestSnapshot(id: string, snapshot: unknown): void {
    this.db.prepare('UPDATE requests SET start_snapshot = ? WHERE id = ?').run(JSON.stringify(snapshot), id);
  }

  getRequestSnapshot<T>(id: string): T | undefined {
    const r = this.db.prepare('SELECT start_snapshot FROM requests WHERE id = ?').get(id) as Row | undefined;
    return r && r.start_snapshot !== null && r.start_snapshot !== undefined ? json<T>(r.start_snapshot) : undefined;
  }

  setRequestPrompt(id: string, text: string): void {
    this.db.prepare('UPDATE requests SET prompt_text = ? WHERE id = ?').run(text, id);
  }

  /** awaiting_ms and prompt_text of a request (T7). */
  requestExtras(id: string): { awaitingMs: number; awaitingSince: string | null; prompt: string | null } {
    const r = this.db.prepare('SELECT awaiting_ms, awaiting_since, prompt_text FROM requests WHERE id = ?').get(id) as Row | undefined;
    return { awaitingMs: n(r?.awaiting_ms), awaitingSince: sn(r?.awaiting_since), prompt: sn(r?.prompt_text) };
  }

  /** The prompt_submit events of a request: their prompt_id and whether they were task notifications. */
  promptEvents(requestId: string): Array<{ promptId: string | null; notification: boolean }> {
    return (this.db.prepare(`SELECT payload FROM events WHERE request_id = ? AND type = 'prompt_submit' ORDER BY id`).all(requestId) as Row[]).map(r => {
      try {
        const p = JSON.parse(s(r.payload)) as { prompt_id?: unknown; prompt?: unknown };
        return { promptId: typeof p.prompt_id === 'string' ? p.prompt_id : null, notification: /^\s*<task-notification>/.test(String(p.prompt ?? '')) };
      } catch {
        return { promptId: null, notification: false };
      }
    });
  }

  /** T7: the lead's cost rows of a request are replaced each time it closes (lead_cost_usd follows). */
  replaceLeadCosts(requestId: string, rows: CostInput[]): void {
    this.tx(() => {
      this.db.prepare(`DELETE FROM costs WHERE request_id = ? AND source = 'lead'`).run(requestId);
      for (const r of rows) this.#insertCost({ ...r, requestId, source: 'lead' });
      this.#recount(requestId);
    });
  }

  upsertRecord(r: RecordRow): void {
    this.db.prepare(`INSERT INTO request_records (request_id, session_id, created_at, closed_at, kind, level, final_level, outcome,
        changed_files, lines_added, lines_removed, duration_ms, active_ms, subtask_usd, lead_usd, total_usd, record, prompt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (request_id) DO UPDATE SET closed_at = excluded.closed_at, kind = excluded.kind, level = excluded.level,
        final_level = excluded.final_level, outcome = excluded.outcome, changed_files = excluded.changed_files,
        lines_added = excluded.lines_added, lines_removed = excluded.lines_removed, duration_ms = excluded.duration_ms,
        active_ms = excluded.active_ms, subtask_usd = excluded.subtask_usd, lead_usd = excluded.lead_usd,
        total_usd = excluded.total_usd, record = excluded.record, prompt = excluded.prompt`)
      .run(r.requestId, r.sessionId, r.createdAt, r.closedAt, r.kind, r.level, r.finalLevel, r.outcome, r.changedFiles,
        r.linesAdded, r.linesRemoved, r.durationMs, r.activeMs, r.subtaskUsd, r.leadUsd, r.totalUsd, JSON.stringify(r.record), r.prompt);
  }

  getRecord(requestId: string): Record<string, unknown> | undefined {
    const r = this.db.prepare('SELECT record FROM request_records WHERE request_id = ?').get(requestId) as Row | undefined;
    return r ? json<Record<string, unknown>>(r.record) : undefined;
  }

  /**
   * Re-plans a request at a manual level: triage, preset and budget are replaced; the first replaced
   * triage is kept in override_from. Spent cost and subtasks stay as they are.
   */
  /** T6: re-plans a lead-direct request as a team request; the triage it had is kept in replanned_from. */
  escalateRequest(id: string, triage: TriageResult, team: TeamPreset): RequestRow {
    this.db.prepare(`UPDATE requests SET replanned_from = COALESCE(replanned_from, triage), triage = ?, team = ?, level = ?, preset = ?,
        budget_usd = ? WHERE id = ?`)
      .run(JSON.stringify(triage), JSON.stringify(team), triage.level, triage.preset, triage.budgetUsd, id);
    return this.getRequest(id)!;
  }

  replanRequest(id: string, triage: TriageResult, team: TeamPreset): RequestRow {
    this.db.prepare(`UPDATE requests SET override_from = COALESCE(override_from, triage), triage = ?, team = ?, level = ?, preset = ?,
        budget_usd = ? WHERE id = ?`)
      .run(JSON.stringify(triage), JSON.stringify(team), triage.level, triage.preset, triage.budgetUsd, id);
    return this.getRequest(id)!;
  }

  /** One pending level per session; a new `/router level` replaces it. */
  // ------------------------------------------------------------------ slots (spec 3.5)

  getSlots(requestId: string): SlotRow[] {
    return (this.db.prepare('SELECT * FROM slots WHERE request_id = ? ORDER BY role, slot').all(requestId) as Row[]).map(r => ({
      role: s(r.role) as Role, slot: n(r.slot), step: s(r.step) as Step, upCount: n(r.up_count), failStreak: n(r.fail_streak), leadRaises: n(r.lead_raises),
      easyStreak: n(r.easy_streak), lastEasy: n(r.last_easy) === 1, lockStep: sn(r.lock_step) as Step | null, lockLeft: n(r.lock_left), downCount: n(r.down_count),
    }));
  }

  /**
   * Writes a slot's step-down state (decision 135, core SlotAdjust), with its step and the raises that count:
   * after an easy pass, a raise, a dispatch. A slot without a row gets one. Reject streak and lead-only raises stay.
   */
  setSlotAdjust(requestId: string, role: Role, slot: number,
    a: { step: Step; upCount: number; easyStreak: number; lastEasy: boolean; lockStep: Step | null; lockLeft: number; downCount: number }, at: string): void {
    this.db.prepare(`INSERT INTO slots (request_id, role, slot, step, up_count, updated_at, easy_streak, last_easy, lock_step, lock_left, down_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (request_id, role, slot) DO UPDATE SET step = excluded.step, up_count = excluded.up_count, updated_at = excluded.updated_at,
        easy_streak = excluded.easy_streak, last_easy = excluded.last_easy, lock_step = excluded.lock_step, lock_left = excluded.lock_left,
        down_count = excluded.down_count`)
      .run(requestId, role, slot, a.step, a.upCount, at, a.easyStreak, a.lastEasy ? 1 : 0, a.lockStep, a.lockLeft, a.downCount);
  }

  /** The subtask dispatched last on a slot of a request (its id), if any. */
  latestSubtaskOnSlot(requestId: string, role: Role, slot: number): string | undefined {
    const r = this.db.prepare('SELECT id FROM subtasks WHERE request_id = ? AND role = ? AND slot = ? ORDER BY dispatch_seq DESC LIMIT 1').get(requestId, role, slot) as Row | undefined;
    return r ? s(r.id) : undefined;
  }

  /** Moves a slot to a step (a raise). The failure streak starts again at the new step. */
  setSlot(requestId: string, role: Role, slot: number, step: Step, upCount: number, at: string): void {
    this.db.prepare(`INSERT INTO slots (request_id, role, slot, step, up_count, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (request_id, role, slot) DO UPDATE SET step = excluded.step, up_count = excluded.up_count, fail_streak = 0, updated_at = excluded.updated_at`)
      .run(requestId, role, slot, step, upCount, at);
  }

  /**
   * Sets a slot's counters without moving it: failStreak (rejects in a row, decision 127) and leadRaises
   * (raises on the lead's word alone, decision 128). A slot not raised yet gets its row at `step`.
   */
  setSlotCounters(requestId: string, role: Role, slot: number, step: Step, c: { failStreak?: number; leadRaises?: number }, at: string): void {
    this.db.prepare(`INSERT INTO slots (request_id, role, slot, step, up_count, updated_at, fail_streak, lead_raises) VALUES (?, ?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT (request_id, role, slot) DO UPDATE SET fail_streak = COALESCE(?, fail_streak), lead_raises = COALESCE(?, lead_raises), updated_at = excluded.updated_at`)
      .run(requestId, role, slot, step, at, c.failStreak ?? 0, c.leadRaises ?? 0, c.failStreak ?? null, c.leadRaises ?? null);
  }

  // ------------------------------------------------------------------ router tools (decisions 127-129)

  setLeadTriage(requestId: string, triage: unknown): void {
    this.db.prepare('UPDATE requests SET lead_triage = ? WHERE id = ?').run(JSON.stringify(triage), requestId);
  }

  getLeadTriage<T>(requestId: string): T | null {
    const r = this.db.prepare('SELECT lead_triage FROM requests WHERE id = ?').get(requestId) as Row | undefined;
    return r && r.lead_triage !== null && r.lead_triage !== undefined ? json<T>(r.lead_triage) : null;
  }

  /** Stores (or replaces) a request waiting for a user turn; the session's newest event marks "before". */
  setConfirmation(c: { requestId: string; sessionId: string; kind: ConfirmationRow['kind']; subtaskId: string; payload: unknown; at: string }): void {
    const last = n((this.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM events WHERE session_id = ?').get(c.sessionId) as Row).m);
    this.db.prepare(`INSERT INTO confirmations (request_id, kind, subtask_id, payload, after_event_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (request_id, kind, subtask_id) DO UPDATE SET payload = excluded.payload, after_event_id = excluded.after_event_id, created_at = excluded.created_at`)
      .run(c.requestId, c.kind, c.subtaskId, JSON.stringify(c.payload), last, c.at);
  }

  getConfirmation(requestId: string, kind: ConfirmationRow['kind'], subtaskId: string): ConfirmationRow | undefined {
    const r = this.db.prepare('SELECT * FROM confirmations WHERE request_id = ? AND kind = ? AND subtask_id = ?').get(requestId, kind, subtaskId) as Row | undefined;
    return r && toConfirmation(r);
  }

  listConfirmations(requestId: string): ConfirmationRow[] {
    return (this.db.prepare('SELECT * FROM confirmations WHERE request_id = ? ORDER BY created_at, rowid').all(requestId) as Row[]).map(toConfirmation);
  }

  clearConfirmation(requestId: string, kind: ConfirmationRow['kind'], subtaskId: string): void {
    this.db.prepare('DELETE FROM confirmations WHERE request_id = ? AND kind = ? AND subtask_id = ?').run(requestId, kind, subtaskId);
  }

  /**
   * Whether the user sent a prompt in the session after event `afterEventId`: a live prompt of the main
   * session that is not a task notification. It shows that the user was in the loop, not what they answered.
   */
  userPromptAfter(sessionId: string, afterEventId: number): boolean {
    const rows = this.db.prepare(`SELECT payload FROM events WHERE session_id = ? AND id > ? AND type = 'prompt_submit' AND agent_id IS NULL AND spooled = 0
      ORDER BY id`).all(sessionId, afterEventId) as Row[];
    return rows.some(r => {
      try { return !/^\s*<task-notification>/.test(String((JSON.parse(s(r.payload)) as { prompt?: unknown }).prompt ?? '')); } catch { return false; }
    });
  }

  // ------------------------------------------------------------------ sessions (decision 117)

  setSessionLeadModel(sessionId: string, model: string, at: string): void {
    this.db.prepare(`INSERT INTO sessions (session_id, lead_model, seen_at) VALUES (?, ?, ?)
      ON CONFLICT (session_id) DO UPDATE SET lead_model = excluded.lead_model, seen_at = excluded.seen_at`).run(sessionId, model, at);
  }

  sessionLeadModel(sessionId: string): string | undefined {
    const r = this.db.prepare('SELECT lead_model FROM sessions WHERE session_id = ?').get(sessionId) as Row | undefined;
    return r && r.lead_model !== null && r.lead_model !== undefined ? s(r.lead_model) : undefined;
  }

  // ------------------------------------------------------------------ clients (decision 97)

  setClient(c: ClientRow): void {
    this.db.prepare(`INSERT INTO clients (session_id, node, node_version, router_home, port, seen_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (session_id) DO UPDATE SET node = excluded.node, node_version = excluded.node_version,
        router_home = excluded.router_home, port = excluded.port, seen_at = excluded.seen_at
      WHERE excluded.seen_at >= clients.seen_at`)   // a replayed older SessionStart does not replace a newer one
      .run(c.sessionId, c.node, c.nodeVersion, c.routerHome, c.port, c.seenAt);
  }

  /** The most recently seen sessions' clients, newest first. */
  recentClients(limit = 10): ClientRow[] {
    return (this.db.prepare('SELECT * FROM clients ORDER BY seen_at DESC, rowid DESC LIMIT ?').all(limit) as Row[]).map(r => ({
      sessionId: s(r.session_id), node: sn(r.node), nodeVersion: sn(r.node_version), routerHome: sn(r.router_home), port: nn(r.port), seenAt: s(r.seen_at),
    }));
  }

  setPendingLevel(sessionId: string, level: Level, at: string): void {
    this.db.prepare(`INSERT INTO pending_levels (session_id, level, set_at) VALUES (?, ?, ?)
      ON CONFLICT (session_id) DO UPDATE SET level = excluded.level, set_at = excluded.set_at`).run(sessionId, level, at);
  }

  getPendingLevel(sessionId: string): Level | undefined {
    const r = this.db.prepare('SELECT level FROM pending_levels WHERE session_id = ?').get(sessionId) as Row | undefined;
    return r ? (s(r.level) as Level) : undefined;
  }

  clearPendingLevel(sessionId: string): void {
    this.db.prepare('DELETE FROM pending_levels WHERE session_id = ?').run(sessionId);
  }

  /** Records the triage a new request's manual level replaced. */
  setOverriddenTriage(id: string, original: TriageResult): void {
    this.db.prepare('UPDATE requests SET override_from = ? WHERE id = ?').run(JSON.stringify(original), id);
  }

  reopenRequest(id: string, at?: string): void {
    this.tx(() => {
      if (at) this.#leaveAwaiting(id, 'open', at);
      this.db.prepare(`UPDATE requests SET status = 'open', closed_at = NULL, turns = turns + 1 WHERE id = ?`).run(id);
    });
  }

  // ------------------------------------------------------------------ subtasks

  getSubtask(requestId: string, id: string): SubtaskRow | undefined {
    const r = this.db.prepare('SELECT * FROM subtasks WHERE request_id = ? AND id = ?').get(requestId, id) as Row | undefined;
    return r && toSubtask(r);
  }

  listSubtasks(requestId: string): SubtaskRow[] {
    return (this.db.prepare('SELECT * FROM subtasks WHERE request_id = ? ORDER BY created_at, rowid').all(requestId) as Row[])
      .map(toSubtask);
  }

  /** Registers (or re-dispatches) a subtask at PreToolUse(Agent): pending until SubagentStart pairs it. */
  dispatchSubtask(d: DispatchInput): SubtaskRow {
    this.db.prepare(`INSERT INTO subtasks (request_id, id, role, slot, step, write_scope, unscoped, agent_type, agent_id,
        attempts, status, verdict, tool_use_id, dispatch_seq, created_at, updated_at)
      VALUES (:requestId, :id, :role, :slot, :step, :scope, :unscoped, :agentType, NULL, 1, 'pending', NULL, :toolUseId,
        (SELECT COALESCE(MAX(dispatch_seq), 0) + 1 FROM subtasks), :at, :at)
      ON CONFLICT (request_id, id) DO UPDATE SET
        role = excluded.role, slot = excluded.slot, step = excluded.step, write_scope = excluded.write_scope,
        unscoped = excluded.unscoped, agent_type = excluded.agent_type, agent_id = NULL, attempts = attempts + 1,
        status = 'pending', verdict = NULL, review = NULL, tool_use_id = excluded.tool_use_id, dispatch_seq = excluded.dispatch_seq,
        updated_at = excluded.updated_at`)
      .run({
        requestId: d.requestId, id: d.id, role: d.role, slot: d.slot, step: d.step, scope: JSON.stringify(d.writeScope),
        unscoped: d.unscoped ? 1 : 0, agentType: d.agentType, toolUseId: d.toolUseId, at: d.at,
      });
    return this.getSubtask(d.requestId, d.id)!;
  }

  /** Oldest subtask of the session that was dispatched with this agent type and has no agent yet. */
  nextPendingSubtask(sessionId: string, agentType: string, requestId?: string): SubtaskRow | undefined {
    const r = (requestId
      ? this.db.prepare(`SELECT * FROM subtasks WHERE request_id = ? AND agent_type = ? AND status = 'pending' AND agent_id IS NULL
          ORDER BY dispatch_seq LIMIT 1`).get(requestId, agentType)
      : this.db.prepare(`SELECT s.* FROM subtasks s JOIN requests q ON q.id = s.request_id
          WHERE q.session_id = ? AND s.agent_type = ? AND s.status = 'pending' AND s.agent_id IS NULL
          ORDER BY s.dispatch_seq LIMIT 1`).get(sessionId, agentType)) as Row | undefined;
    return r && toSubtask(r);
  }

  /** Pending or running subtasks of every request of the session (a tag stays busy across requests, audit #10). */
  activeSubtasksInSession(sessionId: string): SubtaskRow[] {
    return (this.db.prepare(`SELECT s.* FROM subtasks s JOIN requests q ON q.id = s.request_id
      WHERE q.session_id = ? AND s.status IN ('pending', 'running') ORDER BY s.dispatch_seq`).all(sessionId) as Row[]).map(toSubtask);
  }

  /** The subtask dispatched by this Agent tool_use_id in the session, if any (a replayed duplicate, audit #12). */
  subtaskByToolUseId(sessionId: string, toolUseId: string): SubtaskRow | undefined {
    const r = this.db.prepare(`SELECT s.* FROM subtasks s JOIN requests q ON q.id = s.request_id
      WHERE q.session_id = ? AND s.tool_use_id = ? LIMIT 1`).get(sessionId, toolUseId) as Row | undefined;
    return r && toSubtask(r);
  }

  /** Audit #11: subtasks allowed but never started (no agent) and older than `before` are cancelled. */
  cancelStalePending(sessionId: string, before: string, at: string): string[] {
    const stale = (this.db.prepare(`SELECT s.request_id AS r, s.id AS id FROM subtasks s JOIN requests q ON q.id = s.request_id
      WHERE q.session_id = ? AND s.status = 'pending' AND s.agent_id IS NULL AND s.updated_at < ?`).all(sessionId, before) as Row[]);
    for (const x of stale) this.db.prepare(`UPDATE subtasks SET status = 'cancelled', updated_at = ? WHERE request_id = ? AND id = ?`).run(at, s(x.r), s(x.id));
    return stale.map(x => s(x.id));
  }

  updateSubtask(requestId: string, id: string, p: SubtaskPatch, at: string): void {
    const sets: string[] = [];
    const vals: SQLInputValue[] = [];
    if (p.status !== undefined) { sets.push('status = ?'); vals.push(p.status); }
    if (p.verdict !== undefined) { sets.push('verdict = ?'); vals.push(p.verdict); }
    if (p.agentId !== undefined) { sets.push('agent_id = ?'); vals.push(p.agentId ?? null); }
    if (p.upCount !== undefined) { sets.push('up_count = ?'); vals.push(p.upCount); }
    if (p.writeScope !== undefined) { sets.push('write_scope = ?'); vals.push(JSON.stringify(p.writeScope)); }
    if (p.review !== undefined) { sets.push('review = ?'); vals.push(p.review === null ? null : JSON.stringify(p.review)); }
    if (p.protectedGranted !== undefined) { sets.push('protected_granted = ?'); vals.push(JSON.stringify(p.protectedGranted)); }
    if (!sets.length) return;
    sets.push('updated_at = ?');
    vals.push(at, requestId, id);
    this.db.prepare(`UPDATE subtasks SET ${sets.join(', ')} WHERE request_id = ? AND id = ?`).run(...vals);
  }

  /** Clears an agent binding (used when PostToolUse shows the order-based pairing was wrong). */
  unbindSubtaskAgent(requestId: string, id: string, agentId: string, at: string): void {
    this.db.prepare('UPDATE subtasks SET agent_id = NULL, updated_at = ? WHERE request_id = ? AND id = ? AND agent_id = ?')
      .run(at, requestId, id, agentId);
  }

  // ------------------------------------------------------------------ agents

  insertAgent(a: Omit<AgentRow, 'stoppedAt' | 'stopCount' | 'failCount' | 'resolvedModel' | 'worktreeBranch' | 'worktreePath' | 'verifyEnv' | 'transcriptPath'>): void {
    this.db.prepare(`INSERT INTO agents (agent_id, session_id, request_id, subtask_id, agent_type, role, slot, step, cwd,
        snapshot, pairing, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (agent_id) DO NOTHING`)
      .run(a.agentId, a.sessionId, a.requestId, a.subtaskId, a.agentType, a.role, a.slot, a.step, a.cwd,
        a.snapshot ? JSON.stringify(a.snapshot) : null, a.pairing, a.startedAt);
  }

  getAgent(agentId: string): AgentRow | undefined {
    const r = this.db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agentId) as Row | undefined;
    return r && toAgent(r);
  }

  listAgents(requestId: string): AgentRow[] {
    return (this.db.prepare('SELECT * FROM agents WHERE request_id = ? ORDER BY started_at, rowid').all(requestId) as Row[])
      .map(toAgent);
  }

  updateAgent(agentId: string, p: AgentPatch): void {
    const sets: string[] = [];
    const vals: SQLInputValue[] = [];
    for (const [k, v] of Object.entries(p) as Array<[keyof AgentPatch, AgentPatch[keyof AgentPatch]]>) {
      if (v === undefined) continue;
      sets.push(`${AGENT_COLS[k]} = ?`);
      vals.push(k === 'snapshot' || k === 'verifyEnv' ? (v === null ? null : JSON.stringify(v)) : (v as SQLInputValue));
    }
    if (!sets.length) return;
    vals.push(agentId);
    this.db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE agent_id = ?`).run(...vals);
  }

  // ------------------------------------------------------------------ signals

  insertSignals(ctx: { requestId: string | null; subtaskId: string | null; agentId: string | null; attempt: number; at: string },
    signals: VerifySignal[]): void {
    const st = this.db.prepare(`INSERT INTO signals (request_id, subtask_id, agent_id, attempt, kind, ok, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const x of signals) st.run(ctx.requestId, ctx.subtaskId, ctx.agentId, ctx.attempt, x.kind, x.ok ? 1 : 0, x.detail ?? null, ctx.at);
  }

  listSignals(requestId: string, subtaskId?: string): SignalRow[] {
    const rows = (subtaskId === undefined
      ? this.db.prepare('SELECT * FROM signals WHERE request_id = ? ORDER BY id').all(requestId)
      : this.db.prepare('SELECT * FROM signals WHERE request_id = ? AND subtask_id = ? ORDER BY id').all(requestId, subtaskId)) as Row[];
    return rows.map(r => ({
      requestId: sn(r.request_id), subtaskId: sn(r.subtask_id), agentId: sn(r.agent_id), attempt: n(r.attempt),
      kind: s(r.kind) as SignalKind, ok: n(r.ok) === 1, ...(r.detail === null ? {} : { detail: s(r.detail) }), createdAt: s(r.created_at),
    }));
  }

  // ------------------------------------------------------------------ costs

  #insertCost(c: CostInput): void {
    this.db.prepare(`INSERT INTO costs (request_id, subtask_id, agent_id, source, model_id, input_tokens, output_tokens,
        cache_write_tokens, cache_read_tokens, usd, created_at, calls, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(c.requestId, c.subtaskId, c.agentId, c.source, c.modelId, c.inputTokens, c.outputTokens, c.cacheWriteTokens,
        c.cacheReadTokens, c.usd, c.createdAt, c.calls ?? null, c.note ?? null);
    if (c.requestId) this.#recount(c.requestId);
  }

  /**
   * A request's subtask cost (used_usd) and lead cost (lead_cost_usd) from its cost rows. With proxy rows
   * (API-key mode, decision 130) those are the cost source: an agent's rows are subtask cost, the main
   * conversation's the lead's; transcript, estimate and lead rows stay as the cross-check. Without proxy rows:
   * transcript and estimate rows are subtask cost, lead rows the lead's.
   */
  #recount(requestId: string): void {
    const r = this.db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN source = 'proxy' THEN 1 ELSE 0 END), 0) AS p,
        COALESCE(SUM(CASE WHEN source = 'proxy' AND agent_id IS NOT NULL THEN usd END), 0) AS pu,
        COALESCE(SUM(CASE WHEN source = 'proxy' AND agent_id IS NULL THEN usd END), 0) AS pl,
        COALESCE(SUM(CASE WHEN source IN ('transcript', 'estimate') THEN usd END), 0) AS tu,
        COALESCE(SUM(CASE WHEN source = 'lead' THEN usd END), 0) AS tl
      FROM costs WHERE request_id = ?`).get(requestId) as Row;
    const proxy = n(r.p) > 0;
    this.db.prepare('UPDATE requests SET used_usd = ?, lead_cost_usd = ? WHERE id = ?')
      .run(proxy ? n(r.pu) : n(r.tu), proxy ? n(r.pl) : n(r.tl), requestId);
  }

  /** Whether a request's cost comes from proxy rows (API-key mode). */
  hasProxyCosts(requestId: string): boolean {
    return !!this.db.prepare(`SELECT 1 AS x FROM costs WHERE request_id = ? AND source = 'proxy' LIMIT 1`).get(requestId);
  }

  // ------------------------------------------------------------------ proxy rows (decision 130)

  /**
   * Stores one proxy usage row (false: already taken, by row id or message id) and, when it belongs to a
   * request, its cost row of source 'proxy'.
   */
  insertProxyRow(row: UsageRow, a: { requestId: string | null; subtaskId: string | null; agentId: string | null; how: string }, at: string): boolean {
    return this.tx(() => {
      if (this.db.prepare('SELECT 1 AS x FROM proxy_rows WHERE id = ?').get(row.id)) return false;
      if (row.messageId && this.db.prepare('SELECT 1 AS x FROM proxy_rows WHERE message_id = ?').get(row.messageId)) return false;
      this.db.prepare(`INSERT INTO proxy_rows (id, message_id, upstream_request_id, session_id, agent_id, parent_agent_id, prompt_id,
          request_class, agent_type, path, model, input, output, cache_read, cache_write, cache_write_5m, cache_write_1h, usd, priced,
          state, http_status, token_id, started_at, ended_at, received_at, request_id, subtask_id, attributed_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(row.id, row.messageId, row.upstreamRequestId, row.sessionId, row.agentId, row.parentAgentId, row.promptId, row.requestClass,
          row.agentType, row.path, row.model, row.usage.input, row.usage.output, row.usage.cacheRead, row.usage.cacheWrite,
          row.usage.cacheWrite5m, row.usage.cacheWrite1h, row.usd, row.priced ? 1 : 0, row.state, row.httpStatus, row.tokenId,
          row.startedAt, row.endedAt, at, a.requestId, a.subtaskId, a.how);
      if (a.requestId && row.state !== 'error') {
        this.#insertCost({
          requestId: a.requestId, subtaskId: a.subtaskId, agentId: a.agentId, source: 'proxy', modelId: row.model, calls: 1,
          inputTokens: row.usage.input, outputTokens: row.usage.output, cacheWriteTokens: row.usage.cacheWrite, cacheReadTokens: row.usage.cacheRead,
          usd: row.usd, createdAt: at,
          ...(!row.priced ? { note: 'estimated: a model without a price, at the most expensive rates' } : row.state === 'partial' ? { note: 'partial: the stream did not finish' } : {}),
        });
      }
      return true;
    });
  }

  /** The request a prompt belongs to: the one it opened, or one it continued (an answer, a task notification). */
  requestOfPrompt(sessionId: string, promptId: string): RequestRow | undefined {
    const opened = this.requestByPromptId(sessionId, promptId);
    if (opened) return opened;
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(promptId)) return undefined;
    // the event payload is the compact JSON of the hook input: an exact substring match, no LIKE wildcards
    const e = this.db.prepare(`SELECT request_id AS r FROM events WHERE session_id = ? AND type = 'prompt_submit' AND request_id IS NOT NULL
        AND instr(payload, ?) > 0 ORDER BY id DESC LIMIT 1`).get(sessionId, JSON.stringify({ prompt_id: promptId }).slice(1, -1)) as Row | undefined;
    return e ? this.getRequest(s(e.r)) : undefined;
  }

  /** The session's request open at a time (ISO), if any. */
  requestOpenAt(sessionId: string, at: string): RequestRow | undefined {
    const r = this.db.prepare(`SELECT * FROM requests WHERE session_id = ? AND created_at <= ? AND (closed_at IS NULL OR closed_at >= ?)
        ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(sessionId, at, at) as Row | undefined;
    return r && toRequest(r);
  }

  /** Per agent (null: the lead), the proxy total next to the transcript total (decision 130 cross-check). */
  costPairs(requestId: string): Array<{ agentId: string | null; proxyUsd: number; transcriptUsd: number }> {
    return (this.db.prepare(`SELECT agent_id AS a,
        COALESCE(SUM(CASE WHEN source = 'proxy' THEN usd END), 0) AS p,
        COALESCE(SUM(CASE WHEN (agent_id IS NOT NULL AND source IN ('transcript', 'estimate')) OR (agent_id IS NULL AND source = 'lead') THEN usd END), 0) AS t
      FROM costs WHERE request_id = ? GROUP BY agent_id`).all(requestId) as Row[])
      .map(r => ({ agentId: sn(r.a), proxyUsd: Math.round(n(r.p) * 1e6) / 1e6, transcriptUsd: Math.round(n(r.t) * 1e6) / 1e6 }));
  }

  /** An agent's cost for the lead's result text: proxy rows when there are any, else transcript and estimates. */
  agentCostUsd(agentId: string): { usd: number; partlyEstimated: boolean } {
    const r = this.db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN source = 'proxy' THEN 1 ELSE 0 END), 0) AS p,
        COALESCE(SUM(CASE WHEN source = 'proxy' THEN usd END), 0) AS pu,
        COALESCE(SUM(CASE WHEN source = 'proxy' AND note LIKE 'estimated%' THEN 1 ELSE 0 END), 0) AS pe,
        COALESCE(SUM(CASE WHEN source IN ('transcript', 'estimate') THEN usd END), 0) AS tu,
        COALESCE(SUM(CASE WHEN source = 'estimate' THEN 1 ELSE 0 END), 0) AS te
      FROM costs WHERE agent_id = ?`).get(agentId) as Row;
    return n(r.p) > 0 ? { usd: n(r.pu), partlyEstimated: n(r.pe) > 0 } : { usd: n(r.tu), partlyEstimated: n(r.te) > 0 };
  }

  /** Records one cost row; the request's usedUsd / leadCostUsd are recounted (agent_result rows count for neither). */
  addCost(c: CostInput): void {
    this.tx(() => this.#insertCost(c));
  }

  /**
   * Sets an agent's session cost (its transcript and estimate rows): each SubagentStop re-reads the whole
   * transcript and a notification may bring an estimate, so earlier rows of the agent are taken back out of
   * their request's usedUsd and replaced (no double counting).
   */
  replaceAgentCosts(agentId: string, rows: CostInput[]): void {
    this.tx(() => {
      const old = this.db.prepare(`SELECT DISTINCT request_id AS r FROM costs WHERE agent_id = ? AND source IN ('transcript', 'estimate')`).all(agentId) as Row[];
      this.db.prepare(`DELETE FROM costs WHERE agent_id = ? AND source IN ('transcript', 'estimate')`).run(agentId);
      for (const r of rows) this.#insertCost({ ...r, agentId });
      for (const o of old) if (o.r !== null && o.r !== undefined) this.#recount(s(o.r));
    });
  }

  /**
   * actual: some of the cost is known from the transcript (an unpriced part may be estimated next to it,
   * audit #14); estimate: only a notification estimate; unknown: neither; none: nothing recorded.
   */
  agentCostState(agentId: string): AgentCostState {
    const rows = this.db.prepare(`SELECT source, usd FROM costs WHERE agent_id = ? AND source IN ('transcript', 'estimate')`).all(agentId) as Row[];
    if (this.db.prepare(`SELECT 1 AS x FROM costs WHERE agent_id = ? AND source = 'proxy' LIMIT 1`).get(agentId)) return 'actual';
    if (!rows.length) return 'none';
    if (rows.some(r => r.source === 'transcript' && r.usd !== null)) return 'actual';
    if (rows.some(r => r.source === 'estimate')) return 'estimate';
    return 'unknown';
  }

  /** Agents of the request whose cost could not be determined (neither transcript nor estimate). */
  unknownCostAgents(requestId: string): string[] {
    return (this.db.prepare(`SELECT DISTINCT agent_id AS a FROM costs WHERE request_id = ? AND source = 'transcript' AND usd IS NULL`)
      .all(requestId) as Row[]).map(r => s(r.a));
  }

  /** Whether the request's usedUsd contains estimates, or leaves some subagent costs out (unknown). */
  costFlags(requestId: string): { estimated: boolean; unknown: boolean } {
    if (this.hasProxyCosts(requestId)) {
      const e = this.db.prepare(`SELECT 1 AS x FROM costs WHERE request_id = ? AND source = 'proxy' AND note LIKE 'estimated%' LIMIT 1`).get(requestId);
      return { estimated: !!e, unknown: false };
    }
    const r = this.db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN source = 'estimate' THEN 1 ELSE 0 END), 0) AS e,
        COALESCE(SUM(CASE WHEN source = 'transcript' AND usd IS NULL THEN 1 ELSE 0 END), 0) AS u
      FROM costs WHERE request_id = ?`).get(requestId) as Row;
    return { estimated: n(r.e) > 0, unknown: n(r.u) > 0 };
  }

  listCosts(requestId?: string): Array<Record<string, unknown>> {
    const rows = (requestId === undefined ? this.db.prepare('SELECT * FROM costs ORDER BY id').all()
      : this.db.prepare('SELECT * FROM costs WHERE request_id = ? ORDER BY id').all(requestId)) as Row[];
    return rows.map(r => ({ ...r }));
  }

  sessionCostUsd(sessionId: string): number {
    const r = this.db.prepare('SELECT COALESCE(SUM(used_usd + lead_cost_usd), 0) AS c FROM requests WHERE session_id = ?')
      .get(sessionId) as Row;
    return n(r.c);
  }

  count(table: 'requests' | 'subtasks' | 'agents' | 'events' | 'signals' | 'costs' | 'pending_levels' | 'confirmations'): number {
    return n((this.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as Row).c);
  }
}
