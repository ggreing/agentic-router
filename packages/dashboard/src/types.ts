// Mirrors the daemon's metrics read-model contract (packages/daemon/src/metrics.ts) and the "now" view
// (router.status()). Kept in step with those shapes; the daemon owns the source of truth.
export type Level = 'L0' | 'L1' | 'L2' | 'L3';

export interface MetricsWindow { since?: string; until?: string }

export interface LimitWindow { usedPercentage: number; resetsAt: number | null }
export interface SpendLimit extends LimitWindow { usedUsd: number | null; limitUsd: number | null; period: string | null }
export interface SessionLimits { fiveHour: LimitWindow | null; sevenDay: LimitWindow | null; spendLimit: SpendLimit | null; updatedAt: string }

export interface Acceptance {
  accepted: number;
  notAccepted: number;
  unobserved: number;
  notApplicable: number;
  unknown: number;
  unobservedShare: number | null;
  signals: Record<string, number>;
}

export interface MetricsSummary {
  window: MetricsWindow;
  total: number;
  successful: number;
  successRate: number | null;
  acceptance?: Acceptance;
  teamFitRate: number | null;
  startStepFitRate: number | null;
  upRate: number | null;
  costPerAcceptedTaskUsd: number | null;
  cost: { totalUsd: number; leadUsd: number; subtaskUsd: number };
  cacheHitRate: number | null;
  flags: { estimated: number; unknown: number; budgetExceeded: number };
  byLevel: Array<{ level: Level; count: number; totalUsd: number; successRate: number | null }>;
  baseline: null;
  limits?: SessionLimits | null;
}

export interface TimelineRow {
  requestId: string;
  createdAt: string;
  closedAt: string;
  kind: string | null;
  level: Level;
  finalLevel: Level;
  outcome: string | null;
  leadClass: string | null;
  changedFiles: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  durationMs: number | null;
  activeMs: number | null;
  leadUsd: number | null;
  subtaskUsd: number;
  totalUsd: number;
  success: boolean;
  subtasks: number;
  verifyFailures: number;
  estimated: boolean;
  unknown: boolean;
  budgetExceeded: boolean;
  acceptance: string | null;
  holdout: string | null;
}

export interface Cursor { closedAt: string; requestId: string }
export interface RequestsPage { rows: TimelineRow[]; nextCursor: Cursor | null }

export interface Signal { subtaskId: string | null; attempt: number; kind: string; ok: boolean; detail?: string }
export interface RequestDetail { requestId: string; record: Record<string, unknown>; signals: Signal[]; prompt: string | null }

export interface TriageReport {
  window: MetricsWindow;
  overall: { total: number; levelHeld: number; teamFit: number; startStepFit: number };
  byRule: Array<{ rule: string; count: number; reinforced: number; upStreaks: number; suggestLevelUp: boolean; suggestStepUp: boolean }>;
  byLevel: Array<{ planned: Level; final: Level; count: number }>;
}

// Auto-release panel (decision 138); shape mirrors the daemon's RoutingView on GET /router/v1/status.
export type RoutingMode = 'on' | 'observe' | 'off';
export interface Arm { n: number; accepted: number; costUsd: number; costPerAcceptedUsd: number | null }
export interface RoutingDecision {
  action: 'hold' | 'release' | 'reenable';
  reason: 'not_enough_data' | 'no_direct_cost' | 'delegated_dearer' | 'delegated_not_dearer' | 'inside_band';
  ratio: number | null;
  delegatedCost: number | null;
  directCost: number | null;
  need: { delegated: [number, number]; direct: [number, number] };
}
export interface RoutingLevel {
  level: 'L1' | 'L2';
  delegatedByConfig: boolean;
  released: boolean;
  candidate: boolean;
  delegated: Arm;
  direct: Arm;
  decision: RoutingDecision;
}
export interface RoutingClass {
  leadClass: 'opus' | 'sonnet' | 'haiku' | 'other';
  configuredFrom: Level;
  autoFrom: Level | null;
  effectiveFrom: Level;
  levels: RoutingLevel[];
}
export interface RoutingView {
  mode: RoutingMode;
  holdoutRate: number;
  rule: { majorityMin: number; minorityMin: number; releaseAbove: number; reenableAtOrBelow: number; windowDays: number };
  classes: RoutingClass[];
}

export interface NowRole { role: string; slot: number; step: string; model: string; effort: string; status: string }
export interface NowView {
  request: null | {
    id: string; level: Level; preset: string; status: string; leadDirect: boolean;
    budgetUsd: number; usedUsd: number; leadCostUsd: number; leadModel: string | null; leadClass: string | null; outcome: string | null;
  };
  roles: NowRole[];
  costUsd: number;
  costEstimated: boolean;
  costUnknown: boolean;
  sessionCostUsd: number;
  limits?: SessionLimits | null;
  routing?: RoutingView | null;
}
