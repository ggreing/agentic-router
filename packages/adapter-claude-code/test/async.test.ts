import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  toRouterEvent, agentResult, isAgentToolEvent, isTaskNotification, parseTaskNotification, taskNotification, promptOrigin, subtaskTagFromTranscript,
} from '@do-it-all-claude-code/adapter-claude-code';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
function hookInputs(file: string): Record<string, unknown>[] {
  return fs.readFileSync(path.join(fixturesDir, file), 'utf8').split(/\r?\n/).filter(Boolean)
    .map(l => JSON.parse(l) as Record<string, unknown>)
    .filter(r => r.input && typeof r.input === 'object' && (r.input as Record<string, unknown>).hook_event_name)
    .map(r => r.input as Record<string, unknown>);
}
const inputs = hookInputs('spike-async.jsonl');

test('async fixture converts cleanly and covers the launch + notification shapes', () => {
  for (const i of inputs) assert.ok(toRouterEvent(i).type);
  assert.ok(inputs.some(i => i.hook_event_name === 'PostToolUse'));
  assert.ok(inputs.some(i => i.hook_event_name === 'UserPromptSubmit' && String((i as { prompt?: string }).prompt).startsWith('<task-notification>')));
});

test('PostToolUse(Agent) async launch: isAsync, status and agentId, but no usage', () => {
  const post = inputs.find(i => i.hook_event_name === 'PostToolUse')!;
  const ev = toRouterEvent(post);
  assert.ok(isAgentToolEvent(ev));
  const r = agentResult(ev)!;
  assert.equal(r.isAsync, true);
  assert.equal(r.status, 'async_launched');
  assert.ok(r.agentId, 'launch carries the subagent agentId');
  assert.equal(r.resolvedModel, 'claude-haiku-5-5');
  assert.ok(r.outputFile && r.outputFile.endsWith('.output'));
  assert.equal(r.usage, undefined, 'no usage on an async launch');
  assert.equal(r.text, undefined, 'no report text on an async launch');
});

test('toRouterEvent fills promptOrigin and notification on the event (core fields)', () => {
  const notif = inputs.find(i => i.hook_event_name === 'UserPromptSubmit' && String((i as { prompt?: string }).prompt).startsWith('<task-notification>'))!;
  const nev = toRouterEvent(notif);
  assert.equal(nev.promptOrigin, 'notification');
  assert.ok(nev.notification, 'notification set');
  assert.ok(nev.notification!.taskId);
  assert.match(nev.notification!.toolUseId!, /^toolu_/);
  assert.equal(nev.notification!.status, 'completed');

  const user = inputs.find(i => i.hook_event_name === 'UserPromptSubmit' && !String((i as { prompt?: string }).prompt).startsWith('<task-notification>'))!;
  const uev = toRouterEvent(user);
  assert.equal(uev.promptOrigin, 'user');
  assert.equal(uev.notification, undefined);
});

test('a task-notification UserPromptSubmit is recognised and not a user prompt', () => {
  const notif = inputs.find(i => i.hook_event_name === 'UserPromptSubmit' && String((i as { prompt?: string }).prompt).startsWith('<task-notification>'))!;
  const ev = toRouterEvent(notif);
  assert.equal(ev.type, 'prompt_submit');
  assert.ok(isTaskNotification(ev.prompt), 'discriminated as a task notification');
  const n = taskNotification(ev)!;
  assert.equal(n.kind, 'task');
  assert.ok(n.taskId, 'has the task id (subagent agentId)');
  assert.match(n.toolUseId!, /^toolu_/);
  assert.equal(n.status, 'completed');
  assert.ok(n.result && n.result.length > 0, 'carries the subagent report');
  assert.ok(n.worktreeBranch!.startsWith('worktree-agent-'));
  assert.ok(n.usage && typeof n.usage.subagentTokens === 'number' && n.usage.subagentTokens! > 0);
  assert.ok(typeof n.usage!.toolUses === 'number' && typeof n.usage!.durationMs === 'number');
});

test('the task-notification taskId matches the launch agentId (join key)', () => {
  const posts = inputs.filter(i => i.hook_event_name === 'PostToolUse').map(i => agentResult(toRouterEvent(i))!.agentId);
  const notifs = inputs.filter(i => i.hook_event_name === 'UserPromptSubmit' && String((i as { prompt?: string }).prompt).startsWith('<task-notification>'))
    .map(i => taskNotification(toRouterEvent(i))!.taskId);
  for (const id of notifs) assert.ok(posts.includes(id), `notification ${id} joins a launch`);
});

test('a real user prompt is NOT a task notification', () => {
  const user = inputs.find(i => i.hook_event_name === 'UserPromptSubmit' && !String((i as { prompt?: string }).prompt).startsWith('<task-notification>'))!;
  const ev = toRouterEvent(user);
  assert.equal(isTaskNotification(ev.prompt), false);
  assert.equal(taskNotification(ev), null);
});

test('promptOrigin / detection match the daemon fallback regex ^\\s*<task-notification[\\s>]', () => {
  // identical criterion on both sides (adapter and daemon)
  assert.equal(promptOrigin('<task-notification>\n<task-id>x</task-id></task-notification>'), 'notification');
  assert.equal(promptOrigin('  \n <task-notification attr="1">…'), 'notification'); // leading ws + attribute form
  assert.equal(promptOrigin('<task-notification\n>'), 'notification');
  assert.equal(promptOrigin('fix the typo in interpolate'), 'user');
  assert.equal(promptOrigin('look at <task-notification> later'), 'user'); // not at the start
  assert.equal(promptOrigin(undefined), 'user');
  assert.equal(isTaskNotification('x<task-notification>'), false);
});

test('subtaskTagFromTranscript reads the [subtask:ID] tag for order-independent pairing (audit E16)', () => {
  const read = (_p: string) => 'line0\n{"text":"[subtask:B] do the thing"}\n';
  assert.equal(subtaskTagFromTranscript('/x/agent-a.jsonl', read), 'B');
  assert.equal(subtaskTagFromTranscript('/x/none.jsonl', () => 'no tag here'), null);
  assert.equal(subtaskTagFromTranscript(undefined, read), null);
  assert.equal(subtaskTagFromTranscript('/missing', () => { throw new Error('ENOENT'); }), null);
});

test('parseTaskNotification handles missing optional tags without throwing', () => {
  assert.equal(parseTaskNotification('just a normal prompt'), null);
  const minimal = parseTaskNotification('<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n</task-notification>')!;
  assert.equal(minimal.taskId, 'abc');
  assert.equal(minimal.status, 'completed');
  assert.equal(minimal.usage, undefined);
  assert.equal(minimal.worktreeBranch, undefined);
  assert.equal(minimal.result, undefined);
});
