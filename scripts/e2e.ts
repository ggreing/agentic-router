// End-to-end check with a real Claude Code (spec 7).
//   node scripts/e2e.ts --auth subscription            (uses the logged-in account; consumes usage limits)
//   node scripts/e2e.ts --auth api-key --api-key-helper "<keychain cmd>"   (API key, --bare)
//   add --scenarios E1,E2,E3 to pick rounds 1-4, --model sonnet for the lead (default sonnet)
// Integration round 5 (acceptance, auto-release, router MCP tools, dashboard):
//   node scripts/e2e.ts --round5 --auth subscription          (runs R1-R6 then the R7 dashboard check)
//   node scripts/e2e.ts --round5 --only R1,R3 --auth subscription
//   node scripts/e2e.ts --round5 --dry-run                    (prints the plan + estimated usage; no claude)
//   --no-dashboard skips R7. Per-scenario summaries and round5-summary.json are written to the temp dir.
// Everything runs in a temp AGENTIC_ROUTER_HOME and temp repositories; the user's ~/.claude is
// never modified (init writes the status line into a temp settings file).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce<string[][]>((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1] && !arr[i + 1]!.startsWith('--') ? arr[i + 1]! : 'true']] : a), []));
const AUTH = args.auth ?? '';
const DRY = args['dry-run'] === 'true';
const ROUND5 = args.round5 === 'true';
if (!DRY && AUTH !== 'subscription' && AUTH !== 'api-key') { console.error('choose --auth subscription | api-key (or --dry-run to print the plan)'); process.exit(2); }
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

function claude(cwd: string, prompt: string, timeoutSec = 900, direct = false, resume?: string): Promise<{ code: number | null; out: any; ms: number }> {
  const a = ['-p', ...(direct ? [] : ['--plugin-dir', path.join(ROOT, 'plugin')]), '--model', MODEL, '--output-format', 'json',
    '--permission-mode', 'acceptEdits', '--max-budget-usd', '3',
    // -p cannot prompt, so read-only shell helpers the workers commonly chain (cd/ls/cat/...) are
    // allowed too; round 2 showed `cd … && git grep …; cat package.json` denied otherwise. Network
    // and credential commands stay with the router guard. The router MCP tools are allowed so a lead
    // CAN call them (round 5 observes whether it does, given deferred tool search); it is never forced to.
    '--allowedTools', 'Agent', 'mcp__plugin_agentic-router_router__*', 'Bash(npm *)', 'Bash(node *)', 'Bash(git *)', 'Bash(cd *)', 'Bash(ls *)', 'Bash(cat *)',
    'Bash(head *)', 'Bash(tail *)', 'Bash(grep *)', 'Bash(echo *)', 'Bash(wc *)', 'Bash(pwd)', 'Bash(npx tsc *)'];
  if (resume) a.push('--resume', resume);                        // continue the same session (acceptance follow-ups)
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

log(`e2e home ${HOME} | auth ${AUTH || '(dry-run)'} | lead model ${MODEL}`);

// ================================================================= integration round 5
// What was built since round 4: user acceptance (137), auto-release holdout (138), the router MCP tools
// (127-129, deferred loading) and the dashboard metrics API (132). Control runs claude; this harness
// drives it and reads the ledger. `--round5` runs these; `--only R1,R3` picks some; `--dry-run` prints
// the plan and estimated subscription usage without calling claude.
type R5Kind = 'single' | 'reask' | 'revert' | 'commit' | 'protected';
interface R5 { id: string; title: string; taskId?: string; fixture: string; prompt?: string; kind: R5Kind; follow?: string; calls: number; turns: number; expect: string }
const FOLLOW = 'Looks good, thank you.';
const R5S: R5[] = [
  { id: 'R1', title: 'L1 fix delegated to one coder @s1', taskId: 'c-l1-02', fixture: 'taskboard', kind: 'single', calls: 1, turns: 12, expect: 'delegated, verify passes, a request_record is written; note whether the lead calls router_report_result / router_get_plan (deferred tool search).' },
  { id: 'R2', title: 'L2 change with a reviewer', taskId: 'c-l2-01', fixture: 'taskboard', kind: 'single', calls: 1, turns: 26, expect: "a reviewer runs; note whether the lead passes the reviewer's margin through router_report_result." },
  { id: 'R3', title: 're-ask the same prompt', taskId: 'c-l1-01', fixture: 'textkit', kind: 'reask', calls: 2, turns: 16, expect: 'acceptance of the first request becomes not_accepted (reask).' },
  { id: 'R4', title: 'revert then a follow-up', taskId: 'c-l1-01', fixture: 'textkit', kind: 'revert', follow: FOLLOW, calls: 2, turns: 15, expect: 'acceptance becomes not_accepted (reverted).' },
  { id: 'R5', title: 'commit then a follow-up', taskId: 'c-l1-01', fixture: 'textkit', kind: 'commit', follow: FOLLOW, calls: 2, turns: 15, expect: 'acceptance becomes accepted (committed).' },
  { id: 'R6', title: 'protected-path need (.env.example)', fixture: 'taskboard', prompt: 'Add a new setting EXAMPLE_FLAG: add the line `EXAMPLE_FLAG=false` to .env.example, and add a short note under a new "## Environment" heading at the end of README.md describing it.', kind: 'protected', calls: 1, turns: 12, expect: 'if delegated, the coder hits the guard on .env.example; the lead may call router_request_scope and get needs_user; no user turn in -p. Recorded, not forced.' },
];
const ONLY = (args.only ?? '').split(',').filter(Boolean);
const selected = ONLY.length ? R5S.filter(s => ONLY.includes(s.id)) : R5S;
const wantDash = args['no-dashboard'] !== 'true';
const promptOf = (s: R5) => s.prompt ?? task(s.taskId!).prompt as string;

function httpJson(port: number, method: string, pathname: string, opts: { cookie?: string; token?: string; body?: unknown } = {}): Promise<{ status: number; headers: any; text: string }> {
  return new Promise((resolve, reject) => {
    const data = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const headers: any = { host: `127.0.0.1:${port}` };
    if (data !== undefined) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    if (opts.cookie) headers['cookie'] = opts.cookie;
    if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, res => {
      let t = ''; res.setEncoding('utf8'); res.on('data', d => { t += d; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: t }));
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

function summarize(s: R5, repo: string, r1: any, r2: any): any {
  const sids = [r1?.out?.session_id, r2?.out?.session_id].filter(Boolean) as string[];
  const db = new DatabaseSync(path.join(HOME, 'router.db'), { readOnly: true });
  const q = (sql: string, ...p: any[]) => { try { return db.prepare(sql).all(...p) as any[]; } catch { return []; } };
  const inClause = (col: string, xs: string[]) => `${col} IN (${xs.map(() => '?').join(',') || "''"})`;
  const recs = q(`SELECT * FROM request_records WHERE ${inClause('session_id', sids)} ORDER BY created_at`, ...sids);
  const reqIds = recs.map(r => String(r.request_id));
  const subs = reqIds.length ? q(`SELECT * FROM subtasks WHERE ${inClause('request_id', reqIds)}`, ...reqIds) : [];
  const signals = reqIds.length ? q(`SELECT * FROM signals WHERE ${inClause('request_id', reqIds)}`, ...reqIds) : [];
  const tools = sids.length ? q(`SELECT DISTINCT tool_name FROM events WHERE ${inClause('session_id', sids)} AND tool_name LIKE 'mcp__plugin_agentic-router_router__%'`, ...sids) : [];
  db.close();
  const toolNames = tools.map(t => String(t.tool_name).replace('mcp__plugin_agentic-router_router__', ''));
  const first = recs[0] ?? {};
  const worktrees = execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' }).trim().split('\n').length - 1;
  const changed = execFileSync('git', ['status', '--short', '--', '.', ':!.claude', ':!.bench-hidden'], { cwd: repo, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const costUsd = Number(r1?.out?.total_cost_usd ?? 0) + Number(r2?.out?.total_cost_usd ?? 0);
  const turns = Number(r1?.out?.num_turns ?? 0) + Number(r2?.out?.num_turns ?? 0);
  const unexpected: string[] = [];
  if (r1?.code !== 0) unexpected.push(`r1 exit ${r1?.code}`);
  if (r2 && r2.code !== 0) unexpected.push(`r2 exit ${r2.code}`);
  if (!recs.length) unexpected.push('no request record for the session');
  if (worktrees > 0) unexpected.push(`${worktrees} leftover worktree(s)`);
  const envChanged = changed.some(c => c.includes('.env.example'));
  if (s.kind === 'protected' && envChanged) unexpected.push('.env.example was modified (guard should have blocked a subagent)');
  return {
    id: s.id, title: s.title, kind: s.kind,
    level: first.level ?? '?', finalLevel: first.final_level ?? '?', outcome: first.outcome ?? '?',
    acceptance: first.acceptance ?? null, acceptSignals: (() => { try { return JSON.parse(first.accept_signals ?? 'null'); } catch { return null; } })(),
    routerToolsSeen: toolNames,
    reportResultCalled: toolNames.includes('router_report_result'),
    requestScopeCalled: toolNames.includes('router_request_scope'),
    reviewSignals: signals.filter(x => String(x.kind) === 'review').length,
    subtasks: subs.map(x => ({ role: x.role, slot: x.slot, step: x.step, status: x.status, verdict: x.verdict })),
    requests: recs.length, envExampleChanged: envChanged,
    costUsd, turns, exit: [r1?.code, r2 ? r2.code : null], durationSec: Math.round(((r1?.ms ?? 0) + (r2?.ms ?? 0)) / 1000),
    changedFiles: changed, worktrees, promptHead: promptOf(s).replace(/\s+/g, ' ').slice(0, 48), unexpected,
  };
}

async function dashboardCheck(port: number, token: string, summaries: any[]): Promise<any> {
  try {
    const out = cli('dashboard', '--no-open');
    const m = out.match(/#code=([A-Za-z0-9_-]+)/);
    if (!m) return { ok: false, step: 'register-code', detail: out.trim().slice(0, 200) };
    const auth = await httpJson(port, 'POST', '/dashboard/auth', { body: { code: m[1] } });
    const cookie = (Array.isArray(auth.headers['set-cookie']) ? auth.headers['set-cookie'][0] : auth.headers['set-cookie'] ?? '').split(';')[0];
    if (auth.status !== 200 || !cookie) return { ok: false, step: 'auth', status: auth.status };
    const summary = await httpJson(port, 'GET', '/dashboard/metrics/summary', { cookie });
    const requests = await httpJson(port, 'GET', '/dashboard/metrics/requests?limit=50', { cookie });
    const total = (() => { try { return Number(JSON.parse(summary.text).total ?? 0); } catch { return 0; } })();
    const rows = (() => { try { return (JSON.parse(requests.text).rows ?? []).length; } catch { return 0; } })();
    const haystack = `${summary.text}\n${requests.text}`;
    const leaked = summaries.map(s => s.promptHead).filter((p: string) => p && p.length >= 12 && haystack.includes(p));
    return { ok: total > 0 && rows > 0 && leaked.length === 0, authStatus: auth.status, summaryTotal: total, requestRows: rows, promptLeak: leaked.length ? leaked : 'none' };
  } catch (e: any) { return { ok: false, step: 'exception', detail: String(e?.message ?? e).slice(0, 200) }; }
}

if (DRY) {
  const callTotal = selected.reduce((a, s) => a + s.calls, 0);
  const turnLo = selected.reduce((a, s) => a + Math.round(s.turns * 0.7), 0);
  const turnHi = selected.reduce((a, s) => a + Math.round(s.turns * 1.4), 0);
  console.log(`\n=== round 5 dry run — ${selected.length} scenario(s), lead model ${MODEL} ===`);
  for (const s of selected) {
    console.log(`\n${s.id}  ${s.title}  [${s.kind}]  fixture=${s.fixture}  claude -p calls=${s.calls}  ~turns≈${s.turns}`);
    console.log(`   prompt: ${promptOf(s).replace(/\s+/g, ' ').slice(0, 140)}`);
    if (s.kind === 'reask') console.log('   follow-up (--resume same session): <the same prompt again>');
    else if (s.follow) console.log(`   follow-up (--resume same session): ${s.follow}`);
    console.log(`   expect: ${s.expect}`);
  }
  console.log(`\nR7 dashboard check (no claude): ${wantDash ? 'register a code via `agentic-router dashboard --no-open`, exchange it for a cookie, GET summary + requests, assert the runs appear and no prompt text leaks' : 'skipped (--no-dashboard)'}`);
  console.log(`\nestimated subscription usage: ${callTotal} claude -p calls, roughly ${turnLo}-${turnHi} agent turns total (lead + subagents; depends on how the lead delegates). Each run caps at --max-budget-usd 3.`);
  console.log('no claude was run (dry run).');
  process.exit(0);
}

if (ROUND5) {
  cli('init', '--yes', '--claude-settings', path.join(TMP, 'claude-settings.json'), '--project', TMP);
  log(cli('start').trim());
  const port = (() => { try { return Number(JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8')).daemonPort); } catch { return 0; } })();
  const token = (() => { try { return fs.readFileSync(path.join(HOME, 'token'), 'utf8').trim(); } catch { return ''; } })();
  const summaries: any[] = [];
  for (const s of selected) {
    const repo = repoFrom(s.fixture, s.id);
    if (s.kind === 'protected') {
      fs.writeFileSync(path.join(repo, '.env.example'), 'EXISTING=1\n');
      execFileSync('git', ['add', '-A'], { cwd: repo }); execFileSync('git', ['commit', '-qm', 'env example'], { cwd: repo });
    }
    const prompt = promptOf(s);
    const r1 = await claude(repo, prompt);
    const sid = r1.out?.session_id as string | undefined;
    let r2: any = null;
    if (s.kind === 'reask') r2 = await claude(repo, prompt, 900, false, sid);
    else if (s.kind === 'revert') { execFileSync('git', ['checkout', '--', '.'], { cwd: repo }); r2 = await claude(repo, s.follow!, 900, false, sid); }
    else if (s.kind === 'commit') { execFileSync('git', ['add', '-A'], { cwd: repo }); execFileSync('git', ['commit', '-qm', 'accept the change'], { cwd: repo }); r2 = await claude(repo, s.follow!, 900, false, sid); }
    const sum = summarize(s, repo, r1, r2);
    summaries.push(sum);
    fs.writeFileSync(path.join(TMP, `${s.id}-summary.json`), JSON.stringify(sum, null, 2));
    log(`\n== ${s.id} ${s.title}: level=${sum.level} outcome=${sum.outcome} acceptance=${sum.acceptance} tools=[${sum.routerToolsSeen.join(', ') || 'none'}] reviewSignals=${sum.reviewSignals} cost=$${sum.costUsd.toFixed(4)} turns=${sum.turns}${sum.unexpected.length ? ' !! ' + sum.unexpected.join('; ') : ''}`);
  }
  let dash: any = { skipped: true };
  if (wantDash) { dash = await dashboardCheck(port, token, summaries); log(`\n== R7 dashboard: ${dash.ok ? 'OK' : 'ISSUE'} ${JSON.stringify(dash).slice(0, 300)}`); }
  log('\n== round 5 table');
  log('id   | level | outcome      | acceptance    | router tools seen                 | cost     | turns');
  for (const s of summaries) log(`${s.id.padEnd(4)} | ${String(s.level).padEnd(5)} | ${String(s.outcome).padEnd(12)} | ${String(s.acceptance).padEnd(13)} | ${(s.routerToolsSeen.join(',') || '-').padEnd(33)} | $${s.costUsd.toFixed(4).padStart(7)} | ${s.turns}`);
  fs.writeFileSync(path.join(TMP, 'round5-summary.json'), JSON.stringify({ model: MODEL, auth: AUTH, scenarios: summaries, dashboard: dash }, null, 2));
  log('\n' + cli('stop').trim());
  fs.writeFileSync(path.join(TMP, 'e2e-report.txt'), report.join('\n'));
  console.log(`\nreport: ${path.join(TMP, 'e2e-report.txt')}\nsummaries: ${TMP}`);
} else {
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
}
