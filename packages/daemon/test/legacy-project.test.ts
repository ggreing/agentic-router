// Decision 161: a project that has not renamed .agentic-router (the previous release's folder) keeps its
// verify.json and teams.yaml for this release; the new folder wins file by file. Temp repositories only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { nullLogger } from '../src/log.ts';
import { PresetResolver } from '../src/presets.ts';
import { resolveVerifyCommands } from '../src/verify-source.ts';
import { git, makeRepo, rmrf, tmpDir, write } from './helpers.ts';

test('decision 161: verify.json in the previous folder is read from the start commit while the new folder has none', async () => {
  const dir = makeRepo({ '.agentic-router/verify.json': JSON.stringify({ coder: ['node old.cjs'] }) });
  try {
    let base = git(dir, 'rev-parse', 'HEAD').trim();
    assert.deepEqual(await resolveVerifyCommands({ role: 'coder', repoRoot: dir, baseRef: base }), { commands: [{ kind: 'test', command: 'node old.cjs' }], source: 'project' });
    assert.equal((await resolveVerifyCommands({ role: 'coder', repoRoot: dir })).commands[0]?.command, 'node old.cjs', 'from the work tree too');
    // a broken file is named by the folder it is in
    write(dir, '.agentic-router/verify.json', '{');
    git(dir, 'commit', '-qam', 'broken');
    base = git(dir, 'rev-parse', 'HEAD').trim();
    assert.match((await resolveVerifyCommands({ role: 'coder', repoRoot: dir, baseRef: base })).warning ?? '', /^\.agentic-router\/verify\.json ignored/);
    // the new folder wins
    write(dir, '.do-it-all-claude-code/verify.json', JSON.stringify({ coder: ['node new.cjs'] }));
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'renamed');
    base = git(dir, 'rev-parse', 'HEAD').trim();
    assert.equal((await resolveVerifyCommands({ role: 'coder', repoRoot: dir, baseRef: base })).commands[0]?.command, 'node new.cjs');
  } finally { rmrf(dir); }
});

test('decision 161: teams.yaml in the previous folder is read while the new folder has none', () => {
  const repo = makeRepo({ '.agentic-router/teams.yaml': 'L2:\n  budget_usd: 7\n' });
  const home = tmpDir('home');
  try {
    const r = new PresetResolver({ homeRoot: home, log: nullLogger });
    let got = r.resolve(repo);
    assert.deepEqual([got.source, got.presets.L2.budgetUsd], ['project', 7]);
    fs.mkdirSync(path.join(repo, '.do-it-all-claude-code'));
    fs.writeFileSync(path.join(repo, '.do-it-all-claude-code', 'teams.yaml'), 'L2:\n  budget_usd: 9\n');
    got = r.resolve(repo);
    assert.equal(got.presets.L2.budgetUsd, 9, 'the new folder wins');
  } finally { rmrf(repo); rmrf(home); }
});
