import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROTECTED_WRITE_PATHS } from '@agentic-router/core';
import { scrubbedEnv } from '../src/env.ts';
import { gitMetaChanges, gitMetaFingerprint, takeSnapshot } from '../src/git.ts';
import { inferKind, projectCommands, resolveVerifyCommands } from '../src/verify-source.ts';
import { checkScope, existsInTree, matchGlob, runCommand, runVerify } from '../src/verify.ts';
import { git, makeRepo, rmrf, tmpDir, write } from './helpers.ts';

const PROTECTED = [...PROTECTED_WRITE_PATHS];

test('glob matching is repo-relative, with dir/ and plain-dir shorthands', () => {
  assert.equal(matchGlob('src/a/b.ts', 'src/**'), true);
  assert.equal(matchGlob('src/a/b.ts', 'src/'), true);
  assert.equal(matchGlob('src/a/b.ts', 'src/a'), true);
  assert.equal(matchGlob('src/a/b.ts', './src/a/*.ts'), true);
  assert.equal(matchGlob('srcx/a.ts', 'src'), false);
  assert.equal(matchGlob('test/a.ts', 'src/**'), false);
  assert.equal(matchGlob('anything/at/all', '**'), true);
  assert.equal(matchGlob('.env', '**/.env'), true);
  assert.equal(matchGlob('.claude/worktrees/agent-x/', '.claude/worktrees/**'), true);
});

test('commands: exit code decides ok; output tail goes into the detail', async () => {
  const dir = makeRepo({ 'ok.cjs': 'process.exit(0)\n', 'bad.cjs': 'console.error("broken thing"); process.exit(2)\n' });
  try {
    const s = await runVerify({ cwd: dir, commands: [{ kind: 'test', command: 'node ok.cjs' }, { kind: 'lint', command: 'node bad.cjs' }] });
    assert.deepEqual(s.map(x => [x.kind, x.ok]), [['test', true], ['lint', false]]);
    assert.match(s[1]!.detail!, /node bad\.cjs: exit 2/);
    assert.match(s[1]!.detail!, /broken thing/);
  } finally { rmrf(dir); }
});

test('commands: per-command timeout kills the process; total limit skips the rest', async () => {
  const dir = makeRepo({ 'hang.cjs': 'setTimeout(() => {}, 60000)\n' });
  try {
    const t0 = Date.now();
    const s = await runVerify({
      cwd: dir, commandTimeoutMs: 600, totalTimeoutMs: 900,
      commands: [{ kind: 'test', command: 'node hang.cjs' }, { kind: 'test', command: 'node hang.cjs' }, { kind: 'build', command: 'node hang.cjs' }],
    });
    assert.ok(Date.now() - t0 < 10_000, 'timeouts did not stop the commands');
    assert.match(s[0]!.detail!, /timed out/);
    assert.equal(s.every(x => !x.ok), true);
    assert.match(s[2]!.detail!, /not run, total verify time limit/);
  } finally { rmrf(dir); }
});

test('commands run without credentials from the daemon environment', async () => {
  const dir = makeRepo({ 'env.cjs': 'const e = process.env; process.exit(e.ANTHROPIC_API_KEY || e.MY_SERVICE_TOKEN || e.CLAUDE_CODE_OAUTH_TOKEN ? 3 : e.AR_PLAIN_VAR === "1" ? 0 : 4)\n' });
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { ANTHROPIC_API_KEY: 'sk-ant-test-0000000000', MY_SERVICE_TOKEN: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'y', AR_PLAIN_VAR: '1' });
    const r = await runCommand('node env.cjs', dir, 10_000);
    assert.equal(r.code, 0, r.output);
    const env = scrubbedEnv();
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.ok(env.PATH ?? env.Path, 'PATH must survive');
  } finally {
    for (const k of ['ANTHROPIC_API_KEY', 'MY_SERVICE_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'AR_PLAIN_VAR']) delete process.env[k];
    Object.assign(process.env, saved);
    rmrf(dir);
  }
});

test('scope: untracked, modified and committed changes outside the scope fail; inside passes', async () => {
  const dir = makeRepo({ 'src/a.ts': 'a\n', 'docs/x.md': 'x\n' });
  try {
    const snapshot = await takeSnapshot(dir);
    assert.ok(snapshot?.head);
    write(dir, 'src/a.ts', 'a2\n');
    write(dir, 'src/new.ts', 'n\n');
    const inside = await checkScope(dir, { allowed: ['src/**'], protected: PROTECTED, unscoped: false, snapshot });
    assert.equal(inside.ok, true, inside.detail);
    assert.match(inside.detail!, /2 file\(s\) changed/);

    write(dir, 'docs/x.md', 'changed\n');
    write(dir, 'docs/committed.md', 'c\n');
    git(dir, 'add', 'docs/committed.md');
    git(dir, 'commit', '-qm', 'subagent commit');
    write(dir, 'notes.txt', 'untracked\n');
    const outside = await checkScope(dir, { allowed: ['src/**'], protected: PROTECTED, unscoped: false, snapshot });
    assert.equal(outside.ok, false);
    for (const f of ['docs/x.md', 'docs/committed.md', 'notes.txt']) assert.ok(outside.detail!.includes(f), `${f} not reported: ${outside.detail}`);
    assert.ok(!outside.detail!.includes('src/a.ts'));
  } finally { rmrf(dir); }
});

test('scope: protected paths fail even inside an unscoped (whole repo) scope', async () => {
  const dir = makeRepo();
  try {
    const snapshot = await takeSnapshot(dir);
    write(dir, '.github/workflows/ci.yml', 'on: push\n');
    write(dir, 'pkg/.env', 'X=1\n');
    const s = await checkScope(dir, { allowed: ['**'], protected: PROTECTED, unscoped: true, snapshot });
    assert.equal(s.ok, false);
    assert.match(s.detail!, /protected paths changed/);
    assert.match(s.detail!, /\.github\/workflows\/ci\.yml/);
    assert.match(s.detail!, /pkg\/\.env/);
  } finally { rmrf(dir); }
});

test('scope: changes already present at start are not attributed; later edits to them are', async () => {
  const dir = makeRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
  try {
    write(dir, 'a.txt', 'dirty before start\n');
    write(dir, 'pre-untracked.txt', 'u\n');
    write(dir, 'b.txt', 'dirty b\n');
    const snapshot = await takeSnapshot(dir);
    assert.deepEqual(Object.keys(snapshot!.dirty).sort(), ['a.txt', 'b.txt', 'pre-untracked.txt']);
    write(dir, 'b.txt', 'edited again by the subagent\n');
    const s = await checkScope(dir, { allowed: ['src/**'], protected: PROTECTED, unscoped: false, snapshot });
    assert.equal(s.ok, false);
    assert.match(s.detail!, /b\.txt/);
    assert.ok(!/a\.txt|pre-untracked/.test(s.detail!), s.detail);
  } finally { rmrf(dir); }
});

test('scope: Claude Code worktrees and sibling scopes in a shared work tree are not this agent\'s', async () => {
  const dir = makeRepo();
  try {
    const snapshot = await takeSnapshot(dir);
    write(dir, '.claude/worktrees/agent-x/file.txt', 'w\n');
    write(dir, 'other/b.txt', 'sibling\n');
    write(dir, 'mine/a.txt', 'mine\n');
    const s = await checkScope(dir, { allowed: ['mine/**'], protected: PROTECTED, unscoped: false, snapshot, sharedAllowed: ['other/**'] });
    assert.equal(s.ok, true, s.detail);
  } finally { rmrf(dir); }
});

test('scope outside git is skipped, not failed', async () => {
  const dir = tmpDir('nogit');
  try {
    const s = await checkScope(dir, { allowed: ['**'], protected: PROTECTED, unscoped: true });
    assert.deepEqual(s, { kind: 'scope', ok: true, detail: 'skipped: not a git work tree' });
  } finally { rmrf(dir); }
});

// ------------------------------------------------------------------ verify command source (decision Q2)

test('role file x-router.verify is read with core parseRoleFile (strings and objects); a bad file only warns', async () => {
  const plugin = tmpDir('plugin');
  try {
    write(plugin, 'agents/coder.md', ['---', 'name: coder', 'tools: Read, Edit', 'x-router:', '  role: coder', '  verify:', '    - npm test',
      '    - command: npx tsc --noEmit', '      kind: typecheck', '      timeoutMs: 60000', '---', 'body'].join('\n'));
    write(plugin, 'agents/tester.md', ['---', 'name: tester', '---', 'no x-router'].join('\n'));
    write(plugin, 'agents/reviewer.md', 'no front matter at all');
    assert.deepEqual(await resolveVerifyCommands({ role: 'coder', pluginDir: plugin }), {
      source: 'role', commands: [{ kind: 'test', command: 'npm test' }, { kind: 'typecheck', command: 'npx tsc --noEmit', timeoutMs: 60000 }],
    });
    assert.deepEqual(await resolveVerifyCommands({ role: 'tester', pluginDir: plugin }), { source: 'role', commands: [] });
    const bad = await resolveVerifyCommands({ role: 'reviewer', pluginDir: plugin });
    assert.equal(bad.source, 'none');
    assert.match(bad.warning ?? '', /role file .*reviewer\.md ignored/);
    assert.equal((await resolveVerifyCommands({ role: 'architect', pluginDir: plugin })).source, 'none');
  } finally { rmrf(plugin); }
});

test('project verify.json: role list wins over "*", kinds inferred or given', () => {
  assert.deepEqual(projectCommands({ '*': ['npm test'], coder: ['npx tsc --noEmit', { command: 'npm run lint' }, { kind: 'build', command: 'make' }] }, 'coder'), [
    { kind: 'typecheck', command: 'npx tsc --noEmit' }, { kind: 'lint', command: 'npm run lint' }, { kind: 'build', command: 'make' },
  ]);
  assert.deepEqual(projectCommands({ '*': ['pytest -q'] }, 'tester'), [{ kind: 'test', command: 'pytest -q' }]);
  assert.equal(projectCommands({ reviewer: [] }, 'coder'), undefined);
  assert.throws(() => projectCommands({ coder: [{ kind: 'nope', command: 'x' }] }, 'coder'), /unknown kind/);
  assert.equal(inferKind('npm run build'), 'build');
});

test('project file overrides the role file and is read from the start commit, not the edited work tree', async () => {
  const plugin = tmpDir('plugin');
  const dir = makeRepo({ '.agentic-router/verify.json': JSON.stringify({ coder: ['node check.cjs'] }) });
  try {
    write(plugin, 'agents/coder.md', '---\nname: coder\nx-router:\n  verify:\n    - npm test\n---\n');
    write(plugin, 'agents/tester.md', '---\nname: tester\nx-router:\n  verify:\n    - npm test\n---\n');
    const base = git(dir, 'rev-parse', 'HEAD').trim();
    // the subagent weakens the project file in its work tree
    write(dir, '.agentic-router/verify.json', JSON.stringify({ coder: [] }));
    const coder = await resolveVerifyCommands({ role: 'coder', pluginDir: plugin, repoRoot: dir, baseRef: base });
    assert.deepEqual(coder, { commands: [{ kind: 'test', command: 'node check.cjs' }], source: 'project' });
    const tester = await resolveVerifyCommands({ role: 'tester', pluginDir: plugin, repoRoot: dir, baseRef: base });
    assert.deepEqual(tester, { commands: [{ kind: 'test', command: 'npm test' }], source: 'role' });
    const none = await resolveVerifyCommands({ role: 'reviewer', repoRoot: dir, baseRef: base });
    assert.equal(none.source, 'none');
  } finally { rmrf(dir); rmrf(plugin); }
});

// ------------------------------------------------------------------ ifExists (decision 70)

test('ifExists: runs the step when the path exists in the work tree, skips it as ok otherwise', async () => {
  const dir = makeRepo({ 'ok.cjs': 'process.exit(0)\n', 'bad.cjs': 'process.exit(1)\n', 'sub/marker.txt': 'm\n' });
  try {
    const s = await runVerify({ cwd: dir, root: dir, commands: [
      { kind: 'build', command: 'node ok.cjs', ifExists: 'sub/marker.txt' },
      { kind: 'test', command: 'node bad.cjs', ifExists: 'package.json' },
      { kind: 'lint', command: 'node ok.cjs', ifExists: 'sub' },
    ] });
    // decision 149: the steps that ran carry exit code and duration; a skipped step does not
    assert.deepEqual(s.map(x => [x.kind, x.exitCode ?? null, typeof x.durationMs]), [['build', 0, 'number'], ['test', null, 'undefined'], ['lint', 0, 'number']]);
    assert.deepEqual(s.map(({ kind, ok, detail }) => ({ kind, ok, detail })), [
      { kind: 'build', ok: true, detail: 'node ok.cjs: exit 0' },
      { kind: 'test', ok: true, detail: 'node bad.cjs: skipped (no package.json)' },
      { kind: 'lint', ok: true, detail: 'node ok.cjs: exit 0' },
    ]);
  } finally { rmrf(dir); }
});

test('ifExists: a link that leads outside the work tree counts as absent; a malformed path fails closed', async () => {
  const dir = makeRepo({ 'ok.cjs': 'process.exit(0)\n' });
  const outside = tmpDir('outside');
  try {
    write(outside, 'package.json', '{}');
    fs.symlinkSync(outside, path.join(dir, 'linked'), 'junction');   // no privilege needed on Windows
    assert.equal(existsInTree(dir, 'linked/package.json'), false);
    assert.equal(existsInTree(dir, 'ok.cjs'), true);
    for (const bad of ['../x', '/etc/passwd', 'C:/x', 'a/../../x']) assert.equal(existsInTree(dir, bad), 'invalid', bad);
    const s = await runVerify({ cwd: dir, root: dir, commands: [
      { kind: 'test', command: 'node ok.cjs', ifExists: 'linked/package.json' },
      { kind: 'test', command: 'node ok.cjs', ifExists: '../x' },
    ] });
    assert.deepEqual(s.map(x => [x.ok, x.detail]), [[true, 'node ok.cjs: skipped (no linked/package.json)'], [false, 'node ok.cjs: invalid ifExists path "../x"']]);
  } finally { rmrf(dir); rmrf(outside); }
});

test('ifExists in the project verify.json is kept; an escaping path makes the file ignored with a warning', async () => {
  assert.deepEqual(projectCommands({ coder: [{ command: 'npm ci', kind: 'build', ifExists: 'package-lock.json' }] }, 'coder'),
    [{ kind: 'build', command: 'npm ci', ifExists: 'package-lock.json' }]);
  assert.throws(() => projectCommands({ coder: [{ command: 'x', ifExists: '../outside' }] }, 'coder'), /repo-relative/);
  const dir = makeRepo({ '.agentic-router/verify.json': JSON.stringify({ coder: [{ command: 'x', ifExists: '/abs' }] }) });
  try {
    const r = await resolveVerifyCommands({ role: 'coder', repoRoot: dir });
    assert.equal(r.source, 'none');
    assert.match(r.warning ?? '', /verify\.json ignored: ifExists must be a repo-relative path/);
  } finally { rmrf(dir); }
});

test('the scope check runs before the verify commands: files they create are not the subagent\'s', async () => {
  const dir = makeRepo({ 'build.cjs': 'require("fs").writeFileSync("build-output.txt", "artifact")\n' });
  try {
    const snapshot = await takeSnapshot(dir);
    write(dir, 'src/a.ts', 'mine\n');
    const s = await runVerify({ cwd: dir, root: dir, commands: [{ kind: 'build', command: 'node build.cjs' }],
      scope: { allowed: ['src/**'], protected: PROTECTED, unscoped: false, snapshot } });
    assert.ok(fs.existsSync(path.join(dir, 'build-output.txt')));
    assert.deepEqual(s.map(x => [x.kind, x.ok]), [['build', true], ['scope', true]]);   // reported last
    assert.match(s[1]!.detail!, /1 file\(s\) changed/);
  } finally { rmrf(dir); }
});

// ------------------------------------------------------------------ .git config and hooks (review #3)

test('git metadata: a planted hook or a config change fails the scope check; unchanged passes', async () => {
  const dir = makeRepo();
  try {
    const snapshot = await takeSnapshot(dir);
    assert.ok(snapshot?.gitMeta?.['.git/config'] && snapshot.gitMeta['.git/config'] !== '-');
    const spec = { allowed: ['**'], protected: PROTECTED, unscoped: true, snapshot };
    assert.equal((await checkScope(dir, spec)).ok, true);
    write(dir, '.git/hooks/post-checkout', '#!/bin/sh\necho pwned\n');
    git(dir, 'config', 'core.fsmonitor', 'evil.sh');
    const s = await checkScope(dir, spec);
    assert.equal(s.ok, false);
    assert.match(s.detail!, /protected paths changed \(need user confirmation\): \.git\/config, \.git\/hooks\/post-checkout \(git directory is shared/);
  } finally { rmrf(dir); }
});

test('git metadata in a worktree: hooks and config live in the main .git and are still watched', async () => {
  const dir = makeRepo();
  const wt = path.join(dir, '.claude', 'worktrees', 'agent-x');
  try {
    git(dir, 'worktree', 'add', '-q', '-b', 'wt-x', wt);
    const snapshot = await takeSnapshot(wt);
    assert.ok(snapshot?.gitMeta);
    assert.ok(Object.keys(snapshot.gitMeta).includes('.git/worktrees/agent-x/config.worktree'), Object.keys(snapshot.gitMeta).join(', '));
    const common = path.resolve(wt, git(wt, 'rev-parse', '--git-common-dir').trim());
    assert.equal(fs.realpathSync(common), fs.realpathSync(path.join(dir, '.git')));
    fs.writeFileSync(path.join(common, 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
    const s = await checkScope(wt, { allowed: ['**'], protected: PROTECTED, unscoped: true, snapshot });
    assert.equal(s.ok, false);
    assert.match(s.detail!, /\.git\/hooks\/pre-commit/);
    assert.ok(!/\.git\/config[,; ]/.test(s.detail!), s.detail);
  } finally {
    try { git(dir, 'worktree', 'remove', '--force', wt); } catch { /* best effort */ }
    rmrf(dir);
  }
});

test('gitMetaChanges reports added, changed and removed entries; outside git there is no fingerprint', async () => {
  assert.deepEqual(gitMetaChanges({ a: '1', b: '2', c: '3' }, { a: '1', b: 'x', d: '4' }), ['b', 'c', 'd']);
  assert.deepEqual(gitMetaChanges({ a: '-' }, {}), []);
  const plain = tmpDir('nogit-meta');
  try { assert.equal(await gitMetaFingerprint(plain), undefined); } finally { rmrf(plain); }
});

test('ifMissing: skips while the path exists, runs when absent or when a link leads outside the tree; bad paths fail closed', async () => {
  const dir = makeRepo({ 'ok.cjs': 'process.exit(0)\n' });
  const outside = tmpDir('outside-nm');
  try {
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.symlinkSync(outside, path.join(dir, 'linked_modules'), 'junction');
    const s = await runVerify({ cwd: dir, root: dir, commands: [
      { kind: 'build', command: 'node ok.cjs', ifMissing: 'node_modules' },
      { kind: 'build', command: 'node ok.cjs', ifMissing: 'vendor' },
      { kind: 'build', command: 'node ok.cjs', ifMissing: 'linked_modules' },
      { kind: 'build', command: 'node ok.cjs', ifMissing: '../x' },
      { kind: 'build', command: 'node ok.cjs', ifExists: 'missing.lock', ifMissing: 'vendor' },
    ] });
    assert.deepEqual(s.map(x => [x.ok, x.detail]), [
      [true, 'node ok.cjs: skipped (node_modules present)'],
      [true, 'node ok.cjs: exit 0'],
      [true, 'node ok.cjs: exit 0'],
      [false, 'node ok.cjs: invalid ifMissing path "../x"'],
      [true, 'node ok.cjs: skipped (no missing.lock)'],
    ]);
    assert.deepEqual(projectCommands({ coder: [{ command: 'npm ci', kind: 'build', ifMissing: 'node_modules' }] }, 'coder'),
      [{ kind: 'build', command: 'npm ci', ifMissing: 'node_modules' }]);
    assert.throws(() => projectCommands({ coder: [{ command: 'x', ifMissing: '/abs' }] }, 'coder'), /ifMissing must be a repo-relative path/);
  } finally { rmrf(dir); rmrf(outside); }
});
