// Phase 0 benchmark harness CLI.
//   node bench/src/cli.ts plan     [filters]                 dry-run: matrix, prior cost estimate, budget
//   node bench/src/cli.ts validate [--tasks ...] [--public]  oracle check: fail before, pass after (no model calls)
//   node bench/src/cli.ts run      [filters] --execute --api-key-helper "<keychain command>"
//   node bench/src/cli.ts report                             aggregate results/runs.jsonl
//   node bench/src/cli.ts doctor   [--leak-test]             environment and credential-isolation checks
// filters: --levels L0,L1  --configs s1,s5  --tasks id,id  --sources custom,swebench-verified  --reps 1
import fs from 'node:fs';
import path from 'node:path';
import type { PlannedRun, RunRecord, Task } from './types.ts';
import { RESULTS, exec, parseList } from './util.ts';
import { loadPublicManifest, loadTasks } from './tasks.ts';
import { buildPlan, loadBudget, loadMatrix, summarize } from './plan.ts';
import * as ledger from './ledger.ts';
import { applyOracle, prepare } from './workspace.ts';
import { gradeNodeTest } from './graders/node-test.ts';
import { freeGb, gradeSwebench, swebenchAvailable, workspacePatch } from './graders/swebench.ts';
import { fetchInstance } from './public.ts';
import { runClaude } from './executors/claude.ts';
import { childEnv, childSettings, describeAuth, redact, redactDeep, resolveAuth } from './secrets.ts';
import { writeReport } from './report.ts';

const MIN_CLAUDE = [2, 1, 295];   // per-call effort (2.1.292), hook onFailure (2.1.295)

function flags(argv: string[]) {
  const f: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { f[a.slice(2)] = next; i++; } else f[a.slice(2)] = true;
  }
  return f;
}

function selection(f: Record<string, string | boolean>) {
  const tasks = loadTasks({ levels: parseList(f.levels as string), ids: parseList(f.tasks as string), sources: parseList(f.sources as string) });
  const want = parseList(f.configs as string);
  const configs = loadMatrix().configs.filter(c => !want || want.includes(c.id));
  const reps = Number(f.reps ?? 1);
  return { tasks, configs, reps };
}

function printPlan(runs: PlannedRun[]) {
  const s = summarize(runs);
  const budget = loadBudget();
  const used = ledger.spent();
  console.log(`runs: ${s.runs}   prior estimate: $${s.est.toFixed(2)}   worst case (sum of per-run caps): $${s.cap.toFixed(2)}`);
  console.log(`budget: $${budget.totalUsd}   spent: $${used.toFixed(2)}   remaining: $${(budget.totalUsd - used).toFixed(2)}`);
  console.log('by level :', Object.entries(s.byLevel).map(([k, v]) => `${k} ${v.runs} runs ~$${v.est.toFixed(2)}`).join(' | '));
  console.log('by config:', Object.entries(s.byConfig).map(([k, v]) => `${k} ~$${v.est.toFixed(2)}`).join(' | '));
  if (s.est > budget.totalUsd - used) console.log('WARNING: prior estimate exceeds remaining budget — narrow the selection or run a pilot subset first.');
}

async function claudeVersionOk(): Promise<string> {
  const r = await exec('claude', ['--version'], { cwd: process.cwd(), timeoutSec: 30 });
  const v = (r.stdout.match(/(\d+)\.(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
  const ok = v.length === 3 && (v[0] - MIN_CLAUDE[0] || v[1] - MIN_CLAUDE[1] || v[2] - MIN_CLAUDE[2]) >= 0;
  return `${r.stdout.trim()} ${ok ? '(ok)' : `(need >= ${MIN_CLAUDE.join('.')})`}`;
}

async function cmdValidate(f: Record<string, string | boolean>) {
  const { tasks } = selection(f);
  const work = path.join(RESULTS, 'validate');
  let bad = 0;
  for (const t of tasks) {
    if (t.source === 'custom') {
      const a = await prepare(t, path.join(work, t.id, 'before'));
      const before = await gradeNodeTest(t, a.repo);
      const b = await prepare(t, path.join(work, t.id, 'after'));
      applyOracle(t, b.repo);
      const after = await gradeNodeTest(t, b.repo);
      const ok = !before.pass && after.pass;
      if (!ok) bad++;
      console.log(`${ok ? 'OK ' : 'BAD'} ${t.id.padEnd(10)} ${t.level} before: ${before.detail.padEnd(22)} after(oracle): ${after.detail}`);
    } else if (f.public) {
      // No repo checkout needed: the harness applies the patch inside the instance image.
      const m = loadPublicManifest()!;
      const inst = await fetchInstance(m.dataset, m.split, t.instance_id!);
      fs.rmSync(path.join(work, t.id), { recursive: true, force: true });   // the harness skips run ids it has seen
      const t0 = Date.now();
      // "before": a no-op patch (adds an unrelated file) so the tests really run on the base commit
      // and must fail; an empty patch would be short-circuited by the harness without running tests.
      const noop = 'diff --git a/BENCH_NOOP.txt b/BENCH_NOOP.txt\nnew file mode 100644\n--- /dev/null\n+++ b/BENCH_NOOP.txt\n@@ -0,0 +1 @@\n+noop\n';
      const before = await gradeSwebench(t, m.dataset, m.split, noop, path.join(work, t.id, 'noop'), `validate_noop_${t.id}`, 5400);
      const gold = await gradeSwebench(t, m.dataset, m.split, inst.patch, path.join(work, t.id, 'gold'), `validate_gold_${t.id}`, 5400);
      const ok = before.detail === 'unresolved' && gold.pass;
      if (!ok) bad++;
      console.log(`${ok ? 'OK ' : 'BAD'} ${t.id.padEnd(40)} ${t.level} no-op patch: ${before.detail.padEnd(12)} gold patch: ${gold.detail}  (${((Date.now() - t0) / 60000).toFixed(1)} min, ${freeGb().toFixed(1)} GB free)`);
    } else {
      console.log(`SKIP ${t.id} (public task: add --public; needs Docker + swebench, downloads large images)`);
    }
  }
  console.log(bad ? `${bad} task(s) failed validation` : 'all selected tasks valid');
  if (bad) process.exitCode = 1;
}

async function cmdRun(f: Record<string, string | boolean>) {
  const { tasks, configs, reps } = selection(f);
  const runs = buildPlan(tasks, configs, reps);
  printPlan(runs);
  const auth = resolveAuth({ apiKeyHelper: f['api-key-helper'] as string });
  console.log('auth     :', describeAuth(auth));
  if (!f.execute) { console.log('\nDRY RUN — nothing was executed. Add --execute to run (spends API budget).'); return; }
  if (auth.kind === 'none') { console.error('No API key channel. Store the key with bench/scripts/set-key.ps1 and pass --api-key-helper "<keychain command>" (or set BENCH_API_KEY_HELPER).'); process.exitCode = 2; return; }
  console.log('claude   :', await claudeVersionOk());
  const budget = loadBudget();
  const done = new Set(fs.existsSync(path.join(RESULTS, 'runs.jsonl'))
    ? fs.readFileSync(path.join(RESULTS, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).runId) : []);
  fs.mkdirSync(RESULTS, { recursive: true });
  const m = loadPublicManifest();
  for (const run of runs) {
    if (done.has(run.runId)) { console.log(`skip ${run.runId} (already recorded)`); continue; }
    const remaining = budget.totalUsd - ledger.spent();
    if (remaining < run.capUsd) { console.log(`STOP: remaining budget $${remaining.toFixed(2)} < per-run cap $${run.capUsd} for ${run.runId}`); break; }
    const ws = await prepare(run.task, path.join(RESULTS, 'work', run.runId));
    const out = await runClaude(run, ws.repo, ws.configDir, ws.prompt, auth);
    ledger.record(run.runId, out.costUsd);
    let graded;
    if (run.task.source === 'custom') graded = await gradeNodeTest(run.task, ws.repo);
    else {
      // Keep the agent's patch so a grading-infrastructure failure (e.g. Docker stopped) can be
      // re-graded later without paying for the agent run again.
      const patch = await workspacePatch(ws.repo, run.task.base_commit!);
      fs.mkdirSync(path.join(RESULTS, 'patches'), { recursive: true });
      fs.writeFileSync(path.join(RESULTS, 'patches', `${run.runId}.diff`), patch);
      graded = await gradeSwebench(run.task, m!.dataset, m!.split, patch, path.join(ws.root, 'grade'), run.runId);
    }
    const rec: RunRecord = {
      runId: run.runId, taskId: run.task.id, level: run.task.level, source: run.task.source, configId: run.config.id,
      model: run.config.model, effort: run.config.effort, rep: run.rep, startedAt: new Date(Date.now() - out.durationMs).toISOString(),
      durationMs: out.durationMs, exitCode: out.exitCode, timedOut: out.timedOut, costUsd: out.costUsd, numTurns: out.numTurns,
      isError: out.isError, resultSubtype: out.subtype, resolvedModels: out.resolvedModels, usage: out.usage, graded,
      note: out.isError ? out.stderr.slice(0, 300) : undefined,
    };
    fs.appendFileSync(path.join(RESULTS, 'runs.jsonl'), JSON.stringify(redactDeep(rec)) + '\n');
    console.log(`${graded.pass ? 'PASS' : 'FAIL'} ${run.runId}  $${out.costUsd.toFixed(3)}  ${(out.durationMs / 1000).toFixed(0)}s  ${graded.detail}`);
  }
  console.log('\n' + writeReport());
}

async function cmdDoctor(f: Record<string, string | boolean>) {
  console.log('node     :', process.versions.node);
  console.log('claude   :', await claudeVersionOk());
  console.log('tasks    :', loadTasks({}).reduce((a: Record<string, number>, t: Task) => ({ ...a, [t.level]: (a[t.level] ?? 0) + 1 }), {}));
  console.log('swebench :', (await swebenchAvailable()) ?? 'ok (python swebench + Docker)');
  console.log('auth     :', describeAuth(resolveAuth({ apiKeyHelper: f['api-key-helper'] as string })));
  if (f['leak-test']) {
    // With no API key channel, an isolated --bare run must fail to authenticate. If it succeeded,
    // the child would be using credentials it should never see (e.g. the Claude.ai subscription).
    const dir = path.join(RESULTS, 'leak-test');
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(path.join(dir, 'cfg'), { recursive: true });
    const r = await exec('claude', ['-p', '--bare', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'json', '--model', 'claude-haiku-5-5'],
      { cwd: dir, env: childEnv(path.join(dir, 'cfg'), { kind: 'none' }), input: 'Reply with OK.', timeoutSec: 120 });
    let j: Record<string, unknown> = {};
    try { j = JSON.parse(r.stdout); } catch { /* not JSON */ }
    const cost = typeof j.total_cost_usd === 'number' ? j.total_cost_usd : 0;
    const failedAuth = r.code !== 0 || j.is_error === true;
    console.log(`leak test: exit=${r.code} is_error=${String(j.is_error)} cost=$${cost} → ${failedAuth && cost === 0 ? 'PASS (no credentials reachable without an explicit API key channel)' : 'FAIL (child authenticated without a provided key!)'}`);
    console.log('  child said:', String(j.result ?? r.stdout ?? r.stderr).slice(0, 200).replace(/\s+/g, ' '));
  }
  if (f['auth-test']) {
    // Smallest possible paid call (Haiku, low effort, one turn) through the exact isolation and
    // key channel the benchmark uses. Its cost is written to the ledger like any other run.
    const auth = resolveAuth({ apiKeyHelper: f['api-key-helper'] as string });
    if (auth.kind === 'none') { console.log('auth test: no key channel (pass --api-key-helper)'); process.exitCode = 2; return; }
    const dir = path.join(RESULTS, 'auth-test');
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(path.join(dir, 'cfg'), { recursive: true });
    const r = await exec('claude', ['-p', '--bare', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'json',
      '--model', 'claude-haiku-5-5', '--effort', 'low', '--max-budget-usd', '0.05', '--tools', '', '--settings', childSettings(auth)],
    { cwd: dir, env: childEnv(path.join(dir, 'cfg'), auth), input: 'Reply with exactly: OK', timeoutSec: 180 });
    let j: Record<string, unknown> = {};
    try { j = JSON.parse(r.stdout); } catch { /* not JSON */ }
    const cost = typeof j.total_cost_usd === 'number' ? j.total_cost_usd : 0;
    ledger.record(`auth-test-${Date.now()}`, cost);
    const ok = r.code === 0 && j.is_error !== true;
    console.log(`auth test: ${ok ? 'PASS' : 'FAIL'} exit=${r.code} cost=$${cost.toFixed(4)} models=${Object.keys((j.modelUsage as object) ?? {}).join(',')}`);
    console.log('  child said:', redact(String(j.result ?? r.stderr ?? '').slice(0, 200)).replace(/\s+/g, ' '));
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const f = flags(rest);
if (cmd === 'plan') { const s = selection(f); printPlan(buildPlan(s.tasks, s.configs, s.reps)); }
else if (cmd === 'validate') await cmdValidate(f);
else if (cmd === 'run') await cmdRun(f);
else if (cmd === 'report') console.log(writeReport());
else if (cmd === 'doctor') await cmdDoctor(f);
else console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 8).join('\n'));
