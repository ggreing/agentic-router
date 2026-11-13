// `/router level <L>` (decision): re-plan the request in progress, or set the level
// of the session's next request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DEFAULT_PRESETS } from '@do-it-all-claude-code/core';
import { AWAITING_USER_MARKER } from '../src/continuation.ts';
import type { StatusView } from '../src/router.ts';
import { TEAM_L1_PRESETS, getStatus, postHook, rmrf, rows, startTestDaemon, type HookInput, type TestDaemon } from './helpers.ts';

const L1_PROMPT = 'Fix the bug where parse() fails on empty input in src/parse.ts';
const L0_PROMPT = 'fix the typo in README.md';

type Out = { systemMessage?: string; hookSpecificOutput?: { additionalContext?: string; permissionDecision?: string; permissionDecisionReason?: string } };

async function withDaemon(fn: (d: TestDaemon) => Promise<void>, presets?: typeof TEAM_L1_PRESETS): Promise<void> {
  const d = await startTestDaemon(presets ? { presets } : {});
  try { await fn(d); } finally { await d.close(); rmrf(d.home); }
}

const base = (sid: string, cwd: string) => ({ session_id: sid, cwd, transcript_path: path.join(cwd, 't.jsonl') });
const out = async (d: TestDaemon, h: HookInput): Promise<Out> => {
  const r = await postHook(d.port, h);
  assert.equal(r.status, 200, r.text);
  return r.body as Out;
};
const prompt = (sid: string, cwd: string, text: string): HookInput => ({ ...base(sid, cwd), hook_event_name: 'UserPromptSubmit', prompt: text });
const stop = (sid: string, cwd: string, msg: string): HookInput => ({ ...base(sid, cwd), hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: msg });
const agent = (sid: string, cwd: string, type: string, tag: string, model: string, effort: string): HookInput => ({
  ...base(sid, cwd), hook_event_name: 'PreToolUse', tool_name: 'Agent',
  tool_input: { subagent_type: `do-it-all-claude-code:${type}`, prompt: `[subtask:${tag}] work`, model, effort },
});
const ctx = (o: Out) => o.hookSpecificOutput?.additionalContext ?? '';
const denied = (o: Out) => o.hookSpecificOutput?.permissionDecision === 'deny';

test('/router level on a request in progress re-plans it (manual triage, new team and budget); running subtasks keep their step', () => withDaemon(async d => {
  const cwd = d.home;
  const sid = 'lvl-replan';
  await out(d, prompt(sid, cwd, L1_PROMPT));
  assert.deepEqual(await out(d, agent(sid, cwd, 'coder', 'A', 'haiku', 'low')), {});        // L1 coder @s1, still pending
  await out(d, stop(sid, cwd, `Which file should I start with? ${AWAITING_USER_MARKER}`));

  const o = await out(d, prompt(sid, cwd, '/router level L3'));
  assert.match(ctx(o), /^\[do-it-all-claude-code\] level L3 \(source=manual, confidence=1\.00\)/);
  assert.match(ctx(o), /team preset L3: architect x1 @s5 .* budget \$15\./);
  assert.match(ctx(o), /level set manually to L3 for request r-.* \(was L1\)/);

  const [r] = rows(d, 'SELECT level, preset, budget_usd, status, turns, triage, override_from FROM requests');
  assert.deepEqual([r!.level, r!.preset, r!.budget_usd, r!.status, r!.turns], ['L3', 'L3', DEFAULT_PRESETS.L3.budgetUsd, 'open', 2]);
  assert.equal(JSON.parse(String(r!.triage)).source, 'manual');
  assert.match(JSON.parse(String(r!.triage)).rationale, /rule result was L1/);
  assert.equal(JSON.parse(String(r!.override_from)).level, 'L1');

  // the pending subtask keeps s1; new calls use the L3 steps (coder s5 = opus/high)
  assert.deepEqual(rows(d, 'SELECT id, step FROM subtasks'), [{ id: 'A', step: 's1' }]);
  assert.ok(denied(await out(d, agent(sid, cwd, 'coder', 'B', 'haiku', 'low'))));
  assert.deepEqual(await out(d, agent(sid, cwd, 'coder', 'B', 'opus', 'high')), {});
  assert.deepEqual(await out(d, agent(sid, cwd, 'ui-designer', 'U', 'sonnet', 'medium')), {});  // in the L3 preset now
  const st = (await getStatus(d.port, sid)).body as StatusView;
  assert.equal(st.request?.level, 'L3');
  assert.equal(st.request?.source, 'manual');
  assert.equal(st.request?.budgetUsd, DEFAULT_PRESETS.L3.budgetUsd);
}, TEAM_L1_PRESETS));

test('/router level with no request in progress applies to the next request only', () => withDaemon(async d => {
  const cwd = d.home;
  const sid = 'lvl-next';
  await out(d, prompt(sid, cwd, L1_PROMPT));
  await out(d, stop(sid, cwd, 'Done.'));                                                        // closed
  const o = await out(d, prompt(sid, cwd, '/do-it-all-claude-code:router level l2'));
  assert.match(ctx(o), /no request is in progress, so the next request in this session will run at level L2 \(manual\)/);
  assert.deepEqual(rows(d, 'SELECT level, status FROM requests'), [{ level: 'L1', status: 'closed' }]);

  const next = await out(d, prompt(sid, cwd, L0_PROMPT));                                       // the rules say L0
  assert.match(ctx(next), /^\[do-it-all-claude-code\] level L2 \(source=manual/);
  const reqs = rows(d, 'SELECT level, triage, override_from FROM requests ORDER BY created_at, rowid');
  assert.equal(reqs[1]!.level, 'L2');
  assert.equal(JSON.parse(String(reqs[1]!.override_from)).level, 'L0');

  await out(d, stop(sid, cwd, 'Done.'));
  const after = await out(d, prompt(sid, cwd, L0_PROMPT));                                      // used up: rules again
  assert.match(ctx(after), /^\[do-it-all-claude-code\] level L0 \(source=rule/);
  // another session is not affected
  assert.match(ctx(await out(d, prompt('other', cwd, L0_PROMPT))), /level L0 \(source=rule/);
}));

test('/router level without a valid level answers with usage and changes nothing', () => withDaemon(async d => {
  const cwd = d.home;
  await out(d, prompt('lvl-bad', cwd, L1_PROMPT));
  const o = await out(d, prompt('lvl-bad', cwd, '/router level L9'));
  assert.equal(o.systemMessage, '[do-it-all-claude-code] usage: /router level L0|L1|L2|L3');
  assert.deepEqual(rows(d, 'SELECT level, override_from FROM requests'), [{ level: 'L1', override_from: null }]);
}));

test('the next-request level survives a daemon restart and a newer /router level replaces it', async () => {
  const d1 = await startTestDaemon();
  const home = d1.home;
  try {
    await out(d1, prompt('lvl-keep', home, '/router level L2'));
    await out(d1, prompt('lvl-keep', home, '/router level L3'));
    assert.deepEqual(rows(d1, 'SELECT session_id, level FROM pending_levels'), [{ session_id: 'lvl-keep', level: 'L3' }]);
    await d1.close();
    const d2 = await startTestDaemon({ home });
    try {
      const o = await out(d2, prompt('lvl-keep', home, L0_PROMPT));
      assert.match(ctx(o), /^\[do-it-all-claude-code\] level L3 \(source=manual/);
      assert.equal(rows(d2, 'SELECT COUNT(*) AS c FROM pending_levels')[0]!.c, 0);
    } finally { await d2.close(); }
  } finally { await d1.close(); rmrf(home); }
});
