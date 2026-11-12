// `agentic-router uninstall [--keep-key] [--project <dir>] [--claude-settings <file>] [--yes]` (audit B4): undoes what
// init and the mode commands put outside the router home, after one confirmation. It stops the daemon, takes
// the router's entries out of Claude Code's settings (status line, with a wrapped original put back; the
// router's apiKeyHelper, base URL and hint variable), removes worktree.baseRef = "head" and the
// ".claude/worktrees/" line from the project, deletes the settings backup and (unless --keep-key) the API key
// in the OS keychain. Values the user set are left alone. The router home (~/.agentic-router) stays; the
// command says how to remove it.
import fs from 'node:fs';
import path from 'node:path';
import { routerHome } from '@agentic-router/core';
import { HINT_HEADERS_ENV, isOurBaseUrl, isRouterHelper } from './apimode.ts';
import { backupFile, isRouterStatusLine, readConfig, readJsonFile, writeJsonAtomic, type CliConfig, type PlannedChange } from './setup.ts';

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
}

/** Claude Code's user settings without the router's entries; null when none are there. */
export function planUserSettings(settingsFile: string, config: CliConfig | null): PlannedChange | null {
  if (!fs.existsSync(settingsFile)) return null;
  const s = readJsonFile<Record<string, any>>(settingsFile, {});
  const notes: string[] = [];
  const next: Record<string, any> = { ...s };
  if (isRouterStatusLine(s.statusLine?.command)) {
    const wrapped = config?.wrappedStatusLine;
    if (wrapped) { next.statusLine = wrapped; notes.push(`statusLine: put back "${wrapped.command}"`); } else { delete next.statusLine; notes.push('statusLine: remove the router\'s'); }
  }
  if (isRouterHelper(s.apiKeyHelper)) { delete next.apiKeyHelper; notes.push('apiKeyHelper: remove the router\'s'); }
  const env: Record<string, unknown> = s.env && typeof s.env === 'object' ? { ...s.env } : {};
  if (isOurBaseUrl(env.ANTHROPIC_BASE_URL)) { delete env.ANTHROPIC_BASE_URL; notes.push('env.ANTHROPIC_BASE_URL: remove'); }
  if (HINT_HEADERS_ENV in env) { delete env[HINT_HEADERS_ENV]; notes.push(`env.${HINT_HEADERS_ENV}: remove`); }
  if (!notes.length) return null;
  if (Object.keys(env).length) next.env = env; else delete next.env;
  return { file: settingsFile, summary: notes.join('; '), apply() { writeJsonAtomic(settingsFile, next); } };
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

export async function uninstall(f: Record<string, string | boolean>, d: UninstallDeps): Promise<number> {
  const config = readConfig();
  const changes: PlannedChange[] = [];
  const settings = planUserSettings(d.settingsFile, config);
  if (settings) changes.push(settings);
  changes.push(...planProjectUndo(d.projectDir));
  const bak = backupFile(d.settingsFile);
  if (fs.existsSync(bak)) changes.push({ file: bak, summary: 'delete the settings backup made by init', apply() { fs.rmSync(bak, { force: true }); } });
  const key = f['keep-key'] === true ? 'kept' : await d.keyStatus();
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
  for (const c of changes) c.apply();
  if (key === 'present') {
    try { await d.deleteKey(); d.out('API key deleted from the OS keychain.'); }
    catch (e) { d.out(`The API key could not be deleted (${(e as Error).message}); remove it with the keychain tool.`); }
  }
  d.out('Done. Restart running Claude Code sessions; to remove the plugin, stop loading it (--plugin-dir) or uninstall it in Claude Code.');
  return 0;
}
