// What the daemon leaves outside its ledger to be found by its clients (decision 156): <home>/endpoint.json and, on
// macOS and Linux, its Unix socket, in the home or (when that path is too long) in a fallback directory of the
// user's own under $XDG_RUNTIME_DIR or the temp directory. uninstall and an offline `data purge --all` remove them
// once the daemon has stopped. A fallback directory is touched only when it is ours: a real directory (not a link),
// owned by this user, closed to everyone else (core privateDir); only the socket in it is removed, then the
// directory if that left it empty.
import fs from 'node:fs';
import path from 'node:path';
import { ENDPOINT_FILE, SOCKET_NAME, privateDir, readEndpoint, socketCandidates, type SocketEnv } from '@do-it-all-claude-code/core';

/** Paths that would be removed (dryRun) or were removed. */
export function removeEndpointFiles(home: string, o: SocketEnv & { dryRun?: boolean } = {}): string[] {
  const out: string[] = [];
  const drop = (p: string, isDir = false) => {
    if (!o.dryRun) {
      try { if (isDir) fs.rmdirSync(p); else fs.rmSync(p, { force: true }); } catch { return; }
    }
    out.push(p);
  };
  const regularOrSocket = (p: string) => { try { const st = fs.lstatSync(p); return st.isFile() || st.isSocket(); } catch { return false; } };
  const uid = o.uid ?? process.getuid?.() ?? -1;
  const done = new Set<string>();
  /** A socket and, outside the home, its directory when that is ours and nothing else is left in it. */
  const dropSocket = (sock: string) => {
    if (done.has(path.resolve(sock))) return;
    done.add(path.resolve(sock));
    const dir = path.dirname(sock);
    const inHome = path.resolve(dir) === path.resolve(home);
    if (!inHome && !privateDir(dir, uid)) return;   // not ours (or not there): left alone
    if (regularOrSocket(sock)) drop(sock);
    if (inHome) return;
    let empty = false;
    try { empty = fs.readdirSync(dir).every(f => o.dryRun && path.join(dir, f) === sock); } catch { empty = false; }
    if (empty) drop(dir, true);
  };
  // review L6: the socket the daemon named first (it may differ from what this environment would derive), then the
  // candidates for this home
  // review R5: endpoint.json could name any file, so the named path is used only when it is called daemon.sock and is
  // a socket (not a regular file), in the home or in a directory of the user's own
  const named = readEndpoint(home)?.socket;
  const isSocket = (p: string) => { try { return fs.lstatSync(p).isSocket(); } catch { return false; } };
  if (named && path.isAbsolute(named) && path.basename(named) === SOCKET_NAME && isSocket(named)) dropSocket(named);
  const endpoint = path.join(home, ENDPOINT_FILE);
  if (regularOrSocket(endpoint)) drop(endpoint);
  for (const c of socketCandidates(home, o)) dropSocket(c.path);
  // a socket in the home with the default name, even when the candidates moved elsewhere (a shorter home now)
  const inHome = path.join(home, SOCKET_NAME);
  if (!out.includes(inHome) && regularOrSocket(inHome)) drop(inHome);
  return out;
}
