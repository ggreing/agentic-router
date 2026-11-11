import fs from 'node:fs';
import path from 'node:path';
import type { Task } from './types.ts';
import { BENCH, copyDir, git } from './util.ts';
import { checkoutRepo, fetchInstance, type Instance } from './public.ts';
import { loadPublicManifest } from './tasks.ts';

export interface Workspace { root: string; repo: string; configDir: string; prompt: string; instance?: Instance }

const PUBLIC_PROMPT = 'Resolve the following GitHub issue by editing the repository source code. Do not modify or add tests.\n\n';

export async function prepare(task: Task, root: string): Promise<Workspace> {
  fs.rmSync(root, { recursive: true, force: true });
  const repo = path.join(root, 'repo');
  const configDir = path.join(root, 'claude-config');
  fs.mkdirSync(configDir, { recursive: true });
  if (task.source === 'custom') {
    copyDir(path.join(BENCH, 'fixtures', task.fixture!), repo);
    await git(repo, 'init', '-q', '-b', 'main');
    await git(repo, 'config', 'user.name', 'bench');
    await git(repo, 'config', 'user.email', 'bench@example.invalid');
    await git(repo, 'config', 'core.autocrlf', 'false');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-qm', 'fixture');
    return { root, repo, configDir, prompt: task.prompt! };
  }
  const m = loadPublicManifest()!;
  const inst = await fetchInstance(m.dataset, m.split, task.instance_id!);
  await checkoutRepo(task.repo!, task.base_commit!, repo);
  return { root, repo, configDir, prompt: PUBLIC_PROMPT + inst.problem_statement, instance: inst };
}

export function applyOracle(task: Task, repo: string): void {
  if (!task.dir || !task.oracle) throw new Error(`no oracle for ${task.id}`);
  copyDir(path.join(task.dir, task.oracle), repo);
}
