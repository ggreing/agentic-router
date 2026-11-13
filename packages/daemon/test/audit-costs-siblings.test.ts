// Regression tests for the read-only audit: #14 (E13, transcript costs) and #6 (E2, sibling scopes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { costUsd } from '@do-it-all-claude-code/core';
import { git, makeRepo, postHook, rmrf, rows, startTestDaemon, write, type HookInput, type TestDaemon } from './helpers.ts';

const L1_PROMPT = 'Fix the bug where parse() fails on empty input in src/parse.ts';
const L2_PROMPT = 'Refactor the validation module across multiple files and add an audit log';
type Out = { decision?: string; reason?: string; hookSpecificOutput?: { additionalContext?: string } };

const PLUGIN_DIR = fileURLToPath(new URL('../../../plugin', import.meta.url));

async function withDaemon(fn: (d: TestDaemon, clock: { advance(ms: number): void }) => Promise<void>, config?: Record<string, unknown>): Promise<void> {
  let t = Date.parse('2026-11-11T10:00:00.000Z');
  const d = await startTestDaemon({ now: () => new Date(t), ...(config ? { config } : {}) });
  try { await fn(d, { advance: ms => { t += ms; } }); } finally { await d.close(); rmrf(d.home); }
}
const session = (d: TestDaemon, sid: string, cwd: string) => async (h: HookInput): Promise<Out> => {
  const r = await postHook(d.port, { session_id: sid, cwd, transcript_path: path.join(d.home, `${sid}.jsonl`), ...h });
  assert.equal(r.status, 200, r.text);
  return r.body as Out;
};
let seq = 0;
const call = (tag: string, scope: string | null, type = 'do-it-all-claude-code:coder', model = 'haiku', effort = 'low'): HookInput => ({
  hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: `toolu_c${++seq}`,
  tool_input: { subagent_type: type, prompt: `[subtask:${tag}] work${scope === null ? '' : `\n[scope: ${scope}]`}`, model, effort },
});
const start = (agentId: string, type = 'do-it-all-claude-code:coder'): HookInput => ({ hook_event_name: 'SubagentStart', agent_id: agentId, agent_type: type });
const stop = (agentId: string, extra: HookInput = {}): HookInput => ({ hook_event_name: 'SubagentStop', agent_id: agentId, agent_type: 'do-it-all-claude-code:coder', stop_hook_active: false, ...extra });

test('E13 / #14: a zero-usage "<synthetic>" line is skipped, and a later notification does not overwrite a known cost', () => withDaemon(async d => {
  const repo = makeRepo({ 'src/a/x.ts': 'a\n' });
  try {
    const post = session(d, 'e13', repo);
    const tr = path.join(d.home, 'agent-a1.jsonl');
    const u1 = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 20000, cache_creation_input_tokens: 3000 };
    const u3 = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 24000, cache_creation_input_tokens: 500 };
    const line = (id: string, model: string, usage: object) => JSON.stringify({ type: 'assistant', message: { id, model, usage } });
    fs.writeFileSync(tr, [line('m1', 'claude-haiku-5-5', u1), line('m2', '<synthetic>', { input_tokens: 0, output_tokens: 0 }), line('m3', 'claude-haiku-5-5', u3)].join('\n') + '\n');
    await post({ hook_event_name: 'UserPromptSubmit', prompt: L1_PROMPT });
    await post(call('A', 'src/a/**'));
    await post(start('a1'));
    write(repo, 'src/a/x.ts', 'ok\n');
    await post(stop('a1', { agent_transcript_path: tr }));
    const usd = Math.round((costUsd('claude-haiku-5-5', u1)! + costUsd('claude-haiku-5-5', u3)!) * 1e6) / 1e6;
    assert.deepEqual(rows(d, 'SELECT source, model_id, calls, usd FROM costs'), [{ source: 'transcript', model_id: 'claude-haiku-5-5', calls: 2, usd }]);
    const n = await post({ hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<usage><subagent_tokens>50000</subagent_tokens></usage>\n</task-notification>' });
    assert.deepEqual(rows(d, 'SELECT source, usd FROM costs'), [{ source: 'transcript', usd }]);
    assert.equal(rows(d, 'SELECT used_usd FROM requests')[0]!.used_usd, usd);
    assert.match(n.hookSpecificOutput?.additionalContext ?? '', new RegExp(`cost \\$${usd.toFixed(4)} \\(already verified`));
  } finally { rmrf(repo); }
}));

test('#14: a model without a price is estimated on its own; the priced part stays exact', () => withDaemon(async d => {
  const repo = makeRepo({ 'src/a/x.ts': 'a\n' });
  try {
    const post = session(d, 'mixed', repo);
    const tr = path.join(d.home, 'agent-m1.jsonl');
    const priced = { input_tokens: 100, output_tokens: 100 };
    const line = (id: string, model: string, usage: object) => JSON.stringify({ type: 'assistant', message: { id, model, usage } });
    fs.writeFileSync(tr, [line('m1', 'claude-haiku-5-5', priced), line('m2', 'claude-future-9', { input_tokens: 2000, output_tokens: 1000 })].join('\n') + '\n');
    await post({ hook_event_name: 'UserPromptSubmit', prompt: L1_PROMPT });
    await post(call('A', 'src/a/**'));
    await post(start('m1'));
    write(repo, 'src/a/x.ts', 'ok\n');
    await post(stop('m1', { agent_transcript_path: tr }));
    const exact = costUsd('claude-haiku-5-5', priced)!;
    const est = 3000 * 0.5 / 1e6;   // 3000 tokens at the step model's (s1 = haiku) output rate
    const cost = rows(d, 'SELECT source, model_id, usd, note FROM costs ORDER BY id');
    assert.deepEqual(cost.map(c => [c.source, c.model_id, c.usd]), [['transcript', 'claude-haiku-5-5', exact], ['estimate', 'claude-future-9', est]]);
    assert.match(String(cost[1]!.note), /^estimated: model claude-future-9 has no price; 3000 tokens at the claude-haiku-5-5 output rate/);
    assert.ok(Math.abs(Number(rows(d, 'SELECT used_usd FROM requests')[0]!.used_usd) - (exact + est)) < 1e-9);
    const n = await post({ hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>m1</task-id>\n<status>completed</status>\n</task-notification>' });
    assert.match(n.hookSpecificOutput?.additionalContext ?? '', /cost ~\$0\.0016 \(partly estimated\)/);
  } finally { rmrf(repo); }
}));

// The role files of plugin/agents decide which roles write (decision 103): reviewer has no edit tools.
test('E2 / #6: in a shared tree, only a scoped, writing sibling running at the same time explains an out-of-scope change', () => withDaemon(async (d, clock) => {
  const repo = makeRepo({ 'src/a/x.ts': 'a\n', 'other/y.ts': 'y\n', 'lib/z.ts': 'z\n' });
  try {
    const post = session(d, 'e2', repo);
    await post({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT });
    assert.equal(rows(d, 'SELECT level FROM requests')[0]!.level, 'L2');
    // an unscoped reviewer (read-only role, whole repo) runs alongside coder A
    await post(call('R', null, 'do-it-all-claude-code:reviewer', 'sonnet', 'medium'));
    await post(start('r1', 'do-it-all-claude-code:reviewer'));
    await post(call('A', 'src/a/**'));
    await post(start('a1'));
    write(repo, 'other/y.ts', 'changed by coder A, outside its scope\n');
    let out = await post(stop('a1'));
    assert.equal(out.decision, 'block', 'an unscoped reviewer must not excuse coder A');
    assert.match(out.reason ?? '', /changed outside the allowed scope \[src\/a\/\*\*\]: other\/y\.ts/);

    // a scoped coder B on lib/** running at the same time does explain a change in lib/
    git(repo, 'checkout', '--', 'other/y.ts');
    await post(call('B', 'lib/**'));
    await post(start('b1'));
    write(repo, 'lib/z.ts', 'changed by B\n');
    out = await post(stop('a1', { stop_hook_active: true }));
    assert.deepEqual(out, {});
    assert.deepEqual(rows(d, "SELECT status, verdict FROM subtasks WHERE id = 'A'"), [{ status: 'passed', verdict: 'meet' }]);
    await post(stop('b1'));

    // ... but not once B has finished before A started
    clock.advance(60_000);
    write(repo, 'lib/z.ts', 'changed again, by nobody running now\n');
    await post(call('C', 'src/a/**'));
    await post(start('c1'));
    write(repo, 'lib/z.ts', 'and again while C runs\n');
    out = await post(stop('c1'));
    assert.equal(out.decision, 'block');
    assert.match(out.reason ?? '', /lib\/z\.ts/);
  } finally { rmrf(repo); }
}, { pluginDir: PLUGIN_DIR }));

test('decision 103: a sibling whose role file cannot be read excuses nothing', () => withDaemon(async d => {
  const repo = makeRepo({ 'src/a/x.ts': 'a\n', 'lib/z.ts': 'z\n' });
  try {
    const post = session(d, 'nofile', repo);
    await post({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT });
    await post(call('A', 'src/a/**'));
    await post(start('a1'));
    await post(call('B', 'lib/**'));
    await post(start('b1'));
    write(repo, 'lib/z.ts', 'changed\n');
    const out = await post(stop('a1'));
    assert.equal(out.decision, 'block');
    assert.match(out.reason ?? '', /changed outside the allowed scope \[src\/a\/\*\*\]: lib\/z\.ts/);
  } finally { rmrf(repo); }
}, { pluginDir: path.join(PLUGIN_DIR, 'no-such-dir') }));
