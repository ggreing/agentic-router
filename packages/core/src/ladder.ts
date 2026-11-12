// Default model x effort ladder (spec 3.5). Order confirmed by Phase 0 measurement (Appendix E).
import type { LadderStep, Step, Tier } from './types.ts';

export const DEFAULT_LADDER: readonly LadderStep[] = [
  { step: 's1', tier: 'T1', alias: 'haiku', effort: 'low', modelId: 'claude-haiku-5-5', optIn: false, coefficient: 1.0 },
  { step: 's2', tier: 'T1', alias: 'haiku', effort: 'high', modelId: 'claude-haiku-5-5', optIn: false, coefficient: 3.1 },
  { step: 's3', tier: 'T2', alias: 'sonnet', effort: 'medium', modelId: 'claude-sonnet-5-5', optIn: false, coefficient: 9.1 },
  { step: 's4', tier: 'T2', alias: 'sonnet', effort: 'high', modelId: 'claude-sonnet-5-5', optIn: false, coefficient: 15.3 },
  { step: 's5', tier: 'T3', alias: 'opus', effort: 'high', modelId: 'claude-opus-5-5', optIn: false, coefficient: 44.9 },
  { step: 's6', tier: 'T3', alias: 'opus', effort: 'xhigh', modelId: 'claude-opus-5-5', optIn: false, coefficient: 96.2 },
  { step: 's7', tier: 'T3+', alias: 'fable', effort: 'high', modelId: 'claude-fable-5-1', optIn: true },
];

export const STEPS: readonly Step[] = DEFAULT_LADDER.map(s => s.step);

export function ladderStep(step: Step, ladder: readonly LadderStep[] = DEFAULT_LADDER): LadderStep {
  const s = ladder.find(x => x.step === step);
  if (!s) throw new Error(`unknown ladder step: ${step}`);
  return s;
}

export function stepIndex(step: Step): number {
  return STEPS.indexOf(step);
}

/** Highest usable step: s6, or s7 when Fable is opted in. */
export function topStep(fableOptIn: boolean): Step {
  return fableOptIn ? 's7' : 's6';
}

export function stepUp(step: Step, fableOptIn = false): Step | null {
  const i = stepIndex(step);
  return i < stepIndex(topStep(fableOptIn)) ? STEPS[i + 1]! : null;
}

export function stepDown(step: Step): Step | null {
  const i = stepIndex(step);
  return i > 0 ? STEPS[i - 1]! : null;
}

export function tierOf(step: Step): Tier {
  return ladderStep(step).tier;
}

/** A step change that crosses a tier boundary changes the model, so a new subagent is started. */
export function crossesTier(from: Step, to: Step): boolean {
  return ladderStep(from).alias !== ladderStep(to).alias;
}

export function maxStep(a: Step, b: Step): Step {
  return stepIndex(a) >= stepIndex(b) ? a : b;
}

// ------------------------------------------------------------------ step-down (spec 3.5, decision 135)

/** This many easy passes in a row on a slot move it one step down for its next subtask. */
export const EASY_PASSES_FOR_STEP_DOWN = 2;
/** After a raise the slot stays at its new step for this many dispatches (floor lock). */
export const FLOOR_LOCK_TASKS = 2;

/**
 * A slot's state for moving down. An easy pass is a first attempt that passed verify without a fix round
 * and that a reviewer or tester accepted with margin "easy"; verify alone, or the lead's own word, is not one.
 */
export interface SlotAdjust {
  step: Step;
  /** Raises that still count against the 3-raise limit; a step-down gives one back. */
  upCount: number;
  easyStreak: number;
  /** Whether the slot's latest result was an easy pass (a result nobody reported as easy ends the streak). */
  lastEasy: boolean;
  /** Floor lock: while lockLeft > 0 the slot does not go below lockStep. */
  lockStep: Step | null;
  lockLeft: number;
  downCount: number;
}

export function newSlotAdjust(step: Step, upCount = 0): SlotAdjust {
  return { step, upCount, easyStreak: 0, lastEasy: false, lockStep: null, lockLeft: 0, downCount: 0 };
}

/**
 * An easy pass on the slot's latest subtask. The second in a row moves the slot one step down, unless it is
 * at the bottom step or the floor lock holds it; then the streak stays full and the next easy pass tries again.
 */
export function afterEasyPass(s: SlotAdjust): { state: SlotAdjust; steppedDownTo?: Step } {
  const easyStreak = Math.min(EASY_PASSES_FOR_STEP_DOWN, s.easyStreak + 1);
  const state = { ...s, easyStreak, lastEasy: true };
  if (easyStreak < EASY_PASSES_FOR_STEP_DOWN) return { state };
  const to = stepDown(s.step);
  if (!to) return { state };
  if (s.lockLeft > 0 && s.lockStep && stepIndex(to) < stepIndex(s.lockStep)) return { state };
  return {
    state: { ...state, step: to, upCount: Math.max(0, s.upCount - 1), easyStreak: 0, downCount: s.downCount + 1 },
    steppedDownTo: to,
  };
}

/** Any result that is not an easy pass (a plain accept, a reject, a failure) ends the streak. */
export function afterOtherResult(s: SlotAdjust): SlotAdjust {
  return { ...s, easyStreak: 0, lastEasy: false };
}

/** A raise to `to`: the streak ends and the slot is locked at the new step for the next dispatches. */
export function afterRaise(s: SlotAdjust, to: Step): SlotAdjust {
  return { ...s, step: to, upCount: s.upCount + 1, easyStreak: 0, lastEasy: false, lockStep: to, lockLeft: FLOOR_LOCK_TASKS };
}

/**
 * A new subtask takes the slot. A previous result that was not reported as an easy pass ends the streak;
 * the new subtask's own result is not known yet; one locked task is used up.
 */
export function atDispatch(s: SlotAdjust): SlotAdjust {
  const lockLeft = Math.max(0, s.lockLeft - 1);
  return { ...s, easyStreak: s.lastEasy ? s.easyStreak : 0, lastEasy: false, lockLeft, lockStep: lockLeft > 0 ? s.lockStep : null };
}
