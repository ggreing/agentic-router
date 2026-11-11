import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { DAEMON_VERSION, startDaemon } from '../src/index.ts';
import { TOKEN, claudeAdapter, getStatus, makeHome, postHook, request, rmrf, startTestDaemon, type TestDaemon } from './helpers.ts';

let d: TestDaemon;
before(async () => { d = await startTestDaemon(); });
after(async () => { await d.close(); rmrf(d.home); });

const HOOK = '/router/v1/hooks/claude-code';
const auth = { authorization: `Bearer ${TOKEN}` };
const prompt = { session_id: 'srv-1', hook_event_name: 'UserPromptSubmit', cwd: '.', prompt: 'fix the typo in README.md' };

test('health needs no token and says only ok + version', async () => {
  const r = await request(d.port, { path: '/router/v1/health' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, version: DAEMON_VERSION });
  assert.equal(r.headers['cache-control'], 'no-store');
});

test('status and hook need the bearer token', async () => {
  for (const headers of [{}, { authorization: 'Bearer wrong-token-wrong-token-wrong' }, { authorization: TOKEN }, { authorization: `Basic ${TOKEN}` }]) {
    assert.equal((await request(d.port, { path: '/router/v1/status', headers })).status, 401);
    assert.equal((await request(d.port, { method: 'POST', path: HOOK, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(prompt) })).status, 401);
  }
  assert.equal((await getStatus(d.port)).status, 200);
});

test('only 127.0.0.1 / localhost with the bound port are accepted as Host', async () => {
  for (const host of ['evil.example', `127.0.0.1:${d.port + 1}`, '127.0.0.1', `attacker.localhost:${d.port}`]) {
    const r = await request(d.port, { path: '/router/v1/health', headers: { host } });
    assert.equal(r.status, 403, host);
  }
  assert.equal((await request(d.port, { path: '/router/v1/health', headers: { host: `localhost:${d.port}` } })).status, 200);
  assert.equal((await request(d.port, { path: '/router/v1/health', headers: { host: `LOCALHOST:${d.port}` } })).status, 200);
});

test('any Origin header is refused, even with a valid token', async () => {
  for (const origin of ['http://evil.example', `http://127.0.0.1:${d.port}`, 'null']) {
    assert.equal((await request(d.port, { path: '/router/v1/health', headers: { origin } })).status, 403);
    assert.equal((await request(d.port, { path: '/router/v1/status', headers: { ...auth, origin } })).status, 403);
  }
});

test('hook body: JSON content type, valid JSON object, at most 1 MB', async () => {
  const post = (body: string, type = 'application/json') => request(d.port, { method: 'POST', path: HOOK, headers: { ...auth, 'content-type': type }, body });
  assert.equal((await post(JSON.stringify(prompt), 'text/plain')).status, 415);
  assert.equal((await post(JSON.stringify(prompt), 'application/x-www-form-urlencoded')).status, 415);
  assert.equal((await post('{not json')).status, 400);
  assert.equal((await post('[1,2]')).status, 400);
  assert.equal((await post(JSON.stringify({ hook_event_name: 'Nope', session_id: 'x' }))).status, 400);
  assert.equal((await post(JSON.stringify(prompt), 'application/json; charset=utf-8')).status, 200);

  // declared too large: refused before the body is read
  const declared = await new Promise<number>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: d.port, method: 'POST', path: HOOK,
      headers: { ...auth, 'content-type': 'application/json', 'content-length': String(2 * 1024 * 1024) } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.write('{"a":"');
  });
  assert.equal(declared, 413);

  // streamed (chunked) past the limit
  const big = JSON.stringify({ ...prompt, pad: 'x'.repeat(1024 * 1024 + 10) });
  const streamed = await new Promise<number | string>(resolve => {
    const req = http.request({ host: '127.0.0.1', port: d.port, method: 'POST', path: HOOK, headers: { ...auth, 'content-type': 'application/json', 'transfer-encoding': 'chunked' } },
      res => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', e => resolve((e as NodeJS.ErrnoException).code ?? 'error'));
    req.end(big);
  });
  assert.ok(streamed === 413 || streamed === 'ECONNRESET' || streamed === 'EPIPE', `got ${streamed}`);

  // just under the limit is fine
  const under = JSON.stringify({ ...prompt, pad: 'x'.repeat(1024 * 1024 - 400) });
  assert.equal((await post(under)).status, 200);
});

test('unknown routes 404, wrong methods 405', async () => {
  assert.equal((await request(d.port, { path: '/router/v1/nope', headers: auth })).status, 404);
  assert.equal((await request(d.port, { path: '/', headers: auth })).status, 404);
  const r = await request(d.port, { method: 'POST', path: '/router/v1/health' });
  assert.equal(r.status, 405);
  assert.equal(r.headers.allow, 'GET');
  assert.equal((await request(d.port, { path: HOOK, headers: auth })).status, 405);
});

test('hook response is the adapter-rendered output of the decision', async () => {
  const r = await postHook(d.port, { ...prompt, session_id: 'srv-2' });
  assert.equal(r.status, 200);
  const out = r.body as { hookSpecificOutput?: { additionalContext?: string } };
  assert.match(out.hookSpecificOutput?.additionalContext ?? '', /^\[agentic-router\] level L\d/);
});

test('server binds to 127.0.0.1 only (a wildcard bind would also answer on ::1)', async () => {
  const code = await new Promise<string>(resolve => {
    const s = net.connect({ host: '::1', port: d.port }, () => { s.destroy(); resolve('connected'); });
    s.on('error', e => resolve((e as NodeJS.ErrnoException).code ?? 'error'));
  });
  assert.notEqual(code, 'connected');
});

test('startDaemon refuses to start without a token or a port', async () => {
  const home = makeHome();
  try {
    fs.rmSync(path.join(home, 'token'));
    await assert.rejects(startDaemon({ home, port: 0 }), /token file not found/);
    fs.writeFileSync(path.join(home, 'token'), TOKEN);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ fableOptIn: false }));
    await assert.rejects(startDaemon({ home }), /no daemon port/);
  } finally { rmrf(home); }
});

test('a port already in use rejects the start and releases the ledger', async () => {
  const home = makeHome();
  try {
    await assert.rejects(startTestDaemon({ home, port: d.port }), /EADDRINUSE/);
    fs.rmSync(path.join(home, 'router.db'));   // would fail on Windows if the ledger were still open
  } finally { rmrf(home); }
});

test('PreCompact: the hook response is plain text (what the hook prints), not JSON', async () => {
  const pre = { session_id: 'srv-pc', hook_event_name: 'PreCompact', cwd: '.', trigger: 'manual', custom_instructions: '' };
  const r = await postHook(d.port, pre);
  assert.equal(r.status, 200);
  assert.match(String(r.headers['content-type']), /^text\/plain; charset=utf-8/);
  assert.equal(r.text, '');
  // whatever the adapter renders for PreCompact is passed through unchanged
  const d2 = await startTestDaemon({ adapter: { ...claudeAdapter, renderPreCompactStdout: () => 'Keep every [subtask:<ID>] tag.\nline 2' } });
  try {
    const r2 = await postHook(d2.port, pre);
    assert.equal(r2.text, 'Keep every [subtask:<ID>] tag.\nline 2');
    assert.match(String(r2.headers['content-type']), /^text\/plain/);
  } finally { await d2.close(); rmrf(d2.home); }
});
