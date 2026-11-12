#!/usr/bin/env node
// agentic-router <init|start|stop|status|doctor|dashboard|routing|data|policy|uninstall|supervise|mode|token|key|proxy>
import fs from 'node:fs';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths, type Level } from '@agentic-router/core';
import { SettingsParseError, defaultClaudeSettings, ensureLocalState, planBackupClean, planProject, planStatusLine, promptStorageSummary, readConfig, type PlannedChange } from './setup.ts';
import { start, status, stop } from './daemonctl.ts';
import { doctor } from './doctor.ts';
import { planApiSettings } from './apimode.ts';
import { allowUpstream, configureApi, keySet, modeApi, modeSubscription, preflightApi, realLogin, realVault, setMode, tokenRotate, type ApiDeps } from './apicmds.ts';
import { dashboardCommand } from './dashboard.ts';
import { dataExport, dataPurge, realDataDeps } from './data.ts';
import { uninstall } from './uninstall.ts';
import { loadGuard, policyCommand } from './policy.ts';
import { deleteKey, keyStatus } from '@agentic-router/proxy';
import { autoReleaseSummary, configuredAutoRelease, routingReset } from './routing.ts';
import { runSupervisor } from './supervise.ts';

export { doctor, ladderBreakers, versionAtLeast } from './doctor.ts';
export * from './setup.ts';

function flags(argv: string[]): Record<string, string | boolean> {
  const f: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { f[a.slice(2)] = next; i++; } else f[a.slice(2)] = true;
  }
  return f;
}

async function confirm(changes: PlannedChange[], yes: boolean): Promise<boolean> {
  if (!changes.length) return false;
  console.log('\nThese files outside ~/.agentic-router will change:');
  for (const c of changes) console.log(`  - ${c.file}: ${c.summary}`);
  if (yes) return true;
  if (!process.stdin.isTTY) { console.log('Not a terminal: re-run with --yes to apply.'); return false; }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question('Apply? [y/N] ')).trim().toLowerCase();
  rl.close();
  return a === 'y' || a === 'yes';
}

async function ask(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(question)).trim().toLowerCase();
  rl.close();
  return a === 'y' || a === 'yes';
}

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

const apiDeps = (f: Record<string, string | boolean>): ApiDeps => ({
  settingsFile: typeof f['claude-settings'] === 'string' ? f['claude-settings'] : defaultClaudeSettings(),
  confirm, login: realLogin, vault: realVault, isTTY: process.stdin.isTTY === true, readStdin, out: line => console.log(line),
});

async function init(f: Record<string, string | boolean>) {
  const mode = f.mode;
  if (mode !== undefined && mode !== 'api') { console.error('--mode takes "api" (subscription mode is the default)'); process.exitCode = 2; return; }
  const api = mode === 'api' ? apiDeps(f) : undefined;
  // API-key mode checks the login and the keychain before anything is written
  if (api) {
    const pre = await preflightApi(f, api);
    if (!pre.ok) { process.exitCode = pre.code; return; }
  }
  const budgets: Partial<Record<Level, number>> = {};
  for (const l of ['L0', 'L1', 'L2', 'L3'] as Level[]) {
    const raw = f[`budget-${l}`];
    if (raw === undefined) continue;
    const v = typeof raw === 'string' ? Number(raw) : NaN;
    if (!Number.isFinite(v) || v <= 0) { console.error(`--budget-${l} must be a positive number of USD (got ${JSON.stringify(raw)})`); process.exitCode = 2; return; }
    budgets[l] = v;
  }
  const pluginDir = typeof f['plugin-dir'] === 'string' ? path.resolve(f['plugin-dir']) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../plugin');
  const local = await ensureLocalState(budgets, pluginDir, { newPort: f['new-port'] === true });
  const token = local.token;
  const config = api ? await configureApi(local.config, api) : local.config;
  console.log(`local state ready: daemon port ${config.daemonPort}, token ${token}, plugin ${pluginDir}`);
  console.log(`per-request budgets (provisional): ${Object.entries(config.budgetsUsd).map(([k, v]) => `${k} $${v}`).join(', ')}`);
  // decision 138: the holdout changes how some requests are handled, so init says so
  const ar = configuredAutoRelease(config);
  console.log(`auto-release: ${autoReleaseSummary(ar.mode, ar.rate)}`);
  console.log(`prompt text: ${promptStorageSummary(config.recordPrompts)}`);   // decision 142
  const changes: PlannedChange[] = [];
  // A settings file we cannot parse skips only that step (review #12); nothing is overwritten.
  const step = (name: string, plan: () => PlannedChange[]) => {
    try { changes.push(...plan()); }
    catch (e) {
      if (!(e instanceof SettingsParseError)) throw e;
      console.log(`skipped ${name}: ${e.message}. Fix the file and re-run init, or set it up by hand (README).`);
    }
  };
  step('status line', () => {
    const sl = planStatusLine(typeof f['claude-settings'] === 'string' ? f['claude-settings'] : defaultClaudeSettings(), path.join(pluginDir, 'statusline.mjs'), config);
    return sl ? [sl] : [];
  });
  step('project settings', () => planProject(typeof f.project === 'string' ? f.project : process.cwd()));
  // decision 142: a backup made before it may hold an API key or token in plain text
  step('settings backup', () => { const c = planBackupClean(typeof f['claude-settings'] === 'string' ? f['claude-settings'] : defaultClaudeSettings()); return c ? [c] : []; });
  if (api) step('API-key mode settings', () => { const c = planApiSettings(api.settingsFile, 'proxy', config.proxyPort!); return c ? [c] : []; });
  if (await confirm(changes, f.yes === true)) for (const c of changes) c.apply();
  console.log(`\nLoad the plugin in Claude Code: claude --plugin-dir "${pluginDir}"  (marketplace install comes with the first release)`);
  if (api) console.log('API-key mode: run `agentic-router start` (daemon and proxy), then start new Claude Code sessions. `agentic-router doctor` checks the setup.');
}

async function apiCommand(cmd: string, args: string[], f: Record<string, string | boolean>): Promise<number> {
  const d = apiDeps(f);
  if (cmd === 'mode') {
    if (args[0] === 'subscription') return modeSubscription(f, d);
    if (args[0] === 'api') return modeApi(f, d);
    if (args[0] !== 'direct' && args[0] !== 'proxy') { console.log('usage: agentic-router mode <subscription|api|direct|proxy> [--yes]'); return 2; }
    return setMode(args[0], f, d);
  }
  if (cmd === 'token' && args[0] === 'rotate') return tokenRotate(d);
  if (cmd === 'key' && args[0] === 'set') return keySet(f, d);
  if (cmd === 'proxy' && args[0] === 'allow-upstream') return allowUpstream(args[1], f, d, paths.config());
  console.log('usage: agentic-router token rotate | key set [--key-stdin] | proxy allow-upstream <https origin> [--use] [--yes]');
  return 2;
}

async function routingResetCommand(): Promise<number> {
  const cfg = readConfig();
  let token = '';
  try { token = fs.readFileSync(paths.token(), 'utf8').trim(); } catch { /* below */ }
  if (!cfg || !token) { console.log('Not set up yet: run `agentic-router init` first.'); return 2; }
  return routingReset({ port: cfg.daemonPort, token });
}

const [cmd, ...rest] = process.argv.slice(2);
const f = flags(rest);
const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1]!.startsWith('--') && f[rest[i - 1]!.slice(2)] === a));
// realpath on both sides: an npm bin is a symlink (POSIX) whose path differs from the module's (review #7).
const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const isMain = !!process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url));
if (isMain) {
  if (cmd === 'init') await init(f);
  else if (cmd === 'start') console.log(await start());
  else if (cmd === 'stop') console.log(await stop());
  else if (cmd === 'status') console.log(await status());
  else if (cmd === 'doctor') {
    const checks = await doctor();
    for (const c of checks) console.log(`${c.ok ? 'ok  ' : c.blocking ? 'FAIL' : 'warn'} ${c.name.padEnd(36)} ${c.detail}`);
    if (checks.some(c => !c.ok && c.blocking)) process.exitCode = 1;
  } else if (cmd === 'supervise') await runSupervisor();
  else if (cmd === 'dashboard') process.exitCode = await dashboardCommand(f);
  else if (cmd === 'routing' && positional[0] === 'reset') process.exitCode = await routingResetCommand();
  else if (cmd === 'policy') {
    process.exitCode = await policyCommand(positional[0], f, {
      guard: await loadGuard(), dir: typeof f.project === 'string' ? path.resolve(f.project) : process.cwd(), ask, isTTY: process.stdin.isTTY === true, out: line => console.log(line),
    });
  } else if (cmd === 'uninstall') {
    process.exitCode = await uninstall(f, {
      settingsFile: typeof f['claude-settings'] === 'string' ? f['claude-settings'] : defaultClaudeSettings(),
      projectDir: typeof f.project === 'string' ? f.project : process.cwd(),
      stop, keyStatus: () => keyStatus(), deleteKey: () => deleteKey(), ask, isTTY: process.stdin.isTTY === true, out: line => console.log(line),
    });
  }
  else if (cmd === 'data' && (positional[0] === 'export' || positional[0] === 'purge')) {
    const d = realDataDeps({ confirm: ask, isTTY: process.stdin.isTTY === true });
    process.exitCode = positional[0] === 'export' ? await dataExport(f, d) : await dataPurge(f, d);
  }
  else if (cmd === 'mode' || cmd === 'token' || cmd === 'key' || cmd === 'proxy') process.exitCode = await apiCommand(cmd, positional, f);
  else console.log('usage: agentic-router <init [--mode api]|start|stop|status|doctor|dashboard [--no-open]|routing reset|data export|data purge|uninstall [--keep-key]|policy show|accept|revoke|mode subscription|api|direct|proxy|token rotate|key set|proxy allow-upstream <origin>>');
}
