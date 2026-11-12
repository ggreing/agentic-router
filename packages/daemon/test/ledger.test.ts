import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_PRESETS, triage } from '@agentic-router/core';
import { Ledger, SCHEMA_VERSION } from '../src/ledger.ts';
import { eventPayload } from '../src/payload.ts';
import { rmrf, tmpDir } from './helpers.ts';

function withLedger(fn: (l: Ledger) => void): void {
  const dir = tmpDir('ledger');
  const l = new Ledger(path.join(dir, 'router.db'));
  try { fn(l); } finally { l.close(); rmrf(dir); }
}

const AT = '2026-11-10T00:00:00.000Z';

test('ledger opens in WAL mode with the six Phase 1 tables plus pending_levels and clients', () => withLedger(l => {
  assert.equal(l.journalMode(), 'wal');
  const tables = (l.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>).map(r => r.name);
  assert.deepEqual(tables, ['agents', 'clients', 'confirmations', 'costs', 'events', 'pending_levels', 'proxy_rows', 'release_state', 'request_records', 'requests', 'session_limits', 'sessions', 'signals', 'slots', 'subtasks']);
}));

test('requests and subtasks round-trip in RequestRecord / SubtaskRecord shape', () => withLedger(l => {
  const t = triage({ prompt: 'fix the typo in README.md' });
  const r = l.createRequest({ id: 'r1', sessionId: 's1', createdAt: AT, promptId: 'p1', triage: t, team: DEFAULT_PRESETS[t.level] });
  assert.equal(r.id, 'r1');
  assert.equal(r.sessionId, 's1');
  assert.deepEqual(r.triage, t);
  assert.equal(r.usedUsd, 0);
  assert.equal(r.leadCostUsd, 0);
  assert.equal(r.status, 'open');

  const sub = l.dispatchSubtask({ requestId: 'r1', id: 'A', role: 'coder', slot: 0, step: 's1', writeScope: ['src/**'], unscoped: false, agentType: 'agentic-router:coder', toolUseId: 'tu1', at: AT });
  assert.deepEqual(
    { id: sub.id, requestId: sub.requestId, role: sub.role, slot: sub.slot, step: sub.step, writeScope: sub.writeScope, attempts: sub.attempts, upCount: sub.upCount, status: sub.status },
    { id: 'A', requestId: 'r1', role: 'coder', slot: 0, step: 's1', writeScope: ['src/**'], attempts: 1, upCount: 0, status: 'pending' },
  );
  assert.equal(sub.agentId, undefined);
  // re-dispatching the same tag counts an attempt and resets the binding
  l.updateSubtask('r1', 'A', { agentId: 'ag1', status: 'running' }, AT);
  const again = l.dispatchSubtask({ requestId: 'r1', id: 'A', role: 'coder', slot: 0, step: 's1', writeScope: ['src/**'], unscoped: false, agentType: 'agentic-router:coder', toolUseId: 'tu2', at: AT });
  assert.equal(again.attempts, 2);
  assert.equal(again.agentId, undefined);
  assert.equal(again.status, 'pending');
}));

test('pending subtasks pair with agents in dispatch order, per agent type', () => withLedger(l => {
  const t = triage({ prompt: 'x' });
  l.createRequest({ id: 'r1', sessionId: 's1', createdAt: AT, promptId: null, triage: t, team: DEFAULT_PRESETS.L1 });
  const d = (id: string, agentType: string) => l.dispatchSubtask({ requestId: 'r1', id, role: 'coder', slot: 0, step: 's1', writeScope: ['**'], unscoped: true, agentType, toolUseId: null, at: AT });
  d('A', 'agentic-router:coder');
  d('R', 'agentic-router:reviewer');
  d('B', 'agentic-router:coder');
  assert.equal(l.nextPendingSubtask('s1', 'agentic-router:coder')?.id, 'A');
  l.updateSubtask('r1', 'A', { agentId: 'ag1', status: 'running' }, AT);
  assert.equal(l.nextPendingSubtask('s1', 'agentic-router:coder')?.id, 'B');
  assert.equal(l.nextPendingSubtask('s1', 'agentic-router:reviewer')?.id, 'R');
  assert.equal(l.nextPendingSubtask('other-session', 'agentic-router:coder'), undefined);
}));

test('costs: transcript rows count toward usedUsd, agent_result rows are kept for cross-checking only', () => withLedger(l => {
  l.createRequest({ id: 'r1', sessionId: 's1', createdAt: AT, promptId: null, triage: triage({ prompt: 'x' }), team: DEFAULT_PRESETS.L1 });
  const c = { requestId: 'r1', subtaskId: 'A', agentId: 'ag', source: 'transcript' as const, modelId: 'claude-haiku-5-5', inputTokens: 1, outputTokens: 2, cacheWriteTokens: 3, cacheReadTokens: 4, createdAt: AT };
  l.addCost({ ...c, usd: 0.25 });
  l.addCost({ ...c, usd: 0.5 });
  l.addCost({ ...c, source: 'agent_result', usd: 9 });
  assert.equal(l.getRequest('r1')!.usedUsd, 0.75);
  assert.equal(l.count('costs'), 3);
  assert.equal(l.sessionCostUsd('s1'), 0.75);
}));

test('replaceAgentCosts re-counts an agent (no double counting); estimates count, unknown (usd null) does not', () => withLedger(l => {
  l.createRequest({ id: 'r1', sessionId: 's1', createdAt: AT, promptId: null, triage: triage({ prompt: 'x' }), team: DEFAULT_PRESETS.L1 });
  const row = { requestId: 'r1', subtaskId: 'A', agentId: 'ag', source: 'transcript' as const, modelId: 'claude-haiku-5-5', inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, calls: 2, createdAt: AT };
  const used = () => l.getRequest('r1')!.usedUsd;
  assert.equal(l.agentCostState('ag'), 'none');
  l.replaceAgentCosts('ag', [{ ...row, usd: 0.1 }]);
  l.replaceAgentCosts('ag', [{ ...row, usd: 0.3 }]);          // the second stop sees the whole transcript again
  l.replaceAgentCosts('other', [{ ...row, agentId: 'other', usd: 0.05 }]);
  assert.ok(Math.abs(used() - 0.35) < 1e-9);
  assert.equal(l.count('costs'), 2);
  assert.equal(l.agentCostState('ag'), 'actual');
  assert.deepEqual(l.costFlags('r1'), { estimated: false, unknown: false });

  l.replaceAgentCosts('ag', [{ ...row, usd: null, note: 'unknown: transcript not found' }]);
  assert.ok(Math.abs(used() - 0.05) < 1e-9);
  assert.equal(l.agentCostState('ag'), 'unknown');
  assert.deepEqual(l.unknownCostAgents('r1'), ['ag']);
  assert.deepEqual(l.costFlags('r1'), { estimated: false, unknown: true });

  l.replaceAgentCosts('ag', [{ ...row, source: 'estimate', usd: 0.2, note: 'estimated from notification tokens: …' }]);
  assert.ok(Math.abs(used() - 0.25) < 1e-9);
  assert.equal(l.agentCostState('ag'), 'estimate');
  assert.deepEqual(l.costFlags('r1'), { estimated: true, unknown: false });

  l.replaceAgentCosts('ag', [{ ...row, usd: 0.12 }]);          // the transcript replaces the estimate
  assert.ok(Math.abs(used() - 0.17) < 1e-9);
  assert.equal(l.agentCostState('ag'), 'actual');
  assert.equal(l.count('costs'), 2);
}));

test('event payloads are masked and size-limited', () => {
  const secret = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const p = eventPayload({ prompt: `use ${secret}`, header: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345', big: 'x'.repeat(50_000), list: Array.from({ length: 200 }, (_, i) => i) }, ['local-daemon-token-123']);
  assert.ok(!p.includes('ABCDEFGHIJKLMNOP'));
  assert.ok(!p.includes('abcdefghijklmnopqrstuvwxyz012345'));
  assert.ok(p.length < 20_000);
  assert.match(p, /chars omitted/);
  assert.match(p, /items omitted/);
  assert.ok(!eventPayload({ t: 'local-daemon-token-123' }, ['local-daemon-token-123']).includes('local-daemon-token-123'));
});

test('a v1 ledger is migrated to the current schema (override_from, pending_levels) without losing rows', () => {
  const dir = tmpDir('ledger-v1');
  const file = path.join(dir, 'router.db');
  try {
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE requests (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, created_at TEXT NOT NULL, prompt_id TEXT, "
      + "level TEXT NOT NULL, preset TEXT NOT NULL, budget_usd REAL NOT NULL, triage TEXT NOT NULL, team TEXT NOT NULL, "
      + "lead_cost_usd REAL NOT NULL DEFAULT 0, used_usd REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open', closed_at TEXT, "
      + "turns INTEGER NOT NULL DEFAULT 1); PRAGMA user_version = 1;");
    const t = triage({ prompt: 'x' });
    old.prepare('INSERT INTO requests (id, session_id, created_at, level, preset, budget_usd, triage, team) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('r1', 's1', AT, t.level, t.preset, t.budgetUsd, JSON.stringify(t), JSON.stringify(DEFAULT_PRESETS.L1));
    old.close();
    const l = new Ledger(file);
    try {
      assert.equal(Number((l.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version), SCHEMA_VERSION);
      assert.equal(l.count('pending_levels'), 0);
      assert.equal(l.getRequest('r1')!.overriddenTriage, null);
      const manual = { ...t, level: 'L3' as const, source: 'manual' as const, confidence: 1, preset: 'L3', budgetUsd: 15 };
      const re = l.replanRequest('r1', manual, DEFAULT_PRESETS.L3);
      assert.deepEqual([re.level, re.preset, re.budgetUsd, re.triage.source, re.team.id], ['L3', 'L3', 15, 'manual', 'L3']);
      assert.deepEqual(re.overriddenTriage, t);
      // a second override keeps the first (rule) triage as the original
      const again = l.replanRequest('r1', { ...manual, level: 'L2', preset: 'L2', budgetUsd: 5 }, DEFAULT_PRESETS.L2);
      assert.deepEqual(again.overriddenTriage, t);
    } finally { l.close(); }
  } finally { rmrf(dir); }
});

test('one pending level per session: replaced by a newer one, cleared when used', () => withLedger(l => {
  l.setPendingLevel('s1', 'L2', AT);
  l.setPendingLevel('s1', 'L3', AT);
  l.setPendingLevel('s2', 'L0', AT);
  assert.equal(l.getPendingLevel('s1'), 'L3');
  assert.equal(l.count('pending_levels'), 2);
  l.clearPendingLevel('s1');
  assert.equal(l.getPendingLevel('s1'), undefined);
  assert.equal(l.getPendingLevel('s2'), 'L0');
}));
