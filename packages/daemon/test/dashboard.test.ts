import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger } from '../src/ledger.ts';
import { createDashboard } from '../src/dashboard.ts';
import { applyLimitsSchema, recordLimits } from '../src/limits.ts';

const TOKEN = 'dash-token-0123456789abcdef';

function tmpDist(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-dist-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Agentic Router</title><div id=app></div>');
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'index-abcd1234.js'), 'console.log(1)');
  return dir;
}

function seed(l: Ledger): void {
  const closedAt = new Date(Date.UTC(2026, 10, 10, 9, 0, 0)).toISOString();
  l.upsertRecord({
    requestId: 'req-1', sessionId: 's', createdAt: closedAt, closedAt, kind: 'team', level: 'L2', finalLevel: 'L2',
    outcome: 'delegated', changedFiles: 1, linesAdded: 1, linesRemoved: 0, durationMs: 1000, activeMs: 900,
    subtaskUsd: 0.01, leadUsd: 0.1, totalUsd: 0.11,
    record: { triage: { level: 'L2', rule: 'r' }, plan: { leadClass: 'opus' }, outcome: 'delegated', subtasks: [{ id: 'A', role: 'coder', slot: 0, step: 's1', upCount: 0, status: 'passed', verdict: 'meet', attempts: 1, costUsd: 0.01 }], costs: { subtaskUsd: 0.01, leadUsd: 0.1, totalUsd: 0.11 } },
    prompt: null,
  });
}

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }
function rq(port: number, method: string, pathname: string, opts: { headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: opts.headers }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

interface Opts { now?: () => number; idleTtlMs?: number; cookieTtlMs?: number }
async function withServer(fn: (ctx: { port: number; dash: ReturnType<typeof createDashboard>; ledger: Ledger }) => Promise<void>, opts: Opts = {}): Promise<void> {
  const ledger = new Ledger(':memory:');
  seed(ledger);
  applyLimitsSchema(ledger.db);   // A folds this into the ledger migration; here we create it directly
  recordLimits(ledger.db, { sessionId: 's', rateLimits: { five_hour: { used_percentage: 23.5, resets_at: 1738425600 }, seven_day: { used_percentage: 41.2, resets_at: 1738857600 } }, at: '2026-11-12T10:00:00.000Z' });
  const distDir = tmpDist();
  let addr: () => number = () => 0;
  const dash = createDashboard({ ledger, token: TOKEN, distDir, port: () => addr(), statusView: () => ({ request: { id: 'req-1', level: 'L2' }, roles: [], costUsd: 0.11, costEstimated: false, costUnknown: false, sessionCostUsd: 0.11 }), now: opts.now, idleTtlMs: opts.idleTtlMs, cookieTtlMs: opts.cookieTtlMs });
  const server = http.createServer((req, res) => { if (!dash.handle(req, res)) { res.writeHead(404); res.end('{}'); } });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  addr = () => port;
  try { await fn({ port, dash, ledger }); }
  finally { dash.stop(); await new Promise<void>(r => server.close(() => r())); ledger.close(); fs.rmSync(distDir, { recursive: true, force: true }); }
}

const host = (p: number) => ({ host: `127.0.0.1:${p}` });

test('register-code needs the Bearer token and returns a one-time code + #code url', async () => {
  await withServer(async ({ port }) => {
    const no = await rq(port, 'POST', '/dashboard/register-code', { headers: host(port) });
    assert.equal(no.status, 401);
    const ok = await rq(port, 'POST', '/dashboard/register-code', { headers: { ...host(port), authorization: `Bearer ${TOKEN}` } });
    assert.equal(ok.status, 200);
    const body = JSON.parse(ok.body) as { code: string; url: string };
    assert.ok(body.code.length > 10);
    assert.ok(body.url.includes(`#code=${body.code}`));
    assert.ok(body.url.startsWith(`http://127.0.0.1:${port}/dashboard`));
  });
});

test('one-time code -> HttpOnly SameSite=Strict cookie -> metrics; cookie required; code is single-use', async () => {
  await withServer(async ({ port, dash }) => {
    const code = dash.mintCode();
    const auth = await rq(port, 'POST', '/dashboard/auth', { headers: { ...host(port), 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    assert.equal(auth.status, 200);
    const setCookie = String(auth.headers['set-cookie']);
    assert.match(setCookie, /ar_dash=/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Path=\/dashboard(?:;|$)/);     // C2: scoped so other local servers never see it
    const cookie = setCookie.split(';')[0]!;

    const noCookie = await rq(port, 'GET', '/dashboard/metrics/summary', { headers: host(port) });
    assert.equal(noCookie.status, 401);

    const withCookie = await rq(port, 'GET', '/dashboard/metrics/summary', { headers: { ...host(port), cookie } });
    assert.equal(withCookie.status, 200);
    assert.equal((JSON.parse(withCookie.body) as { total: number }).total, 1);

    const reuse = await rq(port, 'POST', '/dashboard/auth', { headers: { ...host(port), 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    assert.equal(reuse.status, 401, 'the code is single-use');
  });
});

test('every metrics sub-endpoint responds with a session cookie', async () => {
  await withServer(async ({ port, dash }) => {
    const code = dash.mintCode();
    const auth = await rq(port, 'POST', '/dashboard/auth', { headers: { ...host(port), 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    const cookie = String(auth.headers['set-cookie']).split(';')[0]!;
    const h = { ...host(port), cookie };
    for (const [p, check] of [
      ['/dashboard/metrics/summary', (b: Record<string, unknown>) => { assert.equal(b.total, 1); assert.equal((b.limits as { fiveHour: { usedPercentage: number } }).fiveHour.usedPercentage, 23.5); }],
      ['/dashboard/metrics/requests?limit=5', (b: Record<string, unknown>) => assert.equal((b.rows as unknown[]).length, 1)],
      ['/dashboard/metrics/requests/req-1', (b: Record<string, unknown>) => assert.equal(b.requestId, 'req-1')],
      ['/dashboard/metrics/triage-report', (b: Record<string, unknown>) => assert.ok(b.overall)],
      ['/dashboard/metrics/now', (b: Record<string, unknown>) => { assert.ok(b.request); assert.ok((b.limits as { sevenDay: unknown }).sevenDay); }],
    ] as Array<[string, (b: Record<string, unknown>) => void]>) {
      const r = await rq(port, 'GET', p, { headers: h });
      assert.equal(r.status, 200, p);
      check(JSON.parse(r.body) as Record<string, unknown>);
    }
    const missing = await rq(port, 'GET', '/dashboard/metrics/requests/nope', { headers: h });
    assert.equal(missing.status, 404);
  });
});

test('a foreign Origin and a bad Host are refused (CSRF / DNS-rebinding defence)', async () => {
  await withServer(async ({ port, dash }) => {
    const code = dash.mintCode();
    const auth = await rq(port, 'POST', '/dashboard/auth', { headers: { ...host(port), 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    const cookie = String(auth.headers['set-cookie']).split(';')[0]!;
    const evil = await rq(port, 'GET', '/dashboard/metrics/summary', { headers: { ...host(port), cookie, origin: 'http://evil.example' } });
    assert.equal(evil.status, 403);
    const sameOrigin = await rq(port, 'GET', '/dashboard/metrics/summary', { headers: { ...host(port), cookie, origin: `http://127.0.0.1:${port}` } });
    assert.equal(sameOrigin.status, 200);
    const badHost = await rq(port, 'GET', '/dashboard', { headers: { host: 'evil.example' } });
    assert.equal(badHost.status, 403);
  });
});

test('static SPA is served unauthenticated with CSP and nosniff; assets 404 but routes fall back to index', async () => {
  await withServer(async ({ port }) => {
    const index = await rq(port, 'GET', '/dashboard', { headers: host(port) });
    assert.equal(index.status, 200);
    assert.match(String(index.headers['content-type']), /text\/html/);
    assert.match(String(index.headers['content-security-policy']), /default-src 'self'/);
    assert.equal(index.headers['x-content-type-options'], 'nosniff');
    const js = await rq(port, 'GET', '/dashboard/assets/index-abcd1234.js', { headers: host(port) });
    assert.equal(js.status, 200);
    assert.match(String(js.headers['content-type']), /javascript/);
    const missingAsset = await rq(port, 'GET', '/dashboard/assets/missing.js', { headers: host(port) });
    assert.equal(missingAsset.status, 404, 'a missing asset is not masked by index.html');
    const route = await rq(port, 'GET', '/dashboard/some/spa/route', { headers: host(port) });
    assert.equal(route.status, 200, 'an extensionless route falls back to the SPA shell');
    assert.match(String(route.headers['content-type']), /text\/html/);
  });
});

test('when the SPA is not built, /dashboard serves the build-instructions page (not a 404); a missing asset still 404s (C6)', async () => {
  const ledger = new Ledger(':memory:');
  const emptyDist = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-nodist-'));   // no index.html: the SPA was never built
  let addr: () => number = () => 0;
  const dash = createDashboard({ ledger, token: TOKEN, distDir: emptyDist, port: () => addr() });
  const server = http.createServer((req, res) => { if (!dash.handle(req, res)) { res.writeHead(404); res.end('{}'); } });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  addr = () => port;
  try {
    const index = await rq(port, 'GET', '/dashboard', { headers: host(port) });
    assert.equal(index.status, 200, 'the shell gets the instructions page, not a 404');
    assert.match(String(index.headers['content-type']), /text\/html/);
    assert.match(index.body, /npm run build:dashboard/);
    const route = await rq(port, 'GET', '/dashboard/some/route', { headers: host(port) });
    assert.equal(route.status, 200, 'an SPA route also gets the instructions page');
    assert.match(route.body, /not built/i);
    const asset = await rq(port, 'GET', '/dashboard/assets/app.js', { headers: host(port) });
    assert.equal(asset.status, 404, 'a missing hashed asset is still a 404, not the HTML page');
  } finally {
    dash.stop(); await new Promise<void>(r => server.close(() => r())); ledger.close(); fs.rmSync(emptyDist, { recursive: true, force: true });
  }
});

test('handle returns false for non-dashboard paths so server.ts keeps its own routing', async () => {
  await withServer(async ({ port }) => {
    const other = await rq(port, 'GET', '/router/v1/status', { headers: host(port) });
    assert.equal(other.status, 404);   // our test server returns 404 when handle() declines
    assert.equal(other.body, '{}');
  });
});

async function login(port: number, dash: ReturnType<typeof createDashboard>): Promise<string> {
  const code = dash.mintCode();
  const auth = await rq(port, 'POST', '/dashboard/auth', { headers: { ...host(port), 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  return String(auth.headers['set-cookie']).split(';')[0]!;
}
const summary = (port: number, cookie: string) => rq(port, 'GET', '/dashboard/metrics/summary', { headers: { ...host(port), cookie } });

test('session idle timeout: an unused session expires (C2)', async () => {
  let clock = 1_000_000;
  await withServer(async ({ port, dash }) => {
    const cookie = await login(port, dash);
    clock += 10 * 60 * 1000; assert.equal((await summary(port, cookie)).status, 200);   // within the 15m idle window
    clock += 20 * 60 * 1000; assert.equal((await summary(port, cookie)).status, 401);   // idle past 15m -> expired
  }, { now: () => clock, idleTtlMs: 15 * 60 * 1000, cookieTtlMs: 60 * 60 * 1000 });
});

test('absolute lifetime caps even a continuously active session (C2)', async () => {
  let clock = 2_000_000;
  await withServer(async ({ port, dash }) => {
    const cookie = await login(port, dash);
    for (let i = 0; i < 5; i++) { clock += 10 * 60 * 1000; await summary(port, cookie); }   // active, never idle
    clock += 10 * 60 * 1000;                                                                  // now past the 1h absolute cap
    assert.equal((await summary(port, cookie)).status, 401);
  }, { now: () => clock, idleTtlMs: 30 * 60 * 1000, cookieTtlMs: 60 * 60 * 1000 });
});

test('logout revokes the session and clears the cookie (C2)', async () => {
  await withServer(async ({ port, dash }) => {
    const cookie = await login(port, dash);
    assert.equal((await summary(port, cookie)).status, 200);
    const out = await rq(port, 'POST', '/dashboard/logout', { headers: { ...host(port), cookie } });
    assert.equal(out.status, 200);
    assert.match(String(out.headers['set-cookie']), /Max-Age=0/);
    assert.equal((await summary(port, cookie)).status, 401);
  });
});

test('bad metrics input is a 400, not a 500 (D)', async () => {
  await withServer(async ({ port, dash }) => {
    const cookie = await login(port, dash);
    assert.equal((await rq(port, 'GET', '/dashboard/metrics/requests?limit=abc', { headers: { ...host(port), cookie } })).status, 400);
    assert.equal((await rq(port, 'GET', '/dashboard/metrics/requests/%zz', { headers: { ...host(port), cookie } })).status, 400);
  });
});
