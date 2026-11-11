// Grades a public task with the official SWE-bench harness (Docker). The model patch is the
// diff of the agent's workspace against base_commit; for validation, the gold patch (must
// resolve) and an empty patch (must not). Requires Docker and the swebench package, which
// lives in an isolated venv at bench/.cache/venv (or BENCH_PYTHON). Instance images are
// pulled from the registry on first use (1-3 GB each), so free disk space is checked first.
import fs from 'node:fs';
import path from 'node:path';
import type { GradeResult, Task } from '../types.ts';
import { BENCH, exec, git } from '../util.ts';

export const MIN_FREE_GB = 20;

export function pythonExe(): string {
  if (process.env.BENCH_PYTHON) return process.env.BENCH_PYTHON;
  const venv = path.join(BENCH, '.cache', 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  return fs.existsSync(venv) ? venv : 'python';
}

export function freeGb(p = BENCH): number {
  const s = fs.statfsSync(p);
  return (s.bavail * s.bsize) / 1024 ** 3;
}

export async function workspacePatch(repo: string, baseCommit: string): Promise<string> {
  await git(repo, 'add', '-A');
  const d = await git(repo, 'diff', '--cached', '--binary', baseCommit);
  return d.stdout;
}

export async function swebenchAvailable(): Promise<string | null> {
  const py = await exec(pythonExe(), ['-c', 'import swebench; print(swebench.__version__)'], { cwd: BENCH, timeoutSec: 60 });
  if (py.code !== 0) return 'swebench not installed (py -3.12 -m venv bench/.cache/venv && bench/.cache/venv/Scripts/pip install swebench==5.0.2)';
  const dk = await exec('docker', ['info', '--format', '{{.OSType}}'], { cwd: BENCH, timeoutSec: 60 });
  if (dk.code !== 0) return 'Docker is not running';
  return null;
}

export async function gradeSwebench(task: Task, dataset: string, split: string, patch: string, workDir: string,
  runId: string, timeoutSec = task.limits.timeoutSec): Promise<GradeResult> {
  const missing = await swebenchAvailable();
  if (missing) return { pass: false, detail: `not graded: ${missing}` };
  const free = freeGb();
  if (free < MIN_FREE_GB) return { pass: false, detail: `not graded: only ${free.toFixed(1)} GB free (< ${MIN_FREE_GB} GB)` };
  fs.mkdirSync(workDir, { recursive: true });
  const model = 'agentic-bench';
  const preds = path.join(workDir, 'preds.jsonl');
  fs.writeFileSync(preds, JSON.stringify({ instance_id: task.instance_id, model_name_or_path: model, model_patch: patch }) + '\n');
  const safeRun = runId.replace(/[^A-Za-z0-9_.-]/g, '_');
  // On Windows the harness must write patch.diff / eval.sh with LF endings (see scripts/swebench_lf.py).
  const entry = process.platform === 'win32' ? [path.join(BENCH, 'scripts', 'swebench_lf.py')] : ['-m', 'swebench.harness.run_evaluation'];
  const r = await exec(pythonExe(), [...entry, '--dataset_name', dataset, '--split', split,
    '--instance_ids', task.instance_id!, '--predictions_path', preds, '--max_workers', '1', '--run_id', safeRun,
    '--report_dir', workDir], { cwd: workDir, timeoutSec });
  fs.writeFileSync(path.join(workDir, 'harness.log'), r.stdout + '\n--- stderr ---\n' + r.stderr);
  const report = path.join(workDir, `${model}.${safeRun}.json`);
  if (!fs.existsSync(report)) return { pass: false, detail: `harness produced no report (exit ${r.code}${r.timedOut ? ', timeout' : ''}): ${r.stderr.slice(-200).replace(/\s+/g, ' ')}` };
  const rep = JSON.parse(fs.readFileSync(report, 'utf8')) as Record<string, unknown>;
  const has = (k: string) => Array.isArray(rep[k]) && (rep[k] as string[]).includes(task.instance_id!);
  if (has('resolved_ids')) return { pass: true, detail: 'resolved' };
  const why = ['empty_patch_ids', 'unresolved_ids', 'error_ids'].find(has) ?? 'not resolved';
  return { pass: false, detail: why.replace('_ids', '') };
}
