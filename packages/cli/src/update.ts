// `do-it-all-claude-code update on|off|check` and the update lines of init, status and doctor (decision 163). The
// check is opt-in: config.updateCheck "on" lets the daemon read the public release list on GitHub once a day;
// `update check` reads it once, now, whatever the setting. Nothing about the user is sent (an anonymous GET).
// There is no automatic update: a newer release is only named, with its release page.
import fs from 'node:fs';
import {
  checkForUpdate, fetchLatestRelease, readUpdateState, routerHome, updateMessage, updateNotice,
  type FetchOptions, type FetchResult, type UpdateState,
} from '@do-it-all-claude-code/core';
import type { Check } from './doctor.ts';
import { readConfig, writeConfig, type CliConfig } from './setup.ts';

export const UPDATE_QUESTION = 'Check GitHub once a day for a newer release? (only reads the public release list; nothing about you is sent)';

/** This install's version (the CLI's package.json; every package of a release has the same one). */
export const CLI_VERSION: string = (() => {
  try {
    const v = (JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' ? v : '0.0.0';
  } catch { return '0.0.0'; }
})();

export interface UpdateDeps {
  out(line: string): void;
  home?: string;
  current?: string;
  now?: () => Date;
  /** Tests: the request (default: GitHub). */
  fetchOptions?: FetchOptions;
}

const newest = (s: UpdateState) => (s.latest ? s.latest.slice(1) : undefined);

export async function updateCommand(sub: string | undefined, d: UpdateDeps): Promise<number> {
  const current = d.current ?? CLI_VERSION;
  if (sub === 'on' || sub === 'off') {
    const cfg = readConfig();
    if (!cfg) { d.out('Not set up yet: run do-it-all-claude-code init first.'); return 2; }
    cfg.updateCheck = sub;
    writeConfig(cfg);
    d.out(sub === 'on'
      ? 'Update check on: the daemon reads the public release list on GitHub once a day (nothing about you is sent); a newer release shows in the status line and once a day at session start. `do-it-all-claude-code update check` checks now.'
      : 'Update check off. `do-it-all-claude-code update check` still checks once when you ask.');
    return 0;
  }
  if (sub === 'check') {
    const home = d.home ?? routerHome();
    const o = { ...d.fetchOptions, now: d.now?.() ?? new Date() };
    // before init there is no home, and this does not make one (init would take it for a home of its own)
    let state: UpdateState;
    let result: FetchResult;
    if (fs.existsSync(home)) ({ state, result } = await checkForUpdate(home, o));
    else {
      result = await fetchLatestRelease(o);
      state = { version: 1, ...(result.ok && !result.notModified && result.latest ? { latest: result.latest } : {}) };
    }
    if (!result.ok) { d.out(`Could not check: ${result.reason}.${newest(state) ? ` The last release seen is ${newest(state)}.` : ''}`); return 1; }
    const n = updateNotice(state.latest, current);
    d.out(n ? updateMessage(n) : newest(state) ? `You have ${current}; the newest release is ${newest(state)}.` : 'No release was found.');
    return 0;
  }
  d.out('usage: do-it-all-claude-code update on|off|check');
  return 2;
}

/** status: one line about updates. */
export function updateStatusLine(cfg: CliConfig | null, home: string = routerHome(), current: string = CLI_VERSION): string {
  const s = readUpdateState(home);
  const n = updateNotice(s.latest, current);
  if (n) return updateMessage(n) + (cfg?.updateCheck === 'on' ? '' : ' (from your last `update check`; the daily check is off)');
  if (cfg?.updateCheck !== 'on') return `update check: ${cfg?.updateCheck === 'off' ? 'off' : 'not set'} (do-it-all-claude-code update on|off)`;
  return `update check: on; ${newest(s) ? `the newest release is ${newest(s)}` : 'no release seen yet'}${s.checkedAt ? ` (checked ${s.checkedAt.slice(0, 10)})` : ''}${s.lastError ? `; the last attempt failed (${s.lastError})` : ''}`;
}

/** doctor: the update check's line. Not set yet: a suggestion (until the user chooses on or off). */
export function updateCheckLine(cfg: CliConfig, home: string = routerHome(), current: string = CLI_VERSION): Check {
  const name = 'update check';
  const s = readUpdateState(home);
  const n = updateNotice(s.latest, current);
  if (n) return { name, ok: false, blocking: false, detail: updateMessage(n) };
  if (cfg.updateCheck === undefined) {
    return { name, ok: false, blocking: false,
      detail: 'not set: `do-it-all-claude-code update on` checks GitHub once a day for a newer release (it only reads the public release list; nothing about you is sent); `update off` keeps it off and ends this note' };
  }
  if (cfg.updateCheck === 'off') return { name, ok: true, blocking: false, detail: 'off' };
  if (s.lastError) return { name, ok: false, blocking: false, detail: `on, but the last attempt failed (${s.lastError}${s.attemptedAt ? `, ${s.attemptedAt.slice(0, 10)}` : ''}); it is tried again the next day` };
  return { name, ok: true, blocking: false, detail: `on: ${newest(s) ? `no release newer than ${current}` : 'no check yet (the daemon checks once a day)'}${s.checkedAt ? `, checked ${s.checkedAt.slice(0, 10)}` : ''}` };
}
