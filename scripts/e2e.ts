// Phase 1 end-to-end check with a real Claude Code (spec 7, Phase 1 DoD).
//   node scripts/e2e.ts --auth subscription            (uses the logged-in account; consumes usage limits)
//   node scripts/e2e.ts --auth api-key --api-key-helper "<keychain cmd>"   (API key, --bare)
//   add --scenarios E1,E2,E3 to pick, --model sonnet for the lead (default sonnet)
// Everything runs in a temp AGENTIC_ROUTER_HOME and temp repositories; the user's ~/.claude is
// never modified (init writes the status line into a temp settings file).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce<string[][]>((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1] && !arr[i + 1]!.startsWith('--') ? arr[i + 1]! : 'true']] : a), []));
const AUTH = args.auth ?? '';
if (AUTH !== 'subscription' && AUTH !== 'api-key') { console.error('choose --auth subscription | api-key'); process.exit(2); }
const SCEN = (args.scenarios ?? 'E1,E2,E3').split(',');
const MODEL = args.model ?? 'sonnet';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-e2e-'));
const HOME = path.join(TMP, 'home');
const env = { ...process.env, AGENTIC_ROUTER_HOME: HOME };
for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_(CHILD_SESSION|SESSION_ID|MESSAGING_\w+|SESSION_ATTENDED|ENTRYPOINT|EXECPATH)|CLAUDE_PID|CLAUDE_EFFORT)$/.test(k)) delete env[k];
const cli = (...a: string[]) => execFileSync(process.execPath, [path.join(ROOT, 'packages/cli/src/index.ts'), ...a], { env, encoding: 'utf8', cwd: TMP });

function repoFrom(fixture: string, name: string): string {
  const dir = path.join(TMP, name);
  fs.cpSync(path.join(ROOT, 'bench/fixtures', fixture), dir, { recursive: true });
  for (const c of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'e2e'], ['config', 'user.email', 'e2e@example.invalid'], ['add', '-A'], ['commit', '-qm', 'fixture']])
    execFileSync('git', c, { cwd: dir });
  return dir;
}

function claude(cwd: string, prompt: string, timeoutSec = 900, direct = false): Promise<{ code: number | null; out: any; ms: number }> {
  const a = ['-p', ...(direct ? [] : ['--plugin-dir', path.join(ROOT, 'plugin')]), '--model', MODEL, '--output-format', 'json',
    '--permission-mode', 'acceptEdits', '--max-budget-usd', '3',
    // -p cannot prompt, so read-only shell helpers the workers commonly chain (cd/ls/cat/...) are
    // allowed too; round 2 showed `cd … && git grep …; cat package.json` denied otherwise. Network
    // and credential commands stay with the router guard.
    '--allowedTools', 'Agent', 'Bash(npm *)', 'Bash(node *)', 'Bash(git *)', 'Bash(cd *)', 'Bash(ls *)', 'Bash(cat *)',
    'Bash(head *)', 'Bash(tail *)', 'Bash(grep *)', 'Bash(echo *)', 'Bash(wc *)', 'Bash(pwd)', 'Bash(npx tsc *)'];
  if (AUTH === 'api-key') a.splice(1, 0, '--bare', '--settings', JSON.stringify({ apiKeyHelper: args['api-key-helper'] }));
  else a.splice(1, 0, '--setting-sources', 'project,local');     // keep the user's own plugins and hooks out
  return new Promise(resolve => {
    const t0 = Date.now();
    const p = spawn('claude', a, { cwd, env, windowsHide: true });
    let so = '';
    p.stdout.on('data', d => { so += d; });
    const timer = setTimeout(() => p.kill(), timeoutSec * 1000);
    p.on('close', code => { clearTimeout(timer); let out: any = null; try { out = JSON.parse(so); } catch { out = { raw: so.slice(0, 500) }; } resolve({ code, out, ms: Date.now() - t0 }); });
    p.stdin.end(prompt);
  });
}

function ledger(): Record<string, unknown[]> {
  const db = new DatabaseSync(path.join(HOME, 'router.db'), { readOnly: true });
  const out: Record<string, unknown[]> = {};
  for (const t of ['requests', 'subtasks', 'agents', 'signals', 'costs']) {
    try { out[t] = db.prepare(`SELECT * FROM ${t}`).all(); } catch { out[t] = []; }
  }
  try { out.eventCount = [db.prepare('SELECT type, COUNT(*) AS n FROM events GROUP BY type').all()]; } catch { /* schema differs */ }
  db.close();
  return out;
}

function grade(repo: string, taskId: string): string {
  const t = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/tasks/custom', taskId, 'task.json'), 'utf8'));
  fs.mkdirSync(path.join(repo, '.bench-hidden'), { recursive: true });
  for (const h of t.hidden_tests) fs.copyFileSync(path.join(ROOT, 'bench/tasks/custom', taskId, h), path.join(repo, '.bench-hidden', path.basename(h)));
  try { execFileSync(t.grade.cmd, { cwd: repo, shell: true, stdio: 'pipe' }); return 'hidden tests PASS'; } catch { return 'hidden tests FAIL'; }
}

const task = (id: string) => JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/tasks/custom', id, 'task.json'), 'utf8'));
const report: string[] = [];
const log = (s: string) => { console.log(s); report.push(s); };

log(`e2e home ${HOME} | auth ${AUTH} | lead model ${MODEL}`);
cli('init', '--yes', '--claude-settings', path.join(TMP, 'claude-settings.json'), '--project', TMP);
log(cli('start').trim());

// Scenarios: E1/E2 fixed tasks, plus `--tasks c-l1-01,c-l1-03` for any custom bench task.
// `--compare` runs each task twice: routed (plugin + daemon) and direct (no plugin) for a cost comparison.
const runs: Array<[string, string, string, boolean]> = [];
for (const [id, taskId, fixture] of [['E1', 'c-l0-01', 'textkit'], ['E2', 'c-l1-02', 'taskboard']] as const)
  if (SCEN.includes(id)) runs.push([id, taskId, fixture, false]);
for (const taskId of (args.tasks ?? '').split(',').filter(Boolean)) {
  runs.push([`T-${taskId}`, taskId, task(taskId).fixture, false]);
  if (args.compare === 'true') runs.push([`D-${taskId}`, taskId, task(taskId).fixture, true]);
}
for (const [id, taskId, fixture, direct] of runs) {
  const repo = repoFrom(fixture, id);
  const r = await claude(repo, task(taskId).prompt, 900, direct);
  fs.writeFileSync(path.join(TMP, `${id}-result.json`), JSON.stringify(r.out, null, 2));
  const perModel = Object.entries(r.out?.modelUsage ?? {}).map(([m, u]: [string, any]) => `${m.replace('claude-', '')} $${Number(u.costUSD ?? 0).toFixed(4)}`).join(', ');
  log(`\n== ${id} (${taskId}, ${task(taskId).level}) exit=${r.code} ${Math.round(r.ms / 1000)}s cost=$${Number(r.out?.total_cost_usd ?? 0).toFixed(4)} [${perModel}] turns=${r.out?.num_turns ?? '?'}`);
  const worktrees = execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' }).trim().split('\n').length - 1;
  const changed = execFileSync('git', ['status', '--short', '--', '.', ':!.claude', ':!.bench-hidden'], { cwd: repo, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  log(`   working tree changes: ${changed.join(' | ') || 'none'} | leftover worktrees: ${worktrees}`);
  log(`   ${grade(repo, taskId)} | result: ${String(r.out?.result ?? r.out?.raw ?? '').slice(0, 160).replace(/\s+/g, ' ')}`);
}
if (SCEN.includes('E3')) {
  log('\n' + cli('stop').trim());
  const repo = repoFrom('textkit', 'E3');
  const r = await claude(repo, 'README.md 맨 아래에 "Maintained by e2e" 한 줄을 추가해줘.');
  const spooled = fs.existsSync(path.join(HOME, 'spool')) ? fs.readdirSync(path.join(HOME, 'spool')).length : 0;
  log(`== E3 daemon OFF: exit=${r.code} ${Math.round(r.ms / 1000)}s readme edited=${fs.readFileSync(path.join(repo, 'README.md'), 'utf8').includes('Maintained by e2e')} spool files=${spooled}`);
  log(cli('start').trim());
  await new Promise(res => setTimeout(res, 1500));
  log(`   after restart: spool files left=${fs.readdirSync(path.join(HOME, 'spool')).length}`);
}
const l = ledger();
log('\n== ledger');
for (const [k, v] of Object.entries(l)) log(`-- ${k} (${v.length})\n` + v.slice(0, 12).map(x => '   ' + JSON.stringify(x).slice(0, 300)).join('\n'));
log('\n' + cli('stop').trim());
fs.writeFileSync(path.join(TMP, 'e2e-report.txt'), report.join('\n'));
console.log(`\nreport: ${path.join(TMP, 'e2e-report.txt')}`);
