// User acceptance on the daemon (spec 3.8, decision 137): the window of the next two user prompts, the file
// checks against a real git work tree, the re-ask by wording, and what is stored (signals and numbers only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROMPT_MEMORY_TTL_MS, PromptMemory } from '../src/accept.ts';
import { AWAITING_USER_MARKER } from '../src/continuation.ts';
import { metricsSummary } from '../src/metrics.ts';
import { checkEndState, requestEndState, takeRequestSnapshot, CLEAN } from '../src/record.ts';
import { git, makeRepo, postHook, rmrf, rows, startTestDaemon, write, type HookInput, type TestDaemon } from './helpers.ts';

const ASK = 'Fix the bug where parse() fails on empty input in src/parse.ts';
const OTHER = 'Rename the config loader to loadSettings across the cli package and update its callers';
const THIRD = 'Add a changelog entry for the release and bump the version in package.json';
type Out = { systemMessage?: string; hookSpecificOutput?: { additionalContext?: string } };

async function withDaemon(fn: (d: TestDaemon, repo: string, s: ReturnType<typeof session>) => Promise<void>, sid = 'acc'): Promise<void> {
  const repo = makeRepo({ 'src/parse.ts': 'export const parse = () => 1;\n', 'src/other.ts': 'x\n', 'README.md': 'r\n' });
  git(repo, 'config', 'core.autocrlf', 'false');
  const d = await startTestDaemon({ verify: { resolveCommands: async () => [] } });
  try { await fn(d, repo, session(d, sid, repo)); } finally { await d.close(); rmrf(d.home); rmrf(repo); }
}

function session(d: TestDaemon, sid: string, cwd: string) {
  const post = async (h: HookInput): Promise<Out> => {
    const r = await postHook(d.port, { session_id: sid, cwd, transcript_path: path.join(d.home, `${sid}.jsonl`), ...h });
    assert.equal(r.status, 200, r.text);
    return r.body as Out;
  };
  /** One user turn: the prompt, the lead's own edits, the end of the turn; then everything the daemon does afterwards. */
  const turn = async (prompt: string, edits: Record<string, string> = {}): Promise<void> => {
    await post({ hook_event_name: 'UserPromptSubmit', prompt });
    await d.router.drain();   // the request's start state is taken after the hook answers
    for (const [f, body] of Object.entries(edits)) write(cwd, f, body);
    await post({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.' });
    await d.router.drain();
  };
  return { post, turn };
}
/** Acceptance of the session's requests in order, with the kinds of signals seen. */
const seen = (d: TestDaemon, sid = 'acc') => rows(d, 'SELECT r.acceptance, r.accept_signals FROM request_records r JOIN requests q ON q.id = r.request_id WHERE q.session_id = ? ORDER BY q.created_at, q.rowid', sid)
  .map(r => [r.acceptance, (JSON.parse(String(r.accept_signals ?? '[]')) as Array<{ kind: string }>).map(x => x.kind).sort().join(',')]);
const state = (d: TestDaemon, sid = 'acc') => rows(d, 'SELECT accept_state, end_state FROM requests WHERE session_id = ? ORDER BY created_at, rowid', sid)
  .map(r => ({ ...(JSON.parse(String(r.accept_state ?? '{}')) as { promptsSeen?: number; done?: boolean; applicable?: boolean; similarity?: unknown[] }), hasEndState: r.end_state !== null }));

test('a request with changes starts unobserved; reverting its file before the next prompt makes it not accepted', () => withDaemon(async (d, repo, s) => {
  await s.turn(ASK, { 'src/parse.ts': 'export const parse = () => 2;\n' });
  assert.deepEqual(seen(d), [['unobserved', '']]);
  assert.deepEqual((x => [x.applicable, x.promptsSeen, x.done, x.hasEndState])(state(d)[0]!), [true, 0, false, true]);
  // the end state holds paths, fingerprints and line counts, no content
  const end = JSON.parse(String(rows(d, "SELECT end_state FROM requests WHERE session_id = 'acc'")[0]!.end_state));
  assert.deepEqual(end.files.map((f: any) => [f.path, f.start, f.added]), [['src/parse.ts', CLEAN, 1]]);
  assert.ok(!JSON.stringify(end).includes('parse = ()'));

  write(repo, 'src/parse.ts', 'export const parse = () => 1;\n');   // the user puts the old content back
  await s.turn(OTHER, { 'src/other.ts': 'y\n' });
  assert.deepEqual(seen(d), [['not_accepted', 'reverted'], ['unobserved', '']]);
  assert.deepEqual((x => [x.done, x.hasEndState])(state(d)[0]!), [true, false], 'a settled request drops its end state');
  const rec = d.ledger.getRecord(rows(d, "SELECT id FROM requests WHERE session_id = 'acc' ORDER BY created_at")[0]!.id as string) as any;
  assert.deepEqual([rec.acceptance.verdict, rec.acceptance.ruleVersion, rec.acceptance.window, rec.acceptance.signals[0].kind, rec.acceptance.signals[0].turn], ['not_accepted', 1, 2, 'reverted', 1]);
}));

test('the same request again is seen by its wording; only numbers are stored', () => withDaemon(async (d, _repo, s) => {
  await s.turn(ASK, { 'src/parse.ts': 'export const parse = () => 2;\n' });
  await s.turn(`${ASK} again, it is the same as before`, { 'src/parse.ts': 'export const parse = () => 3;\n' });
  assert.deepEqual(seen(d), [['not_accepted', 'reask'], ['unobserved', '']]);
  const all = JSON.stringify(rows(d, 'SELECT accept_state, end_state FROM requests')) + JSON.stringify(rows(d, 'SELECT record, accept_signals, prompt FROM request_records'));
  assert.ok(!all.includes('empty input'), 'no prompt text in what acceptance stores');
  const st = JSON.parse(String(rows(d, "SELECT accept_state FROM requests WHERE session_id = 'acc' ORDER BY created_at")[0]!.accept_state));
  assert.equal(st.similarity.length, 1);
  assert.ok(st.similarity[0].containment >= 0.8 && typeof st.similarity[0].jaccard === 'number');
  assert.equal(typeof st.signals[0].value, 'number');
}));

test('the window passes after two following prompts; a dissatisfaction phrase alone does not flip the verdict', () => withDaemon(async (d, _repo, s) => {
  await s.turn(ASK, { 'src/parse.ts': 'export const parse = () => 2;\n' });
  await s.turn(`That doesn't work for me yet, but first: ${OTHER}`, { 'src/other.ts': 'y\n' });
  assert.deepEqual(seen(d), [['unobserved', 'dissatisfied'], ['unobserved', '']]);
  assert.deepEqual((x => [x.promptsSeen, x.done])(state(d)[0]!), [1, false]);
  await s.turn(THIRD, { 'README.md': 'r2\n' });
  assert.deepEqual(seen(d), [['accepted', 'dissatisfied'], ['unobserved', ''], ['unobserved', '']]);
  assert.deepEqual((x => [x.promptsSeen, x.done, x.hasEndState])(state(d)[0]!), [2, true, false]);
  assert.deepEqual((x => [x.promptsSeen, x.done])(state(d)[1]!), [1, false]);
  // the phrase is stored as a rule id
  const sig = JSON.parse(String(rows(d, "SELECT accept_signals FROM request_records ORDER BY created_at LIMIT 1")[0]!.accept_signals));
  assert.deepEqual([sig[0].kind, sig[0].value, sig[0].turn], ['dissatisfied', 'en-does-not-work', 1]);
  // a task notification and a slash command are not user prompts of the window
  await s.post({ hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>x</task-id>\n<status>completed</status>\n</task-notification>' });
  await s.post({ hook_event_name: 'UserPromptSubmit', prompt: '/help' });
  await d.router.drain();
  assert.deepEqual((x => x.promptsSeen)(state(d)[1]!), 1);
}));

test('a commit of the change accepts it; a later revert still wins', () => withDaemon(async (d, repo, s) => {
  await s.turn(ASK, { 'src/parse.ts': 'export const parse = () => 2;\n', 'src/new.ts': 'export const n = 1;\n' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'fix parse');
  await s.turn(OTHER, { 'src/other.ts': 'y\n' });
  assert.deepEqual(seen(d)[0], ['accepted', 'committed']);
  assert.equal(state(d)[0]!.done, false, 'the window stays open after a commit');
  git(repo, 'revert', '--no-edit', 'HEAD');   // the user takes the commit back
  await s.turn(THIRD, { 'README.md': 'r2\n' });
  assert.deepEqual(seen(d)[0], ['not_accepted', 'committed,reverted']);
}));

test('a question, and a request without changes, have nothing to accept', () => withDaemon(async (d, _repo, s) => {
  await s.turn('What does the parse function return for an empty string?');
  await s.turn(OTHER);
  await s.turn(THIRD, { 'README.md': 'r2\n' });
  assert.deepEqual(seen(d), [['n/a', ''], ['n/a', ''], ['unobserved', '']]);
  assert.deepEqual(state(d).map(x => [x.applicable, x.promptsSeen]), [[false, 0], [false, 0], [true, 0]]);
}));

test('on another history (branch switch, reset) the files say nothing: recorded as not available, not as a revert', async () => {
  const repo = makeRepo({ 'src/parse.ts': 'export const parse = () => 0;\n' });
  git(repo, 'config', 'core.autocrlf', 'false');
  write(repo, 'src/parse.ts', 'export const parse = () => 1;\n');
  git(repo, 'commit', '-qam', 'second');
  const d = await startTestDaemon({ verify: { resolveCommands: async () => [] } });
  try {
    const s = session(d, 'acc', repo);
    await s.turn(ASK, { 'src/parse.ts': 'export const parse = () => 2;\n' });
    git(repo, 'checkout', '-q', '-f', '--detach', 'HEAD~1');   // the work tree is now before the request's start commit
    await s.turn(OTHER);
    assert.deepEqual(seen(d)[0], ['unobserved', 'unavailable']);
    const sig = JSON.parse(String(rows(d, 'SELECT accept_signals FROM request_records ORDER BY created_at LIMIT 1')[0]!.accept_signals));
    assert.equal(sig[0].value, 'other_branch');
  } finally { await d.close(); rmrf(d.home); rmrf(repo); }
});

test('end state and its check, without a daemon: dirty start, created file, mostly deleted', async () => {
  const repo = makeRepo({ 'a.txt': 'one\ntwo\n', 'b.txt': 'b\n' });
  try {
    git(repo, 'config', 'core.autocrlf', 'false');
    write(repo, 'b.txt', 'b\nuser line\n');   // the user's own uncommitted work, there before the request
    const snap = (await takeRequestSnapshot(repo))!;
    write(repo, 'a.txt', `one\ntwo\n${'added\n'.repeat(10)}`);
    write(repo, 'b.txt', 'b\nuser line\nmine\n');
    write(repo, 'c.txt', 'new\nfile\n');
    const es = await requestEndState(snap);
    assert.deepEqual(es.files.map(f => [f.path, f.start === CLEAN ? 'clean' : f.start === '-' ? 'absent' : 'fp', f.added, f.addedBefore]),
      [['a.txt', 'clean', 10, 0], ['b.txt', 'fp', 1, 1], ['c.txt', 'absent', 2, 0]]);
    const fresh = await checkEndState(es);
    assert.ok(fresh.available && fresh.signals.untouched && !fresh.signals.reverted && !fresh.committed);
    // most added lines gone, files not at their start state: the weak signal
    write(repo, 'a.txt', 'one\ntwo\nkept\n');
    fs.rmSync(path.join(repo, 'c.txt'));
    const del = await checkEndState(es);
    assert.ok(del.available && del.signals.mostlyDeleted && !del.signals.reverted, JSON.stringify(del));
    // back to the start: the user's own line in b.txt stays, the request's line goes
    write(repo, 'a.txt', 'one\ntwo\n');
    write(repo, 'b.txt', 'b\nuser line\n');
    const rev = await checkEndState(es);
    assert.ok(rev.available && rev.signals.reverted && rev.signals.revertedFiles === 3, JSON.stringify(rev));
    assert.deepEqual(await checkEndState({ ...es, root: path.join(repo, 'gone') }), { available: false, why: 'not_a_work_tree' });
    const { head: _no, ...headless } = es;
    assert.deepEqual(await checkEndState(headless), { available: false, why: 'no_start_commit' });
  } finally { rmrf(repo); }
});

test('prompt memory: two prompts per session, in memory, gone after two hours', () => {
  const m = new PromptMemory();
  m.remember('s', 'r1', 'first', 0);
  m.remember('s', 'r2', 'second', 10);
  m.remember('s', 'r3', 'third', 20);
  assert.deepEqual([m.get('s', 'r1', 30), m.get('s', 'r2', 30), m.get('s', 'r3', 30), m.size], [undefined, 'second', 'third', 2]);
  assert.equal(m.get('s', 'r3', 20 + PROMPT_MEMORY_TTL_MS + 1), undefined);
  assert.equal(m.get('other', 'r3', 30), undefined);
  m.forget('s', 'r2');
  assert.deepEqual([m.get('s', 'r2', 30), m.size], [undefined, 1]);
  m.remember('s', 'r4', '   ', 40);
  assert.equal(m.size, 1, 'an empty prompt is not kept');
});

test('the KPI reads acceptance: a rejected request costs, and does not count as an accepted task', () => withDaemon(async (d, repo, s) => {
  await s.turn(ASK, { 'src/parse.ts': 'export const parse = () => 2;\n' });
  write(repo, 'src/parse.ts', 'export const parse = () => 1;\n');
  await s.turn(OTHER, { 'src/other.ts': 'y\n' });
  await s.turn('What changed in the last commit?');
  const m = metricsSummary(d.ledger);
  assert.deepEqual([m.total, m.successful], [3, 2]);
  assert.deepEqual((a => [a.accepted, a.notAccepted, a.unobserved, a.notApplicable, a.unknown, a.unobservedShare, a.signals])(m.acceptance), [0, 1, 1, 1, 0, 0.5, { reverted: 1 }]);
}));

// Integration round 5: the change was reverted the moment the turn ended, before the daemon had looked.
test('a revert right after the turn ends is still seen: the end state is taken at Stop, before the hook answers', () => withDaemon(async (d, repo, s) => {
  await s.post({ hook_event_name: 'UserPromptSubmit', prompt: ASK });
  await d.router.drain();
  write(repo, 'src/parse.ts', 'export const parse = () => 2;\n');
  write(repo, 'src/new.ts', 'export const n = 1;\n');
  await s.post({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.' });
  // no drain: `git checkout -- .` and the clean-up run while the daemon's work after the answer is still going
  git(repo, 'checkout', '--', '.');
  fs.rmSync(path.join(repo, 'src', 'new.ts'));
  await d.router.drain();
  assert.deepEqual(seen(d), [['unobserved', '']], 'the request did change files; it is not "n/a"');
  const end = JSON.parse(String(rows(d, "SELECT end_state FROM requests WHERE session_id = 'acc'")[0]!.end_state));
  assert.deepEqual(end.files.map((f: any) => f.path), ['src/new.ts', 'src/parse.ts']);
  assert.equal(end.changes.changedFiles, 2);
  assert.equal(typeof end.takenAt, 'string');
  const rec = d.ledger.getRecord(rows(d, "SELECT id FROM requests WHERE session_id = 'acc'")[0]!.id as string) as any;
  assert.equal(rec.changes.changedFiles, 2, 'the record counts what the request changed, not what is left of it');

  await s.turn('Looks good, thank you.');
  assert.deepEqual(seen(d), [['not_accepted', 'reverted'], ['n/a', '']]);
}));

test('the latest turn end wins: a request that stays open over two turns is recorded as its last turn left it', () => withDaemon(async (d, repo, s) => {
  // the lead asks the user something: the request stays open
  await s.post({ hook_event_name: 'UserPromptSubmit', prompt: ASK });
  await d.router.drain();
  write(repo, 'src/parse.ts', 'export const parse = () => 2;\n');
  await s.post({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: `Return null or throw for empty input? ${AWAITING_USER_MARKER}` });
  await d.router.drain();
  const first = () => rows(d, "SELECT id, status, end_state FROM requests WHERE session_id = 'acc' ORDER BY created_at, rowid")[0]!;
  const taken1 = JSON.parse(String(first().end_state));
  assert.deepEqual([first().status, taken1.files.map((x: any) => x.path), taken1.changes.changedFiles], ['awaiting_user', ['src/parse.ts'], 1]);
  // the answer continues the same request; its second turn changes another file and is reverted at once
  await s.post({ hook_event_name: 'UserPromptSubmit', prompt: 'throw' });
  await d.router.drain();
  write(repo, 'src/other.ts', 'y\n');
  await s.post({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.' });
  git(repo, 'checkout', '--', '.');
  await d.router.drain();
  assert.equal(rows(d, "SELECT COUNT(*) AS n FROM requests WHERE session_id = 'acc'")[0]!.n, 1);
  const taken2 = JSON.parse(String(first().end_state));
  assert.deepEqual([first().status, taken2.files.map((x: any) => x.path)], ['closed', ['src/other.ts', 'src/parse.ts']]);
  assert.ok(taken2.takenAt >= taken1.takenAt);
  assert.equal((d.ledger.getRecord(first().id as string) as any).changes.changedFiles, 2);
  assert.deepEqual(seen(d), [['unobserved', '']]);
}));

test('a turn that changed nothing leaves no end state behind', () => withDaemon(async (d, _repo, s) => {
  await s.turn(ASK);
  assert.deepEqual(seen(d), [['n/a', '']]);
  assert.equal(state(d)[0]!.hasEndState, false);
}));
