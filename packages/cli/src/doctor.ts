// `doctor`: environment checks that decide whether routing can work (spec 5.4, decision 30-35).
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths, routerHome } from '@agentic-router/core';
import { keyStatus, noProxyCovers, shownProxyUrl, splitNoProxy, upstreamProxy, type VaultErrorCode } from '@agentic-router/proxy';
import { HINT_HEADERS_ENV, claudeCodeProxy, isRouterHelper, proxyBaseUrl, uncoveredNoProxy } from './apimode.ts';
import { SettingsParseError, backupCredentials, backupFile, defaultClaudeSettings, promptStorageSummary, readConfig, readJsonFile, type CliConfig } from './setup.ts';
import { daemonIdentity, daemonRequest, otherOnPort } from './daemonctl.ts';
import { portOwner } from './portowner.ts';
import { proxyHolder, type ProxyHolder } from './proxyholder.ts';
import { RENEW_WITHIN_DAYS, WARN_WITHIN_DAYS, bundleSources, bundleStatus, certInfo, certProblems, pairMatches, pemFingerprints, tlsPaths } from './localtls.ts';
import { proxyHealth, readSuperviseStatus, type ProxyHealth, type SuperviseStatus } from './supervise.ts';
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
  // NODE_USE_ENV_PROXY gives Node's global agent the environment's proxy: then the hooks' and this CLI's calls to
  // the daemon on 127.0.0.1 (daemon token included) go to http_proxy unless NO_PROXY names loopback
  const envProxy = env.NODE_USE_ENV_PROXY === '1' || /(^|\s)--use-env-proxy(\s|$)/.test(env.NODE_OPTIONS ?? '');
  const httpProxy = env.http_proxy?.trim() || env.HTTP_PROXY?.trim();
  if (envProxy && httpProxy && !noProxyCovers(splitNoProxy(env.no_proxy ?? env.NO_PROXY), '127.0.0.1')) {
    out.push({ name: 'NODE_USE_ENV_PROXY', ok: false, blocking: false,
      detail: `Node sends plain-http requests through ${shownProxyUrl(httpProxy)}, so the plugin's hooks and the CLI could not reach the daemon on 127.0.0.1: add 127.0.0.1,localhost to NO_PROXY` });
  }
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
    // decision 156: sealed, so the token is not sent to whatever holds the port
    const r = await daemonRequest(port, 'GET', '/router/v1/status', { token, timeoutMs: 1500 });
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
  proxyHealth(port: number): Promise<ProxyHealth | null>;
  supervise: SuperviseStatus | null;
  /** Tests: the clock for the certificate dates, and the port-owner lookup. */
  now?: () => Date;
  proxyHolder?: (port: number) => Promise<ProxyHolder>;
}

/**
 * Decision 157: local TLS in proxy mode. On: the certificate (dates, names, a key that matches, the leaf shape), what
 * Claude Code trusts, and the bundle. Decision 158: the settings value of NODE_EXTRA_CA_CERTS replaces the launch
 * environment's, so the settings value must hold the router's certificate; a launch value that is not the bundle is
 * a warning (works today; would fail closed, with a TLS error, if a later Claude Code let the launch value win).
 * Off: why, as a warning.
 */
export function localTlsChecks(cfg: CliConfig, settingsEnv: Record<string, unknown>, env: NodeJS.ProcessEnv, now = new Date()): Check[] {
  if (cfg.proxy?.tls !== true) {
    return [{ name: 'local TLS', ok: false, blocking: false, detail: `off: ${cfg.localTls?.off ?? 'not set up (run agentic-router mode api)'}; the helper still checks the proxy before it gives out the token` }];
  }
  const p = tlsPaths();
  let pem = '';
  let key = '';
  try { pem = fs.readFileSync(p.cert, 'utf8'); } catch { /* below */ }
  try { key = fs.readFileSync(p.key, 'utf8'); } catch { /* below */ }
  const info = pem ? certInfo(pem) : null;
  const { problems, daysLeft } = certProblems(info, now);
  if (!key) problems.push('its key is missing');
  else if (info && !pairMatches(pem, key)) problems.push('its key does not match it');
  const out: Check[] = [];
  if (problems.length) out.push({ name: 'local TLS', ok: false, blocking: true, detail: `${p.cert}: ${problems.join('; ')}. Run agentic-router mode api (it makes a new pair)` });
  else if (info!.ca) out.push({ name: 'local TLS', ok: false, blocking: false, detail: `${p.cert} is a CA certificate (the older shape, whose key could make certificates Claude Code would accept for any name): it is remade as a leaf at the next agentic-router start or mode api` });
  else out.push({ name: 'local TLS', ok: daysLeft > WARN_WITHIN_DAYS, blocking: false,
    detail: `on: certificate for 127.0.0.1 and localhost, valid until ${info!.notAfter.toISOString().slice(0, 10)} (${daysLeft} days)${daysLeft <= RENEW_WITHIN_DAYS ? '; renewed at the next agentic-router start or mode api (restart Claude Code sessions after it)' : daysLeft <= WARN_WITHIN_DAYS ? `; renewed when ${RENEW_WITHIN_DAYS} days are left` : ''}` });
  if (!info) return out;
  const holds = (file: string) => { try { return pemFingerprints(fs.readFileSync(file, 'utf8')).includes(info.fingerprint); } catch { return false; } };
  const shell = env.NODE_EXTRA_CA_CERTS?.trim();
  const set = typeof settingsEnv.NODE_EXTRA_CA_CERTS === 'string' ? (settingsEnv.NODE_EXTRA_CA_CERTS as string).trim() : '';
  // what Claude Code uses: the settings value (it replaces the launch one)
  out.push(set && holds(set)
    ? { name: 'local TLS trust', ok: true, blocking: false, detail: `NODE_EXTRA_CA_CERTS in Claude Code's settings (${set}) holds the router's certificate` }
    : { name: 'local TLS trust', ok: false, blocking: true, detail: `NODE_EXTRA_CA_CERTS in Claude Code's settings ${set ? `(${set}) does not hold` : 'does not name'} the router's certificate: requests to the proxy fail. Run agentic-router mode api` });
  // the bundle against its sources (review L5): a source that changed or cannot be read is reported; mode api rebuilds
  const sources = bundleSources(cfg.localTls?.bundleFrom);
  const usesBundle = !!set && path.resolve(set) === path.resolve(p.bundle);
  if (usesBundle) {
    const b = bundleStatus(routerHome(), sources);
    if (b.unreadable.length) out.push({ name: 'local TLS bundle', ok: false, blocking: false, detail: `${b.unreadable.join(', ')} (combined into ${p.bundle}) cannot be read, so its certificates are not trusted now. Fix it, then run agentic-router mode api` });
    else if (!b.current) out.push({ name: 'local TLS bundle', ok: false, blocking: false, detail: `${p.bundle} is out of date: ${sources.length ? `${sources.join(', ')} changed since it was written` : 'its sources are not recorded'}. Run agentic-router mode api (it rebuilds it)` });
  }
  // a launch value: today the settings value wins; if a later Claude Code let the launch value win, TLS would fail closed
  const inBundle = (f: string) => sources.some(s => path.resolve(s) === path.resolve(f));
  if (shell && path.resolve(shell) !== path.resolve(p.bundle)) {
    out.push(usesBundle && inBundle(shell)
      ? { name: 'NODE_EXTRA_CA_CERTS in your environment', ok: false, blocking: false, detail: `${shell} is combined into ${p.bundle}, which Claude Code uses (its settings value replaces yours). Point your variable at ${p.bundle} so both orders work` }
      : { name: 'NODE_EXTRA_CA_CERTS in your environment', ok: false, blocking: false, detail: `${shell} is not in what Claude Code uses (its settings value replaces yours), so those certificates are not trusted by it now (WebFetch or MCP through a TLS-inspecting proxy may fail). Run agentic-router mode api to combine them` });
  }
  return out;
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
  let settingsEnv: Record<string, unknown> = {};
  try {
    const s = readJsonFile<Record<string, any>>(i.settingsFile, {});
    const env = s.env && typeof s.env === 'object' ? s.env as Record<string, unknown> : {};
    settingsEnv = env;
    const helper = String(s.apiKeyHelper ?? '');
    if (mode === 'proxy') {
      if (!(isRouterHelper(helper) && helper.includes('local-token'))) problems.push('apiKeyHelper is not the router\'s local-token helper');
      const want = proxyBaseUrl(i.cfg.proxyPort ?? 0, i.cfg.proxy?.tls === true);
      if (env.ANTHROPIC_BASE_URL !== want) problems.push(`env.ANTHROPIC_BASE_URL is ${JSON.stringify(env.ANTHROPIC_BASE_URL)}, not ${want}`);
      if (env[HINT_HEADERS_ENV] !== '1') problems.push(`env.${HINT_HEADERS_ENV} is not "1"`);
    } else {
      if (!(isRouterHelper(helper) && helper.includes('key-helper'))) problems.push('apiKeyHelper is not the router\'s keychain key helper');
      if (typeof env.ANTHROPIC_BASE_URL === 'string' && /127\.0\.0\.1|localhost/.test(env.ANTHROPIC_BASE_URL)) problems.push('env.ANTHROPIC_BASE_URL still points at the local proxy');
    }
    for (const k of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) if (k in env) problems.push(`env.${k} is set and takes precedence over apiKeyHelper`);
  } catch (e) { problems.push(e instanceof SettingsParseError ? e.message : String(e)); }
  out.push({ name: `Claude Code settings (${mode})`, ok: problems.length === 0, blocking: true,
    detail: problems.length ? `${problems.join('; ')} (run agentic-router mode ${mode})` : i.settingsFile });
  // a corporate proxy, both ways: Claude Code must not send its requests for 127.0.0.1 to it (network-config), and
  // the router's proxy reaches the API through it (egress)
  const corp = claudeCodeProxy(settingsEnv, i.env);
  if (mode === 'proxy' && corp) {
    const missing = uncoveredNoProxy(settingsEnv, i.env, i.cfg.proxyPort ?? 0);
    out.push({ name: 'Claude Code and your proxy', ok: !missing.length, blocking: true,
      detail: missing.length
        ? `${corp.name} is ${corp.shown}, and ${missing.join(' / ')} does not name 127.0.0.1: Claude Code would send its requests for the local proxy, local token included, to that proxy. Run agentic-router mode api (it adds 127.0.0.1 and localhost to NO_PROXY in Claude Code's settings)`
        : `${corp.name} is ${corp.shown}; NO_PROXY keeps Claude Code's requests for the local proxy off it` });
  }
  if (mode === 'proxy') out.push(...localTlsChecks(i.cfg, settingsEnv, i.env, i.now?.() ?? new Date()));
  if (mode === 'proxy') {
    try {
      const e = upstreamProxy(i.env);
      if (e) out.push({ name: 'API through your proxy', ok: true, blocking: false, detail: `the router's proxy reaches the API through ${e.shown} (${e.from}, from this shell's environment when the proxy starts); TLS to the API is verified end to end` });
    } catch (e) {
      out.push({ name: 'API through your proxy', ok: false, blocking: true, detail: `${(e as Error).message}; the router's proxy does not start until this is fixed` });
    }
  }
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
    if (h?.other) {
      // decision 156: what answers does not prove it is this router's proxy. The user's own node process is most likely
      // an older proxy or one restarting after a TLS switch (a warning); another user's or an unknown one is treated as
      // a squatter (blocking). The helper gives none of them a token.
      const holder = await (i.proxyHolder ?? proxyHolder)(i.cfg.proxyPort);
      const proves = `it cannot prove it holds the local token${i.cfg.proxy?.tls ? ' or present the router\'s certificate' : ''}`;
      out.push(holder.own
        ? { name: 'proxy', ok: false, blocking: false, detail: `port ${i.cfg.proxyPort} is answered by ${holder.phrase}, which does not prove it is this router's proxy: most likely an older proxy, or one restarting after a TLS switch. agentic-router stop, then agentic-router start` }
        : { name: 'proxy', ok: false, blocking: true, detail: `port ${i.cfg.proxyPort} is answered by ${holder.phrase}, which is not this router's proxy (${proves}). The helper gives it no token. Stop it, then agentic-router start` });
    } else out.push({ name: 'proxy', ok: !!h?.ok, blocking: false,
      detail: h?.ok ? `running on 127.0.0.1:${i.cfg.proxyPort} -> ${h.upstream ?? '?'}${h.via ? ` via ${h.via}` : ''}` : `not answering on 127.0.0.1:${i.cfg.proxyPort}: API calls fail until it runs (agentic-router start), or switch with agentic-router mode direct` });
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
    // decision 156: who answers on the daemon port (sealed; a program without the token is named, never trusted)
    let daemonToken = '';
    try { daemonToken = fs.readFileSync(paths.token(), 'utf8').trim(); } catch { /* init check above */ }
    const id = await daemonIdentity(cfg.daemonPort, daemonToken);
    if (id.who === 'other') {
      const owner = await portOwner(cfg.daemonPort);
      checks.push({ name: 'daemon', ok: false, blocking: true, detail: `${otherOnPort(cfg.daemonPort)}${owner ? ` (${owner})` : ''}` });
    } else checks.push({ name: 'daemon', ok: id.who === 'ours', blocking: false, detail: id.who === 'ours' ? `running (${id.version ?? '?'})` : 'not running: Claude Code works, but without routing' });
    const st = id.who === 'ours' ? await daemonStatus(cfg.daemonPort) : null;
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
