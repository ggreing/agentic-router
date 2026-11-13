import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { COMMON_DEV_PORTS, ensureLocalState, ladderBreakers, planProject, planStatusLine, readConfig, versionAtLeast } from 'do-it-all-claude-code';
import { paths } from '@do-it-all-claude-code/core';

let tmp = '';
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-cli-'));
  process.env.DO_IT_ALL_CLAUDE_CODE_HOME = path.join(tmp, 'home');
});

test('init creates config and a token once, on a port outside common dev ports', async () => {
  const a = await ensureLocalState();
  assert.equal(a.token, 'created');
  assert.ok(!COMMON_DEV_PORTS.has(a.config.daemonPort));
  const tokenBefore = fs.readFileSync(paths.token(), 'utf8');
  const b = await ensureLocalState({ L2: 7 });
  assert.equal(b.token, 'kept');
  assert.equal(fs.readFileSync(paths.token(), 'utf8'), tokenBefore);
  assert.equal(b.config.daemonPort, a.config.daemonPort);
  assert.equal(readConfig()?.budgetsUsd.L2, 7);
});

test('status line wraps an existing one and backs up the settings file', async () => {
  const { config } = await ensureLocalState();
  const settings = path.join(tmp, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: 'my-line.sh' }, model: 'opus' }));
  const plan = planStatusLine(settings, '/plugin/statusline.mjs', config);
  assert.ok(plan);
  plan.apply();
  const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.equal(after.model, 'opus');
  assert.match(after.statusLine.command, /statusline\.mjs/);
  assert.equal(readConfig()?.wrappedStatusLine?.command, 'my-line.sh');
  assert.ok(fs.existsSync(settings + '.do-it-all-claude-code.bak'));
  assert.equal(planStatusLine(settings, '/plugin/statusline.mjs', readConfig()!), null);   // idempotent
});

test('project setup: worktrees branch from HEAD and are git-ignored; non-git folders are untouched', () => {
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  assert.equal(planProject(repo).length, 0);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  for (const c of planProject(repo)) c.apply();
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'settings.local.json'), 'utf8')).worktree.baseRef, 'head');
  assert.match(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8'), /^\.claude\/worktrees\/$/m);
  assert.equal(planProject(repo).length, 0);   // idempotent
});

test('doctor flags settings that disable the ladder', () => {
  const names = ladderBreakers({ CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1', ANTHROPIC_API_KEY: 'x' }).map(c => c.name);
  assert.ok(names.includes('CLAUDE_CODE_SUBAGENT_MODEL_FORCE'));
  assert.ok(names.some(n => n.startsWith('ANTHROPIC_API_KEY')));
  assert.equal(ladderBreakers({}).length, 0);
  assert.ok(versionAtLeast('2.1.319 (Claude Code)', [2, 1, 295]));
  assert.ok(!versionAtLeast('2.1.290', [2, 1, 295]));
});
