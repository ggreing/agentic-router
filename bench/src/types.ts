export type Level = 'L0' | 'L1' | 'L2' | 'L3';

export interface Limits { maxTurns: number; timeoutSec: number }

export interface Task {
  id: string;
  level: Level;
  source: 'custom' | 'swebench-verified';
  title: string;
  limits: Limits;
  // custom tasks
  dir?: string;
  fixture?: string;
  prompt?: string;
  hidden_tests?: string[];
  grade?: { cmd: string };
  oracle?: string;
  // public tasks
  instance_id?: string;
  repo?: string;
  base_commit?: string;
}

export interface RunConfig {
  id: string;
  label: string;
  model: string;
  effort: string;
  group: string;
}

export interface PlannedRun {
  runId: string;
  task: Task;
  config: RunConfig;
  rep: number;
  capUsd: number;
  estUsd: number;
}

export interface GradeResult { pass: boolean; detail: string }

export interface RunRecord {
  runId: string;
  taskId: string;
  level: Level;
  source: string;
  configId: string;
  model: string;
  effort: string;
  rep: number;
  startedAt: string;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  costUsd: number;
  numTurns: number | null;
  isError: boolean;
  resultSubtype: string | null;
  resolvedModels: string[];
  usage: Record<string, unknown> | null;
  graded: GradeResult;
  note?: string;
}

// The only key channel is an OS-keychain lookup command handed to Claude Code as apiKeyHelper.
// Keys are never accepted from environment variables or files (spec 4.4, decision #33).
export interface AuthChannel {
  kind: 'api-key-helper' | 'none';
  helperCmd?: string;          // command that prints the key; run by Claude Code, never by the harness
}
