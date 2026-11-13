// Decision #4 (after integration run 2): subagent cost comes from the SubagentStop transcript, and an
// async subagent's <task-notification> prompt is not a new request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { costUsd } from '@do-it-all-claude-code/core';
import { readTranscriptUsage } from '../src/transcript.ts';
import type { StatusView } from '../src/router.ts';
import {
  FIXTURE_CALLS, TRANSCRIPT_FIXTURE, copyTranscript, getStatus, postHook, rmrf, rows, startTestDaemon, tmpDir, write,
  type HookInput, type TestDaemon,
} from './helpers.ts';

const L1_PROMPT = 'Fix the bug where parse() fails on empty input in src/parse.ts';
const FIXTURE_USD = Math.round(FIXTURE_CALLS.reduce((a, u) => a + costUsd('claude-haiku-5-5', u)!, 0) * 1e6) / 1e6;

test('transcript usage: assistant messages de-duplicated by message.id, priced per call, summed per model', async () => {
  const r = await readTranscriptUsage(TRANSCRIPT_FIXTURE);
  assert.ok(r.ok);
  assert.deepEqual(r.models, [{
    modelId: 'claude-haiku-5-5', calls: 4, inputTokens: 8, outputTokens: 1477, cacheWriteTokens: 12247, cacheReadTokens: 30066, usd: FIXTURE_USD,
  }]);
  // the fixture has 11 assistant lines for those 4 calls
  const lines = fs.readFileSync(TRANSCRIPT_FIXTURE, 'utf8').split('\n').filter(l => l.includes('"type":"assistant"'));
  assert.equal(lines.length, 11);
  // the last call alone (what PostToolUse(Agent) reports) is far less than the session
  assert.ok(costUsd('claude-haiku-5-5', FIXTURE_CALLS[3]!)! < FIXTURE_USD / 2);
});

test('transcript usage: bad paths and unreadable content are reported, malformed lines skipped', async () => {
  const dir = tmpDir('tr');
  try {
    assert.deepEqual(await readTranscriptUsage(undefined), { ok: false, reason: 'no agent_transcript_path in SubagentStop' });
    assert.equal((await readTranscriptUsage('relative/agent.jsonl')).ok, false);
    assert.equal((await readTranscriptUsage(path.join(dir, 'x.txt'))).ok, false);
    assert.deepEqual(await readTranscriptUsage(path.join(dir, 'missing.jsonl')), { ok: false, reason: 'transcript not found' });
    const mixed = path.join(dir, 'mixed.jsonl');
    const call = (id: string, model: string, out: number) => JSON.stringify({ type: 'assistant', message: { id, model, usage: { input_tokens: 10, output_tokens: out } } });
    write(dir, 'mixed.jsonl', ['{not json', call('m1', 'claude-sonnet-5-5', 5), call('m1', 'claude-sonnet-5-5', 7), call('m2', 'claude-opus-5-5', 3), '{"type":"assistant","message":{"usage":{}}}', ''].join('\n'));
    const r = await readTranscriptUsage(mixed);
    assert.ok(r.ok);
    assert.deepEqual(r.models.map(m => [m.modelId, m.calls, m.outputTokens]), [['claude-sonnet-5-5', 1, 7], ['claude-opus-5-5', 1, 3]]);   // last line of m1 wins
    write(dir, 'odd.jsonl', JSON.stringify({ type: 'assistant', message: { id: 'z', model: 'no-such-model', usage: { input_tokens: 1 } } }));
    const odd = await readTranscriptUsage(path.join(dir, 'odd.jsonl'));
    assert.ok(odd.ok);
    assert.equal(odd.models[0]!.usd, null);
  } finally { rmrf(dir); }
});

async function withDaemon(fn: (d: TestDaemon) => Promise<void>): Promise<void> {
  const d = await startTestDaemon();
  try { await fn(d); } finally { await d.close(); rmrf(d.home); }
}

const session = (d: TestDaemon, sid: string) => {
  const b = { session_id: sid, cwd: d.home, transcript_path: path.join(d.home, `${sid}.jsonl`) };
  return async (h: HookInput) => {
    const r = await postHook(d.port, { ...b, ...h });
    assert.equal(r.status, 200, r.text);
    return r.body as { decision?: string; hookSpecificOutput?: { additionalContext?: string; permissionDecision?: string; permissionDecisionReason?: string } };
  };
};
const postStatus = async (d: TestDaemon, sid: string): Promise<StatusView> => (await getStatus(d.port, sid)).body as StatusView;
const agentCall = (tag: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'do-it-all-claude-code:coder', prompt: `[subtask:${tag}] x`, model: 'haiku', effort: 'low' } });

test('async Agent run: no usage at PostToolUse, the cost comes from the SubagentStop transcript, once per agent', () => withDaemon(async d => {
  const post = session(d, 'async');
  await post({ hook_event_name: 'UserPromptSubmit', prompt: L1_PROMPT });
  await post(agentCall('A'));
  await post({ hook_event_name: 'SubagentStart', agent_id: 'ag-a', agent_type: 'do-it-all-claude-code:coder' });
  // Claude Code runs the Agent tool asynchronously: the result is only "launched", without usage
  await post({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'do-it-all-claude-code:coder', prompt: '[subtask:A] x' },
    tool_response: { isAsync: true, status: 'async_launched', agentId: 'ag-a', prompt: '[subtask:A] x', resolvedModel: 'claude-haiku-5-5' } });
  assert.equal(rows(d, 'SELECT COUNT(*) AS c FROM costs')[0]!.c, 0);
  assert.equal(rows(d, 'SELECT pairing FROM agents')[0]!.pairing, 'confirmed');

  const transcript = copyTranscript(d.home, 'ag-a');
  const stop = { hook_event_name: 'SubagentStop', agent_id: 'ag-a', agent_type: 'do-it-all-claude-code:coder', agent_transcript_path: transcript };
  await post({ ...stop, stop_hook_active: false });
  const expected = { source: 'transcript', subtask_id: 'A', model_id: 'claude-haiku-5-5', calls: 4, input_tokens: 8, output_tokens: 1477, cache_write_tokens: 12247, cache_read_tokens: 30066, usd: FIXTURE_USD, note: null };
  const cost = () => rows(d, 'SELECT source, subtask_id, model_id, calls, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, usd, note FROM costs');
  assert.deepEqual(cost(), [expected]);
  assert.equal(rows(d, 'SELECT used_usd FROM requests')[0]!.used_usd, FIXTURE_USD);

  // a second stop (after a block, the transcript has grown) replaces the agent's cost instead of adding it
  await post({ ...stop, stop_hook_active: true });
  assert.deepEqual(cost(), [expected]);
  assert.equal(rows(d, 'SELECT used_usd FROM requests')[0]!.used_usd, FIXTURE_USD);
}));

test('sync Agent run: PostToolUse usage is kept for cross-checking only, not counted', () => withDaemon(async d => {
  const post = session(d, 'sync');
  await post({ hook_event_name: 'UserPromptSubmit', prompt: L1_PROMPT });
  await post({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'Explore', prompt: 'look' },
    tool_response: { status: 'completed', agentId: 'ex-1', resolvedModel: 'claude-haiku-5-5', usage: FIXTURE_CALLS[3] } });
  await post({ hook_event_name: 'SubagentStop', agent_id: 'ex-1', agent_type: 'Explore', stop_hook_active: false, agent_transcript_path: copyTranscript(d.home, 'ex-1') });
  assert.deepEqual(rows(d, 'SELECT source, calls, usd FROM costs ORDER BY id'), [
    { source: 'agent_result', calls: 1, usd: costUsd('claude-haiku-5-5', FIXTURE_CALLS[3]!) },
    { source: 'transcript', calls: 4, usd: FIXTURE_USD },
  ]);
  assert.equal(rows(d, 'SELECT used_usd FROM requests')[0]!.used_usd, FIXTURE_USD);
}));

const notification = (agentId: string, tokens?: number) =>
  `<task-notification>\n<task-id>${agentId}</task-id>\n<status>completed</status>\n<result>done</result>\n`
  + `${tokens === undefined ? '' : `<usage><subagent_tokens>${tokens}</subagent_tokens><tool_uses>4</tool_uses><duration_ms>9000</duration_ms></usage>\n`}</task-notification>`;

async function startedCoder(post: ReturnType<typeof session>, tag: string, agentId: string): Promise<void> {
  await post(agentCall(tag));
  await post({ hook_event_name: 'SubagentStart', agent_id: agentId, agent_type: 'do-it-all-claude-code:coder' });
}

test('decision 84: no transcript but notification tokens -> estimate at the output rate, counted, Agent calls go on', () => withDaemon(async d => {
  const post = session(d, 'estimate');
  await post({ hook_event_name: 'UserPromptSubmit', prompt: L1_PROMPT });
  await startedCoder(post, 'A', 'ag-e');
  const gone = path.join(d.home, 'gone', 'agent-ag-e.jsonl');
  await post({ hook_event_name: 'SubagentStop', agent_id: 'ag-e', agent_type: 'do-it-all-claude-code:coder', stop_hook_active: false, agent_transcript_path: gone });
  assert.deepEqual(rows(d, 'SELECT source, usd, note FROM costs'), [{ source: 'transcript', usd: null, note: 'unknown: transcript not found' }]);
  assert.equal(rows(d, 'SELECT used_usd FROM requests')[0]!.used_usd, 0);
  assert.equal((await post(agentCall('B'))).hookSpecificOutput?.permissionDecision, undefined);   // unknown cost does not deny

  await post({ hook_event_name: 'UserPromptSubmit', prompt: notification('ag-e', 12764) });
  const est = 12764 * 0.5 / 1e6;   // haiku output rate, $0.50 / MTok (s1 = claude-haiku-5-5)
  const [row] = rows(d, 'SELECT source, model_id, output_tokens, usd, note FROM costs');
  assert.deepEqual({ ...row, note: undefined }, { source: 'estimate', model_id: 'claude-haiku-5-5', output_tokens: 12764, usd: est, note: undefined });
  assert.match(String(row!.note), /^estimated from notification tokens: 12764 subagent tokens at the claude-haiku-5-5 output rate/);
  assert.ok(est > FIXTURE_USD, 'the estimate errs high');
  assert.equal(rows(d, 'SELECT used_usd FROM requests')[0]!.used_usd, est);
  const st = (await postStatus(d, 'estimate'));
  assert.deepEqual([st.costEstimated, st.costUnknown], [true, false]);
  assert.match(fs.readFileSync(path.join(d.home, 'logs', 'daemon.log'), 'utf8'), /subagent cost estimated from the task notification/);

  // a stop that still cannot read the transcript keeps the estimate; a readable one replaces it
  await post({ hook_event_name: 'SubagentStop', agent_id: 'ag-e', agent_type: 'do-it-all-claude-code:coder', stop_hook_active: true, agent_transcript_path: gone });
  assert.equal(rows(d, 'SELECT source FROM costs')[0]!.source, 'estimate');
  await post({ hook_event_name: 'SubagentStop', agent_id: 'ag-e', agent_type: 'do-it-all-claude-code:coder', stop_hook_active: true, agent_transcript_path: copyTranscript(d.home, 'ag-e') });
  assert.deepEqual(rows(d, 'SELECT source, usd FROM costs'), [{ source: 'transcript', usd: FIXTURE_USD }]);
  assert.equal(rows(d, 'SELECT used_usd FROM requests')[0]!.used_usd, FIXTURE_USD);
  // and a later notification does not overwrite a known cost
  await post({ hook_event_name: 'UserPromptSubmit', prompt: notification('ag-e', 99999) });
  assert.deepEqual(rows(d, 'SELECT source, usd FROM costs'), [{ source: 'transcript', usd: FIXTURE_USD }]);
}));

test('decision 84: neither transcript nor notification tokens -> unknown, warned, flagged in status, no deny', () => withDaemon(async d => {
  const post = session(d, 'unknown');
  await post({ hook_event_name: 'UserPromptSubmit', prompt: L1_PROMPT });
  await startedCoder(post, 'A', 'ag-u');
  await post({ hook_event_name: 'SubagentStop', agent_id: 'ag-u', agent_type: 'do-it-all-claude-code:coder', stop_hook_active: false });
  await post({ hook_event_name: 'UserPromptSubmit', prompt: notification('ag-u') });
  assert.deepEqual(rows(d, 'SELECT source, usd, note FROM costs'), [{ source: 'transcript', usd: null, note: 'unknown: no agent_transcript_path in SubagentStop' }]);
  assert.equal((await post(agentCall('B'))).hookSpecificOutput?.permissionDecision, undefined);
  const st = await postStatus(d, 'unknown');
  assert.deepEqual([st.costEstimated, st.costUnknown], [false, true]);
  assert.match(fs.readFileSync(path.join(d.home, 'logs', 'daemon.log'), 'utf8'), /subagent cost unknown: not counted/);
  // a built-in agent stopping without any transcript path is not treated as a lost cost
  await post({ hook_event_name: 'SubagentStop', agent_id: 'internal-1', agent_type: '', stop_hook_active: false });
  assert.equal(rows(d, 'SELECT COUNT(*) AS c FROM costs')[0]!.c, 1);
}));

test('a transcript with unexpected field types never throws: bad numbers count as 0, a missing usage falls back to unknown', () => withDaemon(async d => {
  const post = session(d, 'odd');
  await post({ hook_event_name: 'UserPromptSubmit', prompt: L1_PROMPT });
  await startedCoder(post, 'A', 'ag-o');
  write(d.home, 'odd/agent-ag-o.jsonl', [
    JSON.stringify({ type: 'assistant', message: { id: 'm1', model: 'claude-haiku-5-5', usage: { input_tokens: '12', output_tokens: 100, cache_read_input_tokens: -5, cache_creation: 'x' } } }),
    JSON.stringify({ type: 'assistant', message: { id: 'm2', model: 'claude-haiku-5-5', usage: 'not an object' } }),
  ].join('\n'));
  await post({ hook_event_name: 'SubagentStop', agent_id: 'ag-o', agent_type: 'do-it-all-claude-code:coder', stop_hook_active: false, agent_transcript_path: path.join(d.home, 'odd', 'agent-ag-o.jsonl') });
  assert.deepEqual(rows(d, 'SELECT calls, input_tokens, output_tokens, cache_read_tokens, usd FROM costs'),
    [{ calls: 1, input_tokens: 0, output_tokens: 100, cache_read_tokens: 0, usd: costUsd('claude-haiku-5-5', { output_tokens: 100 }) }]);
  write(d.home, 'odd/agent-ag-p.jsonl', JSON.stringify({ type: 'assistant', message: { id: 'm1' } }));
  await post({ hook_event_name: 'SubagentStop', agent_id: 'ag-p', agent_type: 'Explore', stop_hook_active: false, agent_transcript_path: path.join(d.home, 'odd', 'agent-ag-p.jsonl') });
  assert.equal(rows(d, 'SELECT note FROM costs WHERE agent_id = ?', 'ag-p')[0]!.note, 'unknown: no assistant usage in the transcript');
}));

test('decision 85: a task notification brings the subtask\'s verify result to the lead; none when no subtask is bound', () => withDaemon(async d => {
  const post = session(d, 'result');
  await post({ hook_event_name: 'UserPromptSubmit', prompt: L1_PROMPT });
  await startedCoder(post, 'A', 'ag-r');
  await post({ hook_event_name: 'SubagentStop', agent_id: 'ag-r', agent_type: 'do-it-all-claude-code:coder', stop_hook_active: false, agent_transcript_path: copyTranscript(d.home, 'ag-r') });
  const passed = await post({ hook_event_name: 'UserPromptSubmit', prompt: notification('ag-r', 12764) });
  assert.equal(passed.hookSpecificOutput?.additionalContext,
    `[do-it-all-claude-code] subtask A (coder @s1, model=haiku, effort=low): verify passed — scope ok; cost $${FIXTURE_USD.toFixed(4)} (already verified by the router; no need to re-run).`
    // decision 145: the one tool that matters for a passed writer, by its full name
    + ' If the result is wrong although verify passed, do not fix it yourself: call mcp__plugin_do-it-all-claude-code_router__router_request_escalation (load it with ToolSearch first) for this subtask, then dispatch it again.');

  // a miss (two failed attempts), set up directly in the ledger
  await post(agentCall('B'));
  await post({ hook_event_name: 'SubagentStart', agent_id: 'ag-b', agent_type: 'do-it-all-claude-code:coder' });
  d.ledger.insertSignals({ requestId: String(rows(d, 'SELECT id FROM requests')[0]!.id), subtaskId: 'B', agentId: 'ag-b', attempt: 2, at: new Date().toISOString() },
    [{ kind: 'test', ok: false, detail: 'npm test: exit 1\n2 failing' }, { kind: 'scope', ok: true, detail: '3 file(s) changed during the subtask' }]);
  d.ledger.updateAgent('ag-b', { stopCount: 2, failCount: 2 });
  d.ledger.updateSubtask(String(rows(d, 'SELECT id FROM requests')[0]!.id), 'B', { status: 'failed', verdict: 'miss' }, new Date().toISOString());
  const failed = await post({ hook_event_name: 'UserPromptSubmit', prompt: notification('ag-b') });
  assert.equal(failed.hookSpecificOutput?.additionalContext,
    '[do-it-all-claude-code] subtask B (coder @s1, model=haiku, effort=low): verify failed again after one fix attempt (miss) — test failed, scope ok. '
    + 'First failure: npm test: exit 1 (3 file(s)). Decide: dispatch a new attempt with what failed, or report to the user.');

  // an agent with no subtask (Explore) or an unknown task id: no context
  assert.deepEqual(await post({ hook_event_name: 'UserPromptSubmit', prompt: notification('nobody') }), {});
}));

test('a <task-notification> prompt is not a new request: no triage, no context, the request continues', () => withDaemon(async d => {
  const post = session(d, 'notify');
  await post({ hook_event_name: 'UserPromptSubmit', prompt: L1_PROMPT });
  await post({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Started the coder in the background.' });
  assert.equal(rows(d, 'SELECT status FROM requests')[0]!.status, 'closed');
  const note = '<task-notification>\n<task-id>ag-a</task-id>\n<status>completed</status>\n<result>done</result>\n<usage><subagent_tokens>12764</subagent_tokens></usage>\n</task-notification>';
  assert.deepEqual(await post({ hook_event_name: 'UserPromptSubmit', prompt: note }), {});
  const reqs = rows(d, 'SELECT id, status, turns FROM requests');
  assert.equal(reqs.length, 1);
  assert.deepEqual([reqs[0]!.status, reqs[0]!.turns], ['open', 1]);   // reopened for the lead's follow-up Agent calls
  assert.equal(rows(d, 'SELECT request_id FROM events WHERE type = ? ORDER BY id DESC LIMIT 1', 'prompt_submit')[0]!.request_id, reqs[0]!.id);
  assert.deepEqual(await post(agentCall('R')), {});                  // stays in the same request
  assert.equal(rows(d, 'SELECT COUNT(*) AS c FROM requests')[0]!.c, 1);
  // while the request waits for the user's answer, a notification leaves it waiting
  await post({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Which option? [router:awaiting-user]' });
  await post({ hook_event_name: 'UserPromptSubmit', prompt: `  ${note}` });
  assert.equal(rows(d, 'SELECT status FROM requests')[0]!.status, 'awaiting_user');
  // audit #13: the turn spent on the notification ends without answering the question: still waiting
  await post({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Subtask A is done. Still waiting for your answer.' });
  assert.equal(rows(d, 'SELECT status FROM requests')[0]!.status, 'awaiting_user');
  await post({ hook_event_name: 'UserPromptSubmit', prompt: 'option B' });           // the answer continues the request
  assert.equal(rows(d, 'SELECT COUNT(*) AS c FROM requests')[0]!.c, 1);
  // a normal prompt that merely mentions the tag later in the text is a request as usual
  await post({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.' });
  await post({ hook_event_name: 'UserPromptSubmit', prompt: 'why did <task-notification> show up?' });
  assert.equal(rows(d, 'SELECT COUNT(*) AS c FROM requests')[0]!.c, 2);
}));
