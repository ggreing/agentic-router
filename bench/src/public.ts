// SWE-bench Verified instance data (problem statement, gold patch). Read through the swebench
// venv's `datasets` library (the same Hugging Face cache the official harness uses) and cached
// per instance in bench/.cache/swebench/<dataset>/ — never committed to the repo.
import fs from 'node:fs';
import path from 'node:path';
import { BENCH, exec, git } from './util.ts';
import { pythonExe } from './graders/swebench.ts';

export interface Instance {
  instance_id: string; repo: string; base_commit: string; problem_statement: string; patch: string;
  test_patch: string; FAIL_TO_PASS: string; PASS_TO_PASS: string; version: string; difficulty: string; image?: string;
}

const CACHE = path.join(BENCH, '.cache');

const DUMP = `
import json, sys
from datasets import load_dataset
ds, split, out = sys.argv[1], sys.argv[2], sys.argv[3]
d = load_dataset(ds, split=split)
import os
os.makedirs(out, exist_ok=True)
for r in d:
    with open(os.path.join(out, r['instance_id'] + '.json'), 'w', encoding='utf-8') as f:
        json.dump(r, f)
print(len(d))
`;

export async function fetchInstance(dataset: string, split: string, id: string): Promise<Instance> {
  const dir = path.join(CACHE, 'swebench', dataset.replace('/', '__'));
  const p = path.join(dir, `${id}.json`);
  if (!fs.existsSync(p)) {
    const r = await exec(pythonExe(), ['-c', DUMP, dataset, split, dir], { cwd: BENCH, timeoutSec: 900 });
    if (r.code !== 0) throw new Error(`could not load ${dataset}: ${r.stderr.slice(-300)}`);
  }
  if (!fs.existsSync(p)) throw new Error(`instance not found in ${dataset}: ${id}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Checks out <repo>@<base_commit> into dst using a shared bare mirror cache.
export async function checkoutRepo(repo: string, baseCommit: string, dst: string): Promise<void> {
  const mirror = path.join(CACHE, 'repos', repo.replace('/', '__') + '.git');
  if (!fs.existsSync(mirror)) {
    fs.mkdirSync(path.dirname(mirror), { recursive: true });
    const r = await exec('git', ['clone', '--mirror', `https://github.com/${repo}.git`, mirror], { cwd: CACHE, timeoutSec: 3600 });
    if (r.code !== 0) throw new Error(`clone failed: ${r.stderr.slice(0, 300)}`);
  }
  const c = await exec('git', ['clone', '--no-checkout', '--shared', mirror, dst], { cwd: CACHE, timeoutSec: 600 });
  if (c.code !== 0) throw new Error(`local clone failed: ${c.stderr.slice(0, 300)}`);
  const co = await git(dst, 'checkout', '-q', baseCommit);
  if (co.code !== 0) throw new Error(`checkout failed: ${co.stderr.slice(0, 300)}`);
  await git(dst, 'remote', 'remove', 'origin');   // the agent's workspace has no push target
}
