// Decision 156, step 3: on macOS and Linux the daemon also listens on a Unix socket in a directory only the
// user can enter, names it in endpoint.json, and the router's clients then use that socket and nothing else.
// What a second OS user can or cannot do is not exercised here (it needs a second account): see the note at
// the end of this file for the manual check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENDPOINT_FILE, SealError, daemonTarget, privateDir, readEndpoint, sealedCall, socketCandidates, socketLocation, sunPathMax, writeEndpoint } from '@agentic-router/core';
import * as plugin from '../../../plugin/hooks/seal.mjs';
import { TOKEN, makeHome, rmrf, startTestDaemon, tmpDir, type TestDaemon } from './helpers.ts';

const POSIX = process.platform !== 'win32';
const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const RELAY = here('../../../plugin/hooks/relay.mjs');
const STATUSLINE = here('../../../plugin/statusline.mjs');
const CLI = here('../../cli/src/index.ts');
const MARKER = 'MARKER-socket-prose-41c2';
const prompt = (text: string) => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's-sock', cwd: process.cwd(), prompt: text });
const refusal = async (p: Promise<unknown>): Promise<string> => { try { await p; return 'accepted'; } catch (e) { return e instanceof SealError || e instanceof plugin.SealError ? (e as SealError).code : `threw ${String(e)}`; } };

function run(file: string, args: string[], home: string, stdin = ''): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [file, ...args], { env: { ...process.env, AGENTIC_ROUTER_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'], cwd: home });
    let out = '';
    c.stdout.on('data', x => { out += x; });
    c.stderr.on('data', x => { out += x; });
    c.on('error', reject);
    c.on('close', () => resolve(out));
    c.stdin.end(stdin);
  });
}
/** A TCP listener that counts what it is sent: what a program squatting on the daemon's port would see. */
async function tcpRecorder() {
  const wire: string[] = [];
  const server = http.createServer((req, res) => { wire.push(`${req.method} ${req.url}`); req.resume(); req.on('end', () => res.end('{"ok":true}')); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as net.AddressInfo).port, wire, close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }) };
}

// ------------------------------------------------------------------ where the socket goes (every platform)

test('socketCandidates: the home first; a path too long for the system falls back to a directory of the user\'s own', () => {
  const env = { platform: 'linux' as const, uid: 1000, env: { XDG_RUNTIME_DIR: '/run/user/1000' }, tmpdir: '/tmp' };
  assert.deepEqual(socketCandidates('/home/u/.agentic-router', env).map(c => [c.path, c.fallback]).slice(0, 1), [['/home/u/.agentic-router/daemon.sock', false]]);
  const long = '/home/u/' + 'x'.repeat(120);
  const c = socketCandidates(long, env);
  assert.equal(c.length, 2, 'the home is skipped; the runtime directory, then the temp directory');
  assert.match(c[0]!.path, /^\/run\/user\/1000\/agentic-router-1000-[0-9a-f]{12}\/daemon\.sock$/);
  assert.match(c[1]!.path, /^\/tmp\/agentic-router-1000-[0-9a-f]{12}\/daemon\.sock$/);
  assert.ok(c.every(x => x.fallback && Buffer.byteLength(x.path) <= sunPathMax('linux')));
  // per home and per user
  assert.notEqual(socketCandidates(long + 'y', env)[0]!.path, c[0]!.path);
  assert.notEqual(socketCandidates(long, { ...env, uid: 1001 })[0]!.path, c[0]!.path);
  // macOS has the shorter limit; a relative XDG_RUNTIME_DIR is ignored; Windows has no socket
  assert.equal(sunPathMax('darwin'), 103);
  assert.equal(socketCandidates('/Users/u/' + 'x'.repeat(88), { ...env, platform: 'darwin' })[0]!.fallback, true);
  assert.deepEqual(socketCandidates(long, { ...env, env: { XDG_RUNTIME_DIR: 'relative/dir' } }).map(x => x.dir.startsWith('/tmp/')), [true]);
  assert.deepEqual(socketCandidates('C:\\Users\\u\\.agentic-router', { platform: 'win32' }), []);
  // nothing fits: no socket (the daemon then stays on TCP with sealed messages)
  assert.deepEqual(socketCandidates(long, { ...env, env: { XDG_RUNTIME_DIR: '/' + 'r'.repeat(100) }, tmpdir: '/' + 't'.repeat(100) }), []);
});

test('the endpoint file, and how a client picks its transport from it', () => {
  const home = tmpDir('endpoint');
  try {
    assert.equal(readEndpoint(home), undefined);
    for (const target of [daemonTarget, plugin.daemonTarget]) {
      assert.deepEqual(target(home, 47800), { port: 47800 }, 'no endpoint file: the port from the config');
      assert.equal(target(home, null), undefined);
    }
    writeEndpoint(home, { version: 1, pid: 1, startedAt: '2026-11-13T00:00:00.000Z', port: 47801 });
    for (const target of [daemonTarget, plugin.daemonTarget]) {
      assert.deepEqual(target(home, 47800), { port: 47800 }, 'no socket named: still the config port');
      assert.deepEqual(target(home, null), { port: 47801 });
    }
    writeEndpoint(home, { version: 1, pid: 1, startedAt: '2026-11-13T00:00:00.000Z', port: 47801, socket: '/run/user/1000/x/daemon.sock' });
    for (const target of [daemonTarget, plugin.daemonTarget])
      assert.deepEqual(target(home, 47800), { port: 47801, socketPath: '/run/user/1000/x/daemon.sock' }, 'a socket named: the socket, with the daemon\'s own port for the Host header');
    if (POSIX) assert.equal(fs.statSync(path.join(home, ENDPOINT_FILE)).mode & 0o777, 0o600);
    // a broken or foreign file is no endpoint
    for (const bad of ['{', '[]', '{"version":2,"port":1,"socket":"/x/y"}', '{"version":1,"port":"1"}', '{"version":1,"port":1,"socket":7}']) {
      fs.writeFileSync(path.join(home, ENDPOINT_FILE), bad);
      for (const target of [daemonTarget, plugin.daemonTarget]) assert.deepEqual(target(home, 47800), { port: 47800 }, bad);
    }
  } finally { rmrf(home); }
});

test('no silent downgrade: a client that was told of a socket never tries the TCP port', async () => {
  // the daemon is down (its socket does not answer) and something else holds its port
  const rec = await tcpRecorder();
  const home = makeHome({ daemonPort: rec.port });
  try {
    const gone = POSIX ? path.join(home, 'daemon.sock') : `\\\\.\\pipe\\ar-test-gone-${process.pid}`;
    writeEndpoint(home, { version: 1, pid: 1, startedAt: new Date().toISOString(), port: rec.port, socket: gone });
    assert.equal(await refusal(sealedCall({ home, port: rec.port, secret: TOKEN, method: 'GET', path: '/router/v1/health', timeoutMs: 2000 })), 'unreachable');
    assert.equal(await refusal(plugin.sealedCall({ home, port: rec.port, secret: TOKEN, method: 'GET', path: '/router/v1/health', timeoutMs: 2000 })), 'unreachable');
    // the real clients: the hook passes and spools, the status line says OFF, the CLI says the router is off
    assert.equal(await run(RELAY, ['UserPromptSubmit'], home, prompt(`hi ${MARKER}`)), '{}');
    assert.equal(fs.readdirSync(path.join(home, 'spool')).length, 1);
    assert.match(await run(STATUSLINE, [], home, JSON.stringify({ session_id: 's-sock', model: { id: 'claude-sonnet-5-5' } })), /\[Router\] OFF/);
    assert.match(await run(CLI, ['status'], home), /Router OFF/);
    // the port saw none of the sealed calls: at most the CLI's open health probe, which carries nothing
    assert.deepEqual(rec.wire.filter(w => !w.startsWith('GET /router/v1/health')), [], rec.wire.join(' | '));
  } finally { await rec.close(); rmrf(home); }
});

// ------------------------------------------------------------------ the daemon's socket (macOS and Linux)

async function withDaemon(fn: (d: TestDaemon) => Promise<void>, opts: Parameters<typeof startTestDaemon>[0] = {}): Promise<void> {
  const d = await startTestDaemon({ verify: { resolveCommands: async () => [] }, ...opts });
  try { await fn(d); } finally { await d.close(); rmrf(d.home); }
}

test('the daemon listens on a socket in its home: 0600 in a 0700 directory, named in endpoint.json', { skip: !POSIX }, () => withDaemon(async d => {
  assert.equal(d.socketPath, path.join(d.home, 'daemon.sock'));
  const sock = fs.lstatSync(d.socketPath!);
  assert.ok(sock.isSocket());
  assert.equal(sock.mode & 0o777, 0o600, 'the socket file');
  assert.equal(fs.lstatSync(d.home).mode & 0o077, 0, 'its directory admits nobody else');
  assert.equal(sock.uid, process.getuid!());
  const e = readEndpoint(d.home)!;
  assert.deepEqual([e.version, e.pid, e.port, e.socket], [1, process.pid, d.port, d.socketPath]);
  assert.equal(fs.statSync(path.join(d.home, ENDPOINT_FILE)).mode & 0o777, 0o600);
  // a sealed call over the socket, addressed by the home alone
  const viaHome = await sealedCall({ home: d.home, port: 1, secret: TOKEN, method: 'GET', path: '/router/v1/health' });
  assert.deepEqual([viaHome.status, JSON.parse(viaHome.body).ok], [200, true], 'the config port (1 here) is not used once a socket is named');
  const viaPlugin = await plugin.sealedCall({ home: d.home, port: 1, secret: TOKEN, method: 'GET', path: '/router/v1/status' });
  assert.equal(viaPlugin.status, 200);
  // messages are sealed over the socket too: a plain request on it gets what it gets on TCP
  const plain = await new Promise<number>((resolve, reject) => {
    const r = http.request({ socketPath: d.socketPath!, path: '/router/v1/status', headers: { host: `127.0.0.1:${d.port}` } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    r.on('error', reject); r.end();
  });
  assert.equal(plain, 401, 'the socket does not replace the secret');
  assert.equal(await refusal(sealedCall({ socketPath: d.socketPath!, port: d.port, secret: 'not-the-token', method: 'GET', path: '/router/v1/health' })), 'not_sealed');
  // TCP still answers sealed calls (Windows clients of the same daemon version, and the proxy)
  assert.equal((await sealedCall({ port: d.port, secret: TOKEN, method: 'GET', path: '/router/v1/health' })).status, 200);
}));

test('the clients on the socket: relay, status line and CLI reach the daemon with no usable TCP port in their config', { skip: !POSIX }, () => withDaemon(async d => {
  // the config names a port where a recorder listens; a client that used it would show up there
  const rec = await tcpRecorder();
  try {
    const cfg = path.join(d.home, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, 'utf8')), daemonPort: rec.port }));
    const out = await run(RELAY, ['UserPromptSubmit'], d.home, prompt(`Fix the typo in README.md ${MARKER}`));
    assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /agentic-router/, 'the hook was answered by the daemon');
    assert.match(await run(STATUSLINE, [], d.home, JSON.stringify({ session_id: 's-sock' })), /\[Router\] (?!OFF)/);
    assert.match(await run(CLI, ['status'], d.home), /Router ON/);
    assert.deepEqual(rec.wire.filter(w => !w.startsWith('GET /router/v1/health')), [], 'nothing sealed went to the TCP port');
  } finally { await rec.close(); }
}));

test('after a stop the socket is gone and the endpoint still names it, so clients treat the daemon as down', { skip: !POSIX }, async () => {
  const d = await startTestDaemon({ verify: { resolveCommands: async () => [] } });
  const rec = await tcpRecorder();
  try {
    const sock = d.socketPath!;
    await d.close();
    assert.equal(fs.existsSync(sock), false);
    assert.equal(readEndpoint(d.home)?.socket, sock);
    assert.equal(await refusal(sealedCall({ home: d.home, port: rec.port, secret: TOKEN, method: 'GET', path: '/router/v1/health', timeoutMs: 1500 })), 'unreachable');
    assert.deepEqual(rec.wire, []);
    // a new start replaces a stale socket file left by a crash
    fs.writeFileSync(path.join(d.home, 'config.json'), JSON.stringify({ daemonPort: 0, fableOptIn: false, holdoutRate: 0 }));
    const stale = net.createServer();
    await new Promise<void>(r => stale.listen(sock, r));
    stale.unref();                                        // the file stays; nobody will accept on it after this test's close
    await new Promise<void>(r => stale.close(() => r()));
    fs.closeSync(fs.openSync(sock, 'a'));                 // a leftover file of that name
    const again = await startTestDaemon({ home: d.home, verify: { resolveCommands: async () => [] } });
    try {
      assert.ok(again.socketPath === undefined || fs.lstatSync(again.socketPath).isSocket(), 'a plain file of that name is not removed; a stale socket is replaced');
    } finally { await again.close(); }
  } finally { await rec.close(); rmrf(d.home); }
});

test('a directory that is not the user\'s alone gets no socket: TCP with sealed messages instead', { skip: !POSIX }, async () => {
  // privateDir: what counts as a place for the socket
  const base = tmpDir('private');
  try {
    const uid = process.getuid!();
    const good = path.join(base, 'good');
    assert.equal(privateDir(good, uid, true), true, 'created 0700');
    assert.equal(fs.statSync(good).mode & 0o777, 0o700);
    const open = path.join(base, 'open');
    fs.mkdirSync(open, { mode: 0o755 }); fs.chmodSync(open, 0o755);
    assert.equal(privateDir(open, uid, true), false, 'group or others may enter: refused, and not repaired');
    assert.equal(fs.statSync(open).mode & 0o777, 0o755);
    const link = path.join(base, 'link');
    fs.symlinkSync(good, link);
    assert.equal(privateDir(link, uid, true), false, 'a link, even to a private directory');
    assert.equal(privateDir(good, uid + 1, false), false, 'owned by someone else');
    assert.equal(privateDir(path.join(base, 'file'), uid, false), false);
    fs.writeFileSync(path.join(base, 'file'), '');
    assert.equal(privateDir(path.join(base, 'file'), uid, true), false, 'not a directory');
    // a home too long for a socket path, with a fallback place that someone else prepared: no socket at all.
    // The fallback base is a short directory straight under /tmp: the per-test temp directory is itself too
    // long for a socket path on macOS (/var/folders/…/T/…), which would leave no candidate to test.
    const short = fs.realpathSync(fs.mkdtempSync('/tmp/ar-'));
    try {
      const longHome = path.join(base, 'h'.repeat(110));
      const where = { env: { XDG_RUNTIME_DIR: short }, tmpdir: short };
      const candidates = socketCandidates(longHome, where);
      assert.equal(candidates.length, 1, `one fallback place fits (${candidates.map(c => c.path).join(', ')})`);
      const taken = candidates[0]!;
      assert.ok(taken.fallback && Buffer.byteLength(taken.path) <= sunPathMax());
      fs.mkdirSync(taken.dir, { mode: 0o777 }); fs.chmodSync(taken.dir, 0o777);
      assert.equal(socketLocation(longHome, where), undefined, 'the prepared directory is refused');
      fs.rmSync(taken.dir, { recursive: true });
      const made = socketLocation(longHome, where)!;
      assert.deepEqual([made.fallback, fs.statSync(made.dir).mode & 0o777], [true, 0o700], 'free: the daemon makes its own');
      // every candidate too long for the system: there is no place, whatever exists on disk
      const far = { env: { XDG_RUNTIME_DIR: path.join(short, 'r'.repeat(100)) }, tmpdir: path.join(short, 't'.repeat(100)) };
      assert.deepEqual(socketCandidates(longHome, far), []);
      assert.equal(socketLocation(longHome, far), undefined);
    } finally { rmrf(short); }
  } finally { rmrf(base); }
  // the paths of a real install fit, on both systems: the home of an ordinary account, and the fallback under
  // the default macOS temp directory (the longest default there is) with a ten-digit uid
  for (const platform of ['darwin', 'linux'] as const) {
    const home = platform === 'darwin' ? '/Users/a-rather-long-account-name/.agentic-router' : '/home/a-rather-long-account-name/.agentic-router';
    assert.equal(socketCandidates(home, { platform, uid: 501, env: {}, tmpdir: '/tmp' })[0]!.fallback, false, `${platform}: the home holds the socket`);
    const macTmp = '/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T';
    const fb = socketCandidates('/Users/x/' + 'd'.repeat(100), { platform, uid: 1234567890, env: {}, tmpdir: macTmp });
    assert.equal(fb.length, 1, `${platform}: the fallback under the default macOS temp directory fits`);
    assert.ok(Buffer.byteLength(fb[0]!.path) <= sunPathMax(platform), `${fb[0]!.path.length} bytes`);
  }
  // a home that others could enter is closed by the daemon at start (as before), and then holds the socket
  const openHome = makeHome();
  fs.chmodSync(openHome, 0o755);
  const tightened = await startTestDaemon({ home: openHome, verify: { resolveCommands: async () => [] } });
  try {
    assert.equal(fs.statSync(openHome).mode & 0o077, 0);
    assert.equal(tightened.socketPath, path.join(openHome, 'daemon.sock'));
  } finally { await tightened.close(); rmrf(openHome); }
  // a home whose path is too long for a socket, and no place to make a fallback directory: the daemon stays on
  // TCP and says so in the endpoint file
  const parent = tmpDir('long');
  const home = path.join(parent, 'h'.repeat(110));
  fs.mkdirSync(home, { mode: 0o700 });
  fs.writeFileSync(path.join(home, 'token'), TOKEN + '\n');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ daemonPort: 0, fableOptIn: false, holdoutRate: 0 }));
  const saved = { xdg: process.env.XDG_RUNTIME_DIR, tmp: process.env.TMPDIR };
  const blocked = tmpDir('blocked');
  fs.chmodSync(blocked, 0o555);                           // no fallback directory can be made here
  process.env.XDG_RUNTIME_DIR = blocked; process.env.TMPDIR = blocked;
  let d: TestDaemon | undefined;
  try {
    d = await startTestDaemon({ home, verify: { resolveCommands: async () => [] } });
    if (process.getuid!() !== 0) {                        // root can write anywhere; the rest of the check needs an ordinary user
      assert.equal(d.socketPath, undefined);
      assert.equal(readEndpoint(home)?.socket, undefined);
    }
    assert.equal((await sealedCall({ home, port: d.port, secret: TOKEN, method: 'GET', path: '/router/v1/health' })).status, 200, 'TCP, sealed');
    // the same when every candidate path is too long for the system (nothing to do with permissions): TCP, sealed
    await d.close();
    d = undefined;
    process.env.XDG_RUNTIME_DIR = '/' + 'r'.repeat(100); process.env.TMPDIR = '/' + 't'.repeat(100);
    assert.equal(socketLocation(home), undefined);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ daemonPort: 0, fableOptIn: false, holdoutRate: 0 }));
    d = await startTestDaemon({ home, verify: { resolveCommands: async () => [] } });
    assert.deepEqual([d.socketPath, readEndpoint(home)?.socket, readEndpoint(home)?.port], [undefined, undefined, d.port]);
    assert.equal((await sealedCall({ home, port: d.port, secret: TOKEN, method: 'GET', path: '/router/v1/health' })).status, 200, 'TCP, sealed');
    assert.equal((await plugin.sealedCall({ home, port: d.port, secret: TOKEN, method: 'GET', path: '/router/v1/status' })).status, 200);
  } finally {
    if (saved.xdg === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = saved.xdg;
    if (saved.tmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved.tmp;
    await d?.close();
    fs.chmodSync(blocked, 0o755);
    rmrf(blocked); rmrf(parent);
  }
});

test('Windows keeps the TCP port: no socket, and the endpoint file says so', { skip: POSIX }, () => withDaemon(async d => {
  assert.equal(d.socketPath, undefined);
  const e = readEndpoint(d.home)!;
  assert.deepEqual([e.port, e.socket], [d.port, undefined]);
  assert.equal((await sealedCall({ home: d.home, port: d.port, secret: TOKEN, method: 'GET', path: '/router/v1/health' })).status, 200);
}));

// Manual check, not automated (it needs a second account on the machine):
//   as user B, with user A's daemon running:  connecting to A's socket must fail with EACCES (the 0700 home);
//   with A's daemon stopped: B cannot create a socket at A's path, and binding A's TCP port gets B nothing,
//   because A's clients do not use the port while endpoint.json names a socket.
void os;
