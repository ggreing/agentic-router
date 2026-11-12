// The proxy's HTTP server on 127.0.0.1 (spec 3.1, 4.4; decision 130).
//   HEAD /api/hello          answered here with 200: a connection-warming probe that needs no key
//   GET  /proxy/v1/health    local token: upstream origin, uptime, version, exchanges in flight
//   /v1/*                    local token, then forwarded unchanged (messages, count_tokens, models)
// Any Origin header or a Host other than this loopback address and port is refused (browser requests, DNS
// rebinding). A POST /v1/messages is checked against the budget caps before it is sent; one exchange gives
// one usage row.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { Budget, daemonBudgetSource, type BudgetSource } from './budget.ts';
import type { ProxySettings } from './config.ts';
import { forward, localError } from './forward.ts';
import { errorText, type Logger } from './log.ts';
import type { ProxyPaths } from './paths.ts';
import type { LocalTokens } from './token.ts';
import { UsageReporter, attribution, price, tokensOf, type DaemonTarget, type ReporterOptions, type RowState, type UsageRow } from './usage.ts';

export const PROXY_VERSION = '0.1.0';

/**
 * The answer to a request over a budget cap (decision 130): 429 with x-should-retry: false so Claude Code
 * shows the message and does not retry. The contract spike confirms the status.
 */
export const BUDGET_BLOCK_STATUS = 429;
export const BUDGET_BLOCK_ERROR_TYPE = 'rate_limit_error';

/** In-flight streams get this long to finish when the proxy stops. */
export const DRAIN_MS = 30_000;

/** A6: worst-case amount reserved for one POST /v1/messages at check time, settled to the actual after. */
export const RESERVE_USD = 0.5;
/** A6: only these (method, canonical path) go upstream; everything else /v1/* is refused. */
export const ALLOWED_ROUTES: Record<string, 'messages' | 'count_tokens' | 'models'> = {
  'POST /v1/messages': 'messages',
  'POST /v1/messages/count_tokens': 'count_tokens',
  'GET /v1/models': 'models',
};
/** D: how much of an unauthenticated/refused request body to drain before closing the socket. */
export const UNAUTH_BODY_LIMIT = 64 * 1024;
/** D: a whole request (headers + body) must complete within this, so a half-sent request cannot hang a slot. */
export const REQUEST_TIMEOUT_MS = 120_000;

/** Collapse `//`, strip a trailing slash (keep root): `/v1//messages/` -> `/v1/messages`. */
export function canonicalPath(p: string): string {
  const c = p.replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1');
  return c || '/';
}
export function classifyRoute(method: string | undefined, canon: string): 'messages' | 'count_tokens' | 'models' | null {
  const hit = ALLOWED_ROUTES[`${method} ${canon}`];
  if (hit) return hit;
  if (method === 'GET' && /^\/v1\/models\/[A-Za-z0-9._-]+$/.test(canon)) return 'models';   // a specific model
  return null;
}

export interface ProxyOptions {
  paths: ProxyPaths;
  settings: Pick<ProxySettings, 'upstream' | 'tokenDailyCapUsd' | 'dailyCapUsd' | 'headersTimeoutMs'>;
  /** The vault key holder (vault.loadKey). */
  key: { get(): string };
  tokens: LocalTokens;
  log: Logger;
  now?: () => Date;
  /** Request budgets (default: the daemon's GET /router/v1/budget). */
  budgetSource?: BudgetSource;
  /** Where the daemon is (default: config.json daemonPort and the token file, read at each use). */
  daemon?: () => DaemonTarget | undefined;
  reporter?: Partial<Omit<ReporterOptions, 'paths' | 'daemon' | 'log'>>;
}

export interface Proxy {
  readonly server: http.Server;
  readonly reporter: UsageReporter;
  readonly budget: Budget;
  listen(port: number): Promise<number>;
  port(): number;
  close(): Promise<void>;
}

/** config.json's daemonPort and the daemon token file, read fresh. */
export function daemonFromHome(paths: ProxyPaths): () => DaemonTarget | undefined {
  return () => {
    try {
      const c = JSON.parse(fs.readFileSync(paths.config, 'utf8')) as { daemonPort?: unknown };
      const token = fs.readFileSync(paths.daemonToken, 'utf8').trim();
      return Number.isInteger(c.daemonPort) && token ? { port: c.daemonPort as number, token } : undefined;
    } catch {
      return undefined;
    }
  };
}

const bearer = (h: string | undefined): string | undefined => {
  const m = /^Bearer\s+(\S+)$/i.exec(h ?? '');
  return m?.[1];
};

export function createProxy(o: ProxyOptions): Proxy {
  const now = o.now ?? (() => new Date());
  const started = Date.now();
  const daemon = o.daemon ?? daemonFromHome(o.paths);
  const reporter = new UsageReporter({ paths: o.paths, daemon, log: o.log, ...o.reporter });
  const budget = new Budget({
    dbFile: o.paths.db, tokenDailyCapUsd: o.settings.tokenDailyCapUsd, dailyCapUsd: o.settings.dailyCapUsd,
    source: o.budgetSource ?? daemonBudgetSource(daemon), now,
  });
  try { fs.chmodSync(o.paths.db, 0o600); } catch { /* Windows, or not created yet */ }
  const agent: http.Agent = o.settings.upstream.protocol === 'https:'
    ? new https.Agent({ keepAlive: true, maxSockets: 64 })
    : new http.Agent({ keepAlive: true, maxSockets: 64 });
  let inflight = 0;
  let listenPort = 0;

  const hostOk = (host: string | undefined) => {
    const h = (host ?? '').toLowerCase();
    return h === `127.0.0.1:${listenPort}` || h === `localhost:${listenPort}`;
  };

  // D: a refused request's body is drained but bounded, so an unauthenticated client cannot stream forever.
  const drainLimited = (req: http.IncomingMessage) => {
    let n = 0;
    req.on('data', (c: Buffer) => { n += c.length; if (n > UNAUTH_BODY_LIMIT) req.destroy(); });
    req.on('error', () => { /* ignore: the request is being refused */ });
    req.resume();
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    res.socket?.setNoDelay(true);
    if (req.headers.origin !== undefined) {
      localError(res, 403, 'permission_error', 'agentic-router proxy: requests from a web page are refused');
      drainLimited(req);
      return;
    }
    if (!hostOk(req.headers.host)) {
      localError(res, 403, 'permission_error', 'agentic-router proxy: unexpected Host header');
      drainLimited(req);
      return;
    }
    const url = req.url ?? '/';
    const route = url.split('?')[0]!;
    if (req.method === 'HEAD' && route === '/api/hello') { res.writeHead(200); res.end(); return; }
    const presented = bearer(req.headers.authorization) ?? (typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined);
    const auth = o.tokens.accept(presented);
    if (route === '/proxy/v1/health') {
      req.resume();
      if (!auth) { localError(res, 401, 'authentication_error', 'agentic-router proxy: invalid local token'); return; }
      const body = JSON.stringify({ ok: true, version: PROXY_VERSION, upstream: o.settings.upstream.origin, uptimeMs: Date.now() - started, inflight });
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(body);
      return;
    }
    // A6: allowlist (method, canonical path); anything else under /v1 (batches, //, trailing slash) is refused.
    const kind = classifyRoute(req.method, canonicalPath(route));
    if (!kind) { drainLimited(req); localError(res, 404, 'not_found_error', 'agentic-router proxy: this path is not proxied'); return; }
    if (!auth) { drainLimited(req); localError(res, 401, 'authentication_error', 'agentic-router proxy: invalid local token'); return; }

    const att = attribution(req.headers);
    const messages = kind === 'messages';
    let reservationId: string | undefined;
    if (messages) {
      const r = await budget.check({ tokenId: auth.id, sessionId: att.sessionId, promptId: att.promptId, reserveUsd: RESERVE_USD });
      if ('block' in r) {
        drainLimited(req);
        o.log.warn('request blocked by a budget cap', { cap: r.block.kind, sessionId: att.sessionId, promptId: att.promptId });
        localError(res, BUDGET_BLOCK_STATUS, BUDGET_BLOCK_ERROR_TYPE, r.block.message, false);
        return;
      }
      reservationId = r.reservationId;
    }

    inflight++;
    const startedAt = now().toISOString();
    const t0 = Date.now();
    try {
      const out = await forward(req, res, { upstream: o.settings.upstream, agent, key: o.key.get, headersTimeoutMs: o.settings.headersTimeoutMs, tap: messages, restrictEncoding: messages });
      if (!messages) return;
      const tap = out.tap;
      const state: RowState = tap?.sawStop && out.status < 400 ? 'complete' : tap?.sawStart ? 'partial' : 'error';
      const model = tap?.model ?? null;
      const cost = state === 'error' ? { usd: 0, priced: true } : price(model, tap!);
      const row: UsageRow = {
        id: randomUUID(), messageId: tap?.messageId ?? null, upstreamRequestId: out.upstreamRequestId, ...att, path: route, model,
        usage: tokensOf(tap ?? { sawStart: false, sawStop: false }), usd: cost.usd, priced: cost.priced, state, httpStatus: out.status,
        tokenId: auth.id, startedAt, endedAt: now().toISOString(),
      };
      // A6: settle the reservation with the actual cost; a 2xx we could not fully price (unparsed body,
      // partial stream) is charged at least the reserve, never $0; a 4xx/5xx refunds the reservation.
      const settleUsd = out.status >= 400 ? 0 : (state === 'complete' && cost.priced ? cost.usd : Math.max(cost.usd, RESERVE_USD));
      budget.settle(reservationId!, settleUsd);
      reporter.add(row);
      o.log.info('exchange', {
        status: out.status, state, model, usd: row.usd, charged: settleUsd, ms: Date.now() - t0, sessionId: att.sessionId, agentId: att.agentId,
        ...(out.clientAborted ? { clientAborted: true } : {}), ...(out.upstreamBroken ? { upstreamBroken: true } : {}),
        ...(cost.priced ? {} : { unpriced: true }),
      });
    } catch (e) {
      if (reservationId) budget.settle(reservationId, 0);   // internal error: release the reservation
      o.log.error('exchange failed', { error: errorText(e) });
      localError(res, 502, 'api_error', 'agentic-router proxy: internal error', true);
    } finally {
      inflight--;
    }
  };

  const server = http.createServer({ requestTimeout: REQUEST_TIMEOUT_MS, headersTimeout: 60_000, keepAliveTimeout: 65_000 }, (req, res) => {
    handle(req, res).catch(e => {
      o.log.error('request failed', { error: errorText(e) });
      localError(res, 502, 'api_error', 'agentic-router proxy: internal error', true);
    });
  });

  return {
    server, reporter, budget,
    port: () => listenPort,
    listen: port => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        listenPort = (server.address() as { port: number }).port;
        resolve(listenPort);
      });
    }),
    close: async () => {
      await new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeIdleConnections();
        const deadline = Date.now() + DRAIN_MS;
        const wait = setInterval(() => {
          if (inflight === 0 || Date.now() > deadline) { clearInterval(wait); server.closeAllConnections(); }
        }, 50);
        wait.unref();
      });
      await reporter.close();
      budget.close();
      agent.destroy();
    },
  };
}
