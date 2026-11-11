// Live status of the decision-107 measurement: node scripts/m107-status.mjs [--watch] [--log <stdout file>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirArg = process.argv.indexOf('--dir');
const RUNS = path.join(dirArg > 0 ? path.resolve(process.argv[dirArg + 1]) : path.join(ROOT, 'bench', 'results', 'measure107'), 'runs.jsonl');
// optional: the file measure107's stdout is redirected to, to show the run in progress
const logArg = process.argv.indexOf('--log');
const LOG = logArg > 0 ? process.argv[logArg + 1] : process.env.M107_LOG ?? '';
const TOTAL = Number(process.env.M107_TOTAL ?? (dirArg > 0 ? 30 : 45)), BUDGET = Number(process.env.M107_BUDGET ?? (dirArg > 0 ? 10 : 50));

function show() {
  const runs = fs.existsSync(RUNS) ? fs.readFileSync(RUNS, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const spent = runs.reduce((a, r) => a + (r.costUsd || 0), 0);
  const byTask = new Map();
  for (const r of runs) { if (!byTask.has(r.taskId)) byTask.set(r.taskId, { level: r.level }); byTask.get(r.taskId)[r.arrangement] = r; }
  const cell = r => !r ? '      -      ' : r.budgetStop ? '  (budget)   ' : `${r.passed ? 'PASS' : 'FAIL'} $${r.costUsd.toFixed(2).padStart(5)} ${String(r.wallSeconds).padStart(4)}s`.padEnd(13);
  const lines = [`decision 107 measurement — ${runs.length}/${TOTAL} runs, spent $${spent.toFixed(2)} / $${BUDGET}   (${new Date().toLocaleTimeString()})`, '',
    `${'task'.padEnd(30)} lvl  ${'direct'.padEnd(18)} ${'team-L2'.padEnd(18)} team-L3`];
  for (const [id, t] of byTask) lines.push(`${id.slice(0, 30).padEnd(30)} ${t.level}   ${cell(t.direct).padEnd(18)} ${cell(t['team-L2']).padEnd(18)} ${cell(t['team-L3'])}`);
  if (LOG && fs.existsSync(LOG)) {
    const now = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(l => l.startsWith('run ')).pop();
    if (now) lines.push('', `now: ${now.replace(/^run /, '')}`);
  }
  console.log(lines.join('\n'));
}

if (process.argv.includes('--watch')) {
  const tick = () => { process.stdout.write('\x1Bc'); show(); };
  tick(); setInterval(tick, 15000);
} else show();
