// Decision 87: L0 is done by the lead itself (the router only triages and records); L1+ delegates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { AWAITING_USER_MARKER } from '../src/continuation.ts';
import type { StatusView } from '../src/router.ts';
import { TEAM_L1_PRESETS, getStatus, postHook, rmrf, rows, startTestDaemon, type HookInput, type TestDaemon } from './helpers.ts';

const L0_PROMPT = 'fix the typo in README.md';
const L1_PROMPT = 'Fix the bug where parse() fails on empty input in src/parse.ts';

async function withDaemon(fn: (d: TestDaemon) => Promise<void>, presets?: typeof TEAM_L1_PRESETS): Promise<void> {
  const d = await startTestDaemon(presets ? { presets } : {});
  try { await fn(d); } finally { await d.close(); rmrf(d.home); }
}

const session = (d: TestDaemon, sid: string) => async (h: HookInput) => {
  const r = await postHook(d.port, { session_id: sid, cwd: d.home, transcript_path: path.join(d.home, `${sid}.jsonl`), ...h });
  assert.equal(r.status, 200, r.text);
  return r.body as { hookSpecificOutput?: { additionalContext?: string; permissionDecision?: string } };
};
const stop = (msg = 'Done.') => ({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: msg });
const status = async (d: TestDaemon, sid: string) => (await getStatus(d.port, sid)).body as StatusView;

test('an L0 request the lead finishes itself is recorded as a normal "direct" completion', () => withDaemon(async d => {
  const post = session(d, 'l0');
  await post({ hook_event_name: 'UserPromptSubmit', prompt: L0_PROMPT });
  let st = await status(d, 'l0');
  assert.deepEqual([st.request?.level, st.request?.leadDirect, st.request?.outcome], ['L0', true, null]);
  await post(stop());
  assert.deepEqual(rows(d, 'SELECT level, status, outcome FROM requests'), [{ level: 'L0', status: 'closed', outcome: 'direct' }]);
  st = await status(d, 'l0');
  assert.equal(st.request?.outcome, 'direct');
  assert.equal(rows(d, 'SELECT COUNT(*) AS c FROM subtasks')[0]!.c, 0);
}));

test('T6: the lead\'s first router Agent call re-plans a lead-direct request at L2 and is checked against the L2 team', () => withDaemon(async d => {
  for (const [sid, p, from] of [['l0-team', L0_PROMPT, 'L0'], ['l1-team', L1_PROMPT, 'L1']] as const) {
    const post = session(d, sid);
    await post({ hook_event_name: 'UserPromptSubmit', prompt: p });
    assert.deepEqual([(await status(d, sid)).request?.level, (await status(d, sid)).request?.leadDirect], [from, true]);
    const call = (tag: string, type: string, model: string, effort: string) => post({ hook_event_name: 'PreToolUse', tool_name: 'Agent',
      tool_input: { subagent_type: `agentic-router:${type}`, prompt: `[subtask:${tag}] work`, model, effort } });
    // the architect of the L2 team starts at s3: haiku/low is the wrong step
    const r = await call('X', 'architect', 'haiku', 'low');
    assert.equal(r.hookSpecificOutput?.permissionDecision, 'deny');
    const st = await status(d, sid);
    assert.deepEqual([st.request?.level, st.request?.leadDirect, st.request?.budgetUsd, st.request?.replannedFrom], ['L2', false, 5, from]);
    assert.equal((await call('X', 'architect', 'sonnet', 'medium')).hookSpecificOutput?.permissionDecision, undefined);
    assert.equal((await call('A', 'coder', 'haiku', 'low')).hookSpecificOutput?.permissionDecision, undefined);
    const [req] = rows(d, 'SELECT level, preset, replanned_from, triage FROM requests WHERE session_id = ?', sid);
    assert.deepEqual([req!.level, req!.preset, JSON.parse(String(req!.replanned_from)).level], ['L2', 'L2', from]);
    assert.match(String(req!.triage), new RegExp(`re-planned at L2: the lead called a router subagent \\(architect at s1\\) in a lead-direct ${from} request`));
    await post(stop());
    assert.equal(rows(d, 'SELECT outcome FROM requests WHERE session_id = ?', sid)[0]!.outcome, 'delegated');
  }
}));

test('decision 113: the first call\'s step picks the team: the L3 start step re-plans at L3, the L2 one (or both, or neither) at L2', () => withDaemon(async d => {
  const cases: Array<[string, string, string, string, string, 'L2' | 'L3', boolean | null]> = [
    // session, prompt level, role, model, effort, re-planned at, allowed
    ['a3', L0_PROMPT, 'architect', 'opus', 'high', 'L3', true],      // L3 architect starts at s5
    ['c3', L1_PROMPT, 'coder', 'opus', 'high', 'L3', true],          // L3 coder starts at s5
    ['c2', L0_PROMPT, 'coder', 'haiku', 'low', 'L2', true],          // L2 coder starts at s1
    ['t2', L1_PROMPT, 'tester', 'haiku', 'low', 'L2', true],         // both teams start the tester at s1: L2
    ['x2', L0_PROMPT, 'coder', 'sonnet', 'medium', 'L2', false],     // neither: checked against L2 and denied
    ['u2', L0_PROMPT, 'ui-designer', 'sonnet', 'medium', 'L2', null],   // only the L3 team has it: no L3 signal (core l3SignalRoles)
  ];
  for (const [sid, prompt, role, model, effort, level, allowed] of cases) {
    const post = session(d, sid);
    await post({ hook_event_name: 'UserPromptSubmit', prompt });
    const r = await post({ hook_event_name: 'PreToolUse', tool_name: 'Agent',
      tool_input: { subagent_type: `agentic-router:${role}`, prompt: '[subtask:A] work', model, effort } });
    if (allowed !== null) assert.equal(r.hookSpecificOutput?.permissionDecision, allowed ? undefined : 'deny', sid);
    const st = await status(d, sid);
    assert.deepEqual([st.request?.level, st.request?.budgetUsd, st.request?.leadDirect], [level, level === 'L3' ? 15 : 5, false], sid);
    if (allowed !== null) assert.equal(rows(d, 'SELECT COUNT(*) AS c FROM subtasks WHERE request_id = ?', String(st.request!.id))[0]!.c, allowed ? 1 : 0, sid);
  }
  // a later call does not re-plan again: the request stays at L3
  const post = session(d, 'a3');
  await post({ hook_event_name: 'PreToolUse', tool_name: 'Agent',
    tool_input: { subagent_type: 'agentic-router:coder', prompt: '[subtask:B] work', model: 'haiku', effort: 'low' } });
  assert.equal((await status(d, 'a3')).request?.level, 'L3');
}));

test('a team request (L1 with lead_direct: false) that ends without any subtask is marked no_delegation; awaiting the user sets no outcome yet', () => withDaemon(async d => {
  const post = session(d, 'l1');
  await post({ hook_event_name: 'UserPromptSubmit', prompt: L1_PROMPT });
  assert.equal((await status(d, 'l1')).request?.leadDirect, false);
  await post(stop(`Which file? ${AWAITING_USER_MARKER}`));
  assert.deepEqual(rows(d, 'SELECT status, outcome FROM requests'), [{ status: 'awaiting_user', outcome: null }]);
  await post({ hook_event_name: 'UserPromptSubmit', prompt: 'src/parse.ts' });
  await post(stop());
  assert.deepEqual(rows(d, 'SELECT status, outcome FROM requests'), [{ status: 'closed', outcome: 'no_delegation' }]);
}, TEAM_L1_PRESETS));

test('decision 88: L1 is lead-direct by default, so an L1 request finished by the lead is "direct"', () => withDaemon(async d => {
  const post = session(d, 'l1-direct');
  await post({ hook_event_name: 'UserPromptSubmit', prompt: L1_PROMPT });
  assert.equal((await status(d, 'l1-direct')).request?.leadDirect, true);
  await post(stop());
  assert.deepEqual(rows(d, 'SELECT level, outcome FROM requests'), [{ level: 'L1', outcome: 'direct' }]);
}));
