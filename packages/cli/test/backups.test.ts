// Decision 142 and audit C4 in the CLI: settings backups never keep a credential (and old ones can be cleaned),
// settings writes keep the file's mode and a symlink, config.json is 0600. Temp files only.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths } from '@do-it-all-claude-code/core';
import { planApiSettings } from '../src/apimode.ts';
import { backupCredentials, backupFile, ensureLocalState, planBackupClean, planStatusLine, readConfig, writeBackup, writeConfig, writeJsonAtomic } from '../src/setup.ts';

let tmp = '';
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-cli-hard-'));
  process.env.DO_IT_ALL_CLAUDE_CODE_HOME = path.join(tmp, 'home');
});
const posix = process.platform !== 'win32';
const KEY = 'sk-ant-api03-' + 'K'.repeat(40);

test('decision 142: the one-time settings backup leaves credentials out, and says so in the plan', () => {
  const file = path.join(tmp, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ model: 'opus', env: { ANTHROPIC_API_KEY: KEY, MY_SERVICE_TOKEN: 't-123456789', FOO: 'bar' } }));
  const plan = planApiSettings(file, 'proxy', 47811, path.join('/opt', 'proxy'))!;
  assert.match(plan.summary, /the one-time backup leaves out env\.ANTHROPIC_API_KEY, env\.MY_SERVICE_TOKEN: credentials are not copied/);
  plan.apply();
  const bak = fs.readFileSync(backupFile(file), 'utf8');
  assert.ok(!bak.includes(KEY) && !bak.includes('t-123456789'), bak);
  assert.deepEqual(JSON.parse(bak), { model: 'opus', env: { FOO: 'bar' } });
  if (posix) assert.equal(fs.statSync(backupFile(file)).mode & 0o777, 0o600);
  // the status line plan, after: the backup exists, so no note and no second copy
  assert.doesNotMatch(planStatusLine(file, '/p/statusline.mjs', { daemonPort: 1, fableOptIn: false } as never)!.summary, /backup/);
});

test('decision 142: an older backup that holds a key is found (doctor) and cleaned on request (init)', () => {
  const file = path.join(tmp, 'settings.json');
  fs.writeFileSync(file, '{}');
  fs.writeFileSync(backupFile(file), JSON.stringify({ apiKeyHelper: 'x', env: { ANTHROPIC_AUTH_TOKEN: KEY } }));
  assert.deepEqual(backupCredentials(file), ['env.ANTHROPIC_AUTH_TOKEN']);
  const plan = planBackupClean(file)!;
  assert.equal(plan.file, backupFile(file));
  assert.match(plan.summary, /remove env\.ANTHROPIC_AUTH_TOKEN from the backup/);
  plan.apply();
  assert.deepEqual(JSON.parse(fs.readFileSync(backupFile(file), 'utf8')), { apiKeyHelper: 'x' });
  assert.equal(planBackupClean(file), null);
  assert.deepEqual(backupCredentials(path.join(tmp, 'none.json')), []);
});

test('audit C4: a settings write keeps the file\'s mode and writes through a symlink; config.json is 0600', { skip: !posix && 'POSIX modes and symlinks' }, async () => {
  const real = path.join(tmp, 'dotfiles', 'settings.json');
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, '{}', { mode: 0o640 });
  fs.chmodSync(real, 0o640);
  const link = path.join(tmp, 'settings.json');
  fs.symlinkSync(real, link);
  writeJsonAtomic(link, { a: 1 });
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'still a link');
  assert.deepEqual(JSON.parse(fs.readFileSync(real, 'utf8')), { a: 1 });
  assert.equal(fs.statSync(real).mode & 0o777, 0o640);
  writeJsonAtomic(path.join(tmp, 'new.json'), {});
  assert.equal(fs.statSync(path.join(tmp, 'new.json')).mode & 0o777, 0o600, 'a new file is 0600');
  await ensureLocalState();
  fs.chmodSync(paths.config(), 0o644);
  writeConfig({ ...readConfig()!, forceLevel: 'L1' });
  assert.equal(fs.statSync(paths.config()).mode & 0o777, 0o600);
});

test('decision 142: init and doctor say what switching recordPrompts off does', async () => {
  const { promptStorageSummary } = await import('../src/setup.ts');
  assert.match(promptStorageSummary(undefined), /^recordPrompts is off: no prompt or conversation text is stored\..*switching it off again deletes that text at the next daemon start\.$/);
  assert.match(promptStorageSummary(true), /^recordPrompts is on: .*Switching it off deletes the stored prompt text at the next daemon start\.$/);
});

test('decision 149: the backup also leaves out ANTHROPIC_CUSTOM_HEADERS and an apiKeyHelper that holds a key; a plain helper stays', () => {
  const file = path.join(tmp, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ apiKeyHelper: `echo ${KEY}`, env: { ANTHROPIC_CUSTOM_HEADERS: 'X-Gateway: t-0123456789', FOO: 'bar' } }));
  writeBackup(file);
  const bak = fs.readFileSync(backupFile(file), 'utf8');
  assert.ok(!bak.includes(KEY) && !bak.includes('t-0123456789'), bak);
  assert.deepEqual(JSON.parse(bak), { env: { FOO: 'bar' } });
  // an older backup with both: found and cleaned
  fs.writeFileSync(backupFile(file), JSON.stringify({ apiKeyHelper: `echo ${KEY}`, env: { ANTHROPIC_CUSTOM_HEADERS: 'h' } }));
  assert.deepEqual(backupCredentials(file), ['env.ANTHROPIC_CUSTOM_HEADERS', 'apiKeyHelper']);
  planBackupClean(file)!.apply();
  assert.deepEqual(JSON.parse(fs.readFileSync(backupFile(file), 'utf8')), {});
  // a helper that only names a vault command is the user's setting, not a credential
  fs.rmSync(backupFile(file));
  fs.writeFileSync(file, JSON.stringify({ apiKeyHelper: 'corp-vault get anthropic' }));
  writeBackup(file);
  assert.deepEqual(JSON.parse(fs.readFileSync(backupFile(file), 'utf8')), { apiKeyHelper: 'corp-vault get anthropic' });
});
