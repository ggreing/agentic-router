// Routing auto-release (spec 3.8, decision 138): the rules that need no ledger.
//
// Only one arrangement is seen per request, so "would direct have been cheaper" has no answer in the
// records. The baseline is therefore measured on the user's own work: a small random share of the
// requests at a delegated level is handled lead-direct on purpose (the holdout). Cost per accepted task of
// the delegated requests is compared with that of the holdout. With a few dozen requests per arm this
// can tell a gross loss (about 2x) from none, not a small one, so the thresholds are wide and the default
// mode only observes: it reports what it would do and switches nothing until the user turns it on.
import type { Level } from './types.ts';

export type AutoReleaseMode = 'on' | 'observe' | 'off';
export const DEFAULT_AUTO_RELEASE: AutoReleaseMode = 'observe';
export const DEFAULT_HOLDOUT_RATE = 0.1;
export const MAX_HOLDOUT_RATE = 0.2;

/** A configured holdout rate brought into 0..MAX_HOLDOUT_RATE; anything unusable gives the default. */
export function holdoutRate(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(MAX_HOLDOUT_RATE, v) : DEFAULT_HOLDOUT_RATE;
}

/**
 * Whether a request is in the minority arm: lead-direct while its level is delegated, or delegated as a probe
 * while its level is released. Decided by the request id alone, so a replayed event gives the same answer.
 */
export function holdoutDraw(requestId: string, rate: number): boolean {
  if (!(rate > 0)) return false;
  let h = 0x811c9dc5;   // FNV-1a, 32 bit
  for (let i = 0; i < requestId.length; i++) {
    h ^= requestId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // one more mixing round: ids that differ only in their last characters must not land next to each other
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16;
  return (h >>> 0) / 2 ** 32 < rate;
}

// ------------------------------------------------------------------ the comparison

/** The requests of one arrangement in the window: all of them, how many count as accepted, and what all of them cost. */
export interface Arm { n: number; accepted: number; costUsd: number }

/** Cost per accepted task: the cost of every request of the arm, failed and not accepted ones too, over the accepted ones. */
export function costPerAccepted(a: Arm): number | null {
  return a.accepted > 0 ? a.costUsd / a.accepted : null;
}

export const RELEASE_RULE = {
  /** Requests needed in the majority arm and in the minority arm (holdout, or probes while released). */
  majorityMin: 30,
  minorityMin: 10,
  /** Release when delegated cost per accepted task is above this multiple of direct. */
  releaseAbove: 1.5,
  /** Re-enable when it is at or below this multiple. Between the two nothing changes (hysteresis). */
  reenableAtOrBelow: 1.0,
  /** Only requests of the last this many days are counted. */
  windowDays: 60,
} as const;

export type ReleaseAction = 'hold' | 'release' | 'reenable';
export type ReleaseReason = 'not_enough_data' | 'no_direct_cost' | 'delegated_dearer' | 'delegated_not_dearer' | 'inside_band';

export interface ReleaseDecision {
  action: ReleaseAction;
  reason: ReleaseReason;
  /** Delegated cost per accepted task over direct; null when one side has no accepted task. */
  ratio: number | null;
  delegatedCost: number | null;
  directCost: number | null;
  /** How far the arms are from full: counted and needed. */
  need: { delegated: [number, number]; direct: [number, number] };
}

/**
 * What the comparison says for one level of one lead class. `released`: the level is handled lead-direct now,
 * so the delegated arm is the probes (the minority) and the direct arm the majority. The caller applies the
 * action only in mode 'on'; in 'observe' it is shown.
 */
export function decideRelease(i: { released: boolean; delegated: Arm; direct: Arm }, rule: typeof RELEASE_RULE = RELEASE_RULE): ReleaseDecision {
  const needDelegated = i.released ? rule.minorityMin : rule.majorityMin;
  const needDirect = i.released ? rule.majorityMin : rule.minorityMin;
  const delegatedCost = costPerAccepted(i.delegated);
  const directCost = costPerAccepted(i.direct);
  const base = { delegatedCost, directCost, need: { delegated: [i.delegated.n, needDelegated] as [number, number], direct: [i.direct.n, needDirect] as [number, number] } };
  if (i.delegated.n < needDelegated || i.direct.n < needDirect) return { action: 'hold', reason: 'not_enough_data', ratio: null, ...base };
  if (directCost === null || directCost <= 0) return { action: 'hold', reason: 'no_direct_cost', ratio: null, ...base };
  // a full delegated arm without one accepted task is the gross loss this rule exists for
  const ratio = delegatedCost === null ? Infinity : delegatedCost / directCost;
  const shown = Number.isFinite(ratio) ? Math.round(ratio * 1000) / 1000 : null;
  if (!i.released && ratio > rule.releaseAbove) return { action: 'release', reason: 'delegated_dearer', ratio: shown, ...base };
  if (i.released && ratio <= rule.reenableAtOrBelow) return { action: 'reenable', reason: 'delegated_not_dearer', ratio: shown, ...base };
  const reason: ReleaseReason = ratio > rule.releaseAbove ? 'delegated_dearer' : ratio > rule.reenableAtOrBelow ? 'inside_band' : 'delegated_not_dearer';
  return { action: 'hold', reason, ratio: shown, ...base };
}

// ------------------------------------------------------------------ what a release changes

const ORDER: readonly Level[] = ['L0', 'L1', 'L2', 'L3'];

/**
 * A release raises the first delegated level of a lead class by one, bottom-up: releasing L1 means "delegate
 * from L2", releasing L2 "delegate from L3" (teams then only by /router level or the lead's own choice).
 * Null: nothing left to release.
 */
export function releasedFrom(delegateFrom: Level): Level | null {
  const i = ORDER.indexOf(delegateFrom);
  return i >= 1 && i < ORDER.length - 1 ? ORDER[i + 1]! : null;
}

/** The start level in effect: the automatic one only ever raises the configured one. */
export function effectiveDelegateFrom(configured: Level, auto: Level | null | undefined): Level {
  return auto && ORDER.indexOf(auto) > ORDER.indexOf(configured) ? auto : configured;
}
