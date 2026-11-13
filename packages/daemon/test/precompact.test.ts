// pre_compact (spec 3.6): plain-text compaction guidance while a request is in progress, '' otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { TEAM_L1_PRESETS, postHook, rmrf, startTestDaemon, type HookInput, type TestDaemon } from './helpers.ts';

const L1_PROMPT = 'Fix the bug where parse() fails on empty input in src/parse.ts';

async function withDaemon(fn: (d: TestDaemon) => Promise<void>): Promise<void> {
  const d = await startTestDaemon({ presets: TEAM_L1_PRESETS });   // a delegating L1 team (no T6 re-plan)
  try { await fn(d); } finally { await d.close(); rmrf(d.home); }
}

test('guidance keeps level, subtasks with step/status/scope, the unfinished ones and the prompt format', () => withDaemon(async d => {
  const sid = 'pc';
  const b = { session_id: sid, cwd: d.home, transcript_path: path.join(d.home, 't.jsonl') };
  const post = (h: HookInput) => postHook(d.port, { ...b, ...h });
  const preCompact = async () => {
    const r = await post({ hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: '' });
    assert.equal(r.status, 200);
    assert.match(String(r.headers['content-type']), /^text\/plain/);
    return r.text;
  };
  assert.equal(await preCompact(), '');                                         // no request yet

  await post({ hook_event_name: 'UserPromptSubmit', prompt: L1_PROMPT });
  const agent = (tag: string, scope?: string) => post({ hook_event_name: 'PreToolUse', tool_name: 'Agent',
    tool_input: { subagent_type: 'do-it-all-claude-code:coder', prompt: `[subtask:${tag}] work${scope ? `\n[scope: ${scope}]` : ''}`, model: 'haiku', effort: 'low' } });
  await agent('A', 'src/a/**, test/a/**');
  await post({ hook_event_name: 'SubagentStart', agent_id: 'ag-a', agent_type: 'do-it-all-claude-code:coder' });
  await agent('B');

  const text = await preCompact();
  const lines = text.split('\n');
  assert.equal(lines[0], 'Do It All Claude Code: keep this team state in the compacted summary.');
  assert.match(text, /- Request r-[\w-]+: level L1 \(source=rule\), preset L1, budget \$2, spent \$0\.0000\./);
  assert.ok(lines.includes('  - A: coder#0 @s1 (model=haiku, effort=low) running; scope: src/a/**, test/a/**'), text);
  assert.ok(lines.includes('  - B: coder#1 @s1 (model=haiku, effort=low) pending; scope: whole repo'), text);
  assert.match(text, /- Unfinished: A, B\./);
  assert.match(text, /first line \[subtask:<ID>\], second line \[scope: <glob>, <glob>\]/);

  // after the turn ends the request is closed: nothing to keep
  await post({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.' });
  assert.equal(await preCompact(), '');
}));
