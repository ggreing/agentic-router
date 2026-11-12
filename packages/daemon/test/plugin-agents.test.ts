// plugin/agents/*.md: the five role files parse with core parseRoleFile and follow spec 3.3 and the
// role rules (tools, default model/effort = start step, isolation, maxTurns, x-router).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORBIDDEN_ROLE_TOOLS, ladderStep, readRoleFile, type Role } from '@agentic-router/core';
import { defaultStartStep, ROLES } from '../src/policy.ts';
import { takeSnapshot } from '../src/git.ts';
import { resolveVerifyCommands } from '../src/verify-source.ts';
import { isEnvFailure, runVerify } from '../src/verify.ts';
import { git, makeRepo, rmrf, write } from './helpers.ts';

const PLUGIN = fileURLToPath(new URL('../../../plugin/', import.meta.url));
const AGENTS = path.join(PLUGIN, 'agents');

const TOOLS: Record<Role, string[]> = {
  architect: ['Read', 'Grep', 'Glob', 'Write', 'Edit'],
  'ui-designer': ['Read', 'Grep', 'Glob', 'Write', 'Edit'],
  coder: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'],
  reviewer: ['Read', 'Grep', 'Glob'],
  tester: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'],
};

test('exactly the five role files exist', () => {
  assert.deepEqual(fs.readdirSync(AGENTS).sort(), ROLES.map(r => `${r}.md`).sort());
});

for (const role of ROLES) {
  test(`${role}.md parses and follows the role rules`, () => {
    const f = readRoleFile(path.join(AGENTS, `${role}.md`));
    assert.equal(f.name, role);
    assert.equal(f.role, role);
    assert.match(f.description ?? '', /\[subtask:<ID>\]/);
    assert.match(f.description ?? '', /Use only when the Agentic Router lead calls it/);
    assert.deepEqual(f.tools, TOOLS[role]);
    for (const t of FORBIDDEN_ROLE_TOOLS) assert.ok(!f.tools.includes(t), `${role} must not have ${t}`);
    // default model/effort = the role's default start step (the Agent call's model/effort wins)
    const start = ladderStep(defaultStartStep('L2', role));
    assert.deepEqual([f.model, f.effort], [start.alias, start.effort]);
    assert.equal(f.isolation, undefined);   // decision 83: the lead passes isolation per call, only for concurrent writers
    assert.equal(f.maxTurns, role === 'coder' ? 40 : 30);
    for (const h of ['## Work unit', '## Responsibilities', '## Forbidden', '## Report format']) assert.ok(f.body.includes(h), `${role}: missing ${h}`);
    for (const item of ['Changed files:', 'Checks run:', 'Scope request:', 'Remaining issues:']) assert.ok(f.body.includes(`- ${item}`), `${role}: report item ${item}`);
  });
}

// Decision 139: model-facing text is English, so the router behaves the same whatever the user's language.
const HANGUL = /[가-힣ᄀ-ᇿ㄰-㆏]/;
const filesUnder = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap(e => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)]));

test('decision 139: role files, skills and hooks are English; the report items line up with the skill, the guard and the router', () => {
  for (const dir of ['agents', 'skills', 'hooks']) {
    for (const file of filesUnder(path.join(PLUGIN, dir))) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      const bad = lines.findIndex(l => HANGUL.test(l));
      assert.equal(bad, -1, `${path.relative(PLUGIN, file)}:${bad + 1} is not English: ${lines[bad]?.slice(0, 80)}`);
    }
  }
  // every place that names the report's scope line names the same item
  const skill = fs.readFileSync(path.join(PLUGIN, 'skills', 'lead-orchestrator', 'SKILL.md'), 'utf8');
  const guard = fs.readFileSync(path.join(PLUGIN, 'hooks', 'guard.mjs'), 'utf8');
  const router = fs.readFileSync(fileURLToPath(new URL('../src/router.ts', import.meta.url)), 'utf8');
  assert.match(skill, /report's "scope request" line/);
  assert.match(guard, /add it to your report's "scope request" line/);
  assert.match(router, /list them under "Scope request" in your report/);
  // the margin the lead passes on to router_report_result is the word after "Margin:" in the reviewer's or tester's report
  assert.match(skill, /`margin` exactly as their report says \(`easy` or `normal`\)/);
  for (const role of ['reviewer', 'tester'] as const) {
    const body = readRoleFile(path.join(AGENTS, `${role}.md`)).body;
    assert.match(body, /`Margin: easy`/, role);
    assert.match(body, /`Margin: normal`/, role);
  }
});

test('default model/effort match the role table', () => {
  const got = Object.fromEntries(ROLES.map(r => { const f = readRoleFile(path.join(AGENTS, `${r}.md`)); return [r, `${f.model}/${f.effort}`]; }));
  assert.deepEqual(got, { architect: 'sonnet/medium', 'ui-designer': 'sonnet/medium', coder: 'haiku/low', reviewer: 'sonnet/medium', tester: 'haiku/low' });
});

test('x-router.verify: install if locked, then coder build/typecheck/lint/test with package.json, and pytest on the related tests', async () => {
  const cmds = async (role: Role) => (await resolveVerifyCommands({ role, pluginDir: PLUGIN })).commands;
  const install = { kind: 'build', command: 'npm ci', ifExists: 'package-lock.json', ifMissing: 'node_modules' };
  // npm steps need only package.json: a dependency-free `node --test` project has no node_modules; a helper
  // package.json whose tools are not installed fails as "environment" (decision 122), not as the subagent's failure
  const pytest = { kind: 'test', command: 'python -m pytest -q -x {relatedTests}', ifAnyExists: ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini', 'conftest.py'] };
  assert.deepEqual(await cmds('coder'), [
    install,
    { kind: 'build', command: 'npm run build --if-present', ifExists: 'package.json' },
    { kind: 'typecheck', command: 'npm run typecheck --if-present', ifExists: 'package.json' },
    { kind: 'lint', command: 'npm run lint --if-present', ifExists: 'package.json' },
    { kind: 'test', command: 'npm test --if-present', ifExists: 'package.json' },
    pytest,
  ]);
  assert.deepEqual(await cmds('tester'), [install, { kind: 'test', command: 'npm test --if-present', ifExists: 'package.json' }, pytest]);
  for (const r of ['architect', 'ui-designer', 'reviewer'] as const) {
    const res = await resolveVerifyCommands({ role: r, pluginDir: PLUGIN });
    assert.deepEqual(res, { commands: [], source: 'role' }, r);
  }
});

test('in a repository without package.json the coder\'s npm steps are skipped, not failed', async () => {
  const repo = makeRepo({ 'setup.py': 'print(1)\n' });
  try {
    const { commands } = await resolveVerifyCommands({ role: 'coder', pluginDir: PLUGIN });
    const signals = await runVerify({ cwd: repo, root: repo, commands });
    assert.equal(signals.length, 6);
    assert.ok(signals.every(s => s.ok), JSON.stringify(signals));
    assert.equal(signals[0]!.detail, 'npm ci: skipped (no package-lock.json)');
    assert.equal(signals[4]!.detail, 'npm test --if-present: skipped (no package.json)');
    assert.equal(signals[5]!.detail, 'python -m pytest -q -x {relatedTests}: skipped (none of pytest.ini, pyproject.toml, setup.cfg, tox.ini, conftest.py)');
  } finally { rmrf(repo); }
});

test('decision 122: a Python repo whose helper package.json needs an uninstalled tool: npm is an environment failure; pytest runs on the related tests only', async () => {
  const repo = makeRepo({
    'package.json': '{"scripts":{"test":"no-such-linter-xyz ."}}', 'setup.cfg': '[tool:pytest]\n',
    'pkg/parse.py': 'def parse(s):\n    return s\n', 'pkg/other.py': 'x = 1\n',
    'tests/test_parse.py': 'def test_parse():\n    pass\n', 'tests/test_other.py': 'def test_other():\n    pass\n',
  });
  try {
    const snapshot = await takeSnapshot(repo);
    write(repo, 'pkg/parse.py', 'def parse(s):\n    return s or ""\n');
    const { commands } = await resolveVerifyCommands({ role: 'coder', pluginDir: PLUGIN });
    // the runner is a stand-in for python that prints the arguments it got and exits 0
    const shim = commands.map(c => (c.command.includes('{relatedTests}') ? { ...c, command: 'node -e "console.log(process.argv.slice(1).join(\' \'))" {relatedTests}' } : c));
    const signals = await runVerify({ cwd: repo, root: repo, commands: shim, scope: { allowed: ['**'], protected: [], unscoped: true, snapshot } });
    const npmTest = signals.find(s => s.detail?.startsWith('npm test'))!;
    assert.equal(isEnvFailure(npmTest), true, npmTest.detail);
    assert.match(npmTest.detail!, /environment: (no-such-linter-xyz|a command was) not found/);
    const py = signals.find(s => s.detail?.includes('tests/test_parse.py'));
    assert.ok(py?.ok, JSON.stringify(signals));
    assert.doesNotMatch(py!.detail!, /test_other/);
    // nothing related changed: recorded, not run
    const none = await runVerify({ cwd: repo, root: repo, commands: shim.slice(-1), scope: { allowed: ['**'], protected: [], unscoped: true, snapshot: await takeSnapshot(repo) } });
    assert.deepEqual(none.map(s => [s.ok, s.detail]).slice(0, 1), [[true, 'node -e "console.log(process.argv.slice(1).join(\' \'))" {relatedTests}: no related tests (not run; neither a pass nor a miss)']]);
  } finally { rmrf(repo); }
});

test('decision 86: the install step is skipped in the user\'s tree (node_modules present) and runs in a fresh worktree', async () => {
  // the role file's own install step, with npm ci swapped for a script that leaves a marker
  const { commands } = await resolveVerifyCommands({ role: 'coder', pluginDir: PLUGIN });
  const install = { ...commands[0]!, command: 'node install.cjs' };
  assert.deepEqual([commands[0]!.ifExists, commands[0]!.ifMissing], ['package-lock.json', 'node_modules']);
  const repo = makeRepo({ 'package.json': '{}', 'package-lock.json': '{}', '.gitignore': 'node_modules/\ninstalled.txt\n',
    'install.cjs': 'require("fs").writeFileSync("installed.txt", "yes")\n' });
  const wt = path.join(repo, '.claude', 'worktrees', 'agent-x');
  try {
    fs.mkdirSync(path.join(repo, 'node_modules'));
    const user = await runVerify({ cwd: repo, root: repo, commands: [install] });
    assert.deepEqual(user, [{ kind: 'build', ok: true, detail: 'node install.cjs: skipped (node_modules present)' }]);
    assert.equal(fs.existsSync(path.join(repo, 'installed.txt')), false);
    git(repo, 'worktree', 'add', '-q', '-b', 'wt-x', wt);
    const fresh = await runVerify({ cwd: wt, root: wt, commands: [install] });
    assert.deepEqual(fresh, [{ kind: 'build', ok: true, detail: 'node install.cjs: exit 0' }]);
    assert.equal(fs.readFileSync(path.join(wt, 'installed.txt'), 'utf8'), 'yes');
  } finally {
    try { git(repo, 'worktree', 'remove', '--force', wt); } catch { /* best effort */ }
    rmrf(repo);
  }
});

test('a dependency-free node --test project (no node_modules) still runs npm test', async () => {
  const repo = makeRepo({
    'package.json': '{"name":"tiny","scripts":{"test":"node --test"}}',
    'math.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert';\ntest('adds', () => assert.equal(1 + 1, 2));\n",
  });
  try {
    const { commands } = await resolveVerifyCommands({ role: 'tester', pluginDir: PLUGIN });
    const signals = await runVerify({ cwd: repo, root: repo, commands });
    const npmTest = signals.find(s => s.detail?.startsWith('npm test'))!;
    assert.equal(npmTest.ok, true, npmTest.detail);
    assert.equal(npmTest.detail, 'npm test --if-present: exit 0');
  } finally { rmrf(repo); }
});
