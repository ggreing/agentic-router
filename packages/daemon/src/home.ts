// State-folder layout of one router home. File names are derived from core `paths`, so the
// layout keeps a single source of truth even when the daemon runs on a home other than
// $DO_IT_ALL_CLAUDE_CODE_HOME (tests, `startDaemon({ home })`).
import fs from 'node:fs';
import path from 'node:path';
import { paths, routerHome } from '@do-it-all-claude-code/core';

export interface HomeLayout {
  root: string;
  config: string;
  token: string;
  db: string;
  spoolDir: string;
  scopesDir: string;
  agentsDir: string;
  logsDir: string;
  scopeFile(sessionId: string, subtaskId: string): string;
  agentFile(agentId: string): string;
}

export function homeLayout(home: string = routerHome()): HomeLayout {
  const base = routerHome();
  const root = path.resolve(home);
  const rebase = (p: string) => path.join(root, path.relative(base, p));
  return {
    root,
    config: rebase(paths.config()),
    token: rebase(paths.token()),
    db: rebase(paths.db()),
    spoolDir: rebase(paths.spoolDir()),
    scopesDir: rebase(paths.scopesDir()),
    agentsDir: rebase(paths.agentsDir()),
    logsDir: rebase(paths.logsDir()),
    scopeFile: (sessionId, subtaskId) => rebase(paths.scopeFile(sessionId, subtaskId)),
    agentFile: agentId => rebase(paths.agentFile(agentId)),
  };
}

export function ensureHomeDirs(h: HomeLayout, platform: string = process.platform): void {
  for (const d of [h.root, h.spoolDir, h.scopesDir, h.agentsDir, h.logsDir]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  if (platform !== 'win32') tightenPermissions(h);
}

/**
 * Compatibility #13: on POSIX the router home is private to the user: folders 0700, files 0600 (the
 * ledger and its WAL files, the token, config, spooled events, logs). Folders made by an older version or
 * under a loose umask are corrected at start. Best effort: a path owned by someone else is left as it is.
 */
export function tightenPermissions(h: HomeLayout): void {
  const chmod = (p: string, mode: number) => {
    try {
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink() || (st.mode & 0o777) === mode) return;
      fs.chmodSync(p, mode);
    } catch { /* missing or not ours */ }
  };
  for (const d of [h.root, h.spoolDir, h.scopesDir, h.agentsDir, h.logsDir]) chmod(d, 0o700);
  for (const f of [h.db, `${h.db}-wal`, `${h.db}-shm`, h.token, h.config]) chmod(f, 0o600);
  for (const d of [h.spoolDir, h.logsDir, h.scopesDir, h.agentsDir]) {
    let names: string[] = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) chmod(path.join(d, n), 0o600);
  }
}

/** Rename errors that are usually a short-lived lock on Windows (antivirus, indexer, a reader). */
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
export const RENAME_RETRY_MS = [20, 40, 80, 160, 300, 400];   // about 1 s in all

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Writes a small JSON file atomically (tmp + rename) so hook scripts never read a half-written file.
 * Compatibility #9: a rename blocked by a short-lived lock is retried for about a second; on failure the
 * tmp file is removed and the error is thrown.
 */
export function writeJsonAtomic(file: string, value: unknown, rename: (from: string, to: string) => void = fs.renameSync): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    for (let i = 0; ; i++) {
      try {
        rename(tmp, file);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (i >= RENAME_RETRY_MS.length || !code || !RETRY_CODES.has(code)) throw e;
        pause(RENAME_RETRY_MS[i]!);
      }
    }
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* not written or already moved */ }
    throw e;
  }
}
