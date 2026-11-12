// `doctor`: environment checks that decide whether routing can work (spec 5.4, decision 30-35).
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths, routerHome } from '@agentic-router/core';
import { keyStatus, type VaultErrorCode } from '@agentic-router/proxy';
import { HINT_HEADERS_ENV, isRouterHelper, proxyBaseUrl } from './apimode.ts';
import { SettingsParseError, backupCredentials, backupFile, defaultClaudeSettings, promptStorageSummary, readConfig, readJsonFile, type CliConfig } from './setup.ts';
import { health, localRequest } from './daemonctl.ts';
import { proxyHealth, readSuperviseStatus, type SuperviseStatus } from './supervise.ts';
import type { StatusView } from '@agentic-router/daemon';
import { autoReleaseSummary, configuredAutoRelease, routingChecks } from './routing.ts';
import { loadGuard, policyCheck } from './policy.ts';

export interface Check { name: string; ok: boolean; detail: string; blocking: boolean }

export const MIN_CLAUDE = [2, 1, 295] as const;   // per-call effort (2.1.292), hook onFailure (2.1.295)

export function versionAtLeast(v: string, min: readonly number[]): boolean {
  const m = v.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return false;
  const n = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) if (n[i] !== min[i]) return n[i]! > min[i]!;
  return true;
}

/** Settings that silently disable the ladder or the plugin's hooks. Pure: takes env for testing. */
export function ladderBreakers(env: NodeJS.ProcessEnv): Check[] {
  const out: Check[] = [];
  if (env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE) out.push({ name: 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE', ok: false, blocking: true,
    detail: 'forces one model for every subagent: per-call model selection (the ladder) cannot work' });
  if (env.CLAUDE_CODE_EFFORT_LEVEL) out.push({ name: 'CLAUDE_CODE_EFFORT_LEVEL', ok: false, blocking: true,
    detail: 'overrides per-call effort for every subagent' });
  if (env.ANTHROPIC_API_KEY) out.push({ name: 'ANTHROPIC_API_KEY in environment', ok: false, blocking: false,
    detail: 'keys belong in the OS keychain only (decision 33); this variable is visible to every process you start' });
  return out;
}

/** Windows: Git Bash is required (decision 102); Claude Code's Bash tool and the router's verify use it. */
export function findGitBash(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CLAUDE_CODE_GIT_BASH_PATH && fs.existsSync(env.CLAUDE_CODE_GIT_BASH_PATH)) return env.CLAUDE_CODE_GIT_BASH_PATH;
  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')])
    if (base && fs.existsSync(path.join(base, 'Git', 'bin', 'bash.exe'))) return path.join(base, 'Git', 'bin', 'bash.exe');
  try {
    const found = execFileSync('where', ['bash'], { encoding: 'utf8', timeout: 5000, windowsHide: true }).split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    return found.find(x => !/[\/]Windows[\/]System32[\/]bash\.exe$/i.test(x)) ?? null;   // System32\bash.exe is WSL, not Git Bash
  } catch { return null; }
}

/** Environment problems that make hooks or the daemon misbehave (env audit #4, #7, #8, #13). Pure enough to test. */
export function environmentChecks(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, execPath = process.execPath): Check[] {
  const out: Check[] = [];
  if (platform === 'win32') {
    const bash = findGitBash(env);
    out.push({ name: 'git bash (Windows)', ok: !!bash, blocking: true,
      detail: bash ?? 'not found: install Git for Windows or set CLAUDE_CODE_GIT_BASH_PATH (Windows without Git Bash is not supported)' });
  }
  if (/[\\/](\.?nvm|nvm4w|fnm|\.volta|\.asdf|\.nodenv|n[\\/]versions)[\\/]/i.test(execPath)) out.push({ name: 'node from a version manager', ok: false, blocking: false,
    detail: `${execPath}: hooks run \`node\` from the PATH Claude Code sees. A desktop app or IDE started outside your shell may not have it, and then every hook fails (the guard blocks tool calls). Make node available system-wide or start Claude Code from this shell.` });
  const rh = env.AGENTIC_ROUTER_HOME;
  if (rh && !path.isAbsolute(rh)) out.push({ name: 'AGENTIC_ROUTER_HOME', ok: false, blocking: false, detail: `relative value "${rh}" is ignored; using ${routerHome()}` });
  if (env.CLAUDE_CONFIG_DIR) out.push({ name: 'CLAUDE_CONFIG_DIR', ok: path.isAbsolute(env.CLAUDE_CONFIG_DIR), blocking: false,
    detail: path.isAbsolute(env.CLAUDE_CONFIG_DIR) ? `status line goes to ${path.join(env.CLAUDE_CONFIG_DIR, 'settings.json')}; the guard protects this folder` : 'not an absolute path: ignored' });
  return out;
}

/** Who besides the user can read the router home (prompts, token). Windows: icacls; POSIX: mode bits. */
export function homeAccessCheck(home = routerHome(), platform: NodeJS.Platform = process.platform): Check | null {
  if (!fs.existsSync(home)) return null;
  try {
    if (platform === 'win32') {
      const user = os.userInfo().username.toLowerCase();
      const out = execFileSync('icacls', [home], { encoding: 'utf8', timeout: 10000, windowsHide: true });
      // icacls prints "<path> DOMAIN\Name:(OI)(CI)(F)" on the first line, then "<indent>NT AUTHORITY\SYSTEM:(F)" ...
      const principals = out.split(/\r?\n/)
        .map((line, n) => (n === 0 && line.toLowerCase().startsWith(home.toLowerCase()) ? line.slice(home.length) : line).trim())
        .map(line => line.match(/^(.+?):\(/)?.[1]?.trim().toLowerCase())
        .filter((x): x is string => !!x);
      const others = principals.filter(p => !/(^|\\)(system|administrators|creator owner)$/.test(p) && !p.endsWith('\\' + user) && p !== user);
      return { name: 'router home access', ok: others.length === 0, blocking: false,
        detail: others.length ? `${home} is also accessible to: ${[...new Set(others)].join(', ')} (they could read prompts and the local token)` : 'only you (and SYSTEM/Administrators)' };
    }
    const mode = fs.statSync(home).mode & 0o777;
    return { name: 'router home access', ok: (mode & 0o077) === 0, blocking: false,
      detail: (mode & 0o077) === 0 ? 'mode 0700' : `mode 0${mode.toString(8)}: other users can read prompts; run agentic-router init to fix` };
  } catch { return { name: 'router home access', ok: false, blocking: false, detail: 'could not read the permissions' }; }
}

export interface HookClient { sessionId?: string; node?: string; nodeVersion?: string; routerHome?: string; port?: number; seenAt?: string }

/**
 * Compares what the hooks inside Claude Code reported at SessionStart (decision 97) with this CLI's
 * view: a different router home or port means hook events never reach this daemon (env audit #7).
 */
export function compareHookClient(c: HookClient, home: string, port: number): Check {
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  const problems: string[] = [];
  if (c.routerHome && norm(c.routerHome) !== norm(home)) problems.push(`hooks use router home ${c.routerHome}, the CLI uses ${home} (set the same AGENTIC_ROUTER_HOME for both, or neither)`);
  if (c.port && c.port !== port) problems.push(`hooks use port ${c.port}, the daemon listens on ${port}`);
  if (c.nodeVersion && Number(c.nodeVersion.replace(/^v/, '').split('.')[0]) < 24) problems.push(`hooks run node ${c.nodeVersion} (${c.node ?? '?'}); need >= 24`);
  return { name: 'hooks seen from Claude Code', ok: problems.length === 0, blocking: false,
    detail: problems.join('; ') || `last session ${c.seenAt ?? '?'}: node ${c.nodeVersion ?? '?'}, same home and port` };
}

type DaemonStatus = { clients?: HookClient[]; routing?: StatusView['routing'] };

async function daemonStatus(port: number): Promise<DaemonStatus | null> {
  try {
    const token = fs.readFileSync(paths.token(), 'utf8').trim();
    const r = await localRequest(port, 'GET', '/router/v1/status', { token, timeoutMs: 1500 });
    if (!r || r.status !== 200) return null;
    return JSON.parse(r.body) as DaemonStatus;
  } catch { return null; }
}

function hookClientCheck(st: DaemonStatus, port: number): Check {
  const clients = st.clients ?? [];
  if (!clients.length) return { name: 'hooks seen from Claude Code', ok: true, blocking: false, detail: 'no Claude Code session has reported yet (start one with the plugin loaded)' };
  return compareHookClient(clients[0]!, routerHome(), port);
}

/** Hint headers (x-claude-code-prompt-id, request-class) reach a custom base URL from 2.1.273 (decision 130). */
export const MIN_CLAUDE_API = [2, 1, 273] as const;

export interface ApiCheckInput {
  cfg: CliConfig;
  env: NodeJS.ProcessEnv;
  claudeVersion: string;
  settingsFile: string;
  projectDir: string;
  keyStatus(): Promise<'present' | VaultErrorCode>;
  proxyHealth(port: number): Promise<{ ok: boolean; upstream?: string; inflight?: number } | null>;
  supervise: SuperviseStatus | null;
}

const CREDENTIAL_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'];

/** API-key mode checks (decision 130): settings, project overrides, TLS, keychain, proxy, supervisor. */
export async function apiChecks(i: ApiCheckInput): Promise<Check[]> {
  const out: Check[] = [];
  const mode = i.cfg.apiMode!;
  out.push({ name: 'claude code (API mode)', ok: versionAtLeast(i.claudeVersion, MIN_CLAUDE_API), blocking: true,
    detail: versionAtLeast(i.claudeVersion, MIN_CLAUDE_API) ? 'sends the gateway hint headers' : `need >= ${MIN_CLAUDE_API.join('.')} for the prompt and request-class headers (have ${i.claudeVersion || 'none'})` });
  // the user settings the mode needs
  const problems: string[] = [];
  try {
    const s = readJsonFile<Record<string, any>>(i.settingsFile, {});
    const env = s.env && typeof s.env === 'object' ? s.env as Record<string, unknown> : {};
    const helper = String(s.apiKeyHelper ?? '');
    if (mode === 'proxy') {
      if (!(isRouterHelper(helper) && helper.includes('local-token'))) problems.push('apiKeyHelper is not the router\'s local-token helper');
      if (env.ANTHROPIC_BASE_URL !== proxyBaseUrl(i.cfg.proxyPort ?? 0)) problems.push(`env.ANTHROPIC_BASE_URL is ${JSON.stringify(env.ANTHROPIC_BASE_URL)}, not ${proxyBaseUrl(i.cfg.proxyPort ?? 0)}`);
      if (env[HINT_HEADERS_ENV] !== '1') problems.push(`env.${HINT_HEADERS_ENV} is not "1"`);
    } else {
      if (!(isRouterHelper(helper) && helper.includes('key-helper'))) problems.push('apiKeyHelper is not the router\'s keychain key helper');
      if (typeof env.ANTHROPIC_BASE_URL === 'string' && /127\.0\.0\.1|localhost/.test(env.ANTHROPIC_BASE_URL)) problems.push('env.ANTHROPIC_BASE_URL still points at the local proxy');
    }
    for (const k of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) if (k in env) problems.push(`env.${k} is set and takes precedence over apiKeyHelper`);
  } catch (e) { problems.push(e instanceof SettingsParseError ? e.message : String(e)); }
  out.push({ name: `Claude Code settings (${mode})`, ok: problems.length === 0, blocking: true,
    detail: problems.length ? `${problems.join('; ')} (run agentic-router mode ${mode})` : i.settingsFile });
  // a project's own settings override the user's
  for (const f of [path.join(i.projectDir, '.claude', 'settings.json'), path.join(i.projectDir, '.claude', 'settings.local.json')]) {
    let s: Record<string, any>;
    try { s = readJsonFile<Record<string, any>>(f, {}); } catch { continue; }
    const env = s.env && typeof s.env === 'object' ? s.env as Record<string, unknown> : {};
    const set = [...CREDENTIAL_KEYS.filter(k => k in env).map(k => `env.${k}`), ...(s.apiKeyHelper !== undefined ? ['apiKeyHelper'] : [])];
    if (set.length) out.push({ name: 'project settings override', ok: false, blocking: false,
      detail: `${f} sets ${set.join(', ')}: in that project Claude Code does not use the router's ${mode} settings (it may send requests elsewhere)` });
  }
  if (i.env.ANTHROPIC_AUTH_TOKEN) out.push({ name: 'ANTHROPIC_AUTH_TOKEN in environment', ok: false, blocking: true,
    detail: 'it takes precedence over apiKeyHelper, so requests would not carry the router\'s credential; unset it' });
  if (i.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') out.push({ name: 'NODE_TLS_REJECT_UNAUTHORIZED', ok: false, blocking: true,
    detail: '0 turns off TLS verification: the proxy refuses to start (it does not send the key without it)' });
  const ks = await i.keyStatus();
  const keyHelp: Record<string, string> = {
    not_found: 'no API key stored: run agentic-router key set',
    unavailable: 'the OS keychain tool is not available (Windows PowerShell 5.1, macOS security, Linux secret-tool)',
    constrained_language: 'PowerShell runs in ConstrainedLanguage mode (device policy): keychain access is blocked, API-key mode cannot work here',
  };
  out.push({ name: 'API key in the OS keychain', ok: ks === 'present', blocking: true, detail: ks === 'present' ? 'present' : keyHelp[ks] ?? `keychain check failed (${ks})` });
  if (mode === 'proxy' && i.cfg.proxyPort) {
    const h = await i.proxyHealth(i.cfg.proxyPort);
    out.push({ name: 'proxy', ok: !!h?.ok, blocking: false,
      detail: h?.ok ? `running on 127.0.0.1:${i.cfg.proxyPort} -> ${h.upstream ?? '?'}` : `not answering on 127.0.0.1:${i.cfg.proxyPort}: API calls fail until it runs (agentic-router start), or switch with agentic-router mode direct` });
  }
  const degraded = Object.entries(i.supervise?.children ?? {}).filter(([, c]) => c.state === 'degraded').map(([n, c]) => `${n} (${c.restarts} restarts)`);
  if (degraded.length) out.push({ name: 'supervisor', ok: false, blocking: false, detail: `keeps failing: ${degraded.join(', ')}; see the logs in ${paths.logsDir()}` });
  return out;
}

export async function doctor(env: NodeJS.ProcessEnv = process.env): Promise<Check[]> {
  const checks: Check[] = [];
  const node = process.versions.node;
  checks.push({ name: 'node', ok: Number(node.split('.')[0]) >= 24, blocking: true, detail: node });
  let claude = '';
  // On Windows an npm-installed claude is a .cmd shim, which execFile cannot start without a shell (review #8).
  // The command line is fixed (no user input), so shell:true is safe here.
  try {
    const o = { encoding: 'utf8' as const, timeout: 20000, windowsHide: true };
    claude = (process.platform === 'win32' ? execSync('claude --version', o) : execFileSync('claude', ['--version'], o)).trim();
  } catch { /* not installed */ }
  checks.push({ name: 'claude code', ok: versionAtLeast(claude, MIN_CLAUDE), blocking: true, detail: claude || 'not found' + ` (need >= ${MIN_CLAUDE.join('.')})` });
  const cfg = readConfig();
  checks.push({ name: 'init', ok: !!cfg && fs.existsSync(paths.token()), blocking: true, detail: cfg ? `port ${cfg.daemonPort}` : 'run agentic-router init' });
  if (cfg) {
    const h = await health(cfg.daemonPort);
    checks.push({ name: 'daemon', ok: !!h, blocking: false, detail: h ? `running (${h.version ?? '?'})` : 'not running: Claude Code works, but without routing' });
    const st = h ? await daemonStatus(cfg.daemonPort) : null;
    if (st) checks.push(hookClientCheck(st, cfg.daemonPort));
    // decision 138: what auto-release does now (from the daemon), or what the config file will make it do
    if (st?.routing) checks.push(...routingChecks(st.routing));
    else { const a = configuredAutoRelease(cfg); checks.push({ name: 'auto-release (config)', ok: true, blocking: false, detail: autoReleaseSummary(a.mode, a.rate) }); }
  }
  if (cfg?.apiMode) {
    let token = '';
    try { token = fs.readFileSync(path.join(routerHome(), 'proxy-token'), 'utf8').trim(); } catch { /* reported by the proxy check */ }
    checks.push(...await apiChecks({
      cfg, env, claudeVersion: claude, settingsFile: defaultClaudeSettings(env), projectDir: process.cwd(),
      keyStatus: () => keyStatus(), proxyHealth: port => proxyHealth(port, token), supervise: readSuperviseStatus(),
    }));
  }
  checks.push(...environmentChecks(env));
  if (cfg) checks.push({ name: 'prompt text', ok: true, blocking: false, detail: promptStorageSummary(cfg.recordPrompts) });   // decision 142
  // audit C6: the dashboard is served from its build; the router works without it (loaded here only, so other
  // commands do not load the daemon)
  try {
    const { DEFAULT_DASHBOARD_DIST } = await import('@agentic-router/daemon');
    const built = fs.existsSync(path.join(DEFAULT_DASHBOARD_DIST, 'index.html'));
    checks.push({ name: 'dashboard assets', ok: built, blocking: false,
      detail: built ? 'built' : 'not built: run `npm run build:dashboard` (the dashboard serves a build page until then)' });
  } catch { /* the daemon package is not installed next to the CLI */ }
  // decision 142: the current repository's policy counts only once accepted
  try { checks.push(policyCheck(await loadGuard(cfg?.pluginDir), process.cwd())); } catch { /* no plugin here */ }
  // decision 142: a settings backup made before it may hold a credential in plain text
  const held = backupCredentials(defaultClaudeSettings());
  if (held.length) checks.push({ name: 'settings backup', ok: false, blocking: false, detail: `${backupFile(defaultClaudeSettings())} holds ${held.join(', ')} in plain text: run agentic-router init, which offers to remove it` });
  const access = homeAccessCheck();
  if (access) checks.push(access);
  checks.push(...ladderBreakers(env));
  return checks;
}
