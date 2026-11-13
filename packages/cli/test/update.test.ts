// Decision 163: `do-it-all-claude-code update on|off|check` and the update lines of status and doctor. A temp
// router home and a local stand-in for the releases endpoint: nothing reaches GitHub.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { readUpdateState, writeUpdateState, type FetchOptions } from '@do-it-all-claude-code/core';
import { ensureLocalState, readConfig } from '../src/setup.ts';
import { CLI_VERSION, UPDATE_QUESTION, updateCheckLine, updateCommand, updateStatusLine } from '../src/update.ts';

let tmp = '';
let home = '';
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-cli-upd-'));
  home = path.join(tmp, 'home');
  process.env.DO_IT_ALL_CLAUDE_CODE_HOME = home;
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

async function releases(list: unknown[]) {
  const s = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json', etag: '"e1"' }); res.end(JSON.stringify(list)); });
  await new Promise<void>(r => s.listen(0, '127.0.0.1', () => r()));
  const fetchOptions: FetchOptions = { target: { protocol: 'http:', host: '127.0.0.1', port: (s.address() as net.AddressInfo).port }, env: {} };
  return { fetchOptions, close: () => new Promise<void>(r => { s.closeAllConnections(); s.close(() => r()); }) };
}
const run = async (sub: string | undefined, o: { fetchOptions?: FetchOptions; current?: string } = {}) => {
  const lines: string[] = [];
  const code = await updateCommand(sub, { out: l => { lines.push(l); }, home, ...o });
  return { code, text: lines.join('\n') };
};

test('decision 163: the question init asks, and an existing install starts off with doctor suggesting it until the user chooses', async () => {
  assert.equal(UPDATE_QUESTION, 'Check GitHub once a day for a newer release? (only reads the public release list; nothing about you is sent)');
  await ensureLocalState();
  const cfg = readConfig()!;
  assert.equal(cfg.updateCheck, undefined, 'an install from before has no choice yet');
  const suggestion = updateCheckLine(cfg, home);
  assert.deepEqual([suggestion.ok, suggestion.blocking], [false, false]);
  assert.match(suggestion.detail, /not set: `do-it-all-claude-code update on` checks GitHub once a day .*nothing about you is sent.*`update off` keeps it off and ends this note/);
  assert.equal((await run('off')).code, 0);
  assert.equal(readConfig()!.updateCheck, 'off');
  assert.deepEqual(updateCheckLine(readConfig()!, home), { name: 'update check', ok: true, blocking: false, detail: 'off' });
  assert.match(updateStatusLine(readConfig(), home), /^update check: off/);
  const on = await run('on');
  assert.equal(on.code, 0);
  assert.match(on.text, /once a day \(nothing about you is sent\)/);
  assert.equal(readConfig()!.updateCheck, 'on');
  assert.match(updateCheckLine(readConfig()!, home).detail, /^on: no check yet/);
  assert.equal((await run('nonsense')).code, 2);
});

test('decision 163: update check asks now, whatever the setting, and says what it found; status and doctor show it', async () => {
  await ensureLocalState();
  const s = await releases([{ tag_name: 'v99.0.0-rc.1', draft: false, prerelease: true }, { tag_name: 'v100.0.0', draft: true }]);
  try {
    const r = await run('check', { fetchOptions: s.fetchOptions, current: CLI_VERSION });
    assert.equal(r.code, 0);
    assert.equal(r.text, `Do It All Claude Code 99.0.0-rc.1 is available (you have ${CLI_VERSION}): https://github.com/ggreing/do-it-all-claude-code/releases/tag/v99.0.0-rc.1`);
    assert.equal(readUpdateState(home).latest, 'v99.0.0-rc.1', 'saved for status, doctor and the daemon');
    assert.match(updateStatusLine(readConfig(), home), /99\.0\.0-rc\.1 is available .* \(from your last `update check`; the daily check is off\)/);
    const line = updateCheckLine({ ...readConfig()!, updateCheck: 'on' }, home);
    assert.deepEqual([line.ok, line.blocking], [false, false]);
    assert.match(line.detail, /^Do It All Claude Code 99\.0\.0-rc\.1 is available/);
    const same = await run('check', { fetchOptions: s.fetchOptions, current: '99.0.0-rc.1' });
    assert.equal(same.text, 'You have 99.0.0-rc.1; the newest release is 99.0.0-rc.1.');
  } finally { await s.close(); }
  // offline: a failure, the last result kept and named
  const gone = await releases([]);
  await gone.close();
  const off = await run('check', { fetchOptions: gone.fetchOptions });
  assert.equal(off.code, 1);
  assert.match(off.text, /^Could not check: [A-Z_]+\. The last release seen is 99\.0\.0-rc\.1\.$/);
  assert.match(updateCheckLine({ ...readConfig()!, updateCheck: 'on' }, home).detail, /99\.0\.0-rc\.1 is available/);
  writeUpdateState(home, { ...readUpdateState(home), latest: `v${CLI_VERSION}` });
  assert.match(updateCheckLine({ ...readConfig()!, updateCheck: 'on' }, home).detail, /^on, but the last attempt failed \([A-Z_]+, \d{4}-\d\d-\d\d\); it is tried again the next day$/);
});

test('decision 163: update check before init reads the list but makes no home (init would take it for one)', async () => {
  const s = await releases([{ tag_name: 'v99.0.0', draft: false }]);
  try {
    const r = await run('check', { fetchOptions: s.fetchOptions });
    assert.equal(r.code, 0);
    assert.match(r.text, /99\.0\.0 is available/);
    assert.ok(!fs.existsSync(home));
    assert.equal((await run('on')).code, 2, 'on/off need init');
  } finally { await s.close(); }
});
