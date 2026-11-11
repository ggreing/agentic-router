// Scoring for triage (decisions 106, 108, 111).
// Pure functions: the CLI (triage-eval-cli.ts) reads the files and prints the tables.
//
// Two kinds of score:
//  - scoreSet: against labelled prompts. "uncertain" is not an error; the errors are the confident
//    wrong answers: a team-sized task sent to the lead alone (under), a small task sent to a team (over).
//  - regret: against measured runs of the same task under each arrangement (decision 107). The regret
//    of an answer is what it cost beyond the cheapest arrangement that works, in money and in time.
import { parse } from 'yaml';
import { JUDGE_BANDS, judgeDecision, judgeTeamScore, parseJudgeOutput, type JudgeBands } from './triage-judge.ts';
import type { TriageKind } from './triage.ts';
import type { Level } from './types.ts';

export interface PromptLabel { kind: 'direct' | 'team'; level: Level; files?: number; dirs?: number }
export interface LabelledPrompt {
  id: string;
  task: string;
  lang: string;
  style: string;            // short | spec | issue | task
  split: string;            // dev | test | other
  label: PromptLabel;
  prompt: string;
}
export interface Answer { kind: TriageKind; level: Level; teamScore?: number }
export type Classifier = (p: LabelledPrompt) => Answer | undefined;

interface RawTask { task: string; lang: string; split?: string; label: PromptLabel; short?: string; spec?: string }

/** Reads prompts.yaml: one entry per task with a `short` and a `spec` wording. */
export function loadPromptSet(yamlText: string): LabelledPrompt[] {
  const out: LabelledPrompt[] = [];
  for (const t of parse(yamlText) as RawTask[]) {
    for (const style of ['short', 'spec'] as const) {
      const prompt = t[style];
      if (typeof prompt !== 'string' || !prompt.trim()) continue;
      out.push({ id: `${t.task}-${style}`, task: t.task, lang: t.lang, style, split: t.split ?? 'other', label: t.label, prompt: prompt.trim() });
    }
  }
  return out;
}

// ------------------------------------------------------------------ labelled prompts

export interface SetScore {
  n: number;
  truthTeam: number;
  truthDirect: number;
  answered: Record<TriageKind | 'none', number>;
  /** Share left for stage 2. */
  uncertainShare: number;
  /** Of the confident answers, how many were right. */
  decidedAccuracy: number;
  /** Team-sized tasks answered "direct", as a count and as a share of all team-sized tasks. */
  under: number;
  underRate: number;
  /** Small tasks answered "team", as a count and as a share of all small tasks. */
  over: number;
  overRate: number;
  /** Among tasks rightly answered "team": the level was L3 for an L2 task, or L2 for an L3 task. */
  l2AsL3: number;
  l3AsL2: number;
}

const ratio = (a: number, b: number): number => (b ? Math.round((a / b) * 1000) / 1000 : 0);

/** `uncertainAs`: count an uncertain answer as that kind (what happens with no stage 2: decision 105 says direct). */
export function scoreSet(items: LabelledPrompt[], classify: Classifier, uncertainAs?: 'direct' | 'team'): SetScore {
  const answered: SetScore['answered'] = { direct: 0, team: 0, uncertain: 0, none: 0 };
  let right = 0, decided = 0, under = 0, over = 0, l2AsL3 = 0, l3AsL2 = 0;
  for (const p of items) {
    const a = classify(p);
    let kind: TriageKind | 'none' = a?.kind ?? 'none';
    if (kind === 'uncertain' && uncertainAs) kind = uncertainAs;
    answered[kind]++;
    if (kind !== 'direct' && kind !== 'team') continue;
    decided++;
    if (kind === p.label.kind) right++;
    else if (kind === 'direct') under++;
    else over++;
    if (kind === 'team' && p.label.kind === 'team' && a && a.kind === 'team') {
      if (a.level === 'L3' && p.label.level === 'L2') l2AsL3++;
      if (a.level === 'L2' && p.label.level === 'L3') l3AsL2++;
    }
  }
  const truthTeam = items.filter(p => p.label.kind === 'team').length;
  const truthDirect = items.length - truthTeam;
  return {
    n: items.length, truthTeam, truthDirect, answered,
    uncertainShare: ratio(answered.uncertain + answered.none, items.length),
    decidedAccuracy: ratio(right, decided),
    under, underRate: ratio(under, truthTeam), over, overRate: ratio(over, truthDirect), l2AsL3, l3AsL2,
  };
}

export function scoreBy(items: LabelledPrompt[], classify: Classifier, key: (p: LabelledPrompt) => string, uncertainAs?: 'direct' | 'team'): Record<string, SetScore> {
  const groups = new Map<string, LabelledPrompt[]>();
  for (const p of items) groups.set(key(p), [...(groups.get(key(p)) ?? []), p]);
  return Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, scoreSet(v, classify, uncertainAs)]));
}

/**
 * How well teamScore orders and matches the labels: per bin the mean score and the share of
 * team-sized tasks, and the expected calibration error (0 = the score can be read as a probability).
 */
export function calibration(items: LabelledPrompt[], classify: Classifier, bins = 5): { ece: number; bins: Array<{ lo: number; hi: number; n: number; meanScore: number; teamRate: number }> } {
  const rows = items.map(p => ({ s: classify(p)?.teamScore, y: p.label.kind === 'team' ? 1 : 0 })).filter((r): r is { s: number; y: number } => typeof r.s === 'number');
  const out = [];
  let ece = 0;
  for (let i = 0; i < bins; i++) {
    const lo = i / bins, hi = (i + 1) / bins;
    const inBin = rows.filter(r => r.s >= lo && (i === bins - 1 ? r.s <= hi : r.s < hi));
    if (!inBin.length) continue;
    const meanScore = inBin.reduce((a, r) => a + r.s, 0) / inBin.length;
    const teamRate = inBin.reduce((a, r) => a + r.y, 0) / inBin.length;
    ece += (inBin.length / rows.length) * Math.abs(meanScore - teamRate);
    out.push({ lo, hi, n: inBin.length, meanScore: ratio(meanScore, 1), teamRate: ratio(teamRate, 1) });
  }
  return { ece: ratio(ece, 1), bins: out };
}

// ------------------------------------------------------------------ stage 2 answers

/** One line of a judge run (decision 111): the model's reply for one prompt id. */
export interface JudgeLine { id: string; model?: string; output: unknown; costUsd?: number; ms?: number }

/**
 * The judge's answers by prompt id, read through the score bands (decision 115): an in-between score
 * is an "uncertain" answer. Pass `bands: null` to take the judge's own word instead (for comparison).
 */
export function judgeAnswers(lines: JudgeLine[], bands: JudgeBands | null = JUDGE_BANDS): Map<string, Answer> {
  const out = new Map<string, Answer>();
  for (const l of lines) {
    const v = parseJudgeOutput(l.output);
    if (!v) continue;
    out.set(l.id, bands ? judgeDecision(v, bands) : { kind: v.kind, level: v.level, teamScore: judgeTeamScore(v) });
  }
  return out;
}

/** Stage 1 first; only its uncertain answers go to stage 2. A missing stage-2 answer stays uncertain. */
export function cascade(stage1: Classifier, stage2: Classifier): Classifier {
  return p => {
    const a = stage1(p);
    if (a && a.kind !== 'uncertain') return a;
    return stage2(p) ?? a;
  };
}

// ------------------------------------------------------------------ measured runs and regret

export type Arrangement = 'direct' | 'team-L2' | 'team-L3';
export const ARRANGEMENTS: readonly Arrangement[] = ['direct', 'team-L2', 'team-L3'];

/**
 * One measured run of a task under one arrangement (decision 107). The harness writes one JSON line
 * per run; the fields below are the ones the regret needs, everything else on the line is kept as is.
 */
export interface MeasuredRun {
  taskId: string;
  arrangement: Arrangement;
  passed: boolean;            // hidden tests / SWE-bench grading
  costUsd: number;            // lead + subagents, API prices
  wallSeconds: number;        // from the prompt to the final answer
}

export interface ArrangementStats { n: number; passRate: number; costUsd: number; wallSeconds: number }
export type TaskStats = Record<string, Partial<Record<Arrangement, ArrangementStats>>>;

/** Mean cost, time and pass rate per task and arrangement (several repetitions are averaged). */
export function summariseRuns(runs: MeasuredRun[]): TaskStats {
  const out: TaskStats = {};
  for (const r of runs) {
    const t = (out[r.taskId] ??= {});
    const s = (t[r.arrangement] ??= { n: 0, passRate: 0, costUsd: 0, wallSeconds: 0 });
    s.passRate = (s.passRate * s.n + (r.passed ? 1 : 0)) / (s.n + 1);
    s.costUsd = (s.costUsd * s.n + r.costUsd) / (s.n + 1);
    s.wallSeconds = (s.wallSeconds * s.n + r.wallSeconds) / (s.n + 1);
    s.n++;
  }
  return out;
}

const combined = (s: ArrangementStats, usdPerMinute: number): number => s.costUsd + usdPerMinute * s.wallSeconds / 60;

/**
 * What choosing `a` for the task costs, counting a failed attempt: its own cost plus, for the share of
 * runs that failed, doing the task again with the cheapest arrangement that passes. When nothing
 * passes there is no redo to charge, so failures compare by their own cost.
 */
export function effectiveCost(task: Partial<Record<Arrangement, ArrangementStats>>, a: Arrangement, usdPerMinute: number): number | undefined {
  const s = task[a];
  if (!s) return undefined;
  const passing = ARRANGEMENTS.map(x => task[x]).filter((x): x is ArrangementStats => !!x && x.passRate > 0);
  const redo = passing.length ? Math.min(...passing.map(x => combined(x, usdPerMinute))) : 0;
  return combined(s, usdPerMinute) + (1 - s.passRate) * redo;
}

/** The arrangement with the lowest effective cost: the measured answer to "what did this task need". */
export function bestArrangement(task: Partial<Record<Arrangement, ArrangementStats>>, usdPerMinute: number): Arrangement | undefined {
  let best: Arrangement | undefined;
  let bestCost = Infinity;
  for (const a of ARRANGEMENTS) {
    const c = effectiveCost(task, a, usdPerMinute);
    if (c !== undefined && c < bestCost) { best = a; bestCost = c; }
  }
  return best;
}

export const arrangementOf = (a: Answer | undefined, uncertainAs: Arrangement = 'direct'): Arrangement =>
  !a || a.kind === 'uncertain' ? uncertainAs : a.kind === 'direct' ? 'direct' : a.level === 'L3' ? 'team-L3' : 'team-L2';

export interface RegretRow { policy: string; tasks: number; meanCost: number; meanRegret: number; worstRegret: number; matchesBest: number }

/**
 * Mean effective cost and regret of each policy over the measured tasks. A policy names an
 * arrangement per task; tasks where its arrangement was not measured are left out of its row.
 */
export function regretTable(stats: TaskStats, policies: Record<string, (taskId: string) => Arrangement>, usdPerMinute: number): RegretRow[] {
  const rows: RegretRow[] = [];
  for (const [name, choose] of Object.entries(policies)) {
    let n = 0, cost = 0, regret = 0, worst = 0, match = 0;
    for (const [taskId, task] of Object.entries(stats)) {
      const a = choose(taskId);
      const c = effectiveCost(task, a, usdPerMinute);
      const best = bestArrangement(task, usdPerMinute);
      if (c === undefined || best === undefined) continue;
      const r = c - effectiveCost(task, best, usdPerMinute)!;
      n++; cost += c; regret += r; worst = Math.max(worst, r);
      if (a === best) match++;
    }
    rows.push({ policy: name, tasks: n, meanCost: ratio(cost, n), meanRegret: ratio(regret, n), worstRegret: ratio(worst, 1), matchesBest: match });
  }
  return rows;
}
