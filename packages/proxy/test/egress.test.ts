// The upstream connection through a corporate HTTP(S) proxy (Node's built-in proxy support): a local CONNECT proxy
// made with node:net, a local TLS upstream with a certificate made at run time. The tunnel carries TLS end to end,
// NO_PROXY goes around it, a certificate that is not trusted still fails, and the proxy's credentials appear in
// no log, error or health answer. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import { EgressError, agentProxyEnv, noProxyCovers, shownProxyUrl, upstreamProxy } from '../src/egress.ts';
import { Masker } from '../src/log.ts';
import { SSE_HEADERS, TEST_KEY, auth, call, messageStream, startProxy } from './helpers.ts';
import { selfSignedCert } from './tls.ts';

const PROXY_USER = 'corp-user';
const PROXY_PASS = 'not-a-secret-proxy-pass';
const HOST = 'api.test';
/** A proxy URL with credentials, put together at run time (no such URL is written out in the source). */
const withCreds = (scheme: string, user: string, pass: string, hostPort: string) => [scheme, '://', user, ':', pass, '@', hostPort].join('');   // reached only through the test CONNECT proxy, which maps every target to the local upstream

/** A CONNECT proxy: records each request head and every byte it tunnels, and sends all tunnels to `to`. */
async function connectProxy(to: () => number) {
  const heads: string[] = [];
  const tunneled: Buffer[] = [];
  const open = new Set<net.Socket>();
  const track = (s: net.Socket) => { open.add(s); s.on('close', () => open.delete(s)); return s; };
  const server = net.createServer(sock => {
    track(sock);
    sock.once('data', head => {
      const text = head.toString('latin1');
      heads.push(text.split('\r\n\r\n')[0]!);
      if (!/^CONNECT /.test(text)) { sock.end('HTTP/1.1 405 Method Not Allowed\r\ncontent-length: 0\r\n\r\n'); return; }
      const up = track(net.connect(to(), '127.0.0.1', () => {
        sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        sock.on('data', c => { tunneled.push(c as Buffer); up.write(c); });
        up.pipe(sock);
      }));
      // a tunnel ends as a whole: either side closing closes the other (a failed TLS handshake closes one side)
      up.on('error', () => sock.destroy());
      sock.on('error', () => up.destroy());
      up.on('close', () => sock.destroy());
      sock.on('close', () => up.destroy());
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as net.AddressInfo).port, heads, tunneled,
    close: () => new Promise<void>(r => { for (const s of open) s.destroy(); server.close(() => r()); }),
  };
}

/** A TLS upstream that answers POST /v1/messages with a short stream and records the request headers. */
async function tlsUpstream(cert: { cert: string; key: string }) {
  const got: Array<Record<string, string | string[] | undefined>> = [];
  const server = https.createServer({ cert: cert.cert, key: cert.key }, (req, res) => {
    got.push(req.headers);
    req.resume();
    req.on('end', () => { res.writeHead(200, SSE_HEADERS); for (const s of messageStream()) res.write(s); res.end(); });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as net.AddressInfo).port, got, close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }) };
}

const req = JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });

async function scene(env: NodeJS.ProcessEnv, o: { upstreamHost?: string; trust?: 'right' | 'other' } = {}) {
  const cert = selfSignedCert('test-upstream', [HOST, 'localhost'], ['127.0.0.1']);
  const other = selfSignedCert('someone-else', [HOST], ['127.0.0.1']);
  const up = await tlsUpstream(cert);
  const cp = await connectProxy(() => up.port);
  const egress = upstreamProxy(Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v?.replace('PPORT', String(cp.port))])));
  const t = await startProxy(0, {
    settings: { upstream: new URL(`https://${o.upstreamHost ?? HOST}:${up.port}`) },
    ...(egress ? { egress } : {}), testUpstreamCa: (o.trust ?? 'right') === 'right' ? cert.cert : other.cert,
  });
  for (const s of egress?.secrets ?? []) t.masker.add(s);
  return { up, cp, t, egress, close: async () => { await t.close(); await cp.close(); await up.close(); } };
}
const corp = { HTTPS_PROXY: withCreds('http', PROXY_USER, PROXY_PASS, '127.0.0.1:PPORT') };

test('the upstream connection goes through the CONNECT proxy with its credentials, and TLS runs end to end inside the tunnel', async () => {
  const s = await scene(corp);
  try {
    const r = await call(s.t.port, { headers: auth(), body: req });
    assert.equal(r.status, 200, r.body.toString());
    assert.equal(s.cp.heads.length, 1);
    assert.match(s.cp.heads[0]!, new RegExp(`^CONNECT ${HOST}:${s.up.port} HTTP/1\\.1`));
    assert.match(s.cp.heads[0]!, new RegExp(`proxy-authorization: Basic ${Buffer.from(`${PROXY_USER}:${PROXY_PASS}`).toString('base64')}`, 'i'));
    assert.equal(s.up.got[0]!['x-api-key'], TEST_KEY, 'the upstream got the key');
    const wire = Buffer.concat(s.cp.tunneled).toString('latin1');
    assert.ok(wire.length > 0 && !wire.includes(TEST_KEY) && !wire.includes('claude-haiku-5-5'), 'the proxy saw only TLS records');
    // the health answer names the proxy without its credentials
    const h = await call(s.t.port, { method: 'GET', path: '/proxy/v1/health', headers: auth() });
    const via = (JSON.parse(h.body.toString()) as { via: string }).via;
    assert.equal(via, `http://127.0.0.1:${s.cp.port} (credentials hidden)`);
  } finally { await s.close(); }
});

test('NO_PROXY goes around the proxy (comma or space lists), and a loopback upstream never uses it', async () => {
  // a suffix entry for the upstream's domain: the proxy is not contacted (the made-up host then does not resolve)
  let s = await scene({ ...corp, NO_PROXY: 'intranet.example .test' });
  try {
    assert.equal(s.egress!.noProxy, 'intranet.example,.test,localhost,127.0.0.1,::1');
    const r = await call(s.t.port, { headers: auth(), body: req });
    assert.equal(r.status, 502);
    assert.equal(s.cp.heads.length, 0, 'not through the proxy');
  } finally { await s.close(); }
  // loopback is always on the list: a loopback upstream is reached directly, and works
  s = await scene(corp, { upstreamHost: '127.0.0.1' });
  try {
    assert.equal((await call(s.t.port, { headers: auth(), body: req })).status, 200);
    assert.equal(s.cp.heads.length, 0);
  } finally { await s.close(); }
});

test('through the tunnel, an upstream certificate that is not trusted still fails; no credential in the error or the log', async () => {
  const s = await scene(corp, { trust: 'other' });
  try {
    const r = await call(s.t.port, { headers: auth(), body: req });
    assert.equal(r.status, 502);
    assert.equal(s.cp.heads.length, 1, 'the tunnel was opened');
    assert.equal(s.up.got.length, 0, 'no request reached the upstream');
    assert.ok(!r.body.toString().includes(PROXY_PASS));
    const log = fs.existsSync(s.t.paths.log) ? fs.readFileSync(s.t.paths.log, 'utf8') : '';
    assert.ok(!log.includes(PROXY_PASS) && !log.includes(PROXY_USER + ':'), log);
  } finally { await s.close(); }
});

test('proxy variables: Claude Code\'s order, fail closed on what cannot be used, credentials hidden when shown', () => {
  assert.equal(upstreamProxy({}), undefined);
  assert.equal(upstreamProxy({ HTTPS_PROXY: '  ' }), undefined);
  assert.equal(upstreamProxy({ https_proxy: 'http://a.example:1', HTTPS_PROXY: 'http://b.example:2' })!.shown, 'http://a.example:1');
  assert.equal(upstreamProxy({ HTTP_PROXY: 'http://c.example:3' })!.from, 'HTTP_PROXY', 'an HTTP_PROXY alone is used, as Claude Code does');
  assert.throws(() => upstreamProxy({ HTTPS_PROXY: 'socks5://p.example:1080' }), (e: Error) => e instanceof EgressError && /socks5.*not supported/.test(e.message));
  assert.throws(() => upstreamProxy({ HTTPS_PROXY: `${PROXY_USER}:${PROXY_PASS}@nowhere` }), (e: Error) => e instanceof EgressError && !e.message.includes(PROXY_PASS));
  assert.throws(() => upstreamProxy({ HTTPS_PROXY: 'http://p.example:8080' }, '24.4.1'), /Node 24\.5 or later/);
  assert.ok(upstreamProxy({ HTTPS_PROXY: 'http://p.example:8080' }, '25.0.0'));
  const p = upstreamProxy({ HTTPS_PROXY: withCreds('https', PROXY_USER, encodeURIComponent('not:a@secret'), 'p.example:8443'), no_proxy: 'a.example' })!;
  assert.equal(p.shown, 'https://p.example:8443 (credentials hidden)');
  assert.ok(p.secrets.includes('not:a@secret'));
  assert.deepEqual(agentProxyEnv(p), { HTTPS_PROXY: p.url.href, NO_PROXY: 'a.example,localhost,127.0.0.1,::1' });
  assert.equal(shownProxyUrl('not a url'), '(not a URL)');
  assert.ok(noProxyCovers(['*'], '127.0.0.1') && noProxyCovers(['127.0.0.1:4711'], '127.0.0.1', 4711) && !noProxyCovers(['10.0.0.1'], '127.0.0.1'));
  // the log mask takes any user:password@ out of a URL
  assert.equal(new Masker().mask(`{"e":"connect via ${withCreds('http', PROXY_USER, PROXY_PASS, 'p.example:8080')} failed"}`), '{"e":"connect via http://[REDACTED]@p.example:8080 failed"}');
});
