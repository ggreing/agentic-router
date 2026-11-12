// A POST /v1/messages holds its worst case against the daily caps, sized from the request (model, max_tokens, body
// size); the body is forwarded byte for byte. Loopback fake upstream; no network, no real API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { CACHE_MULTIPLIER, PRICING_PER_MTOK } from '@agentic-router/core/pricing';
import { MAX_TOKENS_FALLBACK, requestShape, reservationFor } from '../src/reserve.ts';
import { FakeUpstream, SSE_HEADERS, auth, call, messageStream, startProxy, type TestProxy } from './helpers.ts';

const body = (o: Record<string, unknown>) => JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], ...o });
const HAIKU = PRICING_PER_MTOK['claude-haiku-5-5']!;

async function withProxy(caps: { token?: number; daily?: number }, fn: (up: FakeUpstream, t: TestProxy) => Promise<void>, extra: Parameters<typeof startProxy>[1] = {}): Promise<void> {
  const up = new FakeUpstream();
  await up.start();
  const t = await startProxy(up.port, { settings: { tokenDailyCapUsd: caps.token ?? 100, dailyCapUsd: caps.daily ?? 300 }, ...extra });
  try { await fn(up, t); } finally { await t.close(); await up.close(); }
}
const ok = () => ({ status: 200, headers: SSE_HEADERS, steps: messageStream() });

test('the hold: dearest input-side rate per body byte plus max_tokens at the output rate; an unknown model is priced as the dearest', () => {
  const b = Buffer.from(body({ model: 'claude-haiku-5-5', max_tokens: 1000 }));
  const s = requestShape(b, undefined);
  assert.deepEqual([s.model, s.maxTokens, s.fast, s.promptBytes], ['claude-haiku-5-5', 1000, false, b.length]);
  const inRate = Math.max(HAIKU.input, HAIKU.longPromptInput ?? 0) * CACHE_MULTIPLIER.write1h / 1e6;
  const outRate = Math.max(HAIKU.output, HAIKU.longPromptOutput ?? 0) / 1e6;
  assert.ok(Math.abs(reservationFor(s).usd - (b.length * inRate + 1000 * outRate)) < 1e-6);
  // unknown model: the dearest in the table for this request, never less than any known one
  const unknown = reservationFor({ ...s, model: 'claude-unknown-9' });
  for (const id of Object.keys(PRICING_PER_MTOK)) assert.ok(unknown.usd >= reservationFor({ ...s, model: id }).usd - 1e-9, id);
  assert.match(unknown.basis, /an unknown model, priced as claude-/);
  assert.equal(reservationFor({ ...s, model: null }).pricedAs, unknown.pricedAs);
  // fast mode doubles; no max_tokens uses the fallback
  assert.ok(Math.abs(reservationFor({ ...s, fast: true }).usd - 2 * reservationFor(s).usd) < 1e-5);
  assert.equal(requestShape(Buffer.from(body({ model: 'claude-haiku-5-5', speed: 'fast' })), undefined).fast, true);
  const none = requestShape(Buffer.from(body({ model: 'claude-haiku-5-5' })), undefined);
  assert.equal(none.maxTokens, null);
  assert.match(reservationFor(none).basis, new RegExp(`max_tokens ${MAX_TOKENS_FALLBACK} \\(none given\\)`));
});

test('the hold counts the decoded body; a body that cannot be decoded, or decodes past the limit, is held as the largest request', () => {
  const text = body({ model: 'claude-haiku-5-5', max_tokens: 10, pad: 'x'.repeat(20_000) });
  const gz = zlib.gzipSync(Buffer.from(text));
  assert.ok(gz.length < 1000);
  assert.equal(requestShape(gz, 'gzip').promptBytes, Buffer.byteLength(text), 'the decoded size, not the compressed one');
  assert.equal(requestShape(zlib.brotliCompressSync(Buffer.from(text)), 'br').promptBytes, Buffer.byteLength(text));
  const odd = requestShape(Buffer.from('xyz'), 'compress', 5000);
  assert.deepEqual([odd.promptBytes, odd.unreadable], [5000, 'content-encoding compress cannot be read']);
  const bomb = requestShape(zlib.gzipSync(Buffer.alloc(2_000_000)), 'gzip', 100_000);
  assert.deepEqual([bomb.promptBytes, bomb.unreadable], [100_000, 'decoded body over 100000 bytes']);
  assert.equal(requestShape(Buffer.from('not json'), undefined).model, null);
});

test('the forwarded body is byte-identical: odd spacing and escapes, gzip as sent, and a chunked upload', () => withProxy({}, async (up, t) => {
  const odd = Buffer.from('{ "model" :"claude-haiku-5-5",\n\t"max_tokens":16,  "messages":[{"role":"user","content":"caf\\u00e9 éè \\"q\\" \u{1F600}"}] }   ');
  up.script.push(ok(), ok(), ok());
  assert.equal((await call(t.port, { headers: { ...auth(), 'content-type': 'application/json' }, body: odd })).status, 200);
  assert.ok(up.received[0]!.body.equals(odd), 'identity body unchanged');
  const gz = zlib.gzipSync(Buffer.from(body({ model: 'claude-haiku-5-5', max_tokens: 16 })));
  assert.equal((await call(t.port, { headers: { ...auth(), 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: gz })).status, 200);
  assert.ok(up.received[1]!.body.equals(gz), 'gzip body unchanged (not decoded on the way)');
  const enc = up.received[1]!.rawHeaders.findIndex(h => h.toLowerCase() === 'content-encoding');
  assert.equal(up.received[1]!.rawHeaders[enc + 1], 'gzip');
  // chunked: no content-length, two writes
  const parts = [Buffer.from('{"model":"claude-haiku-5-5","max_tokens":16,'), Buffer.from('"messages":[{"role":"user","content":"hi"}]}')];
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: t.port, method: 'POST', path: '/v1/messages', headers: { host: `127.0.0.1:${t.port}`, ...auth(), 'content-type': 'application/json' } },
      res => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    req.on('error', reject);
    req.write(parts[0]); setTimeout(() => req.end(parts[1]), 20);
  });
  assert.equal(status, 200);
  assert.ok(up.received[2]!.body.equals(Buffer.concat(parts)));
}));

test('concurrent requests see each other\'s holds: the second waits for room, then fits once the first settles', () => withProxy({ token: 1 }, async (up, t) => {
  // haiku, max_tokens 250k: a hold of about $0.63, so one fits under a $1 cap and two do not
  const big = body({ model: 'claude-haiku-5-5', max_tokens: 250_000 });
  up.script.push({ status: 200, headers: SSE_HEADERS, steps: [{ wait: 400 }, ...messageStream()] }, ok());
  const first = call(t.port, { headers: auth(), body: big });
  for (let i = 0; i < 100 && up.received.length === 0; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(up.received.length, 1, 'the first is in flight');
  const second = await call(t.port, { headers: auth(), body: big });
  assert.equal(second.status, 429);
  assert.equal(second.headers['x-should-retry'], 'false');
  assert.match(second.body.toString(), /held at up to \$0\.6\d{3} .*more than the \$0\.3\d{3} left of the daily cap for this local token/);
  assert.equal(up.received.length, 1, 'the second never reached the upstream');
  assert.equal((await first).status, 200);
  // settled to the actual cost (cents), so there is room again
  assert.equal((await call(t.port, { headers: auth(), body: big })).status, 200);
  assert.equal(up.received.length, 2);
}));

test('a large max_tokens is refused near the cap with a message naming the cap and the hold; a small one passes', () => withProxy({ token: 1 }, async (up, t) => {
  const r = await call(t.port, { headers: auth(), body: body({ model: 'claude-haiku-5-5', max_tokens: 1_000_000 }) });
  assert.equal(r.status, 429);
  const msg = (JSON.parse(r.body.toString()) as { error: { type: string; message: string } }).error;
  assert.equal(msg.type, 'rate_limit_error');
  assert.match(msg.message, /held at up to \$2\.50 \(its worst case: claude-haiku-5-5, up to \d+ prompt bytes and max_tokens 1000000\)/);
  assert.match(msg.message, /the daily cap for this local token \(\$0\.00 of \$1\.00 used or held\)/);
  assert.match(msg.message, /proxy\.tokenDailyCapUsd/);
  assert.equal(up.received.length, 0);
  up.script.push(ok());
  assert.equal((await call(t.port, { headers: auth(), body: body({ model: 'claude-haiku-5-5', max_tokens: 1000 }) })).status, 200);
}));

test('an unknown model is priced as the dearest one: refused where the same request for a known cheap model passes', () => withProxy({ token: 1 }, async (up, t) => {
  const r = await call(t.port, { headers: auth(), body: body({ model: 'claude-unknown-9', max_tokens: 30_000 }) });
  assert.equal(r.status, 429);
  assert.match(r.body.toString(), /an unknown model, priced as claude-/);
  up.script.push(ok());
  assert.equal((await call(t.port, { headers: auth(), body: body({ model: 'claude-haiku-5-5', max_tokens: 30_000 }) })).status, 200);
}));

test('the global daily cap applies the same rule', () => withProxy({ token: 100, daily: 1 }, async (up, t) => {
  const r = await call(t.port, { headers: auth(), body: body({ model: 'claude-haiku-5-5', max_tokens: 1_000_000 }) });
  assert.equal(r.status, 429);
  assert.match(r.body.toString(), /the daily API budget \(\$0\.00 of \$1\.00 used or held\).*proxy\.dailyCapUsd/);
  assert.equal(up.received.length, 0);
}));

test('a body over the request limit gets 413 request_too_large and is not sent, whether declared or streamed', () => withProxy({}, async (up, t) => {
  const big = Buffer.from(body({ model: 'claude-haiku-5-5', max_tokens: 10, pad: 'x'.repeat(5000) }));
  const r = await call(t.port, { headers: auth(), body: big });
  assert.equal(r.status, 413);
  assert.equal((JSON.parse(r.body.toString()) as { error: { type: string } }).error.type, 'request_too_large');
  assert.equal(r.headers['x-should-retry'], 'false');
  // chunked, so only the bytes count
  const status = await new Promise<number>(resolve => {
    const req = http.request({ host: '127.0.0.1', port: t.port, method: 'POST', path: '/v1/messages', headers: { host: `127.0.0.1:${t.port}`, ...auth() } },
      res => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    req.on('error', () => resolve(-1));
    req.write(big.subarray(0, 3000)); req.write(big.subarray(3000));
    req.end();
  });
  assert.ok(status === 413 || status === -1, `got ${status}`);
  assert.equal(up.received.length, 0);
  // count_tokens and models are not held or read
  up.script.push({ status: 200, headers: { 'content-type': 'application/json' }, steps: ['{"input_tokens":3}'] });
  assert.equal((await call(t.port, { path: '/v1/messages/count_tokens', headers: auth(), body: big })).status, 200);
  assert.ok(up.received[0]!.body.equals(big));
}, { maxRequestBytes: 4096 }));
