// `agentic-router uninstall` (audit B4): takes out what init and the mode commands put in, keeps what the user
// set, asks first, stops the daemon, deletes the key unless --keep-key. Temp settings and project, fake keychain.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planApiSettings } from '../src/apimode.ts';
import { ensureLocalState, planProject, planStatusLine, readConfig } from '../src/setup.ts';
import { uninstall, type UninstallDeps } from '../src/uninstall.ts';

let tmp = '';
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-cli-un-'));
  process.env.AGENTIC_ROUTER_HOME = path.join(tmp, 'home');
});
const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any

/** A machine after `init --mode api`: the user's own status line wrapped, API settings, a project with our two entries. */
async function installed(): Promise<{ settings: string; project: string; plugin: string }> {
  const { config } = await ensureLocalState();
  const settings = path.join(tmp, 'claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ model: 'opus', statusLine: { type: 'command', command: 'my-status --fancy' }, env: { FOO: 'bar' } }));
  const plugin = path.join(tmp, 'plugin');
  fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'agentic-router' }));
  planStatusLine(settings, path.join(plugin, 'statusline.mjs'), config)!.apply();
  planApiSettings(settings, 'proxy', 47811, path.join(tmp, 'proxy'))!.apply();
  const project = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(project, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }));
  fs.writeFileSync(path.join(project, '.gitignore'), 'node_modules/\n');
  for (const c of planProject(project)) c.apply();
  return { settings, project, plugin };
}

function deps(i: { settings: string; project: string }, o: { tty?: boolean; answer?: boolean; key?: string } = {}) {
  const log: string[] = [];
  const calls: string[] = [];
  const d: UninstallDeps = {
    settingsFile: i.settings, projectDir: i.project,
    stop: async () => { calls.push('stop'); return 'stopped'; },
    keyStatus: async () => o.key ?? 'present',
    deleteKey: async () => { calls.push('deleteKey'); },
    ask: async () => o.answer ?? true, isTTY: o.tty ?? true, out: l => { log.push(l); },
  };
  return { d, log, calls };
}

test('audit B4: uninstall takes out the router\'s entries, puts the wrapped status line back, keeps the user\'s own', async () => {
  const i = await installed();
  assert.equal(readConfig()!.wrappedStatusLine?.command, 'my-status --fancy');
  const { d, log, calls } = deps(i);
  assert.equal(await uninstall({}, d), 0);
  assert.deepEqual(read(i.settings), { model: 'opus', statusLine: { type: 'command', command: 'my-status --fancy' }, env: { FOO: 'bar' } });
  assert.ok(!fs.existsSync(`${i.settings}.agentic-router.bak`), 'the backup is gone');
  assert.deepEqual(read(path.join(i.project, '.claude', 'settings.local.json')), { permissions: { allow: ['Bash(npm test)'] } });
  assert.equal(fs.readFileSync(path.join(i.project, '.gitignore'), 'utf8'), 'node_modules/\n');
  assert.deepEqual(calls, ['stop', 'deleteKey'], 'the daemon stops first; the key goes last');
  assert.match(log.join('\n'), /delete the API key from the OS keychain[\s\S]*data stays in .*data purge --all/);
});

test('audit B4: --keep-key keeps the key; declining or no terminal without --yes changes nothing', async () => {
  const i = await installed();
  const before = fs.readFileSync(i.settings, 'utf8');
  const declined = deps(i, { answer: false });
  assert.equal(await uninstall({}, declined.d), 1);
  const script = deps(i, { tty: false });
  assert.equal(await uninstall({}, script.d), 1);
  assert.match(script.log.at(-1)!, /re-run with --yes/);
  assert.equal(fs.readFileSync(i.settings, 'utf8'), before);
  assert.deepEqual([...declined.calls, ...script.calls], []);
  const keep = deps(i, { tty: false });
  assert.equal(await uninstall({ 'keep-key': true, yes: true }, keep.d), 0);
  assert.deepEqual(keep.calls, ['stop']);
  assert.ok(!keep.log.some(l => /delete the API key/.test(l)));
  // a worktree.baseRef the user changed is theirs
  fs.writeFileSync(path.join(i.project, '.claude', 'settings.local.json'), JSON.stringify({ worktree: { baseRef: 'fresh' } }));
  assert.equal(await uninstall({ yes: true }, deps(i, { key: 'not_found' }).d), 0);
  assert.deepEqual(read(path.join(i.project, '.claude', 'settings.local.json')), { worktree: { baseRef: 'fresh' } });
});
