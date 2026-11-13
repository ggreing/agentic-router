// End-to-end handler flow over HTTP, driven by the recorded spike runs (fixtures), a temp router
// home and temp git repos. Fixture paths are retargeted to the temp repo; probe agents become
// do-it-all-claude-code:coder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PRESETS, PROTECTED_WRITE_PATHS, costUsd, formatTriageContext, scopeKey, triage, type Usage } from '@do-it-all-claude-code/core';
import { AWAITING_USER_MARKER } from '../src/continuation.ts';
import type { StatusView } from '../src/router.ts';
import {
  TEAM_L0_PRESETS, TEAM_L1_PRESETS,
  FIXTURE_CALLS, copyTranscript, editAgentPrompt, getStatus, git, loadSpike, makeRepo, postHook, retarget, rmrf, rows, startTestDaemon, write,
  type HookInput, type TestDaemon,
} from './helpers.ts';

const L1_PROMPT = 'Fix the bug where parse() fails on empty input in src/parse.ts';
const L0_PROMPT = 'fix the typo in README.md';

type Out = { hookSpecificOutput?: { additionalContext?: string; permissionDecision?: string; permissionDecisionReason?: string }; decision?: string; reason?: string };

async function withDaemon(fn: (d: TestDaemon) => Promise<void>, opts: Parameters<typeof startTestDaemon>[0] = {}): Promise<void> {
  const d = await startTestDaemon(opts);
  try { await fn(d); } finally { await d.close(); rmrf(d.home); }
}

/** Verify with one repo-local check script (the command source itself is covered in verify.test.ts). */
const checkScript = { verify: { resolveCommands: async () => [{ kind: 'test' as const, command: 'node check.cjs' }] } };
const PASS = 'process.exit(0)\n';

const setPrompt = (inputs: HookInput[], prompt: string) => {
  for (const h of inputs) if (h.hook_event_name === 'UserPromptSubmit') h.prompt = prompt;
};
const agentPromptOf = (h: HookInput) => String((h.tool_input as { prompt?: unknown } | undefined)?.prompt ?? '');
const out = async (d: TestDaemon, h: HookInput): Promise<Out> => {
  const r = await postHook(d.port, h);
  assert.equal(r.status, 200, `${String(h.hook_event_name)}: ${r.text}`);
  return r.body as Out;
};
const subagentStop = (h: HookInput, stopHookActive: boolean): HookInput => ({ ...h, stop_hook_active: stopHookActive });

// ------------------------------------------------------------------ spike s1: two parallel coders

test('s1: brief injected, B denied (wrong step), A paired by order, verified, usage and verdict recorded', () => withDaemon(async d => {
  const repo = makeRepo({ 'README.md': 'r\n', 'check.cjs': PASS });
  try {
    const inputs = retarget(loadSpike('s1'), repo);
    setPrompt(inputs, L1_PROMPT);
    editAgentPrompt(inputs, '[subtask:A]', p => `${p}\n[scope: allowed/**]`);
    const A = 'a6bfb50a2449d77bb';
    const B = 'a4e3c4cc07571f390';
    const sessionId = String(inputs[0]!.session_id);
    const outs: Array<[string, Out]> = [];
    for (const h of inputs) {
      const isB = h.agent_id === B || agentPromptOf(h).includes('[subtask:B]');
      if (isB && h.hook_event_name !== 'PreToolUse') continue;            // denied: Claude Code never starts B
      if (h.hook_event_name === 'SubagentStop' && h.agent_id === A) {
        write(repo, 'allowed/a.txt', 'A');
        h.agent_transcript_path = copyTranscript(d.home, A);
      }
      outs.push([`${String(h.hook_event_name)}${h.tool_name ? `:${String(h.tool_name)}` : ''}${isB ? ':B' : ''}`, await out(d, h)]);
    }
    const by = (k: string) => outs.find(([n]) => n === k)?.[1];

    const t = triage({ prompt: L1_PROMPT }, TEAM_L1_PRESETS);
    assert.equal(t.level, 'L1');
    assert.equal(by('UserPromptSubmit')?.hookSpecificOutput?.additionalContext, formatTriageContext(t, TEAM_L1_PRESETS.L1, DEFAULT_PRESETS.L2));
    assert.deepEqual(by('PreToolUse:Agent'), {});
    const denyB = by('PreToolUse:Agent:B')?.hookSpecificOutput;
    assert.equal(denyB?.permissionDecision, 'deny');
    assert.match(denyB?.permissionDecisionReason ?? '', /subtask B: the coder runs at step s1 \(model="haiku", effort="low"\).*model="sonnet", effort="high"/);
    assert.deepEqual(by('SubagentStop'), {});

    // files for the guard
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d.home, 'agents', `${A}.json`), 'utf8')), {
      sessionId, subtaskId: 'A', role: 'coder', slot: 0, step: 's1', pairing: 'order', scope: { allowed: ['allowed/**'], protected: [...PROTECTED_WRITE_PATHS] },
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d.home, 'scopes', `${scopeKey(sessionId, 'A')}.json`), 'utf8')), { allowed: ['allowed/**'], protected: [...PROTECTED_WRITE_PATHS] });
    assert.equal(fs.existsSync(path.join(d.home, 'agents', `${B}.json`)), false);

    // ledger
    const [req] = rows(d, 'SELECT * FROM requests');
    assert.equal(req!.level, 'L1');
    assert.equal(req!.status, 'closed');
    const subs = rows(d, 'SELECT id, role, slot, step, agent_id, status, verdict, attempts FROM subtasks');
    assert.deepEqual(subs, [{ id: 'A', role: 'coder', slot: 0, step: 's1', agent_id: A, status: 'passed', verdict: 'meet', attempts: 1 }]);
    assert.deepEqual(rows(d, 'SELECT kind, ok, attempt FROM signals ORDER BY id'), [{ kind: 'test', ok: 1, attempt: 1 }, { kind: 'scope', ok: 1, attempt: 1 }]);
    const [agent] = rows(d, 'SELECT pairing, resolved_model, stop_count FROM agents WHERE agent_id = ?', A);
    assert.deepEqual(agent, { pairing: 'confirmed', resolved_model: 'claude-haiku-5-5', stop_count: 1 });
    // cost from the transcript (decision #4); the PostToolUse usage (last call only) is kept uncounted
    const postA = inputs.find(h => h.hook_event_name === 'PostToolUse' && h.tool_name === 'Agent' && agentPromptOf(h).includes('[subtask:A]'))!;
    const lastCall = costUsd('claude-haiku-5-5', (postA.tool_response as { usage: Usage }).usage)!;
    const usd = Math.round(FIXTURE_CALLS.reduce((a, u) => a + costUsd('claude-haiku-5-5', u)!, 0) * 1e6) / 1e6;
    assert.ok(usd > lastCall);
    assert.deepEqual(rows(d, 'SELECT source, subtask_id, agent_id, model_id, calls, usd FROM costs ORDER BY source'), [
      { source: 'agent_result', subtask_id: 'A', agent_id: A, model_id: 'claude-haiku-5-5', calls: 1, usd: lastCall },
      { source: 'transcript', subtask_id: 'A', agent_id: A, model_id: 'claude-haiku-5-5', calls: 4, usd },
    ]);
    assert.equal(rows(d, 'SELECT COUNT(*) AS c FROM events')[0]!.c, outs.length);

    // status line view
    const st = (await getStatus(d.port, sessionId)).body as StatusView;
    assert.equal(st.request?.level, 'L1');
    assert.equal(st.costUsd, usd);
    assert.deepEqual(st.roles.map(r => [r.role, r.slot, r.step, r.model, r.effort, r.status]), [
      ['coder', 0, 's1', 'haiku', 'low', 'passed'],   // decision 118: the L1 team is a single coder
    ]);
  } finally { rmrf(repo); }
}, { ...checkScript, presets: TEAM_L1_PRESETS }));   // a delegating L1 team (lead-direct L1 would be re-planned at L2, T6)

test('s1 variant: an edit outside the scope blocks once, then the second failure is recorded as miss', () => withDaemon(async d => {
  const repo = makeRepo({ 'check.cjs': PASS });
  try {
    const inputs = retarget(loadSpike('s1'), repo);
    setPrompt(inputs, L1_PROMPT);
    editAgentPrompt(inputs, '[subtask:A]', p => `${p}\n[scope: allowed/**]`);
    const A = 'a6bfb50a2449d77bb';
    const upTo = inputs.findIndex(h => h.hook_event_name === 'SubagentStart' && h.agent_id === A);
    for (const h of inputs.slice(0, upTo + 1)) if (!agentPromptOf(h).includes('[subtask:B]')) await out(d, h);
    const stop = inputs.find(h => h.hook_event_name === 'SubagentStop' && h.agent_id === A)!;
    write(repo, 'allowed/a.txt', 'A');
    write(repo, 'forbidden/x.txt', 'X');               // e.g. written through Bash, which the guard does not see

    const first = await out(d, subagentStop(stop, false));
    assert.equal(first.decision, 'block');
    assert.match(first.reason ?? '', /verification failed for subtask A/);
    assert.match(first.reason ?? '', /changed outside the allowed scope \[allowed\/\*\*\]: forbidden\/x\.txt/);
    assert.ok(!first.reason!.includes('allowed/a.txt'));
    assert.deepEqual(rows(d, 'SELECT status, verdict FROM subtasks'), [{ status: 'running', verdict: 'fail_once' }]);

    const second = await out(d, subagentStop(stop, true));
    assert.deepEqual(second, {});
    assert.deepEqual(rows(d, 'SELECT status, verdict FROM subtasks'), [{ status: 'failed', verdict: 'miss' }]);
    assert.deepEqual(rows(d, 'SELECT attempt, kind, ok FROM signals WHERE kind = ? ORDER BY id', 'scope'), [
      { attempt: 1, kind: 'scope', ok: 0 }, { attempt: 2, kind: 'scope', ok: 0 },
    ]);
  } finally { rmrf(repo); }
}, checkScript));

// ------------------------------------------------------------------ spike s2: block, fix, pass

test('s2: failing verify blocks the first stop; the same subagent fixes it and passes (meet)', () => withDaemon(async d => {
  const check = 'const t = require("fs").readFileSync("allowed/c.txt", "utf8");\nif (!t.includes("VERIFIED")) { console.error("allowed/c.txt is not VERIFIED"); process.exit(1); }\n';
  const repo = makeRepo({ 'check.cjs': check });
  try {
    const inputs = retarget(loadSpike('s2'), repo);
    setPrompt(inputs, L1_PROMPT);
    let stops = 0;
    const outs: Out[] = [];
    for (const h of inputs) {
      if (h.hook_event_name === 'SubagentStop') write(repo, 'allowed/c.txt', stops++ === 0 ? 'C\n' : 'C\nVERIFIED\n');
      const o = await out(d, h);
      if (h.hook_event_name === 'SubagentStop') outs.push(o);
    }
    assert.equal(outs.length, 2);
    assert.equal(outs[0]!.decision, 'block');
    assert.match(outs[0]!.reason!, /- test: node check\.cjs: exit 1/);
    assert.match(outs[0]!.reason!, /allowed\/c\.txt is not VERIFIED/);
    assert.deepEqual(outs[1], {});
    assert.deepEqual(rows(d, 'SELECT id, status, verdict FROM subtasks'), [{ id: 'C', status: 'passed', verdict: 'meet' }]);
    assert.deepEqual(rows(d, 'SELECT attempt, kind, ok FROM signals ORDER BY id'), [
      { attempt: 1, kind: 'test', ok: 0 }, { attempt: 1, kind: 'scope', ok: 1 }, { attempt: 2, kind: 'test', ok: 1 }, { attempt: 2, kind: 'scope', ok: 1 },
    ]);
    // the unscoped dispatch is noted in the scope signal
    assert.match(String(rows(d, 'SELECT detail FROM signals WHERE kind = ? LIMIT 1', 'scope')[0]!.detail), /unscoped/);
  } finally { rmrf(repo); }
}, checkScript));

// ------------------------------------------------------------------ spike s5: isolated worktree

test('s5: worktree subagent: committed change outside scope is caught; branch and path recorded', () => withDaemon(async d => {
  const repo = makeRepo({ 'base.txt': 'main', 'check.cjs': PASS });
  try {
    const inputs = retarget(loadSpike('s5'), repo);
    setPrompt(inputs, L1_PROMPT);
    editAgentPrompt(inputs, 'Run these commands', p => `[subtask:W]\n[scope: src/**]\n${p}`);
    for (const h of inputs) if (h.tool_name === 'Agent') Object.assign(h.tool_input as object, { model: 'haiku', effort: 'low' });
    const start = inputs.find(h => h.hook_event_name === 'SubagentStart')!;
    const wt = String(start.cwd);
    assert.ok(wt.startsWith(repo) && wt !== repo);
    git(repo, 'worktree', 'add', '-q', '-b', 'worktree-agent-ae393b12ffbe55bde', wt);

    let stopOut: Out | undefined;
    for (const h of inputs) {
      if (h.hook_event_name === 'SubagentStop') {
        write(wt, 'wt-b.txt', 'W\n');
        git(wt, 'add', 'wt-b.txt');
        git(wt, 'commit', '-qm', 'wt-b');
        stopOut = await out(d, h);
        assert.deepEqual(await out(d, subagentStop(h, true)), {});
        continue;
      }
      const o = await out(d, h);
      if (h.hook_event_name === 'PreToolUse' && h.tool_name === 'Agent') assert.deepEqual(o, {});
    }
    assert.equal(stopOut?.decision, 'block');
    assert.match(stopOut!.reason!, /changed outside the allowed scope \[src\/\*\*\]: wt-b\.txt/);
    const [a] = rows(d, 'SELECT subtask_id, cwd, worktree_branch, worktree_path, pairing FROM agents');
    assert.equal(a!.subtask_id, 'W');
    assert.equal(a!.cwd, wt);
    assert.equal(a!.worktree_branch, 'worktree-agent-ae393b12ffbe55bde');
    assert.equal(a!.worktree_path, wt);
    assert.equal(a!.pairing, 'confirmed');
    assert.deepEqual(rows(d, 'SELECT status, verdict FROM subtasks'), [{ status: 'failed', verdict: 'miss' }]);
  } finally {
    try { git(repo, 'worktree', 'remove', '--force', path.join(repo, '.claude', 'worktrees', 'agent-ae393b12ffbe55bde')); } catch { /* best effort */ }
    rmrf(repo);
  }
}, checkScript));

// ------------------------------------------------------------------ Agent call rules

const base = (sessionId: string, cwd: string) => ({ session_id: sessionId, cwd, transcript_path: path.join(cwd, 't.jsonl') });
const prompt = (sessionId: string, cwd: string, text: string): HookInput => ({ ...base(sessionId, cwd), hook_event_name: 'UserPromptSubmit', prompt: text });
const agentCall = (sessionId: string, cwd: string, o: { type?: string; prompt: string; model?: string; effort?: string }): HookInput => ({
  ...base(sessionId, cwd), hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: `tu-${Math.random()}`,
  tool_input: { subagent_type: o.type ?? 'do-it-all-claude-code:coder', prompt: o.prompt, description: 'd', ...(o.model ? { model: o.model } : {}), ...(o.effort ? { effort: o.effort } : {}) },
});
const reasonOf = (o: Out) => o.hookSpecificOutput?.permissionDecision === 'deny' ? o.hookSpecificOutput.permissionDecisionReason ?? '' : '';

// A delegating, fixed-size L0 team (teams.yaml): the lead-direct default would re-plan at L2 (T6).
test('Agent call rules: tag, role, managed types only, fixed L0 team, budget', () => withDaemon(async d => {
  const cwd = d.home;
  await out(d, prompt('rules', cwd, L0_PROMPT));
  assert.equal(rows(d, 'SELECT level FROM requests')[0]!.level, 'L0');
  assert.match(reasonOf(await out(d, agentCall('rules', cwd, { prompt: 'no tag here', model: 'haiku', effort: 'low' }))), /must start with "\[subtask:<ID>\]"/);
  assert.match(reasonOf(await out(d, agentCall('rules', cwd, { type: 'do-it-all-claude-code:lead', prompt: '[subtask:A] x', model: 'haiku', effort: 'low' }))), /unknown router agent type/);
  assert.match(reasonOf(await out(d, agentCall('rules', cwd, { type: 'do-it-all-claude-code:reviewer', prompt: '[subtask:R] x', model: 'haiku', effort: 'low' }))), /L0 team is fixed \(coder x1\)/);
  assert.match(reasonOf(await out(d, agentCall('rules', cwd, { prompt: '[subtask:A] x\n[scope: ../up/**]', model: 'haiku', effort: 'low' }))), /repo-relative/);
  assert.match(reasonOf(await out(d, agentCall('rules', cwd, { prompt: '[subtask:A] x' }))), /pass model and effort/);
  // not ours: untouched, not recorded as a subtask
  assert.deepEqual(await out(d, agentCall('rules', cwd, { type: 'Explore', prompt: 'look around' })), {});
  assert.deepEqual(await out(d, agentCall('rules', cwd, { prompt: '[subtask:A] x', model: 'haiku', effort: 'low' })), {});
  // audit #11: allowed but never started (the user pressed Esc, another hook denied it): the same ID may be sent again
  assert.deepEqual(await out(d, agentCall('rules', cwd, { prompt: '[subtask:A] again', model: 'haiku', effort: 'low' })), {});
  assert.match(reasonOf(await out(d, agentCall('rules', cwd, { prompt: '[subtask:A2] x', model: 'haiku', effort: 'low' }))),
    /slot\(s\) of the L0 team are busy; wait for one to finish \(a subtask that was allowed but never started can be dispatched again with the same ID\)/);
  // once its subagent runs, the ID is busy
  await out(d, { ...base('rules', cwd), hook_event_name: 'SubagentStart', agent_id: 'ag-rules', agent_type: 'do-it-all-claude-code:coder' });
  assert.match(reasonOf(await out(d, agentCall('rules', cwd, { prompt: '[subtask:A] third', model: 'haiku', effort: 'low' }))), /already running/);
  assert.deepEqual(rows(d, 'SELECT id, status, attempts FROM subtasks'), [{ id: 'A', status: 'running', attempts: 2 }]);

  // budget: spend the L0 budget, then any new call is denied
  const [req] = rows(d, 'SELECT id, budget_usd FROM requests');
  d.ledger.addCost({ requestId: String(req!.id), subtaskId: 'A', agentId: null, source: 'transcript', modelId: 'claude-haiku-5-5', inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, usd: Number(req!.budget_usd), createdAt: new Date().toISOString() });
  d.ledger.updateSubtask(String(req!.id), 'A', { status: 'passed' }, new Date().toISOString());
  assert.match(reasonOf(await out(d, agentCall('rules', cwd, { prompt: '[subtask:A3] x', model: 'haiku', effort: 'low' }))), /budget is used up/);
}, { presets: TEAM_L0_PRESETS }));

test('pairing by order is repaired from PostToolUse(Agent) when subagents start out of order', () => withDaemon(async d => {
  const cwd = d.home;
  const sid = 'pairs';
  await out(d, prompt(sid, cwd, L1_PROMPT));
  assert.deepEqual(await out(d, agentCall(sid, cwd, { prompt: '[subtask:A] a', model: 'haiku', effort: 'low' })), {});
  assert.deepEqual(await out(d, agentCall(sid, cwd, { prompt: '[subtask:B] b', model: 'haiku', effort: 'low' })), {});   // L1: lead may add a 2nd coder (slot 1)
  const start = (agentId: string) => ({ ...base(sid, cwd), hook_event_name: 'SubagentStart', agent_id: agentId, agent_type: 'do-it-all-claude-code:coder' });
  await Promise.all([out(d, start('ag-1')), out(d, start('ag-2'))]);
  const bound = Object.fromEntries(rows(d, 'SELECT id, agent_id FROM subtasks').map(r => [r.id, r.agent_id]));
  assert.notEqual(bound.A, bound.B);
  // the results say: ag-2 ran B, ag-1 ran A (whatever the start order was)
  const done = (agentId: string, tag: string): HookInput => ({
    ...base(sid, cwd), hook_event_name: 'PostToolUse', tool_name: 'Agent',
    tool_input: { subagent_type: 'do-it-all-claude-code:coder', prompt: `[subtask:${tag}] x`, model: 'haiku', effort: 'low' },
    tool_response: { status: 'completed', agentId, prompt: `[subtask:${tag}] x`, resolvedModel: 'claude-haiku-5-5', usage: { input_tokens: 10, output_tokens: 10 } },
  });
  // force the wrong pairing first, then let PostToolUse repair it
  d.ledger.updateAgent('ag-1', { subtaskId: 'B' });
  d.ledger.updateAgent('ag-2', { subtaskId: 'A' });
  await out(d, done('ag-2', 'B'));
  await out(d, done('ag-1', 'A'));
  assert.deepEqual(rows(d, 'SELECT agent_id, subtask_id, pairing FROM agents ORDER BY agent_id'), [
    { agent_id: 'ag-1', subtask_id: 'A', pairing: 'confirmed' }, { agent_id: 'ag-2', subtask_id: 'B', pairing: 'confirmed' },
  ]);
  assert.deepEqual(rows(d, 'SELECT id, agent_id, slot FROM subtasks ORDER BY id'), [{ id: 'A', agent_id: 'ag-1', slot: 0 }, { id: 'B', agent_id: 'ag-2', slot: 1 }]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d.home, 'agents', 'ag-2.json'), 'utf8')).subtaskId, 'B');
}));

test('parallel events of one session lose no ledger update', () => withDaemon(async d => {
  const cwd = d.home;
  const sid = 'parallel';
  await out(d, prompt(sid, cwd, L1_PROMPT));
  const each = Math.round(FIXTURE_CALLS.reduce((a, u) => a + costUsd('claude-haiku-5-5', u)!, 0) * 1e6) / 1e6;
  const n = 25;
  await Promise.all(Array.from({ length: n }, (_, i) => out(d, {
    ...base(sid, cwd), hook_event_name: 'SubagentStop', agent_id: `x-${i}`, agent_type: 'Explore', stop_hook_active: false,
    agent_transcript_path: copyTranscript(d.home, `x-${i}`),
  })));
  const st = (await getStatus(d.port, sid)).body as StatusView;
  assert.equal(rows(d, 'SELECT COUNT(*) AS c FROM costs')[0]!.c, n);
  assert.ok(Math.abs(st.request!.usedUsd - each * n) < 1e-9, `${st.request!.usedUsd} != ${each * n}`);
}));

// ------------------------------------------------------------------ requests across turns

test('HITL answer and /router resume continue the request; other slash commands are not triaged', () => withDaemon(async d => {
  const cwd = d.home;
  const sid = 'turns';
  const stop = (msg: string): HookInput => ({ ...base(sid, cwd), hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: msg });
  const first = await out(d, prompt(sid, cwd, L1_PROMPT));
  assert.match(first.hookSpecificOutput?.additionalContext ?? '', /level L1/);
  await out(d, stop(`Should empty input return [] or throw? ${AWAITING_USER_MARKER}`));
  assert.equal(rows(d, 'SELECT status FROM requests')[0]!.status, 'awaiting_user');

  assert.deepEqual(await out(d, prompt(sid, cwd, 'return an empty list')), {});          // HITL answer: no triage, no brief
  assert.deepEqual(rows(d, 'SELECT status, turns FROM requests'), [{ status: 'open', turns: 2 }]);
  await out(d, stop('Done.'));
  assert.equal(rows(d, 'SELECT status FROM requests')[0]!.status, 'closed');

  assert.deepEqual(await out(d, prompt(sid, cwd, '/review the last change')), {});        // not a router command: not triaged
  const resumed = await out(d, prompt(sid, cwd, '/router resume'));
  assert.match(resumed.hookSpecificOutput?.additionalContext ?? '', /ledger \(resumed\): request r-/);
  assert.deepEqual(rows(d, 'SELECT status, turns FROM requests'), [{ status: 'open', turns: 3 }]);

  await out(d, prompt(sid, cwd, L0_PROMPT));                                              // a new request closes the open one
  assert.deepEqual(rows(d, 'SELECT level, status FROM requests ORDER BY created_at, rowid'), [{ level: 'L1', status: 'closed' }, { level: 'L0', status: 'open' }]);
}));

test('session_start after compact or resume re-injects the ledger summary', () => withDaemon(async d => {
  const cwd = d.home;
  const sid = 'compact';
  const start = (source: string): HookInput => ({ ...base(sid, cwd), hook_event_name: 'SessionStart', source });
  assert.deepEqual(await out(d, start('startup')), {});
  await out(d, prompt(sid, cwd, L1_PROMPT));
  await out(d, agentCall(sid, cwd, { prompt: '[subtask:A] a\n[scope: src/**]', model: 'haiku', effort: 'low' }));
  const ctx = (await out(d, start('compact'))).hookSpecificOutput?.additionalContext ?? '';
  assert.match(ctx, /^\[do-it-all-claude-code\] level L1/);
  assert.match(ctx, /ledger \(after compaction\)/);
  assert.match(ctx, /A coder#0 @s1 \(model=haiku, effort=low\) pending/);
  assert.match((await out(d, start('resume'))).hookSpecificOutput?.additionalContext ?? '', /ledger \(resumed session\)/);
  assert.deepEqual(await out(d, start('clear')), {});
}, { presets: TEAM_L1_PRESETS }));

test('without a prompt seen this turn, an Agent call opens a default request instead of failing', () => withDaemon(async d => {
  const cwd = d.home;
  assert.deepEqual(await out(d, agentCall('late', cwd, { prompt: '[subtask:A] x', model: 'haiku', effort: 'low' })), {});
  const [r] = rows(d, 'SELECT level, triage, replanned_from FROM requests');
  // the default request is lead-direct L1; the lead calling a router subagent re-plans it at L2 (T6)
  assert.equal(r!.level, 'L2');
  assert.match(String(r!.replanned_from), /"level":"L1".*no prompt seen by the router/);
}));
