// API-key mode (decisions 130-131): Claude Code's settings for the proxy, the direct-mode bypass (spec 5.4),
// and the check for a saved Claude login.
//
//   proxy   env.ANTHROPIC_BASE_URL = http://127.0.0.1:<proxyPort>, env.CLAUDE_CODE_GATEWAY_HINT_HEADERS = "1",
//           apiKeyHelper = node "<proxy>/bin/local-token.mjs" (prints the local token; the key stays in the
//           keychain and the proxy's memory)
//   direct  no base URL or hint variable, apiKeyHelper = node "<proxy>/bin/key-helper.mjs" (prints the key from
//           the keychain: the bypass while the proxy is down; new Claude Code sessions only)
// A credential variable in the same env block would win over apiKeyHelper (ANTHROPIC_AUTH_TOKEN, then
// ANTHROPIC_API_KEY, then the helper), so the plan removes them. Every change is shown and confirmed first.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from '@agentic-router/core';
import { backupNote, readJsonFile, writeBackup, writeJsonAtomic, type PlannedChange } from './setup.ts';

export type ApiMode = 'proxy' | 'direct';

export const HINT_HEADERS_ENV = 'CLAUDE_CODE_GATEWAY_HINT_HEADERS';
const CREDENTIAL_ENV = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'];

/** The proxy package's folder (src/index.ts resolved, one level up). */
export function proxyPackageDir(): string {
  return path.dirname(path.dirname(fileURLToPath(import.meta.resolve('@agentic-router/proxy'))));
}
export const proxyEntry = (dir = proxyPackageDir()) => path.join(dir, 'src', 'main.ts');
export const localTokenHelper = (dir = proxyPackageDir()) => `node "${path.join(dir, 'bin', 'local-token.mjs')}"`;
export const keyHelper = (dir = proxyPackageDir()) => `node "${path.join(dir, 'bin', 'key-helper.mjs')}"`;
export const proxyBaseUrl = (port: number) => `http://127.0.0.1:${port}`;

/** True when an apiKeyHelper command is one of ours (any install location). */
export function isRouterHelper(command: unknown): boolean {
  return typeof command === 'string' && /(local-token|key-helper)\.mjs/.test(command) && /agentic-router|[\\/]proxy[\\/]bin[\\/]/i.test(command);
}
export const isOurBaseUrl = (v: unknown): boolean => typeof v === 'string' && /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(v);

/** What Claude Code's user settings should hold in a mode, as a planned change (null: already so). */
export function planApiSettings(settingsFile: string, mode: ApiMode, proxyPort: number, pkgDir = proxyPackageDir()): PlannedChange | null {
  const settings = readJsonFile<Record<string, any>>(settingsFile, {});
  const env: Record<string, unknown> = settings.env && typeof settings.env === 'object' ? { ...settings.env } : {};
  const helper = mode === 'proxy' ? localTokenHelper(pkgDir) : keyHelper(pkgDir);
  const notes: string[] = [];
  const prevHelper = settings.apiKeyHelper;
  if (prevHelper !== undefined && prevHelper !== helper) {
    notes.push(isRouterHelper(prevHelper) ? 'apiKeyHelper: switch to the router\'s ' + (mode === 'proxy' ? 'local-token helper' : 'keychain key helper')
      // decision 149: a helper that holds a key literal is neither echoed nor copied into the backup
      : redact(String(prevHelper)) !== String(prevHelper) ? 'apiKeyHelper: replace yours (it holds a key, so it is not shown or kept in the backup)'
      : `apiKeyHelper: replace "${String(prevHelper)}" (kept in the settings backup)`);
  } else if (prevHelper === undefined) notes.push(`apiKeyHelper: ${mode === 'proxy' ? 'the router\'s local token' : 'the API key from the OS keychain'}`);
  for (const k of CREDENTIAL_ENV) if (k in env) { delete env[k]; notes.push(`env.${k}: remove (it would take precedence over apiKeyHelper)`); }
  if (mode === 'proxy') {
    const url = proxyBaseUrl(proxyPort);
    if (env.ANTHROPIC_BASE_URL !== url) {
      notes.push(env.ANTHROPIC_BASE_URL !== undefined && !isOurBaseUrl(env.ANTHROPIC_BASE_URL)
        ? `env.ANTHROPIC_BASE_URL: replace "${String(env.ANTHROPIC_BASE_URL)}" with ${url}` : `env.ANTHROPIC_BASE_URL = ${url}`);
      env.ANTHROPIC_BASE_URL = url;
    }
    if (env[HINT_HEADERS_ENV] !== '1') { env[HINT_HEADERS_ENV] = '1'; notes.push(`env.${HINT_HEADERS_ENV} = "1" (session, prompt and request-class headers for the proxy)`); }
  } else {
    if (isOurBaseUrl(env.ANTHROPIC_BASE_URL)) { delete env.ANTHROPIC_BASE_URL; notes.push('env.ANTHROPIC_BASE_URL: remove (talk to the API directly)'); }
    if (HINT_HEADERS_ENV in env) { delete env[HINT_HEADERS_ENV]; notes.push(`env.${HINT_HEADERS_ENV}: remove`); }
  }
  const unchanged = prevHelper === helper && notes.length === 0;
  if (unchanged) return null;
  return {
    file: settingsFile,
    summary: `API-key mode (${mode}): ${notes.join('; ')}${backupNote(settingsFile)}`,
    apply() {
      writeBackup(settingsFile);   // decision 142: without credential env values
      const next: Record<string, any> = { ...settings, apiKeyHelper: helper };
      if (Object.keys(env).length) next.env = env; else delete next.env;
      writeJsonAtomic(settingsFile, next);
    },
  };
}

/**
 * `mode subscription` (spec 2.1): takes out of Claude Code's settings only what API-key mode put in: our
 * ANTHROPIC_BASE_URL, the hint-headers variable and the router's apiKeyHelper. A helper or gateway of the
 * user's own is left alone (a helper API-key mode replaced is in the settings backup, not restored: it would
 * keep Claude Code off the subscription). Null when there is nothing to take out.
 */
export function planSubscriptionSettings(settingsFile: string): PlannedChange | null {
  const settings = readJsonFile<Record<string, any>>(settingsFile, {});
  const env: Record<string, unknown> = settings.env && typeof settings.env === 'object' ? { ...settings.env } : {};
  const notes: string[] = [];
  const ours = isRouterHelper(settings.apiKeyHelper);
  if (ours) notes.push('apiKeyHelper: remove the router\'s helper');
  if (isOurBaseUrl(env.ANTHROPIC_BASE_URL)) { delete env.ANTHROPIC_BASE_URL; notes.push('env.ANTHROPIC_BASE_URL: remove (back to the claude.ai login)'); }
  if (HINT_HEADERS_ENV in env) { delete env[HINT_HEADERS_ENV]; notes.push(`env.${HINT_HEADERS_ENV}: remove`); }
  if (!notes.length) return null;
  const backup = settingsFile + '.agentic-router.bak';
  if (ours && fs.existsSync(backup)) {
    const before = readJsonFile<Record<string, any>>(backup, {}).apiKeyHelper;
    if (before !== undefined && !isRouterHelper(before)) notes.push(`your earlier apiKeyHelper "${String(before)}" is in ${path.basename(backup)}; it is not put back`);
  }
  return {
    file: settingsFile,
    summary: `subscription mode: ${notes.join('; ')}`,
    apply() {
      const next: Record<string, any> = { ...settings };
      if (ours) delete next.apiKeyHelper;
      if (Object.keys(env).length) next.env = env; else delete next.env;
      writeJsonAtomic(settingsFile, next);
    },
  };
}

// ------------------------------------------------------------------ saved Claude login

export type LoginState = 'saved_login' | 'none' | 'unknown';
export type CommandRunner = () => Promise<{ code: number | null; stdout: string }>;

/** `claude auth status --json`, run by Claude Code itself: the router never reads Claude Code's credentials. */
export const claudeAuthStatus: CommandRunner = () => new Promise(resolve => {
  // On Windows the npm-installed claude is a .cmd shim, so it needs a shell; the command line is fixed.
  execFile(process.platform === 'win32' ? 'claude.cmd' : 'claude', ['auth', 'status', '--json'],
    { encoding: 'utf8', timeout: 20_000, windowsHide: true, shell: process.platform === 'win32' },
    (err, stdout) => resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null) : 0, stdout: stdout ?? '' }));
});

/** authMethod values of `claude auth status --json` that are not a saved login (observed on 2.1.322). */
export const NOT_A_LOGIN = new Set(['none', 'api_key', 'api_key_helper']);

/**
 * Whether Claude Code has a saved claude.ai or Console login. A gateway credential next to a saved login
 * makes Claude Code warn about an auth conflict, so API mode asks for `claude auth logout` (or /logout)
 * first. Only `loggedIn` and `authMethod` are looked at; account fields are never read out.
 *   {"loggedIn": false, "authMethod": "none"}                  no login
 *   {"loggedIn": true,  "authMethod": "api_key"}               ANTHROPIC_API_KEY
 *   {"loggedIn": true,  "authMethod": "api_key_helper"}        an apiKeyHelper (the router's, once set)
 *   {"loggedIn": true,  "authMethod": <anything else>}         counted as a saved login (conservative)
 * Output that does not parse, or has no loggedIn, is 'unknown' (init warns and continues).
 */
export async function detectLogin(run: CommandRunner = claudeAuthStatus): Promise<{ state: LoginState; method?: string }> {
  let r: { code: number | null; stdout: string };
  try { r = await run(); } catch { return { state: 'unknown' }; }
  let o: Record<string, unknown>;
  try { o = JSON.parse(r.stdout) as Record<string, unknown>; } catch { return { state: 'unknown' }; }
  if (!o || typeof o !== 'object' || typeof o.loggedIn !== 'boolean') return { state: 'unknown' };
  const method = typeof o.authMethod === 'string' ? o.authMethod : undefined;
  if (!o.loggedIn) return { state: 'none', ...(method ? { method } : {}) };
  if (method && NOT_A_LOGIN.has(method)) return { state: 'none', method };
  return { state: 'saved_login', ...(method ? { method } : {}) };
}
