// Decision 129 at the stop check: a protected path granted to the subtask (router_request_scope after a
// user turn) is inside its scope; every other protected path, git metadata and attributes stay as they were.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROTECTED_WRITE_PATHS } from '@do-it-all-claude-code/core';
import { takeSnapshot } from '../src/git.ts';
import { checkScope, type ScopeSpec } from '../src/verify.ts';
import { git, makeRepo, rmrf, write } from './helpers.ts';

const PROTECTED = [...PROTECTED_WRITE_PATHS];

async function withRepo(fn: (dir: string, spec: (granted?: string[]) => Promise<ScopeSpec>) => Promise<void>): Promise<void> {
  const dir = makeRepo({
    'src/a.ts': 'a\n', '.env.example': 'KEY=\n', '.github/workflows/ci.yml': 'on: push\n', '.gitignore': '.env\n', 'docs/n.md': 'n\n',
  });
  try {
    git(dir, 'config', 'core.autocrlf', 'false');
    write(dir, '.env', 'SECRET=1\n');   // git-ignored, there before the subtask
    const snapshot = await takeSnapshot(dir);
    await fn(dir, async granted => ({ allowed: ['src/**'], protected: PROTECTED, unscoped: false, snapshot, ...(granted ? { protectedGranted: granted } : {}) }));
  } finally { rmrf(dir); }
}

test('a granted protected path is inside the scope; without the grant the same change is refused', () => withRepo(async (dir, spec) => {
  write(dir, 'src/a.ts', 'a2\n');
  write(dir, '.env.example', 'KEY=\nNEW=\n');
  const refused = await checkScope(dir, await spec());
  assert.equal(refused.ok, false);
  assert.match(refused.detail!, /protected paths changed \(need user confirmation\): \.env\.example/);
  const ok = await checkScope(dir, await spec(['.env.example']));
  assert.equal(ok.ok, true, ok.detail);
  assert.match(ok.detail!, /2 file\(s\) changed during the subtask/);
  // an empty grant list is no grant
  assert.equal((await checkScope(dir, await spec([]))).ok, false);
}));

test('a grant covers what it names and nothing else', () => withRepo(async (dir, spec) => {
  write(dir, '.env.example', 'KEY=\nNEW=\n');
  write(dir, '.github/workflows/ci.yml', 'on: [push, pull_request]\n');
  write(dir, 'docs/n.md', 'changed\n');
  const s = await checkScope(dir, await spec(['.env.example']));
  assert.equal(s.ok, false);
  assert.match(s.detail!, /protected paths changed \(need user confirmation\): \.github\/workflows\/ci\.yml( |;|$)/);
  assert.match(s.detail!, /changed outside the allowed scope \[src\/\*\*\]: docs\/n\.md/);
  assert.doesNotMatch(s.detail!, /\.env\.example/);
  // a directory grant
  const both = await checkScope(dir, await spec(['.env.example', '.github/workflows/**']));
  assert.match(both.detail!, /changed outside the allowed scope \[src\/\*\*\]: docs\/n\.md/);
  assert.doesNotMatch(both.detail!, /protected paths changed/);
}));

test('a granted file that git ignores (.env) and a new protected file are covered too', () => withRepo(async (dir, spec) => {
  write(dir, '.env', 'SECRET=2\n');
  write(dir, '.env.local', 'LOCAL=1\n');
  const refused = await checkScope(dir, await spec());
  assert.equal(refused.ok, false);
  assert.match(refused.detail!, /protected paths changed \(need user confirmation\): .*\.env/);
  const partly = await checkScope(dir, await spec(['.env']));
  assert.equal(partly.ok, false);
  assert.match(partly.detail!, /protected paths changed \(need user confirmation\): \.env\.local(;|$| )/);
  const ok = await checkScope(dir, await spec(['.env', '.env.local']));
  assert.equal(ok.ok, true, ok.detail);
}));

test('git metadata is never covered by a grant', () => withRepo(async (dir, spec) => {
  fs.appendFileSync(path.join(dir, '.git', 'config'), '[alias]\n\tx = status\n');
  const s = await checkScope(dir, await spec(['.git/**', '.git/config', '**']));
  assert.equal(s.ok, false);
  assert.match(s.detail!, /protected paths changed \(need user confirmation\): \.git\/config .*git and the verify commands were not run/);
}));

test('without a start snapshot a granted path is not reported as protected or out of scope', () => withRepo(async (dir, spec) => {
  write(dir, '.env.example', 'KEY=\nNEW=\n');
  write(dir, '.github/workflows/ci.yml', 'on: [push, pull_request]\n');
  const { snapshot: _unused, ...noSnap } = await spec(['.env.example']);
  const s = await checkScope(dir, noSnap);
  assert.equal(s.ok, true);
  assert.match(s.detail!, /no start snapshot/);
  assert.match(s.detail!, /protected paths: \.github\/workflows\/ci\.yml/);
  assert.doesNotMatch(s.detail!, /\.env\.example/);
}));
