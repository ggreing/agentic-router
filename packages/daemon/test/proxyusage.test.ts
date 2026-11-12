// Decision 130, daemon side of the API-key mode proxy: usage rows in, request budget out; proxy rows as
// the cost source with the transcripts as the cross-check. Loopback only, temp homes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { UsageRow } from '@agentic-router/core';
import { Ledger } from '../src/ledger.ts';
import type { Logger } from '../src/log.ts';
import { CROSS_CHECK_TOLERANCE, MAX_ROWS_PER_POST, crossCheck, validRow } from '../src/proxyusage.ts';
import { TOKEN, makeRepo, postHook, request, rmrf, rows, startTestDaemon, tmpDir, type HookInput, type TestDaemon } from './helpers.ts';

const L0_PROMPT = 'fix the typo in README.md';
const L2_PROMPT = 'Refactor the validation module across multiple files and add an audit log';
type Rec = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any

function logger(): { log: Logger; warns: Array<{ msg: string; data?: Record<string, unknown> }> } {
  const warns: Array<{ msg: string; data?: Record<string, unknown> }> = [];
  return { warns, log: { info() {}, error() {}, warn: (msg, data) => { warns.push({ msg, ...(data ? { data } : {}) }); } } };
}

let n = 0;
function row(o: Partial<UsageRow> & { usd?: number } = {}): UsageRow {
  n++;
  return {
    id: `row-${n}`, messageId: `msg_${n}`, upstreamRequestId: `req_${n}`, sessionId: 's1', agentId: null, parentAgentId: null, promptId: null,
    requestClass: null, agentType: null, path: '/v1/messages', model: 'claude-sonnet-5-5',
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    usd: 0.01, priced: true, state: 'complete', httpStatus: 200, tokenId: 'tok-a',
    startedAt: '2026-11-12T10:00:01.000Z', endedAt: '2026-11-12T10:00:02.000Z', ...o,
  };
}

async function withDaemon(fn: (d: TestDaemon, warns: Array<{ msg: string; data?: Record<string, unknown> }>) => Promise<void>): Promise<void> {
  const t = Date.parse('2026-11-12T10:00:00.000Z');
  const { log, warns } = logger();
  const d = await startTestDaemon({ now: () => new Date(t), logger: log });
  try { await fn(d, warns); } finally { await d.close(); rmrf(d.home); }
}
const usage = (d: TestDaemon, body: unknown, token = TOKEN) => request(d.port, {
  method: 'POST', path: '/router/v1/usage', body: JSON.stringify(body), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
});
const budget = (d: TestDaemon, q: string) => request(d.port, { path: `/router/v1/budget${q}`, headers: { authorization: `Bearer ${TOKEN}` } });
const session = (d: TestDaemon, sid: string, cwd: string) => async (h: HookInput) => {
  const r = await postHook(d.port, { session_id: sid, cwd, transcript_path: path.join(d.home, `${sid}.jsonl`), ...h });
  assert.equal(r.status, 200, r.text);
  return r.body as Rec;
};

test('decision 130: POST /router/v1/usage stores each row once (row id, message id), counts malformed rows, needs the token', () => withDaemon(async d => {
  const a = row(), b = row();
  assert.equal((await usage(d, { rows: [a] }, 'wrong')).status, 401);
  assert.deepEqual((await usage(d, { rows: [a, b] })).body, { accepted: 2, duplicates: 0, rejected: 0 });
  // a spooled re-send, and the same message under a new row id
  assert.deepEqual((await usage(d, { rows: [a, { ...row(), messageId: b.messageId }] })).body, { accepted: 0, duplicates: 2, rejected: 0 });
  const bad = [{ ...row(), usd: -1 }, { ...row(), state: 'odd' }, { ...row(), id: 'has space' }, { ...row(), usage: {} }, 'x', null];
  assert.deepEqual((await usage(d, { rows: bad })).body, { accepted: 0, duplicates: 0, rejected: 6 });
  assert.equal((await usage(d, { rows: Array.from({ length: MAX_ROWS_PER_POST + 1 }, () => row()) })).status, 400);
  assert.equal((await usage(d, { nope: [] })).status, 400);
  assert.equal((await request(d.port, { method: 'GET', path: '/router/v1/usage', headers: { authorization: `Bearer ${TOKEN}` } })).status, 405);
  assert.equal(rows(d, 'SELECT COUNT(*) AS c FROM proxy_rows')[0]!.c, 2);
  // no request in session s1: stored, not attributed, no cost
  assert.deepEqual(rows(d, 'SELECT DISTINCT attributed_by, request_id FROM proxy_rows'), [{ attributed_by: 'none', request_id: null }]);
  assert.equal(rows(d, "SELECT COUNT(*) AS c FROM costs WHERE source = 'proxy'")[0]!.c, 0);
}));

test('decision 130: main-conversation rows are the lead\'s cost, by prompt id (opening prompt or a later one) or by time; the record says proxy', () => withDaemon(async d => {
  const post = session(d, 's1', d.home);
  await post({ hook_event_name: 'UserPromptSubmit', prompt: L0_PROMPT, prompt_id: 'p-1' });
  const req = String(rows(d, 'SELECT id FROM requests')[0]!.id);
  const byPrompt = row({ promptId: 'p-1', usd: 0.25 });
  const byTime = row({ usd: 0.5 });
  const error = row({ promptId: 'p-1', state: 'error', httpStatus: 529, usd: 0 });
  assert.deepEqual((await usage(d, { rows: [byPrompt, byTime, error] })).body, { accepted: 3, duplicates: 0, rejected: 0 });
  assert.deepEqual(rows(d, 'SELECT id, request_id, attributed_by FROM proxy_rows ORDER BY rowid'),
    [{ id: byPrompt.id, request_id: req, attributed_by: 'prompt' }, { id: byTime.id, request_id: req, attributed_by: 'time' }, { id: error.id, request_id: req, attributed_by: 'prompt' }]);
  assert.deepEqual(rows(d, "SELECT source, agent_id, usd FROM costs ORDER BY id"), [
    { source: 'proxy', agent_id: null, usd: 0.25 }, { source: 'proxy', agent_id: null, usd: 0.5 },   // the error row has no cost row
  ]);
  assert.deepEqual(rows(d, 'SELECT used_usd, lead_cost_usd FROM requests'), [{ used_usd: 0, lead_cost_usd: 0.75 }]);
  // the budget answer: subtask spending only (the lead's own calls are held by the daily caps)
  assert.deepEqual((await budget(d, '?session_id=s1&prompt_id=p-1')).body, { requestId: req, budgetUsd: rows(d, 'SELECT budget_usd FROM requests')[0]!.budget_usd, spentUsd: 0 });
  assert.equal((await budget(d, '?session_id=s1&prompt_id=p-9')).status, 404);
  assert.equal((await budget(d, '?session_id=s1')).status, 400);
  // the request closes; no main transcript here, yet the lead cost is known from the proxy
  await post({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.' });
  await d.router.drain();
  const rec = JSON.parse(String(rows(d, 'SELECT record FROM request_records')[0]!.record)) as Rec;
  assert.deepEqual([rec.costs.source, rec.costs.leadUsd, rec.costs.subtaskUsd, rec.costs.totalUsd], ['proxy', 0.75, 0, 0.75]);
  assert.equal(rec.costs.crossCheck, undefined);
}));

test('decision 130: a subagent\'s rows (agent id = hook agent id) are its subtask\'s cost; transcript rows stay as the cross-check', () => {
  const repo = makeRepo({ 'src/a.ts': 'a\n' });
  return withDaemon(async (d, warns) => {
    const post = session(d, 's1', repo);
    await post({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT, prompt_id: 'p-1' });
    assert.deepEqual(await post({
      hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_1',
      tool_input: { subagent_type: 'agentic-router:coder', prompt: '[subtask:A] work\n[scope: src/**]', model: 'haiku', effort: 'low' },
    }), {});
    await post({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'agentic-router:coder' });
    const req = String(rows(d, 'SELECT id FROM requests')[0]!.id);
    // a transcript cost first (subscription-style), then the proxy rows arrive
    d.ledger.replaceAgentCosts('a1', [{ requestId: req, subtaskId: 'A', agentId: 'a1', source: 'transcript', modelId: 'claude-haiku-5-5', calls: 2,
      inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, usd: 0.1, createdAt: '2026-11-12T10:00:03.000Z' }]);
    assert.deepEqual(rows(d, 'SELECT used_usd FROM requests'), [{ used_usd: 0.1 }]);
    const r1 = row({ agentId: 'a1', promptId: 'p-1', model: 'claude-haiku-5-5', usd: 0.06 });
    const r2 = row({ agentId: 'a1', promptId: 'p-1', model: 'claude-haiku-5-5', usd: 0.05 });
    assert.deepEqual((await usage(d, { rows: [r1, r2] })).body, { accepted: 2, duplicates: 0, rejected: 0 });
    assert.deepEqual(rows(d, 'SELECT DISTINCT request_id, subtask_id, attributed_by FROM proxy_rows'), [{ request_id: req, subtask_id: 'A', attributed_by: 'agent' }]);
    assert.deepEqual(rows(d, 'SELECT round(used_usd, 6) AS u, lead_cost_usd FROM requests'), [{ u: 0.11, lead_cost_usd: 0 }]);   // the proxy total, not 0.21
    // a later transcript re-read does not change the count while proxy rows exist
    d.ledger.replaceAgentCosts('a1', [{ requestId: req, subtaskId: 'A', agentId: 'a1', source: 'transcript', modelId: 'claude-haiku-5-5', calls: 2,
      inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, usd: 0.1, createdAt: '2026-11-12T10:00:04.000Z' }]);
    assert.deepEqual(rows(d, 'SELECT round(used_usd, 6) AS u FROM requests'), [{ u: 0.11 }]);
    assert.equal(d.ledger.agentCostState('a1'), 'actual');
    assert.deepEqual(d.ledger.agentCostUsd('a1'), { usd: 0.11, partlyEstimated: false });
    assert.equal(((await budget(d, '?session_id=s1&prompt_id=p-1')).body as Rec).spentUsd, 0.11);
    // a task notification is a later prompt of the same request: its id finds the request too
    await post({ hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>', prompt_id: 'p-2' });
    assert.equal(((await budget(d, '?session_id=s1&prompt_id=p-2')).body as Rec).requestId, req);
    // closing: the proxy and the transcript differ by more than 2% for a1 -> logged, and in the record
    const checks = crossCheck(d.ledger, { info() {}, error() {}, warn: (msg, data) => warns.push({ msg, ...(data ? { data } : {}) }) }, req);
    assert.deepEqual(checks, [{ agentId: 'a1', proxyUsd: 0.11, transcriptUsd: 0.1, diff: 0.0909 }]);
    assert.ok(warns.some(w => /cross-check/.test(w.msg) && w.data?.agentId === 'a1'));
  }).finally(() => rmrf(repo));
});

test('decision 130: the cross-check logs only differences above 2%; unpriced proxy rows mark the cost estimated', () => {
  const dir = tmpDir('ar-proxy-ledger-');
  const l = new Ledger(path.join(dir, 'router.db'));
  try {
    const { log, warns } = (() => { const w: string[] = []; return { warns: w, log: { info() {}, error() {}, warn: (m: string) => { w.push(m); } } as Logger }; })();
    const req = l.createRequest({
      id: 'r1', sessionId: 's', createdAt: '2026-11-12T10:00:00.000Z', promptId: 'p',
      triage: { level: 'L1', confidence: 1, source: 'rules', taskType: 'other', preset: 'p', budgetUsd: 2, rationale: '' }, team: { leadDirect: false } as never,
    } as never);
    const cost = (o: object) => ({ requestId: req.id, subtaskId: null, agentId: null, modelId: 'm', calls: 1, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, createdAt: 't', ...o });
    l.addCost(cost({ source: 'lead', usd: 1.0 }) as never);
    l.addCost(cost({ source: 'proxy', usd: 1.015 }) as never);                          // 1.5% apart: fine
    l.addCost(cost({ source: 'transcript', agentId: 'x', usd: 0.5 }) as never);
    l.addCost(cost({ source: 'proxy', agentId: 'x', usd: 0.6, note: 'estimated: a model without a price, at the most expensive rates' }) as never);   // 16.7% apart
    const checks = crossCheck(l, log, req.id);
    assert.deepEqual(checks.map(c => [c.agentId, c.diff <= CROSS_CHECK_TOLERANCE]), [[null, true], ['x', false]]);
    assert.equal(warns.length, 1);
    assert.deepEqual(l.costFlags(req.id), { estimated: true, unknown: false });
    assert.deepEqual((({ usedUsd, leadCostUsd }) => [usedUsd, leadCostUsd])(l.getRequest(req.id)!), [0.6, 1.015]);
  } finally { l.close(); rmrf(dir); }
});

test('decision 130: the row check refuses rows whose cost fields are off; odd optional ids become null', () => {
  assert.ok(validRow(row()));
  for (const bad of [{ httpStatus: 2.5 }, { startedAt: 'yesterday' }, { path: 'x'.repeat(201) }, { tokenId: '' }, { priced: 'yes' }, { usd: Number.NaN }]) {
    assert.equal(validRow({ ...row(), ...bad }), undefined, JSON.stringify(bad));
  }
  assert.equal(validRow({ ...row(), usage: { ...row().usage, output: -1 } }), undefined);
  // an odd optional id loses its attribution, not its cost
  const odd = validRow({ ...row(), sessionId: 'a b', model: 'm'.repeat(200), agentId: 7 })!;
  assert.deepEqual([odd.sessionId, odd.model, odd.agentId, odd.usd], [null, null, null, 0.01]);
});
