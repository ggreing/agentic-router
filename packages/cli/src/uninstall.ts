// `agentic-router uninstall [--keep-key] [--project <dir>] [--claude-settings <file>] [--yes]` (audit B4): undoes what
// init and the mode commands put outside the router home, after one confirmation. It stops the daemon, takes
// the router's entries out of Claude Code's settings (status line, with a wrapped original put back; the
// router's apiKeyHelper, base URL and hint variable), removes worktree.baseRef = "head" and the
// ".claude/worktrees/" line from the project, deletes the settings backup and (unless --keep-key) the API key
// in the OS keychain. Values the user set are left alone. The router home (~/.agentic-router) stays; the
// command says how to remove it.
import fs from 'node:fs';
import path from 'node:path';
import { redact, routerHome } from '@agentic-router/core';
import { HINT_HEADERS_ENV, isOurBaseUrl, isRouterHelper, recordApiState, recordNoProxy, removeLoopbackNoProxy, undoEnvAdded } from './apimode.ts';
import { removeEndpointFiles } from './endpointfiles.ts';
import { tlsPaths } from './localtls.ts';
import { SettingsParseError, backupFile, isRouterStatusLine, readConfig, readJsonFile, writeJsonAtomic, type CliConfig, type PlannedChange } from './setup.ts';

export interface UninstallDeps {
  settingsFile: string;
  projectDir: string;
  /** Stops the supervisor, proxy and daemon; its message. */
  stop(): Promise<string>;
  keyStatus(): Promise<string>;
  deleteKey(): Promise<void>;
  ask(question: string): Promise<boolean>;
  isTTY: boolean;
  out(line: string): void;
  /** The environment uninstall runs in (default process.env): its NODE_EXTRA_CA_CERTS decides what of the TLS folder stays. */
  env?: NodeJS.ProcessEnv;
}

/** A directory itself, not a link to one. */
const realDir = (p: string): boolean => { try { return fs.lstatSync(p).isDirectory(); } catch { return false; } };

/**
 * What the user had before the router replaced it (decision 149, audit B6): the status line it wrapped (from
 * config.json, else the settings backup when the router home is gone) and an apiKeyHelper of their own that API
 * mode replaced (the backup is its only copy). Values that are the router's own are not "the user's".
 */
export function userOriginals(config: CliConfig | null, backup: Record<string, any> | null): { statusLine?: Record<string, unknown>; apiKeyHelper?: string } {
  const statusLine = config?.wrappedStatusLine
    ?? (backup?.statusLine?.type === 'command' && !isRouterStatusLine(backup.statusLine.command) ? backup.statusLine : undefined);
  const helper = typeof backup?.apiKeyHelper === 'string' && !isRouterHelper(backup.apiKeyHelper) ? backup.apiKeyHelper : undefined;
  return { ...(statusLine ? { statusLine } : {}), ...(helper ? { apiKeyHelper: helper } : {}) };
}

/** Claude Code's user settings without the router's entries, the user's own put back; null when none are there. */
export function planUserSettings(settingsFile: string, config: CliConfig | null, backup: Record<string, any> | null = null): PlannedChange | null {
  if (!fs.existsSync(settingsFile)) return null;
  const s = readJsonFile<Record<string, any>>(settingsFile, {});
  const notes: string[] = [];
  const next: Record<string, any> = { ...s };
  const own = userOriginals(config, backup);
  if (isRouterStatusLine(s.statusLine?.command)) {
    if (own.statusLine) { next.statusLine = own.statusLine; notes.push(`statusLine: put back your "${String(own.statusLine.command)}"`); } else { delete next.statusLine; notes.push('statusLine: remove the router\'s'); }
  }
  if (isRouterHelper(s.apiKeyHelper)) {
    if (own.apiKeyHelper) { next.apiKeyHelper = own.apiKeyHelper; notes.push(`apiKeyHelper: put back your "${redact(own.apiKeyHelper)}" (from the backup)`); } else { delete next.apiKeyHelper; notes.push('apiKeyHelper: remove the router\'s'); }
  }
  const env: Record<string, unknown> = s.env && typeof s.env === 'object' ? { ...s.env } : {};
  if (isOurBaseUrl(env.ANTHROPIC_BASE_URL)) { delete env.ANTHROPIC_BASE_URL; notes.push('env.ANTHROPIC_BASE_URL: remove'); }
  if (HINT_HEADERS_ENV in env) { delete env[HINT_HEADERS_ENV]; notes.push(`env.${HINT_HEADERS_ENV}: remove`); }
  const noProxy = config?.noProxyAdded;
  if (noProxy?.length) notes.push(...removeLoopbackNoProxy(env, noProxy));
  // decisions 156-157: the helper cache and NODE_EXTRA_CA_CERTS API-key mode set (a value of the user's own is put back)
  const envAdded = [...(config?.apiEnvAdded ?? [])];
  const hadEnvAdded = envAdded.length > 0;
  if (hadEnvAdded) notes.push(...undoEnvAdded(env, envAdded));
  if (!notes.length) return null;
  if (Object.keys(env).length) next.env = env; else delete next.env;
  return { file: settingsFile, summary: notes.join('; '), apply() {
    writeJsonAtomic(settingsFile, next);
    if (noProxy?.length) recordNoProxy(null);
    if (hadEnvAdded) recordApiState({ envAdded: [] });
  } };
}

/** The project: worktree.baseRef while it is still the "head" init set, and the .gitignore line init added. */
export function planProjectUndo(projectDir: string): PlannedChange[] {
  const out: PlannedChange[] = [];
  const local = path.join(projectDir, '.claude', 'settings.local.json');
  if (fs.existsSync(local)) {
    const s = readJsonFile<Record<string, any>>(local, {});
    if (s.worktree?.baseRef === 'head') {
      out.push({
        file: local, summary: 'remove worktree.baseRef = "head" (set by init)',
        apply() {
          const next = { ...s, worktree: { ...s.worktree } };
          delete next.worktree.baseRef;
          if (!Object.keys(next.worktree).length) delete (next as Record<string, unknown>).worktree;
          writeJsonAtomic(local, next);
        },
      });
    }
  }
  const gi = path.join(projectDir, '.gitignore');
  if (fs.existsSync(gi)) {
    const text = fs.readFileSync(gi, 'utf8');
    if (/^\.claude\/worktrees\/?\r?$/m.test(text)) {
      out.push({ file: gi, summary: 'remove the ".claude/worktrees/" line (added by init)', apply() { fs.writeFileSync(gi, text.replace(/^\.claude\/worktrees\/?\r?\n?/m, '')); } });
    }
  }
  return out;
}

/** Whether the settings still lack something of the user's that only the backup holds (then it is kept). */
function backupStillNeeded(settingsFile: string, own: ReturnType<typeof userOriginals>): boolean {
  let now: Record<string, any>;
  try { now = readJsonFile<Record<string, any>>(settingsFile, {}); } catch { return true; }
  if (own.statusLine && JSON.stringify(now.statusLine) !== JSON.stringify(own.statusLine)) return true;
  if (own.apiKeyHelper && now.apiKeyHelper !== own.apiKeyHelper) return true;
  return false;
}

export async function uninstall(f: Record<string, string | boolean>, d: UninstallDeps): Promise<number> {
  const config = readConfig();
  const bak = backupFile(d.settingsFile);
  let backup: Record<string, any> | null = null;
  let backupUnreadable = false;
  if (fs.existsSync(bak)) {
    try { backup = readJsonFile<Record<string, any>>(bak, {}); } catch { backupUnreadable = true; }
  }
  const changes: PlannedChange[] = [];
  try {
    const settings = planUserSettings(d.settingsFile, config, backup);
    if (settings) changes.push(settings);
    changes.push(...planProjectUndo(d.projectDir));
  } catch (e) {
    // audit C2: an unparseable settings file stops here, with nothing changed
    d.out(`${e instanceof SettingsParseError ? e.message : (e as Error).message}. Nothing was changed; fix the file and run uninstall again.`);
    return 2;
  }
  const own = userOriginals(config, backup);
  if (fs.existsSync(bak)) {
    changes.push(backupUnreadable
      ? { file: bak, summary: 'kept: the settings backup could not be read, so it may hold your settings', apply() { /* kept */ } }
      : { file: bak, summary: 'delete the settings backup made by init (kept if something of yours could not be put back)', apply() {
        if (backupStillNeeded(d.settingsFile, own)) { d.out(`Kept ${bak}: it still holds settings of yours that could not be put back.`); return; }
        fs.rmSync(bak, { force: true });
      } });
  }
  // decision 157: the local TLS key and certificate; a bundle the user's own NODE_EXTRA_CA_CERTS names is kept
  const tls = tlsPaths();
  const shellCa = (d.env ?? process.env).NODE_EXTRA_CA_CERTS?.trim();
  const shellUsesBundle = !!shellCa && path.resolve(shellCa) === path.resolve(tls.bundle);
  if (realDir(tls.dir)) {
    changes.push({ file: tls.dir, summary: shellUsesBundle
      ? `delete the local TLS key and certificate; keep ${path.basename(tls.bundle)}, which your NODE_EXTRA_CA_CERTS names (point it back at your own file)`
      : 'delete the local TLS key, certificate and bundle', apply() {
      if (shellUsesBundle) { for (const p of [tls.key, tls.cert]) fs.rmSync(p, { force: true }); }
      else fs.rmSync(tls.dir, { recursive: true, force: true });
    } });
  }
  // decision 156: the daemon's endpoint file and socket, once it has stopped
  const endpointFiles = removeEndpointFiles(routerHome(), { dryRun: true });
  if (endpointFiles.length) changes.push({ file: routerHome(), summary: `remove the daemon's endpoint file and socket (${endpointFiles.map(p => path.basename(p)).join(', ')})`, apply() { removeEndpointFiles(routerHome()); } });
  const key = f['keep-key'] === true ? 'kept' : await d.keyStatus();
  if (key !== 'present' && key !== 'not_found' && key !== 'kept') d.out(`The OS keychain could not be checked (${key}): an API key may remain in it under "agentic-router".`);
  d.out('agentic-router uninstall will:');
  d.out('  - stop the daemon and the proxy');
  for (const c of changes) d.out(`  - ${c.file}: ${c.summary}`);
  if (key === 'present') d.out('  - delete the API key from the OS keychain (--keep-key keeps it)');
  d.out(`Your router data stays in ${routerHome()}: \`agentic-router data purge --all\` empties it, then delete the folder.`);
  if (f.yes !== true) {
    if (!d.isTTY) { d.out('Not a terminal: re-run with --yes to uninstall.'); return 1; }
    if (!await d.ask('Uninstall? [y/N] ')) { d.out('Nothing changed.'); return 1; }
  }
  d.out(await d.stop());
  for (const c of changes) {
    try { c.apply(); } catch (e) { d.out(`Could not change ${c.file}: ${(e as Error).message}`); }
  }
  if (key === 'present') {
    try { await d.deleteKey(); d.out('API key deleted from the OS keychain.'); }
    catch (e) { d.out(`The API key could not be deleted (${(e as Error).message}); remove it with the keychain tool.`); }
  }
  d.out('Done. Restart running Claude Code sessions; to remove the plugin, stop loading it (--plugin-dir) or uninstall it in Claude Code.');
  return 0;
}
