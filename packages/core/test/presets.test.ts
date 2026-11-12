import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PRESETS, loadPresets } from '@agentic-router/core';

const tmp = (name: string, text: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-presets-')); const f = path.join(d, name); fs.writeFileSync(f, text); return f; };

test('teams.yaml: a level may set only lead_direct; other fields come from the base (decision 88)', () => {
  const p = loadPresets(tmp('teams.yaml', 'L1:\n  lead_direct: false\n'));
  assert.equal(p.L1.leadDirect, undefined);
  assert.deepEqual(p.L1.roles, DEFAULT_PRESETS.L1.roles);
  assert.equal(p.L1.budgetUsd, DEFAULT_PRESETS.L1.budgetUsd);
  assert.equal(p.L0.leadDirect, true);
});

test('the repository file layers over the user file', () => {
  const user = loadPresets(tmp('teams.yaml', 'L2:\n  budget_usd: 9\nL1:\n  lead_direct: false\n'));
  const repo = loadPresets(tmp('teams.yaml', 'L2:\n  roles:\n    - { role: coder, count: 1, start: s2 }\n'), user);
  assert.equal(repo.L2.budgetUsd, 9, 'user budget kept');
  assert.deepEqual(repo.L2.roles, [{ role: 'coder', count: 1, start: 's2' }]);
  assert.equal(repo.L1.leadDirect, undefined, 'user lead_direct kept');
});

test('invalid teams.yaml throws', () => {
  assert.throws(() => loadPresets(tmp('teams.yaml', 'L1:\n  roles: []\n')));
  assert.throws(() => loadPresets(tmp('teams.yaml', 'L9:\n  lead_direct: true\n')));
});

test('delegation starts at L1 for an Opus-class lead and at L2 otherwise (decisions 117-118)', async () => {
  const { withLeadModel, leadModelClass } = await import('@agentic-router/core');
  assert.equal(leadModelClass('claude-opus-5-5'), 'opus');
  assert.equal(leadModelClass('claude-fable-5-1'), 'opus');
  assert.equal(leadModelClass('claude-sonnet-5-5'), 'sonnet');
  assert.equal(leadModelClass(undefined), 'other');
  const opus = withLeadModel(DEFAULT_PRESETS, 'claude-opus-5-5');
  assert.equal(opus.L0.leadDirect, true);
  assert.equal(opus.L1.leadDirect, undefined, 'Opus lead delegates L1');
  assert.deepEqual(opus.L1.roles, [{ role: 'coder', count: 1, start: 's1' }], 'light L1 team');
  assert.equal(withLeadModel(DEFAULT_PRESETS, 'claude-sonnet-5-5').L1.leadDirect, undefined, 'Sonnet lead delegates L1 (decision 124)');
  const haiku = withLeadModel(DEFAULT_PRESETS, 'claude-haiku-5-5');
  assert.equal(haiku.L1.leadDirect, true);
  assert.equal(haiku.L2.leadDirect, undefined);
  assert.equal(withLeadModel(DEFAULT_PRESETS, 'claude-sonnet-5-5', { sonnet: 'L2' }).L1.leadDirect, true, 'config override');
  const fileOverride = loadPresets(tmp('teams.yaml', 'L1:\n  lead_direct: true\n'), opus);
  assert.equal(fileOverride.L1.leadDirect, true, 'explicit teams.yaml lead_direct wins');
});
