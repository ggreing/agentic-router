// API-key mode commands (decisions 130-131). Temp homes and settings files, fake keychain and login runners:
// no test touches ~/.claude, a real keychain or the network.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { paths } from '@do-it-all-claude-code/core';
import { HINT_HEADERS_ENV, detectLogin, isRouterHelper, keyHelper, localTokenHelper, planApiSettings, planSubscriptionSettings, proxyBaseUrl } from '../src/apimode.ts';
import { allowUpstream, configureApi, keySet, modeApi, modeSubscription, preflightApi, proxyTokenFile, setMode, tokenRotate, type ApiDeps } from '../src/apicmds.ts';
import { apiChecks, type ApiCheckInput } from '../src/doctor.ts';
import { ensureLocalState, readConfig, writeConfig } from '../src/setup.ts';

let tmp = '';
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-cli-api-'));
  process.env.DO_IT_ALL_CLAUDE_CODE_HOME = path.join(tmp, 'home');
});

const PKG = path.join('/opt', 'do-it-all-claude-code', 'packages', 'proxy');
const settingsOf = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, any>;

interface Fake { deps: ApiDeps; lines: string[]; stored: string[]; confirms: number }
function fake(o: { status?: Awaited<ReturnType<ApiDeps['vault']['status']>>; login?: string; tty?: boolean; stdin?: string; answer?: boolean } = {}): Fake {
  const f: Fake = { lines: [], stored: [], confirms: 0, deps: undefined as unknown as ApiDeps };
  f.deps = {
    settingsFile: path.join(tmp, 'claude', 'settings.json'),
    confirm: async () => { f.confirms++; return o.answer ?? true; },
    login: async () => ({ code: 0, stdout: o.login ?? '{"loggedIn":false}' }),
    vault: {
      status: async () => o.status ?? 'present',
      storeInteractive: async () => { f.stored.push('<interactive>'); },
      storeFromStdin: async key => { f.stored.push(key); },
    },
    isTTY: o.tty ?? false,
    readStdin: async () => o.stdin ?? '',
    out: line => { f.lines.push(line); },
    // decision 157: these tests cover plain HTTP; local TLS (openssl) has its own (localtls.test.ts)
    openssl: null,
  };
  return f;
}

test('proxy settings: base URL, hint headers and the local-token helper; credential variables removed; backup once; idempotent', () => {
  const file = path.join(tmp, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ model: 'opus', env: { ANTHROPIC_AUTH_TOKEN: 'old', FOO: 'bar' }, apiKeyHelper: 'my-vault get' }));
  const plan = planApiSettings(file, 'proxy', 47811, PKG)!;
  assert.match(plan.summary, /replace "my-vault get"/);
  assert.match(plan.summary, /env\.ANTHROPIC_AUTH_TOKEN: remove/);
  plan.apply();
  const s = settingsOf(file);
  assert.equal(s.model, 'opus');
  assert.deepEqual(s.env, { FOO: 'bar', ANTHROPIC_BASE_URL: 'http://127.0.0.1:47811', [HINT_HEADERS_ENV]: '1' });
  assert.equal(s.apiKeyHelper, localTokenHelper(PKG));
  assert.ok(isRouterHelper(s.apiKeyHelper));
  assert.equal(JSON.parse(fs.readFileSync(file + '.do-it-all-claude-code.bak', 'utf8')).apiKeyHelper, 'my-vault get');
  assert.equal(planApiSettings(file, 'proxy', 47811, PKG), null);
  // direct: our base URL and hint go, the key helper comes; the backup is not overwritten
  planApiSettings(file, 'direct', 47811, PKG)!.apply();
  const d = settingsOf(file);
  assert.deepEqual(d.env, { FOO: 'bar' });
  assert.equal(d.apiKeyHelper, keyHelper(PKG));
  assert.equal(JSON.parse(fs.readFileSync(file + '.do-it-all-claude-code.bak', 'utf8')).apiKeyHelper, 'my-vault get');
  // a foreign gateway URL is not removed by direct mode
  fs.writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://gw.example.com' } }));
  planApiSettings(file, 'direct', 47811, PKG)!.apply();
  assert.equal(settingsOf(file).env.ANTHROPIC_BASE_URL, 'https://gw.example.com');
  assert.equal(proxyBaseUrl(1), 'http://127.0.0.1:1');
});

test('saved login detection from `claude auth status --json` (the shapes Claude Code 2.1.322 prints)', async () => {
  const run = (o: unknown) => async () => ({ code: 0, stdout: typeof o === 'string' ? o : JSON.stringify(o) });
  // observed with an empty CLAUDE_CONFIG_DIR
  assert.deepEqual(await detectLogin(run({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty', loginExpiresAt: null })), { state: 'none', method: 'none' });
  assert.deepEqual(await detectLogin(run({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', apiKeySource: 'ANTHROPIC_API_KEY' })), { state: 'none', method: 'api_key' });
  assert.deepEqual(await detectLogin(run({ loggedIn: true, authMethod: 'api_key_helper', apiProvider: 'firstParty', apiKeySource: 'apiKeyHelper' })), { state: 'none', method: 'api_key_helper' });
  // any other method while logged in counts as a saved login (claude.ai was deliberately not observed)
  for (const m of ['claude.ai', 'oauth', 'console', 'something_new']) {
    assert.deepEqual(await detectLogin(run({ loggedIn: true, authMethod: m, email: 'never@read' })), { state: 'saved_login', method: m }, m);
  }
  assert.equal((await detectLogin(run({ loggedIn: true }))).state, 'saved_login');
  assert.equal((await detectLogin(run('not json'))).state, 'unknown');
  assert.equal((await detectLogin(run({ authMethod: 'api_key' }))).state, 'unknown');      // no loggedIn
  assert.equal((await detectLogin(async () => { throw new Error('no claude'); })).state, 'unknown');
});

test('preflight: a saved login stops init before anything is written; the keychain decides the rest', async () => {
  const saved = fake({ login: '{"loggedIn":true,"authMethod":"claude.ai"}' });
  assert.deepEqual(await preflightApi({}, saved.deps), { ok: false, code: 2 });
  assert.match(saved.lines.join('\n'), /claude auth logout/);
  assert.deepEqual(await preflightApi({ 'allow-login': true }, fake({ login: '{"loggedIn":true,"authMethod":"claude.ai"}' }).deps), { ok: true });
  const unknown = fake({ login: 'garbage' });
  assert.deepEqual(await preflightApi({}, unknown.deps), { ok: true });
  assert.match(unknown.lines[0]!, /Could not tell/);
  assert.deepEqual(await preflightApi({}, fake({ status: 'constrained_language' }).deps), { ok: false, code: 2 });
  assert.deepEqual(await preflightApi({}, fake({ status: 'unavailable' }).deps), { ok: false, code: 2 });
  assert.deepEqual(await preflightApi({}, fake({ status: 'not_found' }).deps), { ok: false, code: 2 });   // no terminal, no --key-stdin
  const piped = fake({ status: 'not_found', stdin: '  sk-ant-api03-from-a-pipe  \n' });
  assert.deepEqual(await preflightApi({ 'key-stdin': true }, piped.deps), { ok: true });
  assert.deepEqual(piped.stored, ['sk-ant-api03-from-a-pipe']);
  const tty = fake({ status: 'not_found', tty: true });
  assert.deepEqual(await preflightApi({}, tty.deps), { ok: true });
  assert.deepEqual(tty.stored, ['<interactive>']);
  assert.deepEqual(await preflightApi({ 'no-key': true }, fake({ status: 'not_found' }).deps), { ok: true });
});

test('configure: a proxy port apart from the daemon\'s, the decision-131 caps without asking, a 0600 local token; re-running keeps them', async () => {
  const { config } = await ensureLocalState();
  const f = fake();
  const a = await configureApi({ ...config, forceLevel: 'L2' }, f.deps);
  assert.ok(a.proxyPort && a.proxyPort !== a.daemonPort);
  assert.deepEqual([a.apiMode, a.proxy?.tokenDailyCapUsd, a.proxy?.dailyCapUsd], ['proxy', 100, 300]);
  assert.match(f.lines[0]!, /\$100 per local token and \$300 in all/);
  const token = fs.readFileSync(proxyTokenFile(), 'utf8');
  assert.ok(token.length >= 32);
  if (process.platform !== 'win32') assert.equal(fs.statSync(proxyTokenFile()).mode & 0o777, 0o600);
  // the user raised a cap; init runs again
  writeConfig({ ...readConfig()!, proxy: { ...readConfig()!.proxy, dailyCapUsd: 500 } });
  const again = await ensureLocalState();
  assert.deepEqual([again.config.proxyPort, again.config.apiMode, again.config.forceLevel, again.config.proxy?.dailyCapUsd], [a.proxyPort, 'proxy', 'L2', 500]);
  const b = await configureApi(again.config, fake().deps);
  assert.deepEqual([b.proxyPort, b.proxy?.dailyCapUsd, b.proxy?.tokenDailyCapUsd], [a.proxyPort, 500, 100]);
  assert.equal(fs.readFileSync(proxyTokenFile(), 'utf8'), token, 'the token is kept');
});

test('mode direct|proxy swaps the helper and the base URL (confirmed) and records the mode', async () => {
  const f = fake();
  assert.equal(await setMode('direct', {}, f.deps), 2);                    // not set up
  const { config } = await ensureLocalState();
  const c = await configureApi(config, f.deps);
  planApiSettings(f.deps.settingsFile, 'proxy', c.proxyPort!)!.apply();
  assert.equal(await setMode('direct', {}, fake({ status: 'not_found' }).deps), 2);   // direct needs the key
  const declined = fake({ answer: false });
  assert.equal(await setMode('direct', {}, declined.deps), 1);
  assert.equal(readConfig()!.apiMode, 'proxy');
  assert.equal(await setMode('direct', { yes: true }, f.deps), 0);
  assert.equal(readConfig()!.apiMode, 'direct');
  const s = settingsOf(f.deps.settingsFile);
  assert.match(s.apiKeyHelper, /key-helper\.mjs/);
  assert.equal(s.env?.ANTHROPIC_BASE_URL, undefined);
  assert.equal(await setMode('proxy', { yes: true }, f.deps), 0);
  assert.equal(settingsOf(f.deps.settingsFile).env.ANTHROPIC_BASE_URL, proxyBaseUrl(c.proxyPort!));
});

test('token rotate writes a new local token; key set stores through the keychain only', async () => {
  const f = fake();
  assert.equal(tokenRotate(f.deps), 2);
  const { config } = await ensureLocalState();
  await configureApi(config, f.deps);
  const before = fs.readFileSync(proxyTokenFile(), 'utf8');
  assert.equal(tokenRotate(f.deps), 0);
  assert.notEqual(fs.readFileSync(proxyTokenFile(), 'utf8'), before);
  assert.match(f.lines.at(-1)!, /old one for 10 more minutes/);
  const k = fake({ stdin: 'sk-ant-api03-new-key\n' });
  assert.equal(await keySet({ 'key-stdin': true }, k.deps), 0);
  assert.deepEqual(k.stored, ['sk-ant-api03-new-key']);
  assert.equal(await keySet({}, fake({ status: 'constrained_language' }).deps), 2);
});

test('proxy allow-upstream: https origins only, confirmed, --use also points the proxy there', async () => {
  const f = fake();
  await ensureLocalState();
  assert.equal(await allowUpstream('http://gw.example.com', {}, f.deps, paths.config()), 2);
  assert.equal(await allowUpstream('https://gw.example.com/v1', {}, f.deps, paths.config()), 2);
  assert.equal(await allowUpstream(undefined, {}, f.deps, paths.config()), 2);
  assert.equal(await allowUpstream('https://gw.example.com', {}, fake({ answer: false }).deps, paths.config()), 1);
  assert.equal(readConfig()!.proxy?.allowedUpstreams, undefined);
  assert.equal(await allowUpstream('https://gw.example.com', { yes: true }, f.deps, paths.config()), 0);
  assert.deepEqual(readConfig()!.proxy?.allowedUpstreams, ['https://gw.example.com']);
  assert.equal(readConfig()!.proxy?.upstream, undefined);
  assert.equal(await allowUpstream('https://gw.example.com', { yes: true, use: true }, f.deps, paths.config()), 0);
  assert.deepEqual([readConfig()!.proxy?.allowedUpstreams, readConfig()!.proxy?.upstream], [['https://gw.example.com'], 'https://gw.example.com']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(paths.config()).mode & 0o777, 0o600);
});

test('doctor in API-key mode: version, settings, project overrides, credential variables, TLS, keychain, proxy, supervisor', async () => {
  const { config } = await ensureLocalState();
  const f = fake();
  const c = await configureApi(config, f.deps);
  planApiSettings(f.deps.settingsFile, 'proxy', c.proxyPort!)!.apply();
  const project = path.join(tmp, 'proj');
  const base: ApiCheckInput = {
    cfg: c, env: {}, claudeVersion: '2.1.322 (Claude Code)', settingsFile: f.deps.settingsFile, projectDir: project,
    keyStatus: async () => 'present', proxyHealth: async () => ({ ok: true, upstream: 'https://api.anthropic.com' }), supervise: null,
  };
  const ok = await apiChecks(base);
  // decision 157: local TLS is off here (no openssl in these tests): a warning with the reason, never blocking
  const tlsOff = ok.find(x => x.name === 'local TLS')!;
  assert.deepEqual([tlsOff.ok, tlsOff.blocking], [false, false]);
  assert.ok(ok.filter(x => x.name !== 'local TLS').every(x => x.ok), JSON.stringify(ok.filter(x => !x.ok)));
  const by = async (o: Partial<ApiCheckInput>) => (await apiChecks({ ...base, ...o })).filter(x => !x.ok && x.name !== 'local TLS').map(x => [x.name, x.blocking]);
  assert.deepEqual(await by({ claudeVersion: '2.1.250' }), [['claude code (API mode)', true]]);
  assert.deepEqual(await by({ env: { ANTHROPIC_AUTH_TOKEN: 'x' } }), [['ANTHROPIC_AUTH_TOKEN in environment', true]]);
  assert.deepEqual(await by({ env: { NODE_TLS_REJECT_UNAUTHORIZED: '0' } }), [['NODE_TLS_REJECT_UNAUTHORIZED', true]]);
  assert.deepEqual(await by({ keyStatus: async () => 'constrained_language' }), [['API key in the OS keychain', true]]);
  assert.deepEqual(await by({ proxyHealth: async () => null }), [['proxy', false]]);
  assert.deepEqual(await by({ supervise: { pid: 1, startedAt: '', updatedAt: '', children: { proxy: { pid: null, state: 'degraded', restarts: 4, failures: 4 } } } }), [['supervisor', false]]);
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://elsewhere.example' }, apiKeyHelper: 'cat key.txt' }));
  const over = (await apiChecks(base)).find(x => x.name === 'project settings override')!;
  assert.match(over.detail, /env\.ANTHROPIC_BASE_URL, apiKeyHelper/);
  fs.rmSync(path.join(project, '.claude'), { recursive: true });
  // the settings drifted: base URL gone
  const s = settingsOf(f.deps.settingsFile);
  delete s.env.ANTHROPIC_BASE_URL;
  fs.writeFileSync(f.deps.settingsFile, JSON.stringify(s));
  const drift = (await apiChecks(base)).find(x => x.name === 'Claude Code settings (proxy)')!;
  assert.deepEqual([drift.ok, drift.blocking], [false, true]);
  assert.match(drift.detail, /ANTHROPIC_BASE_URL.*run do-it-all-claude-code mode proxy/);
});

test('decision 156: the proxy health is read only after the proxy proved itself; a program that cannot is reported, and gets no token', async () => {
  const { proxyHealth } = await import('../src/supervise.ts');
  const { proofOf } = await import('@do-it-all-claude-code/proxy');
  const TOKEN = 'tok-1234567890-abcdefghijklmnopqrstuvwxyz';
  const seen: Array<string | undefined> = [];
  let port = 0;
  const proxyLike = (knows: boolean) => http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    let b = '';
    req.on('data', c => { b += String(c); });
    req.on('end', () => {
      if (req.url === '/proxy/v1/proof') {
        const nonce = (JSON.parse(b) as { nonce: string }).nonce;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ proof: knows ? proofOf(TOKEN, port, nonce) : 'guess' }));
      }
      if (req.headers.authorization === `Bearer ${TOKEN}`) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true,"upstream":"https://api.anthropic.com","inflight":2}'); }
      res.writeHead(401); res.end();
    });
  });
  for (const knows of [true, false]) {
    const server = proxyLike(knows);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as { port: number }).port;
    seen.length = 0;
    try {
      if (knows) assert.deepEqual(await proxyHealth(port, TOKEN), { ok: true, upstream: 'https://api.anthropic.com', inflight: 2, tls: false });
      else {
        assert.deepEqual(await proxyHealth(port, TOKEN), { ok: false, other: true });
        assert.ok(seen.every(a => a === undefined), 'the token was never sent to it');
      }
    } finally { server.close(); }
  }
  assert.equal(await proxyHealth(port, TOKEN), null, 'nothing listens: down');
});

test('spec 2.1: subscription settings take out only what API-key mode put in', () => {
  const file = path.join(tmp, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ model: 'opus', apiKeyHelper: 'corp-vault get' }));
  planApiSettings(file, 'proxy', 47811, PKG)!.apply();                     // the backup keeps "corp-vault get"
  fs.writeFileSync(file, JSON.stringify({ ...settingsOf(file), env: { ...settingsOf(file).env, FOO: 'bar' } }));
  const plan = planSubscriptionSettings(file)!;
  assert.match(plan.summary, /apiKeyHelper: remove the router's helper; env\.ANTHROPIC_BASE_URL: remove .*; env\.CLAUDE_CODE_GATEWAY_HINT_HEADERS: remove; your earlier apiKeyHelper "corp-vault get" is in settings\.json\.do-it-all-claude-code\.bak; it is not put back/);
  plan.apply();
  assert.deepEqual(settingsOf(file), { model: 'opus', env: { FOO: 'bar' } });
  assert.equal(planSubscriptionSettings(file), null, 'nothing of ours left');
  // a gateway and a helper of the user's own stay
  fs.writeFileSync(file, JSON.stringify({ apiKeyHelper: 'corp-vault get', env: { ANTHROPIC_BASE_URL: 'https://gw.example.com' } }));
  assert.equal(planSubscriptionSettings(file), null);
});

test('spec 2.1: mode subscription and mode api switch back and forth (confirmed), keep the key, and reload the supervisor', async () => {
  let reloads = 0;
  const deps = (o: Parameters<typeof fake>[0] = {}) => { const f = fake(o); return { ...f, deps: { ...f.deps, reload: () => { reloads++; return true; } } }; };
  assert.equal(await modeSubscription({}, deps().deps), 2, 'not set up');
  assert.equal(await modeApi({}, deps().deps), 2, 'API-key mode never set up');
  const { config } = await ensureLocalState();
  const c = await configureApi(config, fake().deps);
  const f = deps();
  planApiSettings(f.deps.settingsFile, 'proxy', c.proxyPort!)!.apply();
  // to the subscription
  assert.equal(await modeSubscription({}, deps({ answer: false }).deps), 1);
  assert.equal(readConfig()!.apiMode, 'proxy');
  assert.equal(await modeSubscription({}, f.deps), 0);
  assert.equal(readConfig()!.apiMode, undefined);
  assert.deepEqual([readConfig()!.proxyPort, fs.existsSync(proxyTokenFile())], [c.proxyPort, true], 'port and local token kept for mode api');
  const s = settingsOf(f.deps.settingsFile);
  assert.deepEqual([s.apiKeyHelper, s.env?.ANTHROPIC_BASE_URL, s.env?.[HINT_HEADERS_ENV]], [undefined, undefined, undefined]);
  assert.match(f.lines.at(-1)!, /^Subscription mode: .*The supervisor stops the proxy now\. .*do-it-all-claude-code mode api/);
  assert.equal(reloads, 1);
  assert.equal(await modeSubscription({}, deps().deps), 0);
  assert.match(f.lines.at(-1)!, /Subscription mode/);
  // back to API-key mode: the key must be there and no saved login next to it
  assert.equal(await modeApi({}, deps({ status: 'not_found' }).deps), 2);
  const saved = deps({ login: '{"loggedIn":true,"authMethod":"claude.ai"}' });
  assert.equal(await modeApi({}, saved.deps), 2);
  assert.match(saved.lines[0]!, /then run `do-it-all-claude-code mode api` again/);
  const back = deps();
  assert.equal(await modeApi({ yes: true }, back.deps), 0);
  assert.equal(readConfig()!.apiMode, 'proxy');
  assert.deepEqual([settingsOf(back.deps.settingsFile).env.ANTHROPIC_BASE_URL, isRouterHelper(settingsOf(back.deps.settingsFile).apiKeyHelper)], [proxyBaseUrl(c.proxyPort!), true]);
  assert.match(back.lines.at(-1)!, /The supervisor starts it now/);
  assert.equal(reloads, 2);
  const again = deps();
  assert.equal(await modeApi({}, again.deps), 0);
  assert.match(again.lines.at(-1)!, /^Already in API-key mode/);
});

test('audit C3: token rotate records the rotation time, so the grace runs from it; --no-grace refuses the old token at once', async () => {
  const { LocalTokens } = await import('@do-it-all-claude-code/proxy');
  const { config } = await ensureLocalState();
  const f = fake();
  await configureApi(config, f.deps);
  const pause = () => new Promise(r => setTimeout(r, 30));   // the proxy reloads the file when its mtime changes
  // with grace: the proxy, reading the file long after the rotation, still counts the 10 minutes from the rotation
  const first = fs.readFileSync(proxyTokenFile(), 'utf8').trim();
  let clock = Date.now();
  const tokens = new LocalTokens(proxyTokenFile(), { now: () => clock });
  await pause();
  assert.equal(tokenRotate(f.deps), 0);
  clock = Date.now() + 11 * 60_000;                           // the proxy's next read comes 11 minutes later
  assert.equal(tokens.accept(first), null, 'the grace ran out 10 minutes after the rotation');
  const second = fs.readFileSync(proxyTokenFile(), 'utf8').trim();
  assert.ok(tokens.accept(second));
  // --no-grace: refused at once
  clock = Date.now();
  await pause();
  assert.equal(tokenRotate(f.deps, { grace: false }), 0);
  assert.match(f.lines.at(-1)!, /--no-grace: the old token is refused at once/);
  assert.equal(tokens.accept(second), null);
  assert.ok(tokens.accept(fs.readFileSync(proxyTokenFile(), 'utf8').trim()));
});
