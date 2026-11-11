// start / stop / status for the local daemon. The CLI owns the PID file; the daemon does not.
// Safety (review #2, #13, #14, decision 78): a PID is only force-killed when its command line is
// this daemon's entry, stop waits until the process is gone, and start re-checks the port and
// cleans up the PID file when the daemon does not come up.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths, routerHome } from '@agentic-router/core';
import { isFree, readConfig } from './setup.ts';

const pidFile = () => path.join(routerHome(), 'daemon.pid');
const startLock = () => path.join(routerHome(), 'daemon.start.lock');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Talks to the daemon with node:http, never fetch: with NODE_USE_ENV_PROXY / --use-env-proxy and an
 * HTTP_PROXY that does not exempt 127.0.0.1, fetch would send these calls to the proxy (env audit #12).
 */
export function localRequest(port: number, method: 'GET' | 'POST', urlPath: string, opts: { token?: string; body?: string; timeoutMs?: number } = {}): Promise<{ status: number; body: string } | null> {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, agent: false, timeout: opts.timeoutMs ?? 1500,
      headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.body !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(opts.body) } : {}) } },
    res => { let b = ''; res.setEncoding('utf8'); res.on('data', d => { b += d; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b })); });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

export async function health(port: number, timeoutMs = 800): Promise<{ ok: boolean; version?: string } | null> {
  const r = await localRequest(port, 'GET', '/router/v1/health', { timeoutMs });
  if (!r || r.status !== 200) return null;
  try { return JSON.parse(r.body) as { ok: boolean; version?: string }; } catch { return null; }
}

/** The daemon's runnable entry, next to the package's resolved index (src in dev, dist when built). */
export function daemonEntry(): string {
  const index = fileURLToPath(import.meta.resolve('@agentic-router/daemon'));
  const main = path.join(path.dirname(index), index.endsWith('.ts') ? 'main.ts' : 'main.js');
  if (!fs.existsSync(main)) throw new Error(`daemon entry not found: ${main}`);
  return main;
}

export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** The process's command line, or null when it cannot be read (process gone or no access). */
export function commandLineOf(pid: number): string | null {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${Math.trunc(pid)}").CommandLine`],
        { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim();
      return out || null;
    }
    if (fs.existsSync(`/proc/${pid}/cmdline`)) return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim() || null;
    return execFileSync('ps', ['-o', 'command=', '-p', String(Math.trunc(pid))], { encoding: 'utf8', timeout: 5000 }).trim() || null;
  } catch { return null; }
}

/** True only when the PID runs this daemon's entry script (a reused PID belongs to someone else). */
export function isOurDaemon(pid: number, entry = daemonEntry()): boolean {
  const cmd = commandLineOf(pid);
  if (!cmd) return false;
  const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase();
  return norm(cmd).includes(norm(entry));
}

async function waitGone(pid: number | undefined, ms: number): Promise<boolean> {
  if (pid === undefined) return true;
  for (let t = 0; t < ms; t += 100) { if (!isAlive(pid)) return true; await sleep(100); }
  return !isAlive(pid);
}

function readPid(): number | undefined {
  if (!fs.existsSync(pidFile())) return undefined;
  const n = Number(fs.readFileSync(pidFile(), 'utf8').trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export async function start(): Promise<string> {
  const cfg = readConfig();
  if (!cfg) return 'not initialised: run `agentic-router init` first';
  if (await health(cfg.daemonPort)) return `already running on 127.0.0.1:${cfg.daemonPort}`;
  // One start at a time: a second concurrent `start` would race for the port and the PID file.
  try { fs.writeFileSync(startLock(), String(process.pid), { flag: 'wx' }); }
  catch {
    const age = Date.now() - fs.statSync(startLock()).mtimeMs;
    if (age < 15000) return 'another `agentic-router start` is in progress';
    fs.writeFileSync(startLock(), String(process.pid));     // stale lock from a crashed start
  }
  try {
    if (!await isFree(cfg.daemonPort))
      return `port ${cfg.daemonPort} is in use by another program. Pick a new port with \`agentic-router init --new-port\`, then start again.`;
    const child = spawn(process.execPath, [daemonEntry()], {
      detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, AGENTIC_ROUTER_HOME: routerHome() },
    });
    let exited: number | null | undefined;
    child.once('exit', code => { exited = code; });
    child.unref();
    fs.writeFileSync(pidFile(), String(child.pid));
    for (let i = 0; i < 50; i++) {
      const h = await health(cfg.daemonPort, 300);
      if (h?.ok) return `started on 127.0.0.1:${cfg.daemonPort} (pid ${child.pid})`;
      if (exited !== undefined) break;
      await sleep(100);
    }
    if (exited !== undefined || (child.pid !== undefined && !isAlive(child.pid))) {
      fs.rmSync(pidFile(), { force: true });
      return `daemon exited during start${exited != null ? ` (code ${exited})` : ''}; see ${path.join(paths.logsDir(), 'daemon.log')}`;
    }
    return `started (pid ${child.pid}) but no health response yet; see ${paths.logsDir()}`;
  } finally {
    fs.rmSync(startLock(), { force: true });
  }
}

/** Graceful first (authenticated POST /router/v1/shutdown, decision 66); force-kill only as a fallback. */
export async function stop(): Promise<string> {
  const cfg = readConfig();
  const pid = readPid();
  if (cfg && fs.existsSync(paths.token())) {
    try {
      const token = fs.readFileSync(paths.token(), 'utf8').trim();
      const r = await localRequest(cfg.daemonPort, 'POST', '/router/v1/shutdown', { token, body: '{}', timeoutMs: 3000 });
      if (r && r.status >= 200 && r.status < 300) {
        // The daemon stops verify runs and flushes the ledger (up to ~2 s); wait for the process to exit.
        for (let i = 0; i < 30 && await health(cfg.daemonPort, 200); i++) await sleep(100);
        const gone = await waitGone(pid, 10000);
        if (gone) { fs.rmSync(pidFile(), { force: true }); return 'stopped (graceful)'; }
        return `shutdown requested, but pid ${pid} is still running after 10 s; run stop again to force it`;
      }
    } catch { /* daemon not reachable: fall through */ }
  }
  if (pid === undefined) return 'not running';
  if (!isAlive(pid)) { fs.rmSync(pidFile(), { force: true }); return 'not running (removed a stale pid file)'; }
  if (!isOurDaemon(pid)) {
    fs.rmSync(pidFile(), { force: true });
    return `not running (pid ${pid} from the pid file belongs to another program; it was left alone and the pid file removed)`;
  }
  try { process.kill(pid); } catch { /* already gone */ }
  await waitGone(pid, 5000);
  fs.rmSync(pidFile(), { force: true });
  return `stopped (forced, pid ${pid})`;
}

export async function status(): Promise<string> {
  const cfg = readConfig();
  if (!cfg) return 'not initialised';
  const h = await health(cfg.daemonPort);
  if (!h) return `Router OFF (daemon not responding on 127.0.0.1:${cfg.daemonPort}); Claude Code keeps working without routing`;
  let detail = '';
  try {
    const token = fs.readFileSync(paths.token(), 'utf8').trim();
    const r = await localRequest(cfg.daemonPort, 'GET', '/router/v1/status', { token, timeoutMs: 1500 });
    if (r && r.status === 200) detail = '\n' + JSON.stringify(JSON.parse(r.body), null, 2);
  } catch { /* status endpoint optional */ }
  return `Router ON (127.0.0.1:${cfg.daemonPort}, version ${h.version ?? '?'})${detail}`;
}
