import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sealedFake } from '../../core/test/sealed-fake.ts';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'plugin', 'mcp', 'server.mjs');
const TOOLS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'plugin', 'mcp', 'tools.json');

type Json = Record<string, unknown>;

/** A fake daemon whose POST /router/v1/tools/call handler can be swapped per test. */
function fakeDaemon(): Promise<{ port: number; set: (h: (body: Json) => { status?: number; json: unknown }) => void; close: () => Promise<void>; lastBody: () => Json | null }> {
  let handler: (body: Json) => { status?: number; json: unknown } = () => ({ json: { content: [{ type: 'text', text: '{}' }], isError: false } });
  let last: Json | null = null;
  // the daemon side of a sealed call (decision 156), with the token of the test home as the shared secret
  const server = http.createServer(sealedFake('test-token-abcdef0123456789', r => {
    let body: Json = {};
    try { body = JSON.parse(r.body ?? '') as Json; } catch { /* ignore */ }
    last = body;
    const out = handler(body);
    return { status: out.status ?? 200, body: JSON.stringify(out.json) };
  }));
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as { port: number }).port;
    resolve({
      port,
      set: h => { handler = h; },
      lastBody: () => last,
      close: () => new Promise<void>(r => server.close(() => r())),
    });
  }));
}

interface Client {
  child: ChildProcessWithoutNullStreams;
  send: (msg: Json) => void;
  waitFor: (pred: (m: Json) => boolean, timeoutMs?: number) => Promise<Json>;
  rawLines: () => string[];
  close: () => void;
}

function makeHome(daemonPort: number | null): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-mcp-'));
  fs.writeFileSync(path.join(home, 'token'), 'test-token-abcdef0123456789\n');
  if (daemonPort !== null) fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ daemonPort }));
  return home;
}

function spawnServer(home: string, extraEnv: Record<string, string> = {}): Client {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, DO_IT_ALL_CLAUDE_CODE_HOME: home, DO_IT_ALL_CLAUDE_CODE_TOOLS: TOOLS, CLAUDE_CODE_SESSION_ID: 'sess-1', CLAUDE_PROJECT_DIR: '/proj', ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  const msgs: Json[] = [];
  const raw: string[] = [];
  const checks: Array<{ pred: (m: Json) => boolean; resolve: (m: Json) => void }> = [];
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', d => {
    buf += d;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      raw.push(line);
      const m = JSON.parse(line) as Json;   // throws if the server ever writes non-JSON to stdout
      msgs.push(m);
      for (let i = checks.length - 1; i >= 0; i--) if (checks[i]!.pred(m)) { checks[i]!.resolve(m); checks.splice(i, 1); }
    }
  });
  child.stderr.resume();
  return {
    child,
    send: msg => child.stdin.write(JSON.stringify(msg) + '\n'),
    rawLines: () => raw,
    waitFor: (pred, timeoutMs = 5000) => new Promise<Json>((resolve, reject) => {
      const hit = msgs.find(pred);
      if (hit) return resolve(hit);
      const t = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs);
      checks.push({ pred: m => pred(m), resolve: m => { clearTimeout(t); resolve(m); } });
    }),
    close: () => { try { child.stdin.end(); } catch { /* ignore */ } try { child.kill(); } catch { /* ignore */ } },
  };
}

const hasId = (id: unknown) => (m: Json) => m.id === id;

test('initialize negotiates the protocol version and advertises the tools capability', async () => {
  const d = await fakeDaemon();
  const c = spawnServer(makeHome(d.port));
  try {
    c.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    const r1 = await c.waitFor(hasId(1));
    const res1 = r1.result as Json;
    assert.equal(res1.protocolVersion, '2025-06-18');                 // listed -> echoed
    assert.deepEqual((res1.capabilities as Json).tools, {});
    assert.equal((res1.serverInfo as Json).name, 'do-it-all-claude-code');

    c.send({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: 'nope-9999', capabilities: {} } });
    const r2 = await c.waitFor(hasId(2));
    assert.equal((r2.result as Json).protocolVersion, '2025-11-25');   // unknown -> latest
  } finally { c.close(); await d.close(); }
});

test('tools/list returns exactly the tools in tools.json', async () => {
  const d = await fakeDaemon();
  const c = spawnServer(makeHome(d.port));
  try {
    c.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const r = await c.waitFor(hasId(1));
    const tools = (r.result as { tools: Array<{ name: string }> }).tools;
    const expected = JSON.parse(fs.readFileSync(TOOLS, 'utf8')) as Array<{ name: string }>;
    assert.deepEqual(tools, expected);
    assert.deepEqual(tools.map(t => t.name).sort(), ['router_get_plan', 'router_report_result', 'router_report_triage', 'router_request_escalation', 'router_request_scope']);
  } finally { c.close(); await d.close(); }
});

test('tools/call forwards to the daemon with bind info and relays an MCP result', async () => {
  const d = await fakeDaemon();
  d.set(() => ({ json: { content: [{ type: 'text', text: '{"request":null}' }], isError: false } }));
  const c = spawnServer(makeHome(d.port));
  try {
    c.send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'router_get_plan', arguments: {} } });
    const r = await c.waitFor(hasId(7));
    const res = r.result as { content: Array<{ text: string }>; isError: boolean };
    assert.equal(res.isError, false);
    assert.equal(res.content[0]!.text, '{"request":null}');
    const body = d.lastBody()!;
    assert.equal(body.tool, 'router_get_plan');
    assert.deepEqual(body.input, {});
    const bind = body.bind as Json;
    assert.equal(bind.spawnSessionId, 'sess-1');
    assert.equal(bind.projectDir, '/proj');
    assert.ok(typeof bind.instanceId === 'string' && (bind.instanceId as string).length > 0);
  } finally { c.close(); await d.close(); }
});

test('tools/call wraps a bare daemon JSON reply in a single text block', async () => {
  const d = await fakeDaemon();
  d.set(() => ({ json: { error: 'no_request' } }));   // not MCP-shaped
  const c = spawnServer(makeHome(d.port));
  try {
    c.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'router_get_plan' } });
    const r = await c.waitFor(hasId(1));
    const res = r.result as { content: Array<{ text: string }>; isError: boolean };
    assert.equal(res.isError, false);
    assert.deepEqual(JSON.parse(res.content[0]!.text), { error: 'no_request' });
  } finally { c.close(); await d.close(); }
});

test('a daemon error status becomes an isError daemon_unreachable result, not a JSON-RPC error', async () => {
  const d = await fakeDaemon();
  d.set(() => ({ status: 500, json: { error: 'boom' } }));
  const c = spawnServer(makeHome(d.port));
  try {
    c.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'router_get_plan' } });
    const r = await c.waitFor(hasId(1));
    assert.equal(r.error, undefined);
    const res = r.result as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(res.isError, true);
    assert.match(res.content[0]!.text, /daemon_unreachable/);
  } finally { c.close(); await d.close(); }
});

test('tools/call with no daemon configured yields an isError result (never blocks)', async () => {
  const c = spawnServer(makeHome(null));   // no config.json -> no port
  try {
    c.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'router_get_plan' } });
    const r = await c.waitFor(hasId(1));
    const res = r.result as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(res.isError, true);
    assert.match(res.content[0]!.text, /daemon_unreachable/);
  } finally { c.close(); }
});

test('an unparseable line answers -32700 with a null id', async () => {
  const d = await fakeDaemon();
  const c = spawnServer(makeHome(d.port));
  try {
    c.child.stdin.write('this is not json\n');
    const r = await c.waitFor(m => m.id === null && m.error !== undefined);
    assert.equal((r.error as Json).code, -32700);
  } finally { c.close(); await d.close(); }
});

test('an unknown method answers -32601 and does not reach the daemon', async () => {
  const d = await fakeDaemon();
  const c = spawnServer(makeHome(d.port));
  try {
    c.send({ jsonrpc: '2.0', id: 5, method: 'resources/list' });
    const r = await c.waitFor(hasId(5));
    assert.equal((r.error as Json).code, -32601);
  } finally { c.close(); await d.close(); }
});

test('notifications get no reply; ping after them still works (ordering + stdout is JSON only)', async () => {
  const d = await fakeDaemon();
  const c = spawnServer(makeHome(d.port));
  try {
    c.send({ jsonrpc: '2.0', method: 'notifications/initialized' });   // no id -> no reply
    c.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} });  // ignored
    c.send({ jsonrpc: '2.0', id: 9, method: 'ping' });
    const r = await c.waitFor(hasId(9));
    assert.deepEqual(r.result, {});
    // only one line emitted so far (the ping reply); every emitted line is valid JSON
    for (const line of c.rawLines()) JSON.parse(line);
    assert.equal(c.rawLines().length, 1);
  } finally { c.close(); await d.close(); }
});

test('a message split across two stdin writes is handled once reassembled', async () => {
  const d = await fakeDaemon();
  const c = spawnServer(makeHome(d.port));
  try {
    const line = JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }) + '\n';
    c.child.stdin.write(line.slice(0, 10));
    await new Promise(r => setTimeout(r, 30));
    c.child.stdin.write(line.slice(10));
    const r = await c.waitFor(hasId(3));
    assert.deepEqual(r.result, {});
  } finally { c.close(); await d.close(); }
});

test('the server exits when stdin ends', async () => {
  const d = await fakeDaemon();
  const c = spawnServer(makeHome(d.port));
  const exited = new Promise<number>(resolve => c.child.on('exit', code => resolve(code ?? -1)));
  c.child.stdin.end();
  const code = await Promise.race([exited, new Promise<number>((_, rej) => setTimeout(() => rej(new Error('did not exit')), 5000))]);
  assert.equal(code, 0);
  await d.close();
});
