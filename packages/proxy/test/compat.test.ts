// Gateway compatibility test (Phase 3 DoD): the proxy against a local fake upstream, loopback only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, checkUpstream } from '../src/config.ts';
import { BUDGET_BLOCK_STATUS } from '../src/server.ts';
import {
  FakeUpstream, LOCAL_TOKEN, SSE_HEADERS, TEST_KEY, auth, call, event, gzip, messageStream, readAll, rowsAfter, sleep, startProxy, type TestProxy,
} from './helpers.ts';

async function withProxy(fn: (up: FakeUpstream, t: TestProxy) => Promise<void>, o: Parameters<typeof startProxy>[1] = {}): Promise<void> {
  const up = new FakeUpstream();
  const port = await up.start();
  const t = await startProxy(port, o);
  try { await fn(up, t); } finally { await t.close(); await up.close(); }
}

const BODY = JSON.stringify({
  model: 'claude-haiku-5-5', max_tokens: 64, stream: true,
  system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.322' }, { type: 'text', text: 'You are Claude Code.', cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: 'hi' }, { role: 'system', content: 'mid-conversation system entry' }],
  output_config: { effort: 'low' }, thinking: { type: 'adaptive' }, context_management: { edits: [] }, some_future_field: { a: 1 },
});
const CLAUDE_HEADERS = {
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'interleaved-thinking-2025-05-14,effort-2025-11-24,some-future-beta-2099-01-01',
  'content-type': 'application/json',
  'x-claude-code-session-id': 'sess-1',
  'x-claude-code-agent-id': 'agent-7',
  'x-claude-code-prompt-id': 'prompt-3',
  'x-claude-code-request-class': 'subagent',
  'x-claude-code-agent-type': 'custom',
  'x-unknown-new-header': 'kept',
};
const header = (raw: string[], name: string) => {
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 2) if (raw[i]!.toLowerCase() === name) out.push(raw[i + 1]!);
  return out;
};

test('1. the request reaches the upstream unchanged except the credential (local token out, vault key in)', () => withProxy(async (up, t) => {
  up.script.push({ status: 200, headers: SSE_HEADERS, steps: messageStream() });
  const r = await call(t.port, { headers: { ...CLAUDE_HEADERS, ...auth() }, body: BODY });
  assert.equal(r.status, 200);
  const got = up.received[0]!;
  assert.equal(got.method, 'POST');
  assert.equal(got.url, '/v1/messages?beta=true');
  assert.equal(got.body.toString('utf8'), BODY);                                // byte for byte, unknown fields included
  for (const [k, v] of Object.entries(CLAUDE_HEADERS)) assert.deepEqual(header(got.rawHeaders, k), [v], k);
  assert.deepEqual(header(got.rawHeaders, 'x-api-key'), [TEST_KEY]);
  assert.deepEqual(header(got.rawHeaders, 'authorization'), []);
  assert.ok(!got.rawHeaders.join('\n').includes(LOCAL_TOKEN), 'the local token never reaches the upstream');
}));

test('2. the response reaches the client byte for byte: SSE with pings, a 300 KB delta, and a gzip body', () => withProxy(async (up, t) => {
  const big = messageStream({ id: 'msg_big', text: 'y'.repeat(300 * 1024), input: 1000, output: 70000 });
  up.script.push({ status: 200, headers: SSE_HEADERS, steps: big });
  const plain = await call(t.port, { headers: { ...CLAUDE_HEADERS, ...auth() }, body: BODY });
  assert.equal(plain.body.toString('utf8'), big.join(''));
  assert.equal(plain.headers['content-type'], SSE_HEADERS['content-type']);
  assert.equal(plain.headers['request-id'], 'req_fake_1');
  const zipped = gzip(messageStream({ id: 'msg_gz', input: 10, output: 5 }).join(''));
  up.script.push({ status: 200, headers: { ...SSE_HEADERS, 'content-encoding': 'gzip' }, steps: [zipped.subarray(0, 40), { wait: 20 }, zipped.subarray(40)] });
  const gz = await call(t.port, { headers: { ...CLAUDE_HEADERS, ...auth(), 'accept-encoding': 'gzip' }, body: BODY });
  assert.ok(gz.body.equals(zipped), 'compressed bytes are passed as they are');
  assert.deepEqual(header(up.received[1]!.rawHeaders, 'accept-encoding'), ['gzip']);
  const rows = await rowsAfter(t, 2);
  assert.deepEqual(rows.map(r => [r.messageId, (r.usage as { input: number; output: number }).input, (r.usage as { output: number }).output, r.state]),
    [['msg_big', 1000, 70000, 'complete'], ['msg_gz', 10, 5, 'complete']]);
}));

test('3. no buffering: the first event reaches the client before the upstream sends the next', () => withProxy(async (up, t) => {
  const ev = messageStream();
  up.script.push({ status: 200, headers: SSE_HEADERS, steps: [ev[0]!, { wait: 400 }, ...ev.slice(1)] });
  const r = await call(t.port, { headers: auth(), body: BODY });
  assert.ok(r.chunks.length >= 2, JSON.stringify(r.chunks));
  assert.ok(r.chunks[0]!.at < 300, `first chunk after ${r.chunks[0]!.at} ms`);
  assert.ok(r.chunks[r.chunks.length - 1]!.at >= 380, 'the rest came after the pause');
}));

test('4. upstream errors pass through unchanged: status, retry headers, rate-limit headers and body', () => withProxy(async (up, t) => {
  const cases = [
    { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '7', 'x-should-retry': 'true', 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': '1767225600' },
      body: '{"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}' },
    { status: 529, headers: { 'content-type': 'application/json', 'x-should-retry': 'true' }, body: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' },
    { status: 400, headers: { 'content-type': 'application/json' }, body: '{"type":"error","error":{"type":"invalid_request_error","message":"Unexpected value(s) `some-future-beta-2099-01-01` for the `anthropic-beta` header."}}' },
    { status: 500, headers: { 'content-type': 'application/json' }, body: '{"type":"error","error":{"type":"api_error","message":"Internal server error"}}' },
  ];
  for (const c of cases) up.script.push({ status: c.status, headers: c.headers, steps: [c.body] });
  for (const c of cases) {
    const r = await call(t.port, { headers: auth(), body: BODY });
    assert.equal(r.status, c.status);
    assert.equal(r.body.toString('utf8'), c.body);
    for (const [k, v] of Object.entries(c.headers)) assert.equal(r.headers[k], v, `${c.status} ${k}`);
  }
  const rows = await rowsAfter(t, 4);
  assert.deepEqual(rows.map(r => [r.httpStatus, r.state, r.usd]), cases.map(c => [c.status, 'error', 0]));
}));

test('5. the upstream dropping mid-stream reaches the client as a dropped connection, never a made-up end', () => withProxy(async (up, t) => {
  const ev = messageStream({ id: 'msg_cut', input: 50 });
  up.script.push({ status: 200, headers: SSE_HEADERS, steps: [ev[0]!, ev[1]!, { wait: 30 }, { destroy: true }] });
  const r = await call(t.port, { headers: auth(), body: BODY });
  assert.ok(r.error, 'the client connection failed');
  assert.ok(!r.body.toString('utf8').includes('message_stop'));
  assert.ok(!r.body.toString('utf8').includes('message_delta'));
  const [row] = await rowsAfter(t, 1);
  assert.deepEqual([row!.messageId, row!.state, (row!.usage as { input: number }).input], ['msg_cut', 'partial', 50]);
}));

test('6. a client that goes away stops the upstream request at once', () => withProxy(async (up, t) => {
  const ev = messageStream({ id: 'msg_abort' });
  up.script.push({ status: 200, headers: SSE_HEADERS, steps: [ev[0]!, { wait: 2000 }, ...ev.slice(1)] });
  const before = Date.now();
  await call(t.port, { headers: auth(), body: BODY, abortAfterFirstChunk: true });
  for (let i = 0; i < 50 && !up.received[0]?.closedEarly; i++) await sleep(10);
  assert.ok(up.received[0]!.closedEarly, 'the upstream saw the request end early');
  assert.ok(up.received[0]!.closedAt! - before < 1000, 'well before the upstream would have finished');
  const [row] = await rowsAfter(t, 1);
  assert.deepEqual([row!.messageId, row!.state], ['msg_abort', 'partial']);
}));

test('7. usage: stream totals, a non-stream reply, count_tokens (no row) and a retry (two rows)', () => withProxy(async (up, t) => {
  up.script.push({ status: 200, headers: SSE_HEADERS, steps: [
    ...messageStream({ id: 'msg_a', input: 1200, cacheRead: 9000, cacheWrite: 500 }).slice(0, -2),
    event('message_delta', { type: 'message_delta', delta: {}, usage: { output_tokens: 7 } }),
    event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 300, input_tokens: 1200 } }),
    event('message_stop', { type: 'message_stop' }),
  ] });
  up.script.push({ status: 200, headers: { 'content-type': 'application/json' }, steps: [JSON.stringify({ id: 'msg_json', type: 'message', model: 'claude-haiku-5-5', content: [], usage: { input_tokens: 40, output_tokens: 9 } })] });
  up.script.push({ status: 200, headers: { 'content-type': 'application/json' }, steps: ['{"input_tokens":1234}'] });
  up.script.push({ status: 529, headers: { 'content-type': 'application/json' }, steps: ['{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'] });
  up.script.push({ status: 200, headers: SSE_HEADERS, steps: messageStream({ id: 'msg_retry', input: 10, output: 2 }) });
  const h = { ...CLAUDE_HEADERS, ...auth() };
  await call(t.port, { headers: h, body: BODY });
  await call(t.port, { headers: h, body: BODY });
  assert.equal((await call(t.port, { path: '/v1/messages/count_tokens?beta=true', headers: h, body: BODY })).body.toString(), '{"input_tokens":1234}');
  await call(t.port, { headers: h, body: BODY });                               // Claude Code retries a 529 as a new request
  await call(t.port, { headers: h, body: BODY });
  const rows = await rowsAfter(t, 4);
  assert.deepEqual(rows.map(r => [r.messageId, r.state, r.httpStatus]),
    [['msg_a', 'complete', 200], ['msg_json', 'complete', 200], [null, 'error', 529], ['msg_retry', 'complete', 200]]);
  assert.deepEqual(rows[0]!.usage, { input: 1200, output: 300, cacheRead: 9000, cacheWrite: 500, cacheWrite5m: 0, cacheWrite1h: 0 });
  assert.deepEqual([rows[0]!.sessionId, rows[0]!.agentId, rows[0]!.promptId, rows[0]!.requestClass, rows[0]!.agentType], ['sess-1', 'agent-7', 'prompt-3', 'subagent', 'custom']);
  assert.ok(Number(rows[0]!.usd) > 0 && rows[0]!.priced === true);
  assert.equal(new Set(rows.map(r => r.id)).size, 4);
}));

test('8. a request over a budget cap never reaches the upstream: 429, x-should-retry false', () => withProxy(async (up, t) => {
  // the request budget from the daemon says it is spent
  const r1 = await call(t.port, { headers: { ...CLAUDE_HEADERS, ...auth() }, body: BODY });
  assert.equal(r1.status, BUDGET_BLOCK_STATUS);
  assert.equal(r1.headers['x-should-retry'], 'false');
  assert.equal(r1.headers['retry-after'], undefined);
  const e = JSON.parse(r1.body.toString()) as { type: string; error: { type: string; message: string } };
  assert.deepEqual([e.type, e.error.type], ['error', 'rate_limit_error']);
  assert.match(e.error.message, /do-it-all-claude-code: the budget of this request is reached \(\$5\.00 of \$5\.00\)/);
  assert.equal(up.received.length, 0);
  // count_tokens and other routes are not blocked
  up.script.push({ status: 200, headers: { 'content-type': 'application/json' }, steps: ['{"input_tokens":1}'] });
  assert.equal((await call(t.port, { path: '/v1/messages/count_tokens', headers: { ...CLAUDE_HEADERS, ...auth() }, body: BODY })).status, 200);
}, { budgetSource: async () => ({ requestId: 'r-1', budgetUsd: 5, spentUsd: 5 }) }));

test('8b. the daily cap of a local token blocks once its total is reached', () => withProxy(async (up, t) => {
  up.script.push({ status: 200, headers: SSE_HEADERS, steps: messageStream({ model: 'claude-opus-5-5', input: 100_000, output: 10_000 }) });
  assert.equal((await call(t.port, { headers: auth(), body: BODY })).status, 200);
  await rowsAfter(t, 1);
  const r = await call(t.port, { headers: auth(), body: BODY });
  assert.equal(r.status, 429);
  assert.match(r.body.toString(), /daily cap for this local token is reached/);
  assert.equal(up.received.length, 1);
}, { settings: { tokenDailyCapUsd: 0.1 } }));

test('9. wrong, OAuth-looking or missing tokens get 401 without an upstream call; rotation keeps the old token for the grace window', async () => {
  let clock = 1_000_000;
  await withProxy(async (up, t) => {
    for (const h of [{ authorization: 'Bearer wrong-token-0123456789abcdefghijklmnopqrstuvwxyz' }, { authorization: 'Bearer sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789' }, {}]) {
      const r = await call(t.port, { headers: h, body: BODY });
      assert.equal(r.status, 401);
      assert.equal(JSON.parse(r.body.toString()).error.type, 'authentication_error');
    }
    assert.equal(up.received.length, 0);
    // x-api-key alone works (Claude Code sends the helper value in both headers)
    up.script.push({ status: 200, headers: SSE_HEADERS, steps: messageStream() });
    assert.equal((await call(t.port, { headers: { 'x-api-key': LOCAL_TOKEN }, body: BODY })).status, 200);
    const fresh = t.tokens.rotate();
    up.script.push({ status: 200, headers: SSE_HEADERS, steps: messageStream() }, { status: 200, headers: SSE_HEADERS, steps: messageStream() });
    assert.equal((await call(t.port, { headers: auth(fresh), body: BODY })).status, 200);
    assert.equal((await call(t.port, { headers: auth(), body: BODY })).status, 200);          // old token inside the window
    clock += 10 * 60 * 1000 + 1;
    assert.equal((await call(t.port, { headers: auth(), body: BODY })).status, 401);          // after it
    assert.equal(up.received.length, 3);
  }, { nowMs: () => clock });
});

test('10. Origin and Host are checked, the bind is loopback, and the upstream allowlist holds', () => withProxy(async (up, t) => {
  assert.equal((await call(t.port, { headers: { ...auth(), origin: 'https://evil.example' }, body: BODY })).status, 403);
  assert.equal((await call(t.port, { headers: auth(), body: BODY, host: `evil.example:${t.port}` })).status, 403);
  assert.equal((await call(t.port, { method: 'HEAD', path: '/api/hello' })).status, 200);
  assert.equal((await call(t.port, { method: 'GET', path: '/other', headers: auth() })).status, 404);
  const health = await call(t.port, { method: 'GET', path: '/proxy/v1/health', headers: auth() });
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body.toString()).ok, true);
  assert.equal(up.received.length, 0);
  assert.equal((t.proxy.server.address() as { address: string }).address, '127.0.0.1');
  assert.throws(() => checkUpstream('https://evil.example', []), ConfigError);
  assert.throws(() => checkUpstream('http://api.anthropic.com', []), /must be https/);
  assert.throws(() => checkUpstream('https://api.anthropic.com/v1', []), /origin/);
  assert.throws(() => checkUpstream('', [], 'http://10.0.0.5:8080'), /127\.0\.0\.1/);
  assert.equal(checkUpstream('https://gw.example.com', ['https://gw.example.com']).url.origin, 'https://gw.example.com');
  // a redirect is passed back, not followed
  up.script.push({ status: 307, headers: { location: 'https://elsewhere.example/v1/messages' }, steps: [] });
  const r = await call(t.port, { headers: auth(), body: BODY });
  assert.deepEqual([r.status, r.headers.location, up.received.length], [307, 'https://elsewhere.example/v1/messages', 1]);
}));

test('11. the key is never in logs, spool rows, the proxy database or anything the client sees', () => withProxy(async (up, t) => {
  up.script.push({ status: 200, headers: SSE_HEADERS, steps: messageStream() });
  up.script.push({ status: 401, headers: { 'content-type': 'application/json' }, steps: ['{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'] });
  const ok = await call(t.port, { headers: auth(), body: BODY });
  const bad = await call(t.port, { headers: auth(), body: BODY });
  for (const r of [ok, bad]) {
    assert.ok(!r.body.toString().includes(TEST_KEY));
    assert.ok(!r.rawHeaders.join('\n').includes(TEST_KEY));
  }
  await rowsAfter(t, 2);
  t.proxy.budget.close();                                                       // flush the database to its file
  const files = readAll(t.home, [t.paths.proxyToken]).toString('latin1');
  assert.ok(files.length > 0);
  assert.ok(!files.includes(TEST_KEY), 'no file in the router home holds the key');
  assert.ok(!files.includes(LOCAL_TOKEN), 'the local token is only in its own file');
}));
