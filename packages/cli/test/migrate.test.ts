// Decision 161: init moves the previous release's home, settings entries and keychain entry to the new names.
// Temp homes and settings, a fake keychain and fake processes: nothing real is read, stopped or moved.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VAULT_SERVICE, VaultError } from '@do-it-all-claude-code/proxy';
import { isRouterHelper } from '../src/apimode.ts';
import {
  LEGACY_VAULT_SERVICE, checkOldHome, legacyHomeCheck, legacyHomeToMove, migrateHome, moveApiKey, moveHomeFolder, moveSettingsEntries,
  oldRouterProcesses, rehome, rehomeConfig, renamePermission, stopOldRouter, type KeyMover, type MigrateDeps, type ProcessDeps,
} from '../src/migrate.ts';
import { backupFile, isRouterStatusLine, legacyBackupFile, moveBackupFile } from '../src/setup.ts';

let tmp = '';
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ar-migrate-'))); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any
const FAKE_KEY = 'sk-ant-api03-abcdefghijklmnop';   // a fake the other keychain tests use too
const POSIX = process.platform !== 'win32';
/** A link to a folder: a junction on Windows (no privilege needed), a symlink elsewhere. */
const linkDir = (target: string, link: string) => fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');

/** A keychain in memory, by service name; `calls` records what was asked (never the key). */
function fakeKeys(entries: Record<string, string> = {}, o: { failStore?: boolean; failRemove?: boolean } = {}): KeyMover & { entries: Record<string, string>; calls: string[] } {
  const calls: string[] = [];
  return {
    entries, calls,
    async status(s) { calls.push(`status ${s}`); return s in entries ? 'present' : 'not_found'; },
    async read(s) { calls.push(`read ${s}`); if (!(s in entries)) throw new VaultError('not_found', 'none'); return entries[s]!; },
    async store(s, key) { calls.push(`store ${s}`); if (o.failStore) throw new VaultError('unavailable', 'no keychain'); entries[s] = key; },
    async storeInteractive(s) { calls.push(`storeInteractive ${s}`); entries[s] = FAKE_KEY; },
    async remove(s) { calls.push(`remove ${s}`); if (o.failRemove) throw new VaultError('failed', 'locked'); delete entries[s]; },
  };
}

const BEFORE = () => Date.now() - 60_000;   // started before the pid file was written
const AFTER = () => Date.now() + 60_000;    // started after it: a reused pid

/**
 * Processes in memory: pid -> command line and start time. A pid lives until killed (unless stubborn); the
 * supervisor ends when its stop file appears, and takes `children` with it.
 */
function fakeProcesses(home: string, procs: Record<number, { cmd: string; start?: number }>, o: { stubborn?: number[]; supervisor?: number; children?: number[]; daemonAccepts?: boolean; entries?: { supervisor: string[]; child: string[] } } = {}): ProcessDeps & { killed: number[]; shutdowns: number } {
  const alive = new Set(Object.keys(procs).map(Number));
  const d = {
    killed: [] as number[], shutdowns: 0, waitMs: 300, entries: o.entries ?? { supervisor: [], child: [] },
    isAlive(pid: number) {
      if (pid === o.supervisor && alive.has(pid) && fs.existsSync(path.join(home, 'supervise.stop'))) { alive.delete(pid); for (const c of o.children ?? []) alive.delete(c); }
      return alive.has(pid);
    },
    info: (pid: number) => (alive.has(pid) && procs[pid] ? { commandLine: procs[pid]!.cmd, ...(procs[pid]!.start !== undefined ? { startedAt: procs[pid]!.start } : {}) } : null),
    kill(pid: number) { d.killed.push(pid); if (!o.stubborn?.includes(pid)) alive.delete(pid); },
    async shutdownDaemon() { d.shutdowns++; if (o.daemonAccepts) for (const p of Object.keys(procs).map(Number)) if (/daemon/.test(procs[p]!.cmd)) alive.delete(p); return o.daemonAccepts === true; },
    async sleep() { /* no time passes in tests */ },
  };
  return d;
}
const SUP = 'node /opt/agentic-router/packages/cli/src/index.ts supervise';
const DAEMON = 'node /opt/agentic-router/packages/daemon/src/main.ts';
const PROXY = 'node /usr/lib/node_modules/@agentic-router/proxy/src/main.ts';

test('decision 161: which old home init may move (a home set only by the new variable is never filled with the default old one)', () => {
  const u = path.join(tmp, 'user');
  assert.equal(legacyHomeToMove({}, u), path.join(u, '.agentic-router'));
  assert.equal(legacyHomeToMove({ DO_IT_ALL_CLAUDE_CODE_HOME: path.join(tmp, 'x') }, u), undefined, 'a test or script home');
  assert.equal(legacyHomeToMove({ AGENTIC_ROUTER_HOME: path.join(tmp, 'old') }, u), path.join(tmp, 'old'));
  assert.equal(legacyHomeToMove({ AGENTIC_ROUTER_HOME: path.join(tmp, 'old'), DO_IT_ALL_CLAUDE_CODE_HOME: path.join(tmp, 'x') }, u), path.join(tmp, 'old'));
  assert.equal(legacyHomeToMove({ AGENTIC_ROUTER_HOME: 'relative' }, u), path.join(u, '.agentic-router'), 'a relative value is ignored, as before');
});

test('review M1: only a real folder of this user that holds config.json or a token is a home init moves', () => {
  const home = path.join(tmp, 'old');
  assert.deepEqual(checkOldHome(home), { ok: false, why: 'it is not there' });
  fs.mkdirSync(home, { mode: 0o700 });
  if (POSIX) fs.chmodSync(home, 0o700);
  assert.match((checkOldHome(home) as { why: string }).why, /no config\.json or token/);
  fs.writeFileSync(path.join(home, 'token'), 'local-token');
  assert.deepEqual(checkOldHome(home), { ok: true });
  const link = path.join(tmp, 'link');
  linkDir(home, link);
  assert.match((checkOldHome(link) as { why: string }).why, /it is a link/);
  fs.writeFileSync(path.join(tmp, 'file'), '');
  assert.match((checkOldHome(path.join(tmp, 'file')) as { why: string }).why, /not a folder/);
  if (POSIX) {
    const uid = fs.statSync(home).uid;
    assert.match((checkOldHome(home, uid + 1) as { why: string }).why, new RegExp(`belongs to another user \\(uid ${uid}\\)`));
    fs.chmodSync(home, 0o755);
    assert.deepEqual(checkOldHome(home), { ok: true, looseMode: 0o755 }, 'open to others: moved, then closed');
  }
});

test('decision 161: rehome replaces the old home where it begins a path, in every way it is written, and nothing else', () => {
  const o = 'C:\\Users\\a\\.agentic-router', n = 'C:\\Users\\a\\.do-it-all-claude-code';
  assert.equal(rehome('C:\\Users\\a\\.agentic-router\\tls\\ca-bundle.pem', o, n, 'win32'), 'C:\\Users\\a\\.do-it-all-claude-code\\tls\\ca-bundle.pem');
  assert.equal(rehome('c:/users/A/.agentic-router/tls/cert.pem', o, n, 'win32'), 'C:/Users/a/.do-it-all-claude-code/tls/cert.pem');
  assert.equal(rehome('Read(//c/Users/a/.agentic-router/logs/**)', o, n, 'win32'), 'Read(//c/Users/a/.do-it-all-claude-code/logs/**)');
  assert.equal(rehome('node "C:\\Users\\a\\.agentic-router"', o, n, 'win32'), 'node "C:\\Users\\a\\.do-it-all-claude-code"');
  assert.equal(rehome('C:\\Users\\a\\.agentic-router-bench\\x', o, n, 'win32'), 'C:\\Users\\a\\.agentic-router-bench\\x', 'another folder');
  assert.equal(rehome('/home/a/.agentic-router/tls/b.pem', '/home/a/.agentic-router', '/home/a/.do-it-all-claude-code', 'linux'), '/home/a/.do-it-all-claude-code/tls/b.pem');
  assert.equal(rehome('/HOME/a/.agentic-router/x', '/home/a/.agentic-router', '/n', 'linux'), '/HOME/a/.agentic-router/x', 'case matters on Linux');
  assert.equal(rehome('Read(~/.agentic-router/**)', '/home/a/.agentic-router', '/home/a/.do-it-all-claude-code', 'linux', '/home/a'), 'Read(~/.do-it-all-claude-code/**)');
  assert.equal(rehome('Read(~/.agentic-router/**)', '/home/a/.agentic-router', '/home/a/.do-it-all-claude-code', 'linux'), 'Read(~/.agentic-router/**)', 'the ~ form only with the user home');
});

test('review: rehome needs the old home at the start of a path, not as the tail of another one (POSIX and Windows forms)', () => {
  const o = '/home/u/.agentic-router', n = '/home/u/.do-it-all-claude-code';
  const px = (s: string) => rehome(s, o, n, 'linux', '/home/u');
  // the tail of another path: unchanged
  for (const s of ['Read(/mnt/backup/home/u/.agentic-router/**)', 'Read(/mnt/backup//home/u/.agentic-router/**)', '/srv/x/home/u/.agentic-router', 'Read(foo~/.agentic-router/**)', 'Read(a.~/.agentic-router)']) assert.equal(px(s), s, s);
  // a whole path, or one that begins with it: rewritten
  assert.equal(px('Read(/home/u/.agentic-router/**)'), 'Read(/home/u/.do-it-all-claude-code/**)');
  assert.equal(px('Read(//home/u/.agentic-router/**)'), 'Read(//home/u/.do-it-all-claude-code/**)');
  assert.equal(px('"//home/u/.agentic-router/x"'), '"//home/u/.do-it-all-claude-code/x"');
  assert.equal(px('/home/u/.agentic-router'), '/home/u/.do-it-all-claude-code');
  assert.equal(px('"/home/u/.agentic-router/tls/ca-bundle.pem"'), '"/home/u/.do-it-all-claude-code/tls/ca-bundle.pem"', 'a quoted env value');
  assert.equal(px('--use-openssl-ca --cafile=/home/u/.agentic-router/tls/b.pem'), '--use-openssl-ca --cafile=/home/u/.do-it-all-claude-code/tls/b.pem');
  assert.equal(px('/etc/a.pem:/home/u/.agentic-router/b.pem'), '/etc/a.pem:/home/u/.do-it-all-claude-code/b.pem', 'a list');
  assert.equal(px('Read(~/.agentic-router/**)'), 'Read(~/.do-it-all-claude-code/**)');
  const wo = 'C:\\Users\\u\\.agentic-router', wn = 'C:\\Users\\u\\.do-it-all-claude-code';
  const win = (s: string) => rehome(s, wo, wn, 'win32', 'C:\\Users\\u');
  for (const s of ['Read(/mnt/backup/c/Users/u/.agentic-router/**)', 'Read(D:\\backup\\C:\\Users\\u\\.agentic-router)', 'XC:\\Users\\u\\.agentic-router\\x', 'E:/old/C:/Users/u/.agentic-router']) assert.equal(win(s), s, s);
  assert.equal(win('"C:\\Users\\u\\.agentic-router\\tls\\ca-bundle.pem"'), '"C:\\Users\\u\\.do-it-all-claude-code\\tls\\ca-bundle.pem"', 'a quoted env value');
  assert.equal(win('C:\\Users\\u\\.agentic-router\\tls\\key.pem'), 'C:\\Users\\u\\.do-it-all-claude-code\\tls\\key.pem', 'a config.json value');
  assert.equal(win('Read(//c/Users/u/.agentic-router/**)'), 'Read(//c/Users/u/.do-it-all-claude-code/**)');
  assert.equal(win('Read(c:/users/U/.agentic-router/logs/**)'), 'Read(C:/Users/u/.do-it-all-claude-code/logs/**)');
  // config.json and env values go through the same rule
  const home = path.join(tmp, 'new');
  fs.mkdirSync(home);
  const old = path.join(tmp, 'old');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ a: path.join(old, 'tls', 'cert.pem'), b: path.join(tmp, 'backup') + old }));
  assert.equal(rehomeConfig(home, old), 1);
  assert.deepEqual(read(path.join(home, 'config.json')), { a: path.join(home, 'tls', 'cert.pem'), b: path.join(tmp, 'backup') + old });
  const env = moveSettingsEntries({ env: { NODE_EXTRA_CA_CERTS: `"${path.join(old, 'b.pem')}"`, BACKUP: `${path.join(tmp, 'backup')}${old}` } }, { oldHome: old, newHome: home })!;
  assert.deepEqual(env.next.env, { NODE_EXTRA_CA_CERTS: `"${path.join(home, 'b.pem')}"`, BACKUP: `${path.join(tmp, 'backup')}${old}` });
});

test('decision 161: the old names are still recognised in settings entries (so init and uninstall find them)', () => {
  assert.equal(isRouterStatusLine('node "/opt/agentic-router/plugin/statusline.mjs"'), true);
  assert.equal(isRouterStatusLine('node "/opt/do-it-all-claude-code/plugin/statusline.mjs"'), true);
  assert.equal(isRouterStatusLine('node "/opt/other/statusline.mjs"'), false);
  const plugin = path.join(tmp, 'p');
  fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'agentic-router' }));
  assert.equal(isRouterStatusLine(`node "${path.join(plugin, 'statusline.mjs')}"`), true, 'by the old manifest name');
  assert.equal(isRouterHelper('node "/x/node_modules/agentic-router/node_modules/@agentic-router/proxy/bin/local-token.mjs"'), true);
  assert.equal(isRouterHelper('node "/x/my-helper.mjs"'), false);
});

test('review M3: a permission rule is renamed by exact prefixes only; a user\'s own folder with the name in it stays', () => {
  const re = (s: string) => rehome(s, '/home/a/.agentic-router', '/home/a/.do-it-all-claude-code', 'linux', '/home/a');
  const cases: Array<[string, string]> = [
    ['mcp__plugin_agentic-router_router__router_plan', 'mcp__plugin_do-it-all-claude-code_router__router_plan'],
    ['mcp__plugin_agentic-router_router__*', 'mcp__plugin_do-it-all-claude-code_router__*'],
    ['Agent(agentic-router:coder)', 'Agent(do-it-all-claude-code:coder)'],
    ['Bash(agentic-router status)', 'Bash(do-it-all-claude-code status)'],
    ['Bash(agentic-router *)', 'Bash(do-it-all-claude-code *)'],
    ['Bash(agentic-router:*)', 'Bash(do-it-all-claude-code:*)'],
    ['Bash(agentic-router)', 'Bash(do-it-all-claude-code)'],
    ['Bash(agentic-router-proxy)', 'Bash(do-it-all-claude-code-proxy)'],
    ['Read(~/.agentic-router/logs/**)', 'Read(~/.do-it-all-claude-code/logs/**)'],
    // left alone: not the router's
    ['Read(~/src/agentic-router/secrets/**)', 'Read(~/src/agentic-router/secrets/**)'],
    ['Bash(my-agentic-router build)', 'Bash(my-agentic-router build)'],
    ['Bash(agentic-routerx)', 'Bash(agentic-routerx)'],
    ['Bash(npm run agentic-router)', 'Bash(npm run agentic-router)'],
    ['Edit(./agentic-router/**)', 'Edit(./agentic-router/**)'],
    ['mcp__agentic-router__tool', 'mcp__agentic-router__tool'],
  ];
  for (const [from, to] of cases) assert.equal(renamePermission(from, re), to, from);
});

test('decision 161: the settings entries the router owns are rewritten; everything else is left as it is', () => {
  const userHome = path.join(tmp, 'u');
  const oldHome = path.join(userHome, '.agentic-router'), newHome = path.join(userHome, '.do-it-all-claude-code');
  const s = {
    model: 'opus',
    statusLine: { type: 'command', command: 'node "/old/agentic-router/plugin/statusline.mjs"', padding: 1 },
    apiKeyHelper: 'node "/old/agentic-router/packages/proxy/bin/local-token.mjs"',
    env: { NODE_EXTRA_CA_CERTS: path.join(oldHome, 'tls', 'ca-bundle.pem'), ANTHROPIC_BASE_URL: 'https://127.0.0.1:47811', FOO: 'bar' },
    permissions: {
      allow: ['mcp__plugin_agentic-router_router__router_plan', 'Bash(agentic-router status)', 'Read(~/.agentic-router/logs/**)', 'Bash(npm test)'],
      deny: ['Read(~/src/agentic-router/secrets/**)', 'Bash(my-agentic-router)'],
      additionalDirectories: [path.join(oldHome, 'scopes'), path.join(userHome, 'work', 'agentic-router')],
    },
    enabledPlugins: { 'agentic-router@ggreing': true, 'other@market': false },
    extraKnownMarketplaces: {
      ggreing: { source: { source: 'github', repo: 'ggreing/agentic-router' } },
      archive: { source: { source: 'github', repo: 'ggreing/agentic-router-archive' } },
      byUrl: { source: { source: 'git', url: 'https://github.com/ggreing/agentic-router.git' } },
    },
  };
  const helpers = { localToken: 'node "/new/proxy/bin/local-token.mjs"', key: 'node "/new/proxy/bin/key-helper.mjs"' };
  const r = moveSettingsEntries(s, { oldHome, newHome, userHome, statusLine: 'node "/new/plugin/statusline.mjs"', helpers })!;
  assert.deepEqual(r.next.statusLine, { type: 'command', command: 'node "/new/plugin/statusline.mjs"', padding: 1 });
  assert.equal(r.next.apiKeyHelper, helpers.localToken);
  assert.deepEqual(r.next.env, { NODE_EXTRA_CA_CERTS: path.join(newHome, 'tls', 'ca-bundle.pem'), ANTHROPIC_BASE_URL: 'https://127.0.0.1:47811', FOO: 'bar' });
  assert.deepEqual(r.next.permissions, {
    allow: ['mcp__plugin_do-it-all-claude-code_router__router_plan', 'Bash(do-it-all-claude-code status)', 'Read(~/.do-it-all-claude-code/logs/**)', 'Bash(npm test)'],
    deny: ['Read(~/src/agentic-router/secrets/**)', 'Bash(my-agentic-router)'],
    additionalDirectories: [path.join(newHome, 'scopes'), path.join(userHome, 'work', 'agentic-router')],
  });
  assert.deepEqual(Object.keys(r.next.enabledPlugins), ['do-it-all-claude-code@ggreing', 'other@market'], 'keys renamed in place');
  assert.equal(r.next.extraKnownMarketplaces.ggreing.source.repo, 'ggreing/do-it-all-claude-code');
  assert.equal(r.next.extraKnownMarketplaces.archive.source.repo, 'ggreing/agentic-router-archive', 'review L2: another repository');
  assert.equal(r.next.extraKnownMarketplaces.byUrl.source.url, 'https://github.com/ggreing/do-it-all-claude-code.git');
  assert.equal(r.next.model, 'opus');
  assert.equal(r.notes.length, 6, r.notes.join(' | '));
  assert.match(r.notes.join(' | '), /permissions: 4 entries name the previous release/);
  assert.ok(!r.notes.join(' ').includes('bar'), 'values are not listed');
  // the key helper keeps its kind; settings of the new release only: nothing to do
  assert.equal(moveSettingsEntries({ apiKeyHelper: 'node "/a/agentic-router/proxy/bin/key-helper.mjs"' }, { oldHome, newHome, helpers })!.next.apiKeyHelper, helpers.key);
  assert.equal(moveSettingsEntries({ model: 'opus', statusLine: { type: 'command', command: 'my-status' }, env: { FOO: 'bar' } }, { oldHome, newHome, helpers }), null);
});

test('decision 161: config.json in the moved home names the new home', () => {
  const oldHome = path.join(tmp, 'old'), home = path.join(tmp, 'new');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    daemonPort: 47800, pluginDir: '/repo/plugin',
    proxy: { tls: { certFile: path.join(oldHome, 'tls', 'cert.pem'), keyFile: path.join(oldHome, 'tls', 'key.pem') } },
    apiEnvAdded: [{ name: 'NODE_EXTRA_CA_CERTS', value: path.join(oldHome, 'tls', 'ca-bundle.pem'), previous: '/etc/corp-ca.pem' }],
  }));
  assert.equal(rehomeConfig(home, oldHome), 3);
  const c = read(path.join(home, 'config.json'));
  assert.equal(c.proxy.tls.certFile, path.join(home, 'tls', 'cert.pem'));
  assert.equal(c.apiEnvAdded[0].value, path.join(home, 'tls', 'ca-bundle.pem'));
  assert.deepEqual([c.daemonPort, c.pluginDir, c.apiEnvAdded[0].previous], [47800, '/repo/plugin', '/etc/corp-ca.pem']);
  assert.equal(rehomeConfig(home, oldHome), 0, 'nothing left to rewrite');
});

test('review M2: a process is the previous release\'s only with a router path and a start before its pid file', () => {
  const home = path.join(tmp, 'old');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'supervise.pid'), '301');
  fs.writeFileSync(path.join(home, 'supervise.json'), JSON.stringify({ pid: 301, children: { daemon: { pid: 302 }, proxy: { pid: 303 } } }));
  fs.writeFileSync(path.join(home, 'daemon.pid'), '302');
  const procs = (p: Record<number, { cmd: string; start?: number }>, entries?: { supervisor: string[]; child: string[] }) => oldRouterProcesses(home, fakeProcesses(home, p, entries ? { entries } : {}));
  assert.deepEqual(procs({ 301: { cmd: SUP, start: BEFORE() }, 302: { cmd: DAEMON, start: BEFORE() }, 303: { cmd: PROXY, start: BEFORE() } }).map(p => [p.what, p.pid, p.confirmed]),
    [['supervisor', 301, true], ['daemon', 302, true], ['proxy', 303, true]]);
  // a folder without the product's name, or another kind of entry on that pid: someone else's
  assert.deepEqual(procs({ 301: { cmd: 'node /work/cli/src/index.ts supervise', start: BEFORE() }, 302: { cmd: 'node /srv/app/daemon/src/main.js', start: BEFORE() }, 303: { cmd: DAEMON.replace('daemon/src/main', 'cli/src/index'), start: BEFORE() } }), []);
  // the current install's own entries count wherever it lives (as isOurDaemon does)
  assert.equal(procs({ 302: { cmd: 'node /work/router/packages/daemon/src/main.ts', start: BEFORE() } }, { supervisor: [], child: ['/work/router/packages/daemon/src/main.ts'] })[0]?.confirmed, true);
  // a reused pid (started after the file was written) or an unknown start: not confirmed, so not stopped
  const late = procs({ 301: { cmd: SUP, start: AFTER() }, 302: { cmd: DAEMON } });
  assert.deepEqual(late.map(p => [p.pid, p.confirmed]), [[301, false], [302, false]]);
  assert.match(late[0]!.why!, /started after supervise\.pid was written/);
  assert.match(late[1]!.why!, /start time cannot be read/);
});

test('decision 161: the previous release is stopped through its supervisor; only confirmed processes are touched', async () => {
  const home = path.join(tmp, 'old');
  fs.mkdirSync(home);
  // a supervisor that answers its stop file, and takes its children with it
  fs.writeFileSync(path.join(home, 'supervise.pid'), '301');
  fs.writeFileSync(path.join(home, 'supervise.json'), JSON.stringify({ pid: 301, children: { daemon: { pid: 302 }, proxy: { pid: 303 } } }));
  let p = fakeProcesses(home, { 301: { cmd: SUP, start: BEFORE() }, 302: { cmd: DAEMON, start: BEFORE() }, 303: { cmd: PROXY, start: BEFORE() } }, { supervisor: 301, children: [302, 303] });
  let r = await stopOldRouter(home, p, [301, 302, 303]);
  assert.deepEqual([r.ok, p.killed], [true, []], r.detail);
  assert.equal(r.detail, 'stopped supervisor pid 301, daemon pid 302, proxy pid 303');
  assert.ok(!fs.existsSync(path.join(home, 'supervise.stop')) && !fs.existsSync(path.join(home, 'supervise.pid')));
  // not what the question listed: nothing is touched
  fs.writeFileSync(path.join(home, 'supervise.json'), JSON.stringify({ pid: 301, children: { proxy: { pid: 303 } } }));
  p = fakeProcesses(home, { 303: { cmd: PROXY, start: BEFORE() } });
  r = await stopOldRouter(home, p, []);
  assert.deepEqual([r.ok, p.killed], [false, []]);
  assert.match(r.detail, /changed since the question \(now: proxy pid 303\)/);
  // a proxy left behind by a supervisor that was killed: forced
  r = await stopOldRouter(home, p, [303]);
  assert.deepEqual([r.ok, p.killed, r.detail], [true, [303], 'stopped proxy pid 303 (forced)']);
  // a reused pid is never signalled
  p = fakeProcesses(home, { 303: { cmd: PROXY, start: AFTER() } });
  r = await stopOldRouter(home, p);
  assert.deepEqual([r.ok, p.killed], [false, []]);
  // a daemon started without a supervisor: the graceful shutdown first
  fs.rmSync(path.join(home, 'supervise.json'));
  fs.writeFileSync(path.join(home, 'daemon.pid'), '401');
  p = fakeProcesses(home, { 401: { cmd: DAEMON, start: BEFORE() } }, { daemonAccepts: true });
  r = await stopOldRouter(home, p);
  assert.deepEqual([r.ok, p.shutdowns, p.killed], [true, 1, []], r.detail);
  // one that will not stop: init must not move the folder under it
  fs.writeFileSync(path.join(home, 'daemon.pid'), '402');
  p = fakeProcesses(home, { 402: { cmd: DAEMON, start: BEFORE() } }, { stubborn: [402] });
  r = await stopOldRouter(home, p);
  assert.deepEqual([r.ok, r.detail], [false, 'daemon pid 402 still running']);
  // nothing running
  assert.deepEqual(await stopOldRouter(path.join(tmp, 'empty'), fakeProcesses(home, {})), { ok: true, detail: 'the previous release was not running' });
});

test('decision 161: the folder moves by rename, or by copy and remove across devices', () => {
  const make = (name: string) => {
    const d = path.join(tmp, name);
    fs.mkdirSync(path.join(d, 'tls'), { recursive: true });
    fs.writeFileSync(path.join(d, 'token'), 'local-token', { mode: 0o600 });
    fs.writeFileSync(path.join(d, 'tls', 'key.pem'), 'k', { mode: 0o600 });
    return d;
  };
  const a = make('a');
  assert.deepEqual(moveHomeFolder(a, path.join(tmp, 'deep', 'new-a')), { how: 'renamed' });
  assert.equal(fs.readFileSync(path.join(tmp, 'deep', 'new-a', 'tls', 'key.pem'), 'utf8'), 'k');
  const b = make('b');
  const exdev = () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); };
  assert.deepEqual(moveHomeFolder(b, path.join(tmp, 'new-b'), exdev), { how: 'copied' });
  assert.ok(!fs.existsSync(b), 'the old folder is removed after the copy');
  assert.equal(fs.readFileSync(path.join(tmp, 'new-b', 'token'), 'utf8'), 'local-token');
  if (POSIX) assert.equal(fs.statSync(path.join(tmp, 'new-b', 'tls', 'key.pem')).mode & 0o777, 0o600, 'the key keeps its mode');
  const c = make('c');
  assert.throws(() => moveHomeFolder(c, path.join(tmp, 'new-c'), () => { throw Object.assign(new Error('denied'), { code: 'ENOTEMPTY' }); }), /denied/);
  assert.ok(fs.existsSync(path.join(c, 'token')), 'a failed move leaves the old folder');
});

test('decision 161: the API key moves to the new keychain name, and the old entry goes only once the new one is there', async () => {
  const out: string[] = [];
  const o = { platform: 'linux' as const, isTTY: false, out: (l: string) => out.push(l) };
  let k = fakeKeys({ [LEGACY_VAULT_SERVICE]: FAKE_KEY });
  const line = await moveApiKey(k, o);
  assert.deepEqual(k.entries, { [VAULT_SERVICE]: FAKE_KEY });
  assert.match(line, /moved to the keychain name "do-it-all-claude-code"; the previous entry "agentic-router" was deleted/);
  assert.ok(!line.includes(FAKE_KEY) && !out.join('').includes(FAKE_KEY), 'the key is never printed');
  // nothing to move; a key already under the new name (the old one is left); a store that fails (the old one is kept)
  assert.match(await moveApiKey(fakeKeys(), o), /none under the previous keychain name/);
  k = fakeKeys({ [LEGACY_VAULT_SERVICE]: FAKE_KEY, [VAULT_SERVICE]: 'sk-ant-api03-new-key' });
  assert.match(await moveApiKey(k, o), /already holds one/);
  assert.ok(LEGACY_VAULT_SERVICE in k.entries && !k.calls.some(c => c.startsWith('remove')));
  k = fakeKeys({ [LEGACY_VAULT_SERVICE]: FAKE_KEY }, { failStore: true });
  assert.match(await moveApiKey(k, o), /not moved \(unavailable\); the previous entry "agentic-router" is kept/);
  assert.deepEqual(Object.keys(k.entries), [LEGACY_VAULT_SERVICE]);
  k = fakeKeys({ [LEGACY_VAULT_SERVICE]: FAKE_KEY }, { failRemove: true });
  assert.match(await moveApiKey(k, o), /could not be deleted \(failed\): delete it yourself/);
  // macOS: security takes a key only from its prompt, so it needs a terminal
  k = fakeKeys({ [LEGACY_VAULT_SERVICE]: FAKE_KEY });
  assert.match(await moveApiKey(k, { ...o, platform: 'darwin' }), /this is not a terminal: run do-it-all-claude-code key set/);
  assert.ok(!k.calls.some(c => c.startsWith('read') || c.startsWith('remove')));
  k = fakeKeys({ [LEGACY_VAULT_SERVICE]: FAKE_KEY });
  assert.match(await moveApiKey(k, { ...o, platform: 'darwin', isTTY: true }), /moved/);
  assert.ok(k.calls.includes(`storeInteractive ${VAULT_SERVICE}`) && !k.calls.some(c => c.startsWith('read')));
});

/** A home of the previous release (its daemon and proxy running under a supervisor), its settings and backup. */
function previousInstall(o: Partial<MigrateDeps> = {}) {
  const oldHome = path.join(tmp, '.agentic-router');
  const newHome = path.join(tmp, '.do-it-all-claude-code');
  fs.mkdirSync(path.join(oldHome, 'tls'), { recursive: true, mode: 0o700 });
  if (POSIX) fs.chmodSync(oldHome, 0o700);
  for (const [f, v] of [['token', 'local-token'], ['proxy-token', 'proxy-token'], ['router.db', 'ledger'], ['tls/cert.pem', 'cert'], ['tls/key.pem', 'key'], ['tls/ca-bundle.pem', 'bundle']]) fs.writeFileSync(path.join(oldHome, f!), v!, { mode: 0o600 });
  fs.writeFileSync(path.join(oldHome, 'config.json'), JSON.stringify({ daemonPort: 47800, proxyPort: 47811, apiMode: 'proxy', proxy: { tls: { certFile: path.join(oldHome, 'tls', 'cert.pem'), keyFile: path.join(oldHome, 'tls', 'key.pem') } } }));
  fs.writeFileSync(path.join(oldHome, 'endpoint.json'), JSON.stringify({ version: 1, pid: 302, startedAt: '', port: 47800 }));
  fs.writeFileSync(path.join(oldHome, 'supervise.pid'), '301');
  fs.writeFileSync(path.join(oldHome, 'supervise.json'), JSON.stringify({ pid: 301, children: { daemon: { pid: 302 }, proxy: { pid: 303 } } }));
  const settingsFile = path.join(tmp, 'claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({
    statusLine: { type: 'command', command: 'node "/repo/agentic-router/plugin/statusline.mjs"' },
    apiKeyHelper: 'node "/repo/agentic-router/packages/proxy/bin/local-token.mjs"',
    env: { NODE_EXTRA_CA_CERTS: path.join(oldHome, 'tls', 'ca-bundle.pem'), ANTHROPIC_BASE_URL: 'https://127.0.0.1:47811', ANTHROPIC_API_KEY: FAKE_KEY },
  }));
  fs.writeFileSync(legacyBackupFile(settingsFile), JSON.stringify({ statusLine: { type: 'command', command: 'mine' } }));
  const out: string[] = [];
  const keys = fakeKeys({ [LEGACY_VAULT_SERVICE]: FAKE_KEY });
  const processes = fakeProcesses(oldHome, { 301: { cmd: SUP, start: BEFORE() }, 302: { cmd: DAEMON, start: BEFORE() }, 303: { cmd: PROXY, start: BEFORE() } }, { supervisor: 301, children: [302, 303] });
  const d: MigrateDeps = {
    // macOS stores a key only from a terminal prompt (tested on its own below), so the move runs the stdin path there too
    env: { AGENTIC_ROUTER_HOME: oldHome }, newHome, platform: process.platform === 'darwin' ? 'linux' : process.platform, settingsFile,
    statusLine: 'node "/repo/plugin/statusline.mjs"', helpers: { localToken: 'node "/repo/proxy/bin/local-token.mjs"', key: 'node "/repo/proxy/bin/key-helper.mjs"' },
    yes: true, isTTY: false, ask: async () => true, out: l => out.push(l), processes, keys, ...o,
  };
  return { oldHome, newHome, settingsFile, out, keys, processes, d };
}
const fresh = () => { fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp); };

test('decision 161: init moves the previous home, its settings entries, the backup and the API key, and reports what it moved', async () => {
  const t = previousInstall();
  assert.equal(await migrateHome(t.d), 'moved', t.out.join('\n'));
  const text = t.out.join('\n');
  assert.match(text, /- stop the previous release: supervisor pid 301, daemon pid 302, proxy pid 303/, 'review M2: the pids are listed in the question');
  assert.ok(!fs.existsSync(t.oldHome));
  for (const [f, v] of [['token', 'local-token'], ['proxy-token', 'proxy-token'], ['router.db', 'ledger'], ['tls/key.pem', 'key'], ['tls/ca-bundle.pem', 'bundle']]) assert.equal(fs.readFileSync(path.join(t.newHome, f!), 'utf8'), v);
  assert.ok(!fs.existsSync(path.join(t.newHome, 'endpoint.json')), 'review L5: the stale endpoint file is not moved');
  assert.equal(read(path.join(t.newHome, 'config.json')).proxy.tls.keyFile, path.join(t.newHome, 'tls', 'key.pem'));
  const s = read(t.settingsFile);
  assert.deepEqual([s.statusLine.command, s.apiKeyHelper, s.env.NODE_EXTRA_CA_CERTS, s.env.ANTHROPIC_BASE_URL],
    ['node "/repo/plugin/statusline.mjs"', 'node "/repo/proxy/bin/local-token.mjs"', path.join(t.newHome, 'tls', 'ca-bundle.pem'), 'https://127.0.0.1:47811']);
  // review L3: the settings as they were, without the credential
  const before = read(moveBackupFile(t.settingsFile));
  assert.equal(before.env.NODE_EXTRA_CA_CERTS, path.join(t.oldHome, 'tls', 'ca-bundle.pem'));
  assert.ok(!('ANTHROPIC_API_KEY' in before.env), 'no credential in the backup');
  assert.ok(fs.existsSync(backupFile(t.settingsFile)) && !fs.existsSync(legacyBackupFile(t.settingsFile)), 'the one-time backup is renamed');
  assert.deepEqual(t.keys.entries, { [VAULT_SERVICE]: FAKE_KEY });
  assert.match(text, /^Moved:$/m);
  assert.match(text, /stopped supervisor pid 301, daemon pid 302, proxy pid 303/);
  assert.match(text, /removed the stopped daemon's endpoint\.json/);
  assert.match(text, /config\.json: 2 values now under/);
  assert.match(text, /API key: moved/);
  assert.ok(!text.includes(FAKE_KEY), 'the key is never printed');
  // run again: nothing left to move; doctor no longer warns
  assert.equal(await migrateHome(t.d), 'none');
  assert.equal(legacyHomeCheck({ AGENTIC_ROUTER_HOME: t.oldHome }, undefined, t.newHome), null);
});

test('decision 161: on macOS without a terminal the home moves, the previous keychain entry stays, and the report says how to finish', { skip: !POSIX }, async () => {
  const t = previousInstall({ platform: 'darwin', isTTY: false });
  assert.equal(await migrateHome(t.d), 'moved', t.out.join('\n'));
  assert.ok(!fs.existsSync(t.oldHome) && fs.existsSync(path.join(t.newHome, 'token')));
  assert.deepEqual(t.keys.entries, { [LEGACY_VAULT_SERVICE]: FAKE_KEY }, 'the previous entry is kept');
  assert.ok(!t.keys.calls.some(c => c.startsWith('read') || c.startsWith('store') || c.startsWith('remove')));
  assert.match(t.out.join('\n'), /API key: macOS stores a key only interactively, and this is not a terminal: run do-it-all-claude-code key set, then delete the previous entry "agentic-router"/);
});

test('review M1: a folder open to other users is moved and then closed', { skip: !POSIX }, async () => {
  const t = previousInstall();
  fs.chmodSync(t.oldHome, 0o755);
  assert.equal(await migrateHome(t.d), 'moved', t.out.join('\n'));
  assert.match(t.out.join('\n'), /close it to other users afterwards \(it is mode 0755 now\)[\s\S]*closed to other users \(was 0755\)/);
  assert.equal(fs.statSync(t.newHome).mode & 0o777, 0o700);
});

test('decision 161: init stops without changing anything when the source or the target is not right, when it may not ask, when the user says no, or while the old release runs', async () => {
  const snapshot = (t: ReturnType<typeof previousInstall>) => JSON.stringify([fs.readdirSync(t.oldHome).sort(), fs.readFileSync(t.settingsFile, 'utf8'), t.keys.entries]);
  const refused = async (t: ReturnType<typeof previousInstall>, message: RegExp) => {
    const before = snapshot(t);
    assert.equal(await migrateHome(t.d), 'stop');
    assert.match(t.out.join('\n'), message);
    assert.equal(snapshot(t), before, t.out.join('\n'));
    assert.deepEqual(t.processes.killed, []);
    assert.ok(!fs.existsSync(path.join(t.oldHome, 'supervise.stop')), 'nothing was asked to stop');
    fresh();
  };
  // both homes: no merge
  let t = previousInstall();
  fs.mkdirSync(t.newHome);
  fs.writeFileSync(path.join(t.newHome, 'config.json'), '{}');
  assert.match(legacyHomeCheck({ AGENTIC_ROUTER_HOME: t.oldHome }, undefined, t.newHome)!.detail, /is still there next to/);
  await refused(t, /Both .* exist\. init does not merge them/);
  // review L4: a new home that is a link (even to an empty folder), or a file
  t = previousInstall();
  fs.mkdirSync(path.join(tmp, 'elsewhere'));
  linkDir(path.join(tmp, 'elsewhere'), t.newHome);
  await refused(t, /\.do-it-all-claude-code is a link, and init moves the home only into a new folder/);
  t = previousInstall();
  fs.writeFileSync(t.newHome, '');
  await refused(t, /is not a folder/);
  // review M1: the source must be a real router home of this user
  t = previousInstall();
  for (const f of ['config.json', 'token']) fs.rmSync(path.join(t.oldHome, f));
  assert.match(legacyHomeCheck({ AGENTIC_ROUTER_HOME: t.oldHome }, undefined, t.newHome)!.detail, /is not one init moves: it holds no config\.json or token/);
  await refused(t, /is not moved: it holds no config\.json or token/);
  t = previousInstall();
  const real = path.join(tmp, 'real-home');
  fs.renameSync(t.oldHome, real);
  linkDir(real, t.oldHome);
  const before = fs.readdirSync(real).sort().join();
  assert.equal(await migrateHome(t.d), 'stop');
  assert.match(t.out.join('\n'), /\(named by AGENTIC_ROUTER_HOME\) is not moved: it is a link/);
  assert.equal(fs.readdirSync(real).sort().join(), before);
  fresh();
  if (POSIX) {
    t = previousInstall();
    await refused({ ...t, d: { ...t.d, uid: fs.statSync(t.oldHome).uid + 1 } }, /is not moved: it belongs to another user/);
  }
  // review M2: a process its pid file names that cannot be confirmed is not stopped, and nothing moves
  t = previousInstall({ processes: fakeProcesses(path.join(tmp, '.agentic-router'), { 301: { cmd: SUP, start: AFTER() } }) });
  await refused(t, /supervisor pid 301 \(it started after supervise\.pid was written[^)]*\)\. init stops only a process it can confirm/);
  // an empty new folder is no home: the move goes on
  t = previousInstall();
  fs.mkdirSync(t.newHome);
  assert.equal(await migrateHome(t.d), 'moved', t.out.join('\n'));
  fresh();
  // not a terminal and no --yes; the user says no; the old release does not stop
  for (const o of [{ yes: false, isTTY: false }, { yes: false, isTTY: true, ask: async () => false }] as Array<Partial<MigrateDeps>>) {
    t = previousInstall(o);
    await refused(t, /Nothing was changed/);
  }
  t = previousInstall();
  t.d.processes = fakeProcesses(t.oldHome, { 301: { cmd: SUP, start: BEFORE() } }, { stubborn: [301] });
  const kept = snapshot(t);
  assert.equal(await migrateHome(t.d), 'stop');
  assert.match(t.out.join('\n'), /did not stop \(supervisor pid 301 still running\)[^]*Nothing was moved/);
  assert.equal(JSON.parse(snapshot(t))[1], JSON.parse(kept)[1], 'settings untouched');
  assert.ok(!fs.existsSync(t.newHome));
  fresh();
  // doctor says what to do while it is left
  t = previousInstall();
  assert.match(legacyHomeCheck({ AGENTIC_ROUTER_HOME: t.oldHome }, undefined, t.newHome)!.detail, /not moved yet: run do-it-all-claude-code init/);
  // a home set by the new variable alone (a test or a script) never takes the default old home
  const user = path.join(tmp, 'user');
  fs.mkdirSync(path.join(user, '.agentic-router'), { recursive: true });
  fs.writeFileSync(path.join(user, '.agentic-router', 'token'), 'x');
  assert.equal(await migrateHome({ ...t.d, env: { DO_IT_ALL_CLAUDE_CODE_HOME: t.newHome }, userHome: user }), 'none');
  assert.equal(legacyHomeCheck({ DO_IT_ALL_CLAUDE_CODE_HOME: t.newHome }, user, t.newHome), null);
});
