// Aggregates results/runs.jsonl into per-config, per-level metrics:
// pass rate, cost per completed task (failures' cost included), and the effective cost
// coefficient relative to s1 (spec 3.5) and to the baseline config.
import fs from 'node:fs';
import path from 'node:path';
import type { RunRecord } from './types.ts';
import { RESULTS } from './util.ts';
import { loadMatrix } from './plan.ts';

export function loadRuns(): RunRecord[] {
  const p = path.join(RESULTS, 'runs.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
}

interface Cell { n: number; pass: number; cost: number; ms: number }

// A run whose grading never happened (Docker down, harness crash) says nothing about the model.
export const isUngraded = (r: RunRecord) => /^(not graded|harness produced no report)/.test(r.graded.detail);

export function buildReport(allRuns: RunRecord[]): string {
  if (!allRuns.length) return 'No runs recorded yet (results/runs.jsonl is empty).';
  const ungraded = allRuns.filter(isUngraded);
  const runs = allRuns.filter(r => !isUngraded(r));
  if (!runs.length) return `All ${ungraded.length} runs are ungraded (grading infrastructure failed); re-grade from results/patches/.`;
  const m = loadMatrix();
  const levels = [...new Set(runs.map(r => r.level))].sort();
  const configs = m.configs.map(c => c.id).filter(id => runs.some(r => r.configId === id));
  const cell = (cfg: string, lvl?: string): Cell => runs.filter(r => r.configId === cfg && (!lvl || r.level === lvl))
    .reduce((a, r) => ({ n: a.n + 1, pass: a.pass + (r.graded.pass ? 1 : 0), cost: a.cost + r.costUsd, ms: a.ms + r.durationMs }), { n: 0, pass: 0, cost: 0, ms: 0 });
  const cps = (c: Cell) => (c.pass ? c.cost / c.pass : Infinity);
  const fmt = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : '—');
  const lines: string[] = [];
  lines.push(`# Phase 0 benchmark report`, '', `runs: ${runs.length}, total cost: $${fmt(runs.reduce((a, r) => a + r.costUsd, 0), 2)}`, '');
  lines.push('## Cost per completed task (USD) and pass rate, by level', '');
  lines.push(`| config | ${levels.map(l => `${l} $/done (pass)`).join(' | ')} | all $/done | coef vs s1 | vs baseline |`);
  lines.push(`|---|${levels.map(() => '---').join('|')}|---|---|---|`);
  const s1 = cps(cell('s1'));
  const base = cps(cell(m.baseline));
  for (const c of configs) {
    const all = cell(c);
    const perLevel = levels.map(l => { const x = cell(c, l); return x.n ? `${fmt(cps(x))} (${x.pass}/${x.n})` : '—'; });
    lines.push(`| ${c} | ${perLevel.join(' | ')} | ${fmt(cps(all))} | ${fmt(cps(all) / s1, 2)} | ${fmt(cps(all) / base, 2)} |`);
  }
  lines.push('', '`$/done` = total cost of all runs ÷ number of passed runs (failed attempts are charged). `coef vs s1` is the effective cost coefficient of spec 3.5.');
  if (ungraded.length) lines.push('', `Excluded ${ungraded.length} ungraded run(s) (grading infrastructure failed; patches kept in results/patches/): ${ungraded.map(r => r.runId).join(', ')}`);
  return lines.join('\n');
}

export function writeReport(): string {
  const md = buildReport(loadRuns());
  fs.mkdirSync(RESULTS, { recursive: true });
  fs.writeFileSync(path.join(RESULTS, 'report.md'), md);
  return md;
}
