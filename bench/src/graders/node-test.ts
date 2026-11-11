// Grades a custom task: copies hidden tests into <repo>/.bench-hidden/ and runs the task's
// grade command (fixture tests + hidden tests). Pass = exit code 0.
import fs from 'node:fs';
import path from 'node:path';
import type { GradeResult, Task } from '../types.ts';
import { exec } from '../util.ts';

export async function gradeNodeTest(task: Task, repo: string): Promise<GradeResult> {
  const hiddenDir = path.join(repo, '.bench-hidden');
  fs.mkdirSync(hiddenDir, { recursive: true });
  for (const rel of task.hidden_tests ?? []) fs.copyFileSync(path.join(task.dir!, rel), path.join(hiddenDir, path.basename(rel)));
  const r = await exec(task.grade!.cmd, [], { cwd: repo, shell: true, timeoutSec: 300 });
  const out = r.stdout + r.stderr;
  // TAP reporter prints "# pass N"; the spec reporter (Node 24 default) prints "ℹ pass N".
  const pass = out.match(/^(?:#|ℹ) pass (\d+)/m)?.[1] ?? '?';
  const fail = out.match(/^(?:#|ℹ) fail (\d+)/m)?.[1] ?? '?';
  return { pass: r.code === 0 && !r.timedOut, detail: `tests pass=${pass} fail=${fail}${r.timedOut ? ' (timeout)' : ''}` };
}
