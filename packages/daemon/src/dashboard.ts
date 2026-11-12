// Dashboard + metrics HTTP surface (decision 132), prepared as a module so it can be unit-tested with
// its own node:http server and hooked into server.ts in a few lines once that file is free. server.ts
// calls `dashboard.handle(req, res)` BEFORE its own routing: it returns true when it has taken ownership
// of the request (any /dashboard/* or /router/v1/metrics/* path) and written the response, false otherwise.
//
// Trust model (distinct from the hook API, which refuses browsers): the static SPA shell is served
// unauthenticated (it carries no data); the metrics API requires a session cookie obtained through a
// one-time code. `agentic-router dashboard` (A's CLI) calls POST /dashboard/register-code with the local
// Bearer token to mint a code, then opens http://127.0.0.1:<port>/dashboard#code=<code>; the page reads
// the fragment, POSTs it once to /dashboard/auth, and the daemon sets an HttpOnly SameSite=Strict cookie.
// Every route also checks Host (loopback only -> DNS-rebinding defence), Origin and Sec-Fetch-Site
// (same-origin only -> CSRF defence). The long-lived token never reaches the browser, a URL, or a log.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import type { Ledger } from './ledger.ts';
import { metricsSummary, metricsRequests, metricsRequestDetail, metricsTriageReport, type RequestsQuery } from './metrics.ts';
import type { Level } from '@agentic-router/core';

export interface DashboardDeps {
  ledger: Ledger;
  /** The local Bearer token; only POST /dashboard/register-code (the CLI) uses it. */
  token: string;
  /** Directory of the built SPA (packages/dashboard/dist). */
  distDir: string;
  /** The daemon's bound port, for the Origin allowlist; null before listen(). */
  port: () => number | null;
  /** router.status(sessionId?) for the "now" panel; omitted in tests that don't exercise it. */
  statusView?: (sessionId?: string) => unknown;
  now?: () => number;
  cookieTtlMs?: number;
  codeTtlMs?: number;
  maxBodyBytes?: number;
}

const COOKIE = 'ar_dash';
const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();
function safeEqual(a: string, b: string): boolean {
  const da = digest(a), db = digest(b);
  return da.length === db.length && timingSafeEqual(da, db);
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2', '.png': 'image/png', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8',
};
const CSP = "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'";

export interface Dashboard {
  handle(req: http.IncomingMessage, res: http.ServerResponse): boolean;
  /** Test/CLI helper: mint a one-time login code without going through HTTP. */
  mintCode(): string;
}

export function createDashboard(d: DashboardDeps): Dashboard {
  const now = d.now ?? (() => Date.now());
  const cookieTtl = d.cookieTtlMs ?? 12 * 60 * 60 * 1000;
  const codeTtl = d.codeTtlMs ?? 60 * 1000;
  const maxBody = d.maxBodyBytes ?? 64 * 1024;
  const codes = new Map<string, number>();     // one-time code -> expiry
  const sessions = new Map<string, number>();  // cookie session id -> expiry

  const sweep = (m: Map<string, number>): void => { const t = now(); for (const [k, exp] of m) if (exp <= t) m.delete(k); };

  function origins(): string[] {
    const p = d.port();
    return p ? [`http://127.0.0.1:${p}`, `http://localhost:${p}`] : [];
  }
  function hostOk(req: http.IncomingMessage): boolean {
    const p = d.port();
    const h = (req.headers.host ?? '').toLowerCase();
    return !!p && (h === `127.0.0.1:${p}` || h === `localhost:${p}`);
  }
  function originOk(req: http.IncomingMessage): boolean {
    const o = req.headers.origin;
    if (o === undefined) return true;                       // same-origin GET navigations omit Origin
    return origins().includes(String(o).toLowerCase());
  }
  function secFetchOk(req: http.IncomingMessage): boolean {
    const s = req.headers['sec-fetch-site'];
    return s === undefined || s === 'same-origin' || s === 'none';
  }
  function bearerOk(req: http.IncomingMessage): boolean {
    const m = /^Bearer\s+(\S+)\s*$/.exec(req.headers.authorization ?? '');
    return !!m && safeEqual(m[1]!, d.token);
  }
  function cookieSid(req: http.IncomingMessage): string | null {
    const raw = req.headers.cookie;
    if (!raw) return null;
    for (const part of raw.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === COOKIE) return v.join('=');
    }
    return null;
  }
  function sessionOk(req: http.IncomingMessage): boolean {
    const sid = cookieSid(req);
    if (!sid) return false;
    const exp = sessions.get(sid);
    if (!exp || exp <= now()) { if (sid) sessions.delete(sid); return false; }
    sessions.set(sid, now() + cookieTtl);                   // sliding expiry
    return true;
  }

  function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(text);
  }

  async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) { size += (c as Buffer).length; if (size > maxBody) return null; chunks.push(c as Buffer); }
    if (!chunks.length) return {};
    try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null; }
    catch { return null; }
  }

  function registerCode(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    if (!bearerOk(req)) return sendJson(res, 401, { error: 'unauthorized' });
    req.resume();                                           // no body expected
    const code = mintCode();
    const p = d.port();
    sendJson(res, 200, { code, url: `http://127.0.0.1:${p}/dashboard#code=${code}` });
  }

  function mintCode(): string {
    sweep(codes);
    const code = randomBytes(24).toString('base64url');
    codes.set(code, now() + codeTtl);
    return code;
  }

  async function auth(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    const body = await readJson(req);
    const code = body && typeof body.code === 'string' ? body.code : '';
    sweep(codes);
    const exp = code ? codes.get(code) : undefined;
    if (!exp || exp <= now()) return sendJson(res, 401, { error: 'invalid or expired code' });
    codes.delete(code);                                     // single use
    const sid = randomBytes(32).toString('base64url');
    sessions.set(sid, now() + cookieTtl);
    res.setHeader('set-cookie', `${COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(cookieTtl / 1000)}`);
    sendJson(res, 200, { ok: true });
  }

  function metrics(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    if (!sessionOk(req)) return sendJson(res, 401, { error: 'no dashboard session; open the dashboard with `agentic-router dashboard`' });
    const q = url.searchParams;
    const window = { since: q.get('since') ?? undefined, until: q.get('until') ?? undefined };
    const sub = url.pathname.slice('/router/v1/metrics'.length).replace(/^\//, '');
    try {
      if (sub === 'summary') return sendJson(res, 200, metricsSummary(d.ledger, window));
      if (sub === 'requests') {
        const before = q.get('before');
        const bits = before ? before.split(',') : null;
        const query: RequestsQuery = {
          ...window,
          limit: q.get('limit') ? Number(q.get('limit')) : undefined,
          level: (q.get('level') as Level) ?? undefined,
          outcome: q.get('outcome') ?? undefined,
          before: bits && bits.length === 2 ? { closedAt: bits[0]!, requestId: bits[1]! } : null,
        };
        return sendJson(res, 200, metricsRequests(d.ledger, query));
      }
      if (sub.startsWith('requests/')) {
        const detail = metricsRequestDetail(d.ledger, decodeURIComponent(sub.slice('requests/'.length)));
        return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: 'no such request' });
      }
      if (sub === 'triage-report') return sendJson(res, 200, metricsTriageReport(d.ledger, window));
      if (sub === 'now') return sendJson(res, 200, d.statusView ? d.statusView(q.get('session_id') ?? undefined) : { request: null, roles: [] });
    } catch {
      return sendJson(res, 500, { error: 'metrics query failed' });
    }
    sendJson(res, 404, { error: 'not found' });
  }

  function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    const rel = pathname === '/dashboard' || pathname === '/dashboard/' ? 'index.html' : pathname.slice('/dashboard/'.length);
    const distReal = safeReal(d.distDir);
    let file = path.resolve(d.distDir, rel);
    // path confinement: the resolved file must stay within distDir
    if (!within(distReal, file)) return sendJson(res, 403, { error: 'forbidden' });
    if (!fileExists(file)) {
      if (path.extname(rel)) return sendJson(res, 404, { error: 'not found' });   // a real asset: do not mask with HTML
      file = path.join(d.distDir, 'index.html');                                 // SPA route fallback
    }
    let data: Buffer;
    try { data = fs.readFileSync(file); } catch { return sendJson(res, 404, { error: 'not found' }); }
    const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const immutable = /[-.][0-9a-zA-Z_]{8,}\.(js|css|woff2|png|svg|webp)$/.test(file);
    res.writeHead(200, {
      'content-type': type, 'content-length': data.length, 'x-content-type-options': 'nosniff',
      'content-security-policy': CSP, 'referrer-policy': 'no-referrer',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
    });
    res.end(data);
  }

  function handle(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const p = url.pathname;
    const isDash = p === '/dashboard' || p.startsWith('/dashboard/');
    const isMetrics = p === '/router/v1/metrics' || p.startsWith('/router/v1/metrics/');
    if (!isDash && !isMetrics) return false;

    if (!hostOk(req)) { sendJson(res, 403, { error: 'host not allowed' }); return true; }
    if (!originOk(req)) { sendJson(res, 403, { error: 'cross-origin requests are not allowed' }); return true; }
    if (!secFetchOk(req)) { sendJson(res, 403, { error: 'cross-site requests are not allowed' }); return true; }

    if (p === '/dashboard/register-code') { registerCode(req, res); return true; }
    if (p === '/dashboard/auth') { void auth(req, res); return true; }
    if (isMetrics) { metrics(req, res, url); return true; }
    serveStatic(req, res, p);
    return true;
  }

  return { handle, mintCode };
}

function safeReal(p: string): string {
  try { return (fs.realpathSync.native ?? fs.realpathSync)(p); } catch { return path.resolve(p); }
}
function within(dir: string, file: string): boolean {
  const base = safeReal(dir);
  const target = safeReal(path.dirname(file)) + path.sep + path.basename(file);
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function fileExists(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
