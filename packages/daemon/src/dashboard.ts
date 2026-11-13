// Dashboard + metrics HTTP surface (decision 132), prepared as a module so it can be unit-tested with
// its own node:http server and hooked into server.ts in a few lines. server.ts calls
// `dashboard.handle(req, res)` BEFORE its own routing: it returns true when it has taken ownership of the
// request (any /dashboard/* path) and written the response, false otherwise. Everything lives under
// /dashboard — the SPA shell, the one-time-code auth, and the metrics API at /dashboard/metrics/* — so the
// session cookie is scoped to Path=/dashboard and never reaches another local server (cookies are not
// port-scoped). Sessions have an absolute lifetime and an idle timeout, are swept, and POST
// /dashboard/logout clears one (C2).
//
// Trust model (distinct from the hook API, which refuses browsers): the static SPA shell is served
// unauthenticated (it carries no data); the metrics API requires a session cookie obtained through a
// one-time code. The CLI's `do-it-all-claude-code dashboard` calls POST /dashboard/register-code (a sealed call; the
// daemon makes it to itself with the token below) to mint a code, then opens http://127.0.0.1:<port>/dashboard#code=<code>; the page reads
// the fragment, POSTs it once to /dashboard/auth, and the daemon sets an HttpOnly SameSite=Strict cookie.
// Every route also checks Host (loopback only -> DNS-rebinding defence), Origin and Sec-Fetch-Site
// (same-origin only -> CSRF defence). The long-lived token never reaches the browser, a URL, or a log.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import { isWithin } from './canonical.ts';
import type { Ledger } from './ledger.ts';
import { metricsSummary, metricsRequests, metricsRequestDetail, metricsTriageReport, type RequestsQuery } from './metrics.ts';
import { latestLimits } from './limits.ts';
import type { Level } from '@do-it-all-claude-code/core';

export interface DashboardDeps {
  ledger: Ledger;
  /** The Bearer value POST /dashboard/register-code needs: what a sealed call's inner request carries (decisions 156, 164). */
  token: string;
  /** Directory of the built SPA (packages/dashboard/dist). */
  distDir: string;
  /** The daemon's bound port, for the Origin allowlist; null before listen(). */
  port: () => number | null;
  /** router.status(sessionId?) for the "now" panel; omitted in tests that don't exercise it. */
  statusView?: (sessionId?: string) => unknown;
  /** Current config.recordPrompts: the request detail returns prompt text only when this is true (A4/142). */
  recordPrompts?: boolean;
  now?: () => number;
  cookieTtlMs?: number;      // absolute session lifetime (default 12h)
  idleTtlMs?: number;        // idle timeout (default 30m)
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

// audit C6: `npm ci` does not build the SPA, so dist can be absent. Rather than a bare 404, a navigation to
// /dashboard then gets this small page telling the user how to build it.
const UNBUILT_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Dashboard not built</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:14px/1.6 system-ui,-apple-system,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#222}code{background:#f0f0f0;padding:.1rem .35rem;border-radius:3px}pre{background:#f0f0f0;padding:.75rem 1rem;border-radius:6px;overflow:auto}</style>
</head><body>
<h1>Dashboard not built yet</h1>
<p>The dashboard's web assets have not been built. <code>npm ci</code> installs dependencies but does not build the SPA. From the project root, run:</p>
<pre><code>npm run build:dashboard</code></pre>
<p>Then reload this page. <code>do-it-all-claude-code doctor</code> also reports the dashboard build state.</p>
</body></html>`;
const UNBUILT_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'";

export interface Dashboard {
  handle(req: http.IncomingMessage, res: http.ServerResponse): boolean;
  /** Test/CLI helper: mint a one-time login code without going through HTTP. */
  mintCode(): string;
  /** Stops the background session sweeper (for tests / shutdown). */
  stop(): void;
}

const COOKIE_PATH = '/dashboard';

export function createDashboard(d: DashboardDeps): Dashboard {
  const now = d.now ?? (() => Date.now());
  const absoluteTtl = d.cookieTtlMs ?? 12 * 60 * 60 * 1000;       // absolute session lifetime (C2)
  const idleTtl = d.idleTtlMs ?? 30 * 60 * 1000;                  // idle timeout (C2)
  const codeTtl = d.codeTtlMs ?? 60 * 1000;
  const maxBody = d.maxBodyBytes ?? 64 * 1024;
  const codes = new Map<string, number>();                       // one-time code -> expiry
  const sessions = new Map<string, { created: number; seen: number }>();  // cookie session id -> timestamps

  const sweepCodes = (): void => { const t = now(); for (const [k, exp] of codes) if (exp <= t) codes.delete(k); };
  const expired = (s: { created: number; seen: number }): boolean => now() - s.created >= absoluteTtl || now() - s.seen >= idleTtl;
  const sweepSessions = (): void => { for (const [k, s] of sessions) if (expired(s)) sessions.delete(k); };
  // reap idle/expired sessions even without traffic; unref so it never keeps the process alive
  const sweeper = setInterval(() => { sweepCodes(); sweepSessions(); }, 5 * 60 * 1000);
  (sweeper as { unref?: () => void }).unref?.();

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
    const s = sessions.get(sid);
    if (!s || expired(s)) { if (sid) sessions.delete(sid); return false; }
    s.seen = now();                                         // sliding idle; the absolute lifetime never extends
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
    sweepCodes();
    const code = randomBytes(24).toString('base64url');
    codes.set(code, now() + codeTtl);
    return code;
  }

  async function auth(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    const body = await readJson(req);
    const code = body && typeof body.code === 'string' ? body.code : '';
    sweepCodes();
    const exp = code ? codes.get(code) : undefined;
    if (!exp || exp <= now()) return sendJson(res, 401, { error: 'invalid or expired code' });
    codes.delete(code);                                     // single use
    sweepSessions();
    const sid = randomBytes(32).toString('base64url');
    sessions.set(sid, { created: now(), seen: now() });
    // Path=/dashboard keeps the cookie off other local servers (cookies are not port-scoped); Max-Age is the
    // absolute lifetime, and the server also enforces the idle timeout and absolute lifetime (C2).
    res.setHeader('set-cookie', `${COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=${COOKIE_PATH}; Max-Age=${Math.floor(absoluteTtl / 1000)}`);
    sendJson(res, 200, { ok: true });
  }

  function logout(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    const sid = cookieSid(req);
    if (sid) sessions.delete(sid);
    res.setHeader('set-cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=${COOKIE_PATH}; Max-Age=0`);
    sendJson(res, 200, { ok: true });
  }

  function metrics(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    if (!sessionOk(req)) return sendJson(res, 401, { error: 'no dashboard session; open the dashboard with `do-it-all-claude-code dashboard`' });
    const q = url.searchParams;
    const window = { since: q.get('since') ?? undefined, until: q.get('until') ?? undefined };
    const sub = url.pathname.slice(`${COOKIE_PATH}/metrics`.length).replace(/^\//, '');
    // D: bad input is a 400, not a 500. Validate the query/path before touching the ledger.
    const limitRaw = q.get('limit');
    if (limitRaw !== null && !/^\d{1,4}$/.test(limitRaw)) return sendJson(res, 400, { error: 'limit must be a number' });
    try {
      if (sub === 'summary') return sendJson(res, 200, { ...metricsSummary(d.ledger, window), limits: latestLimits(d.ledger.db) });
      if (sub === 'requests') {
        const before = q.get('before');
        const bits = before ? before.split(',') : null;
        const query: RequestsQuery = {
          ...window,
          limit: limitRaw ? Number(limitRaw) : undefined,
          level: (q.get('level') as Level) ?? undefined,
          outcome: q.get('outcome') ?? undefined,
          before: bits && bits.length === 2 ? { closedAt: bits[0]!, requestId: bits[1]! } : null,
        };
        return sendJson(res, 200, metricsRequests(d.ledger, query));
      }
      if (sub.startsWith('requests/')) {
        let id: string;
        try { id = decodeURIComponent(sub.slice('requests/'.length)); } catch { return sendJson(res, 400, { error: 'malformed request id' }); }
        const detail = metricsRequestDetail(d.ledger, id, { includePrompt: d.recordPrompts === true, secrets: [d.token] });
        return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: 'no such request' });
      }
      if (sub === 'triage-report') return sendJson(res, 200, metricsTriageReport(d.ledger, window));
      if (sub === 'now') {
        const sid = q.get('session_id') ?? undefined;
        const view = d.statusView ? d.statusView(sid) : { request: null, roles: [] };
        return sendJson(res, 200, { ...(view as Record<string, unknown>), limits: latestLimits(d.ledger.db, sid) });
      }
    } catch {
      return sendJson(res, 500, { error: 'metrics query failed' });
    }
    sendJson(res, 404, { error: 'not found' });
  }

  function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    const rel = pathname === '/dashboard' || pathname === '/dashboard/' ? 'index.html' : pathname.slice('/dashboard/'.length);
    let file = path.resolve(d.distDir, rel);
    // path confinement: the resolved file must stay within distDir (both sides canonicalized: a route below a
    // folder that does not exist, a symlinked or 8.3-named dist folder, and macOS /var are all inside)
    if (!isWithin(d.distDir, file)) return sendJson(res, 403, { error: 'forbidden' });
    // audit C6: SPA not built — guide a navigation instead of a 404; a missing hashed asset still 404s
    if (!fileExists(path.join(d.distDir, 'index.html')) && (rel === 'index.html' || !path.extname(rel))) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(UNBUILT_PAGE),
        'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': UNBUILT_CSP, 'cache-control': 'no-store',
      });
      res.end(UNBUILT_PAGE);
      return;
    }
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
    // Everything the dashboard needs lives under /dashboard, so the session cookie is scoped there (C2).
    if (p !== '/dashboard' && !p.startsWith('/dashboard/')) return false;

    if (!hostOk(req)) { sendJson(res, 403, { error: 'host not allowed' }); return true; }

    // N2: a cross-site TOP-LEVEL GET navigation to the HTML shell is allowed — the launch page opens the
    // dashboard URL cross-site, and the shell carries nothing secret. Every sensitive route below keeps the
    // strict same-origin / same-site rule; the session cookie is SameSite=Strict, so it is not sent on a
    // cross-site navigation anyway, and the shell's SPA then calls auth and metrics same-origin.
    const navToDocument = req.method === 'GET'
      && req.headers['sec-fetch-mode'] === 'navigate'
      && req.headers['sec-fetch-dest'] === 'document';
    const strict = (): boolean => {
      if (!originOk(req)) { sendJson(res, 403, { error: 'cross-origin requests are not allowed' }); return false; }
      if (!secFetchOk(req)) { sendJson(res, 403, { error: 'cross-site requests are not allowed' }); return false; }
      return true;
    };

    if (p === '/dashboard/register-code') { if (strict()) registerCode(req, res); return true; }
    if (p === '/dashboard/auth') {
      if (!strict()) return true;
      // A client that aborts mid-body rejects the body read; handle it so there is no unhandled rejection.
      auth(req, res).catch(() => { try { if (!res.headersSent && res.writable) sendJson(res, 400, { error: 'bad request' }); } catch { /* socket gone */ } });
      return true;
    }
    if (p === '/dashboard/logout') { if (strict()) logout(req, res); return true; }
    if (p === '/dashboard/metrics' || p.startsWith('/dashboard/metrics/')) { if (strict()) metrics(req, res, url); return true; }
    // static shell / assets: a top-level document navigation may be cross-site (N2); anything else stays strict.
    if (!navToDocument && !strict()) return true;
    serveStatic(req, res, p);
    return true;
  }

  return { handle, mintCode, stop: () => clearInterval(sweeper) };
}

function fileExists(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
