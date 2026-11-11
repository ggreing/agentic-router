// teams.yaml layers (gap in decision 88) and config.forceLevel (decision 107).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { formatStatus } from '../../../plugin/statusline.mjs';
import type { StatusView } from '../src/router.ts';
import { getStatus, makeRepo, postHook, rmrf, rows, startTestDaemon, type TestDaemon } from './helpers.ts';

const L0_PROMPT = 'fix the typo in README.md';
const L1_PROMPT = 'Fix the bug where parse() fails on empty input in src/parse.ts';

async function withDaemon(fn: (d: TestDaemon) => Promise<void>, config: Record<string, unknown> = {}): Promise<void> {
  const d = await startTestDaemon({ config });
  try { await fn(d); } finally { await d.close(); rmrf(d.home); }
}
const ask = async (d: TestDaemon, sid: string, cwd: string, prompt: string) => {
  const r = await postHook(d.port, { session_id: sid, cwd, hook_event_name: 'UserPromptSubmit', prompt });
  assert.equal(r.status, 200, r.text);
  return (r.body as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? '';
};
const status = async (d: TestDaemon, sid: string) => ((await getStatus(d.port, sid)).body as StatusView).request!;
const logText = (d: TestDaemon) => fs.readdirSync(path.join(d.home, 'logs')).map(f => fs.readFileSync(path.join(d.home, 'logs', f), 'utf8')).join('');

test('teams.yaml: the user\'s file, then the project\'s, then config budgets; the status names the source', () => withDaemon(async d => {
  const repo = makeRepo({ 'README.md': 'r\n' });
  const plain = path.join(d.home, 'not-a-repo');
  fs.mkdirSync(plain);
  try {
    assert.equal((await (async () => { await ask(d, 's0', plain, L1_PROMPT); return status(d, 's0'); })()).presetSource, 'default');
    // the user switches L1 to delegation (decision 88: `L1: { lead_direct: false }` is enough)
    fs.writeFileSync(path.join(d.home, 'teams.yaml'), 'L1:\n  lead_direct: false\n');
    const ctx = await ask(d, 's1', plain, L1_PROMPT);
    let st = await status(d, 's1');
    assert.deepEqual([st.level, st.leadDirect, st.presetSource, st.budgetUsd], ['L1', false, 'user', 1.5]);   // config budget on top
    assert.match(ctx, /Routing is ON for this request/);
    // the project turns it back and sets its own budget; config.budgetsUsd still wins
    fs.mkdirSync(path.join(repo, '.agentic-router'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.agentic-router', 'teams.yaml'), 'L1:\n  lead_direct: true\nL2:\n  budget_usd: 7\n');
    await ask(d, 's2', path.join(repo), L1_PROMPT);
    st = await status(d, 's2');
    assert.deepEqual([st.leadDirect, st.presetSource, st.budgetUsd], [true, 'user+project', 1.5]);
    assert.deepEqual(JSON.parse(String(rows(d, "SELECT team FROM requests WHERE session_id = 's2'")[0]!.team)).roles.map((r: { role: string }) => r.role), ['coder']);   // the L1 team (decision 118)
    // an invalid project file is ignored (logged once), the user's still applies
    fs.writeFileSync(path.join(repo, '.agentic-router', 'teams.yaml'), 'L1:\n  roles: nope\n');
    await ask(d, 's3', repo, L1_PROMPT);
    await ask(d, 's4', repo, L1_PROMPT);
    st = await status(d, 's4');
    assert.deepEqual([st.leadDirect, st.presetSource], [false, 'user']);
    assert.equal(logText(d).match(/teams\.yaml ignored: invalid/g)?.length, 1);
  } finally { rmrf(repo); }
}, { budgetsUsd: { L1: 1.5 } }));

test('decision 107: config.forceLevel plans every new request at that level; the rules\' result stays in the rationale', () => withDaemon(async d => {
  const ctx = await ask(d, 'f1', d.home, L0_PROMPT);
  const st = await status(d, 'f1');
  assert.deepEqual([st.level, st.leadDirect, st.forcedFrom, st.budgetUsd], ['L2', false, 'L0', 5]);
  assert.match(ctx, /^\[agentic-router\] level L2 .*forced L2; rule said L0/);
  assert.match(ctx, /Routing is ON for this request/);   // a team level: the team brief, no lead judgement
  assert.equal(formatStatus({ request: st, roles: [], costUsd: 0 }), '[Router] L2 forced | $0.00');
  // it wins over a pending /router level
  await postHook(d.port, { session_id: 'f2', cwd: d.home, hook_event_name: 'UserPromptSubmit', prompt: '/router level L3' });
  await ask(d, 'f2', d.home, L1_PROMPT);
  assert.deepEqual(rows(d, "SELECT level, forced_from FROM requests WHERE session_id = 'f2'"), [{ level: 'L2', forced_from: 'L1' }]);
}, { forceLevel: 'L2' }));

test('decision 107: an invalid forceLevel is reported and ignored', () => withDaemon(async d => {
  await ask(d, 'f3', d.home, L0_PROMPT);
  const st = await status(d, 'f3');
  assert.deepEqual([st.level, st.forcedFrom], ['L0', null]);
  assert.equal(formatStatus({ request: st, roles: [], costUsd: 0 }), '[Router] L0 · direct | $0.00');
  assert.match(logText(d), /config\.forceLevel ignored: \\"L9\\" is not L0, L1, L2 or L3/);
}, { forceLevel: 'L9' }));
