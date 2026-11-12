// config.json and token, both written by `agentic-router init` (CLI).
import fs from 'node:fs';
import { MAX_HOLDOUT_RATE, holdoutRate } from '@agentic-router/core';
import { DEFAULT_EVENT_RETENTION_DAYS, MAX_EVENT_RETENTION_DAYS } from './data.ts';
import type { Level, RouterConfig, TeamPreset } from '@agentic-router/core';

/** config.json as read: every field may be missing (tests and fresh homes pass the port explicitly). */
export type ConfigFile = Partial<RouterConfig>;

const LEVELS: readonly Level[] = ['L0', 'L1', 'L2', 'L3'];

/** Per-request budgets from `init` (review #5): only positive finite numbers; the rest is reported. */
export function parseBudgets(v: unknown, warnings: string[]): Partial<Record<Level, number>> | undefined {
  if (v === undefined) return undefined;
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    warnings.push('config.budgetsUsd ignored: not an object');
    return undefined;
  }
  const out: Partial<Record<Level, number>> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (!(LEVELS as readonly string[]).includes(k)) { warnings.push(`config.budgetsUsd.${k} ignored: unknown level`); continue; }
    if (typeof x !== 'number' || !Number.isFinite(x) || x <= 0) { warnings.push(`config.budgetsUsd.${k} ignored: ${JSON.stringify(x)} is not a positive number`); continue; }
    out[k as Level] = x;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Presets with their per-request budget replaced by the configured one, where set. */
export function applyBudgets(presets: Record<Level, TeamPreset>, budgets: Partial<Record<Level, number>> | undefined): Record<Level, TeamPreset> {
  if (!budgets) return presets;
  const out = { ...presets };
  for (const l of LEVELS) {
    const b = budgets[l];
    if (b !== undefined) out[l] = { ...presets[l], budgetUsd: b };
  }
  return out;
}

export function readConfig(file: string, warnings: string[] = []): ConfigFile {
  if (!fs.existsSync(file)) return {};
  const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`invalid config file: ${file}`);
  const o = raw as Record<string, unknown>;
  const out: ConfigFile = {};
  if (o.daemonPort !== undefined) {
    if (!Number.isInteger(o.daemonPort) || (o.daemonPort as number) < 0 || (o.daemonPort as number) > 65535) throw new Error('config.daemonPort must be a port number');
    out.daemonPort = o.daemonPort as number;
  }
  if (typeof o.proxyPort === 'number') out.proxyPort = o.proxyPort;
  out.fableOptIn = o.fableOptIn === true;
  if (typeof o.pluginDir === 'string' && o.pluginDir) out.pluginDir = o.pluginDir;
  const budgets = parseBudgets(o.budgetsUsd, warnings);
  if (budgets) out.budgetsUsd = budgets;
  if (o.recordPrompts === true) out.recordPrompts = true;
  // Decision 138: auto-release mode (default observe) and the holdout share (default 0.1, at most 0.2)
  if (o.autoRelease === 'on' || o.autoRelease === 'observe' || o.autoRelease === 'off') out.autoRelease = o.autoRelease;
  else if (o.autoRelease !== undefined) warnings.push('config.autoRelease ignored: not "on", "observe" or "off"');
  if (o.holdoutRate !== undefined && !(typeof o.holdoutRate === 'number' && o.holdoutRate >= 0 && o.holdoutRate <= MAX_HOLDOUT_RATE)) {
    warnings.push(`config.holdoutRate ${JSON.stringify(o.holdoutRate)} is not a number from 0 to ${MAX_HOLDOUT_RATE}: the nearest allowed value is used`);
  }
  out.holdoutRate = holdoutRate(o.holdoutRate);
  // Decision 141: hook events are kept this many days (default 30; 0 keeps them)
  if (o.eventRetentionDays === undefined) out.eventRetentionDays = DEFAULT_EVENT_RETENTION_DAYS;
  else if (Number.isInteger(o.eventRetentionDays) && (o.eventRetentionDays as number) >= 0 && (o.eventRetentionDays as number) <= MAX_EVENT_RETENTION_DAYS) out.eventRetentionDays = o.eventRetentionDays as number;
  else {
    out.eventRetentionDays = DEFAULT_EVENT_RETENTION_DAYS;
    warnings.push(`config.eventRetentionDays ${JSON.stringify(o.eventRetentionDays)} is not a whole number of days from 0 to ${MAX_EVENT_RETENTION_DAYS}: ${DEFAULT_EVENT_RETENTION_DAYS} is used`);
  }
  // Decision 130: in API-key proxy mode the proxy's usage rows are the cost source (transcripts a cross-check)
  if (o.apiMode === 'proxy' || o.apiMode === 'direct') out.apiMode = o.apiMode;
  else if (o.apiMode !== undefined) warnings.push(`config.apiMode ignored: ${JSON.stringify(o.apiMode)} is not "proxy" or "direct"`);
  if (o.stepDown === 'on' || o.stepDown === 'off') out.stepDown = o.stepDown;   // decision 135
  else if (o.stepDown !== undefined) warnings.push('config.stepDown ignored: not "on" or "off"');
  // Decisions 117-118: the first delegated level per lead model class
  if (o.delegateFrom !== undefined) {
    const v = o.delegateFrom;
    if (!v || typeof v !== 'object' || Array.isArray(v)) warnings.push('config.delegateFrom ignored: not an object');
    else {
      const from: Partial<Record<'opus' | 'sonnet' | 'haiku' | 'other', Level>> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (!['opus', 'sonnet', 'haiku', 'other'].includes(k)) { warnings.push(`config.delegateFrom.${k} ignored: not opus, sonnet, haiku or other`); continue; }
        if (!(LEVELS as readonly unknown[]).includes(x)) { warnings.push(`config.delegateFrom.${k} ignored: ${JSON.stringify(x)} is not L0, L1, L2 or L3`); continue; }
        from[k as keyof typeof from] = x as Level;
      }
      if (Object.keys(from).length) out.delegateFrom = from;
    }
  }   // T7, opt-in: keep the redacted prompt in the request record
  // Decision 107: benchmarks / debugging only
  if (o.forceLevel !== undefined) {
    if ((LEVELS as readonly unknown[]).includes(o.forceLevel)) out.forceLevel = o.forceLevel as Level;
    else warnings.push(`config.forceLevel ignored: ${JSON.stringify(o.forceLevel)} is not L0, L1, L2 or L3`);
  }
  return out;
}

export const MIN_TOKEN_LENGTH = 16;

export function readToken(file: string): string {
  if (!fs.existsSync(file)) throw new Error(`token file not found: ${file} (run \`agentic-router init\`)`);
  const token = fs.readFileSync(file, 'utf8').trim();
  if (token.length < MIN_TOKEN_LENGTH) throw new Error(`token file is too short: ${file}`);
  return token;
}
