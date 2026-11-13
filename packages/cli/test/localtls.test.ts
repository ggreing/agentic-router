// Decisions 156-158 in the CLI: the local TLS certificate (a leaf made with openssl, checked as a pair, renewed near
// its end), how Claude Code is told to trust it (NODE_EXTRA_CA_CERTS in its settings, a bundle whenever the user has a
// value of their own), the settings round trip through the modes and uninstall, the fallback without openssl, doctor's
// checks, and the daemon's endpoint files. Temp homes and settings files only. The tests that need openssl skip when
// none is found.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { socketCandidates } from '@do-it-all-claude-code/core';
import { EXTRA_CA_ENV, HELPER_TTL_ENV, HELPER_TTL_MS, planApiSettings, planSubscriptionSettings } from '../src/apimode.ts';
import { configureApi, setMode, tlsChoice, type ApiDeps } from '../src/apicmds.ts';
import { localTlsChecks } from '../src/doctor.ts';
import { removeEndpointFiles } from '../src/endpointfiles.ts';
import {
  RENEW_WITHIN_DAYS, certInfo, certNeed, certProblems, ensureProxyCert, findOpenssl, pairMatches, pemFingerprints, prepareTls, renewTlsIfDue, tlsPaths,
} from '../src/localtls.ts';
import { classifyHolder } from '../src/proxyholder.ts';
import { ensureLocalState, readConfig } from '../src/setup.ts';
import { planUserSettings } from '../src/uninstall.ts';

let tmp = '';
let settingsFile = '';
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-cli-tls-'));
  process.env.DO_IT_ALL_CLAUDE_CODE_HOME = path.join(tmp, 'home');
  settingsFile = path.join(tmp, 'claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
});
const OPENSSL = findOpenssl();
const needs = { skip: OPENSSL ? false : 'no openssl on this machine' };
const env = () => (JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as { env?: Record<string, string> }).env ?? {};
const home = () => process.env.DO_IT_ALL_CLAUDE_CODE_HOME!;
const DAY = 86_400_000;

async function setup(): Promise<number> {
  const { config } = await ensureLocalState();
  return (await configureApi(config, { out: () => {} } as Pick<ApiDeps, 'out'>)).proxyPort!;
}
function deps(o: Partial<ApiDeps> = {}): ApiDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines, settingsFile, confirm: async () => true, login: async () => ({ code: 0, stdout: '{"loggedIn":false}' }),
    vault: { status: async () => 'present', storeInteractive: async () => {}, storeFromStdin: async () => {} },
    isTTY: false, readStdin: async () => '', out: l => { lines.push(l); }, reload: () => false, env: {}, ...o,
  };
}
/** A certificate standing for a user's corporate CA: the router's own kind, made in another home. */
function corpCa(name: string): string {
  const h = path.join(tmp, `corp-${name}`);
  assert.notEqual(ensureProxyCert({ home: h, openssl: OPENSSL! }).state, 'unavailable');
  const f = path.join(tmp, `${name}.pem`);
  fs.copyFileSync(tlsPaths(h).cert, f);
  return f;
}
const fp = (file: string) => pemFingerprints(fs.readFileSync(file, 'utf8'));

test('decision 157: a leaf certificate for 127.0.0.1 and localhost, user-only, kept, renewed near its end; a broken pair or the older CA shape is remade', needs, () => {
  const r = ensureProxyCert({ home: home(), openssl: OPENSSL! });
  assert.equal(r.state, 'created');
  if (r.state === 'unavailable') return;
  assert.ok(r.info.sans.includes('IP Address:127.0.0.1') && r.info.sans.includes('DNS:localhost'), r.info.sans.join());
  assert.equal(r.info.ca, false, 'a leaf: its key cannot make certificates Claude Code would accept');
  const p = tlsPaths(home());
  assert.ok(pairMatches(fs.readFileSync(p.cert, 'utf8'), fs.readFileSync(p.key, 'utf8')));
  if (process.platform !== 'win32') {
    for (const f of [p.key, p.cert]) assert.equal(fs.statSync(f).mode & 0o777, 0o600, f);
    assert.equal(fs.statSync(p.dir).mode & 0o777, 0o700);
  }
  assert.deepEqual(fs.readdirSync(p.dir).sort(), ['proxy-cert.pem', 'proxy-key.pem'], 'no temporary or config files left');
  assert.equal(ensureProxyCert({ home: home(), openssl: OPENSSL! }).state, 'kept');
  // near its end: renewed (a new certificate, same names)
  const near = new Date(r.info.notAfter.getTime() - (RENEW_WITHIN_DAYS - 1) * DAY);
  const renewed = ensureProxyCert({ home: home(), openssl: OPENSSL!, now: near });
  assert.equal(renewed.state, 'renewed');
  if (renewed.state !== 'unavailable') assert.notEqual(renewed.info.fingerprint, r.info.fingerprint);
  // review M2: a key from elsewhere (a renewal stopped between its two renames) is found and remade
  const other = path.join(tmp, 'other-home');
  ensureProxyCert({ home: other, openssl: OPENSSL! });
  fs.copyFileSync(tlsPaths(other).key, p.key);
  assert.deepEqual([certNeed({ home: home() }).need, certNeed({ home: home() }).why], ['make', 'the key and the certificate do not match']);
  assert.equal(ensureProxyCert({ home: home(), openssl: OPENSSL! }).state, 'renewed');
  assert.ok(pairMatches(fs.readFileSync(p.cert, 'utf8'), fs.readFileSync(p.key, 'utf8')));
  // the older CA shape (the first release of decision 157) is remade as a leaf, unless the caller says not to (the timer)
  const cnf = path.join(tmp, 'ca.cnf');
  fs.writeFileSync(cnf, '[req]\ndistinguished_name = dn\nx509_extensions = v3ext\nprompt = no\n[dn]\nCN = old\n[v3ext]\nsubjectAltName = IP:127.0.0.1, DNS:localhost\nbasicConstraints = critical, CA:TRUE\nkeyUsage = critical, digitalSignature, keyCertSign\n');
  const made = spawnSync(OPENSSL!, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', p.key, '-out', p.cert, '-days', '400', '-config', cnf], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  assert.equal(certNeed({ home: home(), remakeOldShape: false }).need, 'none', 'the timer leaves a working older certificate alone');
  assert.match(certNeed({ home: home() }).why ?? '', /CA certificate \(the older shape\)/);
  // remaking it fails (an openssl that cannot run): the older pair still works, so it is kept, and nothing throws
  const broken = path.join(tmp, 'no-such-openssl');
  assert.equal(ensureProxyCert({ home: home(), openssl: broken }).state, 'kept');
  const keep = prepareTls({ settingsEnv: {}, shellEnv: {}, home: home(), openssl: broken });
  assert.ok(keep.on);
  if (keep.on) keep.materialize();
  assert.equal(certInfo(fs.readFileSync(p.cert, 'utf8'))!.ca, true, 'the older certificate is still in place');
  const reshaped = ensureProxyCert({ home: home(), openssl: OPENSSL! });
  assert.ok(reshaped.state !== 'unavailable' && reshaped.info.ca === false);
  // expired, and the wrong names, are problems
  assert.match(certProblems(r.info, new Date(r.info.notAfter.getTime() + 1000)).problems.join(), /expired/);
  assert.match(certProblems({ ...r.info, sans: ['DNS:example.com'] }).problems.join(), /not IP 127\.0\.0\.1 and DNS localhost/);
});

test('decision 157: without openssl TLS stays off (no certificate is made); a certificate that still works is kept', () => {
  assert.deepEqual(ensureProxyCert({ home: home(), openssl: null }), { state: 'unavailable', reason: 'openssl was not found (Git for Windows ships one; or set OPENSSL_BIN)' });
  assert.ok(!fs.existsSync(tlsPaths(home()).dir));
  const c = prepareTls({ settingsEnv: {}, shellEnv: {}, home: home(), openssl: null });
  assert.deepEqual([c.on, !c.on && /openssl was not found/.test(c.reason)], [false, true]);
});

test('decision 158: whenever the user has NODE_EXTRA_CA_CERTS (launch environment, settings, or both), the settings value is a bundle with theirs and ours; nothing is written before materialize', needs, () => {
  const p = tlsPaths(home());
  const a = corpCa('corp-a');
  const b = corpCa('corp-b');
  // none of the user's: the router's certificate; prepareTls alone writes nothing
  const plain = prepareTls({ settingsEnv: {}, shellEnv: {}, home: home(), openssl: OPENSSL! });
  assert.ok(plain.on && plain.caFile === p.cert && plain.pending.some(x => /make the local TLS certificate/.test(x)));
  assert.ok(!fs.existsSync(p.dir), 'decided only');
  if (plain.on) plain.materialize();
  const ours = fp(p.cert)[0]!;
  // in the launch environment only: TLS on, the bundle
  const launch = prepareTls({ settingsEnv: {}, shellEnv: { NODE_EXTRA_CA_CERTS: a }, home: home(), openssl: OPENSSL! });
  assert.ok(launch.on && launch.caFile === p.bundle);
  if (launch.on) { assert.deepEqual(launch.bundleFrom, [a]); launch.materialize(); }
  assert.deepEqual(new Set(fp(p.bundle)), new Set([fp(a)[0], ours]));
  // in both: every source once, then ours
  const both = prepareTls({ settingsEnv: { NODE_EXTRA_CA_CERTS: b }, shellEnv: { NODE_EXTRA_CA_CERTS: a }, home: home(), openssl: OPENSSL! });
  assert.ok(both.on && both.caFile === p.bundle);
  if (both.on) { assert.deepEqual(both.bundleFrom, [a, b]); both.materialize(); }
  assert.deepEqual(new Set(fp(p.bundle)), new Set([fp(a)[0], fp(b)[0], ours]));
  // the settings (and the launch value) already name our bundle: its recorded sources; current, so nothing to do
  const again = prepareTls({ settingsEnv: { NODE_EXTRA_CA_CERTS: p.bundle }, shellEnv: { NODE_EXTRA_CA_CERTS: p.bundle }, home: home(), openssl: OPENSSL!, bundleFrom: [a, b] });
  assert.ok(again.on && again.caFile === p.bundle && again.pending.length === 0);
  // a source that cannot be read is said, and left out
  const gone = prepareTls({ settingsEnv: {}, shellEnv: { NODE_EXTRA_CA_CERTS: path.join(tmp, 'nothing.pem') }, home: home(), openssl: OPENSSL! });
  assert.ok(gone.on && /cannot be read and is left out/.test(gone.note ?? ''));
});

test('decisions 157-158: proxy mode with TLS: https base URL, the bundle for a launch-environment CA, the short helper cache; the other modes and uninstall take them out and put the user\'s latest value back', needs, async () => {
  const port = await setup();
  const a = corpCa('corp-a');
  const b = corpCa('corp-b');
  const p = tlsPaths(home());
  fs.writeFileSync(settingsFile, JSON.stringify({ env: { KEEP: '1' } }));
  const d = deps({ openssl: OPENSSL!, env: { NODE_EXTRA_CA_CERTS: a } });
  assert.equal(await setMode('proxy', { yes: true }, d), 0);
  let e = env();
  assert.equal(e.ANTHROPIC_BASE_URL, `https://127.0.0.1:${port}`);
  assert.equal(e[EXTRA_CA_ENV], p.bundle);
  assert.equal(e[HELPER_TTL_ENV], String(HELPER_TTL_MS));
  assert.equal(readConfig()!.proxy?.tls, true);
  assert.deepEqual(readConfig()!.localTls?.bundleFrom, [a]);
  assert.equal(planApiSettings(settingsFile, 'proxy', port, undefined, d.env!, tlsChoice(settingsFile, readConfig()!, d.env!, OPENSSL!)), null, 'idempotent');
  assert.equal(await setMode('direct', { yes: true }, d), 0);
  e = env();
  assert.deepEqual([e[EXTRA_CA_ENV], e[HELPER_TTL_ENV], e.ANTHROPIC_BASE_URL, e.KEEP], [undefined, undefined, undefined, '1'], 'the launch value applies again');
  // a settings value of the user's
  fs.writeFileSync(settingsFile, JSON.stringify({ env: { NODE_EXTRA_CA_CERTS: b } }));
  const d2 = deps({ openssl: OPENSSL!, env: {} });
  assert.equal(await setMode('proxy', { yes: true }, d2), 0);
  assert.equal(env()[EXTRA_CA_ENV], p.bundle);
  // review L4: the user changes it meanwhile; the next mode api records that latest value, which undo then restores
  fs.writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')), env: { ...env(), [EXTRA_CA_ENV]: a } }));
  assert.equal(await setMode('proxy', { yes: true }, d2), 0);
  assert.equal(env()[EXTRA_CA_ENV], p.bundle);
  planSubscriptionSettings(settingsFile)!.apply();
  assert.deepEqual([env()[EXTRA_CA_ENV], env()[HELPER_TTL_ENV]], [a, undefined], 'the latest value of the user\'s, not the first');
  // and uninstall's settings plan
  assert.equal(await setMode('proxy', { yes: true }, d2), 0);
  planUserSettings(settingsFile, readConfig())!.apply();
  assert.deepEqual([env()[EXTRA_CA_ENV], env()[HELPER_TTL_ENV], env().ANTHROPIC_BASE_URL], [a, undefined, undefined]);
});

test('decision 157: no openssl: proxy mode stays on plain HTTP, says why, and still shortens the helper cache', async () => {
  const port = await setup();
  const d = deps({ openssl: null });
  assert.equal(await setMode('proxy', { yes: true }, d), 0);
  const e = env();
  assert.deepEqual([e.ANTHROPIC_BASE_URL, e[EXTRA_CA_ENV], e[HELPER_TTL_ENV]], [`http://127.0.0.1:${port}`, undefined, String(HELPER_TTL_MS)]);
  assert.equal(readConfig()!.proxy?.tls, false);
  assert.match(readConfig()!.localTls?.off ?? '', /openssl was not found/);
  const check = localTlsChecks(readConfig()!, e, {})[0]!;
  assert.deepEqual([check.ok, check.blocking], [false, false]);
  assert.match(check.detail, /^off: openssl was not found.*the helper still checks the proxy/);
});

test('decisions 157-158: doctor checks the certificate (dates, names, pair), what Claude Code trusts, the bundle, and warns about a launch-environment value', needs, async () => {
  await setup();
  const a = corpCa('corp-a');
  const fresh = corpCa('corp-new');
  assert.equal(await setMode('proxy', { yes: true }, deps({ openssl: OPENSSL!, env: { NODE_EXTRA_CA_CERTS: a } })), 0);
  const cfg = readConfig()!;
  const p = tlsPaths(home());
  const info = certInfo(fs.readFileSync(p.cert, 'utf8'))!;
  const run = (o: { now?: Date; settingsEnv?: Record<string, unknown>; shell?: NodeJS.ProcessEnv } = {}) =>
    localTlsChecks(cfg, o.settingsEnv ?? env(), o.shell ?? {}, o.now ?? new Date()).map(c => [c.name, c.ok, c.blocking]);
  assert.deepEqual(run(), [['local TLS', true, false], ['local TLS trust', true, false]]);
  assert.deepEqual(run({ now: new Date(info.notAfter.getTime() - 40 * DAY) })[0], ['local TLS', false, false], 'inside the warning window');
  assert.deepEqual(run({ now: new Date(info.notAfter.getTime() + 1000) })[0], ['local TLS', false, true], 'expired');
  assert.deepEqual(run({ settingsEnv: {} })[1], ['local TLS trust', false, true], 'the settings do not name it');
  // decision 158: a launch value is a warning (the settings value wins today), in the bundle or not
  assert.deepEqual(run({ shell: { NODE_EXTRA_CA_CERTS: a } }).at(-1), ['NODE_EXTRA_CA_CERTS in your environment', false, false]);
  assert.deepEqual(run({ shell: { NODE_EXTRA_CA_CERTS: fresh } }).at(-1), ['NODE_EXTRA_CA_CERTS in your environment', false, false]);
  assert.equal(run({ shell: { NODE_EXTRA_CA_CERTS: p.bundle } }).length, 2, 'pointed at the bundle: nothing to say');
  // review L5: a source that changed, or cannot be read
  fs.copyFileSync(fresh, a);
  assert.deepEqual(run().at(-1), ['local TLS bundle', false, false]);
  fs.rmSync(a);
  assert.match(localTlsChecks(cfg, env(), {}).at(-1)!.detail, /cannot be read/);
  // review M2: a key that does not match blocks
  fs.copyFileSync(tlsPaths(path.join(tmp, 'corp-corp-new')).key, p.key);
  assert.match(localTlsChecks(cfg, env(), {})[0]!.detail, /its key does not match it/);
});

test('review M4: the supervisor at its start renews within 30 days; its timer only within 3 days, or after the end', needs, async () => {
  await setup();
  assert.equal(await setMode('proxy', { yes: true }, deps({ openssl: OPENSSL! })), 0);
  const info = certInfo(fs.readFileSync(tlsPaths(home()).cert, 'utf8'))!;
  const at = (days: number) => new Date(info.notAfter.getTime() - days * DAY);
  assert.equal(renewTlsIfDue(home(), { openssl: OPENSSL!, at: 'start' }).cert, 'kept');
  assert.equal(renewTlsIfDue(home(), { openssl: OPENSSL!, at: 'timer', now: at(10) }).cert, 'kept', '10 days left: not on the timer');
  assert.equal(renewTlsIfDue(home(), { openssl: OPENSSL!, at: 'start', now: at(10) }).cert, 'renewed', 'but at start');
  const info2 = certInfo(fs.readFileSync(tlsPaths(home()).cert, 'utf8'))!;
  assert.equal(renewTlsIfDue(home(), { openssl: OPENSSL!, at: 'timer', now: new Date(info2.notAfter.getTime() - 2 * DAY) }).cert, 'renewed', '2 days left: on the timer too');
});

test('review M3: a holder that does not prove itself: the user\'s own node process is a likely proxy, anything else is not', () => {
  assert.deepEqual(classifyHolder({ pid: 7, user: 'me', mine: true }, 'node.exe'), { own: true, phrase: 'your own node.exe (pid 7, user me)' });
  assert.equal(classifyHolder({ pid: 7, user: 'me', mine: true }, '/usr/bin/node').own, true);
  // review R4: "own" is the listener's user (the kernel says so; on Linux a uid without a pid), not the process name
  assert.deepEqual(classifyHolder({ uid: 1000, mine: true }, undefined), { own: true, phrase: 'your own process (uid 1000)' });
  assert.equal(classifyHolder({ pid: 7, user: 'me', mine: true }, 'python3').own, true);
  assert.equal(classifyHolder({ pid: 9, user: 'bob', mine: false }, 'node').phrase, 'ANOTHER user\'s node (pid 9, user bob)');
  assert.deepEqual(classifyHolder({ pid: 9 }, undefined), { own: false, phrase: 'a process (pid 9)' }, 'the user unknown: not own');
  assert.deepEqual(classifyHolder(undefined, undefined), { own: false, phrase: 'a process that could not be identified' });
});

test('decision 156: uninstall and an offline purge remove the daemon\'s endpoint file and socket (the one it named first), and a fallback socket directory only when it is ours', async () => {
  const h = home();
  fs.mkdirSync(h, { recursive: true });
  fs.writeFileSync(path.join(h, 'endpoint.json'), '{"version":1,"pid":1,"startedAt":"","port":4711}');
  if (process.platform === 'win32') {
    assert.deepEqual(removeEndpointFiles(h, { dryRun: true }), [path.join(h, 'endpoint.json')]);
    assert.deepEqual(removeEndpointFiles(h), [path.join(h, 'endpoint.json')]);
    assert.ok(!fs.existsSync(path.join(h, 'endpoint.json')));
    return;
  }
  // a home path too long for a socket name, so the fallback directory is used
  const long = path.join(h, 'x'.repeat(120));
  fs.mkdirSync(long, { recursive: true });
  fs.writeFileSync(path.join(long, 'endpoint.json'), '{}');
  // The fallback base, and the socket the daemon names below, are in a short directory straight under /tmp: the
  // per-test temp directory is itself too long for a socket path on macOS (/var/folders/…/T/…), which would leave no
  // candidate to test (and no socket to listen on).
  const short = fs.realpathSync(fs.mkdtempSync('/tmp/ar-'));
  try {
    const base = path.join(short, 'run');
    fs.mkdirSync(base);
    const o = { env: { XDG_RUNTIME_DIR: base }, tmpdir: path.join(short, 'tmp-none') };
    const candidates = socketCandidates(long, o).filter(c => c.fallback);
    assert.ok(candidates.length >= 1, `a fallback place fits (${socketCandidates(long, o).map(c => c.path).join(', ') || 'none'})`);
    const fallback = candidates[0]!;
    fs.mkdirSync(fallback.dir, { mode: 0o700 });
    fs.writeFileSync(fallback.path, '');
    assert.deepEqual(removeEndpointFiles(long, { ...o, dryRun: true }).sort(), [path.join(long, 'endpoint.json'), fallback.path, fallback.dir].sort());
    removeEndpointFiles(long, o);
    assert.deepEqual(fs.readdirSync(base), [], 'the fallback directory is gone');
    // review L6: the socket the daemon named (elsewhere than this environment derives) goes too, when its directory is ours
    const named = path.join(short, 'named-run');
    fs.mkdirSync(named, { mode: 0o700 });
    const endpointNaming = (socket: string) => fs.writeFileSync(path.join(long, 'endpoint.json'), JSON.stringify({ version: 1, pid: 1, startedAt: '', port: 4711, socket }));
    // review R5: only a real socket called daemon.sock: a regular file of that name, or any other file named, is kept
    fs.writeFileSync(path.join(named, 'daemon.sock'), 'not a socket');
    endpointNaming(path.join(named, 'daemon.sock'));
    removeEndpointFiles(long, o);
    assert.equal(fs.readFileSync(path.join(named, 'daemon.sock'), 'utf8'), 'not a socket');
    fs.writeFileSync(path.join(named, 'notes.txt'), 'keep');
    endpointNaming(path.join(named, 'notes.txt'));
    removeEndpointFiles(long, o);
    assert.equal(fs.readFileSync(path.join(named, 'notes.txt'), 'utf8'), 'keep');
    fs.rmSync(path.join(named, 'daemon.sock'));
    fs.rmSync(path.join(named, 'notes.txt'));
    const listener = net.createServer();
    await new Promise<void>(r => listener.listen(path.join(named, 'daemon.sock'), () => r()));
    endpointNaming(path.join(named, 'daemon.sock'));
    removeEndpointFiles(long, o);
    await new Promise<void>(r => listener.close(() => r()));
    assert.ok(!fs.existsSync(named), 'the named socket and its private directory are gone');
    // a fallback "directory" that is a link, or open to others, is left alone
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere, { mode: 0o700 });
    fs.writeFileSync(path.join(elsewhere, 'daemon.sock'), 'keep');
    fs.symlinkSync(elsewhere, fallback.dir);
    removeEndpointFiles(long, o);
    assert.ok(fs.existsSync(path.join(elsewhere, 'daemon.sock')), 'nothing removed through a link');
    fs.unlinkSync(fallback.dir);
    fs.mkdirSync(fallback.dir, { mode: 0o755 });
    fs.chmodSync(fallback.dir, 0o755);
    fs.writeFileSync(fallback.path, '');
    removeEndpointFiles(long, o);
    assert.ok(fs.existsSync(fallback.path), 'not a private directory: not ours to clean');
  } finally { fs.rmSync(short, { recursive: true, force: true }); }
});
