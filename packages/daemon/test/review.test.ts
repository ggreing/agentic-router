// Decision 145: a reviewer's or tester's verdict is read from the two lines its report begins with, when the
// subagent stops, and applied as a router_report_result by that role would be. Only the tokens are kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PRESETS, ROUTER_TOOL_PREFIX, formatTriageContext, triage } from '@do-it-all-claude-code/core';
import { parseReportVerdict, reportAsksForScope } from '../src/review.ts';
import { makeRepo, postHook, rmrf, rows, startTestDaemon, type HookInput, type TestDaemon } from './helpers.ts';

const L2_PROMPT = 'Refactor the validation module across multiple files and add an audit log';
type Out = { hookSpecificOutput?: { additionalContext?: string; permissionDecision?: string; permissionDecisionReason?: string } };
let seq = 0;

test('parseReportVerdict: one verdict, an optional margin, nothing else', () => {
  const p = parseReportVerdict;
  assert.deepEqual(p('Verdict: accept\nMargin: easy\n- Review: 5/5'), { verdict: 'accept', margin: 'easy' });
  assert.deepEqual(p('Verdict: accept\nMargin: normal\n- Review: …'), { verdict: 'accept', margin: 'normal' });
  assert.deepEqual(p('Verdict: reject\nMargin: normal\n- Review: must fix: src/a.ts:3'), { verdict: 'reject' }, 'a reject has no margin');
  assert.deepEqual(p('Verdict: accept\n- Changed files: none'), { verdict: 'accept' }, 'no margin line');
  // how models decorate the lines
  assert.deepEqual(p('**Verdict:** accept\n**Margin:** easy'), { verdict: 'accept', margin: 'easy' });
  assert.deepEqual(p('- Verdict: Accept\n- Margin: Easy'), { verdict: 'accept', margin: 'easy' });
  assert.deepEqual(p('`Verdict: reject`'), { verdict: 'reject' });
  assert.deepEqual(p('Some preface.\n\nVERDICT : accepted\nmargin:normal'), { verdict: 'accept', margin: 'normal' });
  assert.deepEqual(p('> Verdict: rejected'), { verdict: 'reject' });
  // nothing to apply
  assert.equal(p('The change looks fine to me.'), undefined);
  assert.equal(p('`Verdict: accept` or `Verdict: reject`\n`Margin: easy` or `Margin: normal`'), undefined, 'the instructions echoed back');
  assert.equal(p('Verdict: accept\n…\nVerdict: reject'), undefined, 'two different verdicts');
  assert.equal(p('Verdict: maybe'), undefined);
  assert.equal(p('The final verdict is to accept.'), undefined, 'not the line');
  assert.equal(p('overdict: accept'), undefined);
  assert.equal(p(''), undefined);
  assert.equal(p(undefined), undefined);
  assert.equal(p({ verdict: 'accept' }), undefined);
  // the same verdict twice is one verdict; two different margins are no margin
  assert.deepEqual(p('Verdict: accept\nVerdict: accept\nMargin: easy\nMargin: normal'), { verdict: 'accept' });
  // Appendix B: a "Subtask:" line names which writer(s) the verdict is about
  assert.deepEqual(p('Verdict: reject\nSubtask: B\n- Review: must fix src/y.ts'), { verdict: 'reject', subtasks: ['B'] });
  assert.deepEqual(p('Verdict: accept\nMargin: easy\nSubtask: A, C'), { verdict: 'accept', margin: 'easy', subtasks: ['A', 'C'] });
  assert.deepEqual(p('Verdict: reject\n**Subtask:** c-l1-02'), { verdict: 'reject', subtasks: ['c-l1-02'] });
  assert.deepEqual(p('Verdict: accept\nSubtask: <id>[, <id>...]'), { verdict: 'accept' }, 'the echoed placeholder names nothing');
  assert.deepEqual(p('Verdict: reject\nSubtask: none'), { verdict: 'reject' }, '"none" names nothing');
  // only the head of a very long message is read
  assert.equal(p('x'.repeat(20_001) + '\nVerdict: accept'), undefined);
});

test('reportAsksForScope: the "Scope request:" item, unless it says none', () => {
  assert.equal(reportAsksForScope('- Changed files: a\n- Scope request: docs/api.md (the README section moved there)'), true);
  assert.equal(reportAsksForScope('**Scope request:** allow `config/**`'), true);
  for (const none of ['- Scope request: none', 'Scope request: None.', 'Scope request: n/a', 'Scope request: -', 'Scope request:', '**Scope request:** none', 'no such item', '', undefined, 3])
    assert.equal(reportAsksForScope(none), false, String(none));
});

test('the first brief no longer lists the router tools', () => {
  for (const prompt of [L2_PROMPT, 'Fix the typo in README.md', 'Look into why the build is slow and make it faster']) {
    const t = triage({ prompt });
    const brief = formatTriageContext(t, DEFAULT_PRESETS[t.level]);
    assert.ok(!/router_(get_plan|report_triage|report_result|request_escalation|request_scope)/.test(brief), prompt);
    assert.ok(!/Router tools/.test(brief), prompt);
  }
});

async function withDaemon(fn: (d: TestDaemon, s: ReturnType<typeof session>) => Promise<void>): Promise<void> {
  const repo = makeRepo({ 'src/a.ts': 'a\n' });
  const d = await startTestDaemon({ verify: { resolveCommands: async () => [] } });
  try { await fn(d, session(d, 'rv', repo)); } finally { await d.close(); rmrf(d.home); rmrf(repo); }
}

function session(d: TestDaemon, sid: string, cwd: string) {
  const post = async (h: HookInput): Promise<Out> => {
    const r = await postHook(d.port, { session_id: sid, cwd, transcript_path: path.join(d.home, `${sid}.jsonl`), ...h });
    assert.equal(r.status, 200, r.text);
    return r.body as Out;
  };
  const steps: Record<string, [string, string]> = { coder: ['haiku', 'low'], tester: ['haiku', 'low'], reviewer: ['sonnet', 'medium'], architect: ['sonnet', 'medium'] };
  /** Dispatches a subtask, lets it change `edit` (a writer) and stop with `report` as its last message; returns the lead's line about it. */
  const run = async (tag: string, role: string, report: string, edit?: string): Promise<string> => {
    const agent = `ag${++seq}`;
    const [model, effort] = steps[role]!;
    const dispatched = await post({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: `toolu_r${++seq}`,
      tool_input: { subagent_type: `do-it-all-claude-code:${role}`, prompt: `[subtask:${tag}]\n[scope: src/**]\nwork`, model, effort } });
    assert.deepEqual(dispatched, {}, `dispatch ${tag}: ${JSON.stringify(dispatched)}`);
    await post({ hook_event_name: 'SubagentStart', agent_id: agent, agent_type: `do-it-all-claude-code:${role}` });
    if (edit) fs.writeFileSync(path.join(cwd, 'src', edit), `// ${tag}\n`);
    assert.deepEqual(await post({ hook_event_name: 'SubagentStop', agent_id: agent, agent_type: `do-it-all-claude-code:${role}`, stop_hook_active: false, last_assistant_message: report }), {});
    await d.router.drain();
    const note = await post({ hook_event_name: 'UserPromptSubmit', prompt: `<task-notification>\n<task-id>${agent}</task-id>\n<status>completed</status>\n</task-notification>` });
    return note.hookSpecificOutput?.additionalContext ?? '';
  };
  return { post, run, cwd };
}
const WRITER_REPORT = '- Changed files: src/x.ts\n- Checks run: npm test (pass)\n- Scope request: none\n- Remaining issues: none';
const sub = (d: TestDaemon, id: string) => {
  const r = rows(d, 'SELECT status, verdict, review FROM subtasks WHERE id = ?', id)[0]!;
  const review = r.review ? JSON.parse(String(r.review)) as { verdict: string; by: string; bySubtaskId?: string; margin?: string } : null;
  return { status: r.status, verdict: r.verdict, review: review && [review.verdict, review.by, review.bySubtaskId ?? null, review.margin ?? null] };
};
const slot = (d: TestDaemon) => rows(d, "SELECT step, easy_streak, last_easy, fail_streak, up_count FROM slots WHERE role = 'coder' AND slot = 0")[0];

test('a reviewer\'s accept with margin easy is recorded for the writer it reviewed, without any tool call', () => withDaemon(async (d, s) => {
  await s.post({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT });
  const coderLine = await s.run('A', 'coder', WRITER_REPORT, 'x.ts');
  assert.match(coderLine, /subtask A \(coder @s1.*verify passed/);
  assert.ok(coderLine.includes(`do not fix it yourself: call ${ROUTER_TOOL_PREFIX}router_request_escalation (load it with ToolSearch first)`), coderLine);
  assert.ok(!coderLine.includes('router_request_scope'), 'no scope sentence when the report asked for none');
  assert.deepEqual(sub(d, 'A'), { status: 'passed', verdict: 'meet', review: null });

  const line = await s.run('R', 'reviewer', 'Verdict: accept\nMargin: easy\n- Review: fit 5/5 · correctness 5/5, findings: none\n- Changed files: none');
  assert.deepEqual(sub(d, 'A').review, ['accept', 'reviewer', 'R', 'easy']);
  assert.match(line, /subtask R \(reviewer .*verify passed.* Its verdict was recorded from its report: accept \(margin easy\) for subtask A\./);
  assert.ok(!line.includes('router_request_escalation'), 'a judge gets no writer sentence');
  assert.deepEqual((x => [x!.easy_streak, x!.last_easy])(slot(d)), [1, 1], 'counted as an easy pass for step-down');
  // only tokens are stored: nothing of the report text
  const stored = JSON.stringify(rows(d, 'SELECT review FROM subtasks')) + JSON.stringify(rows(d, 'SELECT payload FROM events')) + JSON.stringify(rows(d, 'SELECT detail FROM signals'));
  assert.ok(!stored.includes('fit 5/5') && !stored.includes('findings: none'), 'the report text is not kept');
  assert.ok(rows(d, "SELECT kind FROM signals WHERE subtask_id = 'A' AND kind = 'review'").length === 1, 'the review signal is written as for the tool');
}));

test('a reject is recorded as a failure of the writer: the second one in a row raises the slot', () => withDaemon(async (d, s) => {
  await s.post({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT });
  await s.run('A', 'coder', WRITER_REPORT, 'x.ts');
  const first = await s.run('R1', 'reviewer', 'Verdict: reject\nMargin: normal\n- Review: must fix src/x.ts:1');
  assert.deepEqual(sub(d, 'A'), { status: 'failed', verdict: 'rejected', review: ['reject', 'reviewer', 'R1', null] });
  assert.match(first, /Its verdict was recorded from its report: reject for subtask A\..*Dispatch that subtask again/);
  assert.deepEqual((x => [x!.step, x!.fail_streak])(slot(d)), ['s1', 1]);
  // the second attempt of the same subtask, rejected again by a tester this time
  await s.run('A', 'coder', WRITER_REPORT, 'y.ts');
  assert.deepEqual(sub(d, 'A'), { status: 'passed', verdict: 'meet', review: null }, 'a new dispatch clears the review');
  const second = await s.run('T1', 'tester', '**Verdict:** reject\n- Changed files: none\n- Checks run: npm test (2 failed)');
  assert.deepEqual(sub(d, 'A').review, ['reject', 'tester', 'T1', null]);
  assert.deepEqual((x => [x!.step, x!.up_count])(slot(d)), ['s2', 1], 'two rejects in a row raise the slot');
  assert.match(second, /reject for subtask A\./);
}));

test('what is not applied: no verdict line, a reject over two writers, a writer that started after the judge', () => withDaemon(async (d, s) => {
  await s.post({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT });
  await s.run('A', 'coder', WRITER_REPORT, 'x.ts');
  // a report without the line: nothing recorded, and the lead is told how to report it
  const none = await s.run('R1', 'reviewer', 'Looks good overall, two small remarks.');
  assert.equal(sub(d, 'A').review, null);
  assert.ok(none.includes(`No verdict was recorded from its report (no single "Verdict:" line): report it with ${ROUTER_TOOL_PREFIX}router_report_result (load it with ToolSearch first).`), none);
  // two writers passed, then a reject: which one is not in the line
  await s.run('B', 'coder', WRITER_REPORT, 'y.ts');
  const two = await s.run('R2', 'reviewer', 'Verdict: reject\n- Review: must fix');
  assert.deepEqual([sub(d, 'A').status, sub(d, 'B').status, sub(d, 'A').review, sub(d, 'B').review], ['passed', 'passed', null, null]);
  assert.match(two, /No verdict was recorded from its report \(it judged 2 subtasks: A, B\)/);
  // Appendix B: the fall-back is recorded as a signal on the judge, without any report prose
  assert.equal(rows(d, "SELECT ok FROM signals WHERE subtask_id = 'R2' AND kind = 'review'").length, 1, 'the fall-back is recorded on the judge');
  assert.ok(!JSON.stringify(rows(d, 'SELECT detail FROM signals')).includes('must fix'));
  // an accept over two writers is applied to both
  await s.run('R3', 'reviewer', 'Verdict: accept\nMargin: normal');
  assert.deepEqual([sub(d, 'A').review, sub(d, 'B').review], [['accept', 'reviewer', 'R3', 'normal'], ['accept', 'reviewer', 'R3', 'normal']]);
  // a writer dispatched after that reviewer is not covered by its verdict
  await s.run('C', 'coder', WRITER_REPORT, 'z.ts');
  assert.equal(sub(d, 'C').review, null);
}));

test('Appendix B: a Subtask line credits a reject only to the named writer', () => withDaemon(async (d, s) => {
  await s.post({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT });
  await s.run('A', 'coder', WRITER_REPORT, 'x.ts');
  await s.run('B', 'coder', WRITER_REPORT, 'y.ts');
  await s.run('Rb', 'reviewer', 'Verdict: reject\nSubtask: B\n- Review: must fix src/y.ts:3');
  assert.equal(sub(d, 'A').review, null, 'A was not named');
  assert.deepEqual(sub(d, 'B'), { status: 'failed', verdict: 'rejected', review: ['reject', 'reviewer', 'Rb', null] });
  assert.equal(rows(d, "SELECT ok FROM signals WHERE subtask_id = 'Rb' AND kind = 'review'").length, 0, 'no fall-back signal: the line was used');
}));

test('Appendix B: a Subtask line can name both writers, and the verdict counts for both', () => withDaemon(async (d, s) => {
  await s.post({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT });
  await s.run('A', 'coder', WRITER_REPORT, 'x.ts');
  await s.run('B', 'coder', WRITER_REPORT, 'y.ts');
  await s.run('Rab', 'reviewer', 'Verdict: accept\nMargin: easy\nSubtask: A, B');
  assert.deepEqual([sub(d, 'A').review, sub(d, 'B').review], [['accept', 'reviewer', 'Rab', 'easy'], ['accept', 'reviewer', 'Rab', 'easy']]);
}));

test('Appendix B: an unknown id falls back to the current behaviour and is recorded without prose', () => withDaemon(async (d, s) => {
  await s.post({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT });
  await s.run('A', 'coder', WRITER_REPORT, 'x.ts');
  await s.run('B', 'coder', WRITER_REPORT, 'y.ts');
  await s.run('Rz', 'reviewer', 'Verdict: reject\nSubtask: Z\n- Review: must fix src/x.ts');
  // Z is not a writer this judge reviewed: a reject over two writers credits no one (the old behaviour)
  assert.deepEqual([sub(d, 'A').review, sub(d, 'B').review], [null, null]);
  const fb = rows(d, "SELECT ok, detail FROM signals WHERE subtask_id = 'Rz' AND kind = 'review'");
  assert.equal(fb.length, 1, 'the fall-back is recorded as a signal on the judge');
  assert.equal(Number(fb[0]!.ok), 0);
  assert.match(String(fb[0]!.detail), /not attributed .*did not judge \(Z\).*not credited/);
  assert.ok(!JSON.stringify(rows(d, 'SELECT detail FROM signals')).includes('must fix'), 'no report prose stored');
}));

test('a writer whose report asks for more scope gets the scope tool named once', () => withDaemon(async (d, s) => {
  await s.post({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT });
  const line = await s.run('A', 'coder', '- Changed files: src/x.ts\n- Scope request: docs/api.md, the section moved there\n- Remaining issues: none', 'x.ts');
  assert.ok(line.includes(`Its report asks for paths outside its scope: to grant them, call ${ROUTER_TOOL_PREFIX}router_request_scope (load it with ToolSearch first).`), line);
  assert.ok(!JSON.stringify(rows(d, 'SELECT payload FROM events')).includes('the section moved there'));
}));

test('after a compaction or a resume the lead is told where the plan is kept, with the full tool name', () => withDaemon(async (_d, s) => {
  await s.post({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT });
  const sentence = `The router keeps this plan. To read it again (each slot's current model, effort and step, the subtasks and their verify results), call ${ROUTER_TOOL_PREFIX}router_get_plan (load it with ToolSearch first).`;
  for (const source of ['compact', 'resume']) {
    const ctx = (await s.post({ hook_event_name: 'SessionStart', source })).hookSpecificOutput?.additionalContext ?? '';
    assert.ok(ctx.includes(sentence), `${source}: ${ctx.slice(-300)}`);
  }
}));

test('a lead-direct request gets no such sentence: there is no team plan to read', () => withDaemon(async (_d, s) => {
  await s.post({ hook_event_name: 'UserPromptSubmit', prompt: 'Fix the typo in README.md' });
  const ctx = (await s.post({ hook_event_name: 'SessionStart', source: 'compact' })).hookSpecificOutput?.additionalContext ?? '';
  assert.ok(!ctx.includes('router_get_plan'), ctx.slice(-300));
}));
