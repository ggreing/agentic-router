#!/usr/bin/env node
// agentic-router <init|start|stop|status|doctor>
import fs from 'node:fs';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Level } from '@agentic-router/core';
import { SettingsParseError, defaultClaudeSettings, ensureLocalState, planProject, planStatusLine, type PlannedChange } from './setup.ts';
import { start, status, stop } from './daemonctl.ts';
import { doctor } from './doctor.ts';

export { doctor, ladderBreakers, versionAtLeast } from './doctor.ts';
export * from './setup.ts';

function flags(argv: string[]): Record<string, string | boolean> {
  const f: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { f[a.slice(2)] = next; i++; } else f[a.slice(2)] = true;
  }
  return f;
}

async function confirm(changes: PlannedChange[], yes: boolean): Promise<boolean> {
  if (!changes.length) return false;
  console.log('\nThese files outside ~/.agentic-router will change:');
  for (const c of changes) console.log(`  - ${c.file}: ${c.summary}`);
  if (yes) return true;
  if (!process.stdin.isTTY) { console.log('Not a terminal: re-run with --yes to apply.'); return false; }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question('Apply? [y/N] ')).trim().toLowerCase();
  rl.close();
  return a === 'y' || a === 'yes';
}

async function init(f: Record<string, string | boolean>) {
  const budgets: Partial<Record<Level, number>> = {};
  for (const l of ['L0', 'L1', 'L2', 'L3'] as Level[]) {
    const raw = f[`budget-${l}`];
    if (raw === undefined) continue;
    const v = typeof raw === 'string' ? Number(raw) : NaN;
    if (!Number.isFinite(v) || v <= 0) { console.error(`--budget-${l} must be a positive number of USD (got ${JSON.stringify(raw)})`); process.exitCode = 2; return; }
    budgets[l] = v;
  }
  const pluginDir = typeof f['plugin-dir'] === 'string' ? path.resolve(f['plugin-dir']) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../plugin');
  const { config, token } = await ensureLocalState(budgets, pluginDir, { newPort: f['new-port'] === true });
  console.log(`local state ready: daemon port ${config.daemonPort}, token ${token}, plugin ${pluginDir}`);
  console.log(`per-request budgets (provisional): ${Object.entries(config.budgetsUsd).map(([k, v]) => `${k} $${v}`).join(', ')}`);
  const changes: PlannedChange[] = [];
  // A settings file we cannot parse skips only that step (review #12); nothing is overwritten.
  const step = (name: string, plan: () => PlannedChange[]) => {
    try { changes.push(...plan()); }
    catch (e) {
      if (!(e instanceof SettingsParseError)) throw e;
      console.log(`skipped ${name}: ${e.message}. Fix the file and re-run init, or set it up by hand (README).`);
    }
  };
  step('status line', () => {
    const sl = planStatusLine(typeof f['claude-settings'] === 'string' ? f['claude-settings'] : defaultClaudeSettings(), path.join(pluginDir, 'statusline.mjs'), config);
    return sl ? [sl] : [];
  });
  step('project settings', () => planProject(typeof f.project === 'string' ? f.project : process.cwd()));
  if (await confirm(changes, f.yes === true)) for (const c of changes) c.apply();
  console.log(`\nLoad the plugin in Claude Code: claude --plugin-dir "${pluginDir}"  (marketplace install comes with the first release)`);
}

const [cmd, ...rest] = process.argv.slice(2);
const f = flags(rest);
// realpath on both sides: an npm bin is a symlink (POSIX) whose path differs from the module's (review #7).
const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const isMain = !!process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url));
if (isMain) {
  if (cmd === 'init') await init(f);
  else if (cmd === 'start') console.log(await start());
  else if (cmd === 'stop') console.log(await stop());
  else if (cmd === 'status') console.log(await status());
  else if (cmd === 'doctor') {
    const checks = await doctor();
    for (const c of checks) console.log(`${c.ok ? 'ok  ' : c.blocking ? 'FAIL' : 'warn'} ${c.name.padEnd(36)} ${c.detail}`);
    if (checks.some(c => !c.ok && c.blocking)) process.exitCode = 1;
  } else console.log('usage: agentic-router <init|start|stop|status|doctor>');
}
