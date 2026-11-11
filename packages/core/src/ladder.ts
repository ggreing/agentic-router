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
