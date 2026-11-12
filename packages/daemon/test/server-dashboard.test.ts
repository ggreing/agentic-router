// The daemon's HTTP server with the dashboard module (decision 132) and the rate limits route (spec 3.8):
// browser rules apply to /dashboard and /dashboard/metrics only; the hook API still refuses any Origin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Ledger, SCHEMA_VERSION } from '../src/ledger.ts';
import { TOKEN, postHook, request, rmrf, rows, startTestDaemon, tmpDir, type TestDaemon } from './helpers.ts';

const LIMITS = {
  five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
  seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
};

async function withDaemon(fn: (d: TestDaemon) => Promise<void>): Promise<void> {
  const d = await startTestDaemon({ now: () => new Date('2026-11-12T12:00:00.000Z') });
  try { await fn(d); } finally { await d.close(); rmrf(d.home); }
}
const json = (token: string | null, body: unknown, extra: Record<string, string> = {}) => ({
  method: 'POST', body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
});

test('the hook API still refuses any Origin, the daemon\'s own included', () => withDaemon(async d => {
  const hook = { session_id: 's', cwd: d.home, transcript_path: path.join(d.home, 's.jsonl'), hook_event_name: 'UserPromptSubmit', prompt: 'hi' };
  assert.equal((await postHook(d.port, hook)).status, 200);
  for (const origin of [`http://127.0.0.1:${d.port}`, `http://localhost:${d.port}`, 'https://evil.example', 'null']) {
    for (const p of ['/router/v1/hooks/claude-code', '/router/v1/limits', '/router/v1/usage', '/router/v1/tools/call']) {
      const r = await request(d.port, { path: p, ...json(TOKEN, hook, { origin }) });
      assert.equal(r.status, 403, `${p} with Origin ${origin}`);
    }
    assert.equal((await request(d.port, { path: '/router/v1/status', headers: { authorization: `Bearer ${TOKEN}`, origin } })).status, 403);
  }
  assert.equal(rows(d, "SELECT COUNT(*) AS c FROM events WHERE type = 'prompt_submit'")[0]!.c, 1, 'no refused hook was recorded');
}));

test('spec 3.8: POST /router/v1/limits stores a session\'s latest rate limits (token required; junk is not stored)', () => withDaemon(async d => {
  const post = (token: string | null, body: unknown) => request(d.port, { path: '/router/v1/limits', ...json(token, body) });
  assert.equal((await post(null, { sessionId: 's1', rateLimits: LIMITS })).status, 401);
  assert.equal((await post('wrong', { sessionId: 's1', rateLimits: LIMITS })).status, 401);
  assert.equal((await post(TOKEN, { rateLimits: LIMITS })).status, 400);
  assert.equal((await post(TOKEN, { sessionId: 'has space', rateLimits: LIMITS })).status, 400);
  assert.deepEqual((await post(TOKEN, { sessionId: 's1', rateLimits: { five_hour: { resets_at: 1 } } })).body, { stored: false });
  assert.deepEqual((await post(TOKEN, { sessionId: 's1', rateLimits: LIMITS, at: '1999-01-01T00:00:00.000Z' })).body, { stored: true });
  assert.deepEqual(rows(d, 'SELECT session_id, five_hour_pct, seven_day_pct, spend_pct, updated_at FROM session_limits'),
    [{ session_id: 's1', five_hour_pct: 23.5, seven_day_pct: 41.2, spend_pct: null, updated_at: '2026-11-12T12:00:00.000Z' }]);   // the daemon's clock
  assert.equal((await request(d.port, { path: '/router/v1/limits', headers: { authorization: `Bearer ${TOKEN}` } })).status, 405);
}));

test('decision 132: the dashboard through the daemon: a one-time code for the Bearer token, then a cookie for the metrics', () => withDaemon(async d => {
  await request(d.port, { path: '/router/v1/limits', ...json(TOKEN, { sessionId: 's1', rateLimits: LIMITS }) });
  assert.equal((await request(d.port, { path: '/dashboard/register-code', method: 'POST' })).status, 401);
  const reg = await request(d.port, { path: '/dashboard/register-code', method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(reg.status, 200);
  const { code, url } = reg.body as { code: string; url: string };
  assert.equal(url, `http://127.0.0.1:${d.port}/dashboard#code=${code}`);
  assert.ok(!url.includes(TOKEN) && !reg.text.includes(TOKEN), 'the token never reaches the page');
  assert.equal((await request(d.port, { path: '/dashboard/metrics/now?session_id=s1' })).status, 401);
  // the page posts the code once (same origin); a second use is refused
  const page = { origin: `http://127.0.0.1:${d.port}`, 'sec-fetch-site': 'same-origin' };
  const auth = await request(d.port, { path: '/dashboard/auth', ...json(null, { code }, page) });
  assert.equal(auth.status, 200);
  const cookie = String(auth.headers['set-cookie']?.[0] ?? '').split(';')[0]!;
  assert.match(cookie, /^ar_dash=/);
  assert.equal((await request(d.port, { path: '/dashboard/auth', ...json(null, { code }, page) })).status, 401);
  const now = await request(d.port, { path: '/dashboard/metrics/now?session_id=s1', headers: { cookie, ...page } });
  assert.equal(now.status, 200, now.text);
  assert.equal((now.body as { limits: { fiveHour: { usedPercentage: number } } }).limits.fiveHour.usedPercentage, 23.5);
  // the metrics refuse another origin even with the cookie; the hook API does not take the cookie
  assert.equal((await request(d.port, { path: '/dashboard/metrics/now', headers: { cookie, origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request(d.port, { path: '/router/v1/status', headers: { cookie } })).status, 401);
}));

test('ledger v11: a v10 ledger gains session_limits', () => {
  const dir = tmpDir('ar-v10-');
  const file = path.join(dir, 'router.db');
  try {
    const l = new Ledger(file);
    l.db.exec('DROP TABLE session_limits; PRAGMA user_version = 10;');
    l.close();
    const again = new Ledger(file);
    assert.equal(Number((again.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version), SCHEMA_VERSION);
    assert.ok(again.db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'session_limits'").get());
    again.close();
  } finally { rmrf(dir); }
});

test('decision 138: POST /router/v1/routing/reset clears the released levels (token required, no body)', async () => {
  const d = await startTestDaemon({ config: { autoRelease: 'on' } });
  try {
    const reset = (o: { token?: string | null; method?: string } = {}) => request(d.port, {
      method: o.method ?? 'POST', path: '/router/v1/routing/reset', headers: o.token === null ? {} : { authorization: `Bearer ${o.token ?? TOKEN}` },
    });
    const released = () => d.router.routing().classes.flatMap(c => c.levels.filter(l => l.released).map(l => `${c.leadClass}:${l.level}`));
    d.ledger.setRelease('opus', { autoDelegateFrom: 'L2' }, '2026-11-12T12:00:00.000Z');
    assert.deepEqual(released(), ['opus:L1']);
    assert.equal((await reset({ token: null })).status, 401);
    assert.equal((await reset({ method: 'GET' })).status, 405);
    assert.equal((await reset({ token: TOKEN, method: 'POST' })).status, 200);
    assert.deepEqual(released(), []);
    assert.deepEqual((await reset()).body, { cleared: 0 });
  } finally { await d.close(); rmrf(d.home); }
});
