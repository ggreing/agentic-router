// Local HTTP API (node:http). Bound to 127.0.0.1 only.
// - Every request: Host must be 127.0.0.1:<port> or localhost:<port>; any Origin header is refused
//   (no browser may talk to the daemon).
// - Everything but /health needs `Authorization: Bearer <token>`, compared in constant time.
// - POST /shutdown answers { ok: true } first, then asks the daemon to stop (CLI `stop`).
// - POST bodies: application/json only, at most 1 MB.
// - The hook response is what relay.mjs prints unchanged: text/plain for pre_compact, JSON otherwise.
import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { ClientAdapter } from './adapter.ts';
import { errorText, type Logger } from './log.ts';
import type { Router } from './router.ts';

export const MAX_BODY_BYTES = 1024 * 1024;
export const API = {
  hook: '/router/v1/hooks/claude-code',
  status: '/router/v1/status',
  health: '/router/v1/health',
  shutdown: '/router/v1/shutdown',
} as const;

export interface ServerDeps {
  router: Router;
  adapter: ClientAdapter;
  token: string;
  logger: Logger;
  version: string;
  maxBodyBytes?: number;
  /** Called once the shutdown response has been sent. */
  onShutdown?: () => void;
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

  const server = http.createServer((req, res) => {
    handle(req, res).catch(e => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) d.logger.error('request failed', { url: req.url, error: errorText(e) });
      send(res, status, { error: e instanceof HttpError ? e.message : 'internal error' }, status === 413 ? { connection: 'close' } : {});
      if (status === 413) res.on('finish', () => req.destroy());
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

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
    if (route !== API.status && route !== API.hook && route !== API.shutdown) throw new HttpError(404, 'not found');
    if (!authOk(req.headers.authorization)) throw new HttpError(401, 'unauthorized');

    if (route === API.shutdown) {
      if (req.method !== 'POST') throw methodNotAllowed(res, 'POST');
      req.resume();                                   // no body expected; discard any
      d.logger.info('shutdown requested over the API');
      res.on('finish', () => d.onShutdown?.());
      return send(res, 200, { ok: true });
    }

    if (route === API.status) {
      if (req.method !== 'GET') throw methodNotAllowed(res, 'GET');
      const sessionId = url.searchParams.get('session_id') ?? undefined;
      return send(res, 200, d.router.status(sessionId || undefined));
    }

    if (req.method !== 'POST') throw methodNotAllowed(res, 'POST');
    const body = await readJson(req, maxBody);
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
