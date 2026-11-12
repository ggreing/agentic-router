import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  toRouterEvent, renderHookOutput, renderPreCompactStdout, HookInputError,
  isRouterAgent, routerRole, agentCall, agentResult, hookEffort, isAgentToolEvent,
} from '@agentic-router/adapter-claude-code';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Reads one spike fixture as the list of recorded hook inputs (the `input` of each `ev:` row that is a real hook). */
function hookInputs(file: string): Record<string, unknown>[] {
  const lines = fs.readFileSync(path.join(fixturesDir, file), 'utf8').split(/\r?\n/).filter(Boolean);
  return lines
    .map(l => JSON.parse(l) as Record<string, unknown>)
    .filter(r => r.input && typeof r.input === 'object' && (r.input as Record<string, unknown>).hook_event_name)
    .map(r => r.input as Record<string, unknown>);
}

test('every hook input in all fixtures converts without throwing', () => {
  let n = 0;
  for (const f of ['spike-s1.jsonl', 'spike-s2.jsonl', 'spike-s5.jsonl']) {
    for (const input of hookInputs(f)) {
      const ev = toRouterEvent(input);
      assert.ok(ev.type, `type set for ${input.hook_event_name}`);
      assert.equal(ev.sessionId, input.session_id);
      assert.equal(ev.raw, input);
      assert.ok(ev.receivedAt);
      n++;
    }
  }
  assert.ok(n >= 35, `converted ${n} events`);
});

test('all 8 event types are covered by the fixtures', () => {
  const seen = new Set<string>();
  for (const f of ['spike-s1.jsonl', 'spike-s2.jsonl', 'spike-s5.jsonl'])
    for (const input of hookInputs(f)) seen.add(toRouterEvent(input).type);
  for (const t of ['prompt_submit', 'pre_tool_use', 'post_tool_use', 'subagent_start', 'subagent_stop', 'session_start', 'stop'])
    assert.ok(seen.has(t), `fixtures exercise ${t}`);
});

test('UserPromptSubmit carries the prompt and no agent fields (main session)', () => {
  const ups = hookInputs('spike-s1.jsonl').find(i => i.hook_event_name === 'UserPromptSubmit')!;
  const ev = toRouterEvent(ups);
  assert.equal(ev.type, 'prompt_submit');
  assert.match(ev.prompt!, /\[subtask:A\]/);
  assert.equal(ev.agentId, undefined);
  assert.equal(ev.agentType, undefined);
});

test('PreToolUse(Agent) exposes subagent_type, model and effort via agentCall', () => {
  const pre = hookInputs('spike-s1.jsonl').find(i => i.hook_event_name === 'PreToolUse' && (i.tool_name === 'Agent'))!;
  const ev = toRouterEvent(pre);
  assert.equal(ev.type, 'pre_tool_use');
  assert.ok(isAgentToolEvent(ev));
  const call = agentCall(ev)!;
  assert.equal(call.subagentType, 'probe:coder');
  assert.equal(call.model, 'haiku');
  assert.equal(call.effort, 'low');
  assert.match(call.prompt!, /\[subtask:A\]/);
  assert.equal(call.runInBackground, false);
});

test('a subagent tool event carries agent_id, agent_type, cwd and effort.level', () => {
  const write = hookInputs('spike-s1.jsonl').find(i => i.hook_event_name === 'PreToolUse' && i.tool_name === 'Write' && i.agent_id)!;
  const ev = toRouterEvent(write);
  assert.ok(ev.agentId);
  assert.equal(ev.agentType, 'probe:coder');
  assert.ok(ev.cwd);
  assert.equal(hookEffort(ev), 'low');
});

test('PostToolUse(Agent) result exposes resolvedModel, usage, report text and worktree branch', () => {
  const post = hookInputs('spike-s1.jsonl').find(i => i.hook_event_name === 'PostToolUse' && i.tool_name === 'Agent')!;
  const r = agentResult(toRouterEvent(post))!;
  assert.equal(r.status, 'completed');
  assert.equal(r.resolvedModel, 'claude-haiku-5-5');
  assert.ok(r.agentId);
  assert.ok(typeof r.totalTokens === 'number');
  assert.ok(r.usage && typeof r.usage.output_tokens === 'number');
  // report text excludes the <tools-used-before-summary> harness note
  assert.ok(r.text && !r.text.includes('<tools-used-before-summary>'));
  assert.match(r.text!, /Files changed/);

  const wt = hookInputs('spike-s5.jsonl').find(i => i.hook_event_name === 'PostToolUse' && i.tool_name === 'Agent')!;
  const rw = agentResult(toRouterEvent(wt))!;
  assert.match(rw.worktreeBranch!, /^worktree-agent-/);
  assert.ok(rw.worktreePath);
});

test('SubagentStop fills lastAssistantMessage, stopHookActive and agentTranscriptPath', () => {
  const stop = hookInputs('spike-s1.jsonl').find(i => i.hook_event_name === 'SubagentStop')!;
  const ev = toRouterEvent(stop);
  assert.equal(ev.type, 'subagent_stop');
  assert.equal(ev.stopHookActive, false);
  assert.ok(ev.agentTranscriptPath!.includes('subagents'));
  assert.match(ev.lastAssistantMessage!, /Files changed/);
});

test('a second SubagentStop can report stop_hook_active true', () => {
  const stops = hookInputs('spike-s2.jsonl').filter(i => i.hook_event_name === 'SubagentStop');
  assert.ok(stops.some(s => toRouterEvent(s).stopHookActive === true));
});

test('Stop carries the main session lastAssistantMessage (HITL marker lives here)', () => {
  const stop = hookInputs('spike-s1.jsonl').find(i => i.hook_event_name === 'Stop')!;
  const ev = toRouterEvent(stop);
  assert.equal(ev.type, 'stop');
  assert.ok(ev.lastAssistantMessage);
});

test('SessionStart carries source', () => {
  const ss = hookInputs('spike-s1.jsonl').find(i => i.hook_event_name === 'SessionStart')!;
  assert.equal(toRouterEvent(ss).source, 'startup');
});

test('spooled + receivedAt options are honored', () => {
  const ups = hookInputs('spike-s1.jsonl').find(i => i.hook_event_name === 'UserPromptSubmit')!;
  const ev = toRouterEvent(ups, { spooled: true, receivedAt: '2026-11-10T00:00:00.000Z' });
  assert.equal(ev.spooled, true);
  assert.equal(ev.receivedAt, '2026-11-10T00:00:00.000Z');
});

test('toRouterEvent rejects malformed payloads', () => {
  assert.throws(() => toRouterEvent(null), HookInputError);
  assert.throws(() => toRouterEvent({ hook_event_name: 'Nope', session_id: 'x' }), HookInputError);
  assert.throws(() => toRouterEvent({ hook_event_name: 'Stop' }), HookInputError); // no session_id
});

test('isRouterAgent / routerRole only match this plugin\'s subagents', () => {
  assert.equal(isRouterAgent('agentic-router:coder'), true);
  assert.equal(routerRole('agentic-router:reviewer'), 'reviewer');
  assert.equal(isRouterAgent('probe:coder'), false);
  assert.equal(isRouterAgent(''), false);
  assert.equal(routerRole(undefined), undefined);
});

// ---------------------------------------------------------------- renderHookOutput

test('prompt_submit context renders as additionalContext', () => {
  const out = renderHookOutput('prompt_submit', { context: 'triage: L2' });
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'triage: L2' } });
});

test('pre_tool_use deny renders a permission decision with the reason', () => {
  const out = renderHookOutput('pre_tool_use', { deny: { reason: 'budget exceeded' } });
  assert.equal(out.hookSpecificOutput!.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput!.permissionDecision, 'deny');
  assert.equal(out.hookSpecificOutput!.permissionDecisionReason, 'budget exceeded');
  assert.equal(out.decision, undefined);
});

test('pre_tool_use can carry both deny and additionalContext', () => {
  const out = renderHookOutput('pre_tool_use', { deny: { reason: 'r' }, context: 'c' });
  assert.equal(out.hookSpecificOutput!.permissionDecision, 'deny');
  assert.equal(out.hookSpecificOutput!.additionalContext, 'c');
});

test('pre_tool_use allow renders permissionDecision allow; deny wins; other events drop it (decision 127)', () => {
  assert.deepEqual(renderHookOutput('pre_tool_use', { allow: {} }),
    { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } });
  assert.equal(renderHookOutput('pre_tool_use', { allow: { reason: 'router tool' } }).hookSpecificOutput!.permissionDecisionReason, 'router tool');
  const both = renderHookOutput('pre_tool_use', { allow: {}, deny: { reason: 'subagent' } });
  assert.equal(both.hookSpecificOutput!.permissionDecision, 'deny');
  assert.deepEqual(renderHookOutput('post_tool_use', { allow: {} }), {});
});

test('subagent_stop / stop block renders top-level decision+reason', () => {
  for (const t of ['subagent_stop', 'stop'] as const) {
    const out = renderHookOutput(t, { block: { reason: 'verify failed' } });
    assert.equal(out.decision, 'block');
    assert.equal(out.reason, 'verify failed');
  }
});

test('a block on an event that cannot block is dropped', () => {
  const out = renderHookOutput('pre_tool_use', { block: { reason: 'x' } });
  assert.equal(out.decision, undefined);
});

test('a deny off pre_tool_use is dropped', () => {
  const out = renderHookOutput('subagent_start', { deny: { reason: 'x' } });
  assert.equal(out.hookSpecificOutput, undefined);
});

test('userMessage renders as systemMessage (except pre_compact)', () => {
  assert.equal(renderHookOutput('stop', { userMessage: 'hi' }).systemMessage, 'hi');
  assert.equal(renderHookOutput('pre_compact', { userMessage: 'hi' }).systemMessage, undefined);
});

test('pre_compact has no additionalContext; its instructions go to plain stdout', () => {
  assert.deepEqual(renderHookOutput('pre_compact', { context: 'summary guide' }), {});
  assert.equal(renderPreCompactStdout({ context: 'summary guide' }), 'summary guide');
  assert.equal(renderPreCompactStdout({}), '');
});

test('an empty decision renders as an empty object (pass through)', () => {
  assert.deepEqual(renderHookOutput('post_tool_use'), {});
  assert.deepEqual(renderHookOutput('session_start', {}), {});
});

test('session_start / subagent_start / post_tool_use accept additionalContext', () => {
  for (const t of ['session_start', 'subagent_start', 'post_tool_use'] as const)
    assert.equal(renderHookOutput(t, { context: 'c' }).hookSpecificOutput!.additionalContext, 'c');
});
