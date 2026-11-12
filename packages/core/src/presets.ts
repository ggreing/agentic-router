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
  // Decisions 88, 117, 118: L1 is lead-direct unless the lead model delegates from L1 (an Opus-class lead:
  // decision-107 measurement, delegating L1 cost 49% less). When delegated, L1 is the light team: one coder.
  L1: { id: 'L1', level: 'L1', leadMayAdjust: true, budgetUsd: PROVISIONAL_BUDGET_USD.L1, leadDirect: true,
    roles: [{ role: 'coder', count: 1, start: 's1' }] },
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

/** Lead (main session) model tiers that decide where delegation starts (decision 117). Fable counts as Opus-class. */
export type LeadModelClass = 'opus' | 'sonnet' | 'haiku' | 'other';

export function leadModelClass(modelId?: string): LeadModelClass {
  const m = (modelId ?? '').toLowerCase();
  if (/opus|fable/.test(m)) return 'opus';
  if (/sonnet/.test(m)) return 'sonnet';
  if (/haiku/.test(m)) return 'haiku';
  return 'other';
}

/**
 * First level that is delegated, per lead model tier (decisions 117, 124). Below it the lead handles the
 * request itself. L0 is always lead-direct. Unknown lead model -> 'other', which delegates from L1 as well
 * (decision 144): both measured lead classes do, a Haiku main session is rare, and being wrong for one costs
 * little. Claude Code 2.1.322 sends no model in SessionStart or UserPromptSubmit, so the first prompt of a
 * session often has no lead model yet.
 * Decision-107 measurement: delegating L1 cost 49% less with an Opus lead at the same speed, and 42% less
 * with a Sonnet lead (about 20 s slower per request), so both delegate from L1. A Haiku lead is not
 * measured: its workers would run the same model, so it keeps L1 itself.
 */
export const DEFAULT_DELEGATE_FROM: Record<LeadModelClass, Level> = { opus: 'L1', sonnet: 'L1', haiku: 'L2', other: 'L1' };

const ORDER: Level[] = ['L0', 'L1', 'L2', 'L3'];

/**
 * Presets with leadDirect set for this lead model (decisions 117-118). Apply before teams.yaml: an explicit
 * `lead_direct` in teams.yaml still wins because loadPresets keeps fields the file does not set.
 */
export function withLeadModel(presets: Record<Level, TeamPreset>, leadModelId?: string,
  delegateFrom: Partial<Record<LeadModelClass, Level>> = {}): Record<Level, TeamPreset> {
  const from = { ...DEFAULT_DELEGATE_FROM, ...delegateFrom }[leadModelClass(leadModelId)];
  const out = structuredClone(presets);
  for (const l of ORDER) {
    const direct = l === 'L0' || ORDER.indexOf(l) < ORDER.indexOf(from);
    const { leadDirect: _drop, ...rest } = out[l];
    out[l] = direct ? { ...rest, leadDirect: true } : rest;
  }
  return out;
}
