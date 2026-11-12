// start / stop / status. `start` runs `agentic-router supervise` (supervise.ts), which runs the daemon and,
// in API-key mode, the proxy, restarting them when they exit. A daemon started without a supervisor (an older
// install) is still stopped by the PID-file path below. The CLI owns the PID files; the daemon does not.
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
import { proxyHealth, readSuperviseStatus, superviseFiles } from './supervise.ts';

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

function readPid(file = pidFile()): number | undefined {
  if (!fs.existsSync(file)) return undefined;
  const n = Number(fs.readFileSync(file, 'utf8').trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Whether the daemon.pid process is alive and ours, answering or not. */
export function daemonProcessAlive(): boolean {
  const pid = readPid();
  return pid !== undefined && isAlive(pid) && isOurDaemon(pid);
}

/** This CLI's entry (src in dev, dist when built): what `start` runs as `<entry> supervise`. */
export function cliEntry(): string {
  const self = fileURLToPath(import.meta.url);
  return path.join(path.dirname(self), self.endsWith('.ts') ? 'index.ts' : 'index.js');
}

/** The running supervisor's pid, only when that pid really runs `<cli entry> supervise`. */
export function runningSupervisor(): number | undefined {
  const pid = readPid(superviseFiles().pid);
  if (pid === undefined || !isAlive(pid)) return undefined;
  const cmd = commandLineOf(pid);
  const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase();
  return cmd && norm(cmd).includes(norm(cliEntry())) && /\bsupervise\b/.test(cmd) ? pid : undefined;
}

const proxyToken = () => { try { return fs.readFileSync(path.join(routerHome(), 'proxy-token'), 'utf8').trim(); } catch { return ''; } };

export async function start(): Promise<string> {
  const cfg = readConfig();
  if (!cfg) return 'not initialised: run `agentic-router init` first';
  const sup = runningSupervisor();
  if (sup) return `already running (supervisor pid ${sup}, daemon on 127.0.0.1:${cfg.daemonPort}${cfg.apiMode === 'proxy' ? `, proxy on 127.0.0.1:${cfg.proxyPort}` : ''})`;
  if (await health(cfg.daemonPort)) return `already running on 127.0.0.1:${cfg.daemonPort} without a supervisor: run stop, then start, to have it restarted when it exits`;
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
    const proxy = cfg.apiMode === 'proxy' && cfg.proxyPort ? cfg.proxyPort : undefined;
    if (proxy && !await isFree(proxy)) return `proxy port ${proxy} is in use by another program`;
    const child = spawn(process.execPath, [cliEntry(), 'supervise'], {
      detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, AGENTIC_ROUTER_HOME: routerHome() },
    });
    let exited: number | null | undefined;
    child.once('exit', code => { exited = code; });
    child.unref();
    let daemonUp = false;
    let proxyUp = !proxy;
    for (let i = 0; i < 80 && !(daemonUp && proxyUp); i++) {
      daemonUp ||= !!(await health(cfg.daemonPort, 300))?.ok;
      if (proxy && !proxyUp) proxyUp = !!(await proxyHealth(proxy, proxyToken(), 300))?.ok;
      if (exited !== undefined) break;
      if (!(daemonUp && proxyUp)) await sleep(100);
    }
    const where = `daemon on 127.0.0.1:${cfg.daemonPort}${proxy ? `, proxy on 127.0.0.1:${proxy}` : ''}`;
    if (exited !== undefined && !(daemonUp && proxyUp)) return `the supervisor exited during start${exited != null ? ` (code ${exited})` : ''}; see ${paths.logsDir()}`;
    if (daemonUp && proxyUp) return `started (supervisor pid ${child.pid}; ${where})`;
    const down = [daemonUp ? '' : 'daemon', proxyUp ? '' : 'proxy'].filter(Boolean).join(' and ');
    return `started (supervisor pid ${child.pid}) but the ${down} did not answer yet; it is restarted when it exits. See ${paths.logsDir()}`
      + (proxy && !proxyUp ? ' and run agentic-router doctor (is the API key in the keychain?)' : '');
  } finally {
    fs.rmSync(startLock(), { force: true });
  }
}

/**
 * Asks the supervisor to stop (it stops the proxy, then the daemon, gracefully). Without a supervisor:
 * graceful first (authenticated POST /router/v1/shutdown, decision 66), force-kill only as a fallback.
 */
export async function stop(): Promise<string> {
  const sup = runningSupervisor();
  if (sup) {
    const files = superviseFiles();
    fs.writeFileSync(files.stop, String(process.pid));
    if (await waitGone(sup, 50_000)) return 'stopped (supervisor, proxy and daemon)';
    // it did not finish: force it, and the children it recorded when they run our entries
    const children = readSuperviseStatus()?.children ?? {};
    try { process.kill(sup); } catch { /* gone */ }
    for (const c of Object.values(children)) {
      if (!c.pid || !isAlive(c.pid)) continue;
      if (/[\\/](daemon|proxy)[\\/](src|dist)[\\/]main\.(ts|js)/i.test(commandLineOf(c.pid) ?? '')) { try { process.kill(c.pid); } catch { /* gone */ } }
    }
    fs.rmSync(files.stop, { force: true });
    fs.rmSync(files.pid, { force: true });
    return `stopped (forced after 50 s; supervisor pid ${sup})`;
  }
  return stopDaemonOnly();
}

async function stopDaemonOnly(): Promise<string> {
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
  const lines = [`Router ON (127.0.0.1:${cfg.daemonPort}, version ${h.version ?? '?'})`];
  const sup = readSuperviseStatus();
  if (runningSupervisor() && sup) {
    lines.push(`supervisor pid ${sup.pid}: ${Object.entries(sup.children).map(([n, c]) => `${n} ${c.state}${c.restarts ? ` (${c.restarts} restarts)` : ''}`).join(', ')}`);
  }
  if (cfg.apiMode) {
    const p = cfg.apiMode === 'proxy' && cfg.proxyPort ? await proxyHealth(cfg.proxyPort, proxyToken()) : null;
    lines.push(cfg.apiMode === 'direct' ? 'API-key mode: direct (no proxy; Claude Code reads the key from the keychain)'
      : p ? `API-key mode: proxy ON (127.0.0.1:${cfg.proxyPort} -> ${p.upstream ?? '?'}, ${p.inflight ?? 0} in flight)`
      : `API-key mode: proxy OFF (127.0.0.1:${cfg.proxyPort} not answering): API calls fail until it is back, or run agentic-router mode direct`);
  }
  return `${lines.join('\n')}${detail}`;
}
