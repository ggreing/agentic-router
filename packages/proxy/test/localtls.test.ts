// Decisions 156-157 on the proxy side: it serves HTTPS with the router's local certificate (a plain-HTTP request to
// that port gets nothing), proves itself to the helper over it, takes a renewed certificate without a restart, and a
// token from before a restart gets 401. Also the published fast-mode and Fable 5.2 prices (core pricing). Loopback
// only; certificates are made at run time (test/tls.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { costUsd } from '@agentic-router/core/pricing';
import { proveProxy } from '../src/proof.ts';
import { reservationFor, requestShape } from '../src/reserve.ts';
import { createProxy } from '../src/server.ts';
import { checkUpstream } from '../src/config.ts';
import { UsageTap } from '../src/tap.ts';
import { LocalTokens } from '../src/token.ts';
import { nullLogger } from '../src/log.ts';
import { FakeUpstream, LOCAL_TOKEN, SSE_HEADERS, TEST_KEY, auth, messageStream, sleep, startProxy } from './helpers.ts';
import { selfSignedCert } from './tls.ts';

const body = JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });

function tlsFiles(dir: string, cn = 'agentic-router local proxy') {
  const c = selfSignedCert(cn, ['localhost'], ['127.0.0.1']);
  fs.mkdirSync(dir, { recursive: true });
  const certFile = path.join(dir, 'proxy-cert.pem');
  const keyFile = path.join(dir, 'proxy-key.pem');
  fs.writeFileSync(certFile, c.cert);
  fs.writeFileSync(keyFile, c.key);
  return { certFile, keyFile, cert: c.cert };
}

/** One request to the proxy over HTTPS (trusting `ca`) or plain HTTP; 'error:<code>' when it fails. */
function req(port: number, o: { ca?: string; plain?: boolean; path?: string; method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string } | string> {
  return new Promise(resolve => {
    const lib = o.plain ? http : https;
    const r = lib.request({
      host: '127.0.0.1', port, method: o.method ?? 'POST', path: o.path ?? '/v1/messages', agent: false, timeout: 5000,
      headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', ...(o.body ? { 'content-length': String(Buffer.byteLength(o.body)) } : {}), ...o.headers },
      ...(o.plain ? {} : { ca: o.ca }),
    }, res => { let b = ''; res.on('data', c => { b += String(c); }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b })); });
    r.on('timeout', () => r.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    r.on('error', (e: NodeJS.ErrnoException) => resolve(`error:${e.code ?? e.message}`));
    r.end(o.body);
  });
}

test('decision 157: the proxy serves HTTPS with the local certificate; plain HTTP on that port gets nothing and reaches nothing', async () => {
  const up = new FakeUpstream();
  await up.start();
  const dir = path.join(fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'ar-tlsp-')), 'tls');
  const files = tlsFiles(dir);
  const t = await startProxy(up.port, { settings: { tls: { certFile: files.certFile, keyFile: files.keyFile } } });
  try {
    up.script.push({ status: 200, headers: SSE_HEADERS, steps: messageStream() });
    const ok = await req(t.port, { ca: files.cert, headers: auth(), body });
    assert.equal(typeof ok === 'object' && ok.status, 200, String(ok));
    assert.equal(up.received[0]!.rawHeaders[up.received[0]!.rawHeaders.findIndex(h => h.toLowerCase() === 'x-api-key') + 1], TEST_KEY);
    const plain = await req(t.port, { plain: true, headers: auth(), body });
    assert.equal(typeof plain, 'string', `plain HTTP got an answer: ${JSON.stringify(plain)}`);
    assert.equal(up.received.length, 1, 'nothing more reached the upstream');
    // a client that does not trust this certificate does not connect either
    const other = selfSignedCert('someone-else', ['localhost'], ['127.0.0.1']);
    assert.match(String(await req(t.port, { ca: other.cert, headers: auth(), body })), /^error:/);
    // the proof over TLS: ours with the right certificate, 'other' with any other
    assert.equal(await proveProxy({ port: t.port, token: LOCAL_TOKEN, ca: files.cert }), 'ours');
    assert.equal(await proveProxy({ port: t.port, token: LOCAL_TOKEN, ca: other.cert }), 'other');
    assert.equal(await proveProxy({ port: t.port, token: 'not-the-token-0123456789abcdefghij', ca: files.cert }), 'other');
    // the health answer says the scheme
    const h = await req(t.port, { ca: files.cert, method: 'GET', path: '/proxy/v1/health', headers: auth() });
    assert.equal(typeof h === 'object' && h.status, 200);
  } finally { await t.close(); await up.close(); fs.rmSync(path.dirname(dir), { recursive: true, force: true }); }
});

test('decision 157: a renewed certificate is served without a restart', async () => {
  const up = new FakeUpstream();
  await up.start();
  const dir = path.join(fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'ar-tlsr-')), 'tls');
  const first = tlsFiles(dir, 'first');
  const t = await startProxy(up.port, { settings: { tls: { certFile: first.certFile, keyFile: first.keyFile } }, tlsReloadMs: 50 });
  try {
    assert.equal(await proveProxy({ port: t.port, token: LOCAL_TOKEN, ca: first.cert }), 'ours');
    const second = tlsFiles(dir, 'second');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(second.certFile, later, later);
    fs.utimesSync(second.keyFile, later, later);
    for (let i = 0; i < 60 && await proveProxy({ port: t.port, token: LOCAL_TOKEN, ca: second.cert }) !== 'ours'; i++) await sleep(50);
    assert.equal(await proveProxy({ port: t.port, token: LOCAL_TOKEN, ca: second.cert }), 'ours', 'the new certificate is served');
    assert.equal(await proveProxy({ port: t.port, token: LOCAL_TOKEN, ca: first.cert }), 'other', 'the old one no more');
  } finally { await t.close(); await up.close(); fs.rmSync(path.dirname(dir), { recursive: true, force: true }); }
});

test('decision 156: every start writes a fresh token: one from before the restart gets 401, the new one works', async () => {
  const up = new FakeUpstream();
  await up.start();
  const first = await startProxy(up.port);
  const paths = first.paths;
  const upstream = checkUpstream('', [], `http://127.0.0.1:${up.port}`).url;
  // keep the home: close the first proxy's server only
  await first.proxy.close();
  LocalTokens.freshAtStart(paths.proxyToken);   // what main.ts does at every start
  const fresh = fs.readFileSync(paths.proxyToken, 'utf8').trim();
  assert.notEqual(fresh, LOCAL_TOKEN);
  const second = createProxy({
    paths, tokens: new LocalTokens(paths.proxyToken), log: nullLogger, key: { get: () => TEST_KEY }, daemon: () => undefined,
    settings: { upstream, tokenDailyCapUsd: 100, dailyCapUsd: 300, headersTimeoutMs: 5000 }, reporter: { batchMs: 20 },
  });
  const port = await second.listen(0);
  try {
    const stale = await req(port, { plain: true, headers: auth(LOCAL_TOKEN), body });
    assert.equal(typeof stale === 'object' && stale.status, 401, 'a token from before the restart');
    assert.equal(up.received.length, 0);
    up.script.push({ status: 200, headers: SSE_HEADERS, steps: messageStream() });
    const ok = await req(port, { plain: true, headers: auth(fresh), body });
    assert.equal(typeof ok === 'object' && ok.status, 200);
  } finally { await second.close(); await up.close(); fs.rmSync(paths.home, { recursive: true, force: true }); }
});

test('pricing: Fable 5.2 and fast mode at the published rates; the usage tap keeps the speed; the hold uses each model\'s fast multiple', () => {
  const M = 1_000_000;
  assert.equal(costUsd('claude-fable-5-2', { input_tokens: M, output_tokens: M }), 48);
  assert.equal(costUsd('claude-fable-5-2', { cache_read_input_tokens: M }), 0.2);
  assert.equal(costUsd('claude-fable-5-1', { cache_read_input_tokens: M }), 0.25);
  assert.equal(costUsd('claude-fable-5-2', { input_tokens: M, output_tokens: M, speed: 'fast' }), 96);    // $16 + $80
  assert.equal(costUsd('claude-opus-5-5', { input_tokens: M, output_tokens: M, speed: 'fast' }), 48);     // $8 + $40
  assert.equal(costUsd('claude-opus-5-5', { cache_read_input_tokens: M, speed: 'fast' }), 0.4, 'caching multipliers apply on top');
  assert.equal(costUsd('claude-opus-5-5', { input_tokens: M, speed: 'standard' }), 4);
  assert.equal(costUsd('claude-sonnet-5-5', { input_tokens: M, speed: 'fast' }), 2, 'no fast pricing: standard rates');
  const tap = new UsageTap('application/json', undefined);
  tap.write(Buffer.from(JSON.stringify({ type: 'message', id: 'm', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 2, speed: 'fast' } })));
  return tap.end().then(r => {
    assert.equal(r.usage?.speed, 'fast');
    const s = requestShape(Buffer.from(JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 1000, speed: 'fast' })), undefined);
    assert.ok(Math.abs(reservationFor(s).usd - 2 * reservationFor({ ...s, fast: false }).usd) < 1e-5);
    assert.equal(reservationFor(requestShape(Buffer.from(JSON.stringify({ model: 'claude-fable-5-2', max_tokens: 10 })), undefined)).pricedAs, 'claude-fable-5-2', 'Fable 5.2 is a known model now');
  });
});
