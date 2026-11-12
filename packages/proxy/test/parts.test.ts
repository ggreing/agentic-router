// Settings, spool replay to the daemon, budget caps, local tokens, the helper scripts and the log mask.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Budget } from '../src/budget.ts';
import { canonicalPath, classifyRoute } from '../src/server.ts';
import { ConfigError, DEFAULT_DAILY_CAP_USD, DEFAULT_TOKEN_DAILY_CAP_USD, TEST_UPSTREAM_ENV, checkTlsEnv, loadSettings } from '../src/config.ts';
import { Masker } from '../src/log.ts';
import { proxyPaths } from '../src/paths.ts';
import { LocalTokens, writeRotationMeta, writeTokenFile } from '../src/token.ts';
import { FakeUpstream, LOCAL_TOKEN, SSE_HEADERS, auth, call, messageStream, rmrf, sleep, spooled, startProxy, tmpHome } from './helpers.ts';

const BIN = fileURLToPath(new URL('../bin/', import.meta.url));

test('C3: rotation grace is measured from rotation time; --no-grace drops the previous token', () => {
  const home = tmpHome();
  try {
    const file = path.join(home, 'proxy-token');
    const A = 'A'.repeat(40), B = 'B'.repeat(40), C = 'C'.repeat(40);
    let clock = 1_000_000;
    writeTokenFile(file, A);
    let mt = 1000;
    const bump = () => { fs.utimesSync(file, mt, mt); mt += 1000; };   // force a distinct mtime so #reload notices
    bump();
    const t = new LocalTokens(file, { now: () => clock, graceMs: 10 * 60 * 1000 });
    // external rotation (what the CLI does) at t0; the proxy only reads 9 minutes later
    const t0 = 2_000_000;
    writeRotationMeta(file, t0, true); writeTokenFile(file, B); bump();
    clock = t0 + 9 * 60 * 1000;
    assert.equal(t.accept(B)!.which, 'current');
    assert.equal(t.accept(A)!.which, 'previous', 'old token valid until 10 min AFTER rotation, not after first read');
    clock = t0 + 11 * 60 * 1000;
    assert.equal(t.accept(A), null, 'old token rejected once the window (from rotation) passes');
    // --no-grace: the previous token is invalid immediately
    const t1 = 4_000_000; clock = t1;
    writeRotationMeta(file, t1, false); writeTokenFile(file, C); bump();
    assert.equal(t.accept(C)!.which, 'current');
    assert.equal(t.accept(B), null, 'no-grace rotation leaves no previous token');
  } finally { rmrf(home); }
});

test('settings: defaults (decision 131 caps), port required, bad caps reported, TLS off refused', () => {
  const home = tmpHome();
  try {
    const p = proxyPaths(home);
    assert.throws(() => loadSettings(p.config), /proxyPort/);
    fs.writeFileSync(p.config, JSON.stringify({ proxyPort: 47811, daemonPort: 47800 }));
    const s = loadSettings(p.config);
    assert.deepEqual([s.port, s.upstream.origin, s.testUpstream, s.tokenDailyCapUsd, s.dailyCapUsd, s.daemonPort],
      [47811, 'https://api.anthropic.com', false, DEFAULT_TOKEN_DAILY_CAP_USD, DEFAULT_DAILY_CAP_USD, 47800]);
    assert.deepEqual([DEFAULT_TOKEN_DAILY_CAP_USD, DEFAULT_DAILY_CAP_USD], [100, 300]);
    fs.writeFileSync(p.config, JSON.stringify({ proxyPort: 47811, proxy: { tokenDailyCapUsd: -1, dailyCapUsd: 50, upstream: 'https://evil.example' } }));
    assert.throws(() => loadSettings(p.config), ConfigError);
    fs.writeFileSync(p.config, JSON.stringify({ proxyPort: 47811, proxy: { tokenDailyCapUsd: -1, dailyCapUsd: 50 } }));
    const w: string[] = [];
    const s2 = loadSettings(p.config, w);
    assert.deepEqual([s2.tokenDailyCapUsd, s2.dailyCapUsd], [100, 50]);
    assert.match(w[0]!, /tokenDailyCapUsd ignored/);
    // B1: a test-upstream environment switch is ignored by the production loader
    process.env[TEST_UPSTREAM_ENV] = 'http://127.0.0.1:9';
    try { assert.equal(loadSettings(p.config).testUpstream, false, 'B1: env test-upstream switch ignored'); }
    finally { delete process.env[TEST_UPSTREAM_ENV]; }
    assert.throws(() => checkTlsEnv({ NODE_TLS_REJECT_UNAUTHORIZED: '0' }), /TLS verification/);
    checkTlsEnv({});
  } finally { rmrf(home); }
});

test('usage rows go to the spool while the daemon has no route (404) or is down, and are sent once it answers', async () => {
  const up = new FakeUpstream();
  const upPort = await up.start();
  let daemonStatus = 404;
  const got: unknown[] = [];
  const daemon = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      assert.equal(req.headers.authorization, 'Bearer daemon-token');
      if (daemonStatus === 200) got.push(...(JSON.parse(Buffer.concat(chunks).toString()) as { rows: unknown[] }).rows);
      res.writeHead(daemonStatus); res.end();
    });
  });
  await new Promise<void>(r => daemon.listen(0, '127.0.0.1', () => r()));
  const dport = (daemon.address() as { port: number }).port;
  const t = await startProxy(upPort, { daemon: () => ({ port: dport, token: 'daemon-token' }) });
  try {
    up.script.push({ status: 200, headers: SSE_HEADERS, steps: messageStream({ id: 'm-1' }) }, { status: 200, headers: SSE_HEADERS, steps: messageStream({ id: 'm-2' }) });
    await call(t.port, { headers: auth(), body: '{}' });
    await call(t.port, { headers: auth(), body: '{}' });
    for (let i = 0; i < 50 && spooled(t.paths).length < 2; i++) { await t.proxy.reporter.flush(); await sleep(20); }
    assert.deepEqual(spooled(t.paths).map(r => r.messageId), ['m-1', 'm-2']);
    daemonStatus = 200;
    assert.equal(await t.proxy.reporter.replay(), 2);
    assert.deepEqual((got as Array<{ messageId: string }>).map(r => r.messageId), ['m-1', 'm-2']);
    assert.deepEqual(spooled(t.paths), []);
    // a row sent live
    up.script.push({ status: 200, headers: SSE_HEADERS, steps: messageStream({ id: 'm-3' }) });
    await call(t.port, { headers: auth(), body: '{}' });
    for (let i = 0; i < 50 && got.length < 3; i++) { await t.proxy.reporter.flush(); await sleep(20); }
    assert.equal(got.length, 3);
  } finally { await t.close(); await up.close(); daemon.close(); }
});

test('budget: per-token and global daily caps, a request budget, fail open without the daemon, the cached answer is kept', async () => {
  const home = tmpHome();
  let answer: { requestId: string; budgetUsd: number; spentUsd: number } | undefined = { requestId: 'r', budgetUsd: 1, spentUsd: 0.5 };
  let day = new Date(2026, 10, 12, 10);
  const b = new Budget({ dbFile: path.join(home, 'p.db'), tokenDailyCapUsd: 2, dailyCapUsd: 3, source: async () => answer, now: () => day });
  try {
    type R = { block: { kind: string } } | { reservationId: string };
    const kind = (r: R) => ('block' in r ? r.block.kind : null);
    const ok = (r: R) => 'reservationId' in r;
    // reserveUsd 0 keeps these checks side-effect free so they stay pure cap probes; add() seeds the totals.
    const a = { tokenId: 't1', sessionId: 's', promptId: 'p', reserveUsd: 0 };
    assert.ok(ok(await b.check(a)));
    b.add({ tokenId: 't1', sessionId: 's', promptId: 'p', usd: 0.6 });           // 0.5 + 0.6 over the request's 1.0
    assert.equal(kind(await b.check(a)), 'request');
    answer = undefined;                                                          // daemon stops answering: last answer kept
    day = new Date(day.getTime() + 3000);
    assert.equal(kind(await b.check(a)), 'request');
    assert.ok(ok(await b.check({ ...a, promptId: 'other' })));                   // unknown prompt: fail open
    b.add({ tokenId: 't1', sessionId: null, promptId: null, usd: 1.5 });
    assert.equal(kind(await b.check({ tokenId: 't1', sessionId: null, promptId: null, reserveUsd: 0 })), 'token_daily');
    assert.ok(ok(await b.check({ tokenId: 't2', sessionId: null, promptId: null, reserveUsd: 0 })));
    b.add({ tokenId: 't2', sessionId: null, promptId: null, usd: 1 });
    assert.equal(kind(await b.check({ tokenId: 't3', sessionId: null, promptId: null, reserveUsd: 0 })), 'daily');
    day = new Date(2026, 10, 13, 0, 1);                                          // next local day
    assert.ok(ok(await b.check({ tokenId: 't1', sessionId: null, promptId: null, reserveUsd: 0 })));
  } finally { b.close(); rmrf(home); }
});

test('A6: the route allowlist accepts only the three canonical endpoints, refusing // and trailing-slash variants', () => {
  // canonicalisation
  assert.equal(canonicalPath('/v1//messages'), '/v1/messages');
  assert.equal(canonicalPath('/v1/messages/'), '/v1/messages');
  assert.equal(canonicalPath('//v1/messages//'), '/v1/messages');
  assert.equal(canonicalPath('/'), '/');
  // allowed
  assert.equal(classifyRoute('POST', canonicalPath('/v1/messages')), 'messages');
  assert.equal(classifyRoute('POST', canonicalPath('/v1/messages/')), 'messages');       // trailing slash folds in
  assert.equal(classifyRoute('POST', canonicalPath('/v1//messages')), 'messages');        // doubled slash folds in
  assert.equal(classifyRoute('POST', canonicalPath('/v1/messages/count_tokens')), 'count_tokens');
  assert.equal(classifyRoute('GET', canonicalPath('/v1/models')), 'models');
  assert.equal(classifyRoute('GET', canonicalPath('/v1/models/claude-opus-4-8')), 'models');
  // refused
  assert.equal(classifyRoute('POST', canonicalPath('/v1/messages/batches')), null);
  assert.equal(classifyRoute('GET', canonicalPath('/v1/messages')), null);                // wrong method
  assert.equal(classifyRoute('POST', canonicalPath('/v1/models')), null);                 // wrong method
  assert.equal(classifyRoute('DELETE', canonicalPath('/v1/messages/batches/x')), null);
  assert.equal(classifyRoute('POST', canonicalPath('/v1/complete')), null);
  assert.equal(classifyRoute('POST', canonicalPath('/v1/organizations/usage')), null);
});

test('A6: a concurrent burst cannot pass the daily cap (reserve at check, settle after)', async () => {
  const home = tmpHome();
  const day = new Date(2026, 10, 12, 10);
  const b = new Budget({ dbFile: path.join(home, 'p.db'), tokenDailyCapUsd: 1, dailyCapUsd: 100, source: async () => undefined, now: () => day });
  try {
    const a = { tokenId: 't', sessionId: null, promptId: null, reserveUsd: 0.5 };
    const results = await Promise.all(Array.from({ length: 200 }, () => b.check(a)));
    const passed = results.filter(r => 'reservationId' in r);
    assert.ok(passed.length >= 1 && passed.length <= 3, `$1 cap with a $0.50 reserve should pass ~2, got ${passed.length}`);
    // settle the ones that passed to a tiny actual: the cap frees up for the next request
    for (const r of results) if ('reservationId' in r) b.settle(r.reservationId, 0.01);
    assert.ok('reservationId' in (await b.check(a)), 'budget frees up once the reservations settle low');
  } finally { b.close(); rmrf(home); }
});

test('local tokens: a changed file is picked up, the old token stays valid for the grace window only', () => {
  const home = tmpHome();
  try {
    const file = path.join(home, 'proxy-token');
    writeTokenFile(file, LOCAL_TOKEN);
    let now = 0;
    const seen: string[] = [];
    const t = new LocalTokens(file, { graceMs: 1000, now: () => now, onChange: (a, r) => seen.push(a ? `+${a}` : `-${r}`) });
    assert.equal(t.accept(LOCAL_TOKEN)?.which, 'current');
    assert.equal(t.accept('x'.repeat(40)), null);
    const next = 'next-token-0123456789abcdefghijklmnopqrstuv';
    fs.writeFileSync(file, next);
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));                // a clearly newer mtime
    assert.equal(t.accept(next)?.which, 'current');
    assert.equal(t.accept(LOCAL_TOKEN)?.which, 'previous');
    now = 1001;
    assert.equal(t.accept(LOCAL_TOKEN), null);
    assert.deepEqual(seen, [`+${LOCAL_TOKEN}`, `+${next}`, `-${LOCAL_TOKEN}`]);
    assert.throws(() => new LocalTokens(path.join(home, 'missing')), /not found/);
    fs.writeFileSync(path.join(home, 'short'), 'abc');
    assert.throws(() => new LocalTokens(path.join(home, 'short')), /too short/);
  } finally { rmrf(home); }
});

test('bin/local-token.mjs prints the token only; without one it fails', () => {
  const home = tmpHome();
  try {
    writeTokenFile(path.join(home, 'proxy-token'), LOCAL_TOKEN);
    const ok = spawnSync(process.execPath, [path.join(BIN, 'local-token.mjs')], { env: { ...process.env, AGENTIC_ROUTER_HOME: home }, encoding: 'utf8' });
    assert.deepEqual([ok.status, ok.stdout], [0, LOCAL_TOKEN]);
    fs.rmSync(path.join(home, 'proxy-token'));
    const bad = spawnSync(process.execPath, [path.join(BIN, 'local-token.mjs')], { env: { ...process.env, AGENTIC_ROUTER_HOME: home }, encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.equal(bad.stdout, '');
  } finally { rmrf(home); }
});

test('the log mask hides the key, the tokens and key-shaped values', () => {
  const m = new Masker();
  m.add('super-secret-value-123');
  assert.equal(m.mask('a super-secret-value-123 b sk-ant-api03-abcdefghijkl c Bearer abcdefghijklmnop'), 'a [REDACTED] b [REDACTED] c Bearer [REDACTED]');
  m.remove('super-secret-value-123');
  assert.equal(m.mask('super-secret-value-123'), 'super-secret-value-123');
});

test('the proxy stops cleanly: an in-flight stream finishes, then rows are flushed', async () => {
  const up = new FakeUpstream();
  const t = await startProxy(await up.start());
  try {
    const ev = messageStream({ id: 'm-drain' });
    up.script.push({ status: 200, headers: SSE_HEADERS, steps: [ev[0]!, { wait: 200 }, ...ev.slice(1)] });
    const pending = call(t.port, { headers: auth(), body: '{}' });
    await sleep(50);
    const closing = t.proxy.close();
    const r = await pending;
    await closing;
    assert.equal(r.status, 200);
    assert.match(r.body.toString(), /message_stop/);
    assert.deepEqual(spooled(t.paths).map(x => x.messageId), ['m-drain']);
  } finally { rmrf(t.home); await up.close(); }
});
