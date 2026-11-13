// Decision 107: direct vs L2 team vs L3 team on the same tasks, lead Opus 5.5, API key, own $50 budget.
// Output: bench/results/measure107/{runs.jsonl,tasks.jsonl,ledger.jsonl}
// in the format the triage scorer reads (packages/core/src/triage-eval-cli.ts regret runs.jsonl --tasks tasks.jsonl).
//
//   node scripts/measure107.ts --api-key-helper "<keychain cmd>" [--tasks id,id] [--arrangements direct,team-L2,team-L3,auto]
//        [--lead opus] [--effort high] [--budget 50] [--cap-scale 1] [--out dir] [--dry-run] [--setup-only] [--only-plan]
//
// - direct   : plain Claude Code, no plugin (the lead does the work alone) = router OFF
// - team-L2/3: plugin + daemon with config.forceLevel = L2 / L3 (decision 107 harness switch)
// - auto     : plugin + daemon as a user runs it (Phase-3 KPI): automatic triage, the lead's own choice of roles,
//              the default budgets and step rules, no forced level; holdoutRate 0 so no request is held out.
// --dry-run prints the plan and a cost and time estimate from the earlier measurements of the same lead
// (bench/results/measure107-sonnet for Sonnet, decision 123; measure107 for Opus, decision 107) and exits:
// no workspace, no daemon, no API call. --setup-only prepares the workspaces and starts the daemons, no API call.
// Auth: isolated CLAUDE_CONFIG_DIR + apiKeyHelper via --settings (the key never passes through this script).
// No --bare in team runs: hooks must run. Transcripts are kept (the daemon reads them for costs).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { prepare } from '../bench/src/workspace.ts';
import { loadTasks } from '../bench/src/tasks.ts';
import { gradeNodeTest } from '../bench/src/graders/node-test.ts';
import { gradeSwebench, workspacePatch } from '../bench/src/graders/swebench.ts';
import { childEnv, CREDENTIAL_DENY } from '../bench/src/secrets.ts';
import { loadPublicManifest } from '../bench/src/tasks.ts';
import type { Task } from '../bench/src/types.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[i + 1]! : d; };
// --out for smoke tests, so their spend does not enter the decision-107 ledger
const OUT = path.resolve(arg('out', path.join(ROOT, 'bench', 'results', 'measure107'))!);
const WORK = path.join(path.parse(ROOT).root, 'ar-m107');            // short path: Windows MAX_PATH with worktrees
const flag = (k: string) => argv.includes(`--${k}`);

const DEFAULT_TASKS = [
  'c-l1-01', 'c-l1-02', 'c-l1-03', 'c-l1-04', 'c-l1-05',
  'c-l2-01', 'c-l2-02', 'c-l2-03', 'p-l2-astropy__astropy-7671', 'p-l2-pydata__xarray-4966',
  // L3: 3 public (widest by gold-patch file count) + 2 custom broad tasks (decision 114)
  'c-l3-01', 'c-l3-02', 'p-l3-sympy__sympy-16597', 'p-l3-django__django-16263', 'p-l3-pylint-dev__pylint-4551',
];
const taskIds = (arg('tasks') ?? [...DEFAULT_TASKS, ...(arg('public-l3') ?? '').split(',').filter(Boolean)].join(',')).split(',').filter(Boolean);
const arrangements = (arg('arrangements') ?? 'direct,team-L2,team-L3').split(',') as Arrangement[];
const LEAD = arg('lead', 'opus')!;
const EFFORT = arg('effort', 'high')!;
const BUDGET = Number(arg('budget', '50'));
const HELPER = arg('api-key-helper');
// --cap-scale shrinks the per-run caps (and so the budget-stop threshold) for a cheaper lead model
const CAP_SCALE = Number(arg('cap-scale', '1'));
const CAP: Record<string, number> = Object.fromEntries(Object.entries({ L1: 2, L2: 5, L3: 10 }).map(([k, v]) => [k, v * CAP_SCALE]));
type Arrangement = 'direct' | 'team-L2' | 'team-L3' | 'auto';
const KNOWN: Arrangement[] = ['direct', 'team-L2', 'team-L3', 'auto'];
const unknownArr = arrangements.filter(a => !KNOWN.includes(a));
if (unknownArr.length) { console.error(`unknown arrangements: ${unknownArr.join(', ')} (known: ${KNOWN.join(', ')})`); process.exit(2); }

fs.mkdirSync(OUT, { recursive: true });
const ledgerFile = path.join(OUT, 'ledger.jsonl');
const runsFile = path.join(OUT, 'runs.jsonl');
const spent = () => fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean).reduce((a, l) => a + Number(JSON.parse(l).costUsd || 0), 0) : 0;
const doneKeys = new Set(fs.existsSync(runsFile) ? fs.readFileSync(runsFile, 'utf8').split('\n').filter(Boolean).map(l => { const j = JSON.parse(l); return `${j.taskId}|${j.arrangement}`; }) : []);

const tasks = loadTasks({ ids: taskIds });
const missing = taskIds.filter(id => !tasks.some(t => t.id === id));
if (missing.length) { console.error(`unknown tasks: ${missing.join(', ')}`); process.exit(2); }

// Run order: direct and team-L2 for every task first, then team-L3 for L3, L2, L1 tasks,
// so a budget stop drops the least informative cells.
const order: Array<[Task, Arrangement]> = [];
for (const t of tasks) for (const a of arrangements.filter(a => a !== 'team-L3')) order.push([t, a]);
if (arrangements.includes('team-L3')) for (const lv of ['L3', 'L2', 'L1']) for (const t of tasks.filter(t => t.level === lv)) order.push([t, 'team-L3']);

console.log(`plan: ${order.length} runs, lead ${LEAD}/${EFFORT}, budget $${BUDGET} (spent so far $${spent().toFixed(2)}), out ${OUT}`);
for (const [t, a] of order) console.log(`  ${t.id.padEnd(32)} ${t.level} ${a.padEnd(8)} cap $${CAP[t.level]}${doneKeys.has(`${t.id}|${a}`) ? '  (done)' : ''}`);
if (flag('only-plan')) process.exit(0);
if (flag('dry-run')) { printEstimate(); process.exit(0); }
fs.writeFileSync(path.join(OUT, 'tasks.jsonl'), '');      // rewritten with prompts as workspaces are prepared
if (!HELPER && !flag('setup-only')) { console.error('pass --api-key-helper "<command>" (keychain helper)'); process.exit(2); }

// AGENTIC_ROUTER_HOME (the previous release) is left out: with it, init would move that folder into the temp home
const { AGENTIC_ROUTER_HOME: _previousHome, ...inherited } = process.env;
const cli = (home: string, ...a: string[]) => execFileSync(process.execPath, [path.join(ROOT, 'packages/cli/src/index.ts'), ...a],
  { env: { ...inherited, DO_IT_ALL_CLAUDE_CODE_HOME: home }, encoding: 'utf8' });
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 });

function settingsFor(): string {
  return JSON.stringify({ apiKeyHelper: HELPER, permissions: { deny: CREDENTIAL_DENY } });
}

function runClaude(repo: string, configDir: string, prompt: string, a: Arrangement, capUsd: number, timeoutSec: number, home?: string)
  : Promise<{ code: number | null; out: any; ms: number; timedOut: boolean; stderr: string }> {
  const args = ['-p', '--output-format', 'json', '--model', LEAD, '--effort', EFFORT, '--max-budget-usd', String(capUsd),
    '--permission-mode', 'acceptEdits', '--strict-mcp-config', '--setting-sources', 'project,local', '--settings', settingsFor(),
    '--tools', a === 'direct' ? 'Read,Edit,Write,Glob,Grep,Bash' : 'Read,Edit,Write,Glob,Grep,Bash,Agent',
    '--allowedTools', 'Agent', 'Bash(npm *)', 'Bash(node *)', 'Bash(npx tsc *)', 'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)',
    'Bash(git show*)', 'Bash(git add*)', 'Bash(git commit*)', 'Bash(git merge*)', 'Bash(git worktree*)', 'Bash(git branch*)',
    'Bash(ls *)', 'Bash(cat *)', 'Bash(head *)', 'Bash(tail *)', 'Bash(grep *)', 'Bash(cd *)', 'Bash(python *)', 'Bash(pytest *)'];
  if (a !== 'direct') {
    args.splice(1, 0, '--plugin-dir', path.join(ROOT, 'plugin'));
    // -p ends the session when the lead's turn ends; in the first measurement one lead ended 2 s after
    // launching a background worker, which was then cut off. Interactive sessions do not have this problem.
    args.push('--append-system-prompt', 'This is a non-interactive run: before you give your final answer, wait until every subagent you started has finished and you have read its result.');
  }
  const env = { ...childEnv(configDir, { kind: 'api-key-helper' } as never), ...(home ? { DO_IT_ALL_CLAUDE_CODE_HOME: home } : {}) };
  return new Promise(resolve => {
    const t0 = Date.now();
    const p = spawn('claude', args, { cwd: repo, env, windowsHide: true });
    let so = '', se = '', timedOut = false;
    p.stdout.on('data', d => { so += d; }); p.stderr.on('data', d => { se += d; });
    const timer = setTimeout(() => { timedOut = true; p.kill(); }, timeoutSec * 1000);
    p.on('close', code => { clearTimeout(timer); let out: any = null; try { out = JSON.parse(so); } catch { out = null; } resolve({ code, out, ms: Date.now() - t0, timedOut, stderr: se.slice(-1500) }); });
    p.stdin.end(prompt);
  });
}

function diffStats(repo: string, base: string) {
  const ns = git(repo, 'diff', '--numstat', base, '--', '.', ':(exclude).claude', ':(exclude).bench-hidden').trim().split('\n').filter(Boolean);
  const untracked = git(repo, 'ls-files', '--others', '--exclude-standard').trim().split('\n').filter(Boolean)
    .filter(f => !f.startsWith('.claude/') && !f.startsWith('.bench-hidden/'));
  let added = 0, removed = 0; const files = new Set<string>();
  for (const l of ns) { const [a, r, f] = l.split('\t'); added += Number(a) || 0; removed += Number(r) || 0; files.add(f!); }
  for (const f of untracked) { files.add(f); try { added += fs.readFileSync(path.join(repo, f), 'utf8').split('\n').length; } catch { /* binary */ } }
  const dirs = new Set([...files].map(f => path.posix.dirname(f.replace(/\\/g, '/'))));
  return { changedFiles: files.size, changedDirs: dirs.size, linesAdded: added, linesRemoved: removed };
}

function routerFacts(home: string) {
  const dbFile = path.join(home, 'router.db');
  if (!fs.existsSync(dbFile)) return {};
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const q = (sql: string) => { try { return db.prepare(sql).all() as any[]; } catch { return []; } };
  const reqs = q('SELECT * FROM requests');
  const subs = q('SELECT * FROM subtasks');
  const costs = q('SELECT * FROM costs');
  const records = q('SELECT * FROM request_records');
  db.close();
  const sum = (rows: any[]) => rows.reduce((a, r) => a + (Number(r.usd) || 0), 0);
  return {
    costLeadUsd: sum(costs.filter(c => c.source === 'lead')) || undefined,
    costSubagentsUsd: sum(costs.filter(c => c.source !== 'lead' && c.source !== 'agent_result')),
    subtasks: subs.map(s => ({ role: s.role, step: s.step, verdict: s.verdict, status: s.status, attempts: s.attempts,
      costUsd: sum(costs.filter(c => c.agent_id === s.agent_id && c.source !== 'agent_result')) })),
    replanned: reqs.some(r => r.replanned_from),
    requests: reqs.map(r => ({ level: r.level, preset: r.preset, outcome: r.outcome, forced_from: r.forced_from, replanned_from: r.replanned_from, lead_class: r.lead_class, lead_edits: r.lead_edits })),
    records: records.length,
    // Phase-3 KPI fields, from the run's first request (a bench task is one request)
    levelChosen: reqs[0]?.level ?? null,
    triageSource: (() => { try { return JSON.parse(String(reqs[0]?.triage)).source ?? null; } catch { return null; } })(),
    leadClass: reqs[0]?.lead_class ?? null,
    outcome: reqs[0]?.outcome ?? null,                                   // delegated | direct | no_delegation | lead_takeover
    leadEdits: Number(reqs[0]?.lead_edits ?? 0),                         // decision 145: the lead's own edits after delegating
    noChanges: subs.filter(s => s.verdict === 'no_changes').length,      // decision 145: writers that changed nothing
  };
}

/**
 * --dry-run: each planned cell priced from the earlier measurement with the same lead model (Sonnet: decision
 * 123; Opus: decision 107). `auto` has no earlier run of its own: it is priced as team-L2, the closest measured
 * arrangement (auto plans an L1 request with one coder, so for L1 that is an upper bound). A cell without a
 * measurement takes the level's average for its arrangement.
 */
function printEstimate(): void {
  const priorFile = path.join(ROOT, 'bench', 'results', LEAD === 'opus' ? 'measure107' : 'measure107-sonnet', 'runs.jsonl');
  const prior = fs.existsSync(priorFile) ? fs.readFileSync(priorFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { taskId: string; arrangement: string; level: string; costUsd: number; wallSeconds: number }) : [];
  const basisOf = (a: Arrangement) => (a === 'auto' ? 'team-L2' : a);
  const levelAvg = (level: string, a: string) => {
    const rs = prior.filter(r => r.level === level && r.arrangement === a);
    return rs.length ? { usd: rs.reduce((s, r) => s + Number(r.costUsd), 0) / rs.length, sec: rs.reduce((s, r) => s + Number(r.wallSeconds), 0) / rs.length } : { usd: CAP[level]! / 4, sec: 300 };
  };
  const totals: Record<string, { usd: number; sec: number; n: number }> = {};
  console.log(`\nestimate from ${path.relative(ROOT, priorFile)} (lead ${LEAD}${LEAD === 'opus' || LEAD === 'sonnet' ? '' : ': no measurement of this lead, Sonnet numbers used'}):`);
  for (const [t, a] of order) {
    if (doneKeys.has(`${t.id}|${a}`)) continue;
    const basis = basisOf(a);
    const hit = prior.find(r => r.taskId === t.id && r.arrangement === basis);
    const e = hit ? { usd: Number(hit.costUsd), sec: Number(hit.wallSeconds) } : levelAvg(t.level, basis);
    const tot = (totals[a] ??= { usd: 0, sec: 0, n: 0 });
    tot.usd += e.usd; tot.sec += e.sec; tot.n++;
    console.log(`  ${t.id.padEnd(32)} ${t.level} ${a.padEnd(8)} ~$${e.usd.toFixed(2).padStart(5)} ~${String(Math.round(e.sec)).padStart(4)} s  (${hit ? `measured ${basis}` : `${t.level} average of ${basis}`})`);
  }
  const all = Object.values(totals).reduce((s, x) => ({ usd: s.usd + x.usd, sec: s.sec + x.sec, n: s.n + x.n }), { usd: 0, sec: 0, n: 0 });
  for (const [a, x] of Object.entries(totals)) console.log(`  ${a.padEnd(8)} ${String(x.n).padStart(2)} runs  ~$${x.usd.toFixed(2)}  ~${(x.sec / 60).toFixed(0)} min`);
  console.log(`  total    ${String(all.n).padStart(2)} runs  ~$${all.usd.toFixed(2)}  ~${(all.sec / 60).toFixed(0)} min run time (sequential, plus grading)`);
  console.log(`  suggested --budget ${Math.ceil(all.usd * 1.5)} (one run per cell varies; the per-run caps stop a runaway: ${Object.entries(CAP).map(([k, v]) => `${k} $${v}`).join(', ')})`);
}

const manifest = loadPublicManifest();
for (const [task, a] of order) {
  const key = `${task.id}|${a}`;
  if (doneKeys.has(key)) continue;
  const remaining = BUDGET - spent();
  const cap = Math.min(CAP[task.level]!, remaining);
  if (cap < CAP[task.level]! / 2) { console.log(`budget stop before ${key}: $${remaining.toFixed(2)} left`); fs.appendFileSync(runsFile, JSON.stringify({ taskId: task.id, arrangement: a, level: task.level, budgetStop: true, passed: false, costUsd: 0, wallSeconds: 0 }) + '\n'); continue; }
  const root = path.join(WORK, `${task.id.slice(0, 40)}-${a}`.replace(/[^A-Za-z0-9_.-]/g, '_'));
  const ws = await prepare(task, root);
  fs.appendFileSync(path.join(OUT, 'tasks.jsonl'), JSON.stringify({ taskId: task.id, level: task.level, prompt: ws.prompt }) + '\n');
  const base = git(ws.repo, 'rev-parse', 'HEAD').trim();
  // Harness files stay out of the diff: router project settings, worktrees, hidden tests.
  fs.appendFileSync(path.join(ws.repo, '.git', 'info', 'exclude'), '\n.claude/\n.bench-hidden/\n');
  let home: string | undefined;
  if (a !== 'direct') {
    home = path.join(root, 'router-home');
    cli(home, 'init', '--yes', '--claude-settings', path.join(root, 'cs.json'), '--project', root);
    const cfgFile = path.join(home, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    if (a === 'auto') {
      // as a user runs it: no forced level, the default budgets, steps and auto-release mode; only no holdout,
      // so every request is routed by its own triage
      cfg.holdoutRate = 0;
    } else {
      cfg.forceLevel = a === 'team-L2' ? 'L2' : 'L3';
      cfg.budgetsUsd = { L0: cap, L1: cap, L2: cap, L3: cap };
    }
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
    fs.mkdirSync(path.join(ws.repo, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(ws.repo, '.claude', 'settings.local.json'), JSON.stringify({ worktree: { baseRef: 'head' } }, null, 2));
    console.log(cli(home, 'start').trim());
  }
  if (flag('setup-only')) { console.log(`setup-only ${key} in ${ws.repo}`); if (home) cli(home, 'stop'); continue; }
  console.log(`run ${key} (cap $${cap.toFixed(2)})`);
  const r = await runClaude(ws.repo, ws.configDir, ws.prompt, a, cap, task.limits.timeoutSec, home);
  const costUsd = Number(r.out?.total_cost_usd ?? 0);
  fs.appendFileSync(ledgerFile, JSON.stringify({ key, costUsd, at: new Date().toISOString() }) + '\n');
  if (home) { try { cli(home, 'stop'); } catch { /* already down */ } }
  const facts = home ? routerFacts(home) : {};
  const stats = diffStats(ws.repo, base);
  let graded;
  if (task.source === 'custom') graded = await gradeNodeTest(task, ws.repo);
  else graded = await gradeSwebench(task, manifest!.dataset, manifest!.split, await workspacePatch(ws.repo, base), path.join(root, 'grade'), `m107-${task.id}-${a}`);
  const models = Object.entries(r.out?.modelUsage ?? {}).map(([m, u]: [string, any]) => ({ model: m, costUsd: Number(u.costUSD ?? 0) }));
  const rec = {
    taskId: task.id, arrangement: a, level: task.level, leadModel: LEAD, leadEffort: EFFORT, rep: 1,
    passed: graded.pass, grade: graded.detail, costUsd, wallSeconds: Math.round(r.ms / 1000),
    costLeadUsd: a === 'direct' ? costUsd : (facts as any).costLeadUsd, costSubagentsUsd: a === 'direct' ? 0 : (facts as any).costSubagentsUsd,
    leadCalls: r.out?.num_turns ?? null, models, ...stats, ...(a === 'direct' ? { outcome: 'router-off', levelChosen: null } : {}), ...facts,
    timedOut: r.timedOut, error: r.out?.is_error ? String(r.out?.subtype ?? r.out?.result ?? '').slice(0, 300) : (r.out ? undefined : r.stderr.slice(-300)),
  };
  fs.appendFileSync(runsFile, JSON.stringify(rec) + '\n');
  const f = facts as { levelChosen?: string | null; outcome?: string | null; leadEdits?: number; noChanges?: number };
  const routed = a === 'direct' ? '' : ` ${f.levelChosen ?? '?'} ${f.outcome ?? '?'}${f.leadEdits ? ` lead-edits=${f.leadEdits}` : ''}${f.noChanges ? ` no-changes=${f.noChanges}` : ''}`
    + ` lead $${Number(rec.costLeadUsd ?? 0).toFixed(3)} / workers $${Number(rec.costSubagentsUsd ?? 0).toFixed(3)}`;
  console.log(`  -> ${graded.pass ? 'PASS' : 'FAIL'} ${graded.detail} $${costUsd.toFixed(3)} ${rec.wallSeconds}s${routed}; spent $${spent().toFixed(2)} / $${BUDGET}`);
}
console.log(`done. spent $${spent().toFixed(2)} of $${BUDGET}. runs: ${runsFile}`);
