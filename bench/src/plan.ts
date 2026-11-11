import path from 'node:path';
import type { Level, PlannedRun, RunConfig, Task } from './types.ts';
import { BENCH, readJson } from './util.ts';

interface Budget { totalUsd: number; perRunCapUsd: Record<Level, number> }
interface Estimates {
  pricingPerMTok: Record<string, { input: number; output: number }>;
  cacheMultipliers: { write: number; read: number };
  tokensPerRun: Record<Level, { cacheWrite: number; cacheRead: number; output: number }>;
  effortOutputMultiplier: Record<string, number>;
  measured?: Record<string, Partial<Record<Level, number>>>;   // mean cost per run from real runs
}
export interface Matrix { baseline: string; configs: RunConfig[] }

export const loadMatrix = () => readJson<Matrix>(path.join(BENCH, 'config', 'matrix.json'));
export const loadBudget = () => readJson<Budget>(path.join(BENCH, 'config', 'budget.json'));
const loadEstimates = () => readJson<Estimates>(path.join(BENCH, 'config', 'estimates.json'));

function tokenPrior(level: Level, model: string, effort: string, est: Estimates): number {
  const p = est.pricingPerMTok[model];
  const tk = est.tokensPerRun[level];
  const out = tk.output * (est.effortOutputMultiplier[effort] ?? 1);
  return (tk.cacheWrite * p.input * est.cacheMultipliers.write + tk.cacheRead * p.input * est.cacheMultipliers.read + out * p.output) / 1e6;
}

// Measured mean if this config/level has been run; otherwise the token prior scaled by how far
// the prior was off for the same model (mean of measured/prior over that model's measured pairs).
export function priorEstimate(task: Task, cfg: RunConfig, est = loadEstimates(), configs = loadMatrix().configs): number {
  const hit = est.measured?.[cfg.id]?.[task.level];
  if (hit !== undefined) return Math.round(hit * 10000) / 10000;
  const ratios: number[] = [];
  for (const c of configs.filter(c => c.model === cfg.model))
    for (const [lvl, usd] of Object.entries(est.measured?.[c.id] ?? {}))
      ratios.push((usd as number) / tokenPrior(lvl as Level, c.model, c.effort, est));
  const k = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 1;
  return Math.round(tokenPrior(task.level, cfg.model, cfg.effort, est) * k * 10000) / 10000;
}

export function buildPlan(tasks: Task[], configs: RunConfig[], reps: number): PlannedRun[] {
  const budget = loadBudget();
  const est = loadEstimates();
  const runs: PlannedRun[] = [];
  for (let rep = 1; rep <= reps; rep++)
    for (const task of tasks)
      for (const config of configs)
        runs.push({
          runId: `${task.id}__${config.id}__r${rep}`, task, config, rep,
          capUsd: budget.perRunCapUsd[task.level],
          estUsd: Math.min(priorEstimate(task, config, est), budget.perRunCapUsd[task.level]),
        });
  return runs;
}

export function summarize(runs: PlannedRun[]) {
  const byLevel: Record<string, { runs: number; est: number; cap: number }> = {};
  const byConfig: Record<string, { runs: number; est: number }> = {};
  for (const r of runs) {
    const l = (byLevel[r.task.level] ??= { runs: 0, est: 0, cap: 0 });
    l.runs++; l.est += r.estUsd; l.cap += r.capUsd;
    const c = (byConfig[r.config.id] ??= { runs: 0, est: 0 });
    c.runs++; c.est += r.estUsd;
  }
  const est = runs.reduce((a, r) => a + r.estUsd, 0);
  const cap = runs.reduce((a, r) => a + r.capUsd, 0);
  return { runs: runs.length, est, cap, byLevel, byConfig };
}
