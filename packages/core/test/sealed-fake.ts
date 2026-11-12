// Test helper: the daemon side of a sealed call (decision 156) for a fake daemon in a test.
// `sealedFake(secret, handler)` is an http request listener: it opens the envelope, hands the request it
// carries to the handler and seals the handler's answer. `raw` records what arrived on the wire, so a test
// can assert that neither the token nor a marker from the payload was sent in the clear.
import type http from 'node:http';
import { SEALED_PATH, openRequest, sealResponse } from '../src/seal.ts';

export interface FakeRequest { method: string; path: string; body?: string }
export interface FakeAnswer { status?: number; contentType?: string; body: string }
export interface WireRecord { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }

export function sealedFake(secret: string, handler: (r: FakeRequest) => FakeAnswer | Promise<FakeAnswer>, raw: WireRecord[] = []): http.RequestListener {
  return (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      raw.push({ method: req.method, url: req.url, headers: req.headers, body: text });
      void (async () => {
        try {
          if (req.method !== 'POST' || req.url !== SEALED_PATH) { res.writeHead(404, { 'content-type': 'application/json' }); return void res.end('{"error":"not found"}'); }
          const { inner, nonce } = openRequest(secret, text);
          const a = await handler({ method: inner.m, path: inner.p, ...(inner.b !== undefined ? { body: inner.b } : {}) });
          const out = sealResponse(secret, nonce, { s: a.status ?? 200, ct: a.contentType ?? 'application/json', b: a.body });
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(out) });
          res.end(out);
        } catch {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end('{"error":"unauthorized"}');
        }
      })();
    });
  };
}
