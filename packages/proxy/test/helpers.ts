// Test helpers: a fake upstream on 127.0.0.1 that records what it receives and plays scripted responses, a
// proxy started against it, and a client that keeps the exact bytes and their arrival times.
// No test reaches the network or a real API.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { checkUpstream } from '../src/config.ts';
import { Masker, fileLogger } from '../src/log.ts';
import { proxyPaths, type ProxyPaths } from '../src/paths.ts';
import { createProxy, type Proxy, type ProxyOptions } from '../src/server.ts';
import { LocalTokens, writeTokenFile } from '../src/token.ts';

export const TEST_KEY = 'sk-ant-api03-TESTKEY-not-real-0123456789abcdefghijklmnopqrstuvwxyz';
export const LOCAL_TOKEN = 'local-token-for-tests-0123456789abcdefghijklmnop';

export function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ar-proxy-'));
}
export const rmrf = (d: string) => fs.rmSync(d, { recursive: true, force: true });
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------------ fake upstream

export type Step = string | Buffer | { wait: number } | { destroy: true };
export interface Scripted { status?: number; headers?: Record<string, string>; steps?: Step[] }
export interface Received { method: string; url: string; rawHeaders: string[]; body: Buffer; closedEarly: boolean; closedAt?: number }

export class FakeUpstream {
  readonly received: Received[] = [];
  readonly script: Scripted[] = [];
  #server = http.createServer((req, res) => void this.#handle(req, res));
  port = 0;

  async start(): Promise<number> {
    await new Promise<void>(r => this.#server.listen(0, '127.0.0.1', () => r()));
    this.port = (this.#server.address() as { port: number }).port;
    return this.port;
  }

  async #handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    const rec: Received = { method: req.method ?? '', url: req.url ?? '', rawHeaders: req.rawHeaders, body: Buffer.alloc(0), closedEarly: false };
    this.received.push(rec);
    res.on('close', () => { if (!res.writableFinished) { rec.closedEarly = true; rec.closedAt = Date.now(); } });
    for await (const c of req) chunks.push(c as Buffer);
    rec.body = Buffer.concat(chunks);
    const s = this.script.shift() ?? { status: 200, headers: { 'content-type': 'application/json' }, steps: ['{}'] };
    res.writeHead(s.status ?? 200, s.headers ?? {});
    res.flushHeaders();
    for (const step of s.steps ?? []) {
      if (res.destroyed) return;
      if (typeof step === 'string' || Buffer.isBuffer(step)) res.write(step);
      else if ('wait' in step) await sleep(step.wait);
      else { res.socket?.destroy(); return; }
    }
    res.end();
  }

  close(): Promise<void> {
    return new Promise(r => { this.#server.closeAllConnections(); this.#server.close(() => r()); });
  }
}

// ------------------------------------------------------------------ SSE fixtures

export const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

export function messageStream(o: { id?: string; model?: string; input?: number; output?: number; cacheRead?: number; cacheWrite?: number; text?: string } = {}): string[] {
  const id = o.id ?? 'msg_test_1';
  return [
    event('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: o.model ?? 'claude-haiku-5-5', content: [],
      usage: { input_tokens: o.input ?? 100, output_tokens: 1, cache_read_input_tokens: o.cacheRead ?? 0, cache_creation_input_tokens: o.cacheWrite ?? 0 } } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    event('ping', { type: 'ping' }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: o.text ?? 'hello' } }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: o.output ?? 20 } }),
    event('message_stop', { type: 'message_stop' }),
  ];
}

export const SSE_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'request-id': 'req_fake_1' };
export const gzip = (s: string) => zlib.gzipSync(Buffer.from(s));

// ------------------------------------------------------------------ proxy under test

export interface TestProxy { proxy: Proxy; port: number; home: string; paths: ProxyPaths; tokens: LocalTokens; masker: Masker; close(): Promise<void> }

export async function startProxy(upstreamPort: number, o: Partial<Omit<ProxyOptions, 'paths' | 'tokens' | 'key' | 'log' | 'settings'>> & {
  settings?: Partial<ProxyOptions['settings']>; graceMs?: number; nowMs?: () => number;
} = {}): Promise<TestProxy> {
  const home = tmpHome();
  const paths = proxyPaths(home);
  writeTokenFile(paths.proxyToken, LOCAL_TOKEN);
  const masker = new Masker();
  masker.add(TEST_KEY);
  const tokens = new LocalTokens(paths.proxyToken, {
    ...(o.graceMs !== undefined ? { graceMs: o.graceMs } : {}), ...(o.nowMs ? { now: o.nowMs } : {}),
    onChange: (a, r) => { masker.add(a); masker.remove(r); },
  });
  const log = fileLogger(paths.log, masker);
  const proxy = createProxy({
    paths, tokens, log, key: { get: () => TEST_KEY },
    settings: {
      upstream: checkUpstream('', [], `http://127.0.0.1:${upstreamPort}`).url, tokenDailyCapUsd: 100, dailyCapUsd: 300, headersTimeoutMs: 5000,
      ...o.settings,
    },
    daemon: o.daemon ?? (() => undefined),
    reporter: { batchMs: 20, ...o.reporter },
    ...(o.budgetSource ? { budgetSource: o.budgetSource } : {}),
    ...(o.now ? { now: o.now } : {}),
    ...(o.egress ? { egress: o.egress } : {}),
    ...(o.testUpstreamCa ? { testUpstreamCa: o.testUpstreamCa } : {}),
    ...(o.maxRequestBytes ? { maxRequestBytes: o.maxRequestBytes } : {}),
  });
  const port = await proxy.listen(0);
  return { proxy, port, home, paths, tokens, masker, close: async () => { await proxy.close(); rmrf(home); } };
}

// ------------------------------------------------------------------ client

export interface Reply { status: number; rawHeaders: string[]; headers: http.IncomingHttpHeaders; body: Buffer; chunks: Array<{ at: number; bytes: number }>; error?: string; start: number }

export function call(port: number, o: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer; abortAfterFirstChunk?: boolean; host?: string } = {}): Promise<Reply> {
  return new Promise(resolve => {
    const start = Date.now();
    const chunks: Buffer[] = [];
    const reply: Reply = { status: 0, rawHeaders: [], headers: {}, body: Buffer.alloc(0), chunks: [], start };
    const body = o.body === undefined ? undefined : Buffer.isBuffer(o.body) ? o.body : Buffer.from(o.body);
    const req = http.request({
      host: '127.0.0.1', port, method: o.method ?? 'POST', path: o.path ?? '/v1/messages?beta=true',
      headers: { host: o.host ?? `127.0.0.1:${port}`, ...(body ? { 'content-length': String(body.length) } : {}), ...o.headers },
    }, res => {
      reply.status = res.statusCode ?? 0;
      reply.rawHeaders = res.rawHeaders;
      reply.headers = res.headers;
      res.on('data', (c: Buffer) => {
        chunks.push(c);
        reply.chunks.push({ at: Date.now() - start, bytes: c.length });
        if (o.abortAfterFirstChunk) { req.destroy(); reply.body = Buffer.concat(chunks); resolve(reply); }
      });
      res.on('end', () => { reply.body = Buffer.concat(chunks); resolve(reply); });
      res.on('error', e => { reply.error = String(e); reply.body = Buffer.concat(chunks); resolve(reply); });
      res.on('aborted', () => { reply.error = 'aborted'; });
    });
    req.on('error', e => { reply.error = reply.error ?? String(e); reply.body = Buffer.concat(chunks); resolve(reply); });
    req.end(body);
  });
}

export const auth = (token = LOCAL_TOKEN) => ({ authorization: `Bearer ${token}`, 'x-api-key': token });

/** Files under a folder, read as bytes (except the ones listed). */
export function readAll(dir: string, except: string[] = []): Buffer {
  const out: Buffer[] = [];
  const skip = new Set(except.map(p => path.resolve(p)));
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (!skip.has(path.resolve(p))) out.push(fs.readFileSync(p));
    }
  };
  walk(dir);
  return Buffer.concat(out);
}

/** Usage rows spooled so far (no daemon in these tests). */
export function spooled(paths: ProxyPaths): Array<Record<string, unknown>> {
  if (!fs.existsSync(paths.spoolDir)) return [];
  return fs.readdirSync(paths.spoolDir).filter(f => f.endsWith('.jsonl')).flatMap(f =>
    fs.readFileSync(path.join(paths.spoolDir, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>));
}

export async function rowsAfter(t: TestProxy, n: number): Promise<Array<Record<string, unknown>>> {
  for (let i = 0; i < 100; i++) {
    await t.proxy.reporter.flush();
    const r = spooled(t.paths);
    if (r.length >= n) return r;
    await sleep(20);
  }
  return spooled(t.paths);
}
