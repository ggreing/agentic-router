// `init` building blocks: local state (config, token), Claude Code status line, project settings.
// Every change to a file outside ~/.agentic-router is shown first and needs confirmation (or --yes).
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { homedir } from 'node:os';
import { PROVISIONAL_BUDGET_USD, paths, redact, routerHome, type Level, type RouterConfig } from '@agentic-router/core';

/** Ports common dev servers use; the daemon never takes them (spec 2.1). */
export const COMMON_DEV_PORTS = new Set([3000, 3001, 4200, 5000, 5173, 5432, 6379, 8000, 8080, 8081, 8443, 8787, 8888, 9000, 9229, 27017]);

export interface CliConfig extends RouterConfig {
  budgetsUsd: Record<Level, number>;
  wrappedStatusLine?: { type: 'command'; command: string; padding?: number };
  /** What API-key mode added to NO_PROXY in Claude Code's settings (apimode.ts), so it can be taken out again. */
  noProxyAdded?: Array<{ name: string; created: boolean; base: string; added: string[] }>;
  /** Decisions 156-157: other settings env values API-key mode set (helper cache, NODE_EXTRA_CA_CERTS), with what was there before. */
  apiEnvAdded?: Array<{ name: string; value: string; previous: string | null }>;
  /** Decision 157: why local TLS is off, or whose NODE_EXTRA_CA_CERTS file the bundle combines. */
  localTls?: { off?: string; bundleFrom?: string[] };
}

export function isFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

/** First free port in 47800-47999 (outside common dev-server ports and the ports given, e.g. the daemon's). */
export async function pickPort(start = 47800, end = 47999, exclude: ReadonlySet<number> = new Set()): Promise<number> {
  for (let p = start; p <= end; p++) if (!COMMON_DEV_PORTS.has(p) && !exclude.has(p) && await isFree(p)) return p;
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

/**
 * Writes via a temp file + rename so an interrupted write never leaves a truncated file. Audit C4: a symlinked
 * file (a dotfiles setup) is written at its real target, so the link stays a link; the file keeps its mode
 * (a new one gets `mode`, 0600 unless said otherwise).
 */
export function writeJsonAtomic(file: string, data: unknown, opts: { mode?: number } = {}): void {
  let target = file;
  try { target = fs.realpathSync(file); } catch { /* new file */ }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let mode = opts.mode ?? 0o600;
  try { mode = fs.statSync(target).mode & 0o777; } catch { /* new file */ }
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode });
  if (process.platform !== 'win32') fs.chmodSync(tmp, mode);   // the umask may have narrowed or widened it
  // Windows: an antivirus scanner or indexer holding the target open makes rename fail with
  // EPERM/EACCES/EBUSY for a moment (env audit #9). Retry for about a second, then clean up.
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(tmp, target); return; }
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
    for (const f of [paths.token(), paths.config(), paths.db(), path.join(routerHome(), 'proxy-token'), path.join(routerHome(), 'proxy.db')]) if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
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
  writeJsonAtomic(paths.config(), c, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(paths.config(), 0o600);   // audit C4: config.json is 0600 whatever it was
}

// ------------------------------------------------------------------ settings backups (decision 142)

/** Settings env names that look like credentials: a backup never keeps their values. */
export const isCredentialName = (name: string): boolean => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(name);
export const backupFile = (settingsFile: string): string => `${settingsFile}.agentic-router.bak`;

/** Env names a backup leaves out besides credential-looking ones (decision 149): headers can carry a credential. */
const BACKUP_DROP_ENV = new Set(['ANTHROPIC_CUSTOM_HEADERS']);

/**
 * The settings fields a backup must not keep, as labels: `env.<NAME>` for credential-looking env values and
 * ANTHROPIC_CUSTOM_HEADERS, and `apiKeyHelper` when the helper command itself holds a key-shaped literal
 * (masking would change it).
 */
function credentialFields(settings: unknown): string[] {
  const s = settings as { env?: unknown; apiKeyHelper?: unknown } | null;
  const env = s?.env;
  const out = env && typeof env === 'object' && !Array.isArray(env)
    ? Object.keys(env).filter(k => isCredentialName(k) || BACKUP_DROP_ENV.has(k)).sort().map(k => `env.${k}`) : [];
  if (typeof s?.apiKeyHelper === 'string' && redact(s.apiKeyHelper) !== s.apiKeyHelper) out.push('apiKeyHelper');
  return out;
}
function withoutCredentials<T extends Record<string, any>>(settings: T): T {
  const fields = credentialFields(settings);
  if (!fields.length) return settings;
  const next: Record<string, any> = { ...settings };
  const env = { ...settings.env };
  for (const f of fields) { if (f === 'apiKeyHelper') delete next.apiKeyHelper; else delete env[f.slice('env.'.length)]; }
  if (Object.keys(env).length) next.env = env; else delete next.env;
  return next as T;
}

/** For a plan summary: what the one-time backup about to be made leaves out. */
export function backupNote(settingsFile: string): string {
  if (!fs.existsSync(settingsFile) || fs.existsSync(backupFile(settingsFile))) return '';
  const fields = credentialFields(readJsonFile<Record<string, any>>(settingsFile, {}));
  return fields.length ? ` (the one-time backup leaves out ${fields.join(', ')}: credentials are not copied)` : '';
}

/** The one-time backup of a settings file (0600), without credential env values. A backup that exists is kept. */
export function writeBackup(settingsFile: string): void {
  const bak = backupFile(settingsFile);
  if (!fs.existsSync(settingsFile) || fs.existsSync(bak)) return;
  writeJsonAtomic(bak, withoutCredentials(readJsonFile<Record<string, any>>(settingsFile, {})), { mode: 0o600 });
}

/** The credential fields an existing backup still holds (made before decisions 142 and 149), as labels. */
export function backupCredentials(settingsFile: string): string[] {
  const bak = backupFile(settingsFile);
  if (!fs.existsSync(bak)) return [];
  try { return credentialFields(readJsonFile<unknown>(bak, {})); } catch { return []; }
}

/** init offers this when an existing backup holds credentials: the backup rewritten without them. */
export function planBackupClean(settingsFile: string): PlannedChange | null {
  const names = backupCredentials(settingsFile);
  if (!names.length) return null;
  const bak = backupFile(settingsFile);
  return {
    file: bak,
    summary: `remove ${names.join(', ')} from the backup (a credential kept in plain text)`,
    apply() { writeJsonAtomic(bak, withoutCredentials(readJsonFile<Record<string, any>>(bak, {})), { mode: 0o600 }); },
  };
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
    // every other field (proxyPort, proxy, apiMode, forceLevel, recordPrompts, delegateFrom, ...) is kept as it was
    ...(prev ?? {}),
    daemonPort: !opts.newPort && prev?.daemonPort ? prev.daemonPort : await pickPort(47800, 47999, new Set(prev?.proxyPort ? [prev.proxyPort] : [])),
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
    summary: (ours ? 'statusLine: point the router status line at this install (the wrapped original is kept)'
      : existing ? `statusLine: wrap the existing "${existing.command}" and append the router segment`
      : 'statusLine: add the router status line') + backupNote(settingsFile),
    apply() {
      writeBackup(settingsFile);
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

/** Decisions 109, 141-142: what happens to prompt text, for init and doctor. */
export function promptStorageSummary(recordPrompts: boolean | undefined): string {
  return recordPrompts === true
    ? 'recordPrompts is on: a redacted copy of each prompt is kept in its request record (local only). Switching it off deletes the stored prompt text at the next daemon start.'
    : 'recordPrompts is off: no prompt or conversation text is stored. Switching it on keeps a redacted copy per request; switching it off again deletes that text at the next daemon start.';
}
