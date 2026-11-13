// Decisions 161, 164: the product was renamed. The previous release's project folder (.agentic-router) is no longer
// read and stays as protected as the new one; the previous home (~/.agentic-router) stays off limits to workers
// until init moves it. Temp repositories and homes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as guard from '../../../plugin/hooks/guard.mjs';
import { CREDENTIAL_PATHS, GUARD_SENSITIVE_SEGMENTS, NEVER_GRANTABLE_WRITE_PATHS, PROTECTED_WRITE_PATHS } from '@do-it-all-claude-code/core';

const CODER = 'do-it-all-claude-code:coder';

function world() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ar-rename-')));
  const repo = path.join(base, 'repo'), home = path.join(base, 'home'), state = path.join(home, '.do-it-all-claude-code');
  for (const d of [path.join(repo, 'src'), path.join(home, '.agentic-router'), path.join(state, 'agents')]) fs.mkdirSync(d, { recursive: true });
  spawnSync('git', ['-C', repo, 'init', '-q']);
  fs.writeFileSync(path.join(home, '.agentic-router', 'token'), 'fake\n');
  fs.writeFileSync(path.join(state, 'agents', 'ag2.json'), JSON.stringify({ sessionId: 's1', subtaskId: 'B', role: 'coder', slot: 0, step: 's1', pairing: 'confirmed',
    scope: { allowed: ['**'], protected: guard.PROTECTED_WRITE_PATHS, unscoped: true } }));
  const call = (tool: string, tool_input: Record<string, unknown>) =>
    guard.evaluate({ agent_type: CODER, agent_id: 'ag2', session_id: 's1', tool_name: tool, cwd: repo, tool_input }, { userHome: home, routerHome: state }) as { deny?: string } | null;
  return { base, repo, home, call };
}

test('decision 161: both project folders are protected, never grantable, and named in the guard\'s mirrors of core', () => {
  for (const list of [PROTECTED_WRITE_PATHS, guard.PROTECTED_WRITE_PATHS]) for (const g of ['.do-it-all-claude-code/**', '.agentic-router/**']) assert.ok(list.includes(g), g);
  for (const list of [NEVER_GRANTABLE_WRITE_PATHS, guard.NEVER_GRANTABLE_WRITE_PATHS]) assert.ok(list.includes('.agentic-router/**'));
  for (const list of [GUARD_SENSITIVE_SEGMENTS, guard.GUARD_SENSITIVE_SEGMENTS]) assert.ok(list.includes('.agentic-router'));
  for (const list of [CREDENTIAL_PATHS, guard.CREDENTIAL_PATHS]) assert.ok(list.includes('~/.agentic-router/**'));
  const w = world();
  try {
    for (const p of ['.agentic-router/policy.json', '.agentic-router/verify.json', '.do-it-all-claude-code/teams.yaml']) {
      assert.ok(w.call('Write', { file_path: path.join(w.repo, p), content: '{}' })?.deny, p);
    }
    // the previous home: its token, and anything else in it
    assert.ok(w.call('Read', { file_path: path.join(w.home, '.agentic-router', 'token') })?.deny);
    assert.ok(w.call('Bash', { command: `cat ${w.home.replace(/\\/g, '/')}/.agentic-router/proxy-token` })?.deny);
    assert.ok(!w.call('Read', { file_path: path.join(w.repo, 'src', 'a.ts') })?.deny, 'the project itself stays open');
  } finally { fs.rmSync(w.base, { recursive: true, force: true }); }
});

test('decision 164: the previous release\x27s folder is no longer read; an acceptance is keyed by repository and content, so it carries over a rename', () => {
  const w = world();
  const stateHome = path.join(w.home, '.do-it-all-claude-code');
  const oldDir = path.join(w.repo, '.agentic-router'), newDir = path.join(w.repo, '.do-it-all-claude-code');
  const content = JSON.stringify({ bashAllow: ['make lint'] });
  try {
    // only the old folder: not read
    fs.mkdirSync(oldDir);
    fs.writeFileSync(path.join(oldDir, 'policy.json'), content);
    let s = guard.policyStatus(w.repo, stateHome);
    assert.deepEqual([s.present, s.accepted, s.file], [false, false, path.join(newDir, 'policy.json')]);
    assert.equal(guard.readAcceptedPolicy(w.repo, stateHome), null);
    // renamed: read, accepted, and the record names the repository and the content's hash, not a folder
    fs.renameSync(oldDir, newDir);
    s = guard.policyStatus(w.repo, stateHome);
    assert.equal(s.hash, createHash('sha256').update(content).digest('hex'));
    guard.acceptPolicy(w.repo, stateHome, new Date(), s.hash);
    const record = JSON.parse(fs.readFileSync(path.join(stateHome, guard.POLICY_ACCEPT_FILE), 'utf8')) as { roots: Record<string, { hash: string }> };
    assert.deepEqual(Object.values(record.roots).map(r => r.hash), [s.hash]);
    assert.ok(Object.keys(record.roots).every(k => !/\.agentic-router|\.do-it-all-claude-code/.test(k)), 'keyed by the repository, not by the folder');
    // an acceptance recorded while the policy sat in the old folder (as the previous release did) carries over: the
    // same key and hash; moved away it is not read, moved back it counts again without a new acceptance
    fs.renameSync(newDir, oldDir);
    assert.equal(guard.readAcceptedPolicy(w.repo, stateHome), null, 'in the old folder: not read');
    fs.renameSync(oldDir, newDir);
    assert.deepEqual(guard.readAcceptedPolicy(w.repo, stateHome)?.bashAllow, ['make lint']);
    // both folders: only the new one is read
    fs.mkdirSync(oldDir);
    fs.writeFileSync(path.join(oldDir, 'policy.json'), JSON.stringify({ bashAllow: ['rm -rf /'] }));
    assert.deepEqual(guard.policyStatus(w.repo, stateHome).policy?.bashAllow, ['make lint']);
  } finally { fs.rmSync(w.base, { recursive: true, force: true }); }
});

test('review L1: a previous home named by an absolute AGENTIC_ROUTER_HOME is off limits like the state folder while it exists', () => {
  const w = world();
  const custom = path.join(w.base, 'data', 'router-state');
  const ev = (tool: string, tool_input: Record<string, unknown>, legacyRouterHome: string | null | undefined) =>
    guard.evaluate({ agent_type: CODER, agent_id: 'ag2', session_id: 's1', tool_name: tool, cwd: w.repo, tool_input },
      { userHome: w.home, routerHome: path.join(w.home, '.do-it-all-claude-code'), legacyRouterHome }) as { deny?: string } | null;
  try {
    assert.equal(guard.legacyStateHome({ AGENTIC_ROUTER_HOME: custom }), null, 'not there: nothing to protect');
    fs.mkdirSync(custom, { recursive: true });
    fs.writeFileSync(path.join(custom, 'token'), 'fake\n');
    assert.equal(guard.legacyStateHome({ AGENTIC_ROUTER_HOME: custom }), custom);
    assert.equal(guard.legacyStateHome({ AGENTIC_ROUTER_HOME: 'relative/dir' }), null);
    const fwd = custom.replace(/\\/g, '/');
    assert.match(ev('Read', { file_path: path.join(custom, 'token') }, custom)?.deny ?? '', /inside the router state folder/);
    assert.match(ev('Write', { file_path: path.join(custom, 'config.json'), content: '{}' }, custom)?.deny ?? '', /inside the router state folder/);
    assert.match(ev('Grep', { pattern: 'x', path: custom }, custom)?.deny ?? '', /inside the router state folder/);
    assert.match(ev('Bash', { command: `cat ${fwd}/token` }, custom)?.deny ?? '', /router state folder/);
    assert.match(ev('Bash', { command: `cd ${fwd} && ls` }, custom)?.deny ?? '', /router state folder/);
    assert.ok(!ev('Read', { file_path: path.join(custom, 'token') }, null)?.deny, 'without it, an ordinary folder outside the repository');
  } finally { fs.rmSync(w.base, { recursive: true, force: true }); }
});
