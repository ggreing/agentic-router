// `do-it-all-claude-code dashboard` (decision 132): one-time code for the local token, browser opened with the
// code in the fragment, the URL printed when no browser opens; the token never in a URL, argument or line.
// Fake openers only; the last test runs the real daemon in a temp home (loopback).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { paths } from '@do-it-all-claude-code/core';
import { browserCommand, openDashboard } from '../src/dashboard.ts';
import { testPort } from './ports.ts';

let tmp = '';
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-cli-dash-'));
  process.env.DO_IT_ALL_CLAUDE_CODE_HOME = path.join(tmp, 'home');
});

const TOKEN = 'local-token-0123456789abcdef0123456789';
const CODE = 'Q2hhbmdlTWVQbGVhc2UtMTIzNDU2Nzg5MA';
const answer = (port: number, o: Record<string, unknown> = {}) => ({ status: 200, body: JSON.stringify({ code: CODE, url: `http://127.0.0.1:${port}/dashboard#code=${CODE}`, ...o }) });

test('the browser gets the URL without a shell; on Windows through an environment variable', () => {
  const url = `http://127.0.0.1:4000/dashboard#code=${CODE}`;
  const w = browserCommand(url, 'win32');
  assert.equal(w.command, 'powershell.exe');
  assert.ok(!w.args.join(' ').includes(url), 'not in the command line');
  assert.deepEqual(Object.values(w.env ?? {}), [url]);
  assert.deepEqual(browserCommand(url, 'darwin'), { command: 'open', args: [url] });
  assert.deepEqual(browserCommand(url, 'linux'), { command: 'xdg-open', args: [url] });
});

test('opened, printed or refused: the code is shown only when it has to be typed, the token never', async () => {
  const run = async (o: Partial<Parameters<typeof openDashboard>[0]>) => {
    const lines: string[] = [];
    const opened: string[] = [];
    const code = await openDashboard({ port: 4000, token: TOKEN, register: async () => answer(4000), open: async u => { opened.push(u); return true; }, out: l => { lines.push(l); }, ...o });
    const text = lines.join('\n');
    assert.ok(!text.includes(TOKEN) && !opened.join('').includes(TOKEN), 'the token is never shown');
    return { code, text, opened };
  };
  const ok = await run({});
  assert.deepEqual([ok.code, ok.opened], [0, [`http://127.0.0.1:4000/dashboard#code=${CODE}`]]);
  assert.match(ok.text, /^Opened the dashboard in your browser: http:\/\/127\.0\.0\.1:4000\/dashboard$/);
  const noBrowser = await run({ open: async () => false });
  assert.equal(noBrowser.code, 0);
  assert.match(noBrowser.text, /Could not open a browser[\s\S]*#code=Q2hh/);
  const noOpen = await run({ noOpen: true, open: async () => { throw new Error('must not open'); } });
  assert.match(noOpen.text, /^Open this address within a minute/);
  assert.match((await run({ register: async () => null })).text, /not running: start it with `do-it-all-claude-code start`/);
  assert.equal((await run({ register: async () => null })).code, 1);
  assert.match((await run({ register: async () => ({ status: 401, body: '{}' }) })).text, /refused the local token/);
  assert.match((await run({ register: async () => ({ status: 404, body: '{}' }) })).text, /no dashboard/);
  // an answer pointing anywhere else is not opened
  for (const bad of [{ url: `http://evil.example/dashboard#code=${CODE}` }, { url: `http://127.0.0.1:4001/dashboard#code=${CODE}` }, { code: 'a&calc' }]) {
    const r = await run({ register: async () => answer(4000, bad), open: async () => { throw new Error('must not open'); } });
    assert.deepEqual([r.code, /Unexpected answer/.test(r.text)], [1, true], JSON.stringify(bad));
  }
});

/** An OS-assigned free port: test files run in parallel, and two temp homes must not pick the same one. */
async function ownPort(): Promise<void> {
  const { readConfig, writeConfig } = await import('../src/setup.ts');
  const port = await testPort();   // outside the ephemeral range, claimed (see ports.ts)
  writeConfig({ ...readConfig()!, daemonPort: port });
}

test('against the real daemon: the opened URL\'s code logs the page in once', async () => {
  const { ensureLocalState, readConfig } = await import('../src/setup.ts');
  const { start, stop } = await import('../src/daemonctl.ts');
  await ensureLocalState();
  await ownPort();
  const port = readConfig()!.daemonPort;
  try {
    assert.match(await start(), /^started/);
    const opened: string[] = [];
    const lines: string[] = [];
    const token = fs.readFileSync(paths.token(), 'utf8').trim();
    assert.equal(await openDashboard({ port, token, open: async u => { opened.push(u); return true; }, out: l => { lines.push(l); } }), 0);
    const code = /#code=([A-Za-z0-9_-]+)$/.exec(opened[0] ?? '')?.[1];
    assert.ok(code, opened[0]);
    const auth = (c: string) => new Promise<{ status: number; cookie: string }>((resolve, reject) => {
      const body = JSON.stringify({ code: c });
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/dashboard/auth', headers: {
        'content-type': 'application/json', 'content-length': Buffer.byteLength(body), origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin',
      } }, res => { res.resume(); res.on('end', () => resolve({ status: res.statusCode ?? 0, cookie: String(res.headers['set-cookie']?.[0] ?? '') })); });
      req.on('error', reject);
      req.end(body);
    });
    const first = await auth(code!);
    assert.equal(first.status, 200);
    assert.match(first.cookie, /^ar_dash=[^;]+; HttpOnly; SameSite=Strict/);
    assert.equal((await auth(code!)).status, 401, 'single use');
  } finally { await stop(); }
});

test('audit C1: the browser is pointed at a 0600 page in the router home, so the code is in no process argument', async () => {
  const { writeLaunchPage, launchPage } = await import('../src/dashboard.ts');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  const url = `http://127.0.0.1:4000/dashboard#code=${CODE}`;
  const page = writeLaunchPage(url, home);
  assert.equal(page, launchPage(home));
  assert.ok(fs.readFileSync(page, 'utf8').includes(`location.replace("http://127.0.0.1:4000/dashboard#code=${CODE}")`));
  if (process.platform !== 'win32') assert.equal(fs.statSync(page).mode & 0o777, 0o600);
  for (const p of ['darwin', 'linux', 'win32'] as const) assert.ok(!browserCommand(page, p).args.join(' ').includes(CODE), p);
  // a script-breaking URL cannot end the script early
  assert.ok(!fs.readFileSync(writeLaunchPage('http://127.0.0.1:1/dashboard#code=</script><b>', home), 'utf8').includes('</script><b>'));
});
