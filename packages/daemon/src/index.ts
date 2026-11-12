// @agentic-router/daemon: local router daemon (hook event API, local auth, ledger, session verification).
// Entry contract: startDaemon(opts) resolves after the spool replay, with the bound
// port and close(). main.ts is the process entry point.
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Level, TeamPreset } from '@agentic-router/core';
import { loadClaudeCodeAdapter, type ClientAdapter } from './adapter.ts';
import { readConfig, readToken } from './config.ts';
import { ensureHomeDirs, homeLayout, tightenPermissions } from './home.ts';
import { Ledger } from './ledger.ts';
import { DEFAULT_EVENT_RETENTION_DAYS, pruneEvents } from './data.ts';
import { errorText, fileLogger, type Logger } from './log.ts';
import { Router, type VerifySettings } from './router.ts';
import { createHttpServer } from './server.ts';
import { ProxyUsage } from './proxyusage.ts';
import { replaySpool, type ReplayResult } from './spool.ts';

export interface StartOptions {
  home?: string;
  port?: number;
  host?: '127.0.0.1';
}

export interface DaemonHandle {
  port: number;
  close(): Promise<void>;
  /** Resolves once the daemon has stopped, whether by close() or by POST /router/v1/shutdown. */
  closed: Promise<void>;
}

/** Options beyond the public contract, for tests and embedding. */
export interface DaemonOptions extends StartOptions {
  adapter?: ClientAdapter;
  logger?: Logger;
  presets?: Record<Level, TeamPreset>;
  verify?: Partial<VerifySettings>;
  now?: () => Date;
}

export interface Daemon extends DaemonHandle {
  router: Router;
  ledger: Ledger;
  replay: ReplayResult;
}

export const DAEMON_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export function startDaemon(opts: StartOptions = {}): Promise<DaemonHandle> {
  return createDaemon(opts);
}

export async function createDaemon(opts: DaemonOptions = {}): Promise<Daemon> {
  const home = homeLayout(opts.home);
  ensureHomeDirs(home);
  const configWarnings: string[] = [];
  const config = readConfig(home.config, configWarnings);
  const port = opts.port ?? config.daemonPort;
  if (port === undefined) throw new Error(`no daemon port: set daemonPort in ${home.config} or pass { port }`);
  const token = readToken(home.token);
  const logger = opts.logger ?? fileLogger(home.logsDir, [token]);
  for (const w of configWarnings) logger.warn(w);
  const adapter = opts.adapter ?? await loadClaudeCodeAdapter();

  // decision 141: with recordPrompts off, opening the ledger takes conversation text out of stored events
  const ledger = new Ledger(home.db, { keepPrompts: config.recordPrompts === true });
  if (process.platform !== 'win32') tightenPermissions(home);   // the ledger file was just created (compatibility #13)
  let server: http.Server | undefined;
  try {
    const router = new Router({
      ledger, home, config, logger, secrets: [token],
      ...(opts.presets ? { presets: opts.presets } : {}),
      ...(opts.verify ? { verify: opts.verify } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });
    const replay = await replaySpool(home.spoolDir, adapter, router, logger, opts.now);
    // decision 141 (a): events older than eventRetentionDays go at start and then daily (live sessions are kept)
    const retentionDays = config.eventRetentionDays ?? DEFAULT_EVENT_RETENTION_DAYS;
    const prune = () => {
      try {
        const removed = pruneEvents(ledger.db, retentionDays, (opts.now?.() ?? new Date()).toISOString());
        if (removed) logger.info('old events dropped', { removed, retentionDays });
      } catch (e) { logger.error('event retention failed', { error: errorText(e) }); }
    };
    prune();
    const pruneTimer = retentionDays > 0 ? setInterval(prune, 86_400_000) : undefined;
    pruneTimer?.unref();
    let close: () => Promise<void> = async () => {};
    const proxyUsage = new ProxyUsage(ledger, logger, opts.now);
    const srv = createHttpServer({
      router, adapter, token, logger, version: DAEMON_VERSION, proxyUsage, ledger, home, ...(opts.now ? { now: opts.now } : {}),
      // data export (spec 4.4): stored prompts only with recordPrompts; the proxy token is masked like the daemon's
      data: { recordPrompts: config.recordPrompts === true, secrets: () => { try { return [fs.readFileSync(path.join(home.root, 'proxy-token'), 'utf8').trim()]; } catch { return []; } } },
      onShutdown: () => void close().catch(() => {}),
    });
    server = srv;
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(port, opts.host ?? '127.0.0.1', () => { srv.off('error', reject); resolve(); });
    });
    const addr = srv.address();
    const bound = addr && typeof addr === 'object' ? addr.port : port;
    logger.info('daemon listening', { port: bound, version: DAEMON_VERSION, replayed: replay.events });

    let closing: Promise<void> | undefined;
    let markClosed!: () => void;
    let markFailed!: (e: unknown) => void;
    const closed = new Promise<void>((resolve, reject) => { markClosed = resolve; markFailed = reject; });
    closed.catch(() => {});                                     // callers observe failures through `closed`
    close = () => closing ??= (async () => {
      router.abort();                                          // kill running verify commands first
      const stopped = new Promise<void>(resolve => srv.close(() => resolve()));   // no new connections
      await router.drain();                                    // in-flight hooks finish; aborted stops answer {}
      srv.closeIdleConnections();
      await Promise.race([stopped, sleep(2000, undefined, { ref: false })]);   // let the last responses flush
      srv.closeAllConnections();
      await stopped;
      if (pruneTimer) clearInterval(pruneTimer);
      ledger.close();
      logger.info('daemon stopped');
    })().then(markClosed, e => { markFailed(e); throw e; });
    return { port: bound, close: () => close(), closed, router, ledger, replay };
  } catch (e) {
    server?.close();
    ledger.close();
    throw e;
  }
}

export { Router } from './router.ts';
export type { StatusView, RoleView, VerifySettings } from './router.ts';
export { Ledger } from './ledger.ts';
export type { ClientAdapter } from './adapter.ts';
export { runVerify, checkScope, type VerifyCommand, type VerifyPlan } from './verify.ts';
export { SessionQueue } from './queue.ts';
export { API, MAX_BODY_BYTES, DEFAULT_DASHBOARD_DIST } from './server.ts';
export { exportLines, isoTime, liveSessions, pruneEvents, purge, purgeFiles, scrubProse, scrubStoredPrompts, REQUEST_TABLES, SESSION_TABLES, type DataHome, type ExportOptions, type PurgeOptions, type PurgeResult } from './data.ts';
