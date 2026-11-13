// `agentic-router supervise`: one detached process that runs the daemon and, in API-key mode, the proxy
// (spec 5.4, decision 130). A child that exits is started again after 1 s, 2 s, 5 s, then every 30 s; after
// three failures in a row it is marked degraded (status line / doctor say so) and retries continue. A run
// of a minute resets the count.
//
// Stopping: `agentic-router stop` creates <home>/supervise.stop (on Windows a signal to another process is a
// hard kill, so a file is the portable request). The supervisor stops the proxy first (IPC message: in-flight
// streams finish, usage rows are flushed to the daemon), then the daemon (its authenticated shutdown
// route), then exits. <home>/supervise.json records each child's pid and state for status and doctor.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { paths, routerHome } from '@agentic-router/core';
import { proveProxy } from '@agentic-router/proxy';
import { proxyEntry } from './apimode.ts';
import { daemonEntry, daemonRequest, health } from './daemonctl.ts';
import { renewTlsIfDue } from './localtls.ts';
import { readConfig, writeJsonAtomic } from './setup.ts';

/** How often the supervisor looks at the local TLS certificate's end date (decision 157). */
export const TLS_CHECK_MS = 6 * 3600_000;

export const BACKOFF_MS = [1000, 2000, 5000, 30_000];
export const STABLE_MS = 60_000;
export const DEGRADED_AFTER = 3;

export const superviseFiles = (home = routerHome()) => ({
  pid: path.join(home, 'supervise.pid'),
  status: path.join(home, 'supervise.json'),
  stop: path.join(home, 'supervise.stop'),
  /** `mode subscription|api|direct|proxy` drops this: the supervisor re-reads the config and starts or stops the proxy. */
  reload: path.join(home, 'supervise.reload'),
  log: path.join(home, 'logs', 'supervise.log'),
});

export type ChildRunState = 'running' | 'restarting' | 'degraded' | 'stopped';
export interface ChildState {
  pid: number | null;
  state: ChildRunState;
  restarts: number;
  failures: number;
  startedAt?: string;
  lastExit?: { code: number | null; signal: string | null; at: string };
}
export interface SuperviseStatus { pid: number; startedAt: string; updatedAt: string; children: Record<string, ChildState> }

export interface ChildSpec {
  name: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Asks the child to stop; the supervisor kills it if it is still there after `stopTimeoutMs`. */
  stop(child: ChildProcess): Promise<void>;
  stopTimeoutMs: number;
  /** Written with the child's pid (the daemon's daemon.pid keeps `stop`'s fallback working). */
  pidFile?: string;
  /** What the child was started with that it cannot change while running (the proxy: local TLS on or off). A
   *  reconcile restarts a child whose key changed. */
  key?: string;
}

export interface SupervisorOptions {
  specs: ChildSpec[];
  statusFile: string;
  backoffMs?: number[];
  stableMs?: number;
  degradedAfter?: number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

const exited = (c: ChildProcess) => c.exitCode !== null || c.signalCode !== null;
const waitExit = (c: ChildProcess, ms: number) => new Promise<boolean>(resolve => {
  if (exited(c)) { resolve(true); return; }
  const t = setTimeout(() => resolve(exited(c)), ms);
  c.once('exit', () => { clearTimeout(t); resolve(true); });
});

export class Supervisor {
  readonly #o: Required<Omit<SupervisorOptions, 'log'>> & Pick<SupervisorOptions, 'log'>;
  readonly #children = new Map<string, ChildProcess>();
  readonly #states: Record<string, ChildState> = {};
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #startedAt = new Date().toISOString();
  #stopping = false;

  constructor(o: SupervisorOptions) {
    this.#o = { backoffMs: BACKOFF_MS, stableMs: STABLE_MS, degradedAfter: DEGRADED_AFTER, ...o };
    for (const s of o.specs) this.#states[s.name] = { pid: null, state: 'stopped', restarts: 0, failures: 0 };
  }

  start(): void {
    for (const s of this.#o.specs) this.#spawn(s);
  }

  states(): Record<string, ChildState> {
    return structuredClone(this.#states);
  }

  #write(): void {
    const status: SuperviseStatus = { pid: process.pid, startedAt: this.#startedAt, updatedAt: new Date().toISOString(), children: this.#states };
    try { writeJsonAtomic(this.#o.statusFile, status); } catch { /* status is informational */ }
  }

  #spawn(spec: ChildSpec): void {
    if (this.#stopping) return;
    const st = this.#states[spec.name]!;
    let child: ChildProcess;
    try {
      child = spawn(spec.command, spec.args, { env: spec.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    } catch (e) {
      this.#o.log?.('child did not start', { child: spec.name, error: String(e) });
      this.#failed(spec, Date.now(), null, null);
      return;
    }
    const started = Date.now();
    this.#children.set(spec.name, child);
    Object.assign(st, { pid: child.pid ?? null, state: st.failures >= this.#o.degradedAfter ? 'degraded' : 'running', startedAt: new Date(started).toISOString() });
    if (spec.pidFile && child.pid) { try { fs.writeFileSync(spec.pidFile, String(child.pid)); } catch { /* best effort */ } }
    this.#o.log?.('child started', { child: spec.name, pid: child.pid });
    this.#write();
    child.on('error', e => this.#o.log?.('child error', { child: spec.name, error: String(e) }));
    child.on('exit', (code, signal) => {
      if (this.#children.get(spec.name) === child) this.#children.delete(spec.name);
      st.lastExit = { code, signal, at: new Date().toISOString() };
      st.pid = null;
      // stopping, or taken out by reconcile: no restart
      if (this.#stopping || !this.#o.specs.includes(spec)) { st.state = 'stopped'; this.#write(); return; }
      this.#failed(spec, started, code, signal);
    });
  }

  #failed(spec: ChildSpec, started: number, code: number | null, signal: string | null): void {
    const st = this.#states[spec.name]!;
    st.failures = Date.now() - started >= this.#o.stableMs ? 1 : st.failures + 1;
    st.restarts++;
    st.state = st.failures >= this.#o.degradedAfter ? 'degraded' : 'restarting';
    const delay = this.#o.backoffMs[Math.min(st.failures - 1, this.#o.backoffMs.length - 1)]!;
    this.#o.log?.(st.state === 'degraded' ? 'child keeps failing: degraded' : 'child exited: restarting', { child: spec.name, code, signal, failures: st.failures, retryInMs: delay });
    this.#write();
    const t = setTimeout(() => { this.#timers.delete(spec.name); this.#spawn(spec); }, delay);
    this.#timers.set(spec.name, t);
  }

  async #stopOne(spec: ChildSpec): Promise<void> {
    const t = this.#timers.get(spec.name);
    if (t) { clearTimeout(t); this.#timers.delete(spec.name); }
    const child = this.#children.get(spec.name);
    if (child && !exited(child)) {
      try { await spec.stop(child); } catch { /* fall through to the kill */ }
      if (!await waitExit(child, spec.stopTimeoutMs)) { try { child.kill(); } catch { /* gone */ } await waitExit(child, 2000); }
    }
    if (spec.pidFile) fs.rmSync(spec.pidFile, { force: true });
  }

  /**
   * Brings the children in line with the config after a mode switch, by name: a child no longer wanted is
   * stopped (gracefully, as in stop) and dropped; a new one is started. Children in both are left running.
   */
  async reconcile(next: ChildSpec[]): Promise<{ stopped: string[]; started: string[] }> {
    if (this.#stopping) return { stopped: [], started: [] };
    const wanted = new Set(next.map(s => s.name));
    const have = new Map(this.#o.specs.map(s => [s.name, s]));
    // a child whose key changed (decision 157: the proxy's TLS listener) is stopped and started again
    const changed = new Set(next.filter(s => have.has(s.name) && (have.get(s.name)!.key ?? '') !== (s.key ?? '')).map(s => s.name));
    const gone = [...this.#o.specs].reverse().filter(s => !wanted.has(s.name) || changed.has(s.name));
    const added = next.filter(s => !have.has(s.name) || changed.has(s.name));
    this.#o.specs = [...this.#o.specs.filter(s => wanted.has(s.name) && !changed.has(s.name)), ...added];
    for (const spec of gone) {
      await this.#stopOne(spec);
      delete this.#states[spec.name];
      this.#o.log?.(changed.has(spec.name) ? 'child settings changed: restarting' : 'child no longer wanted: stopped', { child: spec.name });
    }
    for (const spec of added) {
      this.#states[spec.name] = { pid: null, state: 'stopped', restarts: 0, failures: 0 };
      this.#spawn(spec);
    }
    this.#write();
    return { stopped: gone.map(s => s.name), started: added.map(s => s.name) };
  }

  /** Stops every child in order (the proxy first, so it can flush to the daemon), then resolves. */
  async stop(): Promise<void> {
    this.#stopping = true;
    for (const t of this.#timers.values()) clearTimeout(t);
    this.#timers.clear();
    for (const spec of [...this.#o.specs].reverse()) await this.#stopOne(spec);
    // children waiting for a restart are stopped too
    for (const st of Object.values(this.#states)) { st.state = 'stopped'; st.pid = null; }
    this.#write();
  }
}

/** The children for this router home: the daemon always, the proxy in API-key proxy mode. */
export function childSpecs(home = routerHome(), env: NodeJS.ProcessEnv = process.env): ChildSpec[] {
  const cfg = readConfig();
  const childEnv = { ...env, AGENTIC_ROUTER_HOME: home };
  const specs: ChildSpec[] = [{
    name: 'daemon', command: process.execPath, args: [daemonEntry()], env: childEnv, stopTimeoutMs: 10_000, pidFile: path.join(home, 'daemon.pid'),
    stop: async () => {
      if (!cfg) return;
      const token = fs.readFileSync(paths.token(), 'utf8').trim();
      await daemonRequest(cfg.daemonPort, 'POST', '/router/v1/shutdown', { token, body: '{}', timeoutMs: 3000 });
    },
  }];
  if (cfg?.apiMode === 'proxy' && cfg.proxyPort) {
    specs.push({
      name: 'proxy', command: process.execPath, args: [proxyEntry()], env: childEnv, stopTimeoutMs: 35_000, key: `tls=${cfg.proxy?.tls === true}`,
      stop: async child => { if (child.connected) child.send({ type: 'stop' }); },
    });
  }
  return specs;
}

/** Runs the supervisor in this process until a stop is requested. */
export async function runSupervisor(home = routerHome()): Promise<void> {
  const files = superviseFiles(home);
  fs.mkdirSync(path.dirname(files.log), { recursive: true, mode: 0o700 });
  const log = (msg: string, data?: Record<string, unknown>) => {
    try { fs.appendFileSync(files.log, JSON.stringify({ t: new Date().toISOString(), msg, ...data }) + '\n', { mode: 0o600 }); } catch { /* ignore */ }
  };
  fs.rmSync(files.stop, { force: true });
  fs.rmSync(files.reload, { force: true });
  fs.writeFileSync(files.pid, String(process.pid));
  const sup = new Supervisor({ specs: childSpecs(home), statusFile: files.status, log });
  sup.start();
  // decision 157: at the supervisor's start (agentic-router start) the certificate is renewed inside RENEW_WITHIN_DAYS
  // and an older CA-shaped one is remade; the timer renews only inside TIMER_RENEW_WITHIN_DAYS or after the end,
  // since a renewal breaks running Claude Code sessions. The proxy picks a new file up without a restart.
  const renew = (at: 'start' | 'timer') => {
    try {
      const r = renewTlsIfDue(home, { at });
      if (r.cert === 'renewed' || r.cert === 'created') log('local TLS certificate made', { at, why: r.why, note: 'Claude Code sessions started before this trust the old certificate only: restart them' });
      if (r.cert === 'unavailable') log('local TLS certificate could not be made', { at, why: r.why });
      if (r.bundle === 'rebuilt') log('local TLS bundle rebuilt', { at });
      if (r.unreadable.length) log('local TLS bundle: a certificate file of yours cannot be read and is left out', { files: r.unreadable });
    } catch (e) { log('local TLS renewal failed', { error: String(e) }); }
  };
  renew('start');
  const renewTimer = setInterval(() => renew('timer'), TLS_CHECK_MS);
  renewTimer.unref();
  log('supervisor started', { pid: process.pid, children: Object.keys(sup.states()) });
  await new Promise<void>(resolve => {
    let done = false;
    const finish = (why: string) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearInterval(renewTimer);
      log('supervisor stopping', { why });
      void sup.stop().then(resolve);
    };
    let reloading = false;
    const poll = setInterval(() => {
      if (fs.existsSync(files.stop)) return finish('stop requested');
      if (reloading || !fs.existsSync(files.reload)) return;
      reloading = true;
      fs.rmSync(files.reload, { force: true });
      void sup.reconcile(childSpecs(home)).then(r => { log('mode change applied', r); }, e => { log('mode change failed', { error: String(e) }); })
        .finally(() => { reloading = false; });
    }, 500);
    process.on('SIGINT', () => finish('SIGINT'));
    process.on('SIGTERM', () => finish('SIGTERM'));
  });
  fs.rmSync(files.stop, { force: true });
  fs.rmSync(files.pid, { force: true });
  log('supervisor stopped');
}

export function readSuperviseStatus(home = routerHome()): SuperviseStatus | null {
  try { return JSON.parse(fs.readFileSync(superviseFiles(home).status, 'utf8')) as SuperviseStatus; } catch { return null; }
}

/** The proxy's health route (local token), for status and doctor. */
export interface ProxyHealth { ok: boolean; upstream?: string; via?: string | null; inflight?: number; tls?: boolean; /** something that is not this router's proxy holds the port */ other?: boolean }

/** The router's local TLS certificate when the proxy serves HTTPS (config.json proxy.tls), else undefined. */
export function proxyCa(home = routerHome()): string | undefined {
  if (readConfig()?.proxy?.tls !== true) return undefined;
  try { return fs.readFileSync(path.join(home, 'tls', 'proxy-cert.pem'), 'utf8'); } catch { return undefined; }
}

/**
 * The proxy's health. Decision 156: the proxy proves itself first (proof.ts), and only then is the local token sent
 * for the health answer; null when nothing listens, `other` when something else answers (or, with local TLS, cannot
 * complete the handshake with the router's certificate).
 */
// two seconds, so a busy proxy is not taken for something else
export async function proxyHealth(port: number, token: string, timeoutMs = 2000): Promise<ProxyHealth | null> {
  const ca = proxyCa();
  const who = await proveProxy({ port, token, timeoutMs, ...(ca ? { ca } : {}) });
  if (who === 'down') return null;
  if (who === 'other') return { ok: false, other: true };
  const body = await new Promise<string | null>(resolve => {
    const lib = ca ? https : http;
    const req = lib.request({
      host: '127.0.0.1', port, method: 'GET', path: '/proxy/v1/health', agent: false, timeout: timeoutMs,
      headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` }, ...(ca ? { ca } : {}),
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c as Buffer));
      res.on('end', () => resolve(res.statusCode === 200 ? Buffer.concat(chunks).toString('utf8') : null));
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
  if (body === null) return null;
  try { return { ...(JSON.parse(body) as ProxyHealth), tls: !!ca }; } catch { return null; }
}

export { health };
