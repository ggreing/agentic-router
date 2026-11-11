// T7 (decisions 104-111): the request-end record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { costUsd } from '@agentic-router/core';
import { AWAITING_USER_MARKER } from '../src/continuation.ts';
import type { StatusView } from '../src/router.ts';
import { getStatus, makeRepo, postHook, rmrf, rows, startTestDaemon, write, type HookInput, type TestDaemon } from './helpers.ts';

const L0_PROMPT = 'fix the typo in README.md';
type Rec = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any

async function withDaemon(fn: (d: TestDaemon, clock: { advance(ms: number): void; at(): string }) => Promise<void>, config: Record<string, unknown> = {}): Promise<void> {
  let t = Date.parse('2026-11-11T10:00:00.000Z');
  const d = await startTestDaemon({ now: () => new Date(t), config });
  try { await fn(d, { advance: ms => { t += ms; }, at: () => new Date(t).toISOString() }); } finally { await d.close(); rmrf(d.home); }
}
const session = (d: TestDaemon, sid: string, cwd: string, transcript?: string) => async (h: HookInput) => {
  const r = await postHook(d.port, { session_id: sid, cwd, transcript_path: transcript ?? path.join(d.home, `${sid}.jsonl`), ...h });
  assert.equal(r.status, 200, r.text);
  return r.body as { hookSpecificOutput?: { additionalContext?: string; permissionDecision?: string } };
};
const stop = (msg = 'Done.'): HookInput => ({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: msg });
const record = (d: TestDaemon, sid: string): Rec => {
  const r = rows(d, 'SELECT record FROM request_records r JOIN requests q ON q.id = r.request_id WHERE q.session_id = ?', sid);
  assert.equal(r.length, 1, `one record for ${sid}`);
  return JSON.parse(String(r[0]!.record));
};

test('T7: the changes of the request only: files, lines, new files, folders; the user\'s earlier work is not counted', () => withDaemon(async d => {
  const repo = makeRepo({ 'README.md': 'teh typo\n', 'src/a.ts': 'one\ntwo\nthree\n', 'docs/user.md': 'u1\n', 'docs/other.md': 'o1\n' });
  try {
    write(repo, 'docs/user.md', 'u1\nu2 by the user\n');       // uncommitted work before the request
    write(repo, 'docs/other.md', 'o1\no2 by the user\n');
    const post = session(d, 'chg', repo);
    await post({ hook_event_name: 'UserPromptSubmit', prompt: L0_PROMPT });
    await d.router.drain();                                         // the start state is taken after the hook answers
    write(repo, 'README.md', 'the typo\n');                          // 1 added, 1 removed
    write(repo, 'src/a.ts', 'one\nTWO\nthree\nfour\n');              // 2 added, 1 removed
    write(repo, 'src/new.ts', 'n1\nn2\nn3');                         // new: 3 lines
    write(repo, 'docs/user.md', 'u1\nu2 by the user\nu3 by the lead\n');   // the user's file edited further: +1
    await post(stop());
    await d.router.drain();
    const rec = record(d, 'chg');
    assert.deepEqual(rec.changes, {
      changedFiles: 4, changedDirs: 3, linesAdded: 7, linesRemoved: 2, newFiles: 1, deletedFiles: 0, binaryFiles: 0, approximate: true,
    });
    assert.equal(rec.outcome, 'direct');
    assert.deepEqual(rows(d, 'SELECT changed_files, lines_added, lines_removed, outcome FROM request_records'),
      [{ changed_files: 4, lines_added: 7, lines_removed: 2, outcome: 'direct' }]);
  } finally { rmrf(repo); }
}));

test('T7: the lead\'s usage of the request, from the main transcript (its prompts only, de-duplicated, no sidechain); it is the lead cost', () => withDaemon(async (d, clock) => {
  const tr = path.join(d.home, 'main.jsonl');
  const u = { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 9000, cache_creation_input_tokens: 500 };
  const u2 = { input_tokens: 100, output_tokens: 50 };
  const line = (o: object) => JSON.stringify(o);
  fs.writeFileSync(tr, [
    line({ type: 'user', promptId: 'p-0', message: { role: 'user', content: 'an earlier request' } }),
    line({ type: 'assistant', message: { id: 'm0', model: 'claude-opus-5-5', usage: u2 } }),                      // p-0: another request
    line({ type: 'user', promptId: 'p-1', message: { role: 'user', content: 'this request' } }),
    line({ type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', usage: u, content: [{ type: 'text', text: 'a' }] } }),
    line({ type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', usage: u, content: [{ type: 'tool_use', name: 'Edit' }] } }),   // same call
    line({ type: 'assistant', isSidechain: true, message: { id: 's1', model: 'claude-haiku-5-5', usage: u2 } }),   // a subagent's line
    line({ type: 'assistant', message: { id: 'm2', model: 'claude-opus-5-5', usage: u2 } }),
  ].join('\n') + '\n');
  const post = session(d, 'lead', d.home, tr);
  await post({ hook_event_name: 'UserPromptSubmit', prompt: L0_PROMPT, prompt_id: 'p-1' });
  clock.advance(5000);
  await post(stop());
  await d.router.drain();
  const usd = Math.round((costUsd('claude-opus-5-5', u)! + costUsd('claude-opus-5-5', u2)!) * 1e6) / 1e6;
  const rec = record(d, 'lead');
  assert.deepEqual([rec.lead.calls, rec.lead.model, rec.lead.usd, rec.lead.matchedBy], [2, 'claude-opus-5-5', usd, 'promptId']);
  assert.deepEqual(rows(d, "SELECT source, model_id, calls, usd FROM costs"), [{ source: 'lead', model_id: 'claude-opus-5-5', calls: 2, usd }]);
  assert.equal(rows(d, 'SELECT lead_cost_usd FROM requests')[0]!.lead_cost_usd, usd);
  assert.equal(((await getStatus(d.port, 'lead')).body as StatusView).costUsd, usd);
  assert.deepEqual([rec.costs.leadUsd, rec.costs.subtaskUsd, rec.costs.totalUsd], [usd, 0, usd]);
  assert.ok(!fs.readFileSync(path.join(d.home, 'router.db')).includes('this request'), 'no conversation content in the ledger');

  // a transcript without prompt ids: the request's time window decides
  const tr2 = path.join(d.home, 'main2.jsonl');
  const post2 = session(d, 'lead2', d.home, tr2);
  clock.advance(60_000);
  const t0 = clock.at();
  await post2({ hook_event_name: 'UserPromptSubmit', prompt: L0_PROMPT });
  clock.advance(10_000);
  fs.writeFileSync(tr2, [
    line({ type: 'assistant', timestamp: '2026-11-11T09:00:00.000Z', message: { id: 'old', model: 'claude-opus-5-5', usage: u } }),
    line({ type: 'assistant', timestamp: new Date(Date.parse(t0) + 3000).toISOString(), message: { id: 'in', model: 'claude-sonnet-5-5', usage: u2 } }),
  ].join('\n') + '\n');
  await post2(stop());
  await d.router.drain();
  const rec2 = record(d, 'lead2');
  assert.deepEqual([rec2.lead.calls, rec2.lead.model, rec2.lead.usd, rec2.lead.matchedBy], [1, 'claude-sonnet-5-5', costUsd('claude-sonnet-5-5', u2), 'time']);
}));

// The line structure of Claude Code's main transcript (checked on real
// runs, metadata only): promptId on user lines only, prompt and tool_result lines alike; none on assistant lines.
test('T7: assistant lines belong to the promptId of the nearest user line above; a notification turn\'s prompt id is the request\'s too', () => withDaemon(async (d, clock) => {
  const tr = path.join(d.home, 'main3.jsonl');
  const u = (n: number) => ({ input_tokens: n, output_tokens: n });
  const line = (o: object) => JSON.stringify(o);
  const user = (promptId: string, content: unknown) => line({ type: 'user', isSidechain: false, promptId, promptSource: 'user', message: { role: 'user', content } });
  const asst = (id: string, n: number) => line({ type: 'assistant', isSidechain: false, requestId: `req_${id}`, message: { id, model: 'claude-opus-5-5', usage: u(n) } });
  fs.writeFileSync(tr, [
    user('p-1', 'the request'), asst('a1', 100),
    user('p-1', [{ type: 'tool_result', content: 'ok' }]), asst('a2', 200),        // the tool result keeps the prompt's id
    user('p-2', '<task-notification>…</task-notification>'), asst('a3', 300),      // the notification turn
    user('p-9', 'the next request'), asst('a4', 999),
  ].join('\n') + '\n');
  const post = session(d, 'n', d.home, tr);
  await post({ hook_event_name: 'UserPromptSubmit', prompt: L0_PROMPT, prompt_id: 'p-1' });
  clock.advance(1000);
  await post(stop());
  clock.advance(1000);
  await post({ hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>x</task-id>\n<status>completed</status>\n</task-notification>', prompt_id: 'p-2' });
  clock.advance(1000);
  await post(stop());
  await d.router.drain();
  const rec = record(d, 'n');
  assert.deepEqual([rec.lead.calls, rec.lead.matchedBy], [3, 'promptId']);
  assert.equal(rec.lead.usd, Math.round([100, 200, 300].reduce((a, n) => a + costUsd('claude-opus-5-5', u(n))!, 0) * 1e6) / 1e6);
}));

test('T7: when none of the request\'s prompt ids is in the transcript, the time window decides (and it is logged)', () => withDaemon(async (d, clock) => {
  const tr = path.join(d.home, 'main4.jsonl');
  const post = session(d, 'mis', d.home, tr);
  const t0 = clock.at();
  await post({ hook_event_name: 'UserPromptSubmit', prompt: L0_PROMPT, prompt_id: 'hook-id' });
  clock.advance(5000);
  fs.writeFileSync(tr, [
    JSON.stringify({ type: 'user', promptId: 'transcript-id', timestamp: t0, message: { role: 'user', content: 'x' } }),
    JSON.stringify({ type: 'assistant', timestamp: new Date(Date.parse(t0) + 2000).toISOString(), message: { id: 'a1', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 10 } } }),
  ].join('\n') + '\n');
  await post(stop());
  await d.router.drain();
  const rec = record(d, 'mis');
  assert.deepEqual([rec.lead.calls, rec.lead.matchedBy], [1, 'time']);
  const log = fs.readdirSync(path.join(d.home, 'logs')).map(f => fs.readFileSync(path.join(d.home, 'logs', f), 'utf8')).join('');
  assert.match(log, /none of the request's prompt ids is in the transcript; matched by time instead/);
}));

test('T7: the record keeps the two-stage triage (kind, rule, teamScore) and its prompt features', () => withDaemon(async d => {
  const post = session(d, 'feat', d.home);
  await post({ hook_event_name: 'UserPromptSubmit', prompt: L0_PROMPT });
  await post(stop());
  await d.router.drain();
  const rec = record(d, 'feat');
  assert.equal(rec.triage.kind, 'direct');
  assert.equal(typeof rec.triage.rule, 'string');
  assert.equal(typeof rec.triage.teamScore, 'number');
  assert.equal(typeof rec.features?.chars, 'number');
  assert.equal(JSON.stringify(rec.features).includes('typo'), false, 'features carry no prompt text');
  assert.equal(rows(d, 'SELECT kind FROM request_records')[0]!.kind, 'direct');
}));

test('T7: time awaiting the user is not active time; prompts, answers and notifications are counted', () => withDaemon(async (d, clock) => {
  const post = session(d, 'time', d.home);
  await post({ hook_event_name: 'UserPromptSubmit', prompt: L0_PROMPT });
  clock.advance(10_000);
  await post(stop(`Which file? ${AWAITING_USER_MARKER}`));
  clock.advance(60_000);
  await post({ hook_event_name: 'UserPromptSubmit', prompt: 'README.md' });
  clock.advance(10_000);
  await post(stop());
  await d.router.drain();
  const rec = record(d, 'time');
  assert.deepEqual(rec.time, { durationMs: 80_000, activeMs: 20_000, awaitingMs: 60_000 });
  assert.deepEqual(rec.turns, { prompts: 2, notifications: 0, continuations: 1 });
}));

test('T7: triage, plan (T6 re-plan) and subtasks; a request reopened by a notification is recorded again', () => withDaemon(async (d, clock) => {
  const repo = makeRepo({ 'README.md': 'teh\n' });
  try {
    const post = session(d, 'plan', repo);
    await post({ hook_event_name: 'UserPromptSubmit', prompt: L0_PROMPT });
    await post({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_r1',
      tool_input: { subagent_type: 'agentic-router:coder', prompt: '[subtask:A] fix it\n[scope: README.md]', model: 'haiku', effort: 'low' } });
    await post({ hook_event_name: 'SubagentStart', agent_id: 'ag1', agent_type: 'agentic-router:coder' });
    write(repo, 'README.md', 'the\n');
    await post({ hook_event_name: 'SubagentStop', agent_id: 'ag1', agent_type: 'agentic-router:coder', stop_hook_active: false });
    await post(stop('Started subtask A.'));
    await d.router.drain();
    let rec = record(d, 'plan');
    assert.deepEqual([rec.triage.level, rec.triage.source, rec.plan.level, rec.plan.replannedFrom, rec.plan.leadDirect, rec.outcome], ['L0', 'rule', 'L2', 'L0', false, 'delegated']);
    assert.deepEqual(rec.subtasks, [{ id: 'A', role: 'coder', slot: 0, step: 's1', upCount: 0, status: 'passed', verdict: 'meet', attempts: 1, costUsd: 0 }]);
    assert.equal(rec.verifyFailures, 0);
    assert.equal(rec.plan.presetSource, 'default');
    clock.advance(1000);
    await post({ hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>ag1</task-id>\n<status>completed</status>\n</task-notification>' });
    clock.advance(1000);
    await post(stop());
    await d.router.drain();
    rec = record(d, 'plan');
    assert.deepEqual(rec.turns, { prompts: 2, notifications: 1, continuations: 0 });
    assert.equal(rec.time.durationMs, 2000);
  } finally { rmrf(repo); }
}));

test('T7: no prompt text is kept unless config.recordPrompts is on (then redacted)', async () => {
  const prompt = 'fix the typo in README.md; my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz';
  for (const [on, expected] of [[false, null], [true, 'fix the typo in README.md; my key is [REDACTED]']] as const) {
    await withDaemon(async d => {
      const post = session(d, 'p', d.home);
      await post({ hook_event_name: 'UserPromptSubmit', prompt });
      await post(stop());
      await d.router.drain();
      const [r] = rows(d, 'SELECT prompt FROM request_records');
      if (expected === null) assert.equal(r!.prompt, null);
      else assert.match(String(r!.prompt), /^fix the typo in README\.md; my key is (?!sk-ant-api03-abcdefghij)/);
      assert.equal(fs.readFileSync(path.join(d.home, 'router.db')).includes('sk-ant-api03-abcdefghij'), false);
    }, on ? { recordPrompts: true } : {});
  }
});
