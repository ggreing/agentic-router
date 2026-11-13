// Decision 156 (d1): the proxy proves it is this router's proxy before anyone hands it the local token.
//
// The proxy listens on a 127.0.0.1 port. While it is down, another local user can bind that port; Claude Code would
// then send the local token, and the prompts, to that program. So the apiKeyHelper (bin/local-token.mjs) asks
// first: it sends a random nonce, and only a program that holds the current local token (in the user-only router
// home) can answer with
//
//   proof = base64url(HMAC-SHA256(key = local token, "agentic-router proxy proof v1\n<port>\n<nonce>"))
//
// The token itself is never sent for this. The port is bound in, so an answer obtained from a proxy on another port
// does not pass. The helper prints the token only after a matching proof; otherwise nothing, and it exits non-zero.
// bin/local-token.mjs carries a dependency-free copy of proofOf; a test keeps the two equal.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

export const PROOF_PATH = '/proxy/v1/proof';
export const PROOF_LABEL = 'agentic-router proxy proof v1';
/** A nonce is 16 to 64 base64url characters (the helper sends 32 random bytes, 43 characters). */
export const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

export function proofOf(token: string, port: number, nonce: string): string {
  return createHmac('sha256', token).update(`${PROOF_LABEL}\n${port}\n${nonce}`).digest('base64url');
}

export function proofMatches(token: string, port: number, nonce: string, proof: unknown): boolean {
  if (typeof proof !== 'string') return false;
  const want = Buffer.from(proofOf(token, port, nonce));
  const got = Buffer.from(proof);
  return want.length === got.length && timingSafeEqual(want, got);
}

/**
 * Who answers on 127.0.0.1:port: 'ours' (the proof matches), 'other' (something answered, or held the TLS handshake,
 * without the proof) or 'down' (nothing listens). With `ca` the check runs over HTTPS trusting only that certificate.
 * The token is the HMAC key only; it is not sent.
 */
export function proveProxy(o: { port: number; token: string; ca?: string; timeoutMs?: number }): Promise<'ours' | 'other' | 'down'> {
  return new Promise(resolve => {
    const nonce = randomBytes(32).toString('base64url');
    const body = JSON.stringify({ nonce });
    const lib = o.ca ? https : http;
    const req = lib.request({
      host: '127.0.0.1', port: o.port, method: 'POST', path: PROOF_PATH, agent: false, timeout: o.timeoutMs ?? 1500,
      headers: { host: `127.0.0.1:${o.port}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      ...(o.ca ? { ca: o.ca } : {}),
    }, res => {
      const chunks: Buffer[] = [];
      let n = 0;
      res.on('data', (c: Buffer) => { n += c.length; if (n <= 4096) chunks.push(c); });
      res.on('error', () => resolve('other'));
      res.on('end', () => {
        let proof: unknown;
        try { proof = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { proof?: unknown }).proof; } catch { proof = undefined; }
        resolve(res.statusCode === 200 && proofMatches(o.token, o.port, nonce, proof) ? 'ours' : 'other');
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'ECONNREFUSED' ? 'down' : 'other'));
    req.end(body);
  });
}
