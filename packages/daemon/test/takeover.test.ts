// Decision 145: a writer subtask that changed nothing is `no_changes` (neither pass nor miss), and a lead that edits
// files itself after delegating makes the request a `lead_takeover`, kept out of the auto-release arms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Ledger } from '../src/ledger.ts';
import { minimalPayload } from '../src/payload.ts';
import { releaseArms } from '../src/routing.ts';
import { makeHome, makeRepo, postHook, rmrf, rows, startTestDaemon, write, type HookInput, type TestDaemon } from './helpers.ts';

const L2_PROMPT = 'Refactor the validation module across multiple files and add an audit log';
const MARK = 'ZQX-lead-edit-145';
type Rec = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any

async function withRepo(fn: (d: TestDaemon, repo: string, post: (h: HookInput) => Promise<Rec>) => Promise<void>): Promise<void> {
  const repo = makeRepo({ 'src/a.ts': 'a\n' });
  const d = await startTestDaemon({ verify: { resolveCommands: async () => [] } });
  const post = async (h: HookInput) => {
    const r = await postHook(d.port, { session_id: 's', cwd: repo, transcript_path: path.join(d.home, 's.jsonl'), ...h });
    assert.equal(r.status, 200, r.text);
    return r.body as Rec;
  };
  try { await fn(d, repo, post); } finally { await d.close(); rmrf(d.home); rmrf(repo); }
}
let seq = 0;
const dispatch = (tag: string, role = 'coder'): HookInput => ({
  hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: `toolu_t${++seq}`,
  tool_input: { subagent_type: `do-it-all-claude-code:${role}`, prompt: `[subtask:${tag}] work\n[scope: src/**]`, model: role === 'coder' ? 'haiku' : 'sonnet', effort: role === 'coder' ? 'low' : 'medium' },
});
const run = async (post: (h: HookInput) => Promise<Rec>, tag: string, agent: string, role: string, edit?: () => void): Promise<Rec> => {
  assert.deepEqual(await post(dispatch(tag, role)), {});
  await post({ hook_event_name: 'SubagentStart', agent_id: agent, agent_type: `do-it-all-claude-code:${role}` });
  edit?.();
  await post({ hook_event_name: 'SubagentStop', agent_id: agent, agent_type: `do-it-all-claude-code:${role}`, stop_hook_active: false });
  return post({ hook_event_name: 'UserPromptSubmit', prompt: `<task-notification>\n<task-id>${agent}</task-id>\n<status>completed</status>\n</task-notification>` });
};
const sub = (d: TestDaemon, id: string) => rows(d, 'SELECT status, verdict FROM subtasks WHERE id = ?', id)[0];

test('decision 145: a coder that changed no file in its scope is no_changes, not a pass; one that did is a pass; a reviewer is not a writer', () => withRepo(async (d, repo, post) => {
  await post({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT });
  const none = await run(post, 'A', 'a1', 'coder');
  assert.deepEqual(sub(d, 'A'), { status: 'hitl', verdict: 'no_changes' });
  assert.match(none.hookSpecificOutput?.additionalContext ?? '', /subtask A \(coder[^)]*\): the coder changed no file in its scope; verify ran on an unchanged tree, so this is not a pass.*do not make the change yourself/);
  await run(post, 'B', 'b1', 'coder', () => write(repo, 'src/b.ts', 'b\n'));
  assert.deepEqual(sub(d, 'B'), { status: 'passed', verdict: 'meet' });
  await run(post, 'RV', 'r1', 'reviewer');
  assert.deepEqual(sub(d, 'RV'), { status: 'passed', verdict: 'meet' }, 'a reviewer changes nothing by design');
  // no step-up for no_changes: the slot was not raised
  assert.equal(rows(d, "SELECT COUNT(*) AS c FROM slots WHERE role = 'coder' AND up_count > 0")[0]!.c, 0);
  await post({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.' });
  await d.router.drain();
  const record = JSON.parse(String(rows(d, 'SELECT record FROM request_records')[0]!.record)) as Rec;
  assert.deepEqual(record.subtasks.map((s: Rec) => [s.id, s.status, s.verdict]), [['A', 'hitl', 'no_changes'], ['B', 'passed', 'meet'], ['RV', 'passed', 'meet']]);
  assert.equal(record.outcome, 'delegated');
}));

test('decision 145: the lead editing files after it delegated makes the request a lead takeover; before a dispatch, or by a subagent, it does not', () => withRepo(async (d, repo, post) => {
  const edit = (file: string, agent?: string): HookInput => ({
    hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: `toolu_e${++seq}`, ...(agent ? { agent_id: agent, agent_type: 'do-it-all-claude-code:coder' } : {}),
    tool_input: { file_path: path.join(repo, file), old_string: 'a', new_string: `${MARK} a` }, tool_response: { filePath: path.join(repo, file), structuredPatch: [MARK] },
  });
  await post({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT });
  await post(edit('src/prep.ts'));                                     // before any dispatch: the lead preparing, not a takeover
  await run(post, 'A', 'a1', 'coder', () => write(repo, 'src/a.ts', 'changed\n'));
  await post(edit('src/a.ts', 'a1'));                                  // a subagent's edit: not the lead's
  assert.deepEqual(rows(d, 'SELECT lead_edits FROM requests'), [{ lead_edits: 0 }]);
  await post(edit('src/a.ts'));
  await post(edit('src/b.ts'));
  await post(edit('src/a.ts'));
  assert.deepEqual(rows(d, 'SELECT lead_edits FROM requests'), [{ lead_edits: 3 }]);
  await post({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.' });
  await d.router.drain();
  const record = JSON.parse(String(rows(d, 'SELECT record FROM request_records')[0]!.record)) as Rec;
  assert.equal(record.outcome, 'lead_takeover');
  assert.deepEqual(record.leadEdits, { calls: 3, files: 2 });
  assert.deepEqual(rows(d, 'SELECT outcome FROM requests'), [{ outcome: 'lead_takeover' }]);
  // the stored edit events keep the tool and the path only (decision 141 rules), never the edit's content
  const stored = rows(d, "SELECT payload FROM events WHERE type = 'post_tool_use'").map(r => String(r.payload));
  assert.ok(stored.length >= 4 && stored.every(p => !p.includes(MARK)), 'no edit content is stored');
  assert.ok(stored.some(p => JSON.parse(p).tool_input?.file_path === path.join(repo, 'src/b.ts')));
}));

test('decision 145: lead takeovers stay out of the auto-release arms', () => {
  const l = new Ledger(':memory:');
  const at = new Date(Date.now() - 86_400_000).toISOString();
  const seed = (n: number, outcome: string) => {
    for (let i = 0; i < n; i++) {
      const record = { version: 1, plan: { level: 'L2', leadDirect: false, leadClass: 'opus', holdout: null }, outcome, subtasks: [{ status: 'passed' }], costs: { unknown: false } };
      l.upsertRecord({ requestId: `${outcome}-${i}`, sessionId: 's', createdAt: at, closedAt: at, kind: 'team', level: 'L2', finalLevel: 'L2', outcome, changedFiles: 1,
        linesAdded: 1, linesRemoved: 0, durationMs: 1, activeMs: 1, subtaskUsd: 0.1, leadUsd: 0.1, totalUsd: 0.2, record, prompt: null, acceptance: 'accepted', acceptSignals: [] });
    }
  };
  seed(5, 'delegated');
  seed(4, 'lead_takeover');
  const arms = releaseArms(l, new Date().toISOString()).get('opus|L2');
  assert.equal(arms?.delegated.n, 5, 'only the real delegations count');
  l.close();
});

test('decision 145: the relay answers a subagent\'s edit at once and spools the lead\'s by path only', async () => {
  const relay = await import(pathToFileURL(fileURLToPath(new URL('../../../plugin/hooks/relay.mjs', import.meta.url))).href) as {
    relay(raw: string, o: { home: string; write(s: string): void }): Promise<void>; minimalHookInput(x: unknown): unknown;
  };
  const home = makeHome({ daemonPort: 1 });   // nothing listens on port 1: the lead's edit is spooled
  try {
    const out: string[] = [];
    const input = (agent?: string) => JSON.stringify({ session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Write', ...(agent ? { agent_id: agent } : {}),
      tool_input: { file_path: '/r/src/x.ts', content: `${MARK} body` }, tool_response: { type: 'create', content: MARK } });
    await relay.relay(input('a1'), { home, write: s => { out.push(s); } });
    assert.deepEqual(out, ['{}']);
    assert.ok(!fs.existsSync(path.join(home, 'spool')), 'a subagent\'s edit never reaches the daemon or the spool');
    await relay.relay(input(), { home, write: s => { out.push(s); } });
    const spooled = fs.readdirSync(path.join(home, 'spool')).map(f => fs.readFileSync(path.join(home, 'spool', f), 'utf8')).join('');
    assert.ok(!spooled.includes(MARK));
    assert.deepEqual((JSON.parse(spooled) as { input: Rec }).input.tool_input, { file_path: '/r/src/x.ts' });
    // the relay's minimal form equals the daemon's for the edit tools too
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      const raw = { hook_event_name: 'PostToolUse', tool_name: tool, tool_input: { file_path: '/r/a.ts', notebook_path: '/r/n.ipynb', new_string: MARK, content: MARK } };
      assert.deepEqual(relay.minimalHookInput(raw), minimalPayload(raw), tool);
      assert.ok(!JSON.stringify(minimalPayload(raw)).includes(MARK), tool);
    }
  } finally { rmrf(home); }
});

test('decision 145: a no_changes writer does not make the request fail (dashboard success, auto-release accepted count); a miss still does', async () => {
  const { recordVerifyOk } = await import('../src/routing.ts');
  const rec = (...subs: Array<[string, string | null]>) => ({ outcome: 'delegated', subtasks: subs.map(([status, verdict]) => ({ status, verdict })) });
  assert.equal(recordVerifyOk(rec(['passed', 'meet'], ['hitl', 'no_changes'])), true);
  assert.equal(recordVerifyOk(rec(['hitl', 'no_changes'])), true);
  assert.equal(recordVerifyOk(rec(['passed', 'meet'], ['hitl', 'miss'])), false, 'verify failed after the step-ups');
  assert.equal(recordVerifyOk(rec(['hitl', 'rejected'])), false);
  assert.equal(recordVerifyOk(rec(['hitl', 'unverified'])), false, 'unchanged: verify did not run (decision 138)');
  assert.equal(recordVerifyOk(rec(['failed', 'miss'])), false);
});
