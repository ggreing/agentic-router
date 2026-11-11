// Stage-2 judge request/answer handling and the evaluation scores (decisions 104-111).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PRESETS, formatTriageContext, triage, withLeadModel } from '@agentic-router/core';
import {
  arrangementOf, bestArrangement, calibration, cascade, effectiveCost, judgeAnswers, loadPromptSet, regretTable, scoreBy, scoreSet, summariseRuns,
  type Classifier, type LabelledPrompt, type MeasuredRun,
} from '../src/triage-eval.ts';
import {
  JUDGE_BANDS, JUDGE_EFFORT, JUDGE_MAX_PROMPT_CHARS, JUDGE_MODEL, JUDGE_SCHEMA, JUDGE_SOURCE, applyJudge, buildJudgeRequest, judgeCanChangeArrangement, judgeDecision, judgeTeamScore, parseJudgeOutput,
} from '../src/triage-judge.ts';

const SET = loadPromptSet(fs.readFileSync(fileURLToPath(new URL('./fixtures/triage/prompts.yaml', import.meta.url)), 'utf8'));
const stage1: Classifier = p => { const t = triage({ prompt: p.prompt }); return { kind: t.kind, level: t.level, teamScore: t.teamScore }; };

test('the prompt set: 30 tasks in two wordings, balanced by answer and language', () => {
  assert.equal(SET.length, 60);
  assert.equal(new Set(SET.map(p => p.id)).size, 60);
  const tasks = new Set(SET.map(p => p.task));
  assert.equal(tasks.size, 30);
  for (const t of tasks) assert.deepEqual(SET.filter(p => p.task === t).map(p => p.style).sort(), ['short', 'spec'], t);
  assert.equal(SET.filter(p => p.label.kind === 'team').length, 30);
  assert.deepEqual([SET.filter(p => p.lang === 'ko').length, SET.filter(p => p.lang === 'en').length], [32, 28]);
  for (const p of SET) {
    assert.equal(p.label.kind === 'team', p.label.level === 'L2' || p.label.level === 'L3', p.id);
    assert.ok(p.split === 'dev' || p.split === 'test', p.id);
  }
  // the two wordings differ in length by design: the spec is the long one
  for (const t of tasks) {
    const [short, spec] = ['short', 'spec'].map(s => SET.find(p => p.task === t && p.style === s)!.prompt.length);
    assert.ok(spec! > short! * 2, t);
  }
});

test('stage 1 on the prompt set: it may leave requests open, but a confident answer is rarely wrong', () => {
  const s = scoreSet(SET, stage1);
  assert.ok(s.under + s.over <= 2, `confident and wrong: under ${s.under}, over ${s.over}`);
  assert.ok(s.answered.direct + s.answered.team >= 20, 'stage 1 settles at least a third of the set');
  // short wordings of team-sized tasks are mostly left to stage 2 rather than guessed
  const shortTeam = scoreSet(SET.filter(p => p.style === 'short' && p.label.kind === 'team'), stage1);
  assert.ok(shortTeam.under <= 1);
  // long wordings of small tasks are not sent to a team just for being long
  assert.ok(scoreSet(SET.filter(p => p.style === 'spec' && p.label.kind === 'direct'), stage1).over <= 1);
});

test('scores: uncertain is not an error; under and over count the confident wrong answers', () => {
  const p = (id: string, kind: 'direct' | 'team', level: 'L1' | 'L2' | 'L3' = kind === 'team' ? 'L2' : 'L1'): LabelledPrompt =>
    ({ id, task: id, lang: 'en', style: id.startsWith('s') ? 'short' : 'spec', split: 'dev', label: { kind, level }, prompt: id });
  const items = [p('s1', 'direct'), p('s2', 'team'), p('s3', 'team'), p('x1', 'direct'), p('x2', 'team', 'L3'), p('x3', 'team')];
  const answers: Record<string, ReturnType<Classifier>> = {
    s1: { kind: 'direct', level: 'L1', teamScore: 0.1 }, s2: { kind: 'direct', level: 'L1', teamScore: 0.2 }, s3: { kind: 'uncertain', level: 'L1', teamScore: 0.5 },
    x1: { kind: 'team', level: 'L2', teamScore: 0.9 }, x2: { kind: 'team', level: 'L2', teamScore: 0.9 }, x3: undefined,
  };
  const c: Classifier = q => answers[q.id];
  const s = scoreSet(items, c);
  assert.deepEqual(s.answered, { direct: 2, team: 2, uncertain: 1, none: 1 });
  assert.deepEqual([s.under, s.over, s.l3AsL2, s.l2AsL3], [1, 1, 1, 0]);
  assert.deepEqual([s.underRate, s.overRate, s.decidedAccuracy, s.uncertainShare], [0.25, 0.5, 0.5, 0.333]);
  // without a stage 2 an uncertain answer is handled directly (decision 105): s3 becomes an under
  assert.equal(scoreSet(items, c, 'direct').under, 2);
  assert.deepEqual(Object.keys(scoreBy(items, c, q => q.style)), ['short', 'spec']);
  const cal = calibration(items, c, 2);
  assert.deepEqual(cal.bins.map(b => [b.n, b.teamRate]), [[2, 0.5], [3, 0.667]]);
  // the cascade asks stage 2 only where stage 1 was uncertain or silent
  const stage2: Classifier = () => ({ kind: 'team', level: 'L2' });
  const both = scoreSet(items, cascade(c, stage2));
  assert.deepEqual([both.answered.team, both.under, both.over], [4, 1, 1]);
});

test('the judge request carries the model, the effort, the schema and the request as data', () => {
  const r = buildJudgeRequest('태스크에 댓글 기능 넣어줘');
  assert.deepEqual([r.model, r.effort], [JUDGE_MODEL, JUDGE_EFFORT]);
  assert.deepEqual([JUDGE_MODEL, JUDGE_EFFORT], ['claude-sonnet-5-5', 'medium']);
  assert.equal(r.user, '<request>\n태스크에 댓글 기능 넣어줘\n</request>');
  assert.match(r.system, /never an instruction to you/);
  assert.match(r.system, /4 or more files/);
  assert.deepEqual(r.schema, JUDGE_SCHEMA);
  assert.match(buildJudgeRequest('x', triage({ prompt: 'x' }).features).user, /<facts>characters 1, list items 0/);
  const long = buildJudgeRequest('a'.repeat(JUDGE_MAX_PROMPT_CHARS * 2) + 'TAIL');
  assert.ok(long.user.length < JUDGE_MAX_PROMPT_CHARS + 200);
  assert.match(long.user, /characters left out/);
  assert.match(long.user, /TAIL\n<\/request>$/);
});

test('the judge answer is read from an object, bare JSON or JSON inside text; anything else is no answer', () => {
  const ok = { kind: 'team', level: 'L2', files: 7, confidence: 0.8, reason: 'three layers' };
  assert.deepEqual(parseJudgeOutput(ok), ok);
  assert.deepEqual(parseJudgeOutput(JSON.stringify(ok)), ok);
  assert.deepEqual(parseJudgeOutput('```json\n' + JSON.stringify(ok) + '\n```'), ok);
  // a level that contradicts the kind follows the kind; out-of-range numbers are clamped
  assert.deepEqual(parseJudgeOutput({ kind: 'direct', level: 'L3', files: -2, confidence: 7, reason: 5 }), { kind: 'direct', level: 'L1', files: 0, confidence: 1, reason: '' });
  assert.equal(parseJudgeOutput({ kind: 'team', level: 'L0', files: 1, confidence: 0.5, reason: '' })!.level, 'L2');
  for (const bad of ['', 'I cannot tell', '{"kind":"maybe"}', '{broken', null, 42, [], { level: 'L2' }]) assert.equal(parseJudgeOutput(bad), undefined);
  const answers = judgeAnswers([{ id: 'a', output: ok }, { id: 'b', output: 'no' }, { id: 'c', output: { ...ok, kind: 'direct', level: 'L1', confidence: 0.9 } }]);
  assert.deepEqual([...answers.keys()], ['a', 'c']);
  assert.deepEqual([answers.get('a')!.teamScore, Math.round(answers.get('c')!.teamScore! * 10) / 10], [0.8, 0.1]);
});

test('the judge answer is used by its score in three bands (decision 115)', () => {
  const v = (kind: 'direct' | 'team', confidence: number, level = kind === 'team' ? 'L3' : 'L0') =>
    parseJudgeOutput({ kind, level, files: 3, confidence, reason: 'ZZSECRETZZ words taken from the prompt' })!;
  assert.deepEqual(JUDGE_BANDS, { team: 0.5, direct: 0.3 });
  // the score: a "team" answer's confidence, or what a "direct" answer leaves over
  assert.deepEqual([judgeTeamScore(v('team', 0.8)), judgeTeamScore(v('direct', 0.9)), judgeTeamScore(v('direct', 0.7))], [0.8, 0.1, 0.3]);
  // at or above 0.5: team; below 0.3: direct; in between: still uncertain
  // (decision 119: a team answer plans L2 even when the judge said L3, and keeps that as l3Signs)
  assert.deepEqual(judgeDecision(v('team', 0.8)), { kind: 'team', level: 'L2', teamScore: 0.8, l3Signs: true });
  assert.deepEqual(judgeDecision(v('team', 0.5)), { kind: 'team', level: 'L2', teamScore: 0.5, l3Signs: true });
  assert.deepEqual(judgeDecision(v('team', 0.8, 'L2')), { kind: 'team', level: 'L2', teamScore: 0.8, l3Signs: false });
  assert.deepEqual(judgeDecision(v('team', 0.45)), { kind: 'uncertain', level: 'L1', teamScore: 0.45, l3Signs: false });
  assert.deepEqual(judgeDecision(v('direct', 0.7)), { kind: 'uncertain', level: 'L1', teamScore: 0.3, l3Signs: false });
  assert.deepEqual(judgeDecision(v('direct', 0.71)), { kind: 'direct', level: 'L0', teamScore: 0.29, l3Signs: false });
  assert.deepEqual(judgeDecision(v('direct', 0.95, 'L1')), { kind: 'direct', level: 'L1', teamScore: 0.05, l3Signs: false });
  // a word the score overrules takes the band's default level
  assert.deepEqual(judgeDecision(v('direct', 0.5)), { kind: 'team', level: 'L2', teamScore: 0.5, l3Signs: false });
  assert.deepEqual(judgeDecision(v('team', 0.2)), { kind: 'direct', level: 'L1', teamScore: 0.2, l3Signs: false });
  assert.deepEqual(judgeDecision(v('direct', 0.7), { team: 0.6, direct: 0.4 }).kind, 'direct');

  // applied to a stage-1 result: only an uncertain one changes, and only when there is a verdict
  const open = triage({ prompt: '태스크에 댓글 기능 넣어줘' });
  assert.equal(open.kind, 'uncertain');
  assert.equal(applyJudge(open, undefined), open);
  const settled = triage({ prompt: 'fix the typo in README.md' });
  assert.equal(applyJudge(settled, v('team', 0.9)), settled);

  const team = applyJudge(open, v('team', 0.8, 'L2'));
  assert.equal(JUDGE_SOURCE, 'judge');
  assert.deepEqual([team.kind, team.level, team.source, team.rule, team.preset, team.budgetUsd, team.confidence, team.teamScore],
    ['team', 'L2', JUDGE_SOURCE, 'judge-team', 'L2', DEFAULT_PRESETS.L2.budgetUsd, 0.8, 0.8]);
  assert.match(formatTriageContext(team, DEFAULT_PRESETS[team.level]), /Do not edit or write files yourself/);
  assert.deepEqual(team.features, open.features);
  assert.equal(team.l3Signs, false);
  // the judge said L3: planned at L2 with the L2 budget, marked, and the brief shows the lead the way up
  const big = applyJudge(open, v('team', 0.9, 'L3'));
  assert.deepEqual([big.level, big.preset, big.budgetUsd, big.rule, big.l3Signs], ['L2', 'L2', DEFAULT_PRESETS.L2.budgetUsd, 'judge-team', true]);
  assert.match(big.rationale, /^L3 signs, planned as L2: stage-2 judge said team/);
  assert.match(formatTriageContext(big, DEFAULT_PRESETS[big.level]), /use the L3 team instead: make your first Agent call the L3 team's architect/);
  assert.doesNotMatch(formatTriageContext(team, DEFAULT_PRESETS[team.level]), /L3/);

  const direct = applyJudge(open, v('direct', 0.9));
  assert.deepEqual([direct.kind, direct.level, direct.source, direct.rule, direct.preset, direct.teamScore], ['direct', 'L0', JUDGE_SOURCE, 'judge-direct', 'L0', 0.1]);
  assert.ok(direct.confidence >= 0.7);
  const directBrief = formatTriageContext(direct, DEFAULT_PRESETS[direct.level]);
  assert.match(directBrief, /make the change yourself/);
  assert.doesNotMatch(directBrief, /could not tell the size|subagent_type/);

  // in between: the request stays uncertain and the lead gets the rubric (with the L2 and L3 call values)
  const between = applyJudge(open, v('direct', 0.65));
  assert.deepEqual([between.kind, between.level, between.source, between.rule, between.preset, between.teamScore], ['uncertain', 'L1', 'default', 'judge-open', open.preset, 0.35]);
  assert.ok(between.confidence < 0.6);
  const rubric = formatTriageContext(between, DEFAULT_PRESETS[between.level]);
  assert.match(rubric, /could not tell the size/);
  assert.match(rubric, /subagent_type "agentic-router:architect"/);
  // the stored rationale carries numbers, never the judge's sentence about the prompt
  for (const r of [team, direct, between]) {
    assert.match(r.rationale, /stage-2 judge said (direct|team) \(confidence 0\.\d\d, about 3 files\), team score 0\.\d\d/);
    assert.doesNotMatch(r.rationale, /ZZSECRETZZ/);
  }
  // a customised teams.yaml sets the preset and the budget
  const presets = { ...DEFAULT_PRESETS, L2: { ...DEFAULT_PRESETS.L2, budgetUsd: 9 } };
  assert.equal(applyJudge(open, v('team', 0.8, 'L2'), presets).budgetUsd, 9);

  // decision 120: the call is skipped when L1 and L2 are staffed the same way, so its answer could not change the staffing
  assert.equal(judgeCanChangeArrangement(DEFAULT_PRESETS), true);
  assert.equal(judgeCanChangeArrangement(withLeadModel(DEFAULT_PRESETS, 'claude-sonnet-5-5')), true);
  assert.equal(judgeCanChangeArrangement(withLeadModel(DEFAULT_PRESETS, 'claude-opus-5-5')), false);
  assert.equal(judgeCanChangeArrangement(withLeadModel(DEFAULT_PRESETS, 'claude-opus-5-5', { opus: 'L2' })), true);
  assert.equal(judgeCanChangeArrangement({ ...DEFAULT_PRESETS, L2: { ...DEFAULT_PRESETS.L2, leadDirect: true } }), false);

  // decision 121: where L1 is delegated, an in-between score keeps the L2 team stage 1 planned; a "direct" answer is the one-coder L1 team
  const opus = withLeadModel(DEFAULT_PRESETS, 'claude-opus-5-5');
  const openOpus = triage({ prompt: '태스크에 댓글 기능 넣어줘' }, opus);
  const betweenOpus = applyJudge(openOpus, v('direct', 0.65), opus);
  assert.deepEqual([betweenOpus.kind, betweenOpus.level, betweenOpus.preset, betweenOpus.rule], ['uncertain', 'L2', 'L2', 'judge-open']);
  assert.match(betweenOpus.rationale, /-> L2 team, the lead picks the roles$/);
  assert.match(formatTriageContext(betweenOpus, opus[betweenOpus.level], opus), /the staffing is yours/);
  assert.deepEqual([applyJudge(openOpus, v('direct', 0.9, 'L1'), opus).level, applyJudge(openOpus, v('direct', 0.9, 'L1'), opus).preset], ['L1', 'L1']);

  // the evaluation reads a judge run through the same bands; null takes the judge's own word
  const lines = [{ id: 'a', output: v('direct', 0.6) }, { id: 'b', output: v('direct', 0.9) }, { id: 'c', output: v('team', 0.7) }];
  assert.deepEqual([...judgeAnswers(lines).values()].map(a => a.kind), ['uncertain', 'direct', 'team']);
  assert.deepEqual([...judgeAnswers(lines, null).values()].map(a => a.kind), ['direct', 'direct', 'team']);
  assert.deepEqual([...judgeAnswers(lines, { team: 0.4, direct: 0.3 }).values()].map(a => a.kind), ['team', 'direct', 'team']);
});

test('regret: an answer costs what it spent beyond the cheapest arrangement that works', () => {
  const run = (taskId: string, arrangement: MeasuredRun['arrangement'], passed: boolean, costUsd: number, wallSeconds: number): MeasuredRun => ({ taskId, arrangement, passed, costUsd, wallSeconds });
  const stats = summariseRuns([
    // small: doing it directly is cheapest and fastest
    run('small', 'direct', true, 0.10, 20), run('small', 'team-L2', true, 0.12, 60), run('small', 'team-L3', true, 0.60, 90),
    // big: the lead alone fails; the L2 team passes for less than the L3 team
    run('big', 'direct', false, 0.40, 300), run('big', 'team-L2', true, 0.50, 240), run('big', 'team-L3', true, 1.50, 200),
    // hard: only the L3 team passes
    run('hard', 'direct', false, 0.50, 400), run('hard', 'team-L2', false, 0.70, 500), run('hard', 'team-L3', true, 2.00, 600),
  ]);
  assert.deepEqual(['small', 'big', 'hard'].map(t => bestArrangement(stats[t]!, 0)), ['direct', 'team-L2', 'team-L3']);
  // a failed choice pays for itself and for the redo with the cheapest passing arrangement
  assert.equal(effectiveCost(stats.big!, 'direct', 0), 0.9);
  assert.equal(effectiveCost(stats.hard!, 'team-L2', 0), 2.7);
  // time can change the answer: at $0.10 per minute the L3 team's shorter run does not make up its price
  assert.equal(bestArrangement(stats.big!, 0.1), 'team-L2');
  assert.equal(Math.round(effectiveCost(stats.small!, 'team-L2', 0.1)! * 100) / 100, 0.22);
  const rows = regretTable(stats, {
    'always direct': () => 'direct', 'always team-L2': () => 'team-L2',
    best: t => bestArrangement(stats[t]!, 0)!,
  }, 0);
  const by = Object.fromEntries(rows.map(r => [r.policy, r]));
  assert.deepEqual([by.best!.meanRegret, by.best!.matchesBest], [0, 3]);
  assert.deepEqual([by['always direct']!.meanRegret, by['always direct']!.matchesBest], [0.3, 1]);          // (0 + 0.4 + 0.5) / 3
  assert.deepEqual([by['always team-L2']!.meanRegret, by['always team-L2']!.worstRegret], [0.24, 0.7]);     // (0.02 + 0 + 0.7) / 3
  // repetitions are averaged, and a task with no passing arrangement charges no redo
  const two = summariseRuns([run('t', 'direct', true, 0.1, 10), run('t', 'direct', false, 0.3, 30)]);
  assert.deepEqual(two.t!.direct, { n: 2, passRate: 0.5, costUsd: 0.2, wallSeconds: 20 });
  assert.equal(Math.round(effectiveCost(two.t!, 'direct', 0)! * 100) / 100, 0.3);
  assert.equal(effectiveCost(summariseRuns([run('f', 'direct', false, 0.4, 1)]).f!, 'direct', 0), 0.4);
  assert.equal(effectiveCost(stats.small!, 'team-L3', 0), 0.6);
  // triage answers map to arrangements; uncertain is handled directly unless told otherwise
  assert.deepEqual([arrangementOf({ kind: 'direct', level: 'L0' }), arrangementOf({ kind: 'team', level: 'L2' }), arrangementOf({ kind: 'team', level: 'L3' }), arrangementOf({ kind: 'uncertain', level: 'L1' }), arrangementOf(undefined, 'team-L2')],
    ['direct', 'team-L2', 'team-L3', 'direct', 'team-L2']);
});
