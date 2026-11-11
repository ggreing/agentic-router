// Team presets per difficulty level (spec 3.2, decisions 46-47) and the YAML loader.
import fs from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Level, TeamPreset } from './types.ts';

/**
 * Per-request budgets are PROVISIONAL (spec Appendix B: decided after Phase 0 targets).
 * Until a decision is recorded, these values only bound runaway cost.
 */
export const PROVISIONAL_BUDGET_USD: Record<Level, number> = { L0: 0.5, L1: 2, L2: 5, L3: 15 };

export const DEFAULT_PRESETS: Record<Level, TeamPreset> = {
  L0: { id: 'L0', level: 'L0', leadMayAdjust: false, budgetUsd: PROVISIONAL_BUDGET_USD.L0, leadDirect: true,
    roles: [{ role: 'coder', count: 1, start: 's1' }] },   // coder is used only if the user forces delegation
  // Decision 88: L1 is also lead-direct by default (round 4: delegation 7% cheaper but 1.8x slower);
  // users who prefer lower usage set `L1: { lead_direct: false }` in teams.yaml.
  L1: { id: 'L1', level: 'L1', leadMayAdjust: true, budgetUsd: PROVISIONAL_BUDGET_USD.L1, leadDirect: true,
    roles: [{ role: 'coder', count: 1, start: 's1' }, { role: 'reviewer', count: 1, start: 's1' }] },
  L2: { id: 'L2', level: 'L2', leadMayAdjust: true, budgetUsd: PROVISIONAL_BUDGET_USD.L2,
    roles: [
      { role: 'architect', count: 1, start: 's3' },
      { role: 'coder', count: 2, start: 's1' },
      { role: 'reviewer', count: 1, start: 's3' },
      { role: 'tester', count: 1, start: 's1' },
    ] },
  L3: { id: 'L3', level: 'L3', leadMayAdjust: true, budgetUsd: PROVISIONAL_BUDGET_USD.L3,
    roles: [
      { role: 'architect', count: 1, start: 's5' },
      { role: 'ui-designer', count: 1, start: 's3' },
      { role: 'coder', count: 2, start: 's5' },
      { role: 'reviewer', count: 1, start: 's5' },
      { role: 'tester', count: 1, start: 's1' },
    ] },
};

const step = z.enum(['s1', 's2', 's3', 's4', 's5', 's6', 's7']);
const role = z.enum(['architect', 'ui-designer', 'coder', 'reviewer', 'tester']);
// zod 4: z.record with enum keys is exhaustive; a teams.yaml may list only some levels
const presetFile = z.partialRecord(z.enum(['L0', 'L1', 'L2', 'L3']), z.object({
  // every field is optional: `L1: { lead_direct: false }` alone keeps the base roles (decision 88)
  roles: z.array(z.object({ role, count: z.number().int().min(0).max(4), start: step })).min(1).optional(),
  lead_may_adjust: z.boolean().optional(),
  lead_direct: z.boolean().optional(),
  budget_usd: z.number().positive().optional(),
}).strict());

/**
 * Loads a teams.yaml on top of `base` (the defaults, or the user file when layering the repository
 * file over it). Fields a level does not set come from `base`. Throws on invalid files.
 */
export function loadPresets(file?: string, base: Record<Level, TeamPreset> = DEFAULT_PRESETS): Record<Level, TeamPreset> {
  const out: Record<Level, TeamPreset> = structuredClone(base);
  if (!file || !fs.existsSync(file)) return out;
  const parsed = presetFile.parse(parse(fs.readFileSync(file, 'utf8')) ?? {});
  for (const [lvl, p] of Object.entries(parsed) as Array<[Level, z.infer<typeof presetFile>[Level]]>) {
    if (!p) continue;
    const prev = out[lvl];
    const leadDirect = p.lead_direct ?? prev.leadDirect;
    out[lvl] = { id: lvl, level: lvl, roles: p.roles ?? prev.roles, leadMayAdjust: p.lead_may_adjust ?? prev.leadMayAdjust,
      budgetUsd: p.budget_usd ?? prev.budgetUsd, ...(leadDirect ? { leadDirect } : {}) };
  }
  return out;
}
