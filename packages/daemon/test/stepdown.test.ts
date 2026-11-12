// Spec 3.5 step-down and floor lock (decision 135) on the daemon: two easy passes in a row on a slot move
// it one step down for its next subtask; a raise locks it for two dispatches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROUTER_TOOL_PREFIX } from '@agentic-router/core';
import { Ledger, SCHEMA_VERSION } from '../src/ledger.ts';
import type { StatusView } from '../src/router.ts';
import { TOOL_USE_ID_META } from '../src/tools.ts';
import { TOKEN, getStatus, makeRepo, postHook, request, rmrf, rows, startTestDaemon, type HookInput, type TestDaemon } from './helpers.ts';

const L1_PROMPT = 'Fix the bug where parse() fails on empty input in src/parse.ts';
const L2_PROMPT = 'Refactor the validation module across multiple files and add an audit log';
type Out = { hookSpecificOutput?: { additionalContext?: string; permissionDecision?: string; permissionDecisionReason?: string } };
type ToolOut = { ok: boolean; code?: string; message?: string; result?: Record<string, any> };
let seq = 0;

async function withDaemon(fn: (d: TestDaemon, repo: string) => Promise<void>, config: Record<string, unknown> = {}): Promise<void> {
  const repo = makeRepo({ 'src/a.ts': 'a\n' });
  const d = await startTestDaemon({ verify: { resolveCommands: async () => [] }, config });
  try { await fn(d, repo); } finally { await d.close(); rmrf(d.home); rmrf(repo); }
}

function session(d: TestDaemon, sid: string, cwd: string) {
  const post = async (h: HookInput): Promise<Out> => {
    const r = await postHook(d.port, { session_id: sid, cwd, transcript_path: path.join(d.home, `${sid}.jsonl`), ...h });
    assert.equal(r.status, 200, r.text);
    return r.body as Out;
  };
  const tool = async (name: string, input: Record<string, unknown> = {}): Promise<ToolOut> => {
    const id = `toolu_d${++seq}`;
    await post({ hook_event_name: 'PreToolUse', tool_name: ROUTER_TOOL_PREFIX + name, tool_use_id: id, tool_input: input });
    const r = await request(d.port, {
      method: 'POST', path: '/router/v1/tools/call', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tool: name, input, meta: { [TOOL_USE_ID_META]: id }, bind: { instanceId: 'i-1', projectDir: cwd } }),
    });
    return r.body as ToolOut;
  };
  const call = (tag: string, role: string, model: string, effort: string): HookInput => ({
    hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: `toolu_c${++seq}`,
    tool_input: { subagent_type: `agentic-router:${role}`, prompt: `[subtask:${tag}] work\n[scope: src/**]`, model, effort },
  });
  /** Dispatches a subtask and lets it finish with a passing verify. */
  const pass = async (tag: string, model: string, effort: string, role = 'coder'): Promise<void> => {
    const agent = `ag${++seq}`;
    assert.deepEqual(await post(call(tag, role, model, effort)), {}, `dispatch ${tag}`);
    await post({ hook_event_name: 'SubagentStart', agent_id: agent, agent_type: `agentic-router:${role}` });
    assert.deepEqual(await post({ hook_event_name: 'SubagentStop', agent_id: agent, agent_type: `agentic-router:${role}`, stop_hook_active: false }), {});
  };
  const easy = (subtaskId: string, bySubtaskId = 'RV') => tool('router_report_result', { subtaskId, verdict: 'accept', by: 'reviewer', bySubtaskId, margin: 'easy' });
  return { post, tool, call, pass, easy };
}
const denied = (o: Out) => (o.hookSpecificOutput?.permissionDecision === 'deny' ? o.hookSpecificOutput.permissionDecisionReason ?? '' : '');
const coder0 = (d: TestDaemon) => rows(d, "SELECT step, up_count, easy_streak, last_easy, lock_step, lock_left, down_count, fail_streak, lead_raises FROM slots WHERE role = 'coder' AND slot = 0")[0];

/** An L3 team request (coder and reviewer start at s5), with a finished reviewer subtask RV. */
async function l3(d: TestDaemon, sid: string, repo: string) {
  const s = session(d, sid, repo);
  await s.post({ hook_event_name: 'UserPromptSubmit', prompt: L1_PROMPT });
  assert.equal((await s.tool('router_report_triage', { kind: 'team', level: 'L3', files: 30, confidence: 0.8 })).result?.level, 'L3');
  await s.pass('RV', 'opus', 'high', 'reviewer');
  return s;
}

test('two easy passes in a row lower the slot for its next subtask, across a model boundary', () => withDaemon(async (d, repo) => {
  const s = await l3(d, 'down', repo);
  assert.deepEqual(((await getStatus(d.port, 'down')).body as StatusView).stepAdjust, { up: 'on', down: 'on' });
  await s.pass('X1', 'opus', 'high');
  const one = await s.easy('X1');
  assert.deepEqual([one.ok, one.result?.steppedDown, one.result?.slot.step], [true, undefined, 's5']);
  assert.deepEqual(coder0(d), { step: 's5', up_count: 0, easy_streak: 1, last_easy: 1, lock_step: null, lock_left: 0, down_count: 0, fail_streak: 0, lead_raises: 0 });
  // the same easy pass reported again counts once
  await s.easy('X1');
  assert.equal(coder0(d)!.easy_streak, 1);
  await s.pass('X2', 'opus', 'high');
  const two = await s.easy('X2');
  assert.deepEqual([two.result?.steppedDown, two.result?.slot.step, two.result?.slot.model, two.result?.slot.effort, two.result?.next], [true, 's4', 'sonnet', 'high', 'none']);
  assert.deepEqual(coder0(d), { step: 's4', up_count: 0, easy_streak: 0, last_easy: 1, lock_step: null, lock_left: 0, down_count: 1, fail_streak: 0, lead_raises: 0 });
  // the next call for the slot must use the lower step; the old one is refused
  assert.match(denied(await s.post(s.call('X3', 'coder', 'opus', 'high'))), /the coder runs at step s4 \(model="sonnet", effort="high"\)/);
  await s.pass('X3', 'sonnet', 'high');
  // the plan and the request record show it
  const plan = (await s.tool('router_get_plan')).result!;
  assert.deepEqual((r => [r.step, r.model])(plan.roles.find((r: any) => r.role === 'coder' && r.slot === 0)), ['s4', 'sonnet']);
  await s.post({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.' });
  await d.router.drain();
  const rec = d.ledger.getRecord(rows(d, "SELECT id FROM requests WHERE session_id = 'down'")[0]!.id as string) as any;
  assert.deepEqual(rec.slots.find((x: any) => x.role === 'coder'), { role: 'coder', slot: 0, step: 's4', ups: 0, downs: 1 });
}));

test('what is not an easy pass: the lead\'s word, a second attempt, a result nobody reported, a late report', () => withDaemon(async (d, repo) => {
  const s = await l3(d, 'not-easy', repo);
  // the lead's own "easy" is recorded and does not count
  await s.pass('X1', 'opus', 'high');
  await s.tool('router_report_result', { subtaskId: 'X1', verdict: 'accept', by: 'lead', margin: 'easy' });
  await s.pass('X2', 'opus', 'high');
  await s.tool('router_report_result', { subtaskId: 'X2', verdict: 'accept', by: 'lead', margin: 'easy' });
  assert.equal(coder0(d), undefined, 'no slot state was needed');
  // one easy pass, then a result nobody reported, then another easy pass: no two in a row
  await s.easy('X2');
  assert.equal(coder0(d)!.easy_streak, 1);
  await s.pass('X3', 'opus', 'high');
  await s.pass('X4', 'opus', 'high');
  assert.deepEqual([coder0(d)!.easy_streak, coder0(d)!.last_easy], [0, 0]);
  await s.easy('X4');
  assert.deepEqual([coder0(d)!.step, coder0(d)!.easy_streak], ['s5', 1]);
  // a second attempt of the same subtask is not a first-try pass, and it ends the streak
  await s.pass('X4', 'opus', 'high');
  assert.equal((await s.easy('X4')).result?.steppedDown, undefined);
  assert.deepEqual([coder0(d)!.step, coder0(d)!.easy_streak], ['s5', 0]);
  // a plain accept and a reject end it too
  await s.pass('X5', 'opus', 'high');
  await s.easy('X5');
  await s.tool('router_report_result', { subtaskId: 'X5', verdict: 'accept', by: 'reviewer', bySubtaskId: 'RV', margin: 'normal' });
  assert.equal(coder0(d)!.easy_streak, 0);
  await s.pass('X6', 'opus', 'high');
  await s.easy('X6');
  await s.tool('router_report_result', { subtaskId: 'X6', verdict: 'reject', by: 'reviewer', bySubtaskId: 'RV' });
  assert.deepEqual([coder0(d)!.easy_streak, coder0(d)!.fail_streak], [0, 1]);
  // a report for a subtask that is no longer the slot's latest changes nothing
  await s.pass('X7', 'opus', 'high');
  assert.deepEqual(await s.post(s.call('X8', 'coder', 'opus', 'high')), {});
  await s.easy('X7');
  assert.deepEqual([coder0(d)!.step, coder0(d)!.easy_streak, coder0(d)!.last_easy], ['s5', 0, 0]);
}));

test('a raise locks the slot for two tasks; coming back down gives the raise back but not the lead-only raise', () => withDaemon(async (d, repo) => {
  const s = session(d, 'lock', repo);
  await s.post({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT });
  await s.pass('RV', 'sonnet', 'medium', 'reviewer');
  await s.pass('A', 'haiku', 'low');
  // verify passed, the lead judges the result wrong: one raise on its word (decision 128), and the floor lock
  assert.equal((await s.tool('router_request_escalation', { subtaskId: 'A', reason: 'wrong_result' })).result?.step, 's2');
  assert.deepEqual(coder0(d), { step: 's2', up_count: 1, easy_streak: 0, last_easy: 0, lock_step: 's2', lock_left: 2, down_count: 0, fail_streak: 0, lead_raises: 1 });
  // two tasks at the raised step, both easy: the third runs one step lower
  await s.pass('B', 'haiku', 'high');
  assert.equal((await s.easy('B')).result?.steppedDown, undefined);
  assert.deepEqual([coder0(d)!.lock_left, coder0(d)!.easy_streak], [1, 1]);
  await s.pass('C', 'haiku', 'high');
  assert.deepEqual([coder0(d)!.lock_left, coder0(d)!.lock_step], [0, null]);
  const down = await s.easy('C');
  assert.deepEqual([down.result?.steppedDown, down.result?.slot.step, down.result?.slot.upCount, down.result?.slot.upsLeft], [true, 's1', 0, 3]);
  assert.deepEqual(coder0(d), { step: 's1', up_count: 0, easy_streak: 0, last_easy: 1, lock_step: null, lock_left: 0, down_count: 1, fail_streak: 0, lead_raises: 1 });
  assert.match(denied(await s.post(s.call('D', 'coder', 'haiku', 'high'))), /the coder runs at step s1/);
  await s.pass('D', 'haiku', 'low');
  // the bottom step stays, however easy
  await s.easy('D');
  await s.pass('E', 'haiku', 'low');
  assert.deepEqual((r => [r.result?.steppedDown, r.result?.slot.step])(await s.easy('E')), [undefined, 's1']);
  // the lead's one raise on its own word was used: step-down did not hand it back
  const again = await s.tool('router_request_escalation', { subtaskId: 'E', reason: 'wrong_result' });
  assert.deepEqual([again.code, again.result?.why], ['needs_user', 'second_lead_only']);
}));

test('a verify miss right after a step-down raises the slot again and locks it', () => {
  let fail = false;
  return (async () => {
    const repo = makeRepo({ 'src/a.ts': 'a\n', 'fail.cjs': 'process.exit(1)\n' });
    const d = await startTestDaemon({ verify: { resolveCommands: async () => (fail ? [{ kind: 'test' as const, command: 'node fail.cjs' }] : []) } });
    try {
      const s = await l3(d, 'bounce', repo);
      await s.pass('X1', 'opus', 'high');
      await s.easy('X1');
      await s.pass('X2', 'opus', 'high');
      assert.equal((await s.easy('X2')).result?.slot.step, 's4');
      fail = true;
      assert.deepEqual(await s.post(s.call('X3', 'coder', 'sonnet', 'high')), {});
      await s.post({ hook_event_name: 'SubagentStart', agent_id: 'm1', agent_type: 'agentic-router:coder' });
      await s.post({ hook_event_name: 'SubagentStop', agent_id: 'm1', agent_type: 'agentic-router:coder', stop_hook_active: false });
      await s.post({ hook_event_name: 'SubagentStop', agent_id: 'm1', agent_type: 'agentic-router:coder', stop_hook_active: true });
      assert.deepEqual((x => [x!.step, x!.up_count, x!.lock_step, x!.lock_left, x!.down_count, x!.easy_streak])(coder0(d)), ['s5', 1, 's5', 2, 1, 0]);
      const n = await s.post({ hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>m1</task-id>\n<status>completed</status>\n</task-notification>' });
      assert.match(n.hookSpecificOutput?.additionalContext ?? '', /now runs one step higher, at s5/);
    } finally { await d.close(); rmrf(d.home); rmrf(repo); }
  })();
});

test('config stepDown "off": easy passes are recorded and nothing moves', () => withDaemon(async (d, repo) => {
  const s = await l3(d, 'off', repo);
  assert.deepEqual(((await getStatus(d.port, 'off')).body as StatusView).stepAdjust, { up: 'on', down: 'off' });
  await s.pass('X1', 'opus', 'high');
  await s.easy('X1');
  await s.pass('X2', 'opus', 'high');
  assert.deepEqual((r => [r.ok, r.result?.steppedDown, r.result?.slot.step])(await s.easy('X2')), [true, undefined, 's5']);
  assert.deepEqual(rows(d, "SELECT review FROM subtasks WHERE id = 'X2'").map(r => JSON.parse(String(r.review)).margin), ['easy']);
  assert.deepEqual(await s.post(s.call('X3', 'coder', 'opus', 'high')), {});
}, { stepDown: 'off' }));

test('a v8 ledger gains the step-down columns', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ar-v8-'));
  const file = path.join(dir, 'router.db');
  try {
    const l = new Ledger(file);
    l.db.exec('ALTER TABLE slots DROP COLUMN easy_streak; ALTER TABLE slots DROP COLUMN last_easy; ALTER TABLE slots DROP COLUMN lock_step; ALTER TABLE slots DROP COLUMN lock_left; ALTER TABLE slots DROP COLUMN down_count; PRAGMA user_version = 8;');
    l.db.exec("INSERT INTO slots (request_id, role, slot, step, up_count, updated_at, fail_streak, lead_raises) VALUES ('r', 'coder', 0, 's2', 1, 't', 1, 1)");
    l.close();
    const again = new Ledger(file);
    assert.equal(SCHEMA_VERSION, 9);
    assert.deepEqual(again.getSlots('r'), [{ role: 'coder', slot: 0, step: 's2', upCount: 1, failStreak: 1, leadRaises: 1, easyStreak: 0, lastEasy: false, lockStep: null, lockLeft: 0, downCount: 0 }]);
    again.setSlotAdjust('r', 'coder', 0, { step: 's1', upCount: 0, easyStreak: 0, lastEasy: true, lockStep: null, lockLeft: 0, downCount: 1 }, 't2');
    assert.deepEqual((x => [x.step, x.upCount, x.downCount, x.lastEasy, x.failStreak, x.leadRaises])(again.getSlots('r')[0]!), ['s1', 0, 1, true, 1, 1]);
    again.close();
  } finally { rmrf(dir); }
});
