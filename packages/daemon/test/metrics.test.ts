import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Level } from '@agentic-router/core';
import { Ledger } from '../src/ledger.ts';
import { metricsSummary, metricsRequests, metricsRequestDetail, metricsTriageReport } from '../src/metrics.ts';

interface SeedOpts {
  id: string;
  closedAt: string;
  level?: Level;
  finalLevel?: Level;
  rule?: string;
  outcome?: string;
  subtasks?: Array<{ status: string; upCount?: number; verdict?: string | null }>;
  replannedFrom?: Level | null;
  totalUsd?: number;
  leadUsd?: number | null;
  subtaskUsd?: number;
  estimated?: boolean;
  unknown?: boolean;
  budgetExceeded?: boolean;
  prompt?: string | null;
  rationale?: string;
  leadClass?: string;
  holdout?: string;
  acceptance?: string;
}

function seed(l: Ledger, o: SeedOpts): void {
  const level = o.level ?? 'L2';
  const subs = (o.subtasks ?? []).map((x, i) => ({
    id: `S${i}`, role: 'coder', slot: i, step: 's1', upCount: x.upCount ?? 0, status: x.status, verdict: x.verdict ?? null, attempts: 1, costUsd: 0,
  }));
  const record = {
    version: 1,
    triage: { kind: 'team', level, confidence: 0.7, source: 'rule', rule: o.rule ?? 'r.files', rationale: o.rationale ?? 'ok' },
    plan: { level, preset: level, leadDirect: false, replannedFrom: o.replannedFrom ?? null, manualLevel: null, leadClass: o.leadClass ?? 'opus', forcedFrom: null, holdout: o.holdout ?? null },
    outcome: o.outcome ?? 'delegated',
    subtasks: subs,
    verifyFailures: 0,
    costs: { subtaskUsd: o.subtaskUsd ?? 0, leadUsd: o.leadUsd ?? 0, totalUsd: o.totalUsd ?? 0, estimated: !!o.estimated, unknown: !!o.unknown, budgetExceeded: !!o.budgetExceeded },
  };
  l.upsertRecord({
    requestId: o.id, sessionId: 'sess', createdAt: o.closedAt, closedAt: o.closedAt, kind: 'team',
    level, finalLevel: o.finalLevel ?? level, outcome: o.outcome ?? 'delegated',
    changedFiles: 1, linesAdded: 1, linesRemoved: 0, durationMs: 1000, activeMs: 900,
    subtaskUsd: o.subtaskUsd ?? 0, leadUsd: o.leadUsd ?? null, totalUsd: o.totalUsd ?? 0, record, prompt: o.prompt ?? null,
  });
  if (o.acceptance) l.db.prepare('UPDATE request_records SET acceptance = ? WHERE request_id = ?').run(o.acceptance, o.id);
}

const iso = (d: number) => new Date(Date.UTC(2026, 10, d, 10, 0, 0)).toISOString();

test('metricsSummary: counts, success proxy, rates, cost totals, by-level', () => {
  const l = new Ledger(':memory:');
  seed(l, { id: 'a', closedAt: iso(10), level: 'L2', totalUsd: 1, subtaskUsd: 0.2, leadUsd: 0.8, subtasks: [{ status: 'passed' }] });
  seed(l, { id: 'b', closedAt: iso(11), level: 'L2', totalUsd: 2, subtaskUsd: 0.5, leadUsd: 1.5, subtasks: [{ status: 'passed', upCount: 1 }] });
  seed(l, { id: 'c', closedAt: iso(12), level: 'L1', totalUsd: 3, subtaskUsd: 1, leadUsd: 2, subtasks: [{ status: 'failed' }], estimated: true });
  const m = metricsSummary(l);
  assert.equal(m.total, 3);
  assert.equal(m.successful, 2);               // a, b passed; c failed
  assert.equal(m.successRate, 2 / 3);
  assert.equal(m.upRate, 1 / 3);               // only b stepped up
  assert.equal(m.teamFitRate, 2 / 3);          // b stepped up -> not team-fit
  assert.equal(m.cost.totalUsd, 6);
  assert.equal(m.cost.leadUsd, 4.3);
  assert.equal(m.costPerAcceptedTaskUsd, 3);   // decision 137: (1 + 2 + 3) / 2, the failed request's cost is carried by the accepted ones
  assert.equal(m.flags.estimated, 1);
  assert.equal(m.baseline, null);
  const l2 = m.byLevel.find(x => x.level === 'L2')!;
  assert.equal(l2.count, 2);
  assert.equal(l2.successRate, 1);
  l.close();
});

test('metricsSummary: cache-hit rate from cost rows of windowed requests', () => {
  const l = new Ledger(':memory:');
  seed(l, { id: 'c1', closedAt: iso(10), subtasks: [{ status: 'passed' }] });
  l.addCost({ requestId: 'c1', subtaskId: null, agentId: null, source: 'transcript', modelId: 'm', inputTokens: 100, outputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 300, usd: 0.01, createdAt: iso(10) });
  const m = metricsSummary(l);
  assert.equal(m.cacheHitRate, 0.75);          // 300 / (100 + 300)
  l.close();
});

test('metricsSummary: window filters by closed_at', () => {
  const l = new Ledger(':memory:');
  seed(l, { id: 'old', closedAt: iso(1), subtasks: [{ status: 'passed' }] });
  seed(l, { id: 'new', closedAt: iso(20), subtasks: [{ status: 'passed' }] });
  assert.equal(metricsSummary(l, { since: iso(10) }).total, 1);
  assert.equal(metricsSummary(l, { until: iso(10) }).total, 1);
  assert.equal(metricsSummary(l).total, 2);
  l.close();
});

test('metricsRequests: keyset pagination, newest first, stable nextCursor', () => {
  const l = new Ledger(':memory:');
  for (let d = 1; d <= 5; d++) seed(l, { id: `r${d}`, closedAt: iso(d), subtasks: [{ status: 'passed' }] });
  const p1 = metricsRequests(l, { limit: 2 });
  assert.deepEqual(p1.rows.map(r => r.requestId), ['r5', 'r4']);
  assert.ok(p1.nextCursor);
  const p2 = metricsRequests(l, { limit: 2, before: p1.nextCursor });
  assert.deepEqual(p2.rows.map(r => r.requestId), ['r3', 'r2']);
  const p3 = metricsRequests(l, { limit: 2, before: p2.nextCursor });
  assert.deepEqual(p3.rows.map(r => r.requestId), ['r1']);
  assert.equal(p3.nextCursor, null);
  l.close();
});

test('metricsRequests: level filter and row shape (success proxy, flags)', () => {
  const l = new Ledger(':memory:');
  seed(l, { id: 'x', closedAt: iso(10), level: 'L3', finalLevel: 'L3', subtasks: [{ status: 'passed' }], budgetExceeded: true });
  seed(l, { id: 'y', closedAt: iso(11), level: 'L1', subtasks: [{ status: 'failed' }] });
  const only3 = metricsRequests(l, { level: 'L3' });
  assert.deepEqual(only3.rows.map(r => r.requestId), ['x']);
  assert.equal(only3.rows[0]!.success, true);
  assert.equal(only3.rows[0]!.budgetExceeded, true);
  assert.equal(metricsRequests(l, { level: 'L1' }).rows[0]!.success, false);
  l.close();
});

test('metricsRequests exposes holdout + acceptance; not_accepted fails even when verify passed (decisions 137/138)', () => {
  const l = new Ledger(':memory:');
  seed(l, { id: 'h1', closedAt: iso(10), subtasks: [{ status: 'passed' }], holdout: 'direct', acceptance: 'accepted' });
  seed(l, { id: 'h2', closedAt: iso(11), subtasks: [{ status: 'passed' }], acceptance: 'not_accepted' });
  const rows = metricsRequests(l).rows;
  const h1 = rows.find(r => r.requestId === 'h1')!;
  assert.equal(h1.holdout, 'direct');
  assert.equal(h1.acceptance, 'accepted');
  assert.equal(h1.success, true);
  const h2 = rows.find(r => r.requestId === 'h2')!;
  assert.equal(h2.acceptance, 'not_accepted');
  assert.equal(h2.success, false, 'verify passed but the user rejected it');
  l.close();
});

test('metricsRequestDetail: returns record + signals, masks secrets, honors prompt opt-in', () => {
  const l = new Ledger(':memory:');
  seed(l, { id: 'd1', closedAt: iso(10), rationale: 'authorization: Bearer abcdefghijklmnop', subtasks: [{ status: 'passed' }] });
  l.insertSignals({ requestId: 'd1', subtaskId: 'S0', agentId: null, attempt: 1, at: iso(10) },
    [{ kind: 'test', ok: false, detail: 'leaked sk-ant-abcdefgh12345678 in output' }]);
  const d = metricsRequestDetail(l, 'd1')!;
  assert.ok(d);
  assert.equal(d.prompt, null);                                     // recordPrompts off -> no prompt
  assert.equal(d.signals.length, 1);
  assert.match(d.signals[0]!.detail!, /\[REDACTED\]/);
  assert.ok(!d.signals[0]!.detail!.includes('sk-ant-abcdefgh12345678'));
  const triage = d.record.triage as { rationale?: string };
  assert.match(String(triage.rationale), /\[REDACTED\]/);           // free-text rationale masked
  assert.equal(metricsRequestDetail(l, 'missing'), null);
  l.close();
});

test('metricsRequestDetail: returns a redacted prompt when recordPrompts stored one', () => {
  const l = new Ledger(':memory:');
  seed(l, { id: 'p1', closedAt: iso(10), prompt: 'fix login, key sk-ant-zzzzzzzz99999999', subtasks: [{ status: 'passed' }] });
  const d = metricsRequestDetail(l, 'p1')!;
  assert.ok(d.prompt && d.prompt.includes('[REDACTED]'));
  assert.ok(!d.prompt.includes('sk-ant-zzzzzzzz99999999'));
  l.close();
});

test('metricsTriageReport: triage-vs-actual + rule suggestions (never auto-applied)', () => {
  const l = new Ledger(':memory:');
  // rule r.files reinforced 3x (re-planned up) -> suggestLevelUp; r.simple held -> no suggestion
  for (let d = 1; d <= 3; d++) seed(l, { id: `g${d}`, closedAt: iso(d), level: 'L1', finalLevel: 'L2', rule: 'r.files', replannedFrom: 'L1', subtasks: [{ status: 'passed', upCount: 1 }] });
  seed(l, { id: 'h', closedAt: iso(5), level: 'L2', finalLevel: 'L2', rule: 'r.simple', subtasks: [{ status: 'passed' }] });
  const rep = metricsTriageReport(l);
  assert.equal(rep.overall.total, 4);
  const files = rep.byRule.find(r => r.rule === 'r.files')!;
  assert.equal(files.count, 3);
  assert.equal(files.reinforced, 3);
  assert.equal(files.suggestLevelUp, true);
  assert.equal(files.suggestStepUp, true);
  const simple = rep.byRule.find(r => r.rule === 'r.simple')!;
  assert.equal(simple.suggestLevelUp, false);
  assert.ok(rep.byLevel.some(x => x.planned === 'L1' && x.final === 'L2' && x.count === 3));
  l.close();
});
