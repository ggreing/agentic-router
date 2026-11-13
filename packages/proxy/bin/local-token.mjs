#!/usr/bin/env node
// Claude Code's apiKeyHelper in API-key mode (decision 130): prints the local proxy token, and nothing else
// (Claude Code rejects a helper that prints anything besides the credential). The real API key never reaches
// Claude Code; the token is read from <router home>/proxy-token (0600), never from settings.json.
//
// Decision 156: before printing, it checks that what listens on the proxy port is this router's proxy. It sends
// a random nonce to POST /proxy/v1/proof and accepts only HMAC-SHA256(token, label, port, nonce) in answer
// (src/proof.ts; a test keeps proofOf here equal to it). Another program on the port, which does not hold the
// token, cannot answer; the helper then prints nothing and exits 1, so Claude Code has no credential to send.
// With local TLS on (config.json proxy.tls), the check runs over HTTPS trusting only the router's certificate.
// The session that runs the helper sends to its own ANTHROPIC_BASE_URL: when that is in the helper's environment it
// must be this proxy as configured now (scheme for the TLS state, loopback host, port), else nothing is printed.
// Dependency-free: node built-ins only.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

export const PROOF_PATH = '/proxy/v1/proof';
// A wire label, not a name shown anywhere: it keeps the previous product name (decision 161), as the seal label does.
export const PROOF_LABEL = 'agentic-router proxy proof v1';
export const proofOf = (token, port, nonce) => createHmac('sha256', token).update(`${PROOF_LABEL}\n${port}\n${nonce}`).digest('base64url');
const TIMEOUT_MS = 3000;

export function routerHome(env = process.env) {
  const v = env.DO_IT_ALL_CLAUDE_CODE_HOME;
  return v && path.isAbsolute(v) ? v : path.join(os.homedir(), '.do-it-all-claude-code');
}

/** Resolves true only when the listener on 127.0.0.1:port answers the nonce with the right proof. */
export function proxyProves({ port, token, ca }) {
  return new Promise(resolve => {
    const nonce = randomBytes(32).toString('base64url');
    const body = JSON.stringify({ nonce });
    const lib = ca ? https : http;
    const req = lib.request({
      host: '127.0.0.1', port, method: 'POST', path: PROOF_PATH, agent: false, timeout: TIMEOUT_MS,
      headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      ...(ca ? { ca } : {}),
    }, res => {
      const chunks = [];
      res.on('data', c => { if (chunks.reduce((n, b) => n + b.length, 0) < 4096) chunks.push(c); });
      res.on('error', () => resolve(false));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(false);
        let proof;
        try { proof = JSON.parse(Buffer.concat(chunks).toString('utf8')).proof; } catch { return resolve(false); }
        if (typeof proof !== 'string') return resolve(false);
        const want = Buffer.from(proofOf(token, port, nonce));
        const got = Buffer.from(proof);
        resolve(want.length === got.length && timingSafeEqual(want, got));
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end(body);
  });
}

/**
 * Whether a base URL is this proxy: the scheme for the TLS state, host 127.0.0.1 (the address the proof is made to and
 * the only one the router writes: "localhost" may resolve to ::1, where another user can listen), the port.
 */
export function sameProxy(base, tls, port) {
  let u;
  try { u = new URL(base); } catch { return false; }
  const path = u.pathname.replace(/\/+$/, '');
  return u.protocol === (tls ? 'https:' : 'http:') && u.hostname === '127.0.0.1'
    && Number(u.port || (tls ? 443 : 80)) === port && !path && !u.search && !u.username && !u.password;
}
const originOf = base => { try { return new URL(base).origin; } catch { return '(not a URL)'; } };

export const PROBE_FILE = 'helper-probe.jsonl';
/**
 * Tests only (scripts/tls-live): with DO_IT_ALL_CLAUDE_CODE_HELPER_PROBE=1, one JSON line in <router home>/helper-probe.jsonl
 * says whether the helper saw ANTHROPIC_BASE_URL and whether it matched; the value itself is never written. No path is
 * taken from the environment (a project's settings env reaches the helper), and the file is not followed if it is a
 * link.
 */
function probe(env, home, baseUrl, matches) {
  if (env.DO_IT_ALL_CLAUDE_CODE_HELPER_PROBE !== '1') return;
  const f = path.join(home, PROBE_FILE);
  try {
    try { if (fs.lstatSync(f).isSymbolicLink()) return; } catch { /* not there yet */ }
    const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0);
    const fd = fs.openSync(f, flags, 0o600);
    try { fs.writeSync(fd, `${JSON.stringify({ at: new Date().toISOString(), baseUrl, matches })}\n`); } finally { fs.closeSync(fd); }
  } catch { /* a probe only */ }
}

function fail(message) {
  process.stderr.write(`do-it-all-claude-code: ${message}\n`);
  process.exit(1);
}

export async function main(env = process.env) {
  const home = routerHome(env);
  let token;
  try { token = fs.readFileSync(path.join(home, 'proxy-token'), 'utf8').trim(); } catch { /* below */ }
  if (!token) return fail('no local proxy token (run do-it-all-claude-code init --mode api)');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')); } catch { /* below */ }
  const port = cfg && Number.isInteger(cfg.proxyPort) ? cfg.proxyPort : 0;
  if (!(port > 0 && port < 65536)) return fail('no proxy port in config.json (run do-it-all-claude-code init --mode api)');
  const tls = !!(cfg.proxy && cfg.proxy.tls === true);
  // The session that runs this helper sends its requests to its ANTHROPIC_BASE_URL, which may be older than the
  // config (a port or TLS change since it started). The proof below checks the port in config.json, so the session's
  // own base URL must be that proxy too; otherwise the token could go to whatever now holds the session's old port.
  const expected = `${tls ? 'https' : 'http'}://127.0.0.1:${port}`;
  const base = typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL.trim() : '';
  const matches = base ? sameProxy(base, tls, port) : null;
  probe(env, home, base ? 'set' : 'unset', matches);
  if (base && !matches) {
    return fail(`this Claude Code session sends to ${originOf(base)}, but the router's proxy is now ${expected}: restart Claude Code; `
      + 'if it was just started, run do-it-all-claude-code mode api (its settings and config.json disagree) (no token given out)');
  }
  let ca;
  if (tls) {
    try { ca = fs.readFileSync(path.join(home, 'tls', 'proxy-cert.pem'), 'utf8'); } catch { return fail('local TLS is on but its certificate is missing (run do-it-all-claude-code mode api)'); }
  }
  if (!(await proxyProves({ port, token, ca }))) {
    return fail(`the program on 127.0.0.1:${port} is not this router's proxy, or the proxy is not running: no token given out (do-it-all-claude-code doctor says more)`);
  }
  process.stdout.write(token);
}

// run as Claude Code's helper (imported by tests otherwise)
const self = process.argv[1] ? path.resolve(process.argv[1]) : '';
let here = '';
try { here = fs.realpathSync(new URL(import.meta.url)); } catch { /* not a file URL */ }
let entry = '';
try { entry = fs.realpathSync(self); } catch { entry = self; }
if (here && entry === here) await main();
