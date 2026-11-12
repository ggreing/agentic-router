// Triage evaluation runner (decisions 106-111). Run from source, no model calls:
//
//   node packages/core/src/triage-eval-cli.ts set [--judge <out.jsonl>] [--bench <bench dir>]
//       stage 1 on the 60 labelled prompts (and the bench tasks); with --judge also stage 2 (score bands, decision 115) and the cascade
//   node packages/core/src/triage-eval-cli.ts lang <ja|zh> [--bench <bench dir>]
//       stage 1 on the translated prompt set (prompts.<lang>.yaml, and bench.<lang>.yaml with --bench) and how its
//       answers compare with the answers on the originals, prompt by prompt (decision 139)
//   node packages/core/src/triage-eval-cli.ts swebench <verified.json> [--judge <out.jsonl>]
//       stage 1 on SWE-bench Verified with change-size proxy labels (a population that is mostly "direct")
//   node packages/core/src/triage-eval-cli.ts judge-input --out <dir> [--bench <bench dir>] [--swebench <verified.json>] [--sample 100]
//       writes the stage-2 inputs for an offline run: judge-input.jsonl, judge-system.txt, judge-schema.json, judge-items.jsonl
//   node packages/core/src/triage-eval-cli.ts judge-score --items <judge-items.jsonl> --judge <out.jsonl>
//       scores a judge run made from those inputs
//   node packages/core/src/triage-eval-cli.ts regret <runs.jsonl> --tasks <tasks.jsonl> [--judge <out.jsonl>]
//       regret of each policy on measured runs (decision 107); tasks.jsonl has { taskId, prompt, level? } per line
//
// A judge run is one JSON line per prompt: { "id": ..., "model": ..., "output": <the reply, text or object>, "costUsd"?, "ms"? }.
// A measured run is one JSON line per run: { "taskId", "arrangement": "direct"|"team-L2"|"team-L3", "passed", "costUsd", "wallSeconds", ... }.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ARRANGEMENTS, arrangementOf, bestArrangement, calibration, cascade, judgeAnswers, languageAgreement, loadPromptSet, regretTable, scoreBy, scoreSet, summariseRuns,
  type Answer, type Arrangement, type Classifier, type JudgeLine, type LabelledPrompt, type MeasuredRun, type SetScore,
} from './triage-eval.ts';
import { JUDGE_EFFORT, JUDGE_MODEL, JUDGE_SCHEMA, JUDGE_SYSTEM, buildJudgeRequest } from './triage-judge.ts';
import { triage } from './triage.ts';
import type { Level } from './types.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS = path.join(HERE, '..', 'test', 'fixtures', 'triage', 'prompts.yaml');

const readJsonl = <T>(file: string): T[] => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l) as T);
const stage1: Classifier = p => { const t = triage({ prompt: p.prompt }); return { kind: t.kind, level: t.level, teamScore: t.teamScore }; };
const fromMap = (m: Map<string, Answer>): Classifier => p => m.get(p.id);

function flags(argv: string[]): { pos: string[]; opt: Record<string, string> } {
  const pos: string[] = [];
  const opt: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) { opt[a.slice(2)] = argv[i + 1] ?? ''; i++; } else pos.push(a);
  }
  return { pos, opt };
}

// ------------------------------------------------------------------ sources

/** The bench's own tasks: the authored level is the label (L2 and above = team). */
function benchTasks(benchDir: string): LabelledPrompt[] {
  const dir = path.join(benchDir, 'tasks', 'custom');
  const out: LabelledPrompt[] = [];
  for (const d of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, d, 'task.json');
    if (!fs.existsSync(file)) continue;
    const t = JSON.parse(fs.readFileSync(file, 'utf8')) as { id: string; level: Level; prompt: string };
    out.push({ id: t.id, task: t.id, lang: 'ko', style: 'task', split: 'bench', label: { kind: t.level === 'L2' || t.level === 'L3' ? 'team' : 'direct', level: t.level }, prompt: t.prompt });
  }
  return out;
}

interface SweRow { instance_id: string; problem_statement: string; patch: string; difficulty: string }
const DIFFICULTY: Record<string, number> = { '<15 min fix': 0, '15 min - 1 hour': 1, '1-4 hours': 2, '>4 hours': 3 };

/** SWE-bench Verified with a change-size proxy label: team = 3+ files, or 60+ changed lines, or annotated as 1 hour or more. */
function sweBench(file: string): LabelledPrompt[] {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  const rows = (Array.isArray(raw) ? raw : Object.values(raw as object)).map(r => ((r as { row?: SweRow }).row ?? r) as SweRow);
  return rows.map(r => {
    const files = (r.patch.match(/^diff --git /gm) ?? []).length;
    const lines = r.patch.split('\n').filter(l => (l.startsWith('+') && !l.startsWith('+++')) || (l.startsWith('-') && !l.startsWith('---'))).length;
    const team = files >= 3 || lines >= 60 || (DIFFICULTY[r.difficulty] ?? 0) >= 2;
    return { id: r.instance_id, task: r.instance_id, lang: 'en', style: 'issue', split: 'swebench', label: { kind: team ? 'team' : 'direct', level: team ? 'L2' : 'L1', files }, prompt: r.problem_statement };
  });
}

/** A fixed sample: the order comes from a hash of the id, and team-sized issues are over-sampled to about a third. */
function sample(items: LabelledPrompt[], n: number): LabelledPrompt[] {
  const order = (p: LabelledPrompt) => createHash('sha1').update(p.id).digest('hex');
  const sorted = [...items].sort((a, b) => order(a).localeCompare(order(b)));
  const team = sorted.filter(p => p.label.kind === 'team').slice(0, Math.round(n / 3));
  const small = sorted.filter(p => p.label.kind === 'direct').slice(0, n - team.length);
  return [...team, ...small].sort((a, b) => a.id.localeCompare(b.id));
}

// ------------------------------------------------------------------ printing

const pct = (x: number) => `${(100 * x).toFixed(0)}%`.padStart(4);
function row(name: string, s: SetScore): string {
  return `${name.padEnd(34)} n=${String(s.n).padStart(3)}  direct ${String(s.answered.direct).padStart(3)}  team ${String(s.answered.team).padStart(3)}  uncertain ${String(s.answered.uncertain + s.answered.none).padStart(3)} (${pct(s.uncertainShare)})`
    + `  right of decided ${pct(s.decidedAccuracy)}  under ${String(s.under).padStart(2)}/${s.truthTeam} (${pct(s.underRate)})  over ${String(s.over).padStart(2)}/${s.truthDirect} (${pct(s.overRate)})`
    + (s.l2AsL3 + s.l3AsL2 ? `  L2 as L3 ${s.l2AsL3}, L3 as L2 ${s.l3AsL2}` : '');
}

function report(title: string, items: LabelledPrompt[], judge?: Map<string, Answer>, word?: Map<string, Answer>): void {
  console.log(`\n== ${title} (${items.length} prompts; under = team-sized answered direct, over = small answered team)`);
  const variants: Array<[string, Classifier, ('direct' | 'team')?]> = [
    ['stage 1', stage1],
    ['stage 1, uncertain as direct', stage1, 'direct'],
    ['always direct', () => ({ kind: 'direct', level: 'L1' })],
  ];
  if (judge) {
    const j = fromMap(judge);
    variants.push(['judge alone, score bands', j], ['stage 1 + judge bands', cascade(stage1, j)], ['stage 1 + judge bands, open as direct', cascade(stage1, j), 'direct']);
    if (word) variants.push(["stage 1 + judge's own word", cascade(stage1, fromMap(word)), 'direct']);
  }
  for (const [name, c, as] of variants) console.log(row(name, scoreSet(items, c, as)));
  for (const key of ['style', 'lang', 'split'] as const) {
    const groups = scoreBy(items, stage1, p => p[key]);
    if (Object.keys(groups).length < 2) continue;
    console.log(`  stage 1 by ${key}:`);
    for (const [k, s] of Object.entries(groups)) console.log('  ' + row(`  ${k}`, s));
    if (judge) for (const [k, s] of Object.entries(scoreBy(items, cascade(stage1, fromMap(judge)), p => p[key], 'direct'))) console.log('  ' + row(`  ${k} (+ judge)`, s));
  }
  const cal = calibration(items, stage1);
  console.log(`  teamScore vs label: calibration error ${cal.ece}; ` + cal.bins.map(b => `[${b.lo.toFixed(1)}-${b.hi.toFixed(1)}] n=${b.n} team ${pct(b.teamRate).trim()}`).join(', '));
  const wrong = items.filter(p => { const a = stage1(p); return a && a.kind !== 'uncertain' && a.kind !== p.label.kind; });
  if (wrong.length && wrong.length <= 25) console.log('  confident and wrong: ' + wrong.map(p => `${p.id} (${triage({ prompt: p.prompt }).rule})`).join(', '));
}

// ------------------------------------------------------------------ commands

const [cmd, ...rest] = process.argv.slice(2);
const { pos, opt } = flags(rest);
// Decision 115: the judge's score is read in three bands; its own direct/team word is kept for comparison.
const judge = opt.judge ? judgeAnswers(readJsonl<JudgeLine>(opt.judge)) : undefined;
const judgeWord = opt.judge ? judgeAnswers(readJsonl<JudgeLine>(opt.judge), null) : undefined;

if (cmd === 'set') {
  report('authored prompt set', loadPromptSet(fs.readFileSync(opt.prompts || PROMPTS, 'utf8')), judge, judgeWord);
  if (opt.bench) report('bench tasks', benchTasks(opt.bench), judge, judgeWord);
} else if (cmd === 'lang' && pos[0]) {
  const lang = pos[0];
  const fixture = (name: string) => path.join(path.dirname(PROMPTS), name);
  const compare = (title: string, original: LabelledPrompt[], file: string): void => {
    if (!fs.existsSync(file)) { console.log(`\n== ${title}: no ${path.basename(file)}`); return; }
    const translated = loadPromptSet(fs.readFileSync(file, 'utf8'));
    console.log(`\n== ${title} in ${lang} (${translated.length} prompts)`);
    console.log(row('original', scoreSet(original, stage1)));
    console.log(row(lang, scoreSet(translated, stage1)));
    const a = languageAgreement(original, translated, stage1);
    console.log(`  same answer and level ${a.same}/${a.n} (${Math.round((a.same / (a.n || 1)) * 100)}%), same answer ${a.sameKind}/${a.n}; team-sized answered direct ${a.falseDirect} (new ${a.newFalseDirect}); small answered team ${a.falseTeam} (new ${a.newFalseTeam})`);
    for (const c of a.changes) console.log(`    ${c.id.padEnd(12)} label ${c.label.kind}/${c.label.level}  ${c.from} -> ${c.to}`);
    if (a.missing.length) console.log(`  not compared: ${a.missing.join(', ')}`);
  };
  compare('authored prompt set', loadPromptSet(fs.readFileSync(PROMPTS, 'utf8')), fixture(`prompts.${lang}.yaml`));
  if (opt.bench) compare('bench tasks', benchTasks(opt.bench), fixture(`bench.${lang}.yaml`));
} else if (cmd === 'swebench' && pos[0]) {
  report('SWE-bench Verified, proxy labels', sweBench(pos[0]), judge, judgeWord);
} else if (cmd === 'judge-input' && opt.out) {
  // The bench's public tasks are SWE-bench issues: they keep their bench id and authored level, and stay out of the sample.
  const swe = opt.swebench ? sweBench(opt.swebench) : [];
  const manifestFile = opt.bench ? path.join(opt.bench, 'tasks', 'public', 'manifest.json') : '';
  const manifest = manifestFile && fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as { tasks?: Array<{ id: string; level: Level; instance_id: string }> } | Array<{ id: string; level: Level; instance_id: string }> : [];
  const publicTasks = (Array.isArray(manifest) ? manifest : manifest.tasks ?? []).flatMap(t => {
    const issue = swe.find(p => p.id === t.instance_id);
    return issue ? [{ ...issue, id: t.id, task: t.id, style: 'task', split: 'bench', label: { ...issue.label, kind: 'team' as const, level: t.level } }] : [];
  });
  const taken = new Set(publicTasks.map(p => p.prompt));
  const items = [
    ...loadPromptSet(fs.readFileSync(opt.prompts || PROMPTS, 'utf8')),
    ...(opt.bench ? benchTasks(opt.bench) : []),
    ...publicTasks,
    ...sample(swe.filter(p => !taken.has(p.prompt)), swe.length ? Number(opt.sample) || 100 : 0),
  ];
  fs.mkdirSync(opt.out, { recursive: true });
  const jsonl = (rows: unknown[]) => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(opt.out, 'judge-input.jsonl'), jsonl(items.map(p => ({ id: p.id, user: buildJudgeRequest(p.prompt).user }))));
  fs.writeFileSync(path.join(opt.out, 'judge-items.jsonl'), jsonl(items.map(({ prompt: _prompt, ...meta }) => ({ ...meta, stage1: stage1({ ...meta, prompt: _prompt }) }))));
  fs.writeFileSync(path.join(opt.out, 'judge-system.txt'), JUDGE_SYSTEM + '\n');
  fs.writeFileSync(path.join(opt.out, 'judge-schema.json'), JSON.stringify(JUDGE_SCHEMA, null, 2) + '\n');
  const chars = items.reduce((a, p) => a + p.prompt.length, 0);
  console.log(`${items.length} prompts written to ${opt.out} (${chars} characters of requests; default model ${JUDGE_MODEL}, effort ${JUDGE_EFFORT})`);
} else if (cmd === 'judge-score' && opt.items && judge) {
  // Scores from the items file alone: it carries the labels and the stage-1 answer, not the prompt text.
  const items = readJsonl<Omit<LabelledPrompt, 'prompt'> & { stage1: Answer }>(opt.items);
  const s1: Classifier = p => (p as unknown as { stage1: Answer }).stage1;
  const j = fromMap(judge);
  const groups = new Map<string, LabelledPrompt[]>();
  for (const it of items) groups.set(it.split, [...(groups.get(it.split) ?? []), { ...it, prompt: '' }]);
  for (const [split, list] of [['all', items.map(it => ({ ...it, prompt: '' }))] as [string, LabelledPrompt[]], ...groups]) {
    console.log(`\n== ${split} (${list.length} prompts, ${list.filter(p => judge.has(p.id)).length} with a judge answer)`);
    console.log(row('stage 1', scoreSet(list, s1)));
    console.log(row('stage 1, uncertain as direct', scoreSet(list, s1, 'direct')));
    console.log(row('judge alone, score bands', scoreSet(list, j)));
    console.log(row('stage 1 + judge bands', scoreSet(list, cascade(s1, j))));
    console.log(row('stage 1 + judge bands, open as direct', scoreSet(list, cascade(s1, j), 'direct')));
    console.log(row("stage 1 + judge's own word", scoreSet(list, cascade(s1, fromMap(judgeWord!)), 'direct')));
    for (const [k, s] of Object.entries(scoreBy(list, j, p => p.style))) console.log('  ' + row(`  judge, ${k}`, s));
  }
  const lines = readJsonl<JudgeLine>(opt.judge!);
  const cost = lines.reduce((a, l) => a + (l.costUsd ?? 0), 0);
  const ms = lines.map(l => l.ms).filter((x): x is number => typeof x === 'number').sort((a, b) => a - b);
  console.log(`\njudge run: ${lines.length} replies, ${lines.length - judge.size} unreadable, total $${cost.toFixed(4)}${ms.length ? `, latency p50 ${ms[Math.floor(ms.length / 2)]} ms, p90 ${ms[Math.floor(ms.length * 0.9)]} ms` : ''}`);
} else if (cmd === 'regret' && pos[0] && opt.tasks) {
  const stats = summariseRuns(readJsonl<MeasuredRun>(pos[0]));
  const taskRows = readJsonl<{ taskId: string; prompt: string; level?: Level }>(opt.tasks);
  const prompts = new Map(taskRows.map(t => [t.taskId, t.prompt]));
  const levels = new Map(taskRows.flatMap(t => (t.level ? [[t.taskId, t.level] as [string, Level]] : [])));
  const answer = (c: Classifier, uncertainAs: Arrangement = 'direct') => (taskId: string): Arrangement => {
    const prompt = prompts.get(taskId);
    return arrangementOf(prompt === undefined ? undefined : c({ id: taskId, task: taskId, lang: '', style: 'task', split: 'measured', label: { kind: 'direct', level: 'L1' }, prompt }), uncertainAs);
  };
  // The level the task was authored at, mapped the way the presets map it: what a triage that always got the size right would choose.
  const byLevel = (l3: Arrangement) => (taskId: string): Arrangement => {
    const level = levels.get(taskId);
    return level === 'L3' ? l3 : level === 'L2' ? 'team-L2' : 'direct';
  };
  const policies: Record<string, (taskId: string) => Arrangement> = {
    'always direct': () => 'direct', 'always team-L2': () => 'team-L2', 'always team-L3': () => 'team-L3',
    ...(levels.size ? { 'authored level (L0, L1 direct)': byLevel('team-L3'), 'authored level, L3 as team-L2': byLevel('team-L2') } : {}),
    'stage 1, uncertain as direct': answer(stage1),
    ...(judge ? {
      'stage 1 + judge bands, open as direct': answer(cascade(stage1, fromMap(judge))),
      'stage 1 + judge bands, open as team-L2': answer(cascade(stage1, fromMap(judge)), 'team-L2'),
      "stage 1 + judge's own word": answer(cascade(stage1, fromMap(judgeWord!))),
    } : {}),
  };
  // A task no arrangement passed has no working answer to compare with (its failures compare by their own cost), so it also gets a table without it.
  const unsolved = Object.entries(stats).filter(([, s]) => !ARRANGEMENTS.some(a => (s[a]?.passRate ?? 0) > 0)).map(([t]) => t);
  const solved = Object.fromEntries(Object.entries(stats).filter(([t]) => !unsolved.includes(t)));
  const sets: Array<[string, typeof stats]> = unsolved.length ? [['all tasks', stats], ['tasks at least one arrangement passed', solved]] : [['all tasks', stats]];
  for (const usdPerMinute of [0, 0.1]) {
    for (const [title, set] of sets) {
      console.log(`\n== regret per request, time valued at $${usdPerMinute.toFixed(2)} per minute (decision 108), ${title}`);
      console.log('policy'.padEnd(40) + 'tasks  mean cost  mean regret  worst regret  picks the best');
      for (const r of regretTable(set, { ...policies, 'measured best (lower bound)': t => bestArrangement(set[t]!, usdPerMinute) ?? 'direct' }, usdPerMinute)) {
        console.log(`${r.policy.padEnd(40)}${String(r.tasks).padStart(5)}  ${r.meanCost.toFixed(3).padStart(9)}  ${r.meanRegret.toFixed(3).padStart(11)}  ${r.worstRegret.toFixed(3).padStart(12)}  ${r.matchesBest}/${r.tasks}`);
      }
    }
    console.log('  best arrangement per task: ' + Object.entries(stats).map(([t, s]) => `${t}=${bestArrangement(s, usdPerMinute)}`).join(', '));
  }
  if (unsolved.length) console.log(`\nno arrangement passed: ${unsolved.join(', ')}`);
  console.log('\nper task (cost USD / seconds / pass rate):');
  for (const [t, s] of Object.entries(stats)) console.log(`  ${t.padEnd(34)} ` + ARRANGEMENTS.map(a => (s[a] ? `${a} ${s[a].costUsd.toFixed(3)}/${Math.round(s[a].wallSeconds)}/${s[a].passRate.toFixed(2)}` : `${a} -`)).join('   '));
} else {
  console.log('usage: triage-eval-cli.ts set | swebench <verified.json> | judge-input --out <dir> | judge-score --items <file> --judge <file> | regret <runs.jsonl> --tasks <tasks.jsonl>   (see the header of this file)');
  process.exitCode = cmd ? 2 : 0;
}
