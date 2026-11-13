// Decision 156: sealed calls between the router's own clients and the daemon.
// A program that holds the daemon's port while the daemon is down (another local user's process) must get
// neither the token nor the hook data from any client, and no client may take its answers for the daemon's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEALED_PATH, SEAL_WINDOW_MS, SealError, sealRequest, sealedCall } from '@do-it-all-claude-code/core';
import { TOKEN, makeHome, request, rmrf, startTestDaemon, type TestDaemon } from './helpers.ts';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const RELAY = here('../../../plugin/hooks/relay.mjs');
const STATUSLINE = here('../../../plugin/statusline.mjs');
const MCP = here('../../../plugin/mcp/server.mjs');
const CLI = here('../../cli/src/index.ts');
const MARKER = 'MARKER-user-prose-7f3a';
const HOOK = '/router/v1/hooks/claude-code';
const prompt = (text: string, sid = 's-sealed') => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sid, cwd: process.cwd(), prompt: text });

async function withDaemon(fn: (d: TestDaemon) => Promise<void>, config: Record<string, unknown> = {}): Promise<void> {
  const d = await startTestDaemon({ verify: { resolveCommands: async () => [] }, config });
  try { await fn(d); } finally { await d.close(); rmrf(d.home); }
}
const sealed = (d: { port: number }, method: string, p: string, body?: string, secret = TOKEN) => sealedCall({ port: d.port, secret, method, path: p, ...(body !== undefined ? { body } : {}), timeoutMs: 5000 });
const refusal = async (p: Promise<unknown>): Promise<string> => { try { await p; return 'accepted'; } catch (e) { return e instanceof SealError ? e.code : `threw ${String(e)}`; } };
const raw = (port: number, envelope: string, headers: Record<string, string> = {}) => request(port, { method: 'POST', path: SEALED_PATH, body: envelope, headers: { 'content-type': 'application/json', ...headers } });

/** Runs a node program with stdin, returns its stdout. */
function run(file: string, args: string[], home: string, stdin = '', extraEnv: Record<string, string> = {}, cwd?: string): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [file, ...args], { env: { ...process.env, DO_IT_ALL_CLAUDE_CODE_HOME: home, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'], ...(cwd ? { cwd } : {}) });
    let out = '';
    c.stdout.on('data', x => { out += x; });
    c.stderr.on('data', x => { out += x; });
    c.on('error', reject);
    c.on('close', code => resolve({ out, code }));
    c.stdin.end(stdin);
  });
}

/** A listener that takes the port and records every byte it is sent. `answer` is what it says to everything. */
async function squatter(answer: (req: http.IncomingMessage, body: string) => { status: number; body: string } = () => ({ status: 200, body: '{"ok":true,"version":"9.9.9"}' })) {
  const wire: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      wire.push(`${req.method} ${req.url}\n${JSON.stringify(req.headers)}\n${body}`);
      const a = answer(req, body);
      res.writeHead(a.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(a.body) });
      res.end(a.body);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as net.AddressInfo).port, wire, all: () => wire.join('\n---\n'), close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }) };
}

// ------------------------------------------------------------------ the daemon's sealed route

test('a sealed call reaches every route and answers as a direct call does; nothing but a sealed answer comes back', () => withDaemon(async d => {
  const health = await sealed(d, 'GET', '/router/v1/health');
  assert.deepEqual([health.status, JSON.parse(health.body).ok], [200, true]);
  const hook = await sealed(d, 'POST', HOOK, prompt(`Fix the typo in README.md ${MARKER}`));
  assert.equal(hook.status, 200);
  assert.match(JSON.parse(hook.body).hookSpecificOutput.additionalContext, /do-it-all-claude-code/);
  assert.equal((await sealed(d, 'GET', '/router/v1/status?session_id=s-sealed')).status, 200);
  // the daemon's own answers pass through with their status: an unknown route, a wrong method, a bad body
  assert.equal((await sealed(d, 'GET', '/router/v1/nope')).status, 404);
  assert.equal((await sealed(d, 'GET', HOOK)).status, 405);
  assert.equal((await sealed(d, 'POST', HOOK, '{ not json')).status, 400);
  // the dashboard's code is given to a sealed caller (the CLI), as it was to a bearer
  const code = await sealed(d, 'POST', '/dashboard/register-code');
  assert.equal(code.status, 200);
  assert.match(JSON.parse(code.body).code, /^[A-Za-z0-9_-]{20,}$/);
}));

test('what the sealed route refuses: every reason looks the same from outside', () => withDaemon(async d => {
  assert.equal(await refusal(sealed(d, 'GET', '/router/v1/health', undefined, 'not-the-token')), 'not_sealed');
  const { envelope } = sealRequest(TOKEN, { m: 'GET', p: '/router/v1/health' });
  const first = await raw(d.port, envelope);
  assert.equal(first.status, 200);
  // the same bytes again: a recorded request cannot be replayed
  const again = await raw(d.port, envelope);
  assert.deepEqual([again.status, again.body], [401, { error: 'unauthorized' }]);
  // outside the time window, a wrong secret, a broken envelope, a sealed call inside a sealed call, another method
  const cases: Array<[string, string]> = [
    ['stale', sealRequest(TOKEN, { m: 'GET', p: '/router/v1/health' }, { now: Date.now() - SEAL_WINDOW_MS - 5000 }).envelope],
    ['future', sealRequest(TOKEN, { m: 'GET', p: '/router/v1/health' }, { now: Date.now() + SEAL_WINDOW_MS + 5000 }).envelope],
    ['wrong secret', sealRequest('another-secret', { m: 'GET', p: '/router/v1/health' }).envelope],
    ['not an envelope', '{"hello":1}'], ['not json', 'x'], ['empty', ''],
    ['nested', sealRequest(TOKEN, { m: 'POST', p: SEALED_PATH, b: envelope }).envelope],
    ['method', sealRequest(TOKEN, { m: 'DELETE', p: '/router/v1/health' }).envelope],
  ];
  for (const [name, env] of cases) {
    const r = await raw(d.port, env);
    assert.deepEqual([r.status, r.body], [401, { error: 'unauthorized' }], name);
  }
  // transport rules as for every route
  assert.equal((await raw(d.port, sealRequest(TOKEN, { m: 'GET', p: '/router/v1/health' }).envelope, { origin: 'http://127.0.0.1' })).status, 403);
  assert.equal((await raw(d.port, sealRequest(TOKEN, { m: 'GET', p: '/router/v1/health' }).envelope, { host: 'evil.example' })).status, 403);
  assert.equal((await request(d.port, { method: 'GET', path: SEALED_PATH })).status, 405);
  // an oversized body: answered 413 and the connection closed (a client still writing sees a reset instead)
  const big = await raw(d.port, 'x'.repeat(2 * 1024 * 1024)).then(r => r.status, () => 'reset');
  assert.ok(big === 413 || big === 'reset', String(big));
  // nothing the daemon logged or stored names the token
  assert.ok(!JSON.stringify(d.ledger.db.prepare('SELECT payload FROM events').all()).includes(TOKEN));
}));

test('decision 164: the bearer route is off by default (the token as a header opens nothing); bearerApi "on" still lets it in; sealed calls work either way', async () => {
  const bearer = (port: number, p: string, method = 'GET') => request(port, { method, path: p, headers: { authorization: `Bearer ${TOKEN}` } });
  for (const config of [{}, { bearerApi: 'off' }]) {
    await withDaemon(async d => {
      assert.equal((await bearer(d.port, '/router/v1/status')).status, 401, `${JSON.stringify(config)}: the token as a header opens nothing`);
      assert.equal((await bearer(d.port, '/dashboard/register-code', 'POST')).status, 401);
      assert.equal((await request(d.port, { method: 'POST', path: HOOK, body: prompt('hi'), headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } })).status, 401);
      assert.equal((await sealed(d, 'GET', '/router/v1/status')).status, 200);
      assert.equal((await sealed(d, 'POST', HOOK, prompt('Fix the typo in README.md'))).status, 200);
      assert.equal((await sealed(d, 'POST', '/dashboard/register-code')).status, 200);
      assert.equal((await request(d.port, { path: '/router/v1/health' })).status, 200, 'health needs no credential');
    }, config);
  }
  await withDaemon(async d => {
    assert.equal((await bearer(d.port, '/router/v1/status')).status, 200, 'on: a client that still sends the token as a header gets in (deprecated)');
    assert.equal((await sealed(d, 'GET', '/router/v1/status')).status, 200);
    const log = fs.readFileSync(path.join(d.home, 'logs', 'daemon.log'), 'utf8');
    assert.equal(log.split('\n').filter(l => /bearerApi is on: .*deprecated and will be removed/.test(l)).length, 1, 'one line at start');
  }, { bearerApi: 'on' });
});

// ------------------------------------------------------------------ a squatter on the port

test('squatter: no client sends it the token or the hook data, and none takes its answer for the daemon\'s', async () => {
  const s = await squatter();
  const home = makeHome({ daemonPort: s.port });
  try {
    // the relay: the event is spooled in its minimal form and the hook passes
    const relayed = await run(RELAY, ['UserPromptSubmit'], home, prompt(`please ${MARKER}`));
    assert.equal(relayed.out, '{}');
    const spool = fs.readdirSync(path.join(home, 'spool'));
    assert.equal(spool.length, 1, 'spooled for the real daemon');
    assert.ok(!fs.readFileSync(path.join(home, 'spool', spool[0]!), 'utf8').includes(MARKER), 'the spool keeps no prompt text');
    // the status line: OFF, not the squatter's "status"
    const line = await run(STATUSLINE, [], home, JSON.stringify({ session_id: 's-sealed', model: { id: 'claude-sonnet-5-5' }, rate_limits: { five_hour: { used_percentage: 12 } } }));
    assert.match(line.out, /\[Router\] OFF/);
    // the MCP server: the tool call fails as "router not reachable"
    const mcp = await mcpCall(home, 'router_get_plan');
    assert.equal(mcp.isError, true);
    assert.ok(!JSON.stringify(mcp).includes('9.9.9'));
    // the CLI
    const cli = async (...a: string[]) => (await run(CLI, a, home, '', {}, home)).out;
    const status = await cli('status');
    assert.match(status, /Router OFF/);
    assert.match(status, /does not hold this router's token/);
    assert.ok(!status.includes('9.9.9'), 'the squatter\'s version is not shown as ours');
    assert.doesNotMatch(await cli('stop'), /stopped/, 'stop does not believe the squatter');
    assert.doesNotMatch(await cli('dashboard', '--no-open'), /#code=/, 'no dashboard link from the squatter');
    await cli('routing', 'reset');
    await cli('data', 'export');
    // what reached the squatter, in total
    const all = s.all();
    assert.ok(s.wire.length >= 5, `the clients did try the port (${s.wire.length} requests)`);
    assert.ok(!all.includes(TOKEN), 'the token never reached the squatter');
    assert.ok(!all.includes(MARKER), 'the prompt never reached the squatter');
    assert.ok(!/authorization/i.test(all), 'no Authorization header at all');
    assert.ok(!all.includes('claude-sonnet-5-5') && !all.includes('used_percentage'), 'nor the status line\'s data');
    for (const w of s.wire) assert.match(w, /^(POST \/router\/v1\/sealed|GET \/router\/v1\/health)\n/, 'only sealed calls and the open health check');
  } finally { await s.close(); rmrf(home); }
});

/** One tools/call through the plugin's MCP server as Claude Code runs it. */
function mcpCall(home: string, tool: string): Promise<{ isError?: boolean; content?: unknown }> {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [MCP], { env: { ...process.env, DO_IT_ALL_CLAUDE_CODE_HOME: home }, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    const timer = setTimeout(() => { c.kill(); reject(new Error('the MCP server did not answer')); }, 20_000);
    c.stdout.on('data', x => {
      buf += x;
      for (const l of buf.split('\n')) {
        let m: { id?: number; result?: { isError?: boolean } } | undefined;
        try { m = JSON.parse(l); } catch { continue; }
        if (m?.id === 2) { clearTimeout(timer); c.kill(); resolve(m.result ?? {}); }
      }
    });
    c.on('error', reject);
    const send = (o: object) => c.stdin.write(JSON.stringify(o) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: {}, _meta: { 'claudecode/toolUseId': 'toolu_x' } } });
  });
}

test('relay attack: a listener that passes everything on to the real daemon sees ciphertext only', () => withDaemon(async d => {
  // the squatter forwards each request to the real daemon (rewriting Host, as an attacker would) and records both directions
  const seen: string[] = [];
  const forward = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push(`> ${req.method} ${req.url} ${JSON.stringify(req.headers)} ${body.toString('utf8')}`);
      const up = http.request({ host: '127.0.0.1', port: d.port, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${d.port}` } }, r => {
        const back: Buffer[] = [];
        r.on('data', c => back.push(c as Buffer));
        r.on('end', () => { const b = Buffer.concat(back); seen.push(`< ${r.statusCode} ${b.toString('utf8')}`); res.writeHead(r.statusCode ?? 502, r.headers); res.end(b); });
      });
      up.end(body);
    });
  });
  await new Promise<void>(r => forward.listen(0, '127.0.0.1', r));
  const port = (forward.address() as net.AddressInfo).port;
  const home = makeHome({ daemonPort: port });
  try {
    const out = await run(RELAY, ['UserPromptSubmit'], home, prompt(`Fix the typo in README.md ${MARKER}`, 's-relayed'));
    // the call went through (the real daemon answered, sealed end to end) ...
    assert.match(JSON.parse(out.out).hookSpecificOutput.additionalContext, /do-it-all-claude-code/);
    // ... and the listener in the middle read nothing: no token, no prompt, no answer text
    const all = seen.join('\n');
    assert.ok(seen.length >= 2);
    assert.ok(!all.includes(TOKEN) && !all.includes(MARKER) && !all.includes('do-it-all-claude-code]') && !/authorization/i.test(all));
    // and what it recorded is worth nothing later: the request cannot be sent again
    const recorded = /\{"v":1,"n":"[^"]+","t":\d+,"c":"[^"]+"\}/.exec(seen[0]!)![0];
    assert.equal((await raw(d.port, recorded)).status, 401);
  } finally { forward.closeAllConnections(); await new Promise<void>(r => forward.close(() => r())); rmrf(home); }
}));

// ------------------------------------------------------------------ version skew

test('version skew: a new client against a daemon without the sealed route spools and never sends the token', async () => {
  // the daemon of the release before: no /router/v1/sealed, and it would accept the bearer on the hook route
  const old = await squatter(req => (req.url === SEALED_PATH ? { status: 404, body: '{"error":"not found"}' } : { status: 200, body: '{"ok":true,"version":"0.1.0"}' }));
  const home = makeHome({ daemonPort: old.port });
  try {
    const out = await run(RELAY, ['UserPromptSubmit'], home, prompt(`please ${MARKER}`));
    assert.equal(out.out, '{}', 'the hook passes');
    assert.equal(fs.readdirSync(path.join(home, 'spool')).length, 1, 'the event waits in the spool until the daemon is upgraded');
    assert.equal(old.wire.length, 1, 'one attempt, on the sealed route');
    assert.match(old.wire[0]!, /^POST \/router\/v1\/sealed\n/);
    assert.ok(!old.all().includes(TOKEN) && !old.all().includes(MARKER) && !/authorization/i.test(old.all()), 'no fallback to the bearer');
    assert.match((await run(CLI, ['status'], home, '', {}, home)).out, /does not hold this router's token|older version/);
  } finally { await old.close(); rmrf(home); }
});

// ------------------------------------------------------------------ cost

test('latency: sealing adds well under 5 ms to a call', () => withDaemon(async d => {
  const N = 200;
  const body = prompt('x'.repeat(1500), 's-lat');
  const direct = () => request(d.port, { method: 'GET', path: '/router/v1/status?session_id=s-lat', headers: { authorization: `Bearer ${TOKEN}` } });
  const viaSeal = () => sealed(d, 'GET', '/router/v1/status?session_id=s-lat');
  void body;
  for (let i = 0; i < 20; i++) { await direct(); await viaSeal(); }   // warm up
  const time = async (f: () => Promise<unknown>) => { const a: number[] = []; for (let i = 0; i < N; i++) { const t0 = performance.now(); await f(); a.push(performance.now() - t0); } return a.sort((x, y) => x - y)[N >> 1]!; };
  const [plain, sealedMs] = [await time(direct), await time(viaSeal)];
  assert.ok(sealedMs - plain < 5, `median ${plain.toFixed(2)} ms direct, ${sealedMs.toFixed(2)} ms sealed`);
}));
