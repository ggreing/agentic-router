// Regression tests for the read-only audit (security items #5, #8, #2) and decisions 89, 91.
// Each test mirrors one experiment of the audit script (E-numbers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { changedFiles } from '../src/git.ts';
import { claudeAdapter, git, makeRepo, postHook, rmrf, rows, startTestDaemon, tmpDir, write, type HookInput, type TestDaemon } from './helpers.ts';

const L1_PROMPT = 'Fix the bug where parse() fails on empty input in src/parse.ts';
type Out = { decision?: string; reason?: string; hookSpecificOutput?: { additionalContext?: string } };

async function withDaemon(fn: (d: TestDaemon) => Promise<void>, commands: Array<{ kind: 'build' | 'test'; command: string }> = []): Promise<void> {
  const d = await startTestDaemon({ verify: { resolveCommands: async () => commands } });
  try { await fn(d); } finally { await d.close(); rmrf(d.home); }
}

async function startCoder(d: TestDaemon, repo: string, sid: string, agentId: string, scope = 'src/a/**') {
  const post = async (h: HookInput) => {
    const r = await postHook(d.port, { session_id: sid, cwd: repo, transcript_path: path.join(d.home, `${sid}.jsonl`), ...h });
    assert.equal(r.status, 200, r.text);
    return r.body as Out;
  };
  await post({ hook_event_name: 'UserPromptSubmit', prompt: L1_PROMPT });
  await post({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'do-it-all-claude-code:coder', prompt: `[subtask:A] work\n[scope: ${scope}]`, model: 'haiku', effort: 'low' } });
  await post({ hook_event_name: 'SubagentStart', agent_id: agentId, agent_type: 'do-it-all-claude-code:coder' });
  const stop = (extra: HookInput = {}) => post({ hook_event_name: 'SubagentStop', agent_id: agentId, agent_type: 'do-it-all-claude-code:coder', stop_hook_active: false, ...extra });
  return { post, stop };
}

const scopeDetail = (d: TestDaemon) => String(rows(d, "SELECT detail FROM signals WHERE kind = 'scope' ORDER BY id DESC LIMIT 1")[0]?.detail);

test('E4 / #5: a filter driver planted by the subagent never runs inside the daemon; git metadata changes fail before git runs', () => withDaemon(async d => {
  const repo = makeRepo({ 'src/a/x.ts': 'a\n' });
  const marker = path.join(tmpDir('marker'), 'ran.txt').replace(/\\/g, '/');
  try {
    const { stop } = await startCoder(d, repo, 'e4', 'ag-e4');
    git(repo, 'config', 'filter.x.clean', `node -e "require('fs').writeFileSync('${marker}','ran');process.stdin.pipe(process.stdout)"`);
    write(repo, 'src/a/.gitattributes', '* filter=x\n');
    write(repo, 'src/a/x.ts', 'changed\n');
    const out = await stop();
    assert.equal(fs.existsSync(marker), false, 'the planted filter command ran');
    assert.equal(out.decision, 'block');
    assert.match(scopeDetail(d), /protected paths changed \(need user confirmation\): \.git\/config .*git and the verify commands were not run/);
  } finally { rmrf(repo); rmrf(path.dirname(marker)); }
}));

test('#5: a filter already configured (any level) is emptied for the daemon\'s git; a changed .gitattributes fails before git runs', async () => {
  const repo = makeRepo({ 'src/a/x.ts': 'a\n' });
  const marker = path.join(tmpDir('marker2'), 'ran.txt').replace(/\\/g, '/');
  try {
    write(repo, '.gitattributes', '*.ts filter=pre\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'attrs');
    // configured after the commit, so only the daemon's own git could run it
    git(repo, 'config', 'filter.pre.clean', `node -e "require('fs').writeFileSync('${marker}','ran');process.stdin.pipe(process.stdout)"`);
    write(repo, 'src/a/x.ts', 'changed again, a different length\n');
    assert.deepEqual(await changedFiles(repo, git(repo, 'rev-parse', 'HEAD').trim()), ['src/a/x.ts']);
    assert.equal(fs.existsSync(marker), false, 'a configured filter ran inside the daemon\'s git');
    // control: plain git (without the daemon's overrides) does run it here, so the check above is meaningful
    git(repo, 'diff', '--name-only', 'HEAD');
    assert.equal(fs.existsSync(marker), true, 'plain git did not run the filter: the test does not exercise it');
  } finally { rmrf(repo); rmrf(path.dirname(marker)); }

  await withDaemon(async d => {
    const repo2 = makeRepo({ 'src/a/x.ts': 'a\n' });
    try {
      const { stop } = await startCoder(d, repo2, 'attrs', 'ag-at');
      write(repo2, 'src/a/.gitattributes', '*.ts diff=evil\n');
      assert.equal((await stop()).decision, 'block');
      assert.match(scopeDetail(d), /^git attributes changed .*: src\/a\/\.gitattributes; git and the verify commands were not run$/);
    } finally { rmrf(repo2); }
  });
});

test('E3 / #8: changes git does not show still count: ignored .env, assume-unchanged file, info/exclude', () => withDaemon(async d => {
  // .env (protected, git-ignored)
  const r1 = makeRepo({ 'src/a/x.ts': 'a\n', '.gitignore': '.env\nnode_modules/\n' });
  write(r1, '.env', 'SECRET=1\n');
  try {
    const { stop } = await startCoder(d, r1, 'env', 'ag-env');
    fs.appendFileSync(path.join(r1, '.env'), 'INJECTED=1\n');
    assert.equal((await stop()).decision, 'block');
    assert.match(scopeDetail(d), /protected paths changed \(need user confirmation\): \.env/);
  } finally { rmrf(r1); }
  // assume-unchanged tracked file (flag set during the run, and one already flagged before)
  const r2 = makeRepo({ 'src/a/x.ts': 'a\n', 'other/y.ts': 'y\n', 'other/z.ts': 'z\n' });
  git(r2, 'update-index', '--assume-unchanged', 'other/z.ts');
  try {
    const { stop } = await startCoder(d, r2, 'flag', 'ag-flag');
    git(r2, 'update-index', '--assume-unchanged', 'other/y.ts');
    write(r2, 'other/y.ts', 'hidden change\n');
    write(r2, 'other/z.ts', 'hidden change too\n');
    assert.equal((await stop()).decision, 'block');
    assert.match(scopeDetail(d), /changed outside the allowed scope \[src\/a\/\*\*\]: other\/y\.ts, other\/z\.ts/);
  } finally { rmrf(r2); }
  // .git/info/exclude edited to hide a new directory
  const r3 = makeRepo({ 'src/a/x.ts': 'a\n' });
  try {
    const { stop } = await startCoder(d, r3, 'excl', 'ag-excl');
    fs.appendFileSync(path.join(r3, '.git', 'info', 'exclude'), 'planted/\n');
    write(r3, 'planted/new.ts', 'x\n');
    assert.equal((await stop()).decision, 'block');
    assert.match(scopeDetail(d), /\.git\/info\/exclude/);
  } finally { rmrf(r3); }
}));

test('E1 / #7: reverting or deleting the user\'s own uncommitted work counts, even when no edit tool did it', () => withDaemon(async d => {
  const repo = makeRepo({ 'src/a/x.ts': 'a\n', 'docs/notes.md': 'notes\n' });
  write(repo, 'docs/notes.md', 'notes\nUSER UNCOMMITTED WORK\n');
  write(repo, 'scratch.txt', 'user untracked\n');
  try {
    const { stop } = await startCoder(d, repo, 'e1', 'ag-e1');
    write(repo, 'src/a/x.ts', 'b\n');
    git(repo, 'checkout', '--', 'docs/notes.md');
    fs.rmSync(path.join(repo, 'scratch.txt'));
    assert.equal((await stop()).decision, 'block');
    assert.match(scopeDetail(d), /the user's uncommitted work was reverted or deleted outside the allowed scope \(may be the user; restore it or report it\): docs\/notes\.md, scratch\.txt/);
  } finally { rmrf(repo); }
}));

test('E6 / #9: files the router\'s verify wrote on stop #1 are not the subagent\'s on stop #2', () => withDaemon(async d => {
  const repo = makeRepo({ 'src/a/x.ts': 'a\n', 'check.cjs': "require('fs').writeFileSync('tsconfig.tsbuildinfo','x');process.exit(require('fs').existsSync('src/a/ok')?0:1)\n" });
  try {
    const { stop } = await startCoder(d, repo, 'e6', 'ag-e6');
    write(repo, 'src/a/x.ts', 'agent edit\n');
    assert.equal((await stop()).decision, 'block');      // build fails, the subagent is asked to fix
    write(repo, 'src/a/ok', 'fixed\n');
    assert.deepEqual(await stop({ stop_hook_active: true }), {});
    assert.deepEqual(rows(d, 'SELECT status, verdict FROM subtasks'), [{ status: 'passed', verdict: 'meet' }]);
    assert.ok(!scopeDetail(d).includes('tsbuildinfo'), scopeDetail(d));
  } finally { rmrf(repo); }
}, [{ kind: 'build', command: 'node check.cjs' }]));

test('decision 91: changed package.json scripts or test config hold the verify commands (hitl, not a miss); a dependency bump does not', () => withDaemon(async d => {
  const pkg = (scripts: Record<string, string>, deps: Record<string, string> = {}) => JSON.stringify({ name: 'x', scripts, dependencies: deps }, null, 2);
  const repo = makeRepo({ 'src/a/x.ts': 'a\n', 'package.json': pkg({ test: 'node check.cjs' }), 'check.cjs': 'process.exit(0)\n', 'pyproject.toml': '[project]\nname = "x"\ndependencies = []\n\n[tool.pytest.ini_options]\naddopts = "-q"\n' });
  try {
    // scripts changed -> held
    const a = await startCoder(d, repo, 'held', 'ag-h', '**');
    write(repo, 'src/a/x.ts', 'b\n');
    write(repo, 'package.json', pkg({ test: 'exit 0' }));
    assert.deepEqual(await a.stop(), {});
    assert.deepEqual(rows(d, "SELECT status, verdict FROM subtasks WHERE request_id = (SELECT id FROM requests WHERE session_id = 'held')"), [{ status: 'hitl', verdict: 'held' }]);
    assert.match(String(rows(d, "SELECT detail FROM signals WHERE kind = 'test' ORDER BY id DESC LIMIT 1")[0]!.detail),
      /^node check\.cjs: held, package\.json changed since the subtask started; ask the user to confirm before running$/);
    const note = await a.post({ hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>ag-h</task-id>\n<status>completed</status>\n</task-notification>' });
    assert.match(note.hookSpecificOutput?.additionalContext ?? '', /verify held: package\.json changed; ask the user to confirm before running/);
  } finally { rmrf(repo); }

  const repo2 = makeRepo({ 'src/a/x.ts': 'a\n', 'package.json': pkg({ test: 'node check.cjs' }), 'check.cjs': 'process.exit(0)\n', 'pyproject.toml': '[project]\nname = "x"\ndependencies = []\n\n[tool.pytest.ini_options]\naddopts = "-q"\n' });
  try {
    // dependencies only (package.json deps, pyproject [project]) -> runs normally
    const b = await startCoder(d, repo2, 'deps', 'ag-d');
    write(repo2, 'package.json', pkg({ test: 'node check.cjs' }, { lodash: '^4' }));
    write(repo2, 'pyproject.toml', '[project]\nname = "x"\ndependencies = ["requests"]\n\n[tool.pytest.ini_options]\naddopts = "-q"\n');
    write(repo2, 'src/a/x.ts', 'c\n');
    const out = await b.stop();
    // package.json / pyproject.toml are outside src/a/** -> the scope fails, but the commands ran (not held)
    assert.equal(out.decision, 'block');
    assert.match(String(rows(d, "SELECT detail FROM signals WHERE kind = 'test' ORDER BY id DESC LIMIT 1")[0]!.detail), /^node check\.cjs: exit 0$/);
  } finally { rmrf(repo2); }

  const repo3 = makeRepo({ 'src/a/x.ts': 'a\n', 'tsconfig.json': '{}\n', 'check.cjs': 'process.exit(0)\n' });
  try {
    // a test-runner / build config added or changed inside the scope -> held
    const c = await startCoder(d, repo3, 'cfg', 'ag-c', '**');
    write(repo3, 'tsconfig.json', '{ "compilerOptions": { "noEmit": true } }\n');
    write(repo3, 'vitest.config.ts', 'export default {}\n');
    assert.deepEqual(await c.stop(), {});
    assert.match(String(rows(d, "SELECT detail FROM signals WHERE kind = 'test' ORDER BY id DESC LIMIT 1")[0]!.detail), /held, tsconfig\.json, vitest\.config\.ts changed/);
  } finally { rmrf(repo3); }
}, [{ kind: 'test', command: 'node check.cjs' }]));

test('decision 89 / #2: a router subagent\'s stop replayed from the spool is unverified, and the lead is told', () => withDaemon(async d => {
  const repo = makeRepo({ 'src/a/x.ts': 'a\n' });
  try {
    const { post } = await startCoder(d, repo, 'offline', 'ag-off');
    write(repo, 'src/a/x.ts', 'edited while the router was down\n');
    // the relay spooled the stop during an outage; the daemon replays it on start (spooled: true)
    const replayed = claudeAdapter.toRouterEvent({ session_id: 'offline', cwd: repo, hook_event_name: 'SubagentStop', agent_id: 'ag-off', agent_type: 'do-it-all-claude-code:coder', stop_hook_active: false }, { spooled: true });
    assert.deepEqual(await d.router.process(replayed), {});
    assert.deepEqual(rows(d, 'SELECT status, verdict FROM subtasks'), [{ status: 'hitl', verdict: 'unverified' }]);
    assert.equal(rows(d, 'SELECT COUNT(*) AS c FROM signals')[0]!.c, 0, 'no verification ran');
    const note = await post({ hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>ag-off</task-id>\n<status>completed</status>\n</task-notification>' });
    assert.match(note.hookSpecificOutput?.additionalContext ?? '', /subtask A \(coder @s1.*\): verify did not run \(router was offline\); check the result yourself before relying on it/);
  } finally { rmrf(repo); }
}));
