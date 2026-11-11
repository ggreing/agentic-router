// `init` building blocks: local state (config, token), Claude Code status line, project settings.
// Every change to a file outside ~/.agentic-router is shown first and needs confirmation (or --yes).
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { homedir } from 'node:os';
import { PROVISIONAL_BUDGET_USD, paths, routerHome, type Level, type RouterConfig } from '@agentic-router/core';

/** Ports common dev servers use; the daemon never takes them (spec 2.1). */
export const COMMON_DEV_PORTS = new Set([3000, 3001, 4200, 5000, 5173, 5432, 6379, 8000, 8080, 8081, 8443, 8787, 8888, 9000, 9229, 27017]);

export interface CliConfig extends RouterConfig {
  budgetsUsd: Record<Level, number>;
  wrappedStatusLine?: { type: 'command'; command: string; padding?: number };
}

export function isFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

/** First free port in 47800-47999 (outside common dev-server ports). */
export async function pickPort(start = 47800, end = 47999): Promise<number> {
  for (let p = start; p <= end; p++) if (!COMMON_DEV_PORTS.has(p) && await isFree(p)) return p;
  throw new Error(`no free port in ${start}-${end}`);
}

/** A settings file we could not parse: init skips that step and says why, instead of failing (review #12). */
export class SettingsParseError extends Error {}

/** Reads a JSON file (BOM tolerated). Missing or empty file -> fallback. Unparseable -> SettingsParseError. */
export function readJsonFile<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  if (!text.trim()) return fallback;
  try { return JSON.parse(text) as T; }
  catch (e) { throw new SettingsParseError(`cannot parse ${file} as JSON (${(e as Error).message}); comments and trailing commas are not supported`); }
}

/** Writes via a temp file + rename so an interrupted write never leaves a truncated file. */
export function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  // Windows: an antivirus scanner or indexer holding the target open makes rename fail with
  // EPERM/EACCES/EBUSY for a moment (env audit #9). Retry for about a second, then clean up.
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt < 10 && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); continue; }
      fs.rmSync(tmp, { force: true });
      throw e;
    }
  }
}

/** POSIX: the router home holds prompts and the local token, so only the user may read it (env audit #13). */
export function restrictHome(): void {
  if (process.platform === 'win32') return;      // Windows: the profile ACL applies; doctor warns on other principals
  try {
    fs.chmodSync(routerHome(), 0o700);
    for (const f of [paths.token(), paths.config(), paths.db()]) if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
  } catch { /* not our file system: doctor reports it */ }
}

/** Only positive finite numbers are budgets; anything else is dropped (review #5). */
export function validBudgets(b: Partial<Record<Level, unknown>> | undefined): Partial<Record<Level, number>> {
  const out: Partial<Record<Level, number>> = {};
  for (const l of ['L0', 'L1', 'L2', 'L3'] as Level[]) {
    const v = b?.[l];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[l] = v;
  }
  return out;
}

export function readConfig(): CliConfig | null {
  return readJsonFile<CliConfig | null>(paths.config(), null);
}

export function writeConfig(c: CliConfig): void {
  writeJsonAtomic(paths.config(), c);
}

/** Creates the local auth token once (mode 0600 where the OS supports it). Never prints it. */
export function ensureToken(): 'created' | 'kept' {
  if (fs.existsSync(paths.token())) return 'kept';
  fs.mkdirSync(routerHome(), { recursive: true });
  fs.writeFileSync(paths.token(), randomBytes(32).toString('base64url'), { mode: 0o600 });
  return 'created';
}

export async function ensureLocalState(budgets: Partial<Record<Level, number>> = {}, pluginDir?: string, opts: { newPort?: boolean } = {}): Promise<{ config: CliConfig; token: 'created' | 'kept' }> {
  const prev = readConfig();
  const config: CliConfig = {
    daemonPort: !opts.newPort && prev?.daemonPort ? prev.daemonPort : await pickPort(),
    fableOptIn: prev?.fableOptIn ?? false,
    ...(pluginDir ?? prev?.pluginDir ? { pluginDir: pluginDir ?? prev?.pluginDir } : {}),
    budgetsUsd: { ...PROVISIONAL_BUDGET_USD, ...validBudgets(prev?.budgetsUsd), ...validBudgets(budgets) },
    ...(prev?.wrappedStatusLine ? { wrappedStatusLine: prev.wrappedStatusLine } : {}),
  };
  for (const d of [paths.spoolDir(), paths.scopesDir(), paths.agentsDir(), paths.logsDir()]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  writeConfig(config);
  const token = ensureToken();
  restrictHome();
  return { config, token };
}

/** Claude Code's user settings file; CLAUDE_CONFIG_DIR moves the whole config folder (env audit #8). */
export const claudeConfigDir = (env: NodeJS.ProcessEnv = process.env) =>
  env.CLAUDE_CONFIG_DIR && path.isAbsolute(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : path.join(homedir(), '.claude');
export const defaultClaudeSettings = (env: NodeJS.ProcessEnv = process.env) => path.join(claudeConfigDir(env), 'settings.json');

export interface PlannedChange { file: string; summary: string; apply(): void }

/**
 * True when a status line command runs this plugin's statusline.mjs, from any install location
 * (dev checkout, another --plugin-dir, marketplace cache). Such a command is never wrapped:
 * wrapping it would make the status line run itself recursively (review #1).
 */
export function isRouterStatusLine(command: string | undefined): boolean {
  if (!command) return false;
  const m = command.match(/"([^"]*statusline\.mjs)"|(\S*statusline\.mjs)/);
  const file = m?.[1] ?? m?.[2];
  if (!file) return false;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(file), '.claude-plugin', 'plugin.json'), 'utf8'));
    if (manifest?.name === 'agentic-router') return true;
  } catch { /* file moved or not readable: fall back to the path */ }
  return /agentic-router/i.test(file);
}

/**
 * Status line: plugins cannot set it, so init writes it into the user's Claude Code settings.
 * An existing (non-router) status line is kept: it is recorded in config.json and the router's
 * script prints the original output first, then the router segment (spec 2.3). Re-running init
 * with another plugin path only repoints the router command and keeps the recorded original.
 * The settings file is backed up once (the first time); later runs never overwrite the backup.
 */
export function planStatusLine(settingsFile: string, statuslineScript: string, config: CliConfig): PlannedChange | null {
  const settings = readJsonFile<Record<string, any>>(settingsFile, {});
  const command = `node "${statuslineScript}"`;
  const current = settings.statusLine;
  if (current?.command === command) return null;
  const ours = isRouterStatusLine(current?.command);
  const existing = !ours && current?.type === 'command' ? current : undefined;
  return {
    file: settingsFile,
    summary: ours ? 'statusLine: point the router status line at this install (the wrapped original is kept)'
      : existing ? `statusLine: wrap the existing "${existing.command}" and append the router segment`
      : 'statusLine: add the router status line',
    apply() {
      const bak = settingsFile + '.agentic-router.bak';
      if (fs.existsSync(settingsFile) && !fs.existsSync(bak)) fs.copyFileSync(settingsFile, bak);
      if (existing) { config.wrappedStatusLine = existing; writeConfig(config); }
      settings.statusLine = { type: 'command', command, ...(typeof current?.padding === 'number' ? { padding: current.padding } : {}) };
      writeJsonAtomic(settingsFile, settings);
    },
  };
}

/** Project: worktrees branch from HEAD (decision: settings.local.json, not committed) and stay out of git. */
export function planProject(projectDir: string): PlannedChange[] {
  const out: PlannedChange[] = [];
  if (!fs.existsSync(path.join(projectDir, '.git'))) return out;
  const local = path.join(projectDir, '.claude', 'settings.local.json');
  const s = readJsonFile<Record<string, any>>(local, {});
  if (s.worktree?.baseRef !== 'head') out.push({
    file: local, summary: 'worktree.baseRef = "head" (parallel workers branch from your current commit)',
    apply() { s.worktree = { ...s.worktree, baseRef: 'head' }; writeJsonAtomic(local, s); },
  });
  const gi = path.join(projectDir, '.gitignore');
  const text = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  if (!/^\.claude\/worktrees\/?$/m.test(text)) out.push({
    file: gi, summary: 'add ".claude/worktrees/" to .gitignore',
    apply() { fs.writeFileSync(gi, text + (text && !text.endsWith('\n') ? '\n' : '') + '.claude/worktrees/\n'); },
  });
  return out;
}
