// Decision 164: the previous release's project folder (.agentic-router) is no longer read: its verify.json and
// teams.yaml count only once the folder is renamed to .do-it-all-claude-code. Temp repositories only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { nullLogger } from '../src/log.ts';
import { PresetResolver } from '../src/presets.ts';
import { resolveVerifyCommands } from '../src/verify-source.ts';
import { git, makeRepo, rmrf, tmpDir } from './helpers.ts';

test('decision 164: verify.json in the previous folder is not read; renamed, it is', async () => {
  const dir = makeRepo({ '.agentic-router/verify.json': JSON.stringify({ coder: ['node old.cjs'] }) });
  try {
    let base = git(dir, 'rev-parse', 'HEAD').trim();
    assert.equal((await resolveVerifyCommands({ role: 'coder', repoRoot: dir, baseRef: base })).source, 'none');
    assert.equal((await resolveVerifyCommands({ role: 'coder', repoRoot: dir })).source, 'none', 'from the work tree neither');
    git(dir, 'mv', '.agentic-router', '.do-it-all-claude-code');
    git(dir, 'commit', '-qm', 'renamed');
    base = git(dir, 'rev-parse', 'HEAD').trim();
    assert.deepEqual(await resolveVerifyCommands({ role: 'coder', repoRoot: dir, baseRef: base }), { commands: [{ kind: 'test', command: 'node old.cjs' }], source: 'project' });
  } finally { rmrf(dir); }
});

test('decision 164: teams.yaml in the previous folder is not read; renamed, it is', () => {
  const repo = makeRepo({ '.agentic-router/teams.yaml': 'L2:\n  budget_usd: 7\n' });
  const home = tmpDir('home');
  try {
    const r = new PresetResolver({ homeRoot: home, log: nullLogger });
    const before = r.resolve(repo);
    assert.equal(before.source, 'default');
    assert.notEqual(before.presets.L2.budgetUsd, 7);
    fs.renameSync(path.join(repo, '.agentic-router'), path.join(repo, '.do-it-all-claude-code'));
    const after = r.resolve(repo);
    assert.deepEqual([after.source, after.presets.L2.budgetUsd], ['project', 7]);
  } finally { rmrf(repo); rmrf(home); }
});
