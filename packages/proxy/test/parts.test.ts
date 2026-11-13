// Settings, spool replay to the daemon, budget caps, local tokens, the helper scripts and the log mask.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Budget } from '../src/budget.ts';
import { canonicalPath, classifyRoute } from '../src/server.ts';
import { ConfigError, DEFAULT_DAILY_CAP_USD, DEFAULT_TOKEN_DAILY_CAP_USD, TEST_UPSTREAM_ENV, checkTlsEnv, loadSettings } from '../src/config.ts';
import { Masker } from '../src/log.ts';
import { proxyPaths } from '../src/paths.ts';
import { LocalTokens, writeRotationMeta, writeTokenFile } from '../src/token.ts';
import { sealedFake, type WireRecord } from '../../core/test/sealed-fake.ts';
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

test('usage rows go to the spool while the daemon has no route (404) or is down, and are sent once it answers, sealed (decision 156)', async () => {
  const up = new FakeUpstream();
  const upPort = await up.start();
  let daemonStatus = 404;
  const got: unknown[] = [];
  const wire: WireRecord[] = [];
  const daemon = http.createServer(sealedFake('daemon-token', r => {
    if (daemonStatus === 200) got.push(...(JSON.parse(r.body ?? '{}') as { rows: unknown[] }).rows);
    return { status: daemonStatus, body: '{}' };
  }, wire));
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
    // the token never travels and the rows are not readable on the wire
    assert.ok(wire.length >= 3);
    for (const w of wire) {
      assert.equal(w.headers.authorization, undefined);
      assert.ok(!JSON.stringify(w).includes('daemon-token') && !w.body.includes('m-1'), 'sealed');
    }
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

/** The helper as Claude Code runs it (asynchronously, so the proxy in this process can answer its check). */
function runHelper(home: string, extra: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const { ANTHROPIC_BASE_URL: _b, AGENTIC_ROUTER_HELPER_PROBE: _p, ...inherited } = process.env;
  return new Promise(resolve => {
    execFile(process.execPath, [path.join(BIN, 'local-token.mjs')], { env: { ...inherited, AGENTIC_ROUTER_HOME: home, ...extra }, encoding: 'utf8', timeout: 20_000 },
      (err, stdout, stderr) => resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null) : 0, stdout, stderr }));
  });
}

test('decision 156: bin/local-token.mjs prints the token only after the proxy on the port proves itself; to anything else, nothing', async () => {
  const up = new FakeUpstream();
  const t = await startProxy(await up.start());
  const writeCfg = (port: number) => fs.writeFileSync(t.paths.config, JSON.stringify({ proxyPort: port }));
  const squat: Array<{ url?: string; auth?: string; body: string }> = [];
  const squatter = http.createServer((req, res) => {
    let b = '';
    req.on('data', c => { b += String(c); });
    req.on('end', () => { squat.push({ url: req.url, auth: req.headers.authorization, body: b }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"proof":"made-up"}'); });
  });
  await new Promise<void>(r => squatter.listen(0, '127.0.0.1', () => r()));
  try {
    writeCfg(t.port);
    const ok = await runHelper(t.home);
    assert.deepEqual([ok.code, ok.stdout], [0, LOCAL_TOKEN], ok.stderr);
    // a program on the port that cannot prove it holds the token: nothing printed, and it was never sent the token
    writeCfg((squatter.address() as { port: number }).port);
    const bad = await runHelper(t.home);
    assert.deepEqual([bad.code, bad.stdout], [1, '']);
    assert.match(bad.stderr, /is not this router's proxy, or the proxy is not running: no token given out/);
    assert.equal(squat.length, 1);
    assert.equal(squat[0]!.url, '/proxy/v1/proof');
    assert.ok(!squat[0]!.body.includes(LOCAL_TOKEN) && squat[0]!.auth === undefined);
    // the proxy down, and no token file
    await new Promise<void>(r => squatter.close(() => r()));
    assert.deepEqual([(await runHelper(t.home)).code, (await runHelper(t.home)).stdout], [1, '']);
    writeCfg(t.port);
    fs.rmSync(t.paths.proxyToken);
    const none = await runHelper(t.home);
    assert.deepEqual([none.code, none.stdout], [1, '']);
  } finally { squatter.close(); await t.close(); await up.close(); }
});

test('decision 156: the helper\'s copy of the proof is the proxy\'s; a proof binds the port and the nonce', async () => {
  const helper = await import(pathToFileURL(path.join(BIN, 'local-token.mjs')).href) as { proofOf(t: string, p: number, n: string): string; PROOF_PATH: string };
  const { proofOf, proofMatches, PROOF_PATH } = await import('../src/proof.ts');
  assert.equal(helper.PROOF_PATH, PROOF_PATH);
  const nonce = 'n'.repeat(43);
  assert.equal(helper.proofOf(LOCAL_TOKEN, 4711, nonce), proofOf(LOCAL_TOKEN, 4711, nonce));
  assert.ok(proofMatches(LOCAL_TOKEN, 4711, nonce, proofOf(LOCAL_TOKEN, 4711, nonce)));
  assert.ok(!proofMatches(LOCAL_TOKEN, 4712, nonce, proofOf(LOCAL_TOKEN, 4711, nonce)), 'another port');
  assert.ok(!proofMatches(LOCAL_TOKEN, 4711, 'm'.repeat(43), proofOf(LOCAL_TOKEN, 4711, nonce)), 'another nonce');
  assert.ok(!proofMatches('other-token-0123456789abcdefghijklmn', 4711, nonce, proofOf(LOCAL_TOKEN, 4711, nonce)), 'another token');
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

test('review M1: the helper gives the token only to a session whose ANTHROPIC_BASE_URL is the proxy as configured now', async () => {
  const up = new FakeUpstream();
  const t = await startProxy(await up.start());
  fs.writeFileSync(t.paths.config, JSON.stringify({ proxyPort: t.port }));
  const probe = path.join(t.home, 'helper-probe.jsonl');
  try {
    for (const base of [`http://127.0.0.1:${t.port}`, `http://127.0.0.1:${t.port}/`]) {
      const ok = await runHelper(t.home, { ANTHROPIC_BASE_URL: base, AGENTIC_ROUTER_HELPER_PROBE: '1' });
      assert.deepEqual([ok.code, ok.stdout], [0, LOCAL_TOKEN], `${base}: ${ok.stderr}`);
    }
    // review R2: localhost is refused too (the proof is made to 127.0.0.1; localhost may resolve to ::1)
    for (const base of [`http://localhost:${t.port}`, `http://127.0.0.1:${t.port + 1}`, `https://127.0.0.1:${t.port}`, 'https://gateway.example', 'not a url']) {
      const bad = await runHelper(t.home, { ANTHROPIC_BASE_URL: base, AGENTIC_ROUTER_HELPER_PROBE: '1' });
      assert.deepEqual([bad.code, bad.stdout], [1, ''], base);
      assert.match(bad.stderr, /restart Claude Code; if it was just started, run agentic-router mode api .*\(no token given out\)/);
    }
    // not set (a helper run by hand): the proof alone decides
    assert.equal((await runHelper(t.home)).stdout, LOCAL_TOKEN);
    // the probe says whether the variable was there, never its value
    const lines = fs.readFileSync(probe, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { baseUrl: string; matches: boolean | null });
    assert.deepEqual(lines.map(l => [l.baseUrl, l.matches]), [['set', true], ['set', true], ['set', false], ['set', false], ['set', false], ['set', false], ['set', false]]);
    assert.ok(!fs.readFileSync(probe, 'utf8').includes(String(t.port)), 'no value written');
    // review R1: no path is taken from the environment, and a link in the probe's place is not followed
    const elsewhere = path.join(t.home, 'elsewhere.txt');
    await runHelper(t.home, { AGENTIC_ROUTER_HELPER_PROBE: elsewhere });
    assert.ok(!fs.existsSync(elsewhere), 'a path value is not a probe switch');
    if (process.platform !== 'win32') {
      fs.rmSync(probe);
      const target = path.join(t.home, 'profile-stand-in');
      fs.writeFileSync(target, 'keep\n');
      fs.symlinkSync(target, probe);
      await runHelper(t.home, { AGENTIC_ROUTER_HELPER_PROBE: '1' });
      assert.equal(fs.readFileSync(target, 'utf8'), 'keep\n', 'nothing appended through the link');
    }
  } finally { await t.close(); await up.close(); }
});
