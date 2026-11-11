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
