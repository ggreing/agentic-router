// Sample data so the SPA runs and builds without a daemon (VITE_USE_MOCK defaults on). The shapes match
// src/types.ts exactly; swapping VITE_USE_MOCK=false points the same screens at the live metrics API.
import type { MetricsSummary, RequestsPage, RequestDetail, TriageReport, NowView, Cursor, TimelineRow, Level } from './types';

const LEVELS: Level[] = ['L0', 'L1', 'L2', 'L3'];

function rows(): TimelineRow[] {
  const out: TimelineRow[] = [];
  for (let i = 0; i < 24; i++) {
    const level = LEVELS[i % 4]!;
    const closedAt = new Date(Date.UTC(2026, 10, 1 + i, 9, 0, 0)).toISOString();
    out.push({
      requestId: `req-${String(100 - i).padStart(3, '0')}`,
      createdAt: closedAt, closedAt, kind: i % 3 === 0 ? 'uncertain' : 'team',
      level, finalLevel: i % 5 === 0 && level !== 'L3' ? LEVELS[LEVELS.indexOf(level) + 1]! : level,
      outcome: level === 'L0' ? 'direct' : 'delegated', leadClass: i % 2 ? 'opus' : 'sonnet',
      changedFiles: 1 + (i % 6), linesAdded: 10 + i, linesRemoved: i % 7,
      durationMs: 20000 + i * 1500, activeMs: 15000 + i * 1200,
      leadUsd: Number((0.08 + i * 0.002).toFixed(3)), subtaskUsd: Number((0.01 + (i % 5) * 0.003).toFixed(3)),
      totalUsd: Number((0.09 + i * 0.0025).toFixed(3)),
      success: i % 6 !== 0, subtasks: level === 'L0' ? 0 : 1 + (i % 3), verifyFailures: i % 6 === 0 ? 2 : 0,
      estimated: i % 4 === 0, unknown: i % 9 === 0, budgetExceeded: i % 11 === 0,
    });
  }
  return out;
}
const ALL = rows();

export function mockSummary(): MetricsSummary {
  const total = ALL.length;
  const ok = ALL.filter(r => r.success).length;
  const byLevel = LEVELS.map(level => {
    const rs = ALL.filter(r => r.level === level);
    return { level, count: rs.length, totalUsd: Number(rs.reduce((a, r) => a + r.totalUsd, 0).toFixed(3)), successRate: rs.length ? rs.filter(r => r.success).length / rs.length : null };
  });
  return {
    window: {}, total, successful: ok,
    successRate: ok / total, teamFitRate: 0.71, startStepFitRate: 0.79, upRate: 0.21,
    costPerAcceptedTaskUsd: 0.14,
    cost: { totalUsd: Number(ALL.reduce((a, r) => a + r.totalUsd, 0).toFixed(3)), leadUsd: Number(ALL.reduce((a, r) => a + (r.leadUsd ?? 0), 0).toFixed(3)), subtaskUsd: Number(ALL.reduce((a, r) => a + r.subtaskUsd, 0).toFixed(3)) },
    cacheHitRate: 0.62, flags: { estimated: 6, unknown: 3, budgetExceeded: 2 }, byLevel, baseline: null,
  };
}

export function mockRequests(opts: { limit?: number; before?: Cursor | null; level?: string } = {}): RequestsPage {
  let list = ALL.slice().sort((a, b) => (a.closedAt < b.closedAt ? 1 : a.closedAt > b.closedAt ? -1 : a.requestId < b.requestId ? 1 : -1));
  if (opts.level) list = list.filter(r => r.level === opts.level);
  if (opts.before) { const b = opts.before; list = list.filter(r => r.closedAt < b.closedAt || (r.closedAt === b.closedAt && r.requestId < b.requestId)); }
  const limit = Math.min(200, Math.max(1, opts.limit ?? 10));
  const page = list.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = list.length > limit && last ? { closedAt: last.closedAt, requestId: last.requestId } : null;
  return { rows: page, nextCursor };
}

export function mockDetail(requestId: string): RequestDetail {
  const row = ALL.find(r => r.requestId === requestId) ?? ALL[0]!;
  return {
    requestId: row.requestId,
    record: {
      triage: { kind: row.kind, level: row.level, confidence: 0.72, source: 'rule', rule: 'r.files', rationale: 'matched the files rule' },
      plan: { level: row.level, preset: row.level, leadDirect: row.level === 'L0', leadClass: row.leadClass, manualLevel: null, replannedFrom: row.level !== row.finalLevel ? row.level : null },
      outcome: row.outcome,
      subtasks: Array.from({ length: row.subtasks }, (_, i) => ({ id: String.fromCharCode(65 + i), role: ['architect', 'coder', 'reviewer'][i % 3], slot: i, step: 's1', upCount: i === 0 && !row.success ? 1 : 0, status: row.success ? 'passed' : 'failed', verdict: row.success ? 'meet' : 'miss', attempts: 1, costUsd: 0.01 })),
      verifyFailures: row.verifyFailures,
      lead: { calls: 3, model: 'claude-opus-4-8', usd: row.leadUsd },
      costs: { subtaskUsd: row.subtaskUsd, leadUsd: row.leadUsd, totalUsd: row.totalUsd, estimated: row.estimated, unknown: row.unknown, budgetExceeded: row.budgetExceeded },
    },
    signals: [
      { subtaskId: 'A', attempt: 1, kind: 'typecheck', ok: true },
      { subtaskId: 'A', attempt: 1, kind: 'test', ok: row.success, detail: row.success ? undefined : 'tests failed: 2' },
    ],
    prompt: null,
  };
}

export function mockTriage(): TriageReport {
  return {
    window: {}, overall: { total: ALL.length, levelHeld: 19, teamFit: 17, startStepFit: 19 },
    byRule: [
      { rule: 'r.files', count: 10, reinforced: 6, upStreaks: 4, suggestLevelUp: true, suggestStepUp: false },
      { rule: 'r.keywords', count: 8, reinforced: 1, upStreaks: 1, suggestLevelUp: false, suggestStepUp: false },
      { rule: '(none)', count: 6, reinforced: 2, upStreaks: 0, suggestLevelUp: false, suggestStepUp: false },
    ],
    byLevel: [{ planned: 'L2', final: 'L2', count: 9 }, { planned: 'L1', final: 'L2', count: 4 }, { planned: 'L1', final: 'L1', count: 6 }, { planned: 'L3', final: 'L3', count: 5 }],
  };
}

export function mockNow(): NowView {
  return {
    request: { id: 'req-100', level: 'L2', preset: 'L2', status: 'open', leadDirect: false, budgetUsd: 5, usedUsd: 0.21, leadCostUsd: 0.18, leadModel: 'claude-opus-4-8', leadClass: 'opus', outcome: null },
    roles: [
      { role: 'architect', slot: 0, step: 's3', model: 'sonnet', effort: 'medium', status: 'passed' },
      { role: 'coder', slot: 0, step: 's1', model: 'haiku', effort: 'low', status: 'running' },
      { role: 'coder', slot: 1, step: 's1', model: 'haiku', effort: 'low', status: 'idle' },
      { role: 'reviewer', slot: 0, step: 's3', model: 'sonnet', effort: 'medium', status: 'idle' },
    ],
    costUsd: 0.39, costEstimated: true, costUnknown: false, sessionCostUsd: 1.27,
  };
}
