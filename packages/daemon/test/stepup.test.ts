// Spec 3.5 step changes (a miss raises the slot one step, at most 3 times) and decision 122 (a check that
// cannot run in this environment is not the subagent's failure).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { StatusView } from '../src/router.ts';
import { projectCommands } from '../src/verify-source.ts';
import { missingTool } from '../src/verify.ts';
import { getStatus, makeRepo, postHook, rmrf, rows, startTestDaemon, write, type HookInput, type TestDaemon } from './helpers.ts';

const L2_PROMPT = 'Refactor the validation module across multiple files and add an audit log';
type Out = { decision?: string; reason?: string; hookSpecificOutput?: { additionalContext?: string; permissionDecision?: string; permissionDecisionReason?: string } };

async function withRepo(files: Record<string, string>, commands: Array<{ kind: 'test' | 'build'; command: string }>, fn: (d: TestDaemon, repo: string) => Promise<void>): Promise<void> {
  const repo = makeRepo({ 'src/a.ts': 'a\n', ...files });
  const d = await startTestDaemon({ verify: { resolveCommands: async () => commands } });
  try { await fn(d, repo); } finally { await d.close(); rmrf(d.home); rmrf(repo); }
}
const session = (d: TestDaemon, sid: string, cwd: string) => async (h: HookInput): Promise<Out> => {
  const r = await postHook(d.port, { session_id: sid, cwd, transcript_path: path.join(d.home, `${sid}.jsonl`), ...h });
  assert.equal(r.status, 200, r.text);
  return r.body as Out;
};
let seq = 0;
const call = (tag: string, model: string, effort: string): HookInput => ({
  hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: `toolu_s${++seq}`,
  tool_input: { subagent_type: 'do-it-all-claude-code:coder', prompt: `[subtask:${tag}] work\n[scope: src/**]`, model, effort },
});
const start = (id: string): HookInput => ({ hook_event_name: 'SubagentStart', agent_id: id, agent_type: 'do-it-all-claude-code:coder' });
const stop = (id: string, again = false): HookInput => ({ hook_event_name: 'SubagentStop', agent_id: id, agent_type: 'do-it-all-claude-code:coder', stop_hook_active: again });
const notify = (id: string): HookInput => ({ hook_event_name: 'UserPromptSubmit', prompt: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n</task-notification>` });
const denied = (o: Out) => (o.hookSpecificOutput?.permissionDecision === 'deny' ? o.hookSpecificOutput.permissionDecisionReason ?? '' : '');

/** Runs one subtask whose verify fails twice (a miss). */
async function miss(post: (h: HookInput) => Promise<Out>, repo: string, tag: string, agent: string, model: string, effort: string): Promise<Out> {
  assert.deepEqual(await post(call(tag, model, effort)), {});
  await post(start(agent));
  write(repo, 'src/a.ts', `${tag}\n`);
  assert.equal((await post(stop(agent))).decision, 'block');
  assert.deepEqual(await post(stop(agent, true)), {});
  return post(notify(agent));
}

test('spec 3.5: a miss raises the slot one step; the next call for it must use the new step', () => withRepo({ 'fail.cjs': 'console.error("boom"); process.exit(1)\n' }, [{ kind: 'test', command: 'node fail.cjs' }], async (d, repo) => {
  const post = session(d, 'up', repo);
  await post({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT });
  const n = await miss(post, repo, 'A', 'a1', 'haiku', 'low');
  assert.match(n.hookSpecificOutput?.additionalContext ?? '', /miss.*The coder slot 0 now runs one step higher, at s2 \(model="haiku", effort="high"\): a new attempt must use these values\./);
  assert.deepEqual(rows(d, "SELECT status, verdict, up_count FROM subtasks WHERE id = 'A'"), [{ status: 'failed', verdict: 'miss', up_count: 1 }]);
  assert.deepEqual(rows(d, 'SELECT role, slot, step, up_count FROM slots'), [{ role: 'coder', slot: 0, step: 's2', up_count: 1 }]);
  // the old step is refused for that slot (it is the first free one), the new one is taken
  assert.match(denied(await post(call('A2', 'haiku', 'low'))), /the coder runs at step s2 \(model="haiku", effort="high"\) for this L2 request \(slot 0 was raised to s2 after a miss\)/);
  assert.deepEqual(await post(call('A2', 'haiku', 'high')), {});
  assert.deepEqual(rows(d, "SELECT slot, step FROM subtasks WHERE id = 'A2'"), [{ slot: 0, step: 's2' }]);
  // with slot 0 busy, the second coder slot still starts at s1
  assert.deepEqual(await post(call('B', 'haiku', 'low')), {});
  assert.deepEqual(rows(d, "SELECT slot, step FROM subtasks WHERE id = 'B'"), [{ slot: 1, step: 's1' }]);
  const st = (await getStatus(d.port, 'up')).body as StatusView;
  assert.deepEqual(st.roles.filter(r => r.role === 'coder').map(r => [r.slot, r.step]), [[0, 's2'], [1, 's1']]);
  assert.deepEqual(st.stepAdjust, { up: 'on', down: 'on' });
}));

test('spec 3.5: after 3 step-ups a further miss is the user\'s decision', () => withRepo({ 'fail.cjs': 'process.exit(1)\n' }, [{ kind: 'test', command: 'node fail.cjs' }], async (d, repo) => {
  const post = session(d, 'top', repo);
  await post({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT });
  const req = String(rows(d, 'SELECT id FROM requests')[0]!.id);
  d.ledger.setSlot(req, 'coder', 0, 's4', 3, new Date().toISOString());     // raised three times already
  const n = await miss(post, repo, 'A', 'a1', 'sonnet', 'high');
  assert.deepEqual(rows(d, "SELECT status, verdict FROM subtasks WHERE id = 'A'"), [{ status: 'hitl', verdict: 'miss' }]);
  assert.deepEqual(rows(d, 'SELECT step, up_count FROM slots'), [{ step: 's4', up_count: 3 }]);
  assert.match(n.hookSpecificOutput?.additionalContext ?? '', /verify failed again at step s4 after 3 step-ups .*Ask the user how to continue/);
}));

test('decision 122: a command that is not installed here leaves the subtask unverified (no retry, no step-up)', () => withRepo({
  'cmdstyle.cjs': 'console.log("> pretest\\n> eslint ."); console.error("\'eslint\' is not recognized as an internal or external command,\\noperable program or batch file."); process.exit(1)\n',
}, [{ kind: 'build', command: 'node cmdstyle.cjs' }, { kind: 'test', command: 'no-such-tool-xyz --check' }], async (d, repo) => {
  const post = session(d, 'env', repo);
  await post({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT });
  assert.deepEqual(await post(call('A', 'haiku', 'low')), {});
  await post(start('e1'));
  write(repo, 'src/a.ts', 'changed\n');
  assert.deepEqual(await post(stop('e1')), {});                              // not blocked
  assert.deepEqual(rows(d, "SELECT status, verdict FROM subtasks WHERE id = 'A'"), [{ status: 'hitl', verdict: 'unverified' }]);
  assert.deepEqual(rows(d, 'SELECT COUNT(*) AS c FROM slots')[0]!.c, 0);
  const n = await post(notify('e1'));
  assert.match(n.hookSpecificOutput?.additionalContext ?? '', /verify could not run in this environment \(node cmdstyle\.cjs: environment: eslint not found \(exit 1\); no-such-tool-xyz --check: environment: no-such-tool-xyz not found \(exit 127\)\); this is not counted as a failure/);
}));

test('decision 122: a real failure next to a missing tool is still a failure (only the real one is reported)', () => withRepo({ 'fail.cjs': 'console.error("assertion failed"); process.exit(1)\n' },
  [{ kind: 'build', command: 'no-such-tool-xyz' }, { kind: 'test', command: 'node fail.cjs' }], async (d, repo) => {
    const post = session(d, 'mix', repo);
    await post({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT });
    await post(call('A', 'haiku', 'low'));
    await post(start('m1'));
    write(repo, 'src/a.ts', 'changed\n');
    const out = await post(stop('m1'));
    assert.equal(out.decision, 'block');
    assert.match(out.reason ?? '', /node fail\.cjs: exit 1[\s\S]*assertion failed/);
    assert.doesNotMatch(out.reason ?? '', /no-such-tool-xyz/);
  }));

test('decision 122: what counts as a missing tool', () => {
  assert.equal(missingTool(1, "'eslint' is not recognized as an internal or external command,\r\noperable program or batch file."), 'eslint not found');
  assert.equal(missingTool(127, 'bash: line 1: pytest: command not found\n'), 'pytest not found');
  assert.equal(missingTool(127, '/bin/sh: 1: tox: not found\n'), 'tox not found');
  assert.equal(missingTool(127, ''), 'a command was not found (exit 127)');
  assert.equal(missingTool(1, 'FAIL test/a.test.ts\nexpected 1 to be 2\n'), undefined);
  assert.equal(missingTool(2, 'Error: file not found: config.json\n'), undefined);
  assert.equal(missingTool(1, '/usr/bin/python: No module named pytest\n'), 'pytest not installed');
  assert.equal(missingTool(1, 'ModuleNotFoundError: No module named "mypkg"\n'), undefined);   // the project's own import error is a real failure
  // ifAnyExists in a project verify.json: a non-empty list of repo-relative paths
  assert.deepEqual(projectCommands({ coder: [{ command: 'pytest -q', ifAnyExists: ['pytest.ini', 'tox.ini'] }] }, 'coder'),
    [{ kind: 'test', command: 'pytest -q', ifAnyExists: ['pytest.ini', 'tox.ini'] }]);
  assert.throws(() => projectCommands({ coder: [{ command: 'x', ifAnyExists: [] }] }, 'coder'), /ifAnyExists must be a non-empty list/);
  assert.throws(() => projectCommands({ coder: [{ command: 'x', ifAnyExists: ['../up'] }] }, 'coder'), /ifAnyExists must be/);
});
