// Sealed calls from the plugin's own programs (relay, status line, MCP server) to the daemon (decision 156).
// Dependency-free copy of the client half of packages/core/src/seal.ts; a test checks that the two produce
// the same bytes and open each other's messages. See that file for the format and the reasons.
//
// The token is a shared secret read from the router home. It is never sent: each request and each answer
// is encrypted and authenticated with a key derived from it, so a program that took the daemon's port while
// the daemon was down can read nothing and cannot answer. There is no fallback to a call that sends the token.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import nodePath from 'node:path';

export const SEAL_VERSION = 1;
export const SEALED_PATH = '/router/v1/sealed';
const SALT = 'agentic-router seal v1';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class SealError extends Error {
  constructor(code, message) {
    super(message ?? `sealed message refused (${code})`);
    this.code = code;
  }
}

const keyFor = (secret, dir) => Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), SALT, dir, 32));
const requestAad = (t, n) => `v${SEAL_VERSION}|req|${t}|${n}`;
const responseAad = (requestNonce, t, n) => `v${SEAL_VERSION}|res|${requestNonce}|${t}|${n}`;

/** Seals one request ({ m: method, p: path with query, b?: body text }). Returns the envelope and the nonce the answer must be bound to. */
export function sealRequest(secret, inner, clock = {}) {
  const nonce = clock.nonce ?? randomBytes(NONCE_BYTES);
  const n = nonce.toString('base64url');
  const t = clock.now ?? Date.now();
  const c = createCipheriv('aes-256-gcm', keyFor(secret, 'req'), nonce);
  c.setAAD(Buffer.from(requestAad(t, n), 'utf8'));
  const sealed = Buffer.concat([c.update(JSON.stringify(inner), 'utf8'), c.final(), c.getAuthTag()]).toString('base64url');
  return { envelope: JSON.stringify({ v: SEAL_VERSION, n, t, c: sealed }), nonce: n };
}

/** Opens an answer: it must be sealed with the secret and bound to this request's nonce. Returns { s, ct, b }. */
export function openResponse(secret, requestNonce, envelopeText) {
  let e;
  try { e = JSON.parse(envelopeText); } catch { throw new SealError('format'); }
  if (!e || typeof e !== 'object' || typeof e.n !== 'string' || typeof e.c !== 'string' || typeof e.t !== 'number' || !Number.isFinite(e.t)) throw new SealError('format');
  if (e.v !== SEAL_VERSION) throw new SealError('version');
  if (!/^[A-Za-z0-9_-]{16}$/.test(e.n) || !/^[A-Za-z0-9_-]+$/.test(e.c)) throw new SealError('format');
  const raw = Buffer.from(e.c, 'base64url');
  if (raw.length < TAG_BYTES) throw new SealError('format');
  const d = createDecipheriv('aes-256-gcm', keyFor(secret, 'res'), Buffer.from(e.n, 'base64url'));
  d.setAAD(Buffer.from(responseAad(requestNonce, e.t, e.n), 'utf8'));
  d.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
  let text;
  try { text = Buffer.concat([d.update(raw.subarray(0, raw.length - TAG_BYTES)), d.final()]).toString('utf8'); } catch { throw new SealError('auth'); }
  let v;
  try { v = JSON.parse(text); } catch { throw new SealError('format'); }
  if (!v || typeof v !== 'object' || typeof v.s !== 'number' || typeof v.ct !== 'string' || typeof v.b !== 'string') throw new SealError('format');
  return v;
}

/**
 * How to reach the daemon of this router home (copy of core endpoint.ts daemonTarget). On macOS and Linux the
 * daemon also listens on a Unix socket in a directory only the user can enter and names it in
 * <home>/endpoint.json. A socket named there is used, and only it: when it cannot be reached the daemon is
 * down, and the TCP port is not tried. Without one (Windows, or a daemon that could not make a private
 * socket) it is the TCP port from the config.
 */
export function daemonTarget(home, configPort) {
  let e;
  try { e = JSON.parse(fs.readFileSync(nodePath.join(home, 'endpoint.json'), 'utf8')); } catch { e = undefined; }
  if (!e || typeof e !== 'object' || e.version !== 1 || !Number.isInteger(e.port)) e = undefined;
  if (e && e.socket !== undefined && !(typeof e.socket === 'string' && e.socket.length > 1 && e.socket.length < 4096)) e = undefined;
  if (e?.socket) return { port: e.port, socketPath: e.socket };
  const port = typeof configPort === 'number' && configPort > 0 ? configPort : e?.port;
  return typeof port === 'number' && port > 0 ? { port } : undefined;
}

/**
 * One sealed call to the daemon: { port, secret, method, path, body?, timeoutMs?, home?, socketPath? }.
 * With `home`, the daemon's endpoint file there decides between its Unix socket and the TCP port.
 * Resolves with { status, contentType, body } as the daemon answered. Rejects with a SealError when nothing
 * answered or when what answered does not hold the secret (an older daemon, or another program on the port).
 */
export function sealedCall({ port, secret, method, path, body, timeoutMs = 1500, home, socketPath }) {
  return new Promise((resolve, reject) => {
    // node:http is loaded lazily, as the callers did before, so a hook that never calls stays small
    import('node:http').then(({ request }) => {
      const { envelope, nonce } = sealRequest(secret, { m: method, p: path, ...(body !== undefined ? { b: body } : {}) });
      const named = socketPath === undefined && home !== undefined ? daemonTarget(home, port) : undefined;
      const sock = socketPath ?? named?.socketPath;
      const hostPort = named?.port ?? port;
      const req = request({
        ...(sock !== undefined ? { socketPath: sock } : { host: '127.0.0.1', port: hostPort }), method: 'POST', path: SEALED_PATH, agent: false, timeout: timeoutMs,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(envelope), host: `127.0.0.1:${hostPort}` },
      }, res => {
        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('error', () => reject(new SealError('unreachable')));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new SealError('not_sealed', `no sealed answer (HTTP ${res.statusCode})`));
          try {
            const inner = openResponse(secret, nonce, Buffer.concat(chunks).toString('utf8'));
            resolve({ status: inner.s, contentType: inner.ct, body: inner.b });
          } catch (e) {
            reject(e instanceof SealError ? e : new SealError('format'));
          }
        });
      });
      req.on('timeout', () => req.destroy(new SealError('unreachable', 'timeout')));
      req.on('error', e => reject(e instanceof SealError ? e : new SealError('unreachable')));
      req.end(envelope);
    }).catch(() => reject(new SealError('unreachable')));
  });
}
