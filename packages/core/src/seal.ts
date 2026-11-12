// Sealed messages between the router's own clients and the daemon (decision 156).
//
// The daemon listens on a 127.0.0.1 port. That separates machines, not users: while the daemon is down,
// another local user can bind the port, and a client that opens with "Authorization: Bearer <token>" hands
// that listener the token and then the hook data. So the token is never sent. Client and daemon both read
// it from the router home and use it as a shared secret: every request and every answer is encrypted and
// authenticated with a key derived from it. A listener without the secret can read nothing, cannot produce
// an answer the client accepts, and gains nothing by passing messages on to the real daemon.
//
//   POST /router/v1/sealed        body: { v, n, t, c }
//     v  format version (1)
//     n  12 random bytes, base64url: the AES-GCM nonce
//     t  sender's clock, ms since the epoch
//     c  AES-256-GCM ciphertext followed by the 16-byte tag, base64url
//   request plaintext   { m: method, p: path with query, b?: body text }
//   response plaintext  { s: status, ct: content type, b: body text }
//
// Keys: HKDF-SHA256(secret, salt "agentic-router seal v1", info "req" | "res"), one per direction.
// Bound in as associated data: version, direction, t and n; for a response also the request's nonce, so an
// answer is good for one request only. The daemon refuses a request whose t is outside the window or whose
// nonce it has seen inside the window (a recorded request cannot be played again).
//
// plugin/hooks/seal.mjs is a dependency-free copy of the client half; a test checks that the two produce
// the same bytes and open each other's messages.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import http from 'node:http';

export const SEAL_VERSION = 1;
export const SEALED_PATH = '/router/v1/sealed';
/** How far a request's clock may be from the daemon's, and how long its nonce is remembered. Same machine, so small. */
export const SEAL_WINDOW_MS = 120_000;
const SALT = 'agentic-router seal v1';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export type SealErrorCode = 'format' | 'version' | 'auth' | 'stale' | 'replay' | 'unreachable' | 'not_sealed';
/** Why a sealed message was not accepted. Nothing about the secret or the content is in the message. */
export class SealError extends Error {
  readonly code: SealErrorCode;
  constructor(code: SealErrorCode, message?: string) {
    super(message ?? `sealed message refused (${code})`);
    this.code = code;
  }
}

export interface SealedRequest { m: string; p: string; b?: string }
export interface SealedResponse { s: number; ct: string; b: string }
export interface SealClock { now?: number; nonce?: Buffer }

const keyFor = (secret: string, dir: 'req' | 'res'): Buffer => Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), SALT, dir, 32));

function seal(key: Buffer, aad: string, plaintext: string, nonce: Buffer): string {
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from(aad, 'utf8'));
  return Buffer.concat([c.update(plaintext, 'utf8'), c.final(), c.getAuthTag()]).toString('base64url');
}
function open(key: Buffer, aad: string, nonce: Buffer, sealed: string): string {
  const raw = Buffer.from(sealed, 'base64url');
  if (nonce.length !== NONCE_BYTES || raw.length < TAG_BYTES) throw new SealError('format');
  const d = createDecipheriv('aes-256-gcm', key, nonce);
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
  try {
    return Buffer.concat([d.update(raw.subarray(0, raw.length - TAG_BYTES)), d.final()]).toString('utf8');
  } catch {
    throw new SealError('auth');
  }
}

interface Envelope { v: number; n: string; t: number; c: string }
function parseEnvelope(text: string): Envelope {
  let e: unknown;
  try { e = JSON.parse(text); } catch { throw new SealError('format'); }
  const o = e as Partial<Envelope> | null;
  if (!o || typeof o !== 'object' || typeof o.n !== 'string' || typeof o.c !== 'string' || typeof o.t !== 'number' || !Number.isFinite(o.t)) throw new SealError('format');
  if (o.v !== SEAL_VERSION) throw new SealError('version');
  if (!/^[A-Za-z0-9_-]{16}$/.test(o.n) || !/^[A-Za-z0-9_-]+$/.test(o.c)) throw new SealError('format');
  return o as Envelope;
}
function parseInner<T>(text: string, ok: (v: Record<string, unknown>) => boolean): T {
  let v: unknown;
  try { v = JSON.parse(text); } catch { throw new SealError('format'); }
  if (!v || typeof v !== 'object' || Array.isArray(v) || !ok(v as Record<string, unknown>)) throw new SealError('format');
  return v as T;
}
const requestAad = (t: number, n: string) => `v${SEAL_VERSION}|req|${t}|${n}`;
const responseAad = (requestNonce: string, t: number, n: string) => `v${SEAL_VERSION}|res|${requestNonce}|${t}|${n}`;

/** Seals one request. Returns the envelope text to send and the nonce the answer must be bound to. */
export function sealRequest(secret: string, inner: SealedRequest, clock: SealClock = {}): { envelope: string; nonce: string } {
  const nonce = clock.nonce ?? randomBytes(NONCE_BYTES);
  const n = nonce.toString('base64url');
  const t = clock.now ?? Date.now();
  const c = seal(keyFor(secret, 'req'), requestAad(t, n), JSON.stringify(inner), nonce);
  return { envelope: JSON.stringify({ v: SEAL_VERSION, n, t, c }), nonce: n };
}

/** The nonces seen inside the window, so that a recorded request cannot be sent again. */
export class NonceWindow {
  readonly #seen = new Map<string, number>();
  readonly #windowMs: number;
  readonly #max: number;
  constructor(windowMs: number = SEAL_WINDOW_MS, max = 50_000) {
    this.#windowMs = windowMs;
    this.#max = max;
  }
  /** Records the nonce; false when it was seen before inside the window. */
  take(nonce: string, now: number): boolean {
    if (this.#seen.size >= this.#max / 2) for (const [n, until] of this.#seen) if (until <= now) this.#seen.delete(n);
    const until = this.#seen.get(nonce);
    if (until !== undefined && until > now) return false;
    if (this.#seen.size >= this.#max) return false;        // full of live nonces: refuse rather than forget one
    this.#seen.set(nonce, now + 2 * this.#windowMs);
    return true;
  }
  get size(): number { return this.#seen.size; }
}

/** Opens a request on the daemon side. Throws SealError; the caller answers every code the same way. */
export function openRequest(secret: string, envelopeText: string, opts: { now?: number; seen?: NonceWindow; windowMs?: number } = {}): { inner: SealedRequest; nonce: string } {
  const e = parseEnvelope(envelopeText);
  const inner = parseInner<SealedRequest>(open(keyFor(secret, 'req'), requestAad(e.t, e.n), Buffer.from(e.n, 'base64url'), e.c),
    v => typeof v.m === 'string' && typeof v.p === 'string' && v.p.startsWith('/') && (v.b === undefined || typeof v.b === 'string'));
  // only after the message proved itself: time and replay (an attacker without the secret learns nothing from these)
  const now = opts.now ?? Date.now();
  if (Math.abs(now - e.t) > (opts.windowMs ?? SEAL_WINDOW_MS)) throw new SealError('stale');
  if (opts.seen && !opts.seen.take(e.n, now)) throw new SealError('replay');
  return { inner, nonce: e.n };
}

/** Seals the answer to the request with that nonce. */
export function sealResponse(secret: string, requestNonce: string, inner: SealedResponse, clock: SealClock = {}): string {
  const nonce = clock.nonce ?? randomBytes(NONCE_BYTES);
  const n = nonce.toString('base64url');
  const t = clock.now ?? Date.now();
  const c = seal(keyFor(secret, 'res'), responseAad(requestNonce, t, n), JSON.stringify(inner), nonce);
  return JSON.stringify({ v: SEAL_VERSION, n, t, c });
}

/** Opens an answer on the client side: it must be sealed with the secret and bound to this request's nonce. */
export function openResponse(secret: string, requestNonce: string, envelopeText: string): SealedResponse {
  const e = parseEnvelope(envelopeText);
  return parseInner<SealedResponse>(open(keyFor(secret, 'res'), responseAad(requestNonce, e.t, e.n), Buffer.from(e.n, 'base64url'), e.c),
    v => typeof v.s === 'number' && typeof v.ct === 'string' && typeof v.b === 'string');
}

export interface SealedCall { port: number; secret: string; method: string; path: string; body?: string; timeoutMs?: number; host?: string }

/**
 * One sealed call to the daemon (node:http, never fetch: an HTTP_PROXY setting must not see it).
 * Resolves with the daemon's own status, content type and body. Rejects with a SealError when nothing
 * answered ('unreachable') or when what answered is not the daemon that holds the secret ('not_sealed',
 * 'auth', …): an older daemon without this route, or another program on the port. The secret is never sent,
 * and there is no fallback to a call that would send it.
 */
export function sealedCall(o: SealedCall): Promise<{ status: number; contentType: string; body: string }> {
  return new Promise((resolve, reject) => {
    const { envelope, nonce } = sealRequest(o.secret, { m: o.method, p: o.path, ...(o.body !== undefined ? { b: o.body } : {}) });
    const host = o.host ?? '127.0.0.1';
    const req = http.request({
      host, port: o.port, method: 'POST', path: SEALED_PATH, agent: false, timeout: o.timeoutMs ?? 1500,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(envelope), host: `${host}:${o.port}` },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', d => chunks.push(d as Buffer));
      res.on('error', () => reject(new SealError('unreachable')));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new SealError('not_sealed', `no sealed answer (HTTP ${res.statusCode})`));
        try {
          const inner = openResponse(o.secret, nonce, Buffer.concat(chunks).toString('utf8'));
          resolve({ status: inner.s, contentType: inner.ct, body: inner.b });
        } catch (e) {
          reject(e instanceof SealError ? e : new SealError('format'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new SealError('unreachable', 'timeout')));
    req.on('error', e => reject(e instanceof SealError ? e : new SealError('unreachable')));
    req.end(envelope);
  });
}
