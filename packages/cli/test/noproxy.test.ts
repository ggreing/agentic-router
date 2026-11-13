// Claude Code behind a corporate proxy: in proxy mode its base URL is http://127.0.0.1:<port>, and with a proxy set
// it would send those requests (the local token in them) to that proxy unless NO_PROXY names loopback. API-key mode
// adds 127.0.0.1 and localhost to the NO_PROXY Claude Code reads, records what it added, and takes exactly that out
// again; doctor says when the setup would leak. Temp homes and settings files only.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planApiSettings, planSubscriptionSettings } from '../src/apimode.ts';
import { configureApi, type ApiDeps } from '../src/apicmds.ts';
import { apiChecks, environmentChecks, type ApiCheckInput } from '../src/doctor.ts';
import { ensureLocalState, readConfig } from '../src/setup.ts';
import { planUserSettings } from '../src/uninstall.ts';

let tmp = '';
let settingsFile = '';
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-cli-np-'));
  process.env.DO_IT_ALL_CLAUDE_CODE_HOME = path.join(tmp, 'home');
  settingsFile = path.join(tmp, 'claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
});
const PKG = path.join('/opt', 'do-it-all-claude-code', 'packages', 'proxy');
const env = () => (JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as { env?: Record<string, string> }).env ?? {};
/** A proxy URL with credentials, put together at run time (no such URL is written out in the source). */
const CORP = ['http', '://', 'corp-user', ':', 'not-a-secret', '@', 'corp.example:8080'].join('');

async function setup(): Promise<number> {
  const { config } = await ensureLocalState();
  const c = await configureApi(config, { out: () => {} } as Pick<ApiDeps, 'out'>);
  return c.proxyPort!;
}

test('proxy mode with a proxy in the shell: the shell NO_PROXY is carried over with loopback added, then taken out by direct mode', async () => {
  const port = await setup();
  const shell = { HTTPS_PROXY: CORP, NO_PROXY: 'intranet.example .corp.example' };
  const plan = planApiSettings(settingsFile, 'proxy', port, PKG, shell)!;
  assert.match(plan.summary, /env\.NO_PROXY = "intranet\.example \.corp\.example 127\.0\.0\.1 localhost"/);
  assert.match(plan.summary, /HTTPS_PROXY is http:\/\/corp\.example:8080 \(credentials hidden\)/);
  assert.match(plan.summary, /your shell's NO_PROXY is carried over/);
  assert.ok(!plan.summary.includes('not-a-secret'), 'the proxy credentials are not shown');
  plan.apply();
  assert.equal(env().NO_PROXY, 'intranet.example .corp.example 127.0.0.1 localhost');
  assert.deepEqual(readConfig()!.noProxyAdded, [{ name: 'NO_PROXY', created: true, base: 'intranet.example .corp.example', added: ['127.0.0.1', 'localhost'] }]);
  assert.equal(planApiSettings(settingsFile, 'proxy', port, PKG, shell), null, 'nothing more to do');
  // direct mode: Claude Code talks to the API itself, through the corporate proxy as before
  const direct = planApiSettings(settingsFile, 'direct', port, PKG, shell)!;
  assert.match(direct.summary, /env\.NO_PROXY: remove \(added by API-key mode\)/);
  direct.apply();
  assert.equal(env().NO_PROXY, undefined, 'the shell value applies again');
  assert.equal(readConfig()!.noProxyAdded, undefined);
});

test('no proxy anywhere: NO_PROXY is left alone; already covered (127.0.0.1 or *): nothing is added', async () => {
  const port = await setup();
  planApiSettings(settingsFile, 'proxy', port, PKG, {})!.apply();
  assert.equal(env().NO_PROXY, undefined);
  assert.equal(readConfig()!.noProxyAdded, undefined);
  fs.writeFileSync(settingsFile, JSON.stringify({ env: { HTTP_PROXY: CORP, NO_PROXY: '*' } }));
  planApiSettings(settingsFile, 'proxy', port, PKG, {})!.apply();
  assert.equal(env().NO_PROXY, '*');
  fs.writeFileSync(settingsFile, JSON.stringify({ env: { HTTP_PROXY: CORP, NO_PROXY: `127.0.0.1:${port}` } }));
  planApiSettings(settingsFile, 'proxy', port, PKG, {})!.apply();
  assert.equal(env().NO_PROXY, `127.0.0.1:${port}`);
});

test('both spellings set: each list Claude Code may read gets loopback; subscription mode takes out only what was added', async () => {
  const port = await setup();
  fs.writeFileSync(settingsFile, JSON.stringify({ env: { https_proxy: CORP, no_proxy: 'a.example', OTHER: '1' } }));
  planApiSettings(settingsFile, 'proxy', port, PKG, { NO_PROXY: 'b.example' })!.apply();
  assert.equal(env().no_proxy, 'a.example,127.0.0.1,localhost');
  assert.equal(env().NO_PROXY, 'b.example,127.0.0.1,localhost');
  const recs = readConfig()!.noProxyAdded!;
  assert.deepEqual(recs.map(r => [r.name, r.created]), [['no_proxy', false], ['NO_PROXY', true]]);
  // the user adds an entry of their own later: it stays
  const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as { env: Record<string, string> };
  s.env.no_proxy += ',c.example';
  fs.writeFileSync(settingsFile, JSON.stringify(s));
  planSubscriptionSettings(settingsFile)!.apply();
  assert.equal(env().no_proxy, 'a.example,c.example');
  assert.equal(env().NO_PROXY, undefined);
  assert.equal(env().OTHER, '1');
  assert.equal(readConfig()!.noProxyAdded, undefined);
});

test('uninstall takes the added NO_PROXY entries out with the rest', async () => {
  const port = await setup();
  planApiSettings(settingsFile, 'proxy', port, PKG, { HTTPS_PROXY: CORP })!.apply();
  assert.equal(env().NO_PROXY, '127.0.0.1,localhost');
  const plan = planUserSettings(settingsFile, readConfig())!;
  assert.match(plan.summary, /env\.NO_PROXY: remove \(added by API-key mode\)/);
  plan.apply();
  assert.equal(env().NO_PROXY, undefined);
});

test('doctor: says when Claude Code would send its requests for the local proxy to a corporate proxy, and how the proxy reaches the API', async () => {
  const port = await setup();
  planApiSettings(settingsFile, 'proxy', port, PKG, {})!.apply();   // set up before the proxy appeared
  const base: ApiCheckInput = {
    cfg: readConfig()!, env: { HTTPS_PROXY: CORP }, claudeVersion: '2.1.322 (Claude Code)', settingsFile, projectDir: path.join(tmp, 'proj'),
    keyStatus: async () => 'present', proxyHealth: async () => ({ ok: true, upstream: 'https://api.anthropic.com', via: 'http://corp.example:8080 (credentials hidden)' }), supervise: null,
  };
  let checks = await apiChecks(base);
  const leak = checks.find(c => c.name === 'Claude Code and your proxy')!;
  assert.deepEqual([leak.ok, leak.blocking], [false, true]);
  assert.match(leak.detail, /local token included.*do-it-all-claude-code mode api/);
  assert.ok(!JSON.stringify(checks).includes('not-a-secret'));
  assert.match(checks.find(c => c.name === 'API through your proxy')!.detail, /through http:\/\/corp\.example:8080 \(credentials hidden\) \(HTTPS_PROXY/);
  assert.match(checks.find(c => c.name === 'proxy')!.detail, /via http:\/\/corp\.example:8080/);
  // after mode api adds loopback, the check passes
  planApiSettings(settingsFile, 'proxy', port, PKG, base.env)!.apply();
  checks = await apiChecks({ ...base, cfg: readConfig()! });
  assert.equal(checks.find(c => c.name === 'Claude Code and your proxy')!.ok, true);
  // a proxy the router's proxy cannot use stops it: doctor says so
  checks = await apiChecks({ ...base, env: { HTTPS_PROXY: 'socks5://corp.example:1080' } });
  assert.deepEqual([checks.find(c => c.name === 'API through your proxy')!.ok, checks.find(c => c.name === 'API through your proxy')!.blocking], [false, true]);
});

test('doctor: NODE_USE_ENV_PROXY without loopback on NO_PROXY would send the hooks\' daemon calls to the proxy', () => {
  const warn = (e: NodeJS.ProcessEnv) => environmentChecks(e, 'linux', '/usr/bin/node').find(c => c.name === 'NODE_USE_ENV_PROXY');
  assert.match(warn({ NODE_USE_ENV_PROXY: '1', HTTP_PROXY: CORP })!.detail, /http:\/\/corp\.example:8080 \(credentials hidden\).*add 127\.0\.0\.1,localhost to NO_PROXY/);
  assert.ok(warn({ NODE_OPTIONS: '--use-env-proxy', http_proxy: CORP }));
  assert.equal(warn({ NODE_USE_ENV_PROXY: '1', HTTP_PROXY: CORP, NO_PROXY: 'localhost,127.0.0.1' }), undefined);
  assert.equal(warn({ HTTP_PROXY: CORP }), undefined, 'without the switch Node does not use it');
});
