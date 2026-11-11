// Review #5: config.budgetsUsd from `init` replaces the preset per-request budgets (positive finite only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PRESETS } from '@agentic-router/core';
import { applyBudgets, parseBudgets, readConfig } from '../src/config.ts';
import type { StatusView } from '../src/router.ts';
import { TEAM_L1_PRESETS, copyTranscript, getStatus, makeHome, postHook, rmrf, startTestDaemon, tmpDir } from './helpers.ts';

const L1_PROMPT = 'Fix the bug where parse() fails on empty input in src/parse.ts';

test('budgets: only positive finite numbers for known levels are taken; the rest is reported', () => {
  const warnings: string[] = [];
  assert.deepEqual(parseBudgets({ L0: 0.25, L1: null, L2: -1, L3: 3, L9: 5, L2x: 'a' }, warnings), { L0: 0.25, L3: 3 });
  assert.equal(warnings.length, 4);
  assert.ok(warnings.some(w => /L1 ignored: null is not a positive number/.test(w)));
  assert.ok(warnings.some(w => /L9 ignored: unknown level/.test(w)));
  assert.equal(parseBudgets(undefined, []), undefined);
  const w2: string[] = [];
  assert.equal(parseBudgets([1, 2], w2), undefined);
  assert.match(w2[0]!, /not an object/);
  assert.equal(parseBudgets({ L0: 0 }, []), undefined);

  const p = applyBudgets(DEFAULT_PRESETS, { L1: 0.5 });
  assert.equal(p.L1.budgetUsd, 0.5);
  assert.equal(p.L2.budgetUsd, DEFAULT_PRESETS.L2.budgetUsd);
  assert.equal(DEFAULT_PRESETS.L1.budgetUsd, 2, 'defaults must not be mutated');

  const dir = tmpDir('cfg');
  try {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ daemonPort: 1, fableOptIn: false, budgetsUsd: { L1: 0.75, L2: 'x' } }));
    const w3: string[] = [];
    assert.deepEqual(readConfig(file, w3).budgetsUsd, { L1: 0.75 });
    assert.equal(w3.length, 1);
  } finally { rmrf(dir); }
});

test('the daemon plans requests with the configured budget and denies once it is spent', async () => {
  const home = makeHome({ budgetsUsd: { L1: 0.002, L3: 'nope' } });
  const d = await startTestDaemon({ home, presets: TEAM_L1_PRESETS });   // decision 88: L1 is lead-direct by default
  try {
    const b = { session_id: 'bud', cwd: home, transcript_path: path.join(home, 't.jsonl') };
    const brief = await postHook(d.port, { ...b, hook_event_name: 'UserPromptSubmit', prompt: L1_PROMPT });
    assert.match((brief.body as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext, /budget \$0\.002\./);
    const st = (await getStatus(d.port, 'bud')).body as StatusView;
    assert.equal(st.request?.budgetUsd, 0.002);

    // spend it through a subagent's transcript (the fixture costs ~$0.0026), then the next Agent call is denied
    await postHook(d.port, { ...b, hook_event_name: 'SubagentStop', agent_id: 'x1', agent_type: 'Explore', stop_hook_active: false,
      agent_transcript_path: copyTranscript(home, 'x1') });
    const r = await postHook(d.port, { ...b, hook_event_name: 'PreToolUse', tool_name: 'Agent',
      tool_input: { subagent_type: 'agentic-router:coder', prompt: '[subtask:A] x', model: 'haiku', effort: 'low' } });
    const out = r.body as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput?.permissionDecisionReason ?? '', /budget is used up .* of \$0\.002\)/);

    // a manual level uses the configured budgets too
    const lvl = await postHook(d.port, { ...b, hook_event_name: 'UserPromptSubmit', prompt: '/router level L1' });
    assert.match((lvl.body as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext, /budget \$0\.002\./);
  } finally { await d.close(); }
  try {
    assert.match(fs.readFileSync(path.join(home, 'logs', 'daemon.log'), 'utf8'), /config\.budgetsUsd\.L3 ignored/);
  } finally { rmrf(home); }
});
