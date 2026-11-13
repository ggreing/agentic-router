// Local state layout shared by the daemon, the hook scripts and the CLI.
//
// <home> = $DO_IT_ALL_CLAUDE_CODE_HOME or ~/.do-it-all-claude-code
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
 * The router's state folder. A relative DO_IT_ALL_CLAUDE_CODE_HOME is ignored (env audit #7): it would
 * resolve to a different folder in every process cwd (hooks, daemon, CLI), so events would never meet.
 */
export function routerHome(): string {
  const v = process.env.DO_IT_ALL_CLAUDE_CODE_HOME;
  return v && path.isAbsolute(v) ? v : path.join(homedir(), '.do-it-all-claude-code');
}

// ------------------------------------------------------------------ names of the previous release (decision 161)
// The product was renamed. These names are only read: to move the old home (init), to honour a project folder
// that has not been renamed yet, to keep both folders protected, and to recognise settings entries the
// previous release wrote. Nothing is written under them.

/** The previous product's command, plugin and keychain service name. */
export const LEGACY_SLUG = 'agentic-router';
/** The project folder (policy.json, verify.json, teams.yaml), and the one of the previous release. */
export const PROJECT_DIR = '.do-it-all-claude-code';
export const LEGACY_PROJECT_DIR = '.agentic-router';

/** The previous release's state folder: $AGENTIC_ROUTER_HOME when absolute, else ~/.agentic-router. */
export function legacyRouterHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const v = env.AGENTIC_ROUTER_HOME;
  return v && path.isAbsolute(v) ? v : path.join(home, LEGACY_PROJECT_DIR);
}

/**
 * A project file: <root>/.do-it-all-claude-code/<name>, or the same file in the previous release's folder when
 * only that one has it (honoured for this release; doctor asks to rename the folder). `legacy` says which.
 */
export function projectFile(root: string, name: string, exists: (p: string) => boolean): { file: string; legacy: boolean } {
  const file = path.join(root, PROJECT_DIR, name);
  const old = path.join(root, LEGACY_PROJECT_DIR, name);
  return !exists(file) && exists(old) ? { file: old, legacy: true } : { file, legacy: false };
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
  stepDown?: 'on' | 'off';   // decision 135: two easy passes in a row move a slot one step down (default on)
  updateCheck?: 'on' | 'off';   // decision 163: check GitHub once a day for a newer release (opt-in; missing = off)
  autoRelease?: 'on' | 'observe' | 'off';   // decision 138: default observe (holdout runs and the comparison is shown; nothing switches)
  holdoutRate?: number;      // decision 138: share of delegated-level requests handled lead-direct as the baseline, 0 to 0.2 (default 0.1)
  eventRetentionDays?: number;   // decision 141: hook events older than this are dropped (default 30; 0 keeps them)
  bearerApi?: 'on' | 'off';  // decision 156: whether the daemon still accepts "Authorization: Bearer <token>" calls from clients of an older version (default on for one release; the router's own clients no longer send it)
  delegateFrom?: Partial<Record<'opus' | 'sonnet' | 'haiku' | 'other', Level>>;   // decision 117: first delegated level per lead model tier
  proxy?: {                  // API-key mode proxy (decisions 130-131)
    upstream?: string;       // https origin on the allowlist; default https://api.anthropic.com
    allowedUpstreams?: string[];   // extra https origins added by `do-it-all-claude-code proxy allow-upstream` (user-confirmed)
    tokenDailyCapUsd?: number;   // per local token per day; default 100
    dailyCapUsd?: number;        // all tokens per day; default 300
    tls?: boolean;               // decision 157: serve HTTPS with <home>/tls/proxy-cert.pem (set by `mode api` when it can)
  };
  /**
   * API-key mode (decision 130), set by `do-it-all-claude-code init --mode api` / `mode`: 'proxy' runs the proxy and
   * its usage rows are the cost source; 'direct' is the bypass while it is down. Absent: subscription mode.
   */
  apiMode?: 'proxy' | 'direct';
}
