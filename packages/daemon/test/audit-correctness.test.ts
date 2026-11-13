// Regression tests for the read-only audit, correctness items #10-#13 (E8-E14).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TEAM_L0_PRESETS, claudeAdapter, makeRepo, postHook, rmrf, rows, startTestDaemon, write, type HookInput, type TestDaemon } from './helpers.ts';

const L1_PROMPT = 'Fix the bug where parse() fails on empty input in src/parse.ts';
const L2_PROMPT = 'Refactor the validation module across multiple files and add an audit log';
type Out = { hookSpecificOutput?: { additionalContext?: string; permissionDecision?: string; permissionDecisionReason?: string } };

let seq = 0;
async function withDaemon(fn: (d: TestDaemon, clock: { advance(ms: number): void }) => Promise<void>, presets?: typeof TEAM_L0_PRESETS): Promise<void> {
  let t = Date.parse('2026-11-11T10:00:00.000Z');
  const d = await startTestDaemon({ now: () => new Date(t), ...(presets ? { presets } : {}) });
  try { await fn(d, { advance: ms => { t += ms; } }); } finally { await d.close(); rmrf(d.home); }
}
const session = (d: TestDaemon, sid: string, cwd = d.home) => async (h: HookInput): Promise<Out> => {
  const r = await postHook(d.port, { session_id: sid, cwd, transcript_path: path.join(d.home, `${sid}.jsonl`), ...h });
  assert.equal(r.status, 200, r.text);
  return r.body as Out;
};
const call = (tag: string, scope: string, o: { type?: string; model?: string; effort?: string; toolUseId?: string } = {}): HookInput => ({
  hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: o.toolUseId ?? `toolu_${++seq}`,
  tool_input: { subagent_type: o.type ?? 'do-it-all-claude-code:coder', prompt: `[subtask:${tag}] work\n[scope: ${scope}]`, model: o.model ?? 'haiku', effort: o.effort ?? 'low' },
});
const start = (agentId: string): HookInput => ({ hook_event_name: 'SubagentStart', agent_id: agentId, agent_type: 'do-it-all-claude-code:coder' });
const denied = (o: Out) => o.hookSpecificOutput?.permissionDecision === 'deny' ? o.hookSpecificOutput.permissionDecisionReason ?? '' : '';
const subs = (d: TestDaemon) => rows(d, 'SELECT id, status, agent_id FROM subtasks ORDER BY dispatch_seq');

test('E9 / #10: a tag running in an earlier request of the session is busy in the next one; its scope file stays', () => withDaemon(async d => {
  const post = session(d, 'e9');
  await post({ hook_event_name: 'UserPromptSubmit', prompt: L1_PROMPT });
  await post(call('A', 'src/a/**'));
  await post(start('a1'));
  await post({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'waiting for the subagent' });
  await post({ hook_event_name: 'UserPromptSubmit', prompt: 'Also fix the bug in src/b/y.ts where it fails on empty input' });
  assert.match(denied(await post(call('A', 'src/b/**'))), /subtask A is already running/);
  const scope = JSON.parse(fs.readFileSync(d.ledger && path.join(d.home, 'scopes', fs.readdirSync(path.join(d.home, 'scopes'))[0]!), 'utf8'));
  assert.deepEqual(scope.allowed, ['src/a/**']);
  // the agent file carries its own scope for the guard
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d.home, 'agents', 'a1.json'), 'utf8')).scope.allowed, ['src/a/**']);
}));

test('E8 / #11: an allowed subtask that never started expires after 30 s and frees the fixed team\'s slot', () => withDaemon(async (d, clock) => {
  const post = session(d, 'e8');
  await post({ hook_event_name: 'UserPromptSubmit', prompt: 'Fix the typo in the error message in src/a/x.ts' });
  assert.equal(rows(d, 'SELECT level FROM requests')[0]!.level, 'L0');
  await post(call('A', 'src/a/**'));                                       // never starts
  assert.match(denied(await post(call('A2', 'src/a/**'))), /L0 team are busy.*dispatched again with the same ID/);
  clock.advance(31_000);
  assert.deepEqual(await post(call('A2', 'src/a/**')), {});
  assert.deepEqual(subs(d), [{ id: 'A', status: 'cancelled', agent_id: null }, { id: 'A2', status: 'pending', agent_id: null }]);
}, TEAM_L0_PRESETS));   // a fixed-size delegating L0 team

test('#11: an agent pairs with a pending subtask of the current request only', () => withDaemon(async (d, clock) => {
  const post = session(d, 'pair');
  await post({ hook_event_name: 'UserPromptSubmit', prompt: L1_PROMPT });
  await post(call('A', 'src/a/**'));                                       // allowed, never starts
  await post({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.' });
  clock.advance(1000);
  await post({ hook_event_name: 'UserPromptSubmit', prompt: 'Fix the bug in src/b/y.ts where it fails on empty input' });
  await post(call('B', 'src/b/**'));
  await post(start('b1'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(d.home, 'agents', 'b1.json'), 'utf8')).subtaskId, 'B');
}));

test('E12 / #11: a "killed" or "failed" notification ends the subtask (verify never ran) and frees its slot', () => withDaemon(async d => {
  const post = session(d, 'e12');
  await post({ hook_event_name: 'UserPromptSubmit', prompt: 'Fix the typo in the error message in src/a/x.ts' });
  await post(call('A', 'src/a/**'));
  await post(start('a1'));
  const n = await post({ hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>a1</task-id>\n<status>killed</status>\n<summary>Agent was stopped</summary>\n</task-notification>' });
  assert.match(n.hookSpecificOutput?.additionalContext ?? '', /subtask A .*: the subagent was stopped before it finished; verify did not run.*Its slot is free/);
  assert.deepEqual(subs(d)[0], { id: 'A', status: 'cancelled', agent_id: 'a1' });
  assert.deepEqual(await post(call('A2', 'src/a/**')), {});
  await post(start('a2'));
  const f = await post({ hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>a2</task-id>\n<status>failed</status>\n</task-notification>' });
  assert.match(f.hookSpecificOutput?.additionalContext ?? '', /subtask A2 .*: the subagent ended with an error before it finished; verify did not run/);
  assert.equal(subs(d)[1]!.status, 'failed');
}));

test('E11 / #12: replayed events are history: duplicates ignored, an old prompt does not close a newer request, a late start has no baseline', () => withDaemon(async (d, clock) => {
  const replay = (sid: string, cwd: string, h: HookInput, receivedAt?: string) =>
    d.router.process(claudeAdapter.toRouterEvent({ session_id: sid, cwd, transcript_path: path.join(d.home, `${sid}.jsonl`), ...h }, { spooled: true, ...(receivedAt ? { receivedAt } : {}) }));

  // (b) a spooled copy of an Agent call already handled
  const repo = makeRepo({ 'src/a/x.ts': 'a\n', 'other/y.ts': 'y\n' });
  try {
    const post = session(d, 'dup', repo);
    await post({ hook_event_name: 'UserPromptSubmit', prompt: L1_PROMPT, prompt_id: 'p-1' });
    await post(call('A', 'src/a/**', { toolUseId: 'toolu_A' }));
    await post(start('a1'));
    write(repo, 'src/a/x.ts', 'ok\n');
    await post({ hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'do-it-all-claude-code:coder', stop_hook_active: false });
    await replay('dup', repo, call('A', 'src/a/**', { toolUseId: 'toolu_A' }));
    await replay('dup', repo, { hook_event_name: 'UserPromptSubmit', prompt: L1_PROMPT, prompt_id: 'p-1' });   // the same prompt again
    assert.deepEqual(subs(d), [{ id: 'A', status: 'passed', agent_id: 'a1' }]);
    assert.equal(rows(d, "SELECT COUNT(*) AS c FROM requests WHERE session_id = 'dup'")[0]!.c, 1);
  } finally { rmrf(repo); }

  // (c) an old spooled prompt replayed while a newer request is live
  const post = session(d, 'old');
  await post({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT });
  clock.advance(1000);
  await replay('old', d.home, { hook_event_name: 'UserPromptSubmit', prompt: 'Fix the typo in the error message' }, '2026-11-01T00:00:00.000Z');
  assert.deepEqual(rows(d, "SELECT level, status, created_at FROM requests WHERE session_id = 'old' ORDER BY created_at"),
    [{ level: 'L0', status: 'closed', created_at: '2026-11-01T00:00:00.000Z' }, { level: 'L2', status: 'open', created_at: '2026-11-11T10:00:00.000Z' }]);
  assert.deepEqual(await post(call('X', 'src/**', { type: 'do-it-all-claude-code:architect', model: 'sonnet', effort: 'medium' })), {});

  // (d) a SubagentStart replayed late: the tree now is not the start state
  const repo2 = makeRepo({ 'src/a/x.ts': 'a\n', 'other/y.ts': 'y\n' });
  try {
    const p2 = session(d, 'late', repo2);
    await p2({ hook_event_name: 'UserPromptSubmit', prompt: L1_PROMPT });
    write(repo2, 'other/y.ts', 'edited while the daemon was down\n');
    await replay('late', repo2, call('A', 'src/a/**'));
    await replay('late', repo2, start('a9'));
    assert.equal(rows(d, "SELECT snapshot FROM agents WHERE agent_id = 'a9'")[0]!.snapshot, null);
    write(repo2, 'src/a/x.ts', 'in scope\n');
    assert.deepEqual(await p2({ hook_event_name: 'SubagentStop', agent_id: 'a9', agent_type: 'do-it-all-claude-code:coder', stop_hook_active: false }), {});
    assert.match(String(rows(d, "SELECT detail FROM signals WHERE agent_id = 'a9' AND kind = 'scope'")[0]!.detail), /^no start snapshot \(baseline unknown\)/);
  } finally { rmrf(repo2); }
}));

test('E14 / #13: SessionStart after compaction re-injects nothing once the request is closed', () => withDaemon(async d => {
  const post = session(d, 'e14');
  await post({ hook_event_name: 'UserPromptSubmit', prompt: L1_PROMPT });
  assert.match((await post({ hook_event_name: 'SessionStart', source: 'compact' })).hookSpecificOutput?.additionalContext ?? '', /ledger \(after compaction\)/);
  await post({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' });
  assert.deepEqual(await post({ hook_event_name: 'SessionStart', source: 'compact' }), {});
  assert.deepEqual(await post({ hook_event_name: 'SessionStart', source: 'resume' }), {});
}));

test('#12: the spool folder is replayed until it stays empty (files written during the replay are picked up)', async () => {
  const { makeHome } = await import('./helpers.ts');
  const home = makeHome();
  try {
    const spool = path.join(home, 'spool');
    fs.mkdirSync(spool, { recursive: true });
    // received a minute ago: a fixed date here would age past the 24-hour replay limit (decision 100) and be dropped
    const receivedAt = new Date(Date.now() - 60_000).toISOString();
    const line = (sid: string) => JSON.stringify({ receivedAt, input: { session_id: sid, hook_event_name: 'SessionStart', cwd: home, source: 'startup' } }) + '\n';
    fs.writeFileSync(path.join(spool, '1.jsonl'), line('s-first'));
    // a relay writing while the daemon replays: simulated by an adapter that drops a new file during the first replay
    let wrote = false;
    const adapter = {
      ...claudeAdapter,
      toRouterEvent: (h: Record<string, unknown>, o?: { receivedAt?: string; spooled?: boolean }) => {
        if (!wrote) { wrote = true; fs.writeFileSync(path.join(spool, '2.jsonl'), line('s-second')); }
        return claudeAdapter.toRouterEvent(h, o);
      },
    };
    const d = await startTestDaemon({ home, adapter });
    try {
      assert.equal(d.replay.files, 2);
      assert.deepEqual(fs.readdirSync(spool), []);
      assert.deepEqual(rows(d, 'SELECT session_id FROM events ORDER BY id').map(r => r.session_id), ['s-first', 's-second']);
    } finally { await d.close(); }
  } finally { rmrf(home); }
});
