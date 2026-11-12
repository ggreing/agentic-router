// Usage rows from the API-key mode proxy (decision 130): POST /router/v1/usage takes them, GET
// /router/v1/budget answers the proxy's request-budget question.
//
// Each row is one proxied exchange. It is stored once (by row id: the proxy re-sends spooled rows; and by
// message id: the same message seen twice), then attributed:
//   1. x-claude-code-agent-id   = a subagent the hooks saw (contract spike: equal ids) -> its request and subtask
//   2. x-claude-code-prompt-id  = a prompt of a request (the opening prompt, an answer or a task notification)
//   3. the session's request open when the exchange started
// and recorded as a cost row of source 'proxy' (an agent's row is subtask cost, a main-conversation row the
// lead's). Once a request has proxy rows they are its cost source: the transcript rows stay next to them as
// the cross-check (Ledger recount). Rows carry no body, prompt or credential.
import type { BudgetAnswer, UsageRow } from '@agentic-router/core';
import type { Ledger } from './ledger.ts';
import type { Logger } from './log.ts';

export const MAX_ROWS_PER_POST = 500;
/** Transcript and proxy totals further apart than this are logged (decision 130 cross-check). */
export const CROSS_CHECK_TOLERANCE = 0.02;

const STATES = new Set(['complete', 'partial', 'error']);
const ID = /^[\x21-\x7e]{1,128}$/;
const idOrNull = (v: unknown): v is string | null => v === null || (typeof v === 'string' && ID.test(v));
const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e10;
const iso = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));

const OPTIONAL_IDS = ['messageId', 'upstreamRequestId', 'sessionId', 'agentId', 'parentAgentId', 'promptId', 'requestClass', 'agentType', 'model'] as const;

/**
 * A row as the proxy sends it, checked field by field; undefined when a field the cost depends on is off.
 * An optional id that does not fit (from a header or the upstream answer) becomes null: the row's cost is
 * kept, only its attribution is weaker.
 */
export function validRow(v: unknown): UsageRow | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  const u = r.usage as Record<string, unknown> | undefined;
  const ok = typeof r.id === 'string' && ID.test(r.id)
    && typeof r.path === 'string' && r.path.length <= 200
    && !!u && typeof u === 'object' && ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h'].every(k => count(u[k]))
    && count(r.usd) && typeof r.priced === 'boolean' && typeof r.state === 'string' && STATES.has(r.state)
    && Number.isInteger(r.httpStatus) && typeof r.tokenId === 'string' && ID.test(r.tokenId) && iso(r.startedAt) && iso(r.endedAt);
  if (!ok) return undefined;
  const out = { ...r } as Record<string, unknown>;
  for (const k of OPTIONAL_IDS) if (!idOrNull(out[k])) out[k] = null;
  return out as unknown as UsageRow;
}

export interface Attribution { requestId: string | null; subtaskId: string | null; agentId: string | null; how: 'agent' | 'prompt' | 'time' | 'none' }

export interface CrossCheck { agentId: string | null; proxyUsd: number; transcriptUsd: number; diff: number }

export class ProxyUsage {
  readonly #ledger: Ledger;
  readonly #log: Logger;
  readonly #now: () => Date;

  constructor(ledger: Ledger, log: Logger, now: () => Date = () => new Date()) {
    this.#ledger = ledger;
    this.#log = log;
    this.#now = now;
  }

  attribute(row: UsageRow): Attribution {
    const agent = row.agentId ? this.#ledger.getAgent(row.agentId) : undefined;
    if (agent?.requestId && (!row.sessionId || agent.sessionId === row.sessionId)) {
      return { requestId: agent.requestId, subtaskId: agent.subtaskId, agentId: agent.agentId, how: 'agent' };
    }
    const agentId = row.agentId;   // a subagent the hooks have not seen (yet): still its cost, not the lead's
    if (row.sessionId && row.promptId) {
      const req = this.#ledger.requestOfPrompt(row.sessionId, row.promptId);
      if (req) return { requestId: req.id, subtaskId: null, agentId, how: 'prompt' };
    }
    if (row.sessionId) {
      const req = this.#ledger.requestOpenAt(row.sessionId, row.startedAt);
      if (req) return { requestId: req.id, subtaskId: null, agentId, how: 'time' };
    }
    return { requestId: null, subtaskId: null, agentId, how: 'none' };
  }

  /** POST /router/v1/usage body `{ rows }`. Duplicates and malformed rows are counted, not stored. */
  ingest(body: unknown): { accepted: number; duplicates: number; rejected: number } {
    const rows = (body as { rows?: unknown } | undefined)?.rows;
    if (!Array.isArray(rows) || rows.length > MAX_ROWS_PER_POST) throw new RangeError(`body must be { rows: [...] } with at most ${MAX_ROWS_PER_POST} rows`);
    const out = { accepted: 0, duplicates: 0, rejected: 0 };
    const at = this.#now().toISOString();
    for (const raw of rows) {
      const row = validRow(raw);
      if (!row) { out.rejected++; continue; }
      const a = this.attribute(row);
      if (this.#ledger.insertProxyRow(row, a, at)) out.accepted++;
      else out.duplicates++;
    }
    if (out.rejected) this.#log.warn('proxy usage rows rejected (malformed)', { rejected: out.rejected });
    return out;
  }

  /**
   * GET /router/v1/budget: the request a prompt belongs to, its budget and its subtask spending (the budget
   * covers delegated work, as everywhere else; the lead's own calls are held by the daily caps).
   */
  budget(sessionId: string, promptId: string): BudgetAnswer | undefined {
    const req = this.#ledger.requestOfPrompt(sessionId, promptId);
    return req ? { requestId: req.id, budgetUsd: req.budgetUsd, spentUsd: Math.round(req.usedUsd * 1e6) / 1e6 } : undefined;
  }
}

/**
 * The proxy's and the transcripts' totals for each agent of a request (and the lead, agentId null), where both
 * exist; run when the request closes. A difference above CROSS_CHECK_TOLERANCE is logged.
 */
export function crossCheck(ledger: Ledger, log: Logger, requestId: string): CrossCheck[] {
  const out: CrossCheck[] = [];
  for (const c of ledger.costPairs(requestId)) {
    if (!(c.proxyUsd > 0) || !(c.transcriptUsd > 0)) continue;
    const diff = Math.abs(c.proxyUsd - c.transcriptUsd) / Math.max(c.proxyUsd, c.transcriptUsd);
    const row = { agentId: c.agentId, proxyUsd: c.proxyUsd, transcriptUsd: c.transcriptUsd, diff: Math.round(diff * 1e4) / 1e4 };
    out.push(row);
    if (diff > CROSS_CHECK_TOLERANCE) log.warn('cost cross-check: proxy and transcript totals differ', { requestId, ...row });
  }
  return out;
}
