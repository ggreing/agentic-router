// Local state layout shared by the daemon, the hook scripts and the CLI.
//
// <home> = $AGENTIC_ROUTER_HOME or ~/.agentic-router
//   config.json        { daemonPort, proxyPort, fableOptIn, ... }   written by `init`
//   token              local auth token (file mode 0600 where supported); never the API key
//   router.db          node:sqlite ledger
//   spool/             hook events queued while the daemon is down (*.jsonl), replayed on start
//   scopes/<scopeKey>.json  { allowed: string[], protected: string[], unscoped?: boolean }   written by the daemon
//   agents/<agentId>.json   { sessionId, subtaskId, role, slot, step }   written by the daemon at SubagentStart
// scopeKey = scopeKey(sessionId, subtaskId): subtask tags (A, B, ...) are only unique within a session.
//   logs/
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Level } from './types.ts';

/**
 * The router's state folder. A relative AGENTIC_ROUTER_HOME is ignored (env audit #7): it would
 * resolve to a different folder in every process cwd (hooks, daemon, CLI), so events would never meet.
 */
export function routerHome(): string {
  const v = process.env.AGENTIC_ROUTER_HOME;
  return v && path.isAbsolute(v) ? v : path.join(homedir(), '.agentic-router');
}

export const paths = {
  config: () => path.join(routerHome(), 'config.json'),
  token: () => path.join(routerHome(), 'token'),
  db: () => path.join(routerHome(), 'router.db'),
  spoolDir: () => path.join(routerHome(), 'spool'),
  scopesDir: () => path.join(routerHome(), 'scopes'),
  scopeFile: (sessionId: string, subtaskId: string) => path.join(routerHome(), 'scopes', `${scopeKey(sessionId, subtaskId)}.json`),
  agentsDir: () => path.join(routerHome(), 'agents'),
  agentFile: (agentId: string) => path.join(routerHome(), 'agents', `${safeName(agentId)}.json`),
  logsDir: () => path.join(routerHome(), 'logs'),
};

/**
 * Key of a subtask's scope file; the guard hook (its own copy) and the daemon must both use this.
 * Readable parts are truncated; the hash of the exact pair removes separator/sanitising collisions.
 */
export function scopeKey(sessionId: string, subtaskId: string): string {
  const h = createHash('sha256').update(`${sessionId}\0${subtaskId}`).digest('hex').slice(0, 10);
  return `${safeName(sessionId).slice(0, 40)}__${safeName(subtaskId).slice(0, 40)}__${h}`;
}

/** File-name-safe identifier (ids come from hook input and must not escape the directory). */
export function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128);
}

export interface RouterConfig {
  daemonPort: number;
  proxyPort?: number;
  fableOptIn: boolean;
  pluginDir?: string;        // where the plugin's agents/*.md live (verify defaults); written by `init`
  budgetsUsd?: Partial<Record<Level, number>>;   // per-request budgets set by `init`; override preset defaults (positive finite only)
  forceLevel?: Level;        // benchmarks / debugging only (decision 107): plan every new request at this level
  recordPrompts?: boolean;   // decision 109: store redacted prompt text in request records (opt-in; default false)
  delegateFrom?: Partial<Record<'opus' | 'sonnet' | 'haiku' | 'other', Level>>;   // decision 117: first delegated level per lead model tier
}
