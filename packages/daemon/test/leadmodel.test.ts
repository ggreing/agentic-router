// Decisions 117-118 (the team plan follows the lead's model) and 119 (an automatic L3 is planned with the
// L2 team; the lead can still take the L3 team with its first call).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { StatusView } from '../src/router.ts';
import { getStatus, postHook, rmrf, rows, startTestDaemon, type HookInput, type TestDaemon } from './helpers.ts';

const L1_PROMPT = 'Fix the bug where parse() fails on empty input in src/parse.ts';
const L3_SIGN_PROMPT = '결제 처리를 위한 신규 서비스를 처음부터 설계하고 구현해줘. 아키텍처 문서도 함께.';
type Out = { hookSpecificOutput?: { additionalContext?: string; permissionDecision?: string } };

async function withDaemon(fn: (d: TestDaemon) => Promise<void>, config: Record<string, unknown> = {}): Promise<void> {
  const d = await startTestDaemon({ config });
  try { await fn(d); } finally { await d.close(); rmrf(d.home); }
}
/** A main transcript whose latest assistant message used `model`. */
const transcript = (d: TestDaemon, name: string, model: string) => {
  const f = path.join(d.home, `${name}.jsonl`);
  fs.writeFileSync(f, JSON.stringify({ type: 'assistant', message: { id: `m-${name}`, model, usage: { input_tokens: 1, output_tokens: 1 } } }) + '\n');
  return f;
};
const ask = async (d: TestDaemon, sid: string, prompt: string, transcriptPath?: string): Promise<Out> => {
  const r = await postHook(d.port, { session_id: sid, cwd: d.home, hook_event_name: 'UserPromptSubmit', prompt, ...(transcriptPath ? { transcript_path: transcriptPath } : {}) });
  assert.equal(r.status, 200, r.text);
  return r.body as Out;
};
const req = async (d: TestDaemon, sid: string) => ((await getStatus(d.port, sid)).body as StatusView).request!;

test('decision 117: an Opus-class lead delegates from L1, a Sonnet or unknown lead from L2; L0 is always the lead\'s', () => withDaemon(async d => {
  await ask(d, 'opus', L1_PROMPT, transcript(d, 'opus', 'claude-opus-5-5'));
  let r = await req(d, 'opus');
  assert.deepEqual([r.level, r.leadDirect, r.leadModel, r.leadClass], ['L1', false, 'claude-opus-5-5', 'opus']);
  assert.deepEqual(JSON.parse(String(rows(d, "SELECT team FROM requests WHERE session_id = 'opus'")[0]!.team)).roles, [{ role: 'coder', count: 1, start: 's1' }]);
  await ask(d, 'opus', 'fix the typo in README.md', transcript(d, 'opus', 'claude-opus-5-5'));
  assert.deepEqual([(await req(d, 'opus')).level, (await req(d, 'opus')).leadDirect], ['L0', true]);
  await ask(d, 'sonnet', L1_PROMPT, transcript(d, 'sonnet', 'claude-sonnet-5-5'));
  r = await req(d, 'sonnet');
  assert.deepEqual([r.leadDirect, r.leadClass], [true, 'sonnet']);
  await ask(d, 'unknown', L1_PROMPT);
  r = await req(d, 'unknown');
  assert.deepEqual([r.leadDirect, r.leadModel, r.leadClass], [true, null, 'other']);
}));

test('decision 117: the lead model is decided at each request (a /model switch), else from the session\'s SessionStart', () => withDaemon(async d => {
  // SessionStart names the model; the first prompt has no transcript yet
  await postHook(d.port, { session_id: 's', cwd: d.home, hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5-5' });
  await ask(d, 's', L1_PROMPT);
  assert.deepEqual([(await req(d, 's')).leadClass, (await req(d, 's')).leadDirect], ['opus', false]);
  // after /model sonnet the transcript's latest assistant line shows the new model
  await ask(d, 's', 'Fix the bug where format() fails on empty input in src/format.ts', transcript(d, 's', 'claude-sonnet-5-5'));
  assert.deepEqual([(await req(d, 's')).leadClass, (await req(d, 's')).leadDirect], ['sonnet', true]);
  const rec = rows(d, "SELECT lead_model, lead_class FROM requests WHERE session_id = 's' ORDER BY created_at, rowid");
  assert.deepEqual(rec, [{ lead_model: 'claude-opus-5-5', lead_class: 'opus' }, { lead_model: 'claude-sonnet-5-5', lead_class: 'sonnet' }]);
}));

test('decision 118: config.delegateFrom changes the start; an explicit lead_direct in teams.yaml still wins', () => withDaemon(async d => {
  await ask(d, 'a', L1_PROMPT, transcript(d, 'a', 'claude-sonnet-5-5'));
  assert.equal((await req(d, 'a')).leadDirect, false);                          // sonnet: from L1 by config
  fs.writeFileSync(path.join(d.home, 'teams.yaml'), 'L1:\n  lead_direct: true\n');
  await ask(d, 'b', L1_PROMPT, transcript(d, 'b', 'claude-sonnet-5-5'));
  assert.deepEqual([(await req(d, 'b')).leadDirect, (await req(d, 'b')).presetSource], [true, 'user']);
}, { delegateFrom: { sonnet: 'L1' } }));

test('decision 119: an automatic L3 is planned with the L2 team; the first call at an L3 signal step takes the L3 team', () => withDaemon(async d => {
  const sid = 'l3';
  const ctx = (await ask(d, sid, L3_SIGN_PROMPT)).hookSpecificOutput?.additionalContext ?? '';
  let r = await req(d, sid);
  assert.deepEqual([r.level, r.budgetUsd, r.leadDirect], ['L2', 5, false]);
  assert.match(ctx, /Larger team/);
  const call = (tag: string, role: string, model: string, effort: string) => postHook(d.port, { session_id: sid, cwd: d.home, hook_event_name: 'PreToolUse', tool_name: 'Agent',
    tool_input: { subagent_type: `agentic-router:${role}`, prompt: `[subtask:${tag}] work`, model, effort } });
  assert.equal(((await call('X', 'architect', 'opus', 'high')).body as Out).hookSpecificOutput?.permissionDecision, undefined);
  r = await req(d, sid);
  assert.deepEqual([r.level, r.budgetUsd, r.replannedFrom], ['L3', 15, 'L2']);
  // a second request with L3 signs whose first call is at the L2 step stays L2
  const sid2 = 'l3-stays';
  await ask(d, sid2, L3_SIGN_PROMPT);
  await postHook(d.port, { session_id: sid2, cwd: d.home, hook_event_name: 'PreToolUse', tool_name: 'Agent',
    tool_input: { subagent_type: 'agentic-router:architect', prompt: '[subtask:X] work', model: 'sonnet', effort: 'medium' } });
  assert.deepEqual([(await req(d, sid2)).level, (await req(d, sid2)).replannedFrom], ['L2', null]);
  // and the record keeps the triage's L3 signs
  await postHook(d.port, { session_id: sid, cwd: d.home, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' });
  await d.router.drain();
  const record = JSON.parse(String(rows(d, "SELECT r.record FROM request_records r JOIN requests q ON q.id = r.request_id WHERE q.session_id = 'l3'")[0]!.record));
  assert.deepEqual([record.triage.level, record.triage.l3Signs, record.plan.level, record.plan.replannedFrom], ['L2', true, 'L3', 'L2']);
}));

test('decision 119: a request set by /router level or by forceLevel is not raised by a call', () => withDaemon(async d => {
  await ask(d, 'forced', L3_SIGN_PROMPT);
  await postHook(d.port, { session_id: 'forced', cwd: d.home, hook_event_name: 'PreToolUse', tool_name: 'Agent',
    tool_input: { subagent_type: 'agentic-router:architect', prompt: '[subtask:X] work', model: 'opus', effort: 'high' } });
  assert.equal((await req(d, 'forced')).level, 'L2');
}, { forceLevel: 'L2' }));

void (null as unknown as HookInput);
