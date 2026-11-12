// One exchange with the upstream, unmodified (decision 9: observe only).
//   request   method, path and query as received; every header in its original order and spelling except the
//             hop-by-hop set and the client's credential headers (Authorization, x-api-key), which are replaced
//             by x-api-key with the vault key; the body is piped, never parsed or held.
//   response  status, headers (minus hop-by-hop) and body bytes as the upstream sent them, flushed chunk by
//             chunk (SSE ping events included: Claude Code's idle watchdog relies on them). A copy of the bytes
//             goes to the usage tap.
// The proxy never retries (Claude Code owns retries) and never follows a redirect (a 3xx is passed back).
// If the client goes away, the upstream request is destroyed at once (stops generation and billing). If the
// upstream breaks mid-response, the client connection is destroyed too: no stream end is made up (spec 5.1).
import http from 'node:http';
import https from 'node:https';
import { UsageTap, type TapResult } from './tap.ts';

export const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);
const CREDENTIALS = new Set(['authorization', 'x-api-key']);

export interface ForwardOptions {
  upstream: URL;
  agent: http.Agent;
  /** The vault key, read only here. */
  key: () => string;
  headersTimeoutMs: number;
  /** Parse usage from the response copy. */
  tap: boolean;
}

export interface ForwardOutcome {
  /** The status the client got (an upstream status, or 502 / 504 made here when there was none). */
  status: number;
  /** A response came from the upstream. */
  upstreamAnswered: boolean;
  tap?: TapResult;
  upstreamRequestId: string | null;
  clientAborted: boolean;
  upstreamBroken: boolean;
}

/** Headers to pass on: original order and case, minus hop-by-hop (and those the Connection header names). */
export function passHeaders(raw: string[], drop: ReadonlySet<string> = new Set()): string[] {
  const named = new Set<string>();
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i]!.toLowerCase() === 'connection') for (const t of raw[i + 1]!.split(',')) named.add(t.trim().toLowerCase());
  }
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i]!;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || named.has(lower) || drop.has(lower)) continue;
    out.push(name, raw[i + 1]!);
  }
  return out;
}

/** An Anthropic-format error made by the proxy itself (no upstream involved). */
export function localError(res: http.ServerResponse, status: number, type: string, message: string, shouldRetry?: boolean): void {
  if (res.headersSent) { res.destroy(); return; }
  const body = JSON.stringify({ type: 'error', error: { type, message } });
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...(shouldRetry === undefined ? {} : { 'x-should-retry': shouldRetry ? 'true' : 'false' }),
  });
  res.end(body);
}

export function forward(req: http.IncomingMessage, res: http.ServerResponse, o: ForwardOptions): Promise<ForwardOutcome> {
  return new Promise(resolve => {
    const out: ForwardOutcome = { status: 0, upstreamAnswered: false, upstreamRequestId: null, clientAborted: false, upstreamBroken: false };
    let tap: UsageTap | undefined;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!tap) { resolve(out); return; }
      void tap.end().then(r => { out.tap = r; resolve(out); });
    };

    const headers = passHeaders(req.rawHeaders, CREDENTIALS);
    headers.push('Host', o.upstream.host, 'x-api-key', o.key());
    const client = o.upstream.protocol === 'https:' ? https : http;
    const up = client.request({
      protocol: o.upstream.protocol, hostname: o.upstream.hostname, port: o.upstream.port || undefined,
      method: req.method, path: req.url, headers, agent: o.agent,
    });

    const timer = setTimeout(() => {
      if (out.upstreamAnswered) return;
      up.destroy(new Error('upstream response headers timeout'));
      out.status = 504;
      localError(res, 504, 'api_error', 'agentic-router proxy: the upstream did not answer in time', true);
      settle();
    }, o.headersTimeoutMs);

    // the client went away before the response was complete: stop the upstream at once
    res.on('close', () => {
      if (res.writableFinished) return;
      out.clientAborted = true;
      up.destroy();
      settle();
    });

    up.on('response', ures => {
      clearTimeout(timer);
      out.upstreamAnswered = true;
      out.status = ures.statusCode ?? 502;
      const rid = ures.headers['request-id'];
      out.upstreamRequestId = typeof rid === 'string' ? rid : null;
      if (o.tap) tap = new UsageTap(ures.headers['content-type'], ures.headers['content-encoding'] as string | undefined);
      res.writeHead(out.status, ures.statusMessage, passHeaders(ures.rawHeaders));
      res.flushHeaders();
      let ended = false;
      ures.on('data', (chunk: Buffer) => {
        tap?.write(chunk);
        if (!res.write(chunk)) { ures.pause(); res.once('drain', () => ures.resume()); }
      });
      ures.on('end', () => { ended = true; res.end(); settle(); });
      ures.on('error', () => { /* handled on close */ });
      ures.on('close', () => {
        if (ended || out.clientAborted) return;
        out.upstreamBroken = true;
        res.destroy();   // the client sees a dropped connection, never a made-up end of stream
        settle();
      });
    });

    up.on('error', e => {
      if (out.clientAborted || settled) { settle(); return; }
      if (out.upstreamAnswered) { out.upstreamBroken = true; res.destroy(); settle(); return; }
      out.status = 502;
      localError(res, 502, 'api_error', `agentic-router proxy: the upstream could not be reached (${(e as NodeJS.ErrnoException).code ?? 'error'})`, true);
      settle();
    });

    req.pipe(up);
    req.on('error', () => up.destroy());
  });
}
