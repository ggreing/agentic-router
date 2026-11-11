// plugin/agents/*.md: the five role files parse with core parseRoleFile and follow spec 3.3 and the
// role rules (tools, default model/effort = start step, isolation, maxTurns, x-router).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORBIDDEN_ROLE_TOOLS, ladderStep, readRoleFile, type Role } from '@agentic-router/core';
import { defaultStartStep, ROLES } from '../src/policy.ts';
import { resolveVerifyCommands } from '../src/verify-source.ts';
import { runVerify } from '../src/verify.ts';
import { git, makeRepo, rmrf } from './helpers.ts';

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
    assert.match(f.description ?? '', /총괄/);
    assert.deepEqual(f.tools, TOOLS[role]);
    for (const t of FORBIDDEN_ROLE_TOOLS) assert.ok(!f.tools.includes(t), `${role} must not have ${t}`);
    // default model/effort = the role's default start step (the Agent call's model/effort wins)
    const start = ladderStep(defaultStartStep('L2', role));
    assert.deepEqual([f.model, f.effort], [start.alias, start.effort]);
    assert.equal(f.isolation, undefined);   // decision 83: the lead passes isolation per call, only for concurrent writers
    assert.equal(f.maxTurns, role === 'coder' ? 40 : 30);
    for (const h of ['## 책임', '## 금지', '## 완료 보고 형식']) assert.ok(f.body.includes(h), `${role}: missing ${h}`);
    for (const item of ['변경 파일:', '실행한 검증:', '범위 변경 요청:', '남은 이슈:']) assert.ok(f.body.includes(`- ${item}`), `${role}: report item ${item}`);
  });
}

test('default model/effort match the role table', () => {
  const got = Object.fromEntries(ROLES.map(r => { const f = readRoleFile(path.join(AGENTS, `${r}.md`)); return [r, `${f.model}/${f.effort}`]; }));
  assert.deepEqual(got, { architect: 'sonnet/medium', 'ui-designer': 'sonnet/medium', coder: 'haiku/low', reviewer: 'sonnet/medium', tester: 'haiku/low' });
});

test('x-router.verify: install if locked, then coder build/typecheck/lint/test, tester test; npm steps only with package.json', async () => {
  const cmds = async (role: Role) => (await resolveVerifyCommands({ role, pluginDir: PLUGIN })).commands;
  const install = { kind: 'build', command: 'npm ci', ifExists: 'package-lock.json', ifMissing: 'node_modules' };
  assert.deepEqual(await cmds('coder'), [
    install,
    { kind: 'build', command: 'npm run build --if-present', ifExists: 'package.json' },
    { kind: 'typecheck', command: 'npm run typecheck --if-present', ifExists: 'package.json' },
    { kind: 'lint', command: 'npm run lint --if-present', ifExists: 'package.json' },
    { kind: 'test', command: 'npm test --if-present', ifExists: 'package.json' },
  ]);
  assert.deepEqual(await cmds('tester'), [install, { kind: 'test', command: 'npm test --if-present', ifExists: 'package.json' }]);
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
    assert.equal(signals.length, 5);
    assert.ok(signals.every(s => s.ok), JSON.stringify(signals));
    assert.equal(signals[0]!.detail, 'npm ci: skipped (no package-lock.json)');
    assert.equal(signals[4]!.detail, 'npm test --if-present: skipped (no package.json)');
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
