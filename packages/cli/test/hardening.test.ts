// Review follow-ups for the CLI (decisions 75, 77, 78).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SettingsParseError, ensureLocalState, isRouterStatusLine, planProject, planStatusLine, readConfig, validBudgets } from 'agentic-router';
import { commandLineOf, isAlive, isOurDaemon } from '../src/daemonctl.ts';

let tmp = '';
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-cli-h-'));
  process.env.AGENTIC_ROUTER_HOME = path.join(tmp, 'home');
});

function fakePlugin(dir: string): string {
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'agentic-router' }));
  fs.writeFileSync(path.join(dir, 'statusline.mjs'), '');
  return path.join(dir, 'statusline.mjs');
}

test('re-running init from another plugin path never wraps the router itself; backup is made once (#1)', async () => {
  const { config } = await ensureLocalState();
  const settings = path.join(tmp, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: 'my-status --fancy' } }));
  planStatusLine(settings, fakePlugin(path.join(tmp, 'plugA')), config)!.apply();
  assert.equal(readConfig()?.wrappedStatusLine?.command, 'my-status --fancy');
  const bak = fs.readFileSync(settings + '.agentic-router.bak', 'utf8');

  const c2 = readConfig()!;
  const second = planStatusLine(settings, fakePlugin(path.join(tmp, 'other', 'plugB')), c2)!;
  assert.match(second.summary, /point the router status line/);
  second.apply();
  assert.equal(readConfig()?.wrappedStatusLine?.command, 'my-status --fancy', 'original kept, not replaced by the old router command');
  assert.equal(fs.readFileSync(settings + '.agentic-router.bak', 'utf8'), bak, 'backup not overwritten');
  assert.match(JSON.parse(fs.readFileSync(settings, 'utf8')).statusLine.command, /plugB/);
});

test('router status line is recognised by manifest or path', () => {
  assert.ok(isRouterStatusLine(`node "${fakePlugin(path.join(tmp, 'x'))}"`));
  assert.ok(isRouterStatusLine('node "/home/u/.claude/plugins/cache/agentic-router/0.1.0/statusline.mjs"'));
  assert.ok(!isRouterStatusLine('node "/home/u/tools/statusline.mjs"'));
  assert.ok(!isRouterStatusLine('ccstatusline'));
});

test('settings with a BOM parse; unparseable settings skip the step and are left untouched (#12)', async () => {
  const { config } = await ensureLocalState();
  const bom = path.join(tmp, 'bom.json');
  fs.writeFileSync(bom, '\uFEFF{"model":"sonnet"}');
  planStatusLine(bom, fakePlugin(path.join(tmp, 'p')), config)!.apply();
  assert.equal(JSON.parse(fs.readFileSync(bom, 'utf8')).model, 'sonnet');

  const broken = path.join(tmp, 'broken.json');
  const text = '{ // my settings\n "model": "opus", }';
  fs.writeFileSync(broken, text);
  assert.throws(() => planStatusLine(broken, fakePlugin(path.join(tmp, 'q')), config), SettingsParseError);
  assert.equal(fs.readFileSync(broken, 'utf8'), text);

  const proj = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  fs.mkdirSync(path.join(proj, '.claude'));
  fs.writeFileSync(path.join(proj, '.claude', 'settings.local.json'), '{,}');
  assert.throws(() => planProject(proj), SettingsParseError);
  assert.ok(!fs.readdirSync(path.dirname(broken)).some(f => f.endsWith('.tmp')), 'no temp files left');
});

test('budgets: only positive finite numbers are kept (#5)', async () => {
  assert.deepEqual(validBudgets({ L0: 1, L1: NaN, L2: -3, L3: 0 }), { L0: 1 });
  assert.deepEqual(validBudgets({ L1: null as unknown as number, L2: '5' as unknown as number }), {});
  fs.mkdirSync(path.join(tmp, 'home'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'home', 'config.json'), JSON.stringify({ daemonPort: 47999, fableOptIn: false, budgetsUsd: { L2: null } }));
  const { config } = await ensureLocalState({ L1: 3 });
  assert.equal(config.budgetsUsd.L1, 3);
  assert.equal(config.budgetsUsd.L2, 5, 'invalid stored value falls back to the provisional default');
});

test('init --new-port picks a fresh port (#14)', async () => {
  fs.mkdirSync(path.join(tmp, 'home'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'home', 'config.json'), JSON.stringify({ daemonPort: 1, fableOptIn: false, budgetsUsd: {} }));
  const { config } = await ensureLocalState({}, undefined, { newPort: true });
  assert.ok(config.daemonPort >= 47800 && config.daemonPort <= 47999);
});

test('a PID is only treated as our daemon when its command line runs the daemon entry (#2)', async () => {
  assert.ok(isAlive(process.pid));
  assert.equal(isOurDaemon(process.pid), false, 'the test runner is not the daemon');
  // A child started like the daemon (node <absolute entry>) is recognised by that entry only.
  const entry = path.join(tmp, 'fake-main.mjs');
  fs.writeFileSync(entry, 'setInterval(() => {}, 1000);');
  const child = spawn(process.execPath, [entry], { stdio: 'ignore', windowsHide: true });
  try {
    await new Promise(r => setTimeout(r, 300));
    assert.ok(commandLineOf(child.pid!)?.length, 'child command line readable');
    assert.equal(isOurDaemon(child.pid!, entry), true);
    assert.equal(isOurDaemon(child.pid!, path.join(tmp, 'other-main.mjs')), false);
  } finally { child.kill(); }
  assert.equal(isOurDaemon(2 ** 22 + 12345), false, 'a missing pid is never ours');
});
