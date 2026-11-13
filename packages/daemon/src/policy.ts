// Agent-call rules for the lead (decisions Q3 and Q5, 2026-11-10).
// - Only subagent types `do-it-all-claude-code:<role>` are managed; others pass untouched.
// - First prompt line must be `[subtask:<ID>]`; optional second line `[scope: glob, glob]`.
// - model/effort must equal the slot's ladder step (Phase 1: the preset start step); otherwise deny
//   with the expected values. A role the preset lacks: deny when the lead may not adjust the team
//   (L0), else expect the role's default start step for that level.
// - s7 needs fableOptIn; usedUsd >= budgetUsd denies.
import { DEFAULT_LADDER, PROTECTED_WRITE_PATHS } from '@do-it-all-claude-code/core';
import type { LadderStep, Level, Role, Step, TeamPreset } from '@do-it-all-claude-code/core';

export const MANAGED_PREFIX = 'do-it-all-claude-code:';
export const ROLES: readonly Role[] = ['architect', 'ui-designer', 'coder', 'reviewer', 'tester'];

/** Role of a managed agent type; null for a managed type with an unknown role; undefined when unmanaged. */
export function managedRole(agentType: string | undefined): Role | null | undefined {
  if (!agentType || !agentType.startsWith(MANAGED_PREFIX)) return undefined;
  const r = agentType.slice(MANAGED_PREFIX.length);
  return (ROLES as readonly string[]).includes(r) ? (r as Role) : null;
}

export const isAgentTool = (toolName: string | undefined) => toolName === 'Agent' || toolName === 'Task';

/** Decision Q3: default start step of a role at a level when the preset does not list it. */
const BASE_START: Record<Role, Step> = { architect: 's3', 'ui-designer': 's3', coder: 's1', reviewer: 's3', tester: 's1' };
const LEVEL_START: Partial<Record<Level, Partial<Record<Role, Step>>>> = {
  L1: { reviewer: 's1' },
  L3: { architect: 's5', coder: 's5', reviewer: 's5' },
};

export function defaultStartStep(level: Level, role: Role): Step {
  return LEVEL_START[level]?.[role] ?? BASE_START[role];
}

/** Ladder step for an Agent call's model + effort. `model` may be the alias or the pinned model id. */
/** The step a role starts at in a preset (its member's start, else the level's default). */
export function startStep(preset: TeamPreset, level: Level, role: Role): Step {
  return preset.roles.find(r => r.role === role && r.count > 0)?.start ?? defaultStartStep(level, role);
}

export function stepOf(model: string | undefined, effort: string | undefined, ladder: readonly LadderStep[] = DEFAULT_LADDER): LadderStep | undefined {
  if (!model || !effort) return undefined;
  return ladder.find(s => (s.alias === model || s.modelId === model) && s.effort === effort);
}

// ------------------------------------------------------------------ prompt lines

const TAG = /^\s*\[subtask:\s*([A-Za-z0-9_.-]{1,64})\s*\]/;
const SCOPE = /^\s*\[scope:([^\]]*)\]\s*$/;

export function parseTag(prompt: string | undefined): string | undefined {
  const first = (prompt ?? '').split(/\r?\n/, 1)[0] ?? '';
  return TAG.exec(first)?.[1];
}

export type ScopeParse = { ok: true; allowed: string[]; unscoped: boolean } | { ok: false; reason: string };

/** Decision Q5: second prompt line `[scope: a/**, b/**]`; without it the whole repository is allowed. */
export function parseScope(prompt: string | undefined): ScopeParse {
  const second = (prompt ?? '').split(/\r?\n/)[1] ?? '';
  const m = SCOPE.exec(second);
  if (!m) return { ok: true, allowed: ['**'], unscoped: true };
  const globs = m[1]!.split(',').map(g => g.trim().replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean);
  if (!globs.length) return { ok: false, reason: 'the [scope: ...] line is empty: list repo-relative globs, or remove the line to allow the whole repository' };
  const bad = globs.filter(g => g.startsWith('/') || /^[A-Za-z]:/.test(g) || g.split('/').includes('..') || g.startsWith('~'));
  if (bad.length) return { ok: false, reason: `scope globs must be repo-relative (no absolute paths, "~" or ".."): ${bad.join(', ')}` };
  return { ok: true, allowed: globs, unscoped: false };
}

export function scopeFileBody(allowed: string[], unscoped: boolean) {
  return { allowed, protected: [...PROTECTED_WRITE_PATHS], ...(unscoped ? { unscoped: true } : {}) };
}

// ------------------------------------------------------------------ the check

export interface AgentCallInput {
  tag: string;
  role: Role;
  model?: string;
  effort?: string;
  level: Level;
  preset: TeamPreset;
  budgetUsd: number;
  spentUsd: number;
  fableOptIn: boolean;
  busySlots: number[];          // slots of this role whose subtask is pending or running
  tagBusy: boolean;             // the same subtask ID is already pending or running
  /** Spec 3.5: the step a slot of this role was raised to after a miss (absent: the preset's start). */
  slotSteps?: Record<number, Step>;
  ladder?: readonly LadderStep[];
}

export type AgentCallCheck = { ok: true; slot: number; step: Step } | { ok: false; reason: string };

const describe = (s: LadderStep) => `model="${s.alias}", effort="${s.effort}"`;

export function checkAgentCall(i: AgentCallInput): AgentCallCheck {
  const ladder = i.ladder ?? DEFAULT_LADDER;
  const id = `subtask ${i.tag}`;
  if (i.spentUsd >= i.budgetUsd) {
    return { ok: false, reason: `${id}: the ${i.level} request budget is used up ($${i.spentUsd.toFixed(4)} of $${i.budgetUsd}). Do not start more subagents; report progress to the user and ask how to continue.` };
  }
  if (i.tagBusy) return { ok: false, reason: `${id} is already running; wait for it to finish or use a new subtask ID.` };

  const member = i.preset.roles.find(r => r.role === i.role && r.count > 0);
  if (!member && !i.preset.leadMayAdjust) {
    const team = i.preset.roles.map(r => `${r.role} x${r.count}`).join(', ');
    return { ok: false, reason: `${id}: the ${i.level} team is fixed (${team}); a ${i.role} cannot be added.` };
  }
  const start = member?.start ?? defaultStartStep(i.level, i.role);
  const stepFor = (slot: number): Step => i.slotSteps?.[slot] ?? start;

  // Free slots of the role, in order; past the team's count only when the lead may adjust the team.
  const count = member?.count ?? 0;
  const free: number[] = [];
  for (let s = 0; s < count; s++) if (!i.busySlots.includes(s)) free.push(s);
  if (!free.length) {
    if (!i.preset.leadMayAdjust) return { ok: false, reason: `${id}: all ${count} ${i.role} slot(s) of the ${i.level} team are busy; wait for one to finish (a subtask that was allowed but never started can be dispatched again with the same ID).` };
    free.push(firstFree(i.busySlots, count, Number.MAX_SAFE_INTEGER)!);
  }
  const expected = stepFor(free[0]!);
  const exp = ladder.find(s => s.step === expected);
  if (!exp) return { ok: false, reason: `${id}: ladder step ${expected} is not defined.` };
  const where = (slot: number) => (i.slotSteps?.[slot] ? ` (slot ${slot} was raised to ${i.slotSteps[slot]} after a miss)` : '');

  if (exp.optIn && !i.fableOptIn) return { ok: false, reason: `${id}: step ${expected} needs the Fable opt-in, which is off.` };
  const asked = stepOf(i.model, i.effort, ladder);
  if (!i.model || !i.effort) {
    return { ok: false, reason: `${id}: pass model and effort on the Agent call. The ${i.role} runs at step ${expected} (${describe(exp)}) for this ${i.level} request${where(free[0]!)}.` };
  }
  if (asked?.optIn && !i.fableOptIn) return { ok: false, reason: `${id}: step ${asked.step} (Fable) needs the opt-in, which is off. Use ${describe(exp)}.` };
  // the first free slot takes the call, at its own step: a slot raised after a miss is used next (spec 3.5)
  const slot = free[0]!;
  if (!asked || asked.step !== stepFor(slot)) {
    return { ok: false, reason: `${id}: the ${i.role} runs at step ${expected} (${describe(exp)}) for this ${i.level} request${where(free[0]!)}, but the call asked for model="${i.model}", effort="${i.effort}". Call again with ${describe(exp)}.` };
  }
  return { ok: true, slot, step: stepFor(slot) };
}

function firstFree(busy: number[], from: number, to: number): number | undefined {
  for (let s = from; s < to; s++) if (!busy.includes(s)) return s;
  return undefined;
}
