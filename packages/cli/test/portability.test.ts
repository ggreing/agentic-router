// Env / shell / permission review follow-ups for the CLI (decisions 97, 101, 102; env audit #7, #8, #12, #13).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { claudeConfigDir, defaultClaudeSettings } from 'do-it-all-claude-code';
import { environmentChecks } from '../src/doctor.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('files with a shebang use LF line endings (decision 101)', () => {
  const files = ['packages/cli/src/index.ts', 'plugin/hooks/guard.mjs', 'plugin/hooks/relay.mjs', 'plugin/statusline.mjs']
    .map(f => path.join(ROOT, f)).filter(f => fs.existsSync(f));
  for (const f of files) {
    const b = fs.readFileSync(f);
    if (b.subarray(0, 2).toString() === '#!') assert.ok(!b.includes('\r\n'), `${f} has CRLF`);
  }
  assert.match(fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8'), /\* text=auto eol=lf/);
});

test('CLAUDE_CONFIG_DIR moves the settings file the status line is written to (env audit #8)', () => {
  const abs = path.resolve('/tmp/cc-config');
  assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: abs }), abs);
  assert.equal(defaultClaudeSettings({ CLAUDE_CONFIG_DIR: abs }), path.join(abs, 'settings.json'));
  assert.match(claudeConfigDir({ CLAUDE_CONFIG_DIR: 'relative' }), /\.claude$/);
});

test('doctor flags a version-manager node, a relative router home and requires Git Bash on Windows only', () => {
  const nvm = environmentChecks({}, 'linux', '/home/u/.nvm/versions/node/v24.1.0/bin/node');
  assert.ok(nvm.some(c => c.name === 'node from a version manager' && !c.blocking));
  assert.ok(!nvm.some(c => c.name.startsWith('git bash')), 'no Git Bash check off Windows');
  assert.ok(environmentChecks({ DO_IT_ALL_CLAUDE_CODE_HOME: 'rel' }, 'linux', '/usr/bin/node').some(c => c.name === 'DO_IT_ALL_CLAUDE_CODE_HOME' && !c.ok));
  const win = environmentChecks({}, 'win32', 'C:/Program Files/nodejs/node.exe');
  assert.ok(win.some(c => c.name === 'git bash (Windows)' && c.blocking));
});

test('daemon calls ignore HTTP proxies even with NODE_USE_ENV_PROXY (env audit #12)', async () => {
  const server = http.createServer((_q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end('{"ok":true,"version":"t"}'); });
  await new Promise<void>(res => server.listen(0, '127.0.0.1', () => res()));
  const port = (server.address() as { port: number }).port;
  try {
    const mod = pathToFileURL(path.join(ROOT, 'packages/cli/src/daemonctl.ts')).href;
    const script = `import { health } from ${JSON.stringify(mod)};\nconsole.log(JSON.stringify(await health(${port})));`;
    // async child: a sync spawn would block this process's event loop, so the test server could not answer
    const r = await new Promise<{ stdout: string; stderr: string }>(resolve => execFile(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9', NO_PROXY: '' },
      encoding: 'utf8', timeout: 20000,
    }, (_e, stdout, stderr) => resolve({ stdout, stderr })));
    assert.match(r.stdout, /"ok":true/, r.stderr);
  } finally { server.close(); }
});

test('doctor compares the router home and port the hooks reported with the CLI view (decision 97)', async () => {
  const { compareHookClient } = await import('../src/doctor.ts');
  const home = path.resolve('/tmp/ar-home');
  assert.equal(compareHookClient({ routerHome: home, port: 47800, nodeVersion: 'v24.1.0' }, home, 47800).ok, true);
  const bad = compareHookClient({ routerHome: path.resolve('/tmp/other'), port: 47801, nodeVersion: 'v20.0.0' }, home, 47800);
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /router home/); assert.match(bad.detail, /port 47801/); assert.match(bad.detail, /node v20/);
});
