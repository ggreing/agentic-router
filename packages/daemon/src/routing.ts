// Routing auto-release over the ledger (spec 3.8, decision 138): the two arms per lead class and level, what
// the rule says about them, and the view the status, the plan and the dashboard show. The rule itself is
// core's (release.ts); nothing here writes except applyRelease.
//
// Arms. While a level is delegated: the requests the rules or the judge planned at it and a team handled,
// against the holdout (the same kind of request handled lead-direct on purpose). While it is released: the
// probes (delegated on purpose), against the requests handled lead-direct because of the release. The two
// pairs are kept apart, so what was measured before a release does not decide the way back. Left out of all:
// forced and manual levels, requests the lead re-planned, requests with a partly unknown cost, requests the
// lead took over after delegating (decision 145), and requests without changes (acceptance n/a).
import {
  DEFAULT_AUTO_RELEASE, DEFAULT_DELEGATE_FROM, RELEASE_RULE, costPerAccepted, countsAsAccepted, decideRelease, effectiveDelegateFrom, holdoutRate,
  releasedFrom, type Acceptance, type Arm, type AutoReleaseMode, type LeadModelClass, type Level, type ReleaseDecision,
} from '@do-it-all-claude-code/core';
import type { Ledger } from './ledger.ts';

const ORDER: readonly Level[] = ['L0', 'L1', 'L2', 'L3'];
/** Levels a release can apply to: L0 is always direct, L3 teams are never automatic (decision 119). */
export const RELEASE_LEVELS: readonly Level[] = ['L1', 'L2'];
export const LEAD_CLASSES: readonly LeadModelClass[] = ['opus', 'sonnet', 'haiku', 'other'];

export interface RoutingConfig {
  autoRelease?: AutoReleaseMode;
  holdoutRate?: number;
  delegateFrom?: Partial<Record<LeadModelClass, Level>>;
}

export const routingMode = (c: RoutingConfig): AutoReleaseMode => c.autoRelease ?? DEFAULT_AUTO_RELEASE;
/**
 * The holdout share in effect: none when auto-release is off, and none when the configuration carries no
 * rate at all (a router built without a config file; the file reader fills in the default of 0.1).
 */
export const routingHoldoutRate = (c: RoutingConfig): number => (routingMode(c) === 'off' || c.holdoutRate === undefined ? 0 : holdoutRate(c.holdoutRate));

interface RecordBlob {
  plan?: { level?: Level; leadDirect?: boolean; leadClass?: string | null; holdout?: string | null; forcedFrom?: Level | null; manualLevel?: Level | null; replannedFrom?: Level | null };
  outcome?: string;
  subtasks?: Array<{ status: string; verdict?: string | null }>;
  costs?: { unknown?: boolean };
}

/**
 * Verify said the request's work is fine: a direct request, or every subtask passed. A writer that changed
 * nothing (decision 145: hitl / no_changes) is neither a pass nor a miss, so it does not make the request fail;
 * a miss or a reject that waits for the user (hitl / miss, hitl / rejected) still does.
 */
export function recordVerifyOk(rec: { outcome?: string; subtasks?: Array<{ status: string; verdict?: string | null }> }): boolean {
  const subs = rec.subtasks ?? [];
  if (!subs.length) return rec.outcome !== 'no_delegation';
  return subs.every(x => x.status === 'passed' || (x.status === 'hitl' && x.verdict === 'no_changes'));
}

export interface Arms {
  /** While the level is delegated: team requests, and the holdout handled lead-direct. */
  delegated: Arm; direct: Arm;
  /** While the level is released: probes handled by a team, and the requests handled lead-direct. */
  probe: Arm; releasedDirect: Arm;
}
const arm0 = (): Arm => ({ n: 0, accepted: 0, costUsd: 0 });
const emptyArms = (): Arms => ({ delegated: arm0(), direct: arm0(), probe: arm0(), releasedDirect: arm0() });
/** The pair the rule compares in a state. */
const pairOf = (a: Arms, released: boolean): { delegated: Arm; direct: Arm } => (released ? { delegated: a.probe, direct: a.releasedDirect } : { delegated: a.delegated, direct: a.direct });
const key = (leadClass: string, level: Level) => `${leadClass}|${level}`;

/** The arms of every (lead class, level), from the records of the rule's window; each arm holds its latest requests. */
export function releaseArms(ledger: Ledger, nowIso: string, rule: typeof RELEASE_RULE = RELEASE_RULE): Map<string, Arms> {
  const since = new Date(Date.parse(nowIso) - rule.windowDays * 86_400_000).toISOString();
  const rows = ledger.db.prepare('SELECT total_usd, acceptance, record FROM request_records WHERE closed_at >= ? ORDER BY closed_at DESC, rowid DESC').all(since) as Array<Record<string, unknown>>;
  const out = new Map<string, Arms>();
  for (const r of rows) {
    let rec: RecordBlob;
    try { rec = JSON.parse(String(r.record)) as RecordBlob; } catch { continue; }
    const p = rec.plan ?? {};
    const acceptance = (r.acceptance ?? null) as Acceptance | null;
    if (!p.level || !RELEASE_LEVELS.includes(p.level) || !p.leadClass) continue;
    // decision 145: a request the lead took over after delegating credits a delegation that did not happen
    if (p.forcedFrom || p.manualLevel || p.replannedFrom || rec.costs?.unknown || rec.outcome === 'lead_takeover') continue;
    if (acceptance === null || acceptance === 'n/a') continue;
    const direct = p.leadDirect === true;
    const which: keyof Arms | undefined = direct
      ? (p.holdout === 'direct' ? 'direct' : p.holdout === 'released' ? 'releasedDirect' : undefined)   // direct by configuration: no arm
      : (p.holdout === 'probe' ? 'probe' : p.holdout === null || p.holdout === undefined ? 'delegated' : undefined);
    if (!which) continue;
    const k = key(p.leadClass, p.level);
    const arms = out.get(k) ?? emptyArms();
    out.set(k, arms);
    const arm = arms[which];
    if (arm.n >= rule.majorityMin) continue;   // the latest requests only
    arm.n++;
    arm.costUsd += Number(r.total_usd ?? 0);
    if (countsAsAccepted(acceptance) && recordVerifyOk(rec)) arm.accepted++;
  }
  return out;
}

export interface ArmView extends Arm { costPerAcceptedUsd: number | null }
export interface RoutingLevelView {
  level: Level;
  /** Whether the lead class delegates this level by configuration at all (otherwise there is nothing to compare). */
  delegatedByConfig: boolean;
  /** Handled lead-direct now because the auto-release raised the start level (mode 'on' only). */
  released: boolean;
  /** The level the rule looks at now: the lowest delegated one (for a release) or the last released one (for a re-enable). */
  candidate: boolean;
  /** The two arms compared in the level's state: team requests against the holdout, or probes against released requests. */
  delegated: ArmView;
  direct: ArmView;
  decision: ReleaseDecision;
}
export interface RoutingClassView {
  leadClass: LeadModelClass;
  configuredFrom: Level;
  /** The start level the auto-release decided, kept while the mode is not 'on' but not applied. */
  autoFrom: Level | null;
  effectiveFrom: Level;
  levels: RoutingLevelView[];
}
export interface RoutingView {
  mode: AutoReleaseMode;
  holdoutRate: number;
  rule: typeof RELEASE_RULE;
  classes: RoutingClassView[];
}

const armView = (a: Arm): ArmView => ({ ...a, costUsd: round6(a.costUsd), costPerAcceptedUsd: (c => (c === null ? null : round6(c)))(costPerAccepted(a)) });
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

function classView(ledger: Ledger, cfg: RoutingConfig, leadClass: LeadModelClass, arms: Map<string, Arms>): RoutingClassView {
  const configuredFrom = { ...DEFAULT_DELEGATE_FROM, ...cfg.delegateFrom }[leadClass];
  const autoFrom = ledger.getRelease(leadClass)?.autoDelegateFrom ?? null;
  const effectiveFrom = effectiveDelegateFrom(configuredFrom, routingMode(cfg) === 'on' ? autoFrom : null);
  const idx = (l: Level) => ORDER.indexOf(l);
  const lastReleased = idx(effectiveFrom) > idx(configuredFrom) ? ORDER[idx(effectiveFrom) - 1]! : null;
  const levels = RELEASE_LEVELS.map(level => {
    const a = arms.get(key(leadClass, level)) ?? emptyArms();
    const delegatedByConfig = idx(level) >= idx(configuredFrom);
    const released = delegatedByConfig && idx(level) < idx(effectiveFrom);
    const pair = pairOf(a, released);
    return {
      level, delegatedByConfig, released, candidate: delegatedByConfig && (level === effectiveFrom || level === lastReleased),
      delegated: armView(pair.delegated), direct: armView(pair.direct), decision: decideRelease({ released, ...pair }),
    };
  });
  return { leadClass, configuredFrom, autoFrom, effectiveFrom, levels };
}

/** What the status, router_get_plan and the dashboard show about auto-release. Read-only. */
export function routingView(ledger: Ledger, cfg: RoutingConfig, nowIso: string): RoutingView {
  const arms = releaseArms(ledger, nowIso);
  return { mode: routingMode(cfg), holdoutRate: routingHoldoutRate(cfg), rule: RELEASE_RULE, classes: LEAD_CLASSES.map(c => classView(ledger, cfg, c, arms)) };
}

export interface ReleaseChange { kind: 'release' | 'reenable'; leadClass: LeadModelClass; level: Level; from: Level; to: Level; decision: ReleaseDecision }

/**
 * What the rule says to do for one lead class now: release its lowest delegated level, or re-enable the level
 * released last. Undefined: nothing. It is the caller's to apply it (mode 'on') or only to show it (observe).
 */
export function releaseChange(ledger: Ledger, cfg: RoutingConfig, leadClass: LeadModelClass, nowIso: string): ReleaseChange | undefined {
  if (routingMode(cfg) === 'off') return undefined;
  const v = classView(ledger, cfg, leadClass, releaseArms(ledger, nowIso));
  for (const l of v.levels) {
    if (!l.candidate) continue;
    if (l.released && l.decision.action === 'reenable') return { kind: 'reenable', leadClass, level: l.level, from: v.effectiveFrom, to: l.level, decision: l.decision };
    const to = releasedFrom(l.level);
    if (!l.released && l.decision.action === 'release' && to) return { kind: 'release', leadClass, level: l.level, from: v.effectiveFrom, to, decision: l.decision };
  }
  return undefined;
}

const usd = (x: number | null) => (x === null ? 'no accepted task' : `$${x.toFixed(x < 1 ? 3 : 2)} per accepted task`);

/** The one line the user sees when a level is released or comes back. */
export function releaseNotice(c: ReleaseChange): string {
  const d = c.decision;
  const nums = `the last ${d.need.delegated[0]} delegated ${c.level} requests cost ${usd(d.delegatedCost)} against ${usd(d.directCost)} for ${d.need.direct[0]} handled directly`;
  return c.kind === 'release'
    ? `[do-it-all-claude-code] ${c.level} requests with a ${c.leadClass} lead are now handled directly: ${nums}. Undo: do-it-all-claude-code routing reset`
    : `[do-it-all-claude-code] ${c.level} requests with a ${c.leadClass} lead go to a team again: ${nums}.`;
}

/** Applies a change (mode 'on'): the new start level and a notice for the next prompt of that lead class. */
export function applyRelease(ledger: Ledger, cfg: RoutingConfig, c: ReleaseChange, at: string): void {
  const configuredFrom = { ...DEFAULT_DELEGATE_FROM, ...cfg.delegateFrom }[c.leadClass];
  ledger.setRelease(c.leadClass, { autoDelegateFrom: c.to === configuredFrom ? null : c.to, notice: releaseNotice(c), detail: { kind: c.kind, level: c.level, decision: c.decision } }, at);
}
