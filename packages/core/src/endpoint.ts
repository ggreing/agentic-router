// Where the daemon can be reached (decision 156, step 3).
//
// On macOS and Linux the daemon also listens on a Unix socket inside a directory only the user can enter.
// The kernel then decides who may connect: another local user cannot create that socket, cannot connect to
// it, and so cannot stand in for the daemon at all, not even to count requests. Messages stay sealed over
// the socket (seal.ts). Windows keeps the TCP port with sealed messages: a named pipe there lives in one
// global namespace and cannot be given an owner-only access list without native code.
//
// The daemon writes <home>/endpoint.json when it is up: { version, pid, startedAt, port, socket? }.
// A client that finds a socket named there uses it and nothing else: when the socket cannot be reached the
// daemon counts as down (hooks spool), and the TCP port is not tried. The file stays after a stop, so that
// rule also holds while the daemon is down.
//
// plugin/hooks/seal.mjs has a dependency-free copy of the reading half (daemonTarget).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ENDPOINT_FILE = 'endpoint.json';
export const SOCKET_NAME = 'daemon.sock';
export interface DaemonEndpoint { version: 1; pid: number; startedAt: string; port: number; socket?: string }

/** The longest socket path the system takes (sun_path without its terminator). */
export const sunPathMax = (platform: NodeJS.Platform = process.platform): number => (platform === 'darwin' ? 103 : 107);
/**
 * The fallback socket directory's name starts with this, then the uid and a hash of the home. Short on purpose:
 * under the default macOS temp directory (49 bytes) with a ten-digit uid, the prefix has 17 bytes at most, so
 * the full product name does not fit.
 */
export const SOCKET_DIR_PREFIX = 'do-it-all-cc';

export interface SocketEnv { platform?: NodeJS.Platform; env?: Record<string, string | undefined>; uid?: number; tmpdir?: string }
export interface SocketLocation { dir: string; path: string; fallback: boolean }

/**
 * Where the socket goes: in the router home; when that path is too long for the system, in a directory of
 * the user's own under $XDG_RUNTIME_DIR, else under the temp directory. Undefined on Windows and when no
 * candidate fits. The directory is not created or checked here (see privateDir).
 */
export function socketCandidates(home: string, o: SocketEnv = {}): SocketLocation[] {
  const platform = o.platform ?? process.platform;
  if (platform === 'win32') return [];
  const max = sunPathMax(platform);
  const fits = (p: string) => Buffer.byteLength(p, 'utf8') <= max;
  const out: SocketLocation[] = [];
  const primary = path.posix.join(home, SOCKET_NAME);
  if (fits(primary)) out.push({ dir: home, path: primary, fallback: false });
  // a name of its own per user and per home, so two homes do not share a socket
  const uid = o.uid ?? process.getuid?.() ?? 0;
  const name = `${SOCKET_DIR_PREFIX}-${uid}-${createHash('sha256').update(home).digest('hex').slice(0, 12)}`;
  const env = o.env ?? process.env;
  const bases = [env.XDG_RUNTIME_DIR, o.tmpdir ?? os.tmpdir()].filter((b): b is string => typeof b === 'string' && path.posix.isAbsolute(b));
  for (const base of bases) {
    const dir = path.posix.join(base, name);
    const p = path.posix.join(dir, SOCKET_NAME);
    if (fits(p) && !out.some(x => x.path === p)) out.push({ dir, path: p, fallback: true });
  }
  return out;
}

/**
 * Whether `dir` is a directory of this user that nobody else can enter: a real directory (not a link), owned
 * by `uid`, with no access for group or others. With `create`, a missing directory is made that way first.
 * A directory that exists and is not like that is refused, never repaired: it may be someone else's.
 */
export function privateDir(dir: string, uid: number = process.getuid?.() ?? -1, create = false): boolean {
  try {
    if (create) { try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return false; } }
    const st = fs.lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink() && st.uid === uid && (st.mode & 0o077) === 0;
  } catch { return false; }
}

/** The first candidate whose directory is private (the fallback directories are created when missing). */
export function socketLocation(home: string, o: SocketEnv = {}): SocketLocation | undefined {
  const uid = o.uid ?? process.getuid?.() ?? -1;
  return socketCandidates(home, o).find(c => privateDir(c.dir, uid, c.fallback));
}

export function writeEndpoint(home: string, e: DaemonEndpoint): void {
  const file = path.join(home, ENDPOINT_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(e) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readEndpoint(home: string): DaemonEndpoint | undefined {
  try {
    const e = JSON.parse(fs.readFileSync(path.join(home, ENDPOINT_FILE), 'utf8')) as Partial<DaemonEndpoint> | null;
    if (!e || typeof e !== 'object' || e.version !== 1 || !Number.isInteger(e.port)) return undefined;
    if (e.socket !== undefined && !(typeof e.socket === 'string' && e.socket.length > 1 && e.socket.length < 4096)) return undefined;
    return e as DaemonEndpoint;
  } catch { return undefined; }
}

/**
 * How a client reaches the daemon of this home: the socket when the daemon named one (and then only the
 * socket), else the TCP port from the config. `port` is always given: it is what the Host header carries.
 */
export function daemonTarget(home: string, configPort: number | null | undefined): { port: number; socketPath?: string } | undefined {
  const e = readEndpoint(home);
  if (e?.socket) return { port: e.port, socketPath: e.socket };
  const port = typeof configPort === 'number' && configPort > 0 ? configPort : e?.port;
  return typeof port === 'number' && port > 0 ? { port } : undefined;
}
