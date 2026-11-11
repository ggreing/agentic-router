import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHome, rmrf } from './helpers.ts';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));

test('main.ts writes nothing to the console; a start failure goes to logs/daemon.log and exits 1', () => {
  const home = makeHome();
  try {
    fs.rmSync(path.join(home, 'token'));
    const r = spawnSync(process.execPath, [MAIN], { env: { ...process.env, AGENTIC_ROUTER_HOME: home }, encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
    const log = fs.readFileSync(path.join(home, 'logs', 'daemon.log'), 'utf8');
    assert.match(log, /"level":"error","msg":"daemon failed to start".*token file not found/);
  } finally { rmrf(home); }
});
