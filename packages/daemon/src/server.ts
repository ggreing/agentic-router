// Local HTTP API (node:http). Bound to 127.0.0.1 only.
// - Every request: Host must be 127.0.0.1:<port> or localhost:<port>; any Origin header is refused
//   (no browser may talk to the daemon).
// - Everything but /health needs `Authorization: Bearer <token>`, compared in constant time.
// - POST /shutdown answers { ok: true } first, then asks the daemon to stop (CLI `stop`).
// - POST bodies: application/json only, at most 1 MB.
// - The hook response is what relay.mjs prints unchanged: text/plain for pre_compact, JSON otherwise.
// - POST /router/v1/tools/call takes one router MCP tool call from the plugin's server and always answers
//   200 with { ok, ... }: a refused call is a tool result for the lead, not a transport error.
// - API-key mode proxy (decision 130): POST /router/v1/usage takes usage rows ({ accepted, duplicates,
//   rejected }); GET /router/v1/budget?session_id=&prompt_id= answers { requestId, budgetUsd, spentUsd } or 404.
// - POST /router/v1/limits takes the status line's rate_limits for a session (spec 3.8): { stored }.
// - POST /router/v1/routing/reset (`agentic-router routing reset`, decision 138): every released level is
//   delegated again; answers { cleared }. No body.
// - /dashboard/* and /router/v1/metrics/* belong to the dashboard module (decision 132), which runs first and
//   has its own rules (same-origin browser pages with a session cookie). Every other route still refuses any
//   Origin header.
import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import type { ClientAdapter } from './adapter.ts';
import { createDashboard, type Dashboard } from './dashboard.ts';
import type { Ledger } from './ledger.ts';
import { recordLimits } from './limits.ts';
import { errorText, type Logger } from './log.ts';
import type { ProxyUsage } from './proxyusage.ts';
import type { Router } from './router.ts';

export const MAX_BODY_BYTES = 1024 * 1024;
export const API = {
  hook: '/router/v1/hooks/claude-code',
  status: '/router/v1/status',
  tools: '/router/v1/tools/call',
  health: '/router/v1/health',
  shutdown: '/router/v1/shutdown',
  usage: '/router/v1/usage',
  budget: '/router/v1/budget',
  limits: '/router/v1/limits',
  routingReset: '/router/v1/routing/reset',
} as const;

/** The built dashboard (packages/dashboard/dist) next to this package in the workspace. */
export const DEFAULT_DASHBOARD_DIST = fileURLToPath(new URL('../../dashboard/dist', import.meta.url));

export interface ServerDeps {
  router: Router;
  adapter: ClientAdapter;
  token: string;
  logger: Logger;
  version: string;
  maxBodyBytes?: number;
  /** Called once the shutdown response has been sent. */
  onShutdown?: () => void;
  /** API-key mode proxy rows and budget answers (decision 130). */
  proxyUsage?: ProxyUsage;
  /** For the rate limits route and the dashboard; without it neither is served. */
  ledger?: Ledger;
  /** The built dashboard; default DEFAULT_DASHBOARD_DIST. */
  dashboardDir?: string;
  now?: () => Date;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

export function createHttpServer(d: ServerDeps): http.Server {
  const tokenDigest = digest(d.token);
  const maxBody = d.maxBodyBytes ?? MAX_BODY_BYTES;

  const now = d.now ?? (() => new Date());
  let dashboard: Dashboard | undefined;
  const server = http.createServer((req, res) => {
    try {
      if (dashboard?.handle(req, res)) return;
    } catch (e) {
      d.logger.error('dashboard request failed', { url: req.url, error: errorText(e) });
      return send(res, 500, { error: 'internal error' });
    }
    handle(req, res).catch(e => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) d.logger.error('request failed', { url: req.url, error: errorText(e) });
      send(res, status, { error: e instanceof HttpError ? e.message : 'internal error' }, status === 413 ? { connection: 'close' } : {});
      if (status === 413) res.on('finish', () => req.destroy());
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  if (d.ledger) {
    dashboard = createDashboard({
      ledger: d.ledger, token: d.token, distDir: d.dashboardDir ?? DEFAULT_DASHBOARD_DIST,
      port: () => { const a = server.address(); return a && typeof a !== 'string' ? a.port : null; },
      statusView: sessionId => d.router.status(sessionId),
    });
  }

  const hostOk = (host: string | undefined): boolean => {
    const a = server.address();
    if (!host || !a || typeof a === 'string') return false;
    const h = host.toLowerCase();
    return h === `127.0.0.1:${a.port}` || h === `localhost:${a.port}`;
  };

  const authOk = (header: string | undefined): boolean => {
    const m = /^Bearer\s+(\S+)\s*$/.exec(header ?? '');
    return !!m && timingSafeEqual(digest(m[1]!), tokenDigest);
  };

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!hostOk(req.headers.host)) throw new HttpError(403, 'host not allowed');
    if (req.headers.origin !== undefined) throw new HttpError(403, 'cross-origin requests are not allowed');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = url.pathname;

    if (route === API.health) {
      if (req.method !== 'GET') throw methodNotAllowed(res, 'GET');
      return send(res, 200, { ok: true, version: d.version });
    }
    if (!(Object.values(API) as string[]).includes(route) || route === API.health) throw new HttpError(404, 'not found');
    if (!authOk(req.headers.authorization)) throw new HttpError(401, 'unauthorized');

    if (route === API.shutdown) {
      if (req.method !== 'POST') throw methodNotAllowed(res, 'POST');
      req.resume();                                   // no body expected; discard any
      d.logger.info('shutdown requested over the API');
      res.on('finish', () => d.onShutdown?.());
      return send(res, 200, { ok: true });
    }

    if (route === API.routingReset) {
      if (req.method !== 'POST') throw methodNotAllowed(res, 'POST');
      req.resume();                                   // no body expected; discard any
      return send(res, 200, d.router.routingReset());
    }

    if (route === API.status) {
      if (req.method !== 'GET') throw methodNotAllowed(res, 'GET');
      const sessionId = url.searchParams.get('session_id') ?? undefined;
      return send(res, 200, d.router.status(sessionId || undefined));
    }

    // ------------------------------------------------------------------ API-key mode proxy (decision 130)
    if (route === API.budget) {
      if (req.method !== 'GET') throw methodNotAllowed(res, 'GET');
      const sessionId = url.searchParams.get('session_id') ?? '';
      const promptId = url.searchParams.get('prompt_id') ?? '';
      if (!sessionId || !promptId) throw new HttpError(400, 'session_id and prompt_id are required');
      const answer = d.proxyUsage?.budget(sessionId, promptId);
      if (!answer) throw new HttpError(404, 'no request for this prompt');
      return send(res, 200, answer);
    }

    if (req.method !== 'POST') throw methodNotAllowed(res, 'POST');
    const body = await readJson(req, maxBody);
    if (route === API.tools) return send(res, 200, await d.router.tool(body));
    if (route === API.limits) {
      if (!d.ledger) throw new HttpError(404, 'not found');
      const sessionId = typeof body.sessionId === 'string' && /^[\x21-\x7e]{1,128}$/.test(body.sessionId) ? body.sessionId : '';
      if (!sessionId) throw new HttpError(400, 'sessionId is required');
      return send(res, 200, { stored: recordLimits(d.ledger.db, { sessionId, rateLimits: body.rateLimits, at: now().toISOString() }) });
    }
    if (route === API.usage) {
      if (!d.proxyUsage) throw new HttpError(404, 'not found');
      try {
        return send(res, 200, d.proxyUsage.ingest(body));
      } catch (e) {
        if (e instanceof RangeError) throw new HttpError(400, e.message);
        throw e;
      }
    }
    let ev;
    try {
      ev = d.adapter.toRouterEvent(body);
    } catch (e) {
      throw new HttpError(400, `unsupported hook input: ${errorText(e).slice(0, 200)}`);
    }
    const decision = await d.router.process(ev);
    // The response is what the hook prints as is: plain text for pre_compact (Claude Code reads it as the
    // compaction guidance), the hook output JSON for every other event.
    if (ev.type === 'pre_compact') return sendText(res, 200, d.adapter.renderPreCompactStdout?.(decision) ?? '');
    return send(res, 200, d.adapter.renderHookOutput(ev.type, decision) ?? {});
  }

  return server;
}

function methodNotAllowed(res: http.ServerResponse, allow: string): HttpError {
  res.setHeader('allow', allow);
  return new HttpError(405, 'method not allowed');
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return void res.end();
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', ...headers,
  });
  res.end(text);
}

function sendText(res: http.ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

async function readJson(req: http.IncomingMessage, max: number): Promise<Record<string, unknown>> {
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'content-type must be application/json');
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) throw new HttpError(413, `body larger than ${max} bytes`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new HttpError(413, `body larger than ${max} bytes`);
    chunks.push(chunk as Buffer);
  }
  let v: unknown;
  try {
    v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'body must be a JSON object');
  return v as Record<string, unknown>;
}
