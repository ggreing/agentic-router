#!/usr/bin/env node
// Self-check for the custom task set (bench/tasks/custom/*).
//
// For every task:
//   before: fresh fixture copy + hidden tests in .bench-hidden/
//           -> fixture's own tests pass, grade command FAILS, at least one hidden test fails
//   after:  fresh fixture copy + oracle/ overlay + hidden tests
//           -> grade command PASSES with zero failures
// Also lints task.json (shape, id/level, limits, grade command, referenced files).
//
// Usage: node bench/tasks/custom/_validate.mjs [--keep] [--verbose] [taskId ...]
//   --keep     leave the temp repos in place (paths are printed)
//   --verbose  print test output for failed checks
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TASKS_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(TASKS_DIR, '..', '..', 'fixtures');
const GRADE_CMD = 'node --test "test/**/*.test.ts" ".bench-hidden/*.test.ts"';
const OWN_CMD = 'node --test --test-reporter=tap "test/**/*.test.ts"';
const HIDDEN_CMD = 'node --test --test-reporter=tap ".bench-hidden/*.test.ts"';
const GRADE_TAP_CMD = 'node --test --test-reporter=tap "test/**/*.test.ts" ".bench-hidden/*.test.ts"';
const LIMITS = {
  L0: { maxTurns: 15, timeoutSec: 300 },
  L1: { maxTurns: 30, timeoutSec: 600 },
  L2: { maxTurns: 60, timeoutSec: 1200 },
  L3: { maxTurns: 100, timeoutSec: 2400 },
};
const TASK_KEYS = ['id', 'level', 'source', 'fixture', 'title', 'prompt', 'hidden_tests', 'grade', 'oracle', 'limits'];

const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const verbose = argv.includes('--verbose');
const only = argv.filter((a) => !a.startsWith('--'));

function lintTask(task, dirName, taskDir) {
  const errors = [];
  const keys = Object.keys(task);
  if (keys.join(',') !== TASK_KEYS.join(',')) errors.push(`task.json keys must be exactly ${TASK_KEYS.join(',')} (got ${keys.join(',')})`);
  if (task.id !== dirName) errors.push(`id "${task.id}" does not match directory "${dirName}"`);
  const m = /^c-l([0-3])-\d{2}$/.exec(task.id ?? '');
  if (!m) errors.push(`id "${task.id}" does not match c-l<0-3>-NN`);
  else if (task.level !== `L${m[1]}`) errors.push(`level "${task.level}" does not match id`);
  if (task.source !== 'custom') errors.push('source must be "custom"');
  if (!existsSync(join(FIXTURES_DIR, task.fixture ?? '', 'package.json'))) errors.push(`fixture "${task.fixture}" not found`);
  if (typeof task.title !== 'string' || task.title.trim() === '') errors.push('title is empty');
  if (typeof task.prompt !== 'string' || task.prompt.trim().length < 40) errors.push('prompt is missing or too short');
  if (!Array.isArray(task.hidden_tests) || task.hidden_tests.length === 0) errors.push('hidden_tests is empty');
  for (const rel of task.hidden_tests ?? []) {
    if (!/^hidden\/[^/]+\.test\.ts$/.test(rel)) errors.push(`hidden test path "${rel}" must look like hidden/<name>.test.ts`);
    if (!existsSync(join(taskDir, rel))) errors.push(`hidden test "${rel}" not found`);
  }
  if (task.grade?.cmd !== GRADE_CMD || Object.keys(task.grade ?? {}).length !== 1) errors.push(`grade must be {"cmd": ${JSON.stringify(GRADE_CMD)}}`);
  if (task.oracle !== 'oracle/' || !existsSync(join(taskDir, 'oracle'))) errors.push('oracle must be "oracle/" and exist');
  const want = LIMITS[task.level];
  if (!want || task.limits?.maxTurns !== want.maxTurns || task.limits?.timeoutSec !== want.timeoutSec
    || Object.keys(task.limits ?? {}).length !== 2) {
    errors.push(`limits must be ${JSON.stringify(want)}`);
  }
  return errors;
}

function prepare(task, taskDir, withOracle) {
  const dir = mkdtempSync(join(tmpdir(), `bench-${task.id}-${withOracle ? 'after' : 'before'}-`));
  cpSync(join(FIXTURES_DIR, task.fixture), dir, { recursive: true });
  if (withOracle) cpSync(join(taskDir, task.oracle), dir, { recursive: true });
  const hiddenDir = join(dir, '.bench-hidden');
  mkdirSync(hiddenDir, { recursive: true });
  for (const rel of task.hidden_tests) cpSync(join(taskDir, rel), join(hiddenDir, basename(rel)));
  return dir;
}

function run(cmd, cwd) {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', timeout: 180_000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const count = (name) => {
    const hit = new RegExp(`^(?:#|ℹ) ${name} (\\d+)`, 'm').exec(out);
    return hit ? Number(hit[1]) : null;
  };
  return { code: r.status, out, tests: count('tests'), pass: count('pass'), fail: count('fail') };
}

function validate(task, taskDir) {
  const problems = [];
  const dirs = [];
  const show = (label, res) => {
    if (verbose) console.log(`----- ${task.id} ${label} -----\n${res.out}`);
  };

  // before: fixture as shipped
  const before = prepare(task, taskDir, false);
  dirs.push(before);
  const own = run(OWN_CMD, before);
  if (own.code !== 0) { problems.push(`before: fixture's own tests fail (${own.fail} failing)`); show('own', own); }
  const gradeBefore = run(GRADE_CMD, before);
  if (gradeBefore.code === 0) problems.push('before: grade command unexpectedly PASSES');
  const hidden = run(HIDDEN_CMD, before);
  if (!(hidden.fail > 0)) { problems.push('before: no hidden test fails'); show('hidden', hidden); }

  // after: oracle overlay
  const after = prepare(task, taskDir, true);
  dirs.push(after);
  const gradeAfter = run(GRADE_CMD, after);
  const afterCounts = run(GRADE_TAP_CMD, after);
  if (gradeAfter.code !== 0 || afterCounts.fail !== 0) {
    problems.push(`after: grade command fails (${afterCounts.fail} failing)`);
    show('after', afterCounts);
  }
  const hiddenAfter = run(HIDDEN_CMD, after);

  if (keep) console.log(`  kept: ${dirs.join('  ')}`);
  else for (const d of dirs) rmSync(d, { recursive: true, force: true });

  return {
    problems,
    beforeFail: hidden.fail,
    beforeTotal: hidden.tests,
    afterPass: afterCounts.pass,
    afterTotal: afterCounts.tests,
    hiddenAfterPass: hiddenAfter.pass,
  };
}

const taskDirs = readdirSync(TASKS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
  .map((d) => d.name)
  .filter((name) => only.length === 0 || only.includes(name))
  .sort();

const rows = [];
let failed = 0;
for (const name of taskDirs) {
  const taskDir = join(TASKS_DIR, name);
  const task = JSON.parse(readFileSync(join(taskDir, 'task.json'), 'utf8'));
  const lint = lintTask(task, name, taskDir);
  const res = lint.length === 0 ? validate(task, taskDir) : { problems: [] };
  const problems = [...lint, ...res.problems];
  if (problems.length > 0) failed++;
  rows.push({
    id: task.id,
    level: task.level,
    fixture: task.fixture,
    before: res.beforeFail == null ? '-' : `${res.beforeFail}/${res.beforeTotal} hidden fail`,
    after: res.afterPass == null ? '-' : `${res.afterPass}/${res.afterTotal} pass`,
    status: problems.length === 0 ? 'OK' : 'FAIL',
  });
  console.log(`${problems.length === 0 ? 'OK  ' : 'FAIL'} ${task.id}${problems.map((p) => `\n     - ${p}`).join('')}`);
}

if (only.length === 0) {
  const expected = [
    ...[1, 2, 3, 4, 5].map((n) => `c-l0-0${n}`),
    ...[1, 2, 3, 4, 5].map((n) => `c-l1-0${n}`),
    ...[1, 2, 3].map((n) => `c-l2-0${n}`),
    ...[1, 2].map((n) => `c-l3-0${n}`),
  ];
  const missing = expected.filter((id) => !taskDirs.includes(id));
  const extra = taskDirs.filter((id) => !expected.includes(id));
  if (missing.length || extra.length) {
    failed++;
    console.log(`FAIL task set: missing [${missing.join(', ')}] extra [${extra.join(', ')}]`);
  }
}

console.log('');
console.table(rows);
console.log(failed === 0 ? `All ${rows.length} tasks valid.` : `${failed} problem(s).`);
process.exit(failed === 0 ? 0 : 1);
