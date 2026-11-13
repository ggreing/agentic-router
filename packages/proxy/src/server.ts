// The proxy's HTTP server on 127.0.0.1 (spec 3.1, 4.4; decision 130).
//   HEAD /api/hello          answered here with 200: a connection-warming probe that needs no key
//   GET  /proxy/v1/health    local token: upstream origin, uptime, version, exchanges in flight
//   /v1/*                    local token, then forwarded unchanged (messages, count_tokens, models)
// Any Origin header or a Host other than this loopback address and port is refused (browser requests, DNS
// rebinding). A POST /v1/messages is read (bounded by the API's request limit), held against the budget caps at
// its worst case (reserve.ts) and only then sent, byte for byte; one exchange gives one usage row. The upstream
// connection goes through a corporate HTTP(S) proxy when one is configured (egress.ts).
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { Budget, daemonBudgetSource, type BudgetSource } from './budget.ts';
import type { ProxySettings } from './config.ts';
import { agentProxyEnv, type UpstreamProxy } from './egress.ts';
import { forward, localError } from './forward.ts';
import { NONCE_RE, PROOF_PATH, proofOf } from './proof.ts';
import { MAX_REQUEST_BYTES, requestShape, reservationFor } from './reserve.ts';
import { errorText, type Logger } from './log.ts';
import type { ProxyPaths } from './paths.ts';
import type { LocalTokens } from './token.ts';
import { UsageReporter, attribution, price, tokensOf, type DaemonTarget, type ReporterOptions, type RowState, type UsageRow } from './usage.ts';

export const PROXY_VERSION = '0.2.0';

/**
 * The answer to a request over a budget cap (decision 130): 429 with x-should-retry: false so Claude Code
 * shows the message and does not retry. The contract spike confirms the status.
 */
export const BUDGET_BLOCK_STATUS = 429;
export const BUDGET_BLOCK_ERROR_TYPE = 'rate_limit_error';

/** How often the proxy looks for a renewed local TLS certificate (decision 157). */
export const TLS_RELOAD_MS = 60_000;

/** In-flight streams get this long to finish when the proxy stops. */
export const DRAIN_MS = 30_000;

/**
 * A6: what a 2xx that could not be fully priced (an unparsed body, a partial stream) is charged at least, never
 * $0; no more than the request's own hold (reserve.ts sizes the hold from the request).
 */
export const UNPRICED_MIN_USD = 0.5;
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
  settings: Pick<ProxySettings, 'upstream' | 'tokenDailyCapUsd' | 'dailyCapUsd' | 'headersTimeoutMs' | 'tls'>;
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
  /** The corporate proxy for the upstream connection (main.ts: upstreamProxy(process.env)); none: direct. */
  egress?: UpstreamProxy;
  /** Tests only: a certificate the upstream connection also trusts (a local TLS upstream). */
  testUpstreamCa?: string;
  /** Tests only: a smaller body limit than the API's (MAX_REQUEST_BYTES). */
  maxRequestBytes?: number;
  /** Tests only: how often a renewed TLS certificate is looked for (TLS_RELOAD_MS). */
  tlsReloadMs?: number;
}

/** The whole request body, or why not: 'too_large' (more than `limit`; the rest is not kept) or 'aborted'. */
function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer | 'too_large' | 'aborted'> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let n = 0;
    let done = false;
    const finish = (v: Buffer | 'too_large' | 'aborted') => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c: Buffer) => {
      if (done) return;
      n += c.length;
      if (n > limit) { chunks.length = 0; finish('too_large'); return; }
      chunks.push(c);
    });
    req.on('end', () => finish(Buffer.concat(chunks, n)));
    req.on('close', () => { if (!req.complete) finish('aborted'); });
    req.on('error', () => finish('aborted'));
  });
}

export interface Proxy {
  readonly server: http.Server | https.Server;
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
      return Number.isInteger(c.daemonPort) && token ? { port: c.daemonPort as number, token, home: paths.home } : undefined;
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
  // HTTPS upstream: through the corporate proxy when one is set (a CONNECT tunnel; TLS verified end to end). The
  // plain-http upstream is the loopback test fake and never goes through a proxy.
  const agent: http.Agent = o.settings.upstream.protocol === 'https:'
    ? new https.Agent({
      keepAlive: true, maxSockets: 64,
      ...(o.egress ? { proxyEnv: agentProxyEnv(o.egress) } : {}),
      ...(o.testUpstreamCa ? { ca: o.testUpstreamCa } : {}),
    })
    : new http.Agent({ keepAlive: true, maxSockets: 64 });
  const maxBody = o.maxRequestBytes ?? MAX_REQUEST_BYTES;
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
      localError(res, 403, 'permission_error', 'do-it-all-claude-code proxy: requests from a web page are refused');
      drainLimited(req);
      return;
    }
    if (!hostOk(req.headers.host)) {
      localError(res, 403, 'permission_error', 'do-it-all-claude-code proxy: unexpected Host header');
      drainLimited(req);
      return;
    }
    const url = req.url ?? '/';
    const route = url.split('?')[0]!;
    if (req.method === 'HEAD' && route === '/api/hello') { res.writeHead(200); res.end(); return; }
    // decision 156: the proof that this is the router's proxy, asked for before the token is handed over (proof.ts)
    if (route === PROOF_PATH) {
      if (req.method !== 'POST') { drainLimited(req); localError(res, 405, 'invalid_request_error', 'do-it-all-claude-code proxy: POST a nonce'); return; }
      const read = await readBody(req, 1024);
      if (read === 'aborted') return;
      let nonce: unknown;
      try { nonce = read === 'too_large' ? undefined : (JSON.parse(read.toString('utf8')) as { nonce?: unknown }).nonce; } catch { nonce = undefined; }
      if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) { localError(res, 400, 'invalid_request_error', 'do-it-all-claude-code proxy: a nonce of 16 to 64 base64url characters is needed'); return; }
      const body = JSON.stringify({ v: 1, proof: proofOf(o.tokens.current(), listenPort, nonce) });
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    const presented = bearer(req.headers.authorization) ?? (typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined);
    const auth = o.tokens.accept(presented);
    if (route === '/proxy/v1/health') {
      req.resume();
      if (!auth) { localError(res, 401, 'authentication_error', 'do-it-all-claude-code proxy: invalid local token'); return; }
      const body = JSON.stringify({ ok: true, version: PROXY_VERSION, upstream: o.settings.upstream.origin, via: o.egress?.shown ?? null, uptimeMs: Date.now() - started, inflight });
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(body);
      return;
    }
    // A6: allowlist (method, canonical path); anything else under /v1 (batches, //, trailing slash) is refused.
    const kind = classifyRoute(req.method, canonicalPath(route));
    if (!kind) { drainLimited(req); localError(res, 404, 'not_found_error', 'do-it-all-claude-code proxy: this path is not proxied'); return; }
    if (!auth) { drainLimited(req); localError(res, 401, 'authentication_error', 'do-it-all-claude-code proxy: invalid local token'); return; }

    const att = attribution(req.headers);
    const messages = kind === 'messages';
    let reservationId: string | undefined;
    let held = 0;
    let body: Buffer | undefined;
    if (messages) {
      // the body is read once, bounded by the API's own limit, to size the hold; it is forwarded as these bytes
      const tooLarge = () => {
        localError(res, 413, 'request_too_large', `do-it-all-claude-code proxy: the request body is over ${maxBody} bytes, more than the API accepts`, false);
        res.once('finish', () => req.destroy());
      };
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBody) { tooLarge(); return; }
      const read = await readBody(req, maxBody);
      if (read === 'aborted') return;   // the client went away before sending it all: nothing is sent or held
      if (read === 'too_large') { tooLarge(); return; }
      body = read;
      const enc = req.headers['content-encoding'];
      const reservation = reservationFor(requestShape(body, typeof enc === 'string' ? enc : undefined, maxBody));
      const r = await budget.check({ tokenId: auth.id, sessionId: att.sessionId, promptId: att.promptId, reserveUsd: reservation.usd, reserveBasis: reservation.basis });
      if ('block' in r) {
        o.log.warn('request blocked by a budget cap', { cap: r.block.kind, held: reservation.usd, pricedAs: reservation.pricedAs, sessionId: att.sessionId, promptId: att.promptId });
        localError(res, BUDGET_BLOCK_STATUS, BUDGET_BLOCK_ERROR_TYPE, r.block.message, false);
        return;
      }
      reservationId = r.reservationId;
      held = reservation.usd;
    }

    inflight++;
    const startedAt = now().toISOString();
    const t0 = Date.now();
    try {
      const out = await forward(req, res, { upstream: o.settings.upstream, agent, key: o.key.get, headersTimeoutMs: o.settings.headersTimeoutMs, tap: messages, restrictEncoding: messages, ...(body ? { body } : {}) });
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
      // A6: settle the hold with the actual cost; a 2xx we could not fully price (unparsed body, partial stream)
      // is charged at least UNPRICED_MIN_USD (no more than its hold), never $0; a 4xx/5xx releases the hold.
      const settleUsd = out.status >= 400 ? 0 : (state === 'complete' && cost.priced ? cost.usd : Math.max(cost.usd, Math.min(UNPRICED_MIN_USD, held)));
      budget.settle(reservationId!, settleUsd);
      reporter.add(row);
      o.log.info('exchange', {
        status: out.status, state, model, usd: row.usd, held, charged: settleUsd, ms: Date.now() - t0, sessionId: att.sessionId, agentId: att.agentId,
        ...(out.clientAborted ? { clientAborted: true } : {}), ...(out.upstreamBroken ? { upstreamBroken: true } : {}),
        ...(cost.priced ? {} : { unpriced: true }),
      });
    } catch (e) {
      if (reservationId) budget.settle(reservationId, 0);   // internal error: release the reservation
      o.log.error('exchange failed', { error: errorText(e) });
      localError(res, 502, 'api_error', 'do-it-all-claude-code proxy: internal error', true);
    } finally {
      inflight--;
    }
  };

  const listener = (req: http.IncomingMessage, res: http.ServerResponse) => {
    handle(req, res).catch(e => {
      o.log.error('request failed', { error: errorText(e) });
      localError(res, 502, 'api_error', 'do-it-all-claude-code proxy: internal error', true);
    });
  };
  const serverOptions = { requestTimeout: REQUEST_TIMEOUT_MS, headersTimeout: 60_000, keepAliveTimeout: 65_000 };
  // decision 157: HTTPS with the router's local certificate; a plain-HTTP request to this port fails its handshake
  // (there is no plain listener to fall back to). A renewed certificate is picked up without a restart.
  const tls = o.settings.tls;
  const readTls = () => ({ cert: fs.readFileSync(tls!.certFile), key: fs.readFileSync(tls!.keyFile) });
  const server: http.Server | https.Server = tls
    ? https.createServer({ ...serverOptions, ...readTls(), minVersion: 'TLSv1.2' }, listener)
    : http.createServer(serverOptions, listener);
  let tlsWatch: NodeJS.Timeout | undefined;
  if (tls) {
    const stamp = () => { try { return `${fs.statSync(tls.certFile).mtimeMs}/${fs.statSync(tls.keyFile).mtimeMs}`; } catch { return ''; } };
    let seen = stamp();
    tlsWatch = setInterval(() => {
      const now = stamp();
      if (!now || now === seen) return;
      try { (server as https.Server).setSecureContext({ ...readTls(), minVersion: 'TLSv1.2' }); seen = now; o.log.info('local TLS certificate reloaded'); }
      catch (e) { o.log.error('local TLS certificate not reloaded', { error: errorText(e) }); }
    }, o.tlsReloadMs ?? TLS_RELOAD_MS);
    tlsWatch.unref();
  }

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
      if (tlsWatch) clearInterval(tlsWatch);
    },
  };
}
