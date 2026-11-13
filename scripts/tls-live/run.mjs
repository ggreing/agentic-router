#!/usr/bin/env node
// Live check of the local-TLS proxy path (decisions 156-158) with a real Claude Code. Like scripts/tls-spike, it
// drives `claude -p` with a fresh temp config dir (no login) against loopback only, but through the router's own
// pieces: the certificate made by the CLI's localtls.ts (openssl), the real proxy (packages/proxy createProxy) serving
// HTTPS with it, and the real apiKeyHelper (packages/proxy/bin/local-token.mjs), which checks the proxy's proof before
// it prints the local token. The proxy forwards to a fake Messages API on 127.0.0.1 with a dummy key that only the fake
// accepts. No API call is made and nothing is billed; your own ~/.claude and ~/.agentic-router are not read or changed.
//
// Cases through the router's proxy (one tiny prompt each):
//   tls          settings env: https base URL + NODE_EXTRA_CA_CERTS = the router's leaf certificate -> connected; also
//                reports whether the helper saw ANTHROPIC_BASE_URL in its environment (review M1)
//   restart      the proxy restarts (a fresh local token) between two runs  -> the old token gets 401; the next run connects
//   squatter     another program holds the proxy port (its own certificate) -> the helper prints nothing; no request reaches it
//   shell-ca     settings: the bundle (the user's CA + ours); launch env: the user's CA  -> connected (decision 158)
//   precedence   settings: ours only; launch env: the user's CA only  -> connected (pins "settings replaces launch")
//   plain        local TLS off (the no-openssl fallback): http base URL  -> connected, through the proof-checking helper
// Certificate-shape cases (a fake HTTPS API straight, a dummy-key helper), review of decision 157:
//   minted-leaf  trusted: the router's leaf (CA:FALSE); served: a leaf made with its key, with the chain  -> TLS error
//   control-ca   trusted: the older CA:TRUE shape; served: a leaf made with its key, with the chain  -> connected
//   nc-anchor    trusted: CA:TRUE pathlen 0 with critical nameConstraints (127.0.0.1, localhost); served: itself -> connected
//   nc-minted    the same anchor; served: a leaf it made for 127.0.0.2, on 127.0.0.2  -> TLS error (skipped on macOS)
//
// Usage: node scripts/tls-live/run.mjs [--only=<case>] [--keep] [--timeout=<seconds>] [--selftest]
//   --selftest: no claude; the helper and one HTTPS request stand in for it (checks this script's own plumbing)
// Env: CLAUDE_BIN=<path> (default "claude"), OPENSSL_BIN=<path> (else PATH, else Git for Windows' openssl).
import { execFile, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const { ensureProxyCert, findOpenssl, tlsPaths, writeBundle } = await import(new URL('../../packages/cli/src/localtls.ts', import.meta.url).href);
const { createProxy } = await import(new URL('../../packages/proxy/src/server.ts', import.meta.url).href);
const { checkUpstream } = await import(new URL('../../packages/proxy/src/config.ts', import.meta.url).href);
const { LocalTokens } = await import(new URL('../../packages/proxy/src/token.ts', import.meta.url).href);
const { proxyPaths } = await import(new URL('../../packages/proxy/src/paths.ts', import.meta.url).href);
const { fileLogger, Masker } = await import(new URL('../../packages/proxy/src/log.ts', import.meta.url).href);

const arg = n => process.argv.find(a => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const flag = n => process.argv.includes(`--${n}`);
const posix = p => p.replace(/\\/g, '/');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const WIN = process.platform === 'win32';
const TIMEOUT_MS = Number(arg('timeout') ?? 120) * 1000;
const DUMMY_KEY = 'tls-live-dummy-key';
const MARKER = 'TLS_LIVE_OK';

// ---------------------------------------------------------------- fake Messages API (http, or https with a given cert)
function startFakeApi(o = {}) {
  const seen = [];
  const usage = { input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const handler = (req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const key = req.headers['x-api-key'] ?? String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      seen.push({ method: req.method, path: (req.url ?? '').split('?')[0], key: key === DUMMY_KEY ? 'dummy' : key ? 'other' : 'none' });
      if ((req.url ?? '').startsWith('/api/hello')) { res.writeHead(200, { 'content-length': 0 }); return res.end(); }
      if (key !== DUMMY_KEY) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"type":"error","error":{"type":"authentication_error","message":"fake: dummy key only"}}'); }
      if ((req.url ?? '').startsWith('/v1/messages/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"input_tokens":10}'); }
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not needed */ }
      const msg = { id: `msg_live_${Date.now()}`, type: 'message', role: 'assistant', model: body.model || 'claude-sonnet-5-5', content: [{ type: 'text', text: MARKER }], stop_reason: 'end_turn', stop_sequence: null, usage };
      if (body.stream !== true) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(msg)); }
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      ev('message_start', { message: { ...msg, content: [], usage: { ...usage, output_tokens: 1 } } });
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: MARKER } });
      ev('content_block_stop', { index: 0 });
      ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } });
      ev('message_stop', {});
      res.end();
    });
  };
  const server = o.tls ? https.createServer({ cert: o.tls.cert, key: o.tls.key }, handler) : http.createServer(handler);
  const handshakes = [];
  server.on('tlsClientError', e => handshakes.push(String(e?.message).slice(0, 120)));
  const host = o.host ?? '127.0.0.1';
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve({ port: server.address().port, host, seen, handshakes, close: () => new Promise(r => { server.closeAllConnections(); server.close(() => r()); }) }));
  });
}

// ---------------------------------------------------------------- certificates for the shape cases (openssl)
function opensslRun(openssl, args) {
  const r = spawnSync(openssl, args, { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`openssl ${args[0]} failed: ${(r.stderr || '').trim().split('\n')[0]}`);
}
/** A self-signed certificate with the given v3 extension lines. */
function selfSigned(openssl, dir, name, ext) {
  fs.mkdirSync(dir, { recursive: true });
  const cnf = path.join(dir, `${name}.cnf`);
  fs.writeFileSync(cnf, `[req]\ndistinguished_name = dn\nx509_extensions = v3ext\nprompt = no\n[dn]\nCN = tls-live ${name}\n[v3ext]\n${ext}\n`);
  const key = path.join(dir, `${name}.key`), cert = path.join(dir, `${name}.pem`);
  opensslRun(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-keyout', key, '-out', cert, '-days', '2', '-config', cnf]);
  return { cert, key };
}
/** A leaf for `san` signed with an issuer's key (the issuer need not be a CA: that is what the shape cases test). */
function mint(openssl, dir, name, issuer, san) {
  const cnf = path.join(dir, `${name}.cnf`);
  fs.writeFileSync(cnf, `[req]\ndistinguished_name = dn\nprompt = no\n[dn]\nCN = tls-live ${name}\n[v3]\nsubjectAltName = ${san}\nbasicConstraints = critical, CA:FALSE\nkeyUsage = critical, digitalSignature\nextendedKeyUsage = serverAuth\n`);
  const key = path.join(dir, `${name}.key`), csr = path.join(dir, `${name}.csr`), cert = path.join(dir, `${name}.pem`);
  opensslRun(openssl, ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-config', cnf]);
  opensslRun(openssl, ['x509', '-req', '-in', csr, '-CA', issuer.cert, '-CAkey', issuer.key, '-set_serial', String(Date.now()), '-days', '1', '-sha256', '-extfile', cnf, '-extensions', 'v3', '-out', cert]);
  return { cert, key };
}

// ---------------------------------------------------------------- the router's proxy, in this process
async function startProxy(home, port, fakePort, tls) {
  const paths = proxyPaths(home);
  LocalTokens.freshAtStart(paths.proxyToken);   // what main.ts does at every start
  const masker = new Masker();
  const proxy = createProxy({
    paths, tokens: new LocalTokens(paths.proxyToken), log: fileLogger(paths.log, masker), key: { get: () => DUMMY_KEY }, daemon: () => undefined,
    settings: { upstream: checkUpstream('', [], `http://127.0.0.1:${fakePort}`).url, tokenDailyCapUsd: 100, dailyCapUsd: 300, headersTimeoutMs: 30_000,
      ...(tls ? { tls: { certFile: paths.tlsCert, keyFile: paths.tlsKey } } : {}) },
    reporter: { batchMs: 100 },
  });
  await proxy.listen(port);
  return { proxy, token: () => fs.readFileSync(paths.proxyToken, 'utf8').trim(), close: () => proxy.close() };
}

/** Another program on the proxy port: HTTPS with a certificate of its own; records every request it parses. */
async function startSquatter(port, cert) {
  const seen = [];
  const server = https.createServer({ cert: fs.readFileSync(cert.cert), key: fs.readFileSync(cert.key) }, (req, res) => {
    seen.push({ method: req.method, path: req.url, auth: req.headers.authorization ? 'sent' : 'none', apiKey: req.headers['x-api-key'] ? 'sent' : 'none' });
    req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"proof":"made-up"}');
  });
  const handshakes = [];
  server.on('tlsClientError', e => handshakes.push(String(e?.message).slice(0, 120)));
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return { seen, handshakes, close: () => new Promise(r => { server.closeAllConnections(); server.close(() => r()); }) };
}

// ---------------------------------------------------------------- claude
function cleanEnv(extra) {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    // a prefix match, as in scripts/guard-e2e: nothing of a surrounding Claude Code session (CLAUDECODE, CLAUDE_*),
    // no credential, no TLS override (NODE_TLS_REJECT_UNAUTHORIZED) and no ambient proxy reaches the child
    if (/^(?:CLAUDE|ANTHROPIC|AWS_BEARER|MCP_|ENABLE_TOOL_SEARCH|AGENTIC_ROUTER|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT|HTTPS?_PROXY|NO_PROXY)/i.test(k)) continue;
    out[k] = v;
  }
  return { ...out, NO_PROXY: '127.0.0.1,localhost,::1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', ENABLE_TOOL_SEARCH: 'false', ...extra };
}
/**
 * --selftest: no claude. The helper as Claude Code runs it (with the settings env values applied, as Claude Code does),
 * then one request with what it printed, trusting the NODE_EXTRA_CA_CERTS Claude Code uses: the settings value when
 * there is one (decision 158: it replaces the launch value), else the launch value. Checks this script's own plumbing.
 */
async function selftestClaude(env) {
  const settings = JSON.parse(fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'));
  const helperCmd = String(settings.apiKeyHelper).match(/^node "(.+)"$/)?.[1];
  // asynchronously: the proxy runs in this process and must be free to answer the helper's check
  const helper = await new Promise(resolve => execFile(process.execPath, [helperCmd], { env: { ...env, ...settings.env }, encoding: 'utf8' },
    (err, stdout, stderr) => resolve({ status: err ? 1 : 0, stdout, stderr })));
  if (helper.status !== 0) return { exitCode: 1, stdout: '', stderr: `apiKeyHelper failed: ${helper.stderr}` };
  const base = new URL(settings.env.ANTHROPIC_BASE_URL);
  const caFile = settings.env.NODE_EXTRA_CA_CERTS ?? env.NODE_EXTRA_CA_CERTS;
  const r = await new Promise(resolve => {
    const lib = base.protocol === 'https:' ? https : http;
    const body = JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] });
    const q = lib.request({ host: base.hostname, port: Number(base.port), method: 'POST', path: '/v1/messages', agent: false,
      headers: { host: base.host, authorization: `Bearer ${helper.stdout}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      ...(base.protocol === 'https:' ? { ca: caFile ? fs.readFileSync(caFile) : undefined } : {}) },
    x => { let b = ''; x.on('data', c => { b += c; }); x.on('end', () => resolve({ status: x.statusCode, body: b })); });
    q.on('error', e => resolve({ error: `${e.code ?? ''} ${e.message} certificate` }));
    q.end(body);
  });
  if (r.error) return { exitCode: 1, stdout: '', stderr: r.error };
  return { exitCode: 0, stdout: JSON.stringify({ result: r.status === 200 && r.body.includes(MARKER) ? MARKER : `HTTP ${r.status}` }), stderr: '' };
}

function runClaude(env) {
  if (flag('selftest')) return selftestClaude(env);
  return new Promise(resolve => {
    const bin = process.env.CLAUDE_BIN || 'claude';
    let out = '', err = '', timedOut = false, child;
    try { child = spawn(bin, ['-p', '--debug', '--model', 'sonnet', '--max-turns', '2', '--output-format', 'json'], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: /\.(cmd|bat)$/i.test(bin) }); }
    catch (e) { return resolve({ spawnError: String(e?.message) }); }
    const timer = setTimeout(() => { timedOut = true; try { WIN ? spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }) : child.kill('SIGKILL'); } catch { /* gone */ } }, TIMEOUT_MS);
    child.stdout.on('data', d => { if (out.length < 400_000) out += d; });
    child.stderr.on('data', d => { if (err.length < 200_000) err += d; });
    child.on('error', e => { clearTimeout(timer); resolve({ spawnError: String(e?.message) }); });
    child.on('close', code => { clearTimeout(timer); resolve({ exitCode: code, timedOut, stdout: out, stderr: err }); });
    child.stdin.on('error', () => {});
    child.stdin.end('Reply with just the word: ping');
  });
}
function claudeConfig(root, name, o) {
  const dir = path.join(root, `config-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const env = { ANTHROPIC_BASE_URL: `${o.tls ? 'https' : 'http'}://${o.host ?? '127.0.0.1'}:${o.port}`, CLAUDE_CODE_API_KEY_HELPER_TTL_MS: '60000', CLAUDE_CODE_GATEWAY_HINT_HEADERS: '1', ...(o.ca ? { NODE_EXTRA_CA_CERTS: o.ca } : {}) };
  const helper = o.helper ?? path.join(REPO, 'packages', 'proxy', 'bin', 'local-token.mjs');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ apiKeyHelper: `node "${posix(helper)}"`, env }, null, 2) + '\n');
  return dir;
}
const TLS_RE = /self[\s-]?signed certificate|unable to (?:get|verify)|SELF_SIGNED_CERT|DEPTH_ZERO_SELF_SIGNED|ERR_TLS|ALTNAME|UNABLE_TO_|CERT_UNTRUSTED|INVALID_CA|invalid CA|ssl routines|handshake|certificate/i;
const HELPER_RE = /apiKeyHelper|api key helper|not this router's proxy|no token given out/i;
function summarize(r) {
  let parsed = null; try { parsed = JSON.parse(r.stdout || ''); } catch { /* not JSON */ }
  const text = `${parsed?.result ?? ''}\n${r.stderr ?? ''}`;
  return {
    exitCode: r.exitCode ?? null, timedOut: !!r.timedOut, spawnError: r.spawnError ?? null, answered: String(parsed?.result ?? '').includes(MARKER),
    tlsError: TLS_RE.test(text), helperError: HELPER_RE.test(text),
    debug: (r.stderr || '').split(/\r?\n/).filter(l => /CA certs|NODE_EXTRA_CA_CERTS|apiKeyHelper|helper|401|certificate/.test(l)).slice(0, 8),
  };
}

// ---------------------------------------------------------------- run
const openssl = findOpenssl();
if (!openssl) { console.error('openssl not found. Set OPENSSL_BIN, or install Git for Windows / openssl.'); process.exit(2); }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-tls-live-'));
const home = path.join(root, 'router-home');
fs.mkdirSync(home, { recursive: true, mode: 0o700 });
const cert = ensureProxyCert({ home, openssl });
if (cert.state === 'unavailable') { console.error(`certificate: ${cert.reason}`); process.exit(2); }
const shapes = path.join(root, 'shapes');
const userCa = selfSigned(openssl, shapes, 'user-corporate-ca', 'basicConstraints = critical, CA:TRUE\nkeyUsage = critical, keyCertSign');
const squatterCert = selfSigned(openssl, shapes, 'squatter', 'subjectAltName = IP:127.0.0.1, DNS:localhost\nbasicConstraints = critical, CA:FALSE\nkeyUsage = critical, digitalSignature\nextendedKeyUsage = serverAuth');
const fake = await startFakeApi();
const port = await new Promise(r => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const writeRouterConfig = tls => fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ proxyPort: port, daemonPort: 1, apiMode: 'proxy', proxy: { tls } }));
const only = arg('only');
const results = [];
const childEnv = (dir, extra = {}) => cleanEnv({ CLAUDE_CONFIG_DIR: dir, AGENTIC_ROUTER_HOME: home, ...extra });
async function step(name, expect, fn) {
  if (only && only !== name) return;
  fake.seen.length = 0;
  const r = await fn();
  if (r.skipped) { console.log(`skipped  ${name.padEnd(11)} ${r.skipped}`); results.push({ case: name, met: true, skipped: r.skipped }); return; }
  const ok = expect(r);
  results.push({ case: name, met: ok, ...r });
  console.log(`${ok ? 'met    ' : 'NOT MET'}  ${name.padEnd(11)} ${JSON.stringify({ ...r, debug: undefined })}`);
  for (const l of r.debug ?? []) console.log(`           ${l.slice(0, 200)}`);
}

try {
  const claudeVersion = WIN ? spawnSync(`"${process.env.CLAUDE_BIN || 'claude'}" --version`, { encoding: 'utf8', shell: true }) : spawnSync(process.env.CLAUDE_BIN || 'claude', ['--version'], { encoding: 'utf8' });
  console.log(`claude: ${claudeVersion.stdout?.trim() || '?'}; openssl: ${spawnSync(openssl, ['version'], { encoding: 'utf8' }).stdout.trim()}; temp: ${root}`);
  writeRouterConfig(true);
  let p = await startProxy(home, port, fake.port, true);
  const cfgTls = claudeConfig(root, 'tls', { port, tls: true, ca: cert.paths.cert });
  await step('tls', r => r.answered && r.fakeKeys.includes('dummy'), async () => {
    // the helper writes its probe line into the router home (a fixed file; no path is taken from the environment)
    const probe = path.join(home, 'helper-probe.jsonl');
    const s = summarize(await runClaude(childEnv(cfgTls, { AGENTIC_ROUTER_HELPER_PROBE: '1' })));
    let seen = 'the helper did not run';
    try { const lines = fs.readFileSync(probe, 'utf8').trim().split('\n').map(l => JSON.parse(l)); seen = [...new Set(lines.map(l => `${l.baseUrl}${l.matches === null ? '' : l.matches ? ', matches' : ', does not match'}`))].join(' / '); } catch { /* none */ }
    return { ...s, fakeKeys: [...new Set(fake.seen.map(e => e.key))], helperSawBaseUrl: seen };
  });
  await step('restart', r => r.oldTokenStatus === 401 && r.answered, async () => {
    const old = p.token();
    await p.close();
    p = await startProxy(home, port, fake.port, true);   // a fresh token, as at every start
    const status = await new Promise(res => {
      const q = https.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/messages', ca: fs.readFileSync(cert.paths.cert), agent: false,
        headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${old}`, 'content-type': 'application/json' } }, x => { x.resume(); x.on('end', () => res(x.statusCode)); });
      q.on('error', () => res(-1)); q.end('{}');
    });
    return { oldTokenStatus: status, ...summarize(await runClaude(childEnv(cfgTls))) };
  });
  await step('squatter', r => !r.answered && r.requestsWithCredential === 0, async () => {
    await p.close();
    const sq = await startSquatter(port, squatterCert);
    try {
      const s = summarize(await runClaude(childEnv(cfgTls)));
      return { ...s, squatterParsed: sq.seen.length, requestsWithCredential: sq.seen.filter(e => e.auth === 'sent' || e.apiKey === 'sent').length, squatterHandshakeErrors: sq.handshakes.length };
    } finally { await sq.close(); p = await startProxy(home, port, fake.port, true); }
  });
  // decision 158: the settings value replaces the launch one, so the settings value is the bundle of theirs and ours
  const bundle = writeBundle([userCa.cert], fs.readFileSync(cert.paths.cert, 'utf8'), tlsPaths(home)).file;
  await step('shell-ca', r => r.answered, async () =>
    summarize(await runClaude(childEnv(claudeConfig(root, 'shell-ca', { port, tls: true, ca: bundle }), { NODE_EXTRA_CA_CERTS: userCa.cert }))));
  await step('precedence', r => r.answered, async () =>
    summarize(await runClaude(childEnv(claudeConfig(root, 'precedence', { port, tls: true, ca: cert.paths.cert }), { NODE_EXTRA_CA_CERTS: userCa.cert }))));
  await step('plain', r => r.answered, async () => {
    await p.close();
    writeRouterConfig(false);
    p = await startProxy(home, port, fake.port, false);
    return summarize(await runClaude(childEnv(claudeConfig(root, 'plain', { port, tls: false }))));
  });
  await p.close();

  // ---- certificate shapes: a fake HTTPS API straight, trusted through the settings, a dummy-key helper
  const dummy = path.join(HERE, 'dummy-key.mjs');
  const shapeCase = async (name, o) => {
    const api = await startFakeApi({ tls: { cert: o.served, key: o.key }, host: o.host ?? '127.0.0.1' });
    try {
      const s = summarize(await runClaude(childEnv(claudeConfig(root, name, { port: api.port, tls: true, ca: o.trusted, host: o.host, helper: dummy }))));
      return { ...s, requestsSeen: api.seen.length, handshakeErrors: api.handshakes.length };
    } finally { await api.close(); }
  };
  const routerLeaf = { cert: cert.paths.cert, key: cert.paths.key };
  const mintedByLeaf = mint(openssl, shapes, 'minted-by-leaf', routerLeaf, 'IP:127.0.0.1, DNS:localhost');
  await step('minted-leaf', r => !r.answered && r.requestsSeen === 0, () => shapeCase('minted-leaf', {
    trusted: routerLeaf.cert, served: `${fs.readFileSync(mintedByLeaf.cert, 'utf8')}${fs.readFileSync(routerLeaf.cert, 'utf8')}`, key: fs.readFileSync(mintedByLeaf.key) }));
  const oldCa = selfSigned(openssl, shapes, 'old-ca-shape', 'subjectAltName = IP:127.0.0.1, DNS:localhost\nbasicConstraints = critical, CA:TRUE\nkeyUsage = critical, digitalSignature, keyCertSign');
  const mintedByCa = mint(openssl, shapes, 'minted-by-ca', oldCa, 'IP:127.0.0.1, DNS:localhost');
  await step('control-ca', r => r.answered, () => shapeCase('control-ca', {
    trusted: oldCa.cert, served: `${fs.readFileSync(mintedByCa.cert, 'utf8')}${fs.readFileSync(oldCa.cert, 'utf8')}`, key: fs.readFileSync(mintedByCa.key) }));
  const nc = selfSigned(openssl, shapes, 'nc-anchor', 'subjectAltName = IP:127.0.0.1, DNS:localhost\nbasicConstraints = critical, CA:TRUE, pathlen:0\nkeyUsage = critical, digitalSignature, keyCertSign\nnameConstraints = critical, permitted;IP:127.0.0.1/255.255.255.255, permitted;DNS:localhost');
  await step('nc-anchor', r => r.answered, () => shapeCase('nc-anchor', { trusted: nc.cert, served: fs.readFileSync(nc.cert, 'utf8'), key: fs.readFileSync(nc.key) }));
  await step('nc-minted', r => !r.answered && r.requestsSeen === 0, async () => {
    if (process.platform === 'darwin') return { skipped: '127.0.0.2 is not a loopback address on macOS without an alias' };
    const mintedByNc = mint(openssl, shapes, 'minted-by-nc', nc, 'IP:127.0.0.2');
    return shapeCase('nc-minted', { trusted: nc.cert, served: `${fs.readFileSync(mintedByNc.cert, 'utf8')}${fs.readFileSync(nc.cert, 'utf8')}`, key: fs.readFileSync(mintedByNc.key), host: '127.0.0.2' });
  });
} finally {
  await fake.close();
  fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify({ at: new Date().toISOString(), platform: process.platform, node: process.version, results }, null, 2));
  if (!flag('keep')) fs.rmSync(root, { recursive: true, force: true });
  else console.log(`kept: ${root}`);
}
await sleep(10);
process.exit(results.every(r => r.met) ? 0 : 1);
