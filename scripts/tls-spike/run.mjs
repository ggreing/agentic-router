#!/usr/bin/env node
// Local-TLS spike for API-key mode (decision 156). Does the Claude Code binary accept
// ANTHROPIC_BASE_URL=https://127.0.0.1:<port> with a private self-signed certificate trusted through
// NODE_EXTRA_CA_CERTS? And, without trust, does it fail with a TLS error rather than silently falling back
// to plain HTTP?
//
// It reuses the shape of scripts/guard-e2e: a real `claude -p` is driven against a local fake that listens
// on 127.0.0.1 only, with a fresh temp config dir (no login) and a dummy key that only the fake accepts.
// The difference is that the fake speaks HTTPS with a throwaway self-signed cert, and the prompt is tiny.
// No API call is made and nothing is billed. Your own ~/.claude and ~/.agentic-router are not touched.
//
// Cases (one tiny prompt each):
//   no-trust      host 127.0.0.1, cert not trusted                 -> expect a TLS error (no silent http)
//   env-process   host 127.0.0.1, NODE_EXTRA_CA_CERTS in the env   -> expect connected  (the (a) / IP-SAN case)
//   env-settings  host 127.0.0.1, NODE_EXTRA_CA_CERTS in settings  -> report which      (the (b) case)
//   localhost     host localhost, same cert via its DNS SAN        -> expect connected  (the (c) localhost case)
//
// The cert carries both SANs (IP:127.0.0.1 and DNS:localhost), so the same cert serves every case and the
// 127.0.0.1 cases exercise the IP SAN while the localhost case exercises the DNS SAN.
//
// Usage:
//   node scripts/tls-spike/run.mjs                 # all cases (starts a real claude per case)
//   node scripts/tls-spike/run.mjs --only=no-trust # one case
//   node scripts/tls-spike/run.mjs --selftest      # cert + fake only, no claude (safe to run anywhere)
//   node scripts/tls-spike/run.mjs --keep          # keep the temp dir (cert, configs, summary) for inspection
// Env: CLAUDE_BIN=<path> (default "claude"), OPENSSL_BIN=<path> (default "openssl"), --timeout=<seconds>.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { startFakeTls } from './fake-tls.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = n => process.argv.find(a => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const flag = n => process.argv.includes(`--${n}`);
const posix = p => p.replace(/\\/g, '/');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const WIN = process.platform === 'win32';
const TIMEOUT_MS = Number(arg('timeout') ?? 120) * 1000;

// ---------------------------------------------------------------- openssl + cert

/** Finds openssl: OPENSSL_BIN, then PATH, then the one Git for Windows ships. */
function findOpenssl() {
  const candidates = [process.env.OPENSSL_BIN, 'openssl'];
  if (WIN) candidates.push('C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe');
  for (const c of candidates) {
    if (!c) continue;
    try { if (spawnSync(c, ['version'], { encoding: 'utf8' }).status === 0) return c; } catch { /* next */ }
  }
  return null;
}

// A config-file request is used rather than `-addext` so the one command works on old OpenSSL, OpenSSL 3,
// and the LibreSSL that ships with macOS. The cert is its own CA (self-signed) so it validates as a trust
// anchor when added through NODE_EXTRA_CA_CERTS.
const OPENSSL_CNF = `[req]
distinguished_name = dn
x509_extensions = v3ext
prompt = no
[dn]
CN = agentic-router-tls-spike
[v3ext]
subjectAltName = IP:127.0.0.1, DNS:localhost
basicConstraints = critical, CA:TRUE
keyUsage = critical, digitalSignature, keyCertSign
`;

function makeCert(openssl, dir) {
  const certPath = path.join(dir, 'cert.pem'), keyPath = path.join(dir, 'key.pem'), cnfPath = path.join(dir, 'openssl.cnf');
  fs.writeFileSync(cnfPath, OPENSSL_CNF);
  const args = ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '2', '-config', cnfPath];
  const r = spawnSync(openssl, args, { encoding: 'utf8' });
  const command = `${/\s/.test(openssl) ? `"${openssl}"` : openssl} ${args.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`;
  if (r.status !== 0) throw new Error(`openssl failed (status ${r.status}): ${(r.stderr || r.error?.message || '').trim()}\n  command: ${command}`);
  return { certPath, keyPath, cnfPath, command, cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
}

// ---------------------------------------------------------------- the cases

const CASES = [
  { name: 'no-trust',     host: '127.0.0.1', trust: 'none',     expect: 'tls-error', note: 'self-signed cert, no CA trusted anywhere' },
  { name: 'env-process',  host: '127.0.0.1', trust: 'process',  expect: 'connected', note: 'NODE_EXTRA_CA_CERTS in the process env (case a; IP SAN)' },
  { name: 'env-settings', host: '127.0.0.1', trust: 'settings', expect: 'report',    note: 'NODE_EXTRA_CA_CERTS only in settings.json env (case b)' },
  { name: 'localhost',    host: 'localhost', trust: 'process',  expect: 'connected', note: 'same cert via its DNS SAN localhost (case c)' },
];

/** A clean environment: nothing of a surrounding Claude Code session, no real credential, and no ambient
 *  proxy (this spike is about TLS, not the proxy; NO_PROXY is set so a loopback request never leaves). */
function cleanEnv(base, extra) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    // a prefix match: CLAUDE_CODE_*, ANTHROPIC_*, NODE_TLS_REJECT_UNAUTHORIZED and the rest never reach the child
    if (/^(?:CLAUDE|ANTHROPIC|AWS_BEARER|MCP_|ENABLE_TOOL_SEARCH|AGENTIC_ROUTER|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT|HTTPS?_PROXY|NO_PROXY)/i.test(k)) continue;
    env[k] = v;
  }
  return Object.assign(env, extra);
}

function configDirFor(root, c, certPath) {
  const dir = path.join(root, `config-${c.name}`);
  fs.mkdirSync(dir, { recursive: true });
  const settings = { apiKeyHelper: `node "${posix(path.join(HERE, 'key-helper.mjs'))}"` };
  if (c.trust === 'settings') settings.env = { NODE_EXTRA_CA_CERTS: certPath };
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
  return dir;
}

function envFor(c, port, configDir, certPath) {
  const extra = {
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: `https://${c.host}:${port}`,
    NO_PROXY: '127.0.0.1,localhost,::1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    ENABLE_TOOL_SEARCH: 'false',
  };
  if (c.trust === 'process') extra.NODE_EXTRA_CA_CERTS = certPath;   // case b must NOT set it here, or the settings value is ignored
  return cleanEnv(process.env, extra);
}

// ---------------------------------------------------------------- running claude

function runClaude({ args, stdin, env }) {
  return new Promise(resolve => {
    const bin = process.env.CLAUDE_BIN || 'claude';
    const started = Date.now();
    let out = '', err = '', timedOut = false, child;
    try { child = spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: /\.(cmd|bat)$/i.test(bin) }); }
    catch (e) { return resolve({ spawnError: String(e && e.message), durationMs: 0 }); }
    const timer = setTimeout(() => { timedOut = true; try { WIN ? spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }) : child.kill('SIGKILL'); } catch { /* gone */ } }, TIMEOUT_MS);
    child.stdout.on('data', d => { if (out.length < 400_000) out += d; });
    child.stderr.on('data', d => { if (err.length < 200_000) err += d; });
    child.on('error', e => { clearTimeout(timer); resolve({ spawnError: String(e && e.message), durationMs: Date.now() - started }); });
    child.on('close', code => { clearTimeout(timer); resolve({ exitCode: code, timedOut, durationMs: Date.now() - started, stdout: out, stderr: err }); });
    child.stdin.on('error', () => { /* the child may exit before reading */ });
    child.stdin.end(stdin);
  });
}

// signatures of a certificate / TLS failure in undici-or-node text
const TLS_RE = /self[\s-]?signed certificate|unable to (?:get|verify)|unable_to_verify|SELF_SIGNED_CERT|DEPTH_ZERO_SELF_SIGNED|CERT_HAS_EXPIRED|ERR_TLS|ALTNAME|altname|UNABLE_TO_|CERT_UNTRUSTED|ssl routines|tlsv1|handshake|certificate/i;
const DOWNGRADE_RE = /wrong version number|http request|packet length too long/i;

function classify(c, r, fake) {
  const connected = fake.entries.length > 0;                         // a parsed HTTP request means the handshake succeeded
  let parsed = null; try { parsed = JSON.parse(r.stdout || ''); } catch { /* not JSON */ }
  const resultText = parsed && typeof parsed.result === 'string' ? parsed.result : '';
  const hay = `${resultText}\n${r.stderr || ''}\n${connected ? '' : r.stdout || ''}`;
  const downgrade = fake.tlsErrors.find(e => DOWNGRADE_RE.test(e.message));
  let outcome;
  if (connected) outcome = 'connected';
  else if (r.spawnError) outcome = 'spawn-error';
  else if (r.timedOut) outcome = 'timeout';
  else if (TLS_RE.test(hay)) outcome = 'tls-error';
  else outcome = 'other';
  // the debug lines that prove whether the extra CA actually loaded, and how the proxy was treated
  const debugLines = (r.stderr || '').split(/\r?\n/).filter(l => /CA certs:|Appended extra certificates|NODE_EXTRA_CA_CERTS|Proxy|proxy/.test(l)).slice(0, 8);
  const errText = connected ? '' : (TLS_RE.exec(hay)?.[0] ? firstErrorSentence(hay) : (resultText || (r.stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || '')).slice(0, 300);
  return {
    case: c.name, host: c.host, trust: c.trust, expect: c.expect, outcome,
    met: c.expect === 'report' ? null : (c.expect === 'connected' ? outcome === 'connected' : outcome === 'tls-error'),
    requestsSeen: fake.entries.length, actions: [...new Set(fake.entries.map(e => e.action))], credentials: [...new Set(fake.entries.map(e => e.credential))],
    tlsHandshakeErrors: fake.tlsErrors.map(e => e.message), plainHttpDowngrade: !!downgrade,
    exitCode: r.exitCode ?? null, timedOut: !!r.timedOut, durationMs: r.durationMs, spawnError: r.spawnError ?? null,
    errorText: errText, debugLines,
  };
}
function firstErrorSentence(hay) {
  const i = hay.search(TLS_RE);
  return i < 0 ? hay.trim().slice(0, 300) : hay.slice(Math.max(0, i - 40), i + 160).replace(/\s+/g, ' ').trim();
}

async function runCase(c, ctx) {
  const configDir = configDirFor(ctx.root, c, ctx.cert.certPath);
  const env = envFor(c, ctx.fake.port, configDir, ctx.cert.certPath);
  const args = ['-p', '--debug', '--model', 'sonnet', '--max-turns', '2', '--output-format', 'json'];
  ctx.fake.reset();
  const r = await runClaude({ args, stdin: 'Reply with just the word: ping', env });
  await sleep(400);
  return classify(c, r, ctx.fake);
}

// ---------------------------------------------------------------- selftest (no claude)

/** Confirms the cert and the fake without claude: a trusted Node client must connect to each host, and an
 *  untrusted client must be rejected with a cert error. This does NOT test Claude Code's own trust reading
 *  (settings vs process is only distinguishable by the real run); it treats both trusted cases as "with ca". */
function httpsProbe({ host, port, ca }) {
  return new Promise(resolve => {
    const isIp = /^[\d.]+$|:/.test(host);   // servername for an IP literal is ignored (RFC 6066) and warns
    const req = https.request({ host, port, path: '/api/hello', method: 'GET', ...(isIp ? {} : { servername: host }), ...(ca ? { ca } : {}) }, res => {
      res.resume(); res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode }));
    });
    req.on('error', e => resolve({ ok: false, error: e.code || e.message }));
    req.end();
  });
}
async function selftest(ctx) {
  const lines = [];
  for (const c of CASES) {
    const trusted = c.trust !== 'none';
    const r = await httpsProbe({ host: c.host, port: ctx.fake.port, ca: trusted ? [ctx.cert.cert] : undefined });
    const want = trusted ? r.ok : !r.ok;
    lines.push({ case: c.name, host: c.host, trusted, got: r.ok ? `connected (${r.status})` : `rejected (${r.error})`, pass: want });
    console.log(`  ${c.name.padEnd(13)} host=${c.host.padEnd(10)} trust=${trusted ? 'ca' : 'none '} -> ${r.ok ? `connected (${r.status})` : `rejected (${r.error})`}  ${want ? 'OK' : 'UNEXPECTED'}`);
  }
  return lines;
}

// ---------------------------------------------------------------- main

async function main() {
  const only = arg('only');
  const cases = only ? CASES.filter(c => c.name === only) : CASES;
  if (only && !cases.length) { console.error(`no such case: ${only} (have: ${CASES.map(c => c.name).join(', ')})`); process.exit(2); }

  const openssl = findOpenssl();
  if (!openssl) { console.error('openssl not found. Set OPENSSL_BIN, or install Git for Windows / openssl.'); process.exit(2); }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-tls-spike-'));
  let cert, fake;
  try {
    cert = makeCert(openssl, root);
    fake = await startFakeTls({ cert: cert.cert, key: cert.key, host: '127.0.0.1' });
    const ctx = { root, cert, fake };

    console.log(`openssl: ${spawnSync(openssl, ['version'], { encoding: 'utf8' }).stdout.trim()}`);
    console.log(`cert command:\n  ${cert.command}`);
    console.log(`fake HTTPS upstream on https://127.0.0.1:${fake.port} (SANs: IP:127.0.0.1, DNS:localhost)\n`);

    let results;
    if (flag('selftest')) {
      console.log('selftest (no claude): a trusted client must connect, an untrusted one must be rejected\n');
      results = await selftest(ctx);
    } else {
      const bin = process.env.CLAUDE_BIN || 'claude';
      const ver = (() => { try { return spawnSync(bin, ['--version'], { encoding: 'utf8', windowsHide: true, shell: /\.(cmd|bat)$/i.test(bin) }).stdout.trim(); } catch { return '(claude --version failed)'; } })();
      console.log(`claude: ${ver}\n`);
      results = [];
      for (const c of cases) {
        process.stdout.write(`${c.name.padEnd(13)} [${c.host}] ... `);
        const res = await runCase(c, ctx);
        const verdict = res.outcome === 'connected' ? 'connected' : res.outcome === 'tls-error' ? 'TLS error' : res.outcome;
        const mark = res.met === null ? '(report)' : res.met ? 'as expected' : 'UNEXPECTED';
        console.log(`${verdict}  [${mark}]  ${res.durationMs} ms`);
        if (res.errorText) console.log(`    error: ${res.errorText}`);
        if (res.debugLines.length) console.log(`    debug: ${res.debugLines[0]}`);
        if (res.plainHttpDowngrade) console.log(`    WARNING: plain-HTTP bytes hit the HTTPS port -> a silent downgrade: ${res.tlsHandshakeErrors[0]}`);
        results.push(res);
      }
    }
    const summary = { at: new Date().toISOString(), platform: process.platform, node: process.version, opensslVersion: spawnSync(openssl, ['version'], { encoding: 'utf8' }).stdout.trim(), certCommand: cert.command, fakePort: fake.port, mode: flag('selftest') ? 'selftest' : 'claude', results };
    const summaryPath = path.join(root, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
    console.log(`\nsummary: ${summaryPath}`);

    const bad = flag('selftest') ? results.some(r => !r.pass) : results.some(r => r.met === false || r.plainHttpDowngrade);
    if (!flag('keep')) { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } }
    else console.log(`kept: ${root}`);
    process.exit(bad ? 1 : 0);
  } catch (e) {
    console.error(`\nspike failed: ${e && e.message}`);
    try { await fake?.close(); } catch { /* */ }
    if (!flag('keep')) { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } }
    process.exit(2);
  } finally {
    try { await fake?.close(); } catch { /* */ }
  }
}

main();
