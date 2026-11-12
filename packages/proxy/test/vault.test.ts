// The vault's commands, checked with a fake runner: no test touches a keychain unless
// AGENTIC_ROUTER_TEST_KEYCHAIN=1 (a throwaway service name, created and deleted).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  VaultError, childEnv, deleteKey, readKey, storeKey, windowsDeleteScript, windowsReadScript, windowsStoreScript, type RunOptions, type RunResult, type Runner,
} from '../src/vault.ts';

const KEY = 'sk-ant-api03-vault-test-key-0123456789';

function fake(result: Partial<RunResult>): { run: Runner; calls: Array<{ command: string; args: string[]; o: RunOptions }> } {
  const calls: Array<{ command: string; args: string[]; o: RunOptions }> = [];
  return { calls, run: async (command, args, o) => { calls.push({ command, args, o }); return { code: 0, stdout: '', stderr: '', ...result }; } };
}
const decode = (args: string[]) => Buffer.from(args[args.indexOf('-EncodedCommand') + 1]!, 'base64').toString('utf16le');

test('read: the right tool per OS; the key comes from stdout and never appears in argv', async () => {
  const mac = fake({ stdout: `${KEY}\n` });
  assert.equal(await readKey({ platform: 'darwin', run: mac.run }), KEY);
  assert.deepEqual([mac.calls[0]!.command, mac.calls[0]!.args], ['/usr/bin/security', ['find-generic-password', '-s', 'agentic-router', '-a', 'anthropic-api-key', '-w']]);
  const lin = fake({ stdout: KEY });
  assert.equal(await readKey({ platform: 'linux', run: lin.run }), KEY);
  assert.deepEqual([lin.calls[0]!.command, lin.calls[0]!.args], ['secret-tool', ['lookup', 'service', 'agentic-router', 'account', 'anthropic-api-key']]);
  const win = fake({ stdout: `﻿${KEY}` });
  assert.equal(await readKey({ platform: 'win32', run: win.run }), KEY);
  assert.equal(win.calls[0]!.command, 'powershell.exe');
  assert.ok(win.calls[0]!.args.includes('-NonInteractive'));
  const script = decode(win.calls[0]!.args);
  assert.match(script, /Windows\.Security\.Credentials\.PasswordVault/);
  assert.match(script, /CredRead/);                                          // the FullLanguage fallback
  assert.match(script, /LanguageMode -ne 'FullLanguage'/);
  for (const c of [...mac.calls, ...lin.calls, ...win.calls]) assert.ok(!c.args.join(' ').includes(KEY) && !decode(c.args.includes('-EncodedCommand') ? c.args : ['-EncodedCommand', '']).includes(KEY));
});

test('read errors: missing tool, not found, constrained language, bad value', async () => {
  const cases: Array<[string, Partial<RunResult>, string]> = [
    ['linux', { code: null, stderr: 'Error: spawn secret-tool ENOENT' }, 'unavailable'],
    ['linux', { code: 1, stdout: '' }, 'not_found'],
    ['darwin', { code: 44 }, 'not_found'],
    ['win32', { code: 2, stderr: 'AR_VAULT_NOT_FOUND' }, 'not_found'],
    ['win32', { code: 3, stderr: 'AR_VAULT_CONSTRAINED' }, 'constrained_language'],
    ['darwin', { stdout: 'has a space in it\n' }, 'invalid_key'],
    ['darwin', { code: 7, stderr: 'boom' }, 'failed'],
  ];
  for (const [platform, r, code] of cases) {
    await assert.rejects(readKey({ platform, run: fake(r).run }), (e: unknown) => e instanceof VaultError && e.code === code, `${platform} ${code}`);
  }
  await assert.rejects(readKey({ service: 'bad name', run: fake({}).run }), /letters, digits/);
});

test('store: interactive prompts in the tool on the inherited terminal; stdin mode pipes the key (never argv)', async () => {
  const mac = fake({});
  await storeKey({ platform: 'darwin', interactive: true, run: mac.run });
  assert.deepEqual(mac.calls[0]!.args.slice(-1), ['-w']);                    // security prompts for the value itself
  assert.equal(mac.calls[0]!.o.inheritStdio, true);
  await assert.rejects(storeKey({ platform: 'darwin', interactive: false, key: KEY, run: fake({}).run }), /interactively/);
  const lin = fake({});
  await storeKey({ platform: 'linux', interactive: false, key: KEY, run: lin.run });
  assert.equal(lin.calls[0]!.o.input, KEY);
  assert.ok(!lin.calls[0]!.args.join(' ').includes(KEY));
  const win = fake({});
  await storeKey({ platform: 'win32', interactive: false, key: KEY, run: win.run });
  assert.equal(win.calls[0]!.o.input, KEY);
  assert.match(decode(win.calls[0]!.args), /\[Console\]::In\.ReadToEnd/);
  assert.ok(!decode(win.calls[0]!.args).includes(KEY));
  const winTty = fake({});
  await storeKey({ platform: 'win32', interactive: true, run: winTty.run });
  assert.match(decode(winTty.calls[0]!.args), /Read-Host -AsSecureString/);
  assert.ok(!winTty.calls[0]!.args.includes('-NonInteractive'));
  await assert.rejects(storeKey({ platform: 'linux', interactive: false, key: 'short', run: fake({}).run }), /not a valid key/);
  const del = fake({ code: 44 });
  await deleteKey({ platform: 'darwin', run: del.run });                     // nothing to delete is fine
});

test('children get a minimal environment (no credentials of the parent)', () => {
  const env = childEnv({ PATH: '/bin', HOME: '/h', DBUS_SESSION_BUS_ADDRESS: 'unix:x', ANTHROPIC_API_KEY: 'k', AGENTIC_ROUTER_HOME: '/r', SECRET_TOKEN: 's' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', DBUS_SESSION_BUS_ADDRESS: 'unix:x' });
});

test('the Windows scripts parse in Windows PowerShell 5.1 (parse only: no keychain access)', { skip: process.platform !== 'win32' }, () => {
  for (const script of [windowsReadScript('agentic-router', 'anthropic-api-key'), windowsStoreScript('agentic-router', 'a', false), windowsStoreScript('agentic-router', 'a', true), windowsDeleteScript('agentic-router', 'a')]) {
    const b64 = Buffer.from(script, 'utf8').toString('base64');
    const check = `$s = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')); $e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($s, [ref]$null, [ref]$e); if ($e.Count) { $e | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', check], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
  }
});

test('a real keychain: store, read and delete a throwaway entry', { skip: process.env.AGENTIC_ROUTER_TEST_KEYCHAIN !== '1' || process.platform === 'darwin' }, async () => {
  const service = `agentic-router-test-${process.pid}`;
  const key = `sk-ant-test-${Date.now()}-throwaway`;
  try {
    await storeKey({ service, interactive: false, key });
    assert.equal(await readKey({ service }), key);
  } finally {
    await deleteKey({ service });
  }
  await assert.rejects(readKey({ service }), (e: unknown) => e instanceof VaultError && e.code === 'not_found');
});
