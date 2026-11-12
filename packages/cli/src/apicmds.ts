// API-key mode commands (decisions 130-131, spec 2.1): init --mode api, mode subscription|api|direct|proxy,
// token rotate, key set, proxy allow-upstream. Everything that reaches outside this process (the keychain, Claude Code's login
// status, the user's confirmation, stdin) comes in through ApiDeps, so tests use fakes.
import fs from 'node:fs';
import path from 'node:path';
import { routerHome } from '@agentic-router/core';
import {
  DEFAULT_DAILY_CAP_USD, DEFAULT_TOKEN_DAILY_CAP_USD, ROTATION_GRACE_MS, checkUpstream, keyStatus, newToken, storeKey, writeTokenFile, type VaultErrorCode,
} from '@agentic-router/proxy';
import { claudeAuthStatus, detectLogin, planApiSettings, planSubscriptionSettings, type ApiMode, type CommandRunner } from './apimode.ts';
import { runningSupervisor } from './daemonctl.ts';
import { pickPort, readConfig, restrictHome, writeConfig, writeJsonAtomic, type CliConfig, type PlannedChange } from './setup.ts';
import { superviseFiles } from './supervise.ts';

export interface ApiDeps {
  settingsFile: string;
  confirm(changes: PlannedChange[], yes: boolean): Promise<boolean>;
  login: CommandRunner;
  vault: {
    status(): Promise<'present' | VaultErrorCode>;
    /** The keychain tool prompts on the user's terminal; the key never passes through this process. */
    storeInteractive(): Promise<void>;
    storeFromStdin(key: string): Promise<void>;
  };
  isTTY: boolean;
  readStdin(): Promise<string>;
  out(line: string): void;
  /** Asks a running supervisor to re-read the mode (start or stop the proxy); false when none runs. */
  reload?(): boolean;
}

/** The real reload: a file the supervisor polls for (portable to Windows, where signals are hard kills). */
export function realReload(): boolean {
  if (!runningSupervisor()) return false;
  fs.writeFileSync(superviseFiles().reload, String(Date.now()));
  return true;
}

export const realVault: ApiDeps['vault'] = {
  status: () => keyStatus(),
  storeInteractive: () => storeKey({ interactive: true }),
  storeFromStdin: key => storeKey({ interactive: false, key }),
};
export const realLogin = claudeAuthStatus;

export const proxyTokenFile = (home = routerHome()) => path.join(home, 'proxy-token');

const vaultHelp: Record<string, string> = {
  unavailable: 'the OS keychain tool is not available (Windows PowerShell 5.1, macOS security, or Linux secret-tool from libsecret-tools)',
  constrained_language: 'PowerShell runs in ConstrainedLanguage mode (device policy), which blocks keychain access: API-key mode is unavailable on this machine',
  failed: 'the keychain could not be read',
  invalid_key: 'the keychain entry is not a valid key: store it again with agentic-router key set',
};

type Step = { ok: true } | { ok: false; code: number };

/** Stores the key: interactively on a terminal, else from stdin with --key-stdin (never from a flag or the environment). */
async function storeKeyStep(f: Record<string, string | boolean>, d: ApiDeps): Promise<Step> {
  if (f['key-stdin'] === true) {
    const key = (await d.readStdin()).trim();
    if (!key) { d.out('no key on stdin'); return { ok: false, code: 2 }; }
    await d.vault.storeFromStdin(key);
    d.out('API key stored in the OS keychain');
    return { ok: true };
  }
  if (!d.isTTY) { d.out('no API key in the OS keychain: run in a terminal, or pipe the key with --key-stdin'); return { ok: false, code: 2 }; }
  d.out('Enter the Anthropic API key (the keychain tool asks for it; it is not shown and never stored elsewhere):');
  await d.vault.storeInteractive();
  d.out('API key stored in the OS keychain');
  return { ok: true };
}

/** No saved claude.ai / Console login next to the gateway credential (an auth conflict), unless --allow-login. */
async function loginStep(f: Record<string, string | boolean>, d: ApiDeps, again: string): Promise<Step> {
  const login = await detectLogin(d.login);
  if (login.state === 'saved_login' && f['allow-login'] !== true) {
    d.out(`Claude Code has a saved login${login.method ? ` (${login.method})` : ''}. API-key mode needs it gone: a gateway credential next to a saved login gives an auth conflict. `
      + `Run \`claude auth logout\` (or /logout in Claude Code), then run \`${again}\` again. (--allow-login continues anyway.)`);
    return { ok: false, code: 2 };
  }
  if (login.state === 'unknown') d.out('Could not tell whether Claude Code has a saved claude.ai login. If it has, run `claude auth logout` (or /logout) before using API-key mode.');
  return { ok: true };
}

/** Before init --mode api writes anything: no saved Claude login, and a usable keychain holding the key. */
export async function preflightApi(f: Record<string, string | boolean>, d: ApiDeps): Promise<Step> {
  const login = await loginStep(f, d, 'agentic-router init --mode api');
  if (!login.ok) return login;
  const status = await d.vault.status();
  if (status === 'present') { d.out('API key found in the OS keychain'); return { ok: true }; }
  if (status !== 'not_found') { d.out(`keychain: ${vaultHelp[status] ?? status}`); return { ok: false, code: 2 }; }
  if (f['no-key'] === true) { d.out('no API key stored yet (--no-key): run agentic-router key set before starting'); return { ok: true }; }
  return storeKeyStep(f, d);
}

/** Proxy port (not the daemon's), daily caps (decision 131: applied, not asked), mode, local token file. */
export async function configureApi(config: CliConfig, d: Pick<ApiDeps, 'out'>): Promise<CliConfig> {
  const proxyPort = config.proxyPort && config.proxyPort !== config.daemonPort ? config.proxyPort : await pickPort(47800, 47999, new Set([config.daemonPort]));
  const proxy = {
    ...config.proxy,
    tokenDailyCapUsd: config.proxy?.tokenDailyCapUsd ?? DEFAULT_TOKEN_DAILY_CAP_USD,
    dailyCapUsd: config.proxy?.dailyCapUsd ?? DEFAULT_DAILY_CAP_USD,
  };
  const next: CliConfig = { ...config, proxyPort, proxy, apiMode: 'proxy' };
  writeConfig(next);
  const tokenFile = proxyTokenFile();
  if (!fs.existsSync(tokenFile)) writeTokenFile(tokenFile, newToken());
  restrictHome();
  d.out(`API-key mode: proxy port ${proxyPort}, daily caps $${proxy.tokenDailyCapUsd} per local token and $${proxy.dailyCapUsd} in all (change proxy.tokenDailyCapUsd / proxy.dailyCapUsd in config.json)`);
  return next;
}

/** `mode direct|proxy`: swaps the helper and the base URL in Claude Code's settings (confirmed), then config. */
export async function setMode(mode: ApiMode, f: Record<string, string | boolean>, d: ApiDeps): Promise<number> {
  const cfg = readConfig();
  if (!cfg?.apiMode || !cfg.proxyPort) { d.out('API-key mode is not set up: run agentic-router init --mode api first'); return 2; }
  if (mode === 'direct') {
    const s = await d.vault.status();
    if (s !== 'present') { d.out(`direct mode reads the key from the keychain, but: ${s === 'not_found' ? 'no key is stored (agentic-router key set)' : vaultHelp[s] ?? s}`); return 2; }
  }
  const change = planApiSettings(d.settingsFile, mode, cfg.proxyPort);
  if (change && !await d.confirm([change], f.yes === true)) { d.out('nothing changed'); return 1; }
  change?.apply();
  writeConfig({ ...cfg, apiMode: mode });
  const live = (d.reload ?? realReload)();
  d.out(mode === 'direct'
    ? `Direct mode: new Claude Code sessions talk to the API themselves with the key from the keychain (no proxy, no budget blocking). ${live ? 'The supervisor stops the proxy now. ' : ''}Restart running Claude Code sessions.`
    : `Proxy mode: new Claude Code sessions go through the proxy. ${live ? 'The supervisor starts it now;' : 'Run `agentic-router start` to run it;'} then restart running Claude Code sessions.`);
  return 0;
}

/**
 * `mode subscription` (spec 2.1): back to the claude.ai subscription once its limit has recovered. Takes the
 * router's base URL, hint variable and apiKeyHelper out of Claude Code's settings (confirmed) and stops the
 * proxy under the supervisor. The key stays in the keychain and the local token file stays: `mode api`
 * switches back without setting up again.
 */
export async function modeSubscription(f: Record<string, string | boolean>, d: ApiDeps): Promise<number> {
  const cfg = readConfig();
  if (!cfg) { d.out('Not set up yet: run agentic-router init first.'); return 2; }
  const change = planSubscriptionSettings(d.settingsFile);
  if (!cfg.apiMode && !change) { d.out('Already in subscription mode: nothing to change.'); return 0; }
  if (change && !await d.confirm([change], f.yes === true)) { d.out('nothing changed'); return 1; }
  change?.apply();
  const { apiMode: _gone, ...rest } = cfg;
  writeConfig(rest);
  const live = (d.reload ?? realReload)();
  d.out(`Subscription mode: new Claude Code sessions use the claude.ai login. If you logged out for API-key mode, log in again (/login in Claude Code). ${live ? 'The supervisor stops the proxy now. ' : ''}`
    + 'The API key stays in the keychain, so `agentic-router mode api` switches back. Restart running Claude Code sessions.');
  return 0;
}

/**
 * `mode api` (spec 2.1): API-key mode through the proxy again, for a setup that has a key and a local token
 * already (else init --mode api). The saved-login check of init applies; the settings change is confirmed and
 * the supervisor starts the proxy.
 */
export async function modeApi(f: Record<string, string | boolean>, d: ApiDeps): Promise<number> {
  const cfg = readConfig();
  if (!cfg?.proxyPort || !fs.existsSync(proxyTokenFile())) { d.out('API-key mode is not set up: run agentic-router init --mode api first'); return 2; }
  const status = await d.vault.status();
  if (status !== 'present') { d.out(`API-key mode needs the key in the keychain, but: ${status === 'not_found' ? 'no key is stored (agentic-router key set)' : vaultHelp[status] ?? status}`); return 2; }
  const login = await loginStep(f, d, 'agentic-router mode api');
  if (!login.ok) return login.code;
  const change = planApiSettings(d.settingsFile, 'proxy', cfg.proxyPort);
  if (cfg.apiMode === 'proxy' && !change) { d.out('Already in API-key mode through the proxy: nothing to change.'); return 0; }
  if (change && !await d.confirm([change], f.yes === true)) { d.out('nothing changed'); return 1; }
  change?.apply();
  writeConfig({ ...cfg, apiMode: 'proxy' });
  const live = (d.reload ?? realReload)();
  d.out(`API-key mode (proxy): new Claude Code sessions go through the proxy. ${live ? 'The supervisor starts it now;' : 'Run `agentic-router start` to run it;'} then restart running Claude Code sessions.`);
  return 0;
}

/** `token rotate`: a new local token; the proxy keeps the old one valid for the grace window. */
export function tokenRotate(d: Pick<ApiDeps, 'out'>): number {
  const cfg = readConfig();
  if (!cfg?.apiMode) { d.out('API-key mode is not set up: run agentic-router init --mode api first'); return 2; }
  writeTokenFile(proxyTokenFile(), newToken());
  restrictHome();
  d.out(`local token rotated. The proxy accepts the old one for ${Math.round(ROTATION_GRACE_MS / 60000)} more minutes; Claude Code picks up the new one through its apiKeyHelper (a 401 makes it ask again), so sessions keep working.`);
  return 0;
}

/** `key set`: replaces the key in the keychain. The running proxy loads it at its next start. */
export async function keySet(f: Record<string, string | boolean>, d: ApiDeps): Promise<number> {
  const status = await d.vault.status();
  if (status !== 'present' && status !== 'not_found') { d.out(`keychain: ${vaultHelp[status] ?? status}`); return 2; }
  const r = await storeKeyStep(f, d);
  if (!r.ok) return r.code;
  if (readConfig()?.apiMode === 'proxy') d.out('Run agentic-router stop and start so the proxy loads the new key.');
  return 0;
}

/** `proxy allow-upstream <origin> [--use]`: an https origin the proxy may send the key to (confirmed). */
export async function allowUpstream(origin: string | undefined, f: Record<string, string | boolean>, d: ApiDeps, configFile: string): Promise<number> {
  if (!origin) { d.out('usage: agentic-router proxy allow-upstream <https origin> [--use]'); return 2; }
  let normalized: string;
  try { normalized = checkUpstream(origin, [origin]).url.origin; } catch (e) { d.out(String((e as Error).message)); return 2; }
  const cfg = readConfig();
  if (!cfg) { d.out('not initialised: run agentic-router init first'); return 2; }
  const allowed = [...new Set([...(cfg.proxy?.allowedUpstreams ?? []), normalized])];
  const use = f.use === true;
  const change: PlannedChange = {
    file: configFile,
    summary: `proxy.allowedUpstreams += ${normalized}${use ? `; proxy.upstream = ${normalized} (the API key is sent there)` : ''}`,
    apply() {
      writeJsonAtomic(configFile, { ...cfg, proxy: { ...cfg.proxy, allowedUpstreams: allowed, ...(use ? { upstream: normalized } : {}) } });
      restrictHome();
    },
  };
  if (!await d.confirm([change], f.yes === true)) { d.out('nothing changed'); return 1; }
  change.apply();
  d.out(use ? `upstream set to ${normalized}: run agentic-router stop and start` : `${normalized} allowed (use it with --use, or set proxy.upstream)`);
  return 0;
}
