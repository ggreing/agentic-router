// Router MCP tools on the daemon side (decisions 127-129, 134): binding a call to its session by the
// PreToolUse ticket, and the five tools against the ledger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROUTER_TOOL_PREFIX } from '@agentic-router/core';
import { AWAITING_USER_MARKER } from '../src/continuation.ts';
import { MAX_TICKETS, TICKET_TTL_MS, TOOL_USE_ID_META, TicketStore, addGlobs, removeGlobs, sortScopeGlobs, toolUseIdOf } from '../src/tools.ts';
import { TOKEN, makeRepo, postHook, request, rmrf, rows, startTestDaemon, write, type HookInput, type TestDaemon } from './helpers.ts';

const L1_PROMPT = 'Fix the bug where parse() fails on empty input in src/parse.ts';
const L2_PROMPT = 'Refactor the validation module across multiple files and add an audit log';
const L3_PROMPT = 'Build a new notification microservice with its own database schema and an event bus';

type Out = { decision?: string; hookSpecificOutput?: { additionalContext?: string; permissionDecision?: string; permissionDecisionReason?: string } };
type ToolOut = { ok: boolean; code?: string; message?: string; result?: Record<string, any> };

let seq = 0;
const AUTH = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

async function withDaemon(fn: (d: TestDaemon, repo: string) => Promise<void>, opts: Parameters<typeof startTestDaemon>[0] = {}): Promise<void> {
  const repo = makeRepo({ 'src/a.ts': 'a\n', 'README.md': 'x\n' });
  const d = await startTestDaemon({ verify: { resolveCommands: async () => [] }, ...opts });
  try { await fn(d, repo); } finally { await d.close(); rmrf(d.home); rmrf(repo); }
}

/** One Claude Code session against the daemon: hook events and router tool calls. */
function session(d: TestDaemon, sid: string, cwd: string) {
  const post = async (h: HookInput): Promise<Out> => {
    const r = await postHook(d.port, { session_id: sid, cwd, transcript_path: path.join(d.home, `${sid}.jsonl`), ...h });
    assert.equal(r.status, 200, r.text);
    return r.body as Out;
  };
  const raw = async (body: unknown): Promise<ToolOut> => {
    const r = await request(d.port, { method: 'POST', path: '/router/v1/tools/call', headers: AUTH, body: JSON.stringify(body) });
    assert.equal(r.status, 200, r.text);
    return r.body as ToolOut;
  };
  /** The hook, then the call with the same tool-use id, as Claude Code does. */
  const tool = async (name: string, input: Record<string, unknown> = {}): Promise<ToolOut> => {
    const id = `toolu_t${++seq}`;
    const pre = await post({ hook_event_name: 'PreToolUse', tool_name: ROUTER_TOOL_PREFIX + name, tool_use_id: id, tool_input: input });
    assert.equal(pre.hookSpecificOutput?.permissionDecision, 'allow');
    return raw({ tool: name, input, meta: { [TOOL_USE_ID_META]: id }, bind: { instanceId: 'i-1', projectDir: cwd } });
  };
  const call = (tag: string, role: string, model: string, effort: string, scope: string | null = 'src/**'): HookInput => ({
    hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: `toolu_a${++seq}`,
    tool_input: { subagent_type: `agentic-router:${role}`, prompt: `[subtask:${tag}] work${scope === null ? '' : `\n[scope: ${scope}]`}`, model, effort },
  });
  const start = (id: string, role = 'coder'): HookInput => ({ hook_event_name: 'SubagentStart', agent_id: id, agent_type: `agentic-router:${role}` });
  const stop = (id: string, role = 'coder'): HookInput => ({ hook_event_name: 'SubagentStop', agent_id: id, agent_type: `agentic-router:${role}`, stop_hook_active: false });
  /** Dispatches a subtask and lets it finish with a passing verify. */
  const pass = async (tag: string, agent: string, model = 'haiku', effort = 'low', role = 'coder'): Promise<void> => {
    assert.deepEqual(await post(call(tag, role, model, effort)), {}, `dispatch ${tag}`);
    await post(start(agent, role));
    assert.deepEqual(await post(stop(agent, role)), {});
  };
  /** The lead asks the user (marker at the end of its turn) and the user answers. */
  const userTurn = async (): Promise<void> => {
    await post({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: `May I? ${AWAITING_USER_MARKER}` });
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'yes, go ahead' });
  };
  return { post, raw, tool, call, start, stop, pass, userTurn };
}
const denied = (o: Out) => (o.hookSpecificOutput?.permissionDecision === 'deny' ? o.hookSpecificOutput.permissionDecisionReason ?? '' : '');
const slots = (d: TestDaemon) => rows(d, 'SELECT role, slot, step, up_count, fail_streak, lead_raises FROM slots ORDER BY role, slot');

// ------------------------------------------------------------------ binding

test('ticket store: exact, single use, short-lived, bounded', () => {
  const t = new TicketStore();
  t.add('toolu_1', 's1', 'router_get_plan', 1000);
  assert.equal(t.redeem('toolu_1', 'router_get_plan', 1500), 's1');
  assert.equal(t.redeem('toolu_1', 'router_get_plan', 1500), undefined, 'single use');
  t.add('toolu_2', 's1', 'router_get_plan', 1000);
  assert.equal(t.redeem('toolu_2', 'router_request_scope', 1500), undefined, 'another tool');
  assert.equal(t.redeem('toolu_2', 'router_get_plan', 1500), undefined, 'gone after a wrong use');
  t.add('toolu_3', 's1', 'router_get_plan', 1000);
  assert.equal(t.redeem('toolu_3', 'router_get_plan', 1000 + TICKET_TTL_MS + 1), undefined, 'expired');
  for (let i = 0; i < MAX_TICKETS + 20; i++) t.add(`x${i}`, 's', 'router_get_plan', 5000);
  assert.equal(t.size, MAX_TICKETS);
  assert.equal(t.redeem('x0', 'router_get_plan', 5000), undefined, 'the oldest were dropped');
  assert.equal(t.redeem(`x${MAX_TICKETS + 19}`, 'router_get_plan', 5000), 's');
  t.add('late', 's', 'router_get_plan', 5000 + TICKET_TTL_MS + 1);
  assert.equal(t.size, 1, 'expired tickets are dropped when a new one comes');
  assert.equal(toolUseIdOf({ [TOOL_USE_ID_META]: 'toolu_9', progressToken: 3 }), 'toolu_9');
  assert.equal(toolUseIdOf({ [TOOL_USE_ID_META]: 7 }), undefined);
  assert.equal(toolUseIdOf(undefined), undefined);
});

test('a tool call is bound to the session of its PreToolUse; a subagent call is denied (decision 134)', () => withDaemon(async (d, repo) => {
  const a = session(d, 'bind-a', repo);
  const b = session(d, 'bind-b', repo);
  await a.post({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT });
  await b.post({ hook_event_name: 'UserPromptSubmit', prompt: L1_PROMPT });
  // two sessions, the same tool and input: each call gets its own session's plan
  const [pa, pb] = [await a.tool('router_get_plan'), await b.tool('router_get_plan')];
  assert.equal(pa.result?.request.level, 'L2');
  assert.equal(pb.result?.request.level, 'L1');
  assert.equal(pa.result?.boundBy, 'ticket');

  // the hook allows the lead without a prompt, and denies inside a subagent
  const tool_name = `${ROUTER_TOOL_PREFIX}router_get_plan`;
  const sub = await a.post({ hook_event_name: 'PreToolUse', tool_name, tool_use_id: 'toolu_sub', tool_input: {}, agent_id: 'ag1', agent_type: 'general-purpose' });
  assert.match(denied(sub), /not_lead: router tools are for the lead only/);
  const meta = (id: string) => ({ [TOOL_USE_ID_META]: id });
  const bind = { instanceId: 'i-1', spawnSessionId: 'bind-a' };
  assert.equal((await a.raw({ tool: 'router_get_plan', input: {}, meta: meta('toolu_sub'), bind })).code, 'not_bound', 'no ticket for the subagent call');

  // a ticket is used once and only for its tool
  await a.post({ hook_event_name: 'PreToolUse', tool_name, tool_use_id: 'toolu_once', tool_input: {} });
  assert.equal((await a.raw({ tool: 'router_get_plan', input: {}, meta: meta('toolu_once'), bind })).ok, true);
  const again = await a.raw({ tool: 'router_get_plan', input: {}, meta: meta('toolu_once'), bind });
  assert.deepEqual([again.ok, again.code], [false, 'not_bound']);
  assert.match(again.message ?? '', /^\[agentic-router\] not_bound: /);
  await a.post({ hook_event_name: 'PreToolUse', tool_name, tool_use_id: 'toolu_other', tool_input: {} });
  assert.equal((await a.raw({ tool: 'router_report_triage', input: { kind: 'team', level: 'L2', files: 5, confidence: 0.8 }, meta: meta('toolu_other'), bind })).code, 'not_bound');

  // without a tool-use id only the read-only tool answers, for the session the server was started in, and says so
  const fallback = await a.raw({ tool: 'router_get_plan', input: {}, bind });
  assert.deepEqual([fallback.ok, fallback.result?.boundBy, fallback.result?.request.level], [true, 'spawn_session', 'L2']);
  assert.equal((await a.raw({ tool: 'router_report_triage', input: { kind: 'team', level: 'L2', files: 5, confidence: 0.8 }, bind })).code, 'not_bound');
  assert.equal((await a.raw({ tool: 'router_get_plan', input: {}, bind: { instanceId: 'i-1' } })).code, 'not_bound');

  // refusals that need no session
  assert.equal((await a.raw({ tool: 'router_nope', input: {}, bind })).code, 'unknown_tool');
  assert.equal((await a.raw({ tool: 'router_get_plan', input: {}, sessionId: 'bind-b', bind })).code, 'invalid_input', 'the server cannot name a session');
  const bad = await a.tool('router_report_triage', { kind: 'team', level: 'L2', files: 'many', confidence: 0.8, note: 'x' });
  assert.equal(bad.code, 'invalid_input');
  assert.match(bad.message ?? '', /files/);

  // the endpoint is behind the token like every other route
  const noAuth = await request(d.port, { method: 'POST', path: '/router/v1/tools/call', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noAuth.status, 401);
  assert.equal((await request(d.port, { path: '/router/v1/tools/call', headers: AUTH })).status, 405);

  // calls are recorded as events of the session; refused ones before binding are not
  const ev = rows(d, "SELECT session_id, tool_name, payload FROM events WHERE type = 'tool_call' ORDER BY id");
  assert.ok(ev.length >= 4);
  assert.ok(ev.every(e => e.session_id === 'bind-a' || e.session_id === 'bind-b'));
  assert.deepEqual(JSON.parse(String(ev[0]!.payload)).boundBy, 'ticket');
}));

test('router_get_plan: the request, each slot\'s next call values, the subtasks; nothing is opened', () => withDaemon(async (d, repo) => {
  const s = session(d, 'plan', repo);
  const empty = await s.tool('router_get_plan');
  assert.deepEqual(empty, { ok: true, result: { request: null, boundBy: 'ticket' } });
  assert.equal(d.ledger.count('requests'), 0);

  await s.post({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT });
  await s.pass('A', 'a1');
  assert.deepEqual(await s.post(s.call('B', 'coder', 'haiku', 'low', 'test/**')), {});
  const p = (await s.tool('router_get_plan')).result!;
  assert.equal(p.request.level, 'L2');
  assert.equal(p.request.leadDirect, false);
  assert.equal(p.request.status, 'open');
  assert.equal(p.requestId, p.request.id);
  const coder0 = p.roles.find((r: any) => r.role === 'coder' && r.slot === 0);
  assert.deepEqual([coder0.step, coder0.model, coder0.effort, coder0.upCount, coder0.upsLeft], ['s1', 'haiku', 'low', 0, 3]);
  assert.ok(p.roles.some((r: any) => r.role === 'reviewer'));
  assert.deepEqual(p.subtasks.map((x: any) => [x.id, x.status, x.verdict, x.scope]), [['A', 'passed', 'meet', ['src/**']], ['B', 'pending', null, ['test/**']]]);
  assert.deepEqual(p.pendingUser, []);
}));

// ------------------------------------------------------------------ router_report_triage

test('router_report_triage re-plans upward exactly as the first Agent call does, and only once', () => withDaemon(async (d, repo) => {
  // reference: the hook path (first Agent call of a lead-direct request)
  const ref = session(d, 'tri-ref', repo);
  await ref.post({ hook_event_name: 'UserPromptSubmit', prompt: L1_PROMPT });
  assert.deepEqual(await ref.post(ref.call('A', 'coder', 'haiku', 'low')), {});
  const refRow = rows(d, "SELECT level, preset, budget_usd, team FROM requests WHERE session_id = 'tri-ref'")[0]!;

  const s = session(d, 'tri', repo);
  await s.post({ hook_event_name: 'UserPromptSubmit', prompt: L1_PROMPT });
  assert.equal(rows(d, "SELECT level FROM requests WHERE session_id = 'tri'")[0]!.level, 'L1');
  const r = await s.tool('router_report_triage', { kind: 'team', level: 'L2', files: 6, confidence: 0.8 });
  assert.equal(r.ok, true);
  assert.deepEqual([r.result?.recorded, r.result?.replanned, r.result?.level, r.result?.leadDirect], [true, true, 'L2', false]);
  assert.match(r.result?.brief, /subagent_type "agentic-router:coder", model "haiku", effort "low"/);
  const row = rows(d, "SELECT level, preset, budget_usd, team, triage, replanned_from, lead_triage FROM requests WHERE session_id = 'tri'")[0]!;
  assert.deepEqual([row.level, row.preset, row.budget_usd, row.team], [refRow.level, refRow.preset, refRow.budget_usd, refRow.team]);
  assert.match(JSON.parse(String(row.triage)).rationale, /^re-planned at L2: the lead judged the request as L2 \(about 6 files, confidence 0\.80\) in a lead-direct L1 request/);
  assert.equal(JSON.parse(String(row.replanned_from)).level, 'L1');
  assert.deepEqual((({ kind, level, files, confidence, plannedLevel }) => ({ kind, level, files, confidence, plannedLevel }))(JSON.parse(String(row.lead_triage))),
    { kind: 'team', level: 'L2', files: 6, confidence: 0.8, plannedLevel: 'L1' });

  // the Agent call that follows is checked against the L2 team and does not re-plan again (an L3 value is refused, not taken as a signal)
  assert.match(denied(await s.post(s.call('A', 'coder', 'opus', 'high'))), /the coder runs at step s1/);
  assert.deepEqual(await s.post(s.call('A', 'coder', 'haiku', 'low')), {});
  assert.equal(rows(d, "SELECT level FROM requests WHERE session_id = 'tri'")[0]!.level, 'L2');
  // after a dispatch the judgement comes too late and changes nothing
  assert.equal((await s.tool('router_report_triage', { kind: 'team', level: 'L3', files: 30, confidence: 0.9 })).code, 'too_late');
  assert.equal(JSON.parse(String(rows(d, "SELECT lead_triage FROM requests WHERE session_id = 'tri'")[0]!.lead_triage)).level, 'L2');
}));

test('router_report_triage: L3 by the lead\'s word, a direct judgement only recorded, no request no record', () => withDaemon(async (d, repo) => {
  const none = session(d, 'tri-none', repo);
  assert.equal((await none.tool('router_report_triage', { kind: 'direct', level: 'L1', files: 1, confidence: 0.9 })).code, 'no_request');

  // lead-direct -> L3 (decision 113's choice, said outright)
  const a = session(d, 'tri-l3', repo);
  await a.post({ hook_event_name: 'UserPromptSubmit', prompt: L1_PROMPT });
  const up = await a.tool('router_report_triage', { kind: 'team', level: 'L3', files: 25, confidence: 0.7 });
  assert.deepEqual([up.result?.replanned, up.result?.level], [true, 'L3']);
  assert.deepEqual(await a.post(a.call('D', 'architect', 'opus', 'high', 'docs/**')), {});

  // an automatic L2 with L3 signs (decision 119) -> L3; one without them stays
  const b = session(d, 'tri-signs', repo);
  await b.post({ hook_event_name: 'UserPromptSubmit', prompt: L3_PROMPT });
  assert.deepEqual(rows(d, "SELECT level FROM requests WHERE session_id = 'tri-signs'"), [{ level: 'L2' }]);
  assert.deepEqual((r => [r.result?.replanned, r.result?.level])(await b.tool('router_report_triage', { kind: 'team', level: 'L3', files: 25, confidence: 0.7 })), [true, 'L3']);
  const c = session(d, 'tri-plain', repo);
  await c.post({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT });
  assert.deepEqual((r => [r.result?.recorded, r.result?.replanned, r.result?.level, r.result?.brief])(await c.tool('router_report_triage', { kind: 'team', level: 'L3', files: 25, confidence: 0.7 })), [true, false, 'L2', undefined]);

  // a smaller judgement never moves the plan down; it is kept as a label, with its level made to fit its kind
  const e = session(d, 'tri-down', repo);
  await e.post({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT });
  assert.deepEqual((r => [r.result?.replanned, r.result?.level])(await e.tool('router_report_triage', { kind: 'direct', level: 'L3', files: 1, confidence: 0.9 })), [false, 'L2']);
  assert.equal(JSON.parse(String(rows(d, "SELECT lead_triage FROM requests WHERE session_id = 'tri-down'")[0]!.lead_triage)).level, 'L1');
}));

// ------------------------------------------------------------------ router_report_result

test('router_report_result: a reject after a passing verify is a failure; two in a row raise the slot', () => withDaemon(async (d, repo) => {
  const s = session(d, 'rej', repo);
  await s.post({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT });
  assert.equal((await s.tool('router_report_result', { subtaskId: 'A', verdict: 'reject', by: 'lead' })).code, 'unknown_subtask');
  assert.deepEqual(await s.post(s.call('A', 'coder', 'haiku', 'low')), {});
  await s.post(s.start('a1'));
  assert.equal((await s.tool('router_report_result', { subtaskId: 'A', verdict: 'reject', by: 'lead' })).code, 'not_finished');
  write(repo, 'src/a.ts', 'wrong fix\n');
  assert.deepEqual(await s.post(s.stop('a1')), {});
  assert.deepEqual(rows(d, "SELECT status, verdict FROM subtasks WHERE id = 'A'"), [{ status: 'passed', verdict: 'meet' }]);

  const r1 = await s.tool('router_report_result', { subtaskId: 'A', verdict: 'reject', by: 'lead', issues: 1, categories: ['wrong_behavior'] });
  assert.deepEqual([r1.ok, r1.result?.status, r1.result?.raised, r1.result?.next, r1.result?.slot.step], [true, 'failed', false, 'retry_at_same_step', 's1']);
  assert.deepEqual(rows(d, "SELECT status, verdict FROM subtasks WHERE id = 'A'"), [{ status: 'failed', verdict: 'rejected' }]);
  assert.deepEqual(slots(d), [{ role: 'coder', slot: 0, step: 's1', up_count: 0, fail_streak: 1, lead_raises: 0 }]);
  assert.deepEqual(rows(d, "SELECT kind, ok, detail FROM signals WHERE kind = 'review'"), [{ kind: 'review', ok: 0, detail: 'reject by lead; issues 1; categories wrong_behavior' }]);
  // the same attempt judged again is not a second failure
  await s.tool('router_report_result', { subtaskId: 'A', verdict: 'reject', by: 'lead' });
  assert.equal(slots(d)[0]!.fail_streak, 1);

  // second attempt at the same step: verify passes again (it does not end the streak), the lead rejects again
  await s.pass('A', 'a2');
  assert.deepEqual(rows(d, "SELECT status, verdict, review FROM subtasks WHERE id = 'A'"), [{ status: 'passed', verdict: 'meet', review: null }]);
  const r2 = await s.tool('router_report_result', { subtaskId: 'A', verdict: 'reject', by: 'lead' });
  assert.deepEqual([r2.result?.raised, r2.result?.next, r2.result?.slot.step, r2.result?.slot.model, r2.result?.slot.effort, r2.result?.slot.upsLeft], [true, 'retry_at_raised_step', 's2', 'haiku', 'high', 2]);
  assert.deepEqual(slots(d), [{ role: 'coder', slot: 0, step: 's2', up_count: 1, fail_streak: 0, lead_raises: 0 }]);
  assert.deepEqual(rows(d, "SELECT status, verdict, up_count FROM subtasks WHERE id = 'A'"), [{ status: 'failed', verdict: 'rejected', up_count: 1 }]);
  // the next call for the slot must use the raised step, as after a verify miss
  assert.match(denied(await s.post(s.call('A', 'coder', 'haiku', 'low'))), /slot 0 was raised to s2 after a miss/);
  await s.pass('A', 'a3', 'haiku', 'high');

  // an accept is recorded and ends a streak
  d.ledger.setSlotCounters(rows(d, "SELECT id FROM requests WHERE session_id = 'rej'")[0]!.id as string, 'coder', 0, 's2', { failStreak: 1 }, new Date().toISOString());
  const ok = await s.tool('router_report_result', { subtaskId: 'A', verdict: 'accept', by: 'lead', margin: 'easy' });
  assert.deepEqual([ok.result?.status, ok.result?.next, ok.result?.raised], ['passed', 'none', false]);
  assert.equal(slots(d)[0]!.fail_streak, 0);
  assert.deepEqual(JSON.parse(String(rows(d, "SELECT review FROM subtasks WHERE id = 'A'")[0]!.review)).margin, 'easy');
}));

test('router_report_result: a reviewer verdict must come from a finished reviewer subtask', () => withDaemon(async (d, repo) => {
  const s = session(d, 'rev', repo);
  await s.post({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT });
  await s.pass('A', 'a1');
  await s.pass('B', 'b1');
  assert.equal((await s.tool('router_report_result', { subtaskId: 'A', verdict: 'reject', by: 'reviewer', bySubtaskId: 'R' })).code, 'unknown_subtask');
  assert.match((await s.tool('router_report_result', { subtaskId: 'A', verdict: 'reject', by: 'reviewer', bySubtaskId: 'B' })).message ?? '', /not_allowed: subtask B is a coder, not a reviewer/);
  assert.deepEqual(await s.post(s.call('R', 'reviewer', 'sonnet', 'medium', null)), {});
  await s.post(s.start('r1', 'reviewer'));
  assert.match((await s.tool('router_report_result', { subtaskId: 'A', verdict: 'reject', by: 'reviewer', bySubtaskId: 'R' })).message ?? '', /not_allowed: subtask R must be finished/);
  assert.deepEqual(await s.post(s.stop('r1', 'reviewer')), {});
  const r = await s.tool('router_report_result', { subtaskId: 'A', verdict: 'reject', by: 'reviewer', bySubtaskId: 'R' });
  assert.deepEqual([r.ok, r.result?.status, r.result?.by, r.result?.raised], [true, 'failed', 'reviewer', false]);
  assert.match(r.result?.escalation, /router_request_escalation/);
  assert.deepEqual(rows(d, "SELECT detail FROM signals WHERE kind = 'review'"), [{ detail: 'reject by reviewer (subtask R)' }]);
}));

// ------------------------------------------------------------------ router_request_escalation

test('router_request_escalation on the lead\'s word: once per slot inside a model, then a user turn (decision 128)', () => withDaemon(async (d, repo) => {
  const s = session(d, 'esc', repo);
  await s.post({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT });
  assert.deepEqual(await s.post(s.call('A', 'coder', 'haiku', 'low')), {});
  await s.post(s.start('a1'));
  assert.equal((await s.tool('router_request_escalation', { subtaskId: 'A', reason: 'wrong_result' })).code, 'not_finished');
  assert.deepEqual(await s.post(s.stop('a1')), {});

  // verify passed, the lead judges the result wrong: one raise inside the same model, without asking
  const g = await s.tool('router_request_escalation', { subtaskId: 'A', reason: 'wrong_result' });
  assert.deepEqual([g.ok, g.result?.granted, g.result?.how, g.result?.from, g.result?.step, g.result?.model, g.result?.effort, g.result?.upCount, g.result?.upsLeft],
    [true, true, 'lead_judgement', 's1', 's2', 'haiku', 'high', 1, 2]);
  assert.deepEqual(slots(d), [{ role: 'coder', slot: 0, step: 's2', up_count: 1, fail_streak: 0, lead_raises: 1 }]);
  assert.deepEqual(rows(d, "SELECT status, verdict FROM subtasks WHERE id = 'A'"), [{ status: 'failed', verdict: 'rejected' }], 'the request counts as the lead\'s reject');
  // asked again for the same attempt: nothing more happens
  assert.deepEqual((r => [r.result?.granted, r.result?.how, r.result?.step])(await s.tool('router_request_escalation', { subtaskId: 'A', reason: 'wrong_result' })), [true, 'already_raised', 's2']);
  assert.equal(slots(d)[0]!.up_count, 1);
  // the lead cannot call a step higher than the one granted
  assert.match(denied(await s.post(s.call('A', 'coder', 'sonnet', 'medium'))), /the coder runs at step s2/);

  // second attempt at s2 passes verify; the next step changes the model: not on the lead's word alone
  await s.pass('A', 'a2', 'haiku', 'high');
  const n = await s.tool('router_request_escalation', { subtaskId: 'A', reason: 'wrong_result' });
  assert.deepEqual([n.ok, n.code, n.result?.why, n.result?.step], [false, 'needs_user', 'tier', 's2']);
  assert.match(n.message ?? '', /needs_user: the next step \(s3\) changes the model/);
  assert.equal(slots(d)[0]!.step, 's2');
  assert.deepEqual((await s.tool('router_get_plan')).result?.pendingUser, [{ kind: 'escalation', subtaskId: 'A' }]);
  // saying the user confirmed is not enough: the ledger must show a user turn after the request
  const lie = await s.tool('router_request_escalation', { subtaskId: 'A', reason: 'wrong_result', userConfirmed: true });
  assert.equal(lie.code, 'needs_user');
  assert.match(lie.message ?? '', /No user turn was seen/);
  // a task notification is not a user turn
  await s.post({ hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>a2</task-id>\n<status>completed</status>\n</task-notification>' });
  assert.equal((await s.tool('router_request_escalation', { subtaskId: 'A', reason: 'wrong_result', userConfirmed: true })).code, 'needs_user');
  await s.userTurn();
  const u = await s.tool('router_request_escalation', { subtaskId: 'A', reason: 'wrong_result', userConfirmed: true });
  assert.deepEqual([u.ok, u.result?.how, u.result?.step, u.result?.model, u.result?.effort, u.result?.upsLeft], [true, 'user_turn', 's3', 'sonnet', 'medium', 1]);
  assert.deepEqual(slots(d), [{ role: 'coder', slot: 0, step: 's3', up_count: 2, fail_streak: 0, lead_raises: 1 }]);
  assert.equal(d.ledger.count('confirmations'), 0);
  assert.deepEqual(await s.post(s.call('A', 'coder', 'sonnet', 'medium')), {});
}));

test('router_request_escalation: a reviewer reject raises at once, also across a model; the 3-raise limit goes to the user', () => withDaemon(async (d, repo) => {
  const s = session(d, 'esc-rev', repo);
  await s.post({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT });
  const requestId = rows(d, "SELECT id FROM requests WHERE session_id = 'esc-rev'")[0]!.id as string;
  d.ledger.setSlot(requestId, 'coder', 0, 's2', 1, new Date().toISOString());   // the slot was raised once before
  await s.pass('A', 'a1', 'haiku', 'high');
  await s.pass('R', 'r1', 'sonnet', 'medium', 'reviewer');
  await s.tool('router_report_result', { subtaskId: 'A', verdict: 'reject', by: 'reviewer', bySubtaskId: 'R' });
  const g = await s.tool('router_request_escalation', { subtaskId: 'A', reason: 'review_reject' });
  assert.deepEqual([g.ok, g.result?.how, g.result?.from, g.result?.step, g.result?.model, g.result?.upCount], [true, 'review_reject', 's2', 's3', 'sonnet', 2]);
  assert.equal(slots(d).find(x => x.role === 'coder')!.lead_raises, 0);

  // one raise left: a second lead reject in a row uses it; after that every request goes to the user
  await s.pass('A', 'a2', 'sonnet', 'medium');
  await s.tool('router_report_result', { subtaskId: 'A', verdict: 'reject', by: 'lead' });
  await s.pass('A', 'a3', 'sonnet', 'medium');
  assert.deepEqual((r => [r.result?.raised, r.result?.slot.step, r.result?.slot.upsLeft])(await s.tool('router_report_result', { subtaskId: 'A', verdict: 'reject', by: 'lead' })), [true, 's4', 0]);
  await s.pass('A', 'a4', 'sonnet', 'high');
  await s.pass('R2', 'r2', 'sonnet', 'medium', 'reviewer');
  await s.tool('router_report_result', { subtaskId: 'A', verdict: 'reject', by: 'reviewer', bySubtaskId: 'R2' });
  const lim = await s.tool('router_request_escalation', { subtaskId: 'A', reason: 'review_reject' });
  assert.deepEqual([lim.ok, lim.code, lim.result?.why, lim.result?.step, lim.result?.upsLeft], [false, 'needs_user', 'limit', 's4', 0]);
  assert.match(lim.message ?? '', /no raise left \(3 step-ups or the top step\)\. Stop this subtask and ask the user/);
  assert.deepEqual(rows(d, "SELECT status, verdict FROM subtasks WHERE id = 'A'"), [{ status: 'hitl', verdict: 'rejected' }]);
  assert.equal(slots(d).find(x => x.role === 'coder')!.step, 's4');
  // a user turn does not lift the limit: the user chooses how to go on (spec 5.3)
  await s.userTurn();
  assert.equal((await s.tool('router_request_escalation', { subtaskId: 'A', reason: 'review_reject', userConfirmed: true })).result?.why, 'limit');
}));

// ------------------------------------------------------------------ router_request_scope

test('scope globs are sorted by what they name', () => {
  assert.deepEqual(sortScopeGlobs(['src/**', '.\\test\\**', '**', 'docs/.envoy.md']), { ordinary: ['src/**', 'test/**', '**'], protectedPaths: ['docs/.envoy.md'], never: [] });
  assert.deepEqual(sortScopeGlobs(['.env.example', 'app/.env', '.github/workflows/**', '.github/workflows/ci.yml', 'pkg/.npmrc', '.claude/**', '.gitlab-ci.yml']).ordinary, []);
  assert.deepEqual(sortScopeGlobs(['.git/**', 'sub/.git/hooks/**', '.agentic-router/**', '.agentic-router/policy.json', '.GIT/config']).never.length, 5);
  assert.deepEqual(sortScopeGlobs(['.github/ISSUE_TEMPLATE/**', '.gitignore', 'environment/**']).ordinary.length, 3);
  assert.deepEqual(addGlobs(['src/**'], ['./src/**', 'test\\**']), ['src/**', 'test/**']);
  assert.deepEqual(removeGlobs(['src/**', 'test/**'], ['./test/**', 'nope/**']), ['src/**']);
});

test('router_request_scope changes a running subtask\'s scope where the guard reads it', () => withDaemon(async (d, repo) => {
  const s = session(d, 'scope', repo);
  await s.post({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT });
  assert.equal((await s.tool('router_request_scope', { subtaskId: 'A', add: ['test/**'] })).code, 'unknown_subtask');
  assert.deepEqual(await s.post(s.call('A', 'coder', 'haiku', 'low')), {});
  const scopeFile = path.join(d.home, 'scopes', fs.readdirSync(path.join(d.home, 'scopes'))[0]!);
  const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

  // pending: the scope file follows
  const r = await s.tool('router_request_scope', { subtaskId: 'A', add: ['test/**', './src/**'] });
  assert.deepEqual([r.ok, r.result?.live, r.result?.scope, r.result?.protectedGranted], [true, true, ['src/**', 'test/**'], []]);
  assert.deepEqual(read(scopeFile).allowed, ['src/**', 'test/**']);
  assert.ok(!('protectedGranted' in read(scopeFile)));
  // running: the agent's own file follows too
  await s.post(s.start('a1'));
  const agentFile = path.join(d.home, 'agents', 'a1.json');
  assert.deepEqual(read(agentFile).scope.allowed, ['src/**', 'test/**']);
  await s.tool('router_request_scope', { subtaskId: 'A', add: ['docs/**'], remove: ['test/**'] });
  assert.deepEqual(read(agentFile).scope.allowed, ['src/**', 'docs/**']);
  assert.deepEqual(read(scopeFile).allowed, ['src/**', 'docs/**']);
  assert.deepEqual(rows(d, "SELECT write_scope FROM subtasks WHERE id = 'A'"), [{ write_scope: '["src/**","docs/**"]' }]);
  // the stop check uses the new scope: an edit under docs/ is inside it now
  write(repo, 'docs/x.md', 'x\n');
  assert.deepEqual(await s.post(s.stop('a1')), {});
  assert.deepEqual(rows(d, "SELECT status, verdict FROM subtasks WHERE id = 'A'"), [{ status: 'passed', verdict: 'meet' }]);

  // finished: the scope line of a new dispatch is the way, not this tool
  const fin = await s.tool('router_request_scope', { subtaskId: 'A', add: ['lib/**'] });
  assert.deepEqual([fin.ok, fin.code], [false, 'not_running']);
  assert.match(fin.message ?? '', /dispatch it again with a new \[scope: \.\.\.\] line/);
  // a subtask without a scope line has nothing to remove
  assert.deepEqual(await s.post(s.call('U', 'coder', 'haiku', 'low', null)), {});
  assert.equal((await s.tool('router_request_scope', { subtaskId: 'U', remove: ['src/**'] })).code, 'not_allowed');
  assert.deepEqual((x => [x.ok, x.result?.unscoped, x.result?.scope])(await s.tool('router_request_scope', { subtaskId: 'U', add: ['lib/**'] })), [true, true, null]);
  // never grantable, whatever the user says
  const never = await s.tool('router_request_scope', { subtaskId: 'U', add: ['src/**', '.git/hooks/**'], userConfirmed: true });
  assert.equal(never.code, 'not_allowed');
  assert.match(never.message ?? '', /can never be given to a subtask: \.git\/hooks\/\*\*/);
}));

test('router_request_scope: a protected path is granted after a user turn and stays with the subtask id (decision 129)', () => withDaemon(async (d, repo) => {
  const s = session(d, 'prot', repo);
  await s.post({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT });
  assert.deepEqual(await s.post(s.call('A', 'coder', 'haiku', 'low')), {});
  await s.post(s.start('a1'));
  const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));
  const agentFile = path.join(d.home, 'agents', 'a1.json');

  const n = await s.tool('router_request_scope', { subtaskId: 'A', add: ['lib/**', '.env.example'] });
  assert.deepEqual([n.ok, n.code, n.result?.protectedPaths], [false, 'needs_user', ['.env.example']]);
  assert.match(n.message ?? '', /Nothing was changed/);
  assert.deepEqual(read(agentFile).scope.allowed, ['src/**'], 'the ordinary part waits too');
  assert.equal((await s.tool('router_request_scope', { subtaskId: 'A', add: ['.env.example'], userConfirmed: true })).code, 'needs_user', 'no user turn yet');
  await s.userTurn();
  // the user turn covers the globs that were asked, not others
  assert.equal((await s.tool('router_request_scope', { subtaskId: 'A', add: ['.github/workflows/ci.yml'], userConfirmed: true })).code, 'needs_user');
  await s.userTurn();
  assert.equal((await s.tool('router_request_scope', { subtaskId: 'A', add: ['.env.example'], userConfirmed: true })).code, 'needs_user', 'the pending request is now the other one');
  await s.userTurn();
  const g = await s.tool('router_request_scope', { subtaskId: 'A', add: ['lib/**', '.env.example'], userConfirmed: true });
  assert.deepEqual([g.ok, g.result?.live, g.result?.scope, g.result?.protectedGranted], [true, true, ['src/**', 'lib/**'], ['.env.example']]);
  assert.deepEqual(read(agentFile).scope.protectedGranted, ['.env.example']);
  assert.deepEqual(read(agentFile).scope.allowed, ['src/**', 'lib/**']);
  assert.ok(read(agentFile).scope.protected.length > 0, 'the protected list itself is unchanged');
  assert.equal(d.ledger.count('confirmations'), 0);
  // already granted: no second user turn
  assert.equal((await s.tool('router_request_scope', { subtaskId: 'A', add: ['.env.example'] })).ok, true);

  // the stop check takes the grant: an edit of the granted file passes (without it: "protected paths changed")
  write(repo, '.env.example', 'KEY=\n');
  assert.deepEqual(await s.post(s.stop('a1')), {});
  assert.deepEqual(rows(d, "SELECT status, verdict FROM subtasks WHERE id = 'A'"), [{ status: 'passed', verdict: 'meet' }]);
  // a new attempt of the same id keeps the grant; its ordinary scope comes from the new [scope: ...] line
  assert.deepEqual(await s.post(s.call('A', 'coder', 'haiku', 'low', 'app/**')), {});
  const scopeFile = path.join(d.home, 'scopes', fs.readdirSync(path.join(d.home, 'scopes')).find(f => !f.includes('U'))!);
  assert.deepEqual([read(scopeFile).allowed, read(scopeFile).protectedGranted], [['app/**'], ['.env.example']]);
  // a grant can be taken back
  const back = await s.tool('router_request_scope', { subtaskId: 'A', remove: ['.env.example'] });
  assert.deepEqual([back.result?.protectedGranted, 'protectedGranted' in read(scopeFile)], [[], false]);
  // for a finished subtask only the protected part is kept, for its next attempt
  await s.post(s.start('a2'));
  assert.deepEqual(await s.post(s.stop('a2')), {});
  await s.tool('router_request_scope', { subtaskId: 'A', add: ['.env.example', 'more/**'] });
  await s.userTurn();
  const fin = await s.tool('router_request_scope', { subtaskId: 'A', add: ['.env.example', 'more/**'], userConfirmed: true });
  assert.deepEqual([fin.ok, fin.result?.live, fin.result?.scope, fin.result?.protectedGranted], [true, false, ['app/**'], ['.env.example']]);
  assert.match(fin.result?.note, /only the protected paths were granted/);
}));

// ------------------------------------------------------------------ record and ledger

test('the request record keeps the lead\'s judgement and the reviews; a v7 ledger gains the new columns', async () => {
  await withDaemon(async (d, repo) => {
    const s = session(d, 'rec', repo);
    await s.post({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT });
    await s.tool('router_report_triage', { kind: 'team', level: 'L2', files: 5, confidence: 0.75 });
    await s.pass('A', 'a1');
    await s.tool('router_report_result', { subtaskId: 'A', verdict: 'accept', by: 'lead' });
    await s.post({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.' });
    await d.router.drain();
    const rec = d.ledger.getRecord(rows(d, "SELECT id FROM requests WHERE session_id = 'rec'")[0]!.id as string) as any;
    assert.deepEqual([rec.leadTriage.kind, rec.leadTriage.level, rec.leadTriage.files, rec.leadTriage.plannedLevel], ['team', 'L2', 5, 'L2']);
    assert.deepEqual(rec.subtasks.map((x: any) => [x.id, x.review]), [['A', { verdict: 'accept', by: 'lead' }]]);
  });
  const { Ledger, SCHEMA_VERSION } = await import('../src/ledger.ts');
  const { DatabaseSync } = await import('node:sqlite');
  const dir = fs.mkdtempSync(path.join(fs.realpathSync((await import('node:os')).tmpdir()), 'ar-v7-'));
  const file = path.join(dir, 'router.db');
  try {
    const l = new Ledger(file);
    l.db.exec("ALTER TABLE requests DROP COLUMN lead_triage; ALTER TABLE subtasks DROP COLUMN review; ALTER TABLE subtasks DROP COLUMN protected_granted; ALTER TABLE slots DROP COLUMN fail_streak; ALTER TABLE slots DROP COLUMN lead_raises; DROP TABLE confirmations; PRAGMA user_version = 7;");
    l.db.exec("INSERT INTO slots (request_id, role, slot, step, up_count, updated_at) VALUES ('r', 'coder', 0, 's2', 1, 't')");
    l.close();
    const again = new Ledger(file);
    assert.deepEqual(again.getSlots('r'), [{ role: 'coder', slot: 0, step: 's2', upCount: 1, failStreak: 0, leadRaises: 0 }]);
    assert.equal(again.count('confirmations'), 0);
    again.close();
    const db = new DatabaseSync(file);
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, SCHEMA_VERSION);
    db.close();
  } finally { rmrf(dir); }
});
