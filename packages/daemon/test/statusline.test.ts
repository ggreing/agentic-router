// plugin/statusline.mjs: run as Claude Code runs it (stdin JSON, one line on stdout) against a test daemon.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatStatus } from '../../../plugin/statusline.mjs';
import { makeHome, postHook, request, rmrf, startTestDaemon, tmpDir, write, type TestDaemon } from './helpers.ts';

const SCRIPT = fileURLToPath(new URL('../../../plugin/statusline.mjs', import.meta.url));
const L2_PROMPT = 'Add a pagination module and refactor the API layer across multiple files';

function run(home: string, input: unknown, env: Record<string, string> = {}): Promise<{ out: string; code: number | null; ms: number }> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [SCRIPT], { env: { ...process.env, AGENTIC_ROUTER_HOME: home, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', c => { out += c; });
    child.on('error', reject);
    child.on('close', code => resolve({ out, code, ms: Date.now() - t0 }));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

const setConfig = (home: string, patch: Record<string, unknown>) => {
  const file = path.join(home, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...patch }));
};

async function withDaemon(fn: (d: TestDaemon) => Promise<void>): Promise<void> {
  const d = await startTestDaemon();
  try {
    setConfig(d.home, { daemonPort: d.port });   // the status line reads the port from config.json
    await fn(d);
  } finally { await d.close(); rmrf(d.home); }
}

test('formatStatus groups slots with the same step and rounds the cost', () => {
  assert.equal(formatStatus({
    request: { level: 'L2' }, costUsd: 0.4234,
    roles: [
      { role: 'architect', slot: 0, step: 's3' }, { role: 'coder', slot: 0, step: 's1' }, { role: 'coder', slot: 1, step: 's1' },
      { role: 'reviewer', slot: 0, step: 's3' }, { role: 'tester', slot: 0, step: 's1' },
    ],
  }), '[Router] L2 | architect s3 · coder×2 s1 · reviewer s3 · tester s1 | $0.42');
  assert.equal(formatStatus({ request: { level: 'L1' }, costUsd: 0, roles: [{ role: 'coder', step: 's1' }, { role: 'coder', step: 's3' }] }),
    '[Router] L1 | coder s1 · coder s3 | $0.00');
  assert.equal(formatStatus({ request: null, roles: [], costUsd: 0 }), '[Router] idle');
  const base = { request: { level: 'L1' }, roles: [{ role: 'coder', step: 's1' }], costUsd: 0.0064 };
  assert.equal(formatStatus({ ...base, costEstimated: true }), '[Router] L1 | coder s1 | ~$0.01');
  assert.equal(formatStatus({ ...base, costUnknown: true }), '[Router] L1 | coder s1 | $0.01+?');
  assert.equal(formatStatus({ ...base, costEstimated: true, costUnknown: true }), '[Router] L1 | coder s1 | ~$0.01+?');
  const l0 = { request: { level: 'L0', leadDirect: true }, costUsd: 0, roles: [{ role: 'coder', slot: 0, step: 's1', status: 'idle' }] };
  assert.equal(formatStatus(l0), '[Router] L0 · direct | $0.00');
  assert.equal(formatStatus({ ...l0, roles: [{ role: 'coder', slot: 0, step: 's1', status: 'running' }] }), '[Router] L0 · direct | coder s1 | $0.00');
});

test('one line for the session\'s request from the daemon; idle for a session without one', () => withDaemon(async d => {
  await postHook(d.port, { session_id: 'sl-1', hook_event_name: 'UserPromptSubmit', cwd: d.home, prompt: L2_PROMPT });
  const r = await run(d.home, { session_id: 'sl-1', model: { id: 'claude-opus-5-5' }, cwd: d.home });
  assert.equal(r.code, 0);
  assert.equal(r.out, '[Router] L2 | architect s3 · coder×2 s1 · reviewer s3 · tester s1 | $0.00\n');
  assert.equal((await run(d.home, { session_id: 'sl-unknown' })).out, '[Router] idle\n');
}));

test('the wrapped status line runs with the same stdin and is appended; its failure is ignored', () => withDaemon(async d => {
  await postHook(d.port, { session_id: 'sl-2', hook_event_name: 'UserPromptSubmit', cwd: d.home, prompt: L2_PROMPT });
  const echo = path.join(d.home, 'echo-session.cjs');
  write(d.home, 'echo-session.cjs', 'let s = ""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => console.log("prev:" + JSON.parse(s).session_id));\n');
  setConfig(d.home, { wrappedStatusLine: `node "${echo}"` });
  assert.match((await run(d.home, { session_id: 'sl-2' })).out, /^\[Router\] L2 \| .* \| \$0\.00 \| prev:sl-2\n$/);
  setConfig(d.home, { wrappedStatusLine: { type: 'command', command: `node "${echo}"` } });   // Claude Code statusLine object form
  assert.match((await run(d.home, { session_id: 'sl-2' })).out, / \| prev:sl-2\n$/);
  const fail = path.join(d.home, 'fail.cjs');
  write(d.home, 'fail.cjs', 'console.log("partial"); process.exit(3);\n');
  setConfig(d.home, { wrappedStatusLine: `node "${fail}"` });
  assert.equal((await run(d.home, { session_id: 'sl-2' })).out, '[Router] L2 | architect s3 · coder×2 s1 · reviewer s3 · tester s1 | $0.00\n');
}));

test('[Router] OFF when the daemon is down, the token is wrong, or it does not answer within 1 s', async () => {
  const home = makeHome();
  const hang = net.createServer(() => { /* accept and never answer */ });
  try {
    // nothing listening
    const free = await new Promise<number>(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
    setConfig(home, { daemonPort: free });
    assert.equal((await run(home, { session_id: 'x' })).out, '[Router] OFF\n');
    // a daemon with another token
    const d = await startTestDaemon();
    try {
      setConfig(home, { daemonPort: d.port });
      fs.writeFileSync(path.join(home, 'token'), 'some-other-token-0123456789abcdef');
      assert.equal((await run(home, { session_id: 'x' })).out, '[Router] OFF\n');
    } finally { await d.close(); rmrf(d.home); }
    // a port that accepts but never answers
    await new Promise<void>(resolve => hang.listen(0, '127.0.0.1', () => resolve()));
    setConfig(home, { daemonPort: (hang.address() as net.AddressInfo).port });
    const r = await run(home, { session_id: 'x' });
    assert.equal(r.out, '[Router] OFF\n');
    assert.ok(r.ms < 15_000, `took ${r.ms} ms`);   // it gave up (1 s timeout) instead of hanging; the rest is a node cold start, slow under load
    // garbage stdin, no config
    fs.rmSync(path.join(home, 'config.json'));
    assert.equal((await run(home, 'not json')).out, '[Router] OFF\n');
  } finally {
    hang.close();
    rmrf(home);
  }
});

test('a wrapped status line that is this script itself runs one level deep, not recursively', () => withDaemon(async d => {
  await postHook(d.port, { session_id: 'sl-3', hook_event_name: 'UserPromptSubmit', cwd: d.home, prompt: L2_PROMPT });
  setConfig(d.home, { wrappedStatusLine: { type: 'command', command: `"${process.execPath}" "${SCRIPT}"` } });
  const r = await run(d.home, { session_id: 'sl-3' });
  const line = '[Router] L2 | architect s3 · coder×2 s1 · reviewer s3 · tester s1 | $0.00';
  assert.equal(r.out, `${line} | ${line}\n`);
  assert.ok(r.ms < 15_000, `took ${r.ms} ms`);   // one level deep, not recursive; the rest is node cold starts, slow under load
  // started as a wrapped command: router segment only, nothing wrapped
  assert.equal((await run(d.home, { session_id: 'sl-3' }, { AGENTIC_ROUTER_STATUSLINE: '1' })).out, `${line}\n`);
}));

test('runs when the plugin is reached through a junction or symlink (environment audit E1)', async () => {
  const home = makeHome();
  const link = path.join(tmpDir('plugin-link'), 'plugin');
  try {
    fs.symlinkSync(path.dirname(SCRIPT), link, 'junction');   // a junction needs no privilege on Windows; a dir symlink elsewhere
    const r = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(link, 'statusline.mjs')], { env: { ...process.env, AGENTIC_ROUTER_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', c => { out += c; });
      child.on('error', reject);
      child.on('close', () => resolve(out));
      child.stdin.end(JSON.stringify({ session_id: 'x' }));
    });
    assert.equal(r, '[Router] OFF\n');   // no daemon in this home: the point is that the script ran at all
  } finally {
    // remove the link itself first, so that no recursive delete can ever walk into the real plugin folder
    try { fs.unlinkSync(link); } catch { try { fs.rmdirSync(link); } catch { /* not created */ } }
    fs.rmdirSync(path.dirname(link));
    rmrf(home);
  }
});

test('decision 144: the status line\'s model.id reaches the daemon, so the session\'s first prompt knows its lead model', () => withDaemon(async d => {
  const L1 = 'Fix the bug where parse() fails on empty input in src/a.ts';
  const req = (sid: string) => d.ledger.db.prepare('SELECT level, lead_model AS m, lead_class AS c, team FROM requests WHERE session_id = ?').get(sid) as { level: string; m: string | null; c: string; team: string };
  // no status line yet: the hooks name no model, the first prompt has no transcript
  assert.equal((await postHook(d.port, { session_id: 'blind', cwd: d.home, hook_event_name: 'UserPromptSubmit', prompt: L1 })).status, 200);
  assert.deepEqual([req('blind').m, req('blind').c], [null, 'other']);
  // 1. what the status line sends: it renders before the first prompt (interactive sessions) and posts model.id,
  // also without rate_limits. Caught by a stub that records the body on arrival: the status line's own 500 ms
  // post timeout is no part of this check (an in-process daemon under a loaded full suite can be slower).
  const posted = await new Promise<Record<string, unknown>>(resolve => {
    const stub = net.createServer(s => {
      let buf = '';
      s.on('data', c => {
        buf += c;
        const at = buf.indexOf('\r\n\r\n');
        if (!buf.startsWith('POST /router/v1/limits') || at < 0) return;
        const len = Number(/content-length: (\d+)/i.exec(buf)?.[1] ?? '0');
        if (buf.length - at - 4 < len) return;
        resolve(JSON.parse(buf.slice(at + 4, at + 4 + len)) as Record<string, unknown>);
        s.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n{}');
        stub.close();
      });
    });
    stub.listen(0, '127.0.0.1', () => {
      const home = makeHome({ daemonPort: (stub.address() as net.AddressInfo).port });
      void run(home, { session_id: 'seen', model: { id: 'claude-sonnet-5-5', display_name: 'Sonnet' } }).finally(() => rmrf(home));
    });
  });
  assert.deepEqual([posted.sessionId, posted.model, posted.rateLimits], ['seen', 'claude-sonnet-5-5', undefined]);
  // 2. what the daemon does with it: the session's model, used by the first prompt that has no transcript yet
  const token = fs.readFileSync(path.join(d.home, 'token'), 'utf8').trim();
  const limits = (body: unknown) => request(d.port, {
    method: 'POST', path: '/router/v1/limits', body: JSON.stringify(body), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  assert.deepEqual((await limits(posted)).body, { stored: false, model: true });
  assert.equal(d.ledger.sessionLeadModel('seen'), 'claude-sonnet-5-5');
  assert.equal((await postHook(d.port, { session_id: 'seen', cwd: d.home, hook_event_name: 'UserPromptSubmit', prompt: L1 })).status, 200);
  const r = req('seen');
  assert.deepEqual([r.m, r.c], ['claude-sonnet-5-5', 'sonnet']);
  if (r.level === 'L1') assert.equal(JSON.parse(r.team).leadDirect, undefined, 'a Sonnet lead delegates L1');
  // a bad model id is not stored
  assert.deepEqual((await limits({ sessionId: 'odd', model: 'not a model id' })).body, { stored: false, model: false });
}));
