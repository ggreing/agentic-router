// Decision 83: a lone writer works in the user's own checkout (no worktree). The scope check must count
// only what changed during the subtask, never the user's uncommitted work that was already there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, makeRepo, postHook, rmrf, rows, startTestDaemon, write, type HookInput, type TestDaemon } from './helpers.ts';

const L1_PROMPT = 'Fix the bug where parse() fails on empty input in src/parse.ts';
type Out = { decision?: string; reason?: string };

async function withDaemon(fn: (d: TestDaemon) => Promise<void>): Promise<void> {
  const d = await startTestDaemon({ verify: { resolveCommands: async () => [{ kind: 'test', command: 'node check.cjs' }] } });
  try { await fn(d); } finally { await d.close(); rmrf(d.home); }
}

/** A repo with the user's own uncommitted work: a modified tracked file and an untracked file, both outside src/. */
function repoWithUserChanges(): string {
  const repo = makeRepo({ 'src/parse.ts': 'export const parse = () => 1;\n', 'docs/notes.md': 'notes\n', 'check.cjs': 'process.exit(0)\n' });
  write(repo, 'docs/notes.md', 'notes\nuser edit, not committed\n');
  write(repo, 'scratch.txt', 'user scratch file\n');
  return repo;
}

async function dispatch(d: TestDaemon, cwd: string, sid: string, agentId: string): Promise<(h: HookInput) => Promise<Out>> {
  const post = async (h: HookInput) => {
    const r = await postHook(d.port, { session_id: sid, cwd, transcript_path: path.join(d.home, `${sid}.jsonl`), ...h });
    assert.equal(r.status, 200, r.text);
    return r.body as Out;
  };
  await post({ hook_event_name: 'UserPromptSubmit', prompt: L1_PROMPT });
  await post({ hook_event_name: 'PreToolUse', tool_name: 'Agent',
    tool_input: { subagent_type: 'do-it-all-claude-code:coder', prompt: '[subtask:A] fix parse\n[scope: src/**]', model: 'haiku', effort: 'low' } });
  await post({ hook_event_name: 'SubagentStart', agent_id: agentId, agent_type: 'do-it-all-claude-code:coder' });
  return post;
}

const scopeDetail = (d: TestDaemon) => String(rows(d, 'SELECT detail FROM signals WHERE kind = ? ORDER BY id DESC LIMIT 1', 'scope')[0]?.detail);

test('shared work tree: the user\'s uncommitted changes are not counted; one in-scope edit passes', () => withDaemon(async d => {
  const repo = repoWithUserChanges();
  try {
    const post = await dispatch(d, repo, 'shared-ok', 'ag-1');
    assert.equal(rows(d, 'SELECT snapshot FROM agents')[0]!.snapshot !== null, true);
    write(repo, 'src/parse.ts', 'export const parse = (s = "") => s.length;\n');
    const out = await post({ hook_event_name: 'SubagentStop', agent_id: 'ag-1', agent_type: 'do-it-all-claude-code:coder', stop_hook_active: false });
    assert.deepEqual(out, {});
    assert.deepEqual(rows(d, 'SELECT status, verdict FROM subtasks'), [{ status: 'passed', verdict: 'meet' }]);
    assert.equal(scopeDetail(d), 'shared work tree (the user\'s checkout; 2 uncommitted change(s) that were already there are not counted): 1 file(s) changed during the subtask');
    // the user's work is untouched
    assert.match(git(repo, 'status', '--porcelain'), /M docs\/notes\.md/);
  } finally { rmrf(repo); }
}));

test('shared work tree: an edit outside the scope fails, including a further edit to a file the user had changed', () => withDaemon(async d => {
  const repo = repoWithUserChanges();
  try {
    const post = await dispatch(d, repo, 'shared-bad', 'ag-2');
    write(repo, 'src/parse.ts', 'export const parse = () => 2;\n');
    write(repo, 'docs/notes.md', 'notes\nuser edit, not committed\nand the subagent appended this\n');
    // no transcript: every out-of-scope change counts (decision 95: the strict fallback)
    const out = await post({ hook_event_name: 'SubagentStop', agent_id: 'ag-2', agent_type: 'do-it-all-claude-code:coder', stop_hook_active: false });
    assert.equal(out.decision, 'block');
    assert.match(out.reason ?? '', /shared work tree \(the user's checkout; 1 uncommitted change\(s\) that were already there are not counted\): changed outside the allowed scope \[src\/\*\*\]: docs\/notes\.md/);
    assert.ok(!(out.reason ?? '').includes('scratch.txt'));
    assert.match(out.reason ?? '', /ran in the shared work tree \(the user's checkout\)\. Changes that were already uncommitted when you started are not counted as yours; do not revert or commit them\./);
  } finally { rmrf(repo); }
}));

test('isolated worktree (isolation "worktree" on the call): checks run there and are not marked shared', () => withDaemon(async d => {
  const repo = repoWithUserChanges();
  const wt = path.join(repo, '.claude', 'worktrees', 'agent-ag-3');
  try {
    git(repo, 'worktree', 'add', '-q', '-b', 'worktree-agent-ag-3', wt);
    const post = await dispatch(d, wt, 'isolated', 'ag-3');
    write(wt, 'src/parse.ts', 'export const parse = () => 3;\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-qm', '[subtask:A] fix parse');
    const out = await post({ hook_event_name: 'SubagentStop', agent_id: 'ag-3', agent_type: 'do-it-all-claude-code:coder', stop_hook_active: false });
    assert.deepEqual(out, {});
    assert.equal(scopeDetail(d), '1 file(s) changed during the subtask');
    assert.equal(JSON.parse(String(rows(d, 'SELECT snapshot FROM agents')[0]!.snapshot)).isolated, true);
  } finally {
    try { git(repo, 'worktree', 'remove', '--force', wt); } catch { /* best effort */ }
    rmrf(repo);
  }
}));

// ------------------------------------------------------------------ integration run 3, E2: async PostToolUse before SubagentStart

async function asyncLaunch(d: TestDaemon, cwd: string, sid: string, agentId: string): Promise<(h: HookInput) => Promise<Out>> {
  const post = async (h: HookInput) => {
    const r = await postHook(d.port, { session_id: sid, cwd, transcript_path: path.join(d.home, `${sid}.jsonl`), ...h });
    assert.equal(r.status, 200, r.text);
    return r.body as Out;
  };
  const prompt = '[subtask:A] fix parse\n[scope: src/**]';
  await post({ hook_event_name: 'UserPromptSubmit', prompt: L1_PROMPT });
  await post({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'do-it-all-claude-code:coder', prompt, model: 'haiku', effort: 'low' } });
  await post({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'do-it-all-claude-code:coder', prompt, model: 'haiku', effort: 'low' },
    tool_response: { isAsync: true, status: 'async_launched', agentId, prompt, resolvedModel: 'claude-haiku-5-5' } });
  return post;
}

test('E2 order (async PostToolUse before SubagentStart): the start still records cwd, snapshot and the guard file', () => withDaemon(async d => {
  const repo = repoWithUserChanges();
  try {
    const post = await asyncLaunch(d, repo, 'e2-order', 'ag-e2');
    assert.deepEqual(rows(d, 'SELECT pairing, cwd, snapshot FROM agents'), [{ pairing: 'confirmed', cwd: null, snapshot: null }]);
    await post({ hook_event_name: 'SubagentStart', agent_id: 'ag-e2', agent_type: 'do-it-all-claude-code:coder' });
    const [a] = rows(d, 'SELECT pairing, cwd, snapshot, subtask_id FROM agents');
    assert.equal(a!.pairing, 'confirmed');
    assert.equal(a!.cwd, repo);
    const snap = JSON.parse(String(a!.snapshot));
    assert.equal(snap.isolated, false);
    assert.deepEqual(Object.keys(snap.dirty).sort(), ['docs/notes.md', 'scratch.txt']);
    assert.deepEqual(rows(d, 'SELECT status, agent_id FROM subtasks'), [{ status: 'running', agent_id: 'ag-e2' }]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(d.home, 'agents', 'ag-e2.json'), 'utf8')).subtaskId, 'A');

    write(repo, 'src/parse.ts', 'export const parse = () => 4;\n');
    assert.deepEqual(await post({ hook_event_name: 'SubagentStop', agent_id: 'ag-e2', agent_type: 'do-it-all-claude-code:coder', stop_hook_active: false }), {});
    assert.equal(scopeDetail(d), 'shared work tree (the user\'s checkout; 2 uncommitted change(s) that were already there are not counted): 1 file(s) changed during the subtask');
    assert.deepEqual(rows(d, 'SELECT status, verdict FROM subtasks'), [{ status: 'passed', verdict: 'meet' }]);
  } finally { rmrf(repo); }
}));

test('no start snapshot at all: the scope is reported against HEAD as baseline unknown, warned, and not failed', () => withDaemon(async d => {
  const repo = repoWithUserChanges();
  try {
    const post = await asyncLaunch(d, repo, 'no-snap', 'ag-ns');   // SubagentStart never arrives
    write(repo, 'src/parse.ts', 'export const parse = () => 5;\n');
    const out = await post({ hook_event_name: 'SubagentStop', agent_id: 'ag-ns', agent_type: 'do-it-all-claude-code:coder', stop_hook_active: false });
    assert.deepEqual(out, {});
    assert.equal(scopeDetail(d), 'no start snapshot (baseline unknown): 3 uncommitted change(s) against HEAD; outside the allowed scope [src/**]: docs/notes.md, scratch.txt '
      + '(may include the user\'s own uncommitted changes; not counted as a failure)');
    assert.deepEqual(rows(d, 'SELECT status, verdict FROM subtasks'), [{ status: 'passed', verdict: 'meet' }]);
    assert.match(fs.readFileSync(path.join(d.home, 'logs', 'daemon.log'), 'utf8'), /scope check without a start snapshot/);
  } finally { rmrf(repo); }
}));

// ------------------------------------------------------------------ decision 95: further edits follow the normal rule

/** A transcript whose only edit tool call wrote `rel` (tool input path only; the daemon reads nothing else). */
function editTranscript(d: TestDaemon, agentId: string, repo: string, rel: string): string {
  const file = path.join(d.home, 'subagents', `agent-${agentId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', message: { id: 'm1', model: 'claude-haiku-5-5',
    content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(repo, rel), old_string: 'x', new_string: 'y' } }],
    usage: { input_tokens: 1, output_tokens: 1 } } }) + '\n');
  return file;
}

test('decision 95: the subagent may further edit an in-scope file the user had already changed', () => withDaemon(async d => {
  const repo = repoWithUserChanges();
  try {
    write(repo, 'src/parse.ts', 'export const parse = () => "user draft";\n');   // the user's uncommitted in-scope change
    const post = await dispatch(d, repo, 'further-in', 'ag-f1');
    write(repo, 'src/parse.ts', 'export const parse = (s = "") => s.length; // finished by the subagent\n');
    const out = await post({ hook_event_name: 'SubagentStop', agent_id: 'ag-f1', agent_type: 'do-it-all-claude-code:coder', stop_hook_active: false,
      agent_transcript_path: editTranscript(d, 'ag-f1', repo, 'src/parse.ts') });
    assert.deepEqual(out, {});
    assert.deepEqual(rows(d, 'SELECT status, verdict FROM subtasks'), [{ status: 'passed', verdict: 'meet' }]);
  } finally { rmrf(repo); }
}));

test('decision 95: a further edit to the user\'s out-of-scope file counts only when the subagent\'s edit tools made it', () => withDaemon(async d => {
  const repo = repoWithUserChanges();
  try {
    // not touched by the subagent's tools (the user, or another process): reported, not failed
    let post = await dispatch(d, repo, 'further-out-1', 'ag-f2');
    write(repo, 'src/parse.ts', 'export const parse = () => 6;\n');
    write(repo, 'docs/notes.md', 'notes\nuser edit, not committed\nthe user kept typing\n');
    let out = await post({ hook_event_name: 'SubagentStop', agent_id: 'ag-f2', agent_type: 'do-it-all-claude-code:coder', stop_hook_active: false,
      agent_transcript_path: editTranscript(d, 'ag-f2', repo, 'src/parse.ts') });
    assert.deepEqual(out, {});
    assert.match(scopeDetail(d), /changed outside the scope but not by this subagent's edit tools \(may be another process; not counted\): docs\/notes\.md/);

    // made by the subagent's Edit tool: fails
    post = await dispatch(d, repo, 'further-out-2', 'ag-f3');
    write(repo, 'docs/notes.md', 'notes\nuser edit, not committed\nthe user kept typing\nand the subagent edited it\n');
    out = await post({ hook_event_name: 'SubagentStop', agent_id: 'ag-f3', agent_type: 'do-it-all-claude-code:coder', stop_hook_active: false,
      agent_transcript_path: editTranscript(d, 'ag-f3', repo, 'docs/notes.md') });
    assert.equal(out.decision, 'block');
    assert.match(out.reason ?? '', /changed outside the allowed scope \[src\/\*\*\]: docs\/notes\.md/);
  } finally { rmrf(repo); }
}));
